import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDocumentWorkflow } from '../src/apps/sheerid/document-workflow.js';
import { acquireLock } from '../src/core/storage.js';
import { withLogSink } from '../src/core/logger.js';

const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const status = (currentStep, extra = {}) => ({ verificationId: id, currentStep, errorIds: [], ...extra });
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

async function scenario(t, states, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'one-review-'));
  t.after(async () => { for (const name of await readdir(directory)) await unlink(join(directory, name)); await rmdir(directory); });
  const logs = [], requests = [], downloaded = [], uploaded = [];
  let polls = 0, completes = 0;
  const controller = new AbortController();
  const config = { app: 'sheerid', proxy: null, artifactsDir: directory,
    url: `https://my.sheerid.com/rest/v2/verification/${id}`,
    document: { url: 'http://localhost:3000/original.png?page=2' }, data: { firstName: 'Test', lastName: 'Student' },
    timeouts: { apiMs: 1000, downloadMs: 1000, uploadMs: 1000 }, polling: { intervalMs: 1 } };
  const fetchMock = mock.method(globalThis, 'fetch', async (value, request = {}) => {
    const url = new URL(value);
    const method = request.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    if (url.hostname === 'localhost') {
      assert.equal(url.searchParams.get('name'), 'Test Student');
      assert.equal(url.searchParams.get('page'), '2');
      assert.equal(request.cache, 'no-store');
      const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(`original-${downloaded.length + 1}`)]);
      downloaded.push(bytes);
      return new Response(bytes);
    }
    if (method === 'GET') {
      await assert.rejects(acquireLock(directory, `sheerid:${id}`), { code: 'TASK_LOCKED' });
      assert.equal(logs.some(log => log.event === 'run_finished'), false);
      const current = states[polls++] ?? states.at(-1);
      if (polls > 20) throw new Error('Unexpected polling loop');
      if (current instanceof Error) throw current;
      if (current instanceof Response) return current;
      return json(current);
    }
    if (method === 'PUT') {
      uploaded.push(Buffer.from(request.body));
      if (options.failPut) throw new Error('response lost');
      return new Response(null);
    }
    if (url.pathname.endsWith('/step/docUpload')) {
      return json(status('docUpload', { documents: [{ uploadUrl: `https://test.s3.amazonaws.com/file-${downloaded.length}` }] }));
    }
    if (url.pathname.endsWith('/step/completeDocUpload')) {
      completes++;
      if (options.failComplete) throw new Error('response lost');
      return json(status('pending'));
    }
    throw new Error('Unexpected request');
  });
  t.after(() => fetchMock.mock.restore());
  const result = await withLogSink(record => {
    logs.push(record);
    if (options.cancelWaiting && record.event === 'waiting_for_review') controller.abort();
  }, () => runDocumentWorkflow(config, { submit: options.submit ?? true, signal: controller.signal,
    resumeUncertainStage: options.resumeUncertainStage }));
  const release = await acquireLock(directory, `sheerid:${id}`);
  await release();
  return { result, logs, requests, downloaded, uploaded, polls, completes };
}

test('Pending is intermediate; keep the lock and poll until verified', async t => {
  const output = await scenario(t, [status('docUpload'), status('pending'), status('pending'), status('success')]);
  assert.equal(output.result.status, 'verified');
  assert.equal(output.polls, 4);
  assert.equal(output.completes, 1);
  assert.equal(output.logs.filter(log => log.event === 'run_finished').length, 1);
});

test('Review rejection fetches fresh original bytes and a new upload URL', async t => {
  const output = await scenario(t, [status('docUpload'), status('pending'),
    status('docUpload', { rejectionReasons: ['DOCUMENT_UNREADABLE'] }), status('pending'), status('success')]);
  assert.equal(output.result.status, 'verified');
  assert.equal(output.result.uploadAttempt, 2);
  assert.equal(output.downloaded.length, 2);
  assert.notDeepEqual(output.downloaded[0], output.downloaded[1]);
  assert.deepEqual(output.uploaded, output.downloaded);
  assert.equal(output.completes, 2);
  assert.deepEqual(output.requests.filter(request => request.method === 'PUT').map(request => request.path), ['/file-1', '/file-2']);
  assert.ok(output.logs.some(log => log.event === 'document_refetch'));
});

