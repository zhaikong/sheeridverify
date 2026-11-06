import { randomUUID } from 'node:crypto';
import { createSession, waitForSessionClose } from '../browser/session.js';
import { createInteraction } from '../browser/interaction.js';
import { getApplication } from '../apps/registry.js';
import { AutomationError, requireValue } from './errors.js';
import { createLogger } from './logger.js';
import { withTaskLock, saveResult } from './storage.js';
import { withNetwork } from './network.js';

export function runAutomation(config, options = {}) {
  return withNetwork(config, () => executeAutomation(config, options));
}

async function executeAutomation(config, options) {
  const app = getApplication(config.app);
  app.validate(config);
  return withTaskLock(config.artifactsDir, app.identity(config), () => executeLockedAutomation(config, options, app));
}

async function executeLockedAutomation(config, { submit = false, signal, afterSubmit } = {}, app) {
  const manual = config.browser.autoFill === false;
  requireValue(!manual || (!submit && !config.browser.headless && config.browser.keepOpen !== false),
    '手动填写模式需要有界面并保持浏览器打开，且不能使用 --submit');
  const mode = manual ? 'manual' : submit ? 'submit' : 'fill';
  const runId = randomUUID();
  const log = createLogger(runId);
  const started = Date.now();
  let session;
  let sessionClosed = false;
  let documentHandoffStarted = false;
  let attempted = false;
  let stage = app.preflight ? 'preflight' : 'launch';
  let result;
  const abort = () => { session?.close().catch(() => {}); };
  const checkAbort = () => {
    if (signal?.aborted) throw new AutomationError('CANCELLED', '任务已取消');
  };
  signal?.addEventListener('abort', abort, { once: true });
  const envelope = outcome => ({ runId, app: config.app, mode,
    startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started, submissionAttempted: attempted, browserOpened: Boolean(session), ...outcome });
  const followUpStatuses = ['document_required', 'sso_required', 'pending', 'email_required', 'submission_unknown'];
  const continueAfterSubmission = async outcome => {
    checkAbort();
    documentHandoffStarted = true;
    stage = 'document';
    log('stage_started', { stage, code: 'CONTINUE_DOCUMENT_WORKFLOW' });
    const documentResult = await afterSubmit({
      // Keep the page alive while the API still reports the pre-submit step.
      uncertainSubmission: attempted || outcome.status === 'submission_unknown',
      beforeDocumentUpload: async () => {
        checkAbort();
        if (session && !sessionClosed) {
          await session.close();
          sessionClosed = true;
          log('browser_closed', { stage, code: 'DOCUMENT_HANDOFF' });
        }
        checkAbort();
      },
    });
    return {
      status: documentResult.status, code: documentResult.code, message: documentResult.message,
      currentStep: documentResult.currentStep, errorIds: documentResult.errorIds,
      rejectionReasons: documentResult.rejectionReasons, uploadAttempt: documentResult.uploadAttempt,
      submissionUncertain: documentResult.submissionUncertain,
      uncertainStage: documentResult.uncertainStage,
      lastKnownStep: documentResult.lastKnownStep, remoteWriteAttempted: documentResult.remoteWriteAttempted,
      documentRunId: documentResult.runId, documentStage: documentResult.stage, stage,
    };
  };
  try {
    checkAbort();
    log('run_started', { app: config.app, stage, mode });
    if (app.preflight) {
      const decision = await app.preflight({ config, signal, log });
      checkAbort();
      if (!decision || typeof decision.proceed !== 'boolean'
        || (!decision.proceed && typeof decision.outcome?.status !== 'string')) {
        throw new AutomationError('INVALID_PREFLIGHT_RESULT', '应用状态检查未返回明确决策，未启动浏览器');
      }
      if (!decision.proceed) {
        result = envelope(submit && afterSubmit && followUpStatuses.includes(decision.outcome.status)
          ? await continueAfterSubmission(decision.outcome) : { ...decision.outcome, stage });
        return result; // finally persists the result and releases the lock without a browser.
      }
      log('preflight_ready', { stage, currentStep: decision.currentStep, errorIds: decision.errorIds });
    }
    if (!manual) {
      stage = 'validate_input';
      app.validateInput?.(config);
    }
    checkAbort();
    stage = 'launch';
    log('stage_started', { stage });
    session = await createSession(config);
    checkAbort();
    log('browser_identity_created', { stage, code: 'FRESH_CONTEXT' });
    stage = 'navigate';
    const response = await session.page.goto(config.url, { waitUntil: 'domcontentloaded' });
    if (response && !response.ok()) throw new AutomationError('NAVIGATION_FAILED', '目标页面返回错误状态');
    checkAbort();
    if (manual) {
      stage = 'manual';
      result = envelope({ status: 'manual', code: 'MANUAL_MODE',
        message: '页面已打开，请手动填写和提交；关闭窗口结束任务。手动操作的验证结果以页面为准。' });
      return result; // finally keeps the browser, proxy and task lock alive until the user closes it.
    }
    const interaction = createInteraction(config.interaction, { signal, log });
    const context = { ...session, config, log, signal, interaction };
    stage = 'wait_ready';
    log('stage_started', { stage });
    if (app.waitUntilReady) await app.waitUntilReady(context);
    else await session.page.waitForLoadState('load', { timeout: config.timeouts.readyMs });
    checkAbort();
    log('form_ready', { stage });
    stage = 'fill';
    log('stage_started', { stage });
    await app.fill(context);
    checkAbort();
    let outcome = { status: 'filled', code: 'FORM_FILLED' };
    if (submit) {
      stage = 'submit';
      log('stage_started', { stage });
      outcome = await app.submit({ ...context, markSubmissionAttempted: async () => {
        checkAbort();
        attempted = true;
        // Persist uncertainty BEFORE the click. A crash must never imply a safe automatic retry.
        await saveResult(config.artifactsDir, envelope({ status: 'submission_unknown', code: 'SUBMISSION_STARTED' }));
      } });
    }
    const pageFailure = app.failureOutcome ? await app.failureOutcome(context) : null;
    if (!pageFailure && submit && afterSubmit && followUpStatuses.includes(outcome.status)) {
      outcome = await continueAfterSubmission(outcome);
    }
    result = envelope(pageFailure ?? outcome);
  } catch (error) {
    let pageFailure;
    if (session && !signal?.aborted && app.failureOutcome) {
      // Preserve a definite page rejection even if a disappearing form caused
      // the pending action to time out, including after a submission attempt.
      pageFailure = await app.failureOutcome({ ...session, config }).catch(() => null);
    }
    result = envelope(pageFailure ? { ...pageFailure, stage } : { status: attempted ? 'submission_unknown'
      : error.code === 'HUMAN_VERIFICATION_REQUIRED' ? 'human_verification_required' : 'failed',
      code: signal?.aborted ? 'CANCELLED' : error instanceof AutomationError ? error.code
        : stage === 'preflight' ? 'PREFLIGHT_FAILED' : 'BROWSER_ERROR',
      message: error instanceof AutomationError ? error.message : undefined, stage });
    if (attempted && !pageFailure && !signal?.aborted && afterSubmit && !documentHandoffStarted) {
      try { result = envelope(await continueAfterSubmission({ status: 'submission_unknown' })); }
      catch { result = envelope({ status: 'failed', code: 'FOLLOW_UP_FAILED', submissionUncertain: true,
        message: '提交后的状态查询未能继续，服务端最终结果尚未确认' }); }
    }
  } finally {
    try {
      // Persist the automation outcome before handing the visible page back to the user.
      if (result) {
        if (submit && !['verified', 'failed'].includes(result.status)) {
          Object.assign(result, { submissionUncertain: result.status === 'submission_unknown', status: 'failed' });
        }
        await saveResult(config.artifactsDir, result);
        log('run_finished', result);
      }
      if (session && (manual || (!submit && config.browser.keepOpen)) && !signal?.aborted
        && session.browser.isConnected() && !session.page.isClosed()) {
        log('browser_kept_open', { stage: 'await_user_close', status: result?.status });
        await waitForSessionClose(session, signal);
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      if (session && !sessionClosed) {
        await session.close().catch(() => log('cleanup_failed', { code: 'BROWSER_CLOSE_FAILED' }));
      }
    }
  }
  return result;
}
