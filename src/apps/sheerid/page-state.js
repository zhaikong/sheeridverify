import { AutomationError } from '../../core/errors.js';

// This terminal page is different from the inline, retryable human-check error.
const FAILURE_TITLE = /^(?:We (?:couldn['’]t|could not) continue your verification|(?:我们|我們)?(?:无法|無法)继续(?:您的)?验证|(?:我們)?無法繼續(?:您的)?驗證)[.!。]?$/i;

export async function verificationFailure(page) {
  if (page.isClosed()) return null;
  // Do not classify a login page or an unrelated site using its text alone.
  if (new URL(page.url()).origin !== 'https://services.sheerid.com') return null;
  const errorStep = page.locator('#sid-step-error').filter({ visible: true });
  const title = page.getByText(FAILURE_TITLE).filter({ visible: true });
  if (await errorStep.count() === 0 && await title.count() === 0) return null;
  return {
    status: 'failed', code: 'VERIFICATION_UNAVAILABLE',
    message: 'SheerID 页面显示无法继续验证，本次验证失败；已停止填写、重试和提交',
  };
}

export async function assertVerificationAvailable(page) {
  const failure = await verificationFailure(page);
  if (failure) throw new AutomationError(failure.code, failure.message);
}
