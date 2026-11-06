import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AutomationError, requireValue } from './errors.js';

const DIRECT = new Set(['direct', 'none', 'off']);

// Unset, null, blank strings and objects whose fields are all blank mean "not configured".
function isUnset(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value).every(item => item === undefined || item === null
      || (typeof item === 'string' && item.trim() === ''));
  }
  return false;
}

function isDirect(value) {
  return value === false || (typeof value === 'string' && DIRECT.has(value.trim().toLowerCase()));
}

/**
 * Resolve the effective proxy for a run:
 * - false / "direct": connect directly;
 * - an explicit proxy: use it;
 * - unset (missing, null, "" or all-blank object): use the current system proxy, else direct.
 */
export async function resolveProxy(value, env = process.env) {
  if (isDirect(value)) return null;
  if (!isUnset(value)) return parseProxy(value);
  return systemProxy(env);
}

export async function systemProxy(env = process.env) {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return parseSystemProxy(value, `环境变量 ${name}`);
  }
  if (process.platform !== 'win32') return null;
  const settings = await readWindowsInternetSettings();
  if (!settings || Number(settings.ProxyEnable) !== 1 || !settings.ProxyServer?.trim()) return null;
  return parseSystemProxy(pickWindowsProxy(settings.ProxyServer), 'Windows 系统代理');
}

async function readWindowsInternetSettings() {
  try {
    const { stdout } = await promisify(execFile)('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { windowsHide: true, timeout: 5000 });
    const values = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
      if (match) values[match[1]] = match[2].trim();
    }
    // REG_DWORD values are printed as hex, e.g. 0x1.
    if (values.ProxyEnable) values.ProxyEnable = Number.parseInt(values.ProxyEnable, 16);
    return values;
  } catch {
    return null; // Registry unavailable: behave as if no system proxy is configured.
  }
}

// ProxyServer is either "host:port" or "http=host:port;https=host:port;socks=host:port".
function pickWindowsProxy(value) {
  if (!value.includes('=')) return value;
  const entries = Object.fromEntries(value.split(';').map(part => part.trim().split('=', 2))
    .filter(([key, server]) => key && server).map(([key, server]) => [key.toLowerCase(), server.trim()]));
  if (entries.https) return entries.https;
  if (entries.http) return entries.http;
  if (entries.socks) return /^[a-z][a-z\d+.-]*:\/\//i.test(entries.socks) ? entries.socks : `socks5://${entries.socks}`;
  return '';
}

function parseSystemProxy(value, source) {
  try {
    return parseProxy(value);
  } catch {
    throw new AutomationError('INVALID_SYSTEM_PROXY', `${source} 的代理地址无效；请修正系统代理，或在配置中显式设置 proxy（"direct" 表示直连）`);
  }
}

export function parseProxy(value) {
  if (isUnset(value) || isDirect(value)) return null;
  try {
    const object = typeof value === 'object' && !Array.isArray(value);
    if (object) {
      requireValue(Object.keys(value).every(key => ['server', 'username', 'password'].includes(key)), 'proxy 包含不支持的配置项');
      for (const key of ['username', 'password']) {
        requireValue(value[key] === undefined || typeof value[key] === 'string', '代理账号密码必须是字符串');
      }
    }
    let input = object ? value.server : value;
    requireValue(typeof input === 'string' && input.trim().length > 0, '代理地址必须是非空字符串');
    input = input.trim().replace(/^sock5:\/\//i, 'socks5://');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) input = `http://${input}`;
    // Also accept the provider's host:port:username:password notation, keeping
    // colons in the password. Standard URLs must percent-encode credentials.
    const short = input.match(/^(https?|socks5h?):\/\/(\[[^\]]+\]|[^:/\s]+):(\d+):([^:]*):(.*)$/i);
    if (short && !input.slice(input.indexOf('://') + 3).includes('@')) {
      input = `${short[1]}://${encodeURIComponent(short[4])}:${encodeURIComponent(short[5])}@${short[2]}:${short[3]}`;
    }
    const url = new URL(input);
    requireValue(['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol), '代理仅支持 HTTP、HTTPS 或 SOCKS5');
    requireValue(Boolean(url.hostname) && !url.search && !url.hash && ['', '/'].includes(url.pathname), '代理地址不能包含路径或查询参数');
    const embedded = Boolean(url.username || url.password);
    requireValue(!(embedded && object && (value.username !== undefined || value.password !== undefined)), '代理凭据只能写在 URL 或独立字段中的一处');
    const username = embedded ? decodeURIComponent(url.username) : object ? value.username ?? '' : '';
    const password = embedded ? decodeURIComponent(url.password) : object ? value.password ?? '' : '';
    requireValue(!/[\r\n\0]/.test(username + password) && (!password || username.length > 0), '代理凭据格式无效');
    if (url.protocol.startsWith('socks5') && !url.port) url.port = '1080';
    requireValue(url.port !== '0', '代理端口必须大于 0');
    return Object.freeze({ server: `${url.protocol}//${url.host}`, username, password });
  } catch {
    // URL/parser exceptions can contain the entire password-bearing input.
    throw new AutomationError('INVALID_PROXY', '代理配置无效；请使用 HTTP/SOCKS5 地址，或 host:port:username:password 格式');
  }
}

export function upstreamProxyUrl(proxy) {
  const url = new URL(proxy.server);
  // Resolve target hostnames at the SOCKS5 upstream for both HTTP and CONNECT.
  if (url.protocol === 'socks5:') url.protocol = 'socks5h:';
  url.username = encodeURIComponent(proxy.username);
  url.password = encodeURIComponent(proxy.password);
  return url.href;
}
