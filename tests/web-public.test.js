import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createWebServer } from '../src/web/server.js';
import { webConfig } from './fixtures/web-config.js';

const publicOrigin = 'https://workspace.example.com';
const password = 'fixture-password-for-offline-tests';

test('Public deployment requires a nonempty password and an explicit HTTPS origin', () => {
  assert.throws(() => createWebServer({ host: '0.0.0.0', publicOrigin, password: '' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => createWebServer({ host: '0.0.0.0', password }), { code: 'INVALID_CONFIG' });
  assert.throws(() => createWebServer({ publicOrigin: 'http://workspace.example.com', password }), { code: 'INVALID_CONFIG' });
});

test('Public HTTPS origin authenticates, keeps CSRF protections and supports queue requests', async t => {
  const { configFile } = await webConfig(t);
  const app = createWebServer({ port: 0, host: '0.0.0.0', publicOrigin, password, configFile,
    workflow: async () => ({ status: 'pending' }) });
  await app.start();
  t.after(() => app.close());
  const call = (path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: app.server.address().port, path,
      method: body ? 'POST' : 'GET', headers: { Host: 'workspace.example.com', ...headers } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    req.on('error', reject); req.end(body);
  });
  const denied = await call('/api/session');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers['www-authenticate'], undefined);
  for (const path of ['/', '/app.js', '/style.css']) {
    const asset = await call(path);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['www-authenticate'], undefined);
    assert.ok(!asset.text.includes(password));
    assert.ok(!asset.text.includes('JenkinWoo'));
  }
  assert.equal((await call('/api/jobs')).status, 401);
  assert.equal((await call('/api/session', { 'X-Web-Password': 'wrong' })).status, 401);
  assert.equal((await call('/api/session', { Cookie: 'one-session=forged' })).status, 401);
  const session = await call('/api/session', { 'X-Web-Password': password });
  assert.equal(session.status, 200);
  const cookie = session.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  const sessionCookie = cookie.split(';')[0];
  assert.equal((await call('/api/session', { Cookie: sessionCookie })).status, 200);
  assert.equal((await call('/api/jobs', { Cookie: sessionCookie })).status, 200);
  const token = JSON.parse(session.text).token;
  const body = JSON.stringify({ url: 'https://my.sheerid.com/rest/v2/verification/aaaaaaaaaaaaaaaaaaaaaaaa',
    firstName: 'Test', lastName: 'Student', birthDate: '2000-01-02' });
  const headers = { Cookie: sessionCookie, Origin: publicOrigin, 'Content-Type': 'application/json', 'X-Local-Token': token };
  assert.equal((await call('/api/jobs', { 'X-Local-Token': token, 'Content-Type': 'application/json' }, body)).status, 401);
  assert.equal((await call('/api/jobs', headers, body)).status, 202);
  assert.equal((await call('/api/jobs', { ...headers, Host: `localhost:${app.server.address().port}` }, body)).status, 202);
  assert.equal((await call('/api/jobs', { ...headers, Host: `127.0.0.1:${app.server.address().port}` }, body)).status, 202);
  assert.equal((await call('/api/jobs', { ...headers, Host: `localhost:${app.server.address().port}`, Origin: 'https://evil.example' }, body)).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, Origin: 'https://evil.example' }, body)).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, 'X-Local-Token': 'wrong' }, body)).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, Host: 'evil.example' })).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, 'Sec-Fetch-Site': 'cross-site' }, body)).status, 403);
  assert.equal((await call('/config/sheerid.local.json', { 'X-Web-Password': password })).status, 404);
});
