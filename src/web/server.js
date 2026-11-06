import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AutomationError, requireValue } from '../core/errors.js';
import { WebJobs } from './jobs.js';
import { isMainModule } from '../../scripts/process.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function createWebServer({ port = 8787, host = '127.0.0.1', publicOrigin,
  password = 'JenkinWoo', configFile = resolve('config/sheerid.local.json'), workflow } = {}) {
  requireValue(['127.0.0.1', '0.0.0.0'].includes(host), 'Web 监听地址无效');
  let published;
  if (publicOrigin) {
    try { published = new URL(publicOrigin); } catch { throw new AutomationError('INVALID_CONFIG', '公网地址无效'); }
    requireValue(published.protocol === 'https:' && !published.username && !published.password
      && published.pathname === '/' && !published.search && !published.hash, '公网地址必须为 HTTPS 域名');
  }
  requireValue(typeof password === 'string' && password.length > 0, '访问密码不能为空');
  requireValue(host !== '0.0.0.0' || published, '公网监听需要配置 HTTPS 访问地址');
  const digest = value => createHash('sha256').update(value).digest();
  const expectedPassword = digest(password);
  const sessionKey = randomBytes(32).toString('hex');
  const expectedSession = digest(sessionKey);
  const token = randomBytes(32).toString('hex');
  const jobs = new WebJobs({ configFile, workflow });
  let origin;
  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const status = error.code === 'JOB_NOT_FOUND' ? 404
        : ['SERVER_STOPPING', 'JOB_ACTIVE'].includes(error.code) ? 409
          : error.code === 'FORBIDDEN' ? 403 : error.code === 'BODY_TOO_LARGE' ? 413
            : error instanceof AutomationError ? 400 : 500;
      json(response, status, { error: { code: error instanceof AutomationError ? error.code : 'WEB_ERROR',
        message: error instanceof AutomationError ? error.message : '请求处理失败，请重试' } });
    });
  });
  server.requestTimeout = 120000;

  function authorize(request, write = false) {
    const address = server.address();
    const hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    if (published) hosts.push(published.host);
    if (!hosts.includes(request.headers.host)) throw new AutomationError('FORBIDDEN', '仅允许从本机工作台访问');
    const expectedOrigin = published && request.headers.host === published.host ? published.origin : `http://${request.headers.host}`;
    // The trusted instabox proxy can replace Host with localhost:port while
    // retaining the browser's public HTTPS Origin. Trust only our configured
    // public origin; never derive it from arbitrary forwarded headers.
    if (request.headers.origin && request.headers.origin !== expectedOrigin
      && request.headers.origin !== published?.origin) {
      throw new AutomationError('FORBIDDEN', '请求来源不匹配');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new AutomationError('FORBIDDEN', '请求来源不匹配');
    if (write && request.headers['x-local-token'] !== token) {
      throw new AutomationError('FORBIDDEN', '页面会话已失效，请刷新后重试');
    }
  }

  async function handle(request, response) {
    authorize(request);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(request.url, origin);
    if (request.method === 'GET' && assets.has(url.pathname)) {
      const [filename, type] = assets.get(url.pathname);
      response.writeHead(200, { 'Content-Type': type });
      response.end(await readFile(new URL(`./public/${filename}`, import.meta.url)));
      return;
    }
    const cookie = (request.headers.cookie ?? '').split(';').map(item => item.trim())
      .find(item => item.startsWith('one-session='))?.slice('one-session='.length) ?? '';
    const passwordValid = timingSafeEqual(expectedPassword, digest(request.headers['x-web-password'] ?? ''));
    const sessionValid = timingSafeEqual(expectedSession, digest(cookie));
    if (!passwordValid && !sessionValid) {
      json(response, 401, { error: { code: 'UNAUTHORIZED', message: '请输入正确的访问密码' } });
      return;
    }
    authorize(request, request.method !== 'GET');
    if (request.method === 'GET' && url.pathname === '/api/session') {
      if (passwordValid) response.setHeader('Set-Cookie', `one-session=${sessionKey}; Path=/; HttpOnly; SameSite=Strict${published ? '; Secure' : ''}`);
      json(response, 200, { token });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/jobs') {
      json(response, 200, jobs.list());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      requireValue(request.headers['content-type']?.split(';')[0] === 'application/json', '任务请求需要 JSON 格式');
      let input;
      try { input = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8')); }
      catch (error) {
        if (error instanceof AutomationError) throw error;
        throw new AutomationError('INVALID_CONFIG', '表单内容不是有效 JSON');
      }
      const job = await jobs.start(input);
      json(response, 202, { job });
      return;
    }
    const jobRoute = url.pathname.match(/^\/api\/jobs\/([a-f\d]{24})(\/(?:cancel|resume))?$/i);
    if (jobRoute && request.method === 'DELETE' && !jobRoute[2]) {
      json(response, 200, jobs.remove(jobRoute[1]));
      return;
    }
    if (jobRoute && request.method === 'GET' && !jobRoute[2]) {
      const after = Number(url.searchParams.get('after') ?? 0);
      requireValue(Number.isSafeInteger(after) && after >= 0, '日志位置无效');
      json(response, 200, jobs.get(jobRoute[1], after));
      return;
    }
    if (jobRoute?.[2] && request.method === 'POST') {
      json(response, 200, { job: jobRoute[2].toLowerCase() === '/resume'
        ? jobs.resume(jobRoute[1]) : jobs.cancel(jobRoute[1]) });
      return;
    }
    json(response, 404, { error: { code: 'NOT_FOUND', message: '页面或接口不存在' } });
  }

  return {
    server, jobs,
    async start() {
      await jobs.initialize();
      await new Promise((resolveStarted, reject) => {
        const fail = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolveStarted(); };
        server.once('error', fail);
        server.once('listening', ready);
        server.listen(port, host);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      return published?.origin ?? origin;
    },
    async close() {
      await jobs.close();
      server.closeAllConnections();
      if (server.listening) await new Promise(resolveClosed => server.close(resolveClosed));
    },
  };
}

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw new AutomationError('BODY_TOO_LARGE', '文件或请求内容超过大小限制');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new AutomationError('BODY_TOO_LARGE', '文件或请求内容超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8787' } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须为 1024–65535 的整数');
  const app = createWebServer({ port, host: process.env.ONE_WEB_HOST || '127.0.0.1',
    publicOrigin: process.env.ONE_WEB_PUBLIC_ORIGIN,
    password: process.env.ONE_WEB_PASSWORD });
  const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  app.start().then(origin => process.stdout.write(`sheeridVerify 本机工作台已启动：${origin}\n按 Ctrl+C 关闭服务。\n`)).catch(error => {
    process.stderr.write(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请用 --port 指定其他端口。\n`
      : error instanceof AutomationError ? `Web 服务启动失败：${error.message}\n` : 'Web 服务启动失败。\n');
    process.exitCode = 1;
    void app.close();
  });
}
