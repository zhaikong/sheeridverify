import { fetchData } from '../../core/http.js';
import { AutomationError, requireValue } from '../../core/errors.js';
import { isRecord } from '../../core/config.js';

export function verificationIdFromUrl(value) {
  const url = new URL(value);
  const page = url.origin === 'https://services.sheerid.com' && /^\/verify\/[a-f\d]{24}\/?$/i.test(url.pathname);
  const api = ['https://my.sheerid.com', 'https://services.sheerid.com'].includes(url.origin)
    && /^\/rest\/v2\/verification\/[a-f\d]{24}\/?$/i.test(url.pathname);
  requireValue(page || api, 'url 必须是 SheerID 验证页面或验证状态接口');
  const id = page ? url.searchParams.get('verificationId') : url.pathname.replace(/\/$/, '').split('/').pop();
  requireValue(typeof id === 'string' && /^[a-f\d]{24}$/i.test(id), 'URL 缺少有效的 verificationId');
  return id.toLowerCase();
}

export function parseVerification(body, verificationId) {
  const errorIds = body?.errorIds ?? [];
  const rejectionReasons = body?.rejectionReasons ?? [];
  if (!isRecord(body) || typeof body.verificationId !== 'string'
    || body.verificationId.toLowerCase() !== verificationId
    || typeof body.currentStep !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(body.currentStep)
    || !Array.isArray(errorIds) || errorIds.length > 50
    || !errorIds.every(code => typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(code))
    || !Array.isArray(rejectionReasons) || rejectionReasons.length > 50
    || !rejectionReasons.every(code => typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(code))) {
    throw new AutomationError('API_RESPONSE_INVALID', '接口字段无效或验证 ID 不匹配，已停止流程');
  }
  return { currentStep: body.currentStep, errorIds, rejectionReasons };
}

export function createVerificationClient(config, signal) {
  const verificationId = verificationIdFromUrl(config.url);
  const base = `https://my.sheerid.com/rest/v2/verification/${verificationId}`;
  async function request(method, step, json) {
    const body = await fetchData(step ? `${base}/step/${step}` : base, {
      method, json, signal, timeoutMs: config.timeouts.apiMs,
    });
    return { body, state: parseVerification(body, verificationId) };
  }
  return {
    verificationId,
    getStatus: () => request('GET'),
    cancelSso: () => request('DELETE', 'sso'),
    initiateUpload: files => request('POST', 'docUpload', { files }),
    completeUpload: () => request('POST', 'completeDocUpload'),
    upload: (url, document) => fetchData(url, {
      method: 'PUT', binary: true, bytes: document.bytes, mimeType: document.mimeType,
      timeoutMs: config.timeouts.uploadMs, signal,
    }),
  };
}

export function validateUploadUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new AutomationError('INVALID_UPLOAD_URL', '接口未提供有效上传地址');
  }
  const allowed = ['.amazonaws.com', '.amazonaws.com.cn', '.sheerid.com']
    .some(suffix => url.hostname.endsWith(suffix));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !allowed) {
    throw new AutomationError('INVALID_UPLOAD_URL', '上传地址不是受支持的 HTTPS S3/SheerID 地址，已停止流程');
  }
  return url.href;
}
