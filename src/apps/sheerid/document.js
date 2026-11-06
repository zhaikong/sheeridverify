import { open } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { AutomationError, requireValue } from '../../core/errors.js';
import { networkFetch } from '../../core/network.js';

const MAX_BYTES = 20 * 1024 * 1024; // Buffering limit, not a claim about a program's upload limit.

export function selectDocumentSource(document = {}, { file, url } = {}, data) {
  requireValue(!(file !== undefined && url !== undefined), '--file 与 --url 只能指定一个');
  if (file !== undefined) return { path: file };
  if (url === undefined) {
    requireValue(!(document.path?.trim() && document.url?.trim()), 'document.path 与 document.url 只能填写一个');
    if (!document.url?.trim()) return { path: document.path };
    url = document.url;
  }
  // Standalone material configs may omit personal data. When supplied, both
  // names are required so the source retrieves the intended original document.
  if (data?.firstName === undefined && data?.lastName === undefined) return { url };
  requireValue(typeof data?.firstName === 'string' && data.firstName.trim().length > 0
    && typeof data?.lastName === 'string' && data.lastName.trim().length > 0,
    '按姓名下载材料需要同时填写 data.firstName 和 data.lastName');
  const sourceUrl = downloadUrl(url);
  sourceUrl.searchParams.set('name', `${data.firstName.trim()} ${data.lastName.trim()}`);
  return { url: sourceUrl.href };
}

function metadata(bytes, filename) {
  let mimeType;
  let extension;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = 'image/png'; extension = '.png';
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    mimeType = 'image/jpeg'; extension = '.jpg';
  } else if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    mimeType = 'application/pdf'; extension = '.pdf';
  }
  requireValue(Boolean(mimeType), '材料内容必须是 PNG、JPEG 或 PDF，不接受 HTML 登录页面或 JSON 响应');
  if (filename) {
    const suffix = extname(filename).toLowerCase();
    requireValue(suffix === extension || (extension === '.jpg' && suffix === '.jpeg'),
      '本地材料扩展名与文件头不一致');
  }
  return { bytes, mimeType, fileSize: bytes.length, fileName: filename ?? `document${extension}` };
}

function downloadUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new AutomationError('INVALID_DOCUMENT_URL', '材料网络地址不是有效 URL');
  }
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
    '材料网络地址仅支持无嵌入账号密码的 HTTP/HTTPS URL');
  url.hash = '';
  return url;
}

async function readRemoteDocument(source, { signal, timeoutMs = 120000 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const downloadSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response;
  try {
    let url = downloadUrl(source);
    for (let redirects = 0; ; redirects++) {
      // A loopback material URL names this computer, not the upstream proxy host.
      // Re-evaluate each redirect so remote destinations still use the configured route.
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      response = await (loopback ? fetch : networkFetch)(url, { signal: downloadSignal, redirect: 'manual',
        cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      requireValue(redirects < 3, '材料下载重定向次数超过 3 次');
      const location = response.headers.get('location');
      requireValue(Boolean(location), '材料下载重定向缺少目标地址');
      const next = downloadUrl(new URL(location, url).href);
      requireValue(!(url.protocol === 'https:' && next.protocol === 'http:'), '材料下载不允许从 HTTPS 重定向到 HTTP');
      url = next;
    }
    requireValue(response.ok && response.status !== 206, '材料下载未返回完整的成功响应');
    const length = response.headers.get('content-length');
    if (length !== null) {
      requireValue(/^\d+$/.test(length) && Number(length) > 0 && Number(length) <= MAX_BYTES,
        '网络材料必须非空且不超过本项目的 20 MiB 限制');
    }
    requireValue(Boolean(response.body), '材料下载响应没有文件内容');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      requireValue(size <= MAX_BYTES, '网络材料超过本项目的 20 MiB 限制');
      chunks.push(chunk);
    }
    downloadSignal.throwIfAborted();
    requireValue(size > 0, '网络材料内容为空');
    // Fetch decompresses bodies; compare Content-Length only for unencoded responses.
    if (length !== null && !response.headers.get('content-encoding')) {
      requireValue(size === Number(length), '网络材料下载不完整');
    }
    return metadata(Buffer.concat(chunks, size));
  } catch (error) {
    if (signal?.aborted) throw new AutomationError('CANCELLED', '材料下载已取消');
    if (deadline.aborted) throw new AutomationError('DOCUMENT_DOWNLOAD_TIMEOUT', '材料下载超时');
    if (error instanceof AutomationError) throw error;
    // Do not expose source URLs, query parameters or server response bodies in errors.
    throw new AutomationError('DOCUMENT_DOWNLOAD_FAILED', '无法下载网络材料，请检查地址和网络连接');
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

export async function readDocument(source, options = {}) {
  options.signal?.throwIfAborted();
  if (typeof source === 'string') return readLocalDocument(source, options.signal);
  requireValue(source && !(source.path !== undefined && source.url !== undefined), '只能指定一种材料来源');
  if (source.url !== undefined) return readRemoteDocument(source.url, options);
  return readLocalDocument(source.path, options.signal);
}

async function readLocalDocument(filename, signal) {
  requireValue(typeof filename === 'string' && filename.trim().length > 0,
    '请通过 --file / document.path 指定本地材料，或 --url / document.url 指定网络材料；尚未修改远端验证状态');
  requireValue(!/^[a-z][a-z\d+.-]*:\/\//i.test(filename), 'document.path 仅接受本地文件路径');
  const path = resolve(filename);
  let file;
  try { file = await open(path, 'r'); } catch (cause) {
    throw new AutomationError('DOCUMENT_UNREADABLE', '无法打开指定的本地证明文件', { cause });
  }
  try {
    const stat = await file.stat();
    requireValue(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES, '证明文件必须是非空普通文件且不超过本项目的 20 MiB 限制');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      signal?.throwIfAborted();
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    requireValue(size === stat.size, '文件读取期间大小发生变化，请文件保存完成后重新运行');
    const data = bytes.subarray(0, size);
    return metadata(data, basename(path));
  } finally {
    await file.close();
  }
}
