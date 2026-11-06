import { setTimeout as delay } from 'node:timers/promises';
import { AutomationError } from '../../core/errors.js';

const HUMAN_ERROR = /无法确认您是真人|無法確認您是真人|unable to (?:confirm|verify).{0,40}human|could(?:n't| not) (?:confirm|verify).{0,40}human/i;
const HUMAN_LOADING = /正在确认您是真人|正在確認您是真人|(?:confirming|verifying|checking).{0,40}(?:human|person)/i;
const RETRY = /^(?:重试|重試|retry|try again)$/i;
const MAX_RETRIES = 3;
const sessions = new WeakMap();

// Readiness checks never submit. Only the page's ordinary Retry button is used;
// interactive challenges remain with the user.
export async function waitForSubmitReady({ page, button, config, signal, log, assertReady }) {
  let state = sessions.get(page);
  if (!state) {
    state = { attempts: 0, waitedMs: 0, lastAttemptAt: 0, transitioned: false, nextReport: 0, sawVerification: false };
    sessions.set(page, state);
  }
  const errorNotice = page.getByText(HUMAN_ERROR).filter({ visible: true });
  const loadingNotice = page.getByText(HUMAN_LOADING).filter({ visible: true });
  const retry = page.getByRole('button', { name: RETRY }).filter({ visible: true });
  const started = Date.now();
  const budget = (config.timeouts.humanMs ?? 180000) - state.waitedMs;
  const remaining = () => Math.max(1, budget - (Date.now() - started));
  let phase = 'BUTTON_DISABLED';
  try {
    while (true) {
      signal?.throwIfAborted();
      if (page.isClosed()) throw new AutomationError('PAGE_CLOSED', '等待提交按钮期间页面已关闭');
      await assertReady();
      // A subsequent readiness check can succeed at the budget boundary, but
      // no further retry or wait is allowed after that boundary.
      const hasError = await errorNotice.count() > 0;
      const loading = await loadingNotice.count() > 0;
      state.sawVerification ||= hasError || loading;
      phase = loading ? 'HUMAN_VERIFICATION_LOADING' : hasError ? 'HUMAN_VERIFICATION_ERROR' : 'BUTTON_DISABLED';
      try {
        if (!hasError && !loading && await button.isEnabled({ timeout: Math.min(500, remaining()) })) {
          phase = 'SUBMIT_NOT_CLICKABLE';
          await button.click({ trial: true, timeout: Math.min(1000, remaining()) });
          // Recheck after scrolling/actionability checks in case the component changed.
          if (await errorNotice.count() === 0 && await loadingNotice.count() === 0
            && await button.isEnabled({ timeout: Math.min(500, remaining()) })) {
            log('submit_ready', { stage: 'wait_submit', code: 'BUTTON_CLICKABLE' });
            return;
          }
        }
        const retryVisible = await retry.count() === 1;
        const retryEnabled = retryVisible && await retry.isEnabled({ timeout: Math.min(500, remaining()) });
        if (state.attempts && (loading || !hasError || !retryEnabled)) state.transitioned = true;
        // Wait for loading to return a result. If the old error never changes,
        // allow another attempt only after a five-second grace period.
        const sinceAttempt = Date.now() - state.lastAttemptAt;
        const resultReady = state.attempts === 0 || (state.transitioned && sinceAttempt >= 1000) || sinceAttempt >= 5000;
        if (hasError && !loading && resultReady && state.attempts >= MAX_RETRIES) {
          throw new AutomationError('HUMAN_VERIFICATION_RETRY_EXHAUSTED', '真人验证已重试 3 次，页面仍提示失败；已停止任务，未提交表单');
        }
        if (Date.now() - started >= budget) break;
        if (hasError && !loading && retryEnabled && resultReady) {
          // The UI may have changed to a terminal page since this poll began.
          await assertReady();
          if (await errorNotice.count() === 0) continue;
          // Count before the click, including uncertain clicks, to cap attempts at three.
          state.attempts++;
          state.lastAttemptAt = Date.now();
          state.transitioned = false;
          phase = 'HUMAN_VERIFICATION_RETRY_PENDING';
          log('human_verification_retry', { stage: 'wait_submit', code: `PAGE_RETRY_${state.attempts}_OF_3`,
            message: `真人验证重试 ${state.attempts}/3，等待页面返回结果` });
          await retry.click({ timeout: Math.min(1500, remaining()) });
        }
      } catch (error) {
        // Temporary actionability timeouts are re-observed under the same budget.
        if (error.name !== 'TimeoutError') throw error;
      }
      if (Date.now() - started >= budget) break;
      if (Date.now() >= state.nextReport) {
        log('waiting_for_submit', { stage: 'wait_submit', code: phase,
          message: `等待按钮可点击（已重试 ${state.attempts}/3）；如有交互式真人验证，请在浏览器中完成` });
        state.nextReport = Date.now() + 10000;
      }
      await delay(Math.min(250, remaining()), undefined, { signal });
    }
    throw new AutomationError(state.sawVerification ? 'HUMAN_VERIFICATION_TIMEOUT' : 'SUBMIT_NOT_READY',
      `等待提交按钮超时（已重试 ${state.attempts}/3），已停止任务，未提交表单`);
  } finally {
    state.waitedMs += Date.now() - started;
  }
}
