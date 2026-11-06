import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../src/core/workflow.js';
import { checkVerificationStatus } from '../src/apps/sheerid/status.js';
import { withLogSink } from '../src/core/logger.js';

const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const response = (currentStep = 'success') => new Response(JSON.stringify({ verificationId: id, currentStep, errorIds: [] }));
async function fixture(t, responses) {
  const directory = await mkdtemp(join(tmpdir(), 'one-status-query-'));
  t.after(async () => { for (const name of await readdir(directory)) await unlink(join(directory, name)); await rmdir(directory); });
  const config = { app: 'sheerid', proxy: null, artifactsDir: directory,
    url: `https://services.sheerid.com/verify/bbbbbbbbbbbbbbbbbbbbbbbb/?verificationId=${id}`,
    timeouts: { apiMs: 1000 }, polling: { intervalMs: 1 } };
  const replies = await Promise.all(responses.map(async value => value instanceof Error ? value
    : { body: await value.text(), status: value.status, headers: value.headers }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `https://my.sheerid.com/rest/v2/verification/${id}`);
    assert.equal(options.method, 'GET');
    const result = replies[Math.min(calls++, replies.length - 1)];
    if (result instanceof Error) throw result;
    return new Response(result.body || null, { status: result.status, headers: result.headers });
  });
  return { config, calls: () => calls };
}

test('Initial routing retries transient read errors before continuing from confirmed status', async t => {
  const { config, calls } = await fixture(t, [new Error('disconnect'), new Response(null, { status: 503 }), response()]);
  const logs = [];
  const result = await withLogSink(record => logs.push(record), () => runWorkflow(config, { submit: true }));
  assert.equal(result.status, 'verified');
  assert.equal(result.browserOpened, false);
  assert.equal(calls(), 4); // Three routing reads and the executor's locked status read.
  assert.equal(logs.filter(record => record.event === 'status_query_retry').length, 2);
});

test('Persistent initial network failure stops after three reads with a query stage', async t => {
  const { config, calls } = await fixture(t, [new Error('disconnect')]);
  await assert.rejects(withLogSink(() => {}, () => runWorkflow(config, { submit: true })),
    { code: 'API_NETWORK_ERROR', stage: 'preflight' });
  assert.equal(calls(), 3);
});

test('Browser preflight also retries temporary status failures', async t => {
  const { config, calls } = await fixture(t, [new Response(null, { status: 503 }), response('collectStudentPersonalInfo')]);
  const decision = await checkVerificationStatus({ config });
  assert.equal(decision.proceed, true);
  assert.equal(calls(), 2);
});

test('Initial rate limits and invalid responses are not retried', async t => {
  for (const status of [429, 403, 200]) await t.test(String(status), async t => {
    const { config, calls } = await fixture(t, [new Response('invalid', { status, headers: { 'Retry-After': '60' } })]);
    await assert.rejects(withLogSink(() => {}, () => runWorkflow(config, { submit: true })));
    assert.equal(calls(), 1);
  });
});

test('Stopping during the initial retry delay prevents any further request', async t => {
  const { config, calls } = await fixture(t, [new Error('disconnect')]);
  const controller = new AbortController();
  await assert.rejects(withLogSink(record => {
    if (record.event === 'status_query_retry') controller.abort();
  }, () => runWorkflow(config, { submit: true, signal: controller.signal })), { name: 'AbortError' });
  assert.equal(calls(), 1);
});
