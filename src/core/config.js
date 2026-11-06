import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AutomationError, requireValue } from './errors.js';
import { resolveProxy } from './proxy.js';

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function checkKeys(value, allowed, label) {
  requireValue(isRecord(value), `${label} 必须是对象`);
  requireValue(Object.keys(value).every(key => allowed.includes(key)), `${label} 包含不支持的配置项`);
}

export function normalizeWebConfig(value = {}) {
  checkKeys(value, ['concurrency'], 'web');
  const concurrency = value.concurrency ?? 1;
  requireValue(Number.isSafeInteger(concurrency) && concurrency >= 1,
    'web.concurrency 必须是大于等于 1 的整数');
  return { concurrency };
}

function timeout(value, fallback, label) {
  const result = value ?? fallback;
  requireValue(Number.isInteger(result) && result >= 1000 && result <= 300000,
    `${label} 必须是 1000–300000 毫秒的整数`);
  return result;
}

function delayRange(value, fallback, label, limit) {
  const range = value ?? fallback;
  checkKeys(range, ['min', 'max'], label);
  requireValue(Number.isInteger(range.min) && Number.isInteger(range.max)
    && range.min >= 0 && range.max >= range.min && range.max <= limit,
    `${label} 必须满足 0 <= min <= max <= ${limit}（毫秒整数）`);
  return { min: range.min, max: range.max };
}

export async function loadConfig(filename, env = process.env) {
  let raw;
  try {
    raw = JSON.parse((await readFile(resolve(filename), 'utf8')).replace(/^\uFEFF/, ''));
  } catch (cause) {
    throw new AutomationError('INVALID_CONFIG', '配置文件无法读取或不是有效 JSON', { cause });
  }
  return normalizeConfig(raw, env);
}

// Both the CLI file loader and the local Web form use the same validation.
export async function normalizeConfig(raw, env = process.env) {
  checkKeys(raw, ['app', 'url', 'proxy', 'browser', 'timeouts', 'interaction', 'document', 'data', 'selectors', 'artifactsDir', 'web', 'polling', 'emailDomain'], '配置');
  const web = normalizeWebConfig(raw.web);
  const polling = raw.polling ?? {};
  const rawDomain = raw.data?.organization?.emailDomain ?? raw.emailDomain ?? raw.data?.emailDomain;
  requireValue(rawDomain === undefined || typeof rawDomain === 'string', 'emailDomain 必须是字符串');
  const emailDomain = typeof rawDomain === 'string' ? rawDomain.trim().replace(/^@+/, '') : '';
  if (emailDomain) {
    requireValue(/^[^\s@]+\.[^\s@]+$/.test(emailDomain), 'emailDomain 格式无效，必须如 xxx.edu');
  }
  checkKeys(polling, ['intervalMs'], 'polling');
  const intervalMs = timeout(polling.intervalMs, 5000, 'polling.intervalMs');
  requireValue(typeof raw.app === 'string' && /^[a-z][a-z0-9-]*$/.test(raw.app), 'app 格式无效');
  const browser = raw.browser ?? {};
  const timeouts = raw.timeouts ?? {};
  const interaction = raw.interaction ?? {};
  const document = raw.document ?? {};
  checkKeys(document, ['path', 'url'], 'document');
  requireValue(document.path === undefined || typeof document.path === 'string', 'document.path 必须是本地路径字符串');
  requireValue(document.url === undefined || typeof document.url === 'string', 'document.url 必须是网络地址字符串');
  requireValue(!(document.path?.trim() && document.url?.trim()), 'document.path 与 document.url 只能填写一个');
  checkKeys(interaction, ['keyDelayMs', 'fieldDelayMs', 'submitDelayMs'], 'interaction');
  checkKeys(browser, ['headless', 'locale', 'keepOpen', 'autoFill'], 'browser');
  checkKeys(timeouts, ['apiMs', 'downloadMs', 'uploadMs', 'actionMs', 'navigationMs', 'readyMs', 'humanMs', 'resultMs'], 'timeouts');
  requireValue(browser.headless === undefined || typeof browser.headless === 'boolean', 'headless 必须是布尔值');
  requireValue(browser.keepOpen === undefined || typeof browser.keepOpen === 'boolean', 'keepOpen 必须是布尔值');
  requireValue(browser.autoFill === undefined || typeof browser.autoFill === 'boolean', 'autoFill 必须是布尔值');
  requireValue(browser.autoFill !== false || (browser.headless !== true && browser.keepOpen !== false),
    '手动填写模式需要 headless: false，并保持 keepOpen: true');
  requireValue(!(browser.headless === true && browser.keepOpen === true), '无界面模式不能设置 keepOpen: true');
  requireValue(browser.locale === undefined || (typeof browser.locale === 'string' && browser.locale.length > 0), 'locale 格式无效');
  requireValue(raw.artifactsDir === undefined || (typeof raw.artifactsDir === 'string' && raw.artifactsDir.length > 0), 'artifactsDir 格式无效');
  let url;
  try { url = new URL(env.AUTOMATION_URL || raw.url); } catch {
    throw new AutomationError('INVALID_CONFIG', 'url 或 AUTOMATION_URL 必须是有效 URL');
  }
  requireValue(url.protocol === 'https:' && !url.username && !url.password, '仅支持无嵌入凭据的 HTTPS URL');
  return {
    app: raw.app, url: url.href, data: raw.data, selectors: raw.selectors ?? {}, web, polling: { intervalMs }, emailDomain,
    // An empty AUTOMATION_PROXY falls back to the config file instead of forcing a value.
    proxy: await resolveProxy(env.AUTOMATION_PROXY?.trim() ? env.AUTOMATION_PROXY : raw.proxy, env),
    document: { path: document.path ?? '', url: document.url ?? '' },
    browser: {
      headless: browser.headless ?? false,
      locale: browser.locale ?? 'en-US',
      keepOpen: browser.keepOpen ?? !(browser.headless ?? false),
      autoFill: browser.autoFill ?? true,
    },
    timeouts: {
      apiMs: timeout(timeouts.apiMs, 20000, 'apiMs'),
      downloadMs: timeout(timeouts.downloadMs, 120000, 'downloadMs'),
      uploadMs: timeout(timeouts.uploadMs, 120000, 'uploadMs'),
      actionMs: timeout(timeouts.actionMs, 15000, 'actionMs'),
      navigationMs: timeout(timeouts.navigationMs, 60000, 'navigationMs'),
      readyMs: timeout(timeouts.readyMs, 120000, 'readyMs'),
      humanMs: timeout(timeouts.humanMs, 180000, 'humanMs'),
      resultMs: timeout(timeouts.resultMs, 45000, 'resultMs'),
    },
    interaction: {
      keyDelayMs: delayRange(interaction.keyDelayMs, { min: 40, max: 120 }, 'keyDelayMs', 1000),
      fieldDelayMs: delayRange(interaction.fieldDelayMs, { min: 500, max: 1200 }, 'fieldDelayMs', 10000),
      submitDelayMs: delayRange(interaction.submitDelayMs, { min: 1000, max: 2000 }, 'submitDelayMs', 10000),
    },
    artifactsDir: resolve(raw.artifactsDir ?? '.runs'),
  };
}
