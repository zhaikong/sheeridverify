import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { createWebServer } from '../src/web/server.js';
import { createLogger } from '../src/core/logger.js';
import { webConfig } from './fixtures/web-config.js';

const fetch = (url, options = {}) => globalThis.fetch(url, { ...options,
  headers: { 'X-Web-Password': 'JenkinWoo', ...options.headers } });

const url = 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb';
const input = (extra = {}) => ({ url, firstName: 'PrivateFirst', lastName: 'PrivateLast', birthDate: '2000-01-02', ...extra });
async function fixture(t, options = {}) {
  const { configFile, raw } = await webConfig(t);
  const app = createWebServer({ port: 0, configFile, ...options });
  const origin = await app.start();
  t.after(() => app.close());
  const session = await (await fetch(`${origin}/api/session`)).json();
  const request = async (path, body, extra = {}) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'X-Local-Token': session.token, 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const start = async body => {
    const response = await request('/api/jobs', body);
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    const { job } = await response.json();
    await app.jobs.jobs.get(job.id).done;
    return app.jobs.get(job.id);
  };
  return { app, origin, request, start, configFile, raw };
}

test('Web serves assets, protects writes and does not expose saved settings', async t => {
  const { origin, request } = await fixture(t);
  for (const path of ['/', '/app.js', '/style.css']) assert.equal((await fetch(origin + path)).status, 200);
  assert.equal((await fetch(origin + '/api/session', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(origin + '/api/jobs', { method: 'POST' })).status, 403);
  assert.equal((await request('/api/jobs', input(), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/jobs', input(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(origin + '/config/sheerid.local.json')).status, 404);
});

test('Web uses the five request fields with fresh settings and only the entered proxy', async t => {
  let received, options;
  const { start, configFile, raw } = await fixture(t, { workflow: async (config, opts) => {
    received = config; options = opts;
    createLogger('fixture')('stage_started', { stage: 'fill', data: config.data });
    return { status: 'pending', data: config.data };
  } });
  const previous = { url: process.env.AUTOMATION_URL, proxy: process.env.AUTOMATION_PROXY };
  process.env.AUTOMATION_URL = 'https://wrong.example';
  process.env.AUTOMATION_PROXY = 'invalid://wrong';
  t.after(() => {
    for (const [key, value] of [['AUTOMATION_URL', previous.url], ['AUTOMATION_PROXY', previous.proxy]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  let nextId = 1;
  for (const proxy of [undefined, '', '   ', '127.0.0.1:8899:user:pass']) {
    const taskUrl = url.replace('bbbbbbbbbbbbbbbbbbbbbbbb', String(nextId++).padStart(24, '0'));
    const snapshot = await start(input({ proxy, url: taskUrl }));
    assert.equal(received.url, taskUrl);
    assert.equal(received.data.firstName, 'PrivateFirst');
    assert.equal(received.data.lastName, 'PrivateLast');
    assert.equal(received.data.birthDate, '2000-01-02');
    assert.equal(received.data.email, 'privatefirst.privatelast@example.edu');
    for (const key of ['country', 'organization', 'consent']) assert.deepEqual(received.data[key], raw.data[key]);
    assert.deepEqual(received.document, raw.document);
    assert.deepEqual(received.selectors, raw.selectors);
    assert.equal(received.timeouts.readyMs, raw.timeouts.readyMs);
    assert.equal(received.browser.locale, raw.browser.locale);
    assert.equal(received.interaction.keyDelayMs.min, raw.interaction.keyDelayMs.min);
    assert.equal(options.submit, true);
    if (proxy?.trim()) assert.deepEqual(received.proxy, { server: 'http://127.0.0.1:8899', username: 'user', password: 'pass' });
    else assert.equal(received.proxy, null);
    assert.doesNotMatch(JSON.stringify(snapshot), /PrivateFirst|PrivateLast|saved-secret/);
  }
  raw.data.organization.emailDomain = 'example.edu';
  raw.browser = { ...raw.browser, headless: false, keepOpen: true, autoFill: false };
  await writeFile(configFile, JSON.stringify(raw));
  await start(input());
  assert.equal(received.data.email, 'privatefirst.privatelast@example.edu');
  assert.equal(received.browser.autoFill, false);
  assert.equal(options.submit, false);
});

test('Duplicate verification IDs share one job; cancellation preserves uncertainty', async t => {
  const attempts = [];
  const { app, origin, request } = await fixture(t, { workflow: async (_config, options) => {
    attempts.push(options);
    const { signal } = options;
    const log = createLogger('fixture');
    log('run_finished', { status: 'submission_unknown', code: 'RESULT_UNKNOWN' });
    log('browser_kept_open', { stage: 'await_user_close' });
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const response = await request('/api/jobs', input());
  const { job } = await response.json();
  assert.equal(response.status, 202);
  const duplicate = await request('/api/jobs', input());
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).job.id, job.id);
  assert.equal(job.id, 'bbbbbbbbbbbbbbbbbbbbbbbb');
  const state = await (await fetch(`${origin}/api/jobs/${job.id}?after=1`)).json();
  assert.equal(state.job.stage, 'await_user_close');
  assert.equal(state.events.length, 3);
  const queue = await (await fetch(`${origin}/api/jobs`)).json();
  assert.equal(queue.jobs[0].id, job.id);
  assert.equal(queue.running, 1);
  assert.equal((await request(`/api/jobs/${job.id}/cancel`)).status, 200);
  await app.jobs.jobs.get(job.id).done;
  assert.equal(app.jobs.get(job.id).job.state, 'cancelled');
  assert.equal(app.jobs.get(job.id).job.result.status, 'submission_unknown');
  assert.equal(app.jobs.running.size, 0);
  assert.equal((await request(`/api/jobs/${job.id}/resume`, undefined, { 'X-Local-Token': '' })).status, 403);
  const resumed = await request(`/api/jobs/${job.id}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).job.state, 'running');
  await request(`/api/jobs/${job.id}/resume`);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].resumeUncertainStage, 'personal_info');
  assert.notEqual(attempts[0].signal, attempts[1].signal);
  assert.equal(app.jobs.jobs.size, 1);
});

test('Rejects invalid input or extra settings without running workflow', async t => {
  let called = false;
  const { request, start } = await fixture(t, { workflow: async () => { called = true; throw new Error('secret-password'); } });
  for (const body of [null, {}, input({ firstName: '' }), input({ url: 'https://evil.example' }), input({ proxy: {} }), input({ config: {} }), input({ extra: 'invalid' }), input({ document: { path: 'C:/secret.pdf' } }),
    ...['url', 'firstName', 'lastName', 'birthDate'].map(key => input({ [key]: undefined }))]) {
    assert.equal((await request('/api/jobs', body)).status, 400);
  }
  assert.equal(called, false);
  const state = await start(input());
  assert.equal(state.job.state, 'failed');
  assert.equal(state.job.result.code, 'WEB_WORKFLOW_ERROR');
  assert.doesNotMatch(JSON.stringify(state), /secret-password/);
});

test('Web starts with no task-specific fields in settings and never writes submitted values back', async t => {
  let received;
  const { start, configFile, raw } = await fixture(t, { workflow: async config => { received = config; return { status: 'verified' }; } });
  delete raw.url;
  for (const key of ['firstName', 'lastName', 'email', 'birthDate']) delete raw.data[key];
  await writeFile(configFile, JSON.stringify(raw));
  await start(input());
  assert.equal(received.url, url);
  assert.equal(received.data.email, 'privatefirst.privatelast@example.edu');
  assert.equal(received.data.firstName, 'PrivateFirst');
  assert.equal(received.data.lastName, 'PrivateLast');
  assert.equal(received.data.birthDate, '2000-01-02');
  const { readFile } = await import('node:fs/promises');
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), raw);
});

test('DELETE removes finished jobs, protects writes, and allows explicit readmission', async t => {
  const { origin, start } = await fixture(t, { workflow: async () => ({ status: 'verified' }) });
  const { job } = await start(input());
  const path = `${origin}/api/jobs/${job.id}`;
  const { token } = await (await fetch(`${origin}/api/session`)).json();
  const headers = { 'X-Local-Token': token };
  assert.equal((await fetch(path, { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(path, { method: 'DELETE', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(path)).status, 200);
  const removed = await fetch(`${origin}/api/jobs/${job.id.toUpperCase()}`, { method: 'DELETE', headers });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { id: job.id, deleted: true });
  assert.equal((await fetch(path)).status, 404);
  assert.equal((await fetch(path, { method: 'DELETE', headers })).status, 404);
  assert.equal((await (await fetch(`${origin}/api/jobs`)).json()).jobs.length, 0);
  const added = await start(input());
  assert.equal(added.job.id, job.id);
  assert.equal(added.job.state, 'completed');
});

test('DELETE rejects active tasks with a conflict response', async t => {
  const { origin, request } = await fixture(t, { workflow: async (_config, { signal }) => {
    await new Promise(resolveDone => signal.addEventListener('abort', resolveDone, { once: true }));
    return { status: 'cancelled' };
  } });
  const { job } = await (await request('/api/jobs', input())).json();
  const { token } = await (await fetch(`${origin}/api/session`)).json();
  const response = await fetch(`${origin}/api/jobs/${job.id}`, { method: 'DELETE', headers: { 'X-Local-Token': token } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'JOB_ACTIVE');
});
