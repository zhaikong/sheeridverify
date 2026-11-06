import { AutomationError } from '../../core/errors.js';
import { isRecord } from '../../core/config.js';
import { networkFetch } from '../../core/network.js';
import { httpResponseError } from '../../core/http.js';
import { queryStatusWithRetry } from '../../core/status-query.js';

export const stepStatuses = Object.freeze({
  success: 'verified',
  docUpload: 'document_required',
  sso: 'sso_required',
  emailLoop: 'email_required',
  pending: 'pending',
  error: 'rejected',
  collectStudentPersonalInfo: 'validation_failed',
});

// Only this step is handled by the personal-information form adapter.
export function checkVerificationStatus(context) {
  return queryStatusWithRetry(() => readVerificationStatus(context), {
    signal: context.signal, intervalMs: context.config.polling?.intervalMs, log: context.log,
  });
}

async function readVerificationStatus({ config, signal }) {
  const verificationId = new URL(config.url).searchParams.get('verificationId')?.toLowerCase();
  if (!verificationId || !/^[a-f\d]{24}$/.test(verificationId)) {
    throw new AutomationError('INVALID_CONFIG', '状态检查需要有效的 verificationId');
  }
  const timeoutSignal = AbortSignal.timeout(config.timeouts.apiMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let body;
  try {
    const response = await networkFetch(`https://my.sheerid.com/rest/v2/verification/${verificationId}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: requestSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw httpResponseError(response, {
        code: 'STATUS_HTTP_ERROR', message: `状态接口返回 HTTP ${response.status}，未启动浏览器`,
      });
    }
    try {
      body = await response.json();
    } catch (cause) {
      if (requestSignal.aborted) throw cause;
      throw new AutomationError('STATUS_RESPONSE_INVALID', '状态接口未返回有效 JSON，未启动浏览器', { cause });
    }
  } catch (cause) {
    if (signal?.aborted) throw new AutomationError('CANCELLED', '状态检查已取消', { cause });
    if (timeoutSignal.aborted) {
      throw new AutomationError('STATUS_REQUEST_TIMEOUT', '状态接口请求超时，未启动浏览器', { cause });
    }
    if (cause instanceof AutomationError) throw cause;
    throw new AutomationError('STATUS_REQUEST_FAILED', '无法读取状态接口，未启动浏览器', { cause });
  }
  const errorIds = body?.errorIds ?? [];
  // Keep only bounded status codes; never log the full response or verification ID.
  if (!isRecord(body) || typeof body.verificationId !== 'string'
    || body.verificationId.toLowerCase() !== verificationId
    || typeof body.currentStep !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(body.currentStep)
    || !Array.isArray(errorIds) || errorIds.length > 50
    || !errorIds.every(code => typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(code))) {
    throw new AutomationError('STATUS_RESPONSE_INVALID', '状态接口字段无效或验证 ID 不匹配，未启动浏览器');
  }
  const { currentStep } = body;
  if (currentStep === 'collectStudentPersonalInfo' && errorIds.length === 0) {
    return { proceed: true, currentStep, errorIds };
  }
  const status = errorIds.length > 0 ? 'rejected'
    : Object.hasOwn(stepStatuses, currentStep) ? stepStatuses[currentStep] : 'not_actionable';
  const messages = {
    verified: '接口确认验证已通过，无需填写，未启动浏览器',
    document_required: '当前需要补交材料，无需填写初始表单，未启动浏览器',
    sso_required: '当前需要学校登录验证，未启动浏览器',
    email_required: '当前需要邮件验证，未启动浏览器',
    pending: '当前正在等待审核，未启动浏览器',
    rejected: '当前验证处于错误或拒绝状态，未启动浏览器；请按 SheerID 页面提示处理',
    not_actionable: '当前不是支持的学生信息填写步骤，未启动浏览器',
  };
  return {
    proceed: false,
    outcome: { status, currentStep, errorIds, code: 'PREFLIGHT_NO_FORM', message: messages[status] },
  };
}
