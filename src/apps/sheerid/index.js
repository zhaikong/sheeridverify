import { AutomationError, requireValue } from '../../core/errors.js';
import { checkKeys } from '../../core/config.js';
import { visibleField, setField, waitForFields, selectChoice } from '../../browser/form.js';
import { selectors as defaults } from './selectors.js';
import { checkVerificationStatus, stepStatuses } from './status.js';
import { formLocales, countryChoice, monthChoice } from './labels.js';
import { waitForSubmitReady } from './human-verification.js';
import { organizationIsSelected } from './organization.js';
import { verificationFailure, assertVerificationAvailable } from './page-state.js';
import { setTimeout as delay } from 'node:timers/promises';

export const sheerid = {
  validate(config) {
    const url = new URL(config.url);
    requireValue(url.origin === 'https://services.sheerid.com' && /^\/verify\/[a-f\d]{24}\/?$/i.test(url.pathname), 'SheerID URL 的域名或项目路径不正确');
    const verificationId = url.searchParams.get('verificationId');
    requireValue(verificationId !== null && /^[a-f\d]{24}$/i.test(verificationId), '请使用包含有效 verificationId 的完整验证链接');
  },

  preflight: checkVerificationStatus,
  failureOutcome: ({ page }) => verificationFailure(page),

  validateInput(config) {
    checkKeys(config.data, ['firstName', 'lastName', 'email', 'birthDate', 'organization', 'country', 'consent', 'emailDomain'], 'data');
    for (const name of ['firstName', 'lastName', 'email']) {
      requireValue(typeof config.data[name] === 'string' && config.data[name].trim().length > 0, `请填写 data.${name}`);
    }
    requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.data.email), 'email 格式无效');
    const date = config.data.birthDate;
    requireValue(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date), 'birthDate 必须是 YYYY-MM-DD');
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    requireValue(Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date && timestamp < Date.now() && Number(date.slice(0, 4)) >= 1900, 'birthDate 不是有效的出生日期');
    checkKeys(config.data.organization, ['name', 'optionText', 'emailDomain'], 'organization');
    for (const key of ['name', 'optionText']) {
      requireValue(typeof config.data.organization[key] === 'string' && config.data.organization[key].trim().length > 0, `请填写 organization.${key}`);
    }
    requireValue(typeof config.data.country === 'string' && config.data.country.trim().length > 0,
      '请填写 data.country（学校所在国家，例如 United States）；此页面必须先选国家才能搜索学校');
    requireValue(config.data.consent === undefined || typeof config.data.consent === 'boolean', 'consent 必须是布尔值');
    checkKeys(config.selectors, Object.keys(defaults), 'selectors');
    for (const list of Object.values(config.selectors)) {
      requireValue(Array.isArray(list) && list.length > 0 && list.every(value => typeof value === 'string' && value.trim().length > 0), '每个选择器配置必须是非空字符串数组');
    }
  },

  identity(config) {
    return `sheerid:${new URL(config.url).searchParams.get('verificationId')}`;
  },

  async waitUntilReady({ page, config, signal, log }) {
    // Navigation only waited for DOMContentLoaded; the React form renders after that.
    // Give `load` a bounded chance first, but do not fail on slow third-party images/iframes.
    const loadBudget = Math.min(15000, config.timeouts.readyMs);
    await page.waitForLoadState('load', { timeout: loadBudget }).catch(error => {
      if (error.name !== 'TimeoutError') throw error;
      log('page_load_slow', { stage: 'wait_ready', code: 'LOAD_EVENT_PENDING', waitedMs: loadBudget });
    });
    signal?.throwIfAborted();
    const selectors = { ...defaults, ...config.selectors };
    // School is intentionally disabled until country is selected. Do not wait for it here.
    // Fields must be actually painted, uncovered and unmoved for 1s before filling starts.
    await waitForFields(page, selectors, ['country', 'firstName', 'lastName', 'email'], {
      timeoutMs: config.timeouts.readyMs, signal, settleMs: 1000,
      assertPage: () => formPageAvailable(page, config),
      enabledOnly: ['country'],
      onPending: pendingFields => log('waiting_for_fields', { stage: 'wait_ready', pendingFields }),
    });
  },

  async fill({ page, config, signal, log, interaction }) {
    assertSession(page, config);
    await assertFormAvailable(page, config);
    const selectors = { ...defaults, ...config.selectors };
    const field = async name => {
      log('field_started', { stage: 'fill', field: name });
      await interaction.beforeField(name);
      await waitForFields(page, selectors, [name], {
        timeoutMs: config.timeouts.readyMs, signal, settleMs: 300,
        assertPage: () => formPageAvailable(page, config),
        enabledOnly: ['country', 'birthMonth'],
        onPending: pendingFields => log('waiting_for_fields', { stage: 'fill', pendingFields }),
      });
      return visibleField(page, selectors[name], name, config.timeouts.actionMs);
    };
    const set = async (name, value) => {
      await setField(await field(name), value, { timeoutMs: config.timeouts.readyMs, signal, interaction });
      log('field_filled', { stage: 'fill', field: name });
    };
    const choose = async (name, options) => {
      await selectChoice(await field(name), {
        ...options, timeoutMs: config.timeouts.readyMs, signal, field: name, interaction,
        assertReady: () => assertFormAvailable(page, config),
        onPending: code => log('waiting_for_options', { stage: 'fill', field: name, code }),
      });
      log('field_filled', { stage: 'fill', field: name });
    };
    const data = config.data;
    const locales = await formLocales(page, config.browser.locale);
    await choose('country', countryChoice(data.country, locales));
    await choose('organization', {
      label: data.organization.optionText,
      searchText: data.organization.name,
      retrySearch: true,
      normalizeLabelSeparators: true,
      isSelectionCommitted: options => organizationIsSelected(page, options),
      // Explicit campus labels retain every name/location word; only separators may differ.
      allowLocationSuffix: data.organization.optionText.trim() === data.organization.name.trim(),
    });
    for (const name of ['firstName', 'lastName']) await set(name, data[name]);
    const [year, month, day] = data.birthDate.split('-');
    await choose('birthMonth', monthChoice(month, locales));
    await set('birthDay', day);
    await set('birthYear', year);
    await set('email', data.email);
    if (data.consent === true) {
      await (await visibleField(page, selectors.consent, 'consent', config.timeouts.readyMs)).check();
    }
    const button = await visibleField(page, selectors.submit, 'submit', config.timeouts.actionMs);
    await waitForSubmitReady({ page, button, config, signal, log,
      assertReady: () => assertFormAvailable(page, config) });
  },

  async submit({ page, config, markSubmissionAttempted, interaction, signal, log }) {
    await assertFormAvailable(page, config);
    await interaction.beforeSubmit();
    const selectors = { ...defaults, ...config.selectors };
    const button = await visibleField(page, selectors.submit, 'submit', config.timeouts.actionMs);
    const valid = await button.evaluate(element => !element.form || element.form.checkValidity());
    if (!valid) throw new AutomationError('FORM_INVALID', '表单存在未填写或无效的必填字段');
    await waitForSubmitReady({ page, button, config, signal, log,
      assertReady: () => assertFormAvailable(page, config) });
    await assertFormAvailable(page, config);
    const stillValid = await button.evaluate(element => !element.form || element.form.checkValidity());
    if (!stillValid) throw new AutomationError('FORM_INVALID', '等待验证期间表单数据发生变化或失效，请检查页面必填字段');
    const verificationId = new URL(config.url).searchParams.get('verificationId');
    // Arm the response listener before clicking; only observe this session's submission POST.
    let receivedResponse;
    const onResponse = response => {
      const url = new URL(response.url());
      if (url.origin === 'https://services.sheerid.com'
        && url.pathname === `/rest/v2/verification/${verificationId}/step/collectStudentPersonalInfo`
        && response.request().method() === 'POST') receivedResponse = response;
    };
    page.on('response', onResponse);
    try {
      await assertFormAvailable(page, config);
      await markSubmissionAttempted();
      try {
        await button.click();
      } catch {
        // An explicit failure page resolves an otherwise uncertain click outcome.
        return await verificationFailure(page)
          ?? { status: 'submission_unknown', code: 'CLICK_OUTCOME_UNKNOWN' };
      }
      const deadline = Date.now() + config.timeouts.resultMs;
      while (true) {
        signal?.throwIfAborted();
        const failure = await verificationFailure(page);
        if (failure) return failure;
        if (receivedResponse || page.isClosed() || Date.now() >= deadline) break;
        await delay(Math.min(200, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
    } finally {
      page.removeListener('response', onResponse);
    }
    const response = receivedResponse;
    if (!response) return { status: 'submission_unknown', code: 'RESULT_TIMEOUT' };
    let body;
    try { body = await response.json(); } catch {
      return { status: 'submission_unknown', code: 'INVALID_RESPONSE' };
    }
    if (!response.ok()) {
      return response.status() >= 400 && response.status() < 500
        ? { status: 'rejected', code: 'HTTP_CLIENT_ERROR' }
        : { status: 'submission_unknown', code: 'HTTP_SERVER_ERROR' };
    }
    if (Array.isArray(body?.errorIds) && body.errorIds.length > 0) {
      return { status: 'validation_failed', code: 'SERVER_VALIDATION_ERROR' };
    }
    const known = typeof body?.currentStep === 'string' && Object.hasOwn(stepStatuses, body.currentStep);
    return { status: known ? stepStatuses[body.currentStep] : 'submission_unknown',
      code: known ? 'STEP_RECEIVED' : 'UNRECOGNIZED_STEP' };
  },
};

function isExpectedSession(page, config) {
  const current = new URL(page.url());
  const expected = new URL(config.url);
  return current.origin === expected.origin
    && current.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '')
    && current.searchParams.get('verificationId') === expected.searchParams.get('verificationId');
}

function assertSession(page, config) {
  if (!isExpectedSession(page, config)) {
    throw new AutomationError('UNEXPECTED_PAGE', '页面已离开指定验证会话，已停止表单操作');
  }
}

async function formPageAvailable(page, config) {
  await assertVerificationAvailable(page);
  if (!isExpectedSession(page, config)) return false;
  return true;
}

async function assertFormAvailable(page, config) {
  if (!await formPageAvailable(page, config)) assertSession(page, config);
}