test('Terminal errors and exhausted review limits fail without another upload', async t => {
  const output = await scenario(t, [status('docUpload'), status('error', { errorIds: ['docReviewLimitExceeded'] })]);
  assert.equal(output.result.status, 'failed');
  assert.deepEqual(output.result.errorIds, ['docReviewLimitExceeded']);
  assert.equal(output.completes, 1);
});

test('Already pending and email verification are polled without uploading', async t => {
  const output = await scenario(t, [status('pending'), status('emailLoop'), status('success')]);
  assert.equal(output.result.status, 'verified');
  assert.equal(output.downloaded.length, 0);
});

test('Read-only status queries still report pending once', async t => {
  const output = await scenario(t, [status('pending')], { submit: false });
  assert.equal(output.result.status, 'pending');
  assert.equal(output.polls, 1);
});

test('Lost PUT response only queries; no duplicate upload or completion request', async t => {
  const output = await scenario(t, [status('docUpload'), status('docUpload'), status('error')], { failPut: true });
  assert.equal(output.result.status, 'failed');
  assert.equal(output.uploaded.length, 1);
  assert.equal(output.completes, 0);
});

test('Lost completion response can resolve to success through GET', async t => {
  const output = await scenario(t, [status('docUpload'), status('pending'), status('success')], { failComplete: true });
  assert.equal(output.result.status, 'verified');
  assert.equal(output.completes, 1);
});

test('Transient GET failures back off, then finish on success', async t => {
  const output = await scenario(t, [status('pending'), new Error('temporary disconnect'),
    new Response(null, { status: 503 }), new Response(null, { status: 429, headers: { 'Retry-After': '0' } }), status('success')]);
  assert.equal(output.result.status, 'verified');
  assert.equal(output.logs.filter(log => log.event === 'status_query_retry').length, 3);
  assert.equal(output.uploaded.length, 0);
});

test('429 without Retry-After or with a terminal error is not retried', async t => {
  await t.test('no retry header', async sub => {
    const output = await scenario(sub, [new Response(null, { status: 429 })]);
    assert.equal(output.result.status, 'failed');
    assert.equal(output.polls, 1);
  });
  await t.test('permanent limit despite a retry header', async sub => {
    const output = await scenario(sub, [new Response(JSON.stringify(status('error', { errorIds: ['verificationLimitExceeded'] })),
      { status: 429, headers: { 'Retry-After': '0' } })]);
    assert.equal(output.result.status, 'failed');
    assert.equal(output.polls, 1);
  });
});

test('Stopping during polling cancels the wait and releases the task lock', async t => {
  const output = await scenario(t, [status('pending')], { cancelWaiting: true });
  assert.equal(output.result.code, 'CANCELLED');
  assert.equal(output.polls, 1);
  assert.equal(output.downloaded.length, 0);
});

test('Resuming an uncertain upload polls the existing submission without uploading again', async t => {
  const output = await scenario(t, [status('docUpload'), status('docUpload'), status('pending'), status('success')],
    { resumeUncertainStage: 'complete_upload' });
  assert.equal(output.result.status, 'verified');
  assert.equal(output.downloaded.length, 0);
  assert.equal(output.completes, 0);
});

test('Stopping an uncertain resumed upload retains its uncertainty for the next resume', async t => {
  const output = await scenario(t, [status('docUpload')],
    { resumeUncertainStage: 'upload_bytes', cancelWaiting: true });
  assert.equal(output.result.uncertainStage, 'upload_bytes');
  assert.equal(output.result.submissionUncertain, true);
});
