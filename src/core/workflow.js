import { AutomationError, requireValue } from './errors.js';
import { createVerificationClient } from '../apps/sheerid/client.js';
import { runDocumentWorkflow } from '../apps/sheerid/document-workflow.js';
import { withNetwork } from './network.js';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { queryStatusWithRetry } from './status-query.js';

// Select an executor from the current server state. Each executor rechecks under its task lock
// before making changes, so routing never bypasses the existing preflight or error handling.
export function runWorkflow(config, options = {}) {
  return withNetwork(config, () => executeWorkflow(config, options));
}

async function executeWorkflow(config, { submit = false, statusOnly = false, file, url: documentUrl, signal, resumeUncertainStage } = {}) {
  requireValue(config.app === 'sheerid', '当前自动分流仅支持 sheerid');
  requireValue(!(statusOnly && submit), '--status 与 --submit 不能同时使用');
  requireValue(!(file !== undefined && documentUrl !== undefined), '--file 与 --url 只能指定一个');
  if (statusOnly) return runDocumentWorkflow(config, { signal });
  signal?.throwIfAborted();
  if (resumeUncertainStage) return runDocumentWorkflow(config, {
    submit, file, url: documentUrl, signal, resumeUncertainStage,
  });
  const log = createLogger(randomUUID());
  log('stage_started', { stage: 'preflight' });
  const client = createVerificationClient(config, signal);
  const { state } = await queryStatusWithRetry(() => client.getStatus(), {
    signal, intervalMs: config.polling?.intervalMs, log,
  });
  log('verification_status', { stage: 'preflight', ...state });
  if (state.currentStep === 'collectStudentPersonalInfo' && state.errorIds.length === 0) {
    requireValue(config.browser.autoFill !== false || !submit,
      '自动填写已关闭，请在浏览器中手动填写；进入材料步骤后可使用 --submit 上传材料');
    const url = new URL(config.url);
    if (url.origin !== 'https://services.sheerid.com' || !/^\/verify\/[a-f\d]{24}\/?$/i.test(url.pathname)) {
      throw new AutomationError('FORM_URL_REQUIRED', '当前需要填写表单，请将 url 设置为包含 verificationId 的完整 SheerID 验证页面链接');
    }
    // Load Camoufox only for the browser branch; status/material-only runs stay browser-free.
    const { runAutomation } = await import('./runner.js');
    return runAutomation(config, {
      submit, signal,
      afterSubmit: submit
        ? ({ uncertainSubmission = false, beforeDocumentUpload } = {}) => runDocumentWorkflow(config, {
          submit: true, file, url: documentUrl, signal, uncertainSubmission, beforeDocumentUpload,
        })
        : undefined,
    });
  }
  return runDocumentWorkflow(config, { submit, file, url: documentUrl, signal });
}
