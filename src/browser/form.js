import { setTimeout as delay } from 'node:timers/promises';
import { AutomationError } from '../core/errors.js';

async function findVisibleField(page, selectors, name) {
  for (const selector of selectors) {
    const locator = page.locator(selector).filter({ visible: true });
    const count = await locator.count();
    if (count > 1) throw new AutomationError('AMBIGUOUS_FIELD', `字段 ${name} 匹配到多个元素，请收紧选择器`);
    if (count === 1) return locator;
  }
  return null;
}

function checkWaiting(page, signal) {
  if (signal?.aborted) throw new AutomationError('CANCELLED', '任务已取消');
  if (page.isClosed()) throw new AutomationError('PAGE_CLOSED', '等待表单期间浏览器页面已关闭');
}

// Playwright's "visible" only means a non-empty box. During SPA start-up a control can
// be transparent (fade-in), covered by a loading overlay, or still moving. Return the
// rounded box as a signature only when the control is really painted and on top.
function renderedSignature(element) {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return { code: 'NO_SIZE' };
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) {
      return { code: 'NOT_PAINTED' };
    }
  }
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  // Only hit-test when the centre is inside the viewport; off-screen fields are scrolled on use.
  if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) {
    const top = document.elementFromPoint(x, y);
    const owner = element.parentElement?.parentElement ?? element.parentElement;
    if (!top || !(top === element || element.contains(top) || owner?.contains(top))) return { code: 'COVERED' };
  }
  return { signature: [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(',') };
}

// Poll readiness under one shared deadline; do not multiply the timeout by the field count.
// With settleMs, every field must stay ready, painted and unmoved for that long before returning.
export async function waitForFields(page, selectors, names, { timeoutMs, signal, assertPage, enabledOnly = [], onPending, settleMs = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let pending = [...names];
  let lastReport = 0;
  let lastPending = '';
  let readySince = 0;
  let lastLayout = '';
  do {
    checkWaiting(page, signal);
    // Only inspect the form after any redirect has returned to the intended session.
    if (assertPage && !await assertPage()) {
      pending = [...names];
      readySince = 0;
    } else {
      pending = [];
      const layout = [];
      for (const name of names) {
        checkWaiting(page, signal);
        const remaining = deadline - Date.now();
        if (remaining <= 0) { pending.push(name); continue; }
        const locator = await findVisibleField(page, selectors[name], name);
        if (!locator) { pending.push(name); continue; }
        try {
          const options = { timeout: Math.min(remaining, 500) };
          const ready = enabledOnly.includes(name)
            ? await locator.isEnabled(options) : await locator.isEditable(options);
          const busy = await locator.evaluate(element => Boolean(element.closest('[aria-busy="true"]')), undefined, options);
          if (!ready || busy) { pending.push(name); continue; }
          if (settleMs > 0) {
            const rendered = await locator.evaluate(renderedSignature, undefined, options);
            if (!rendered.signature) { pending.push(`${name}:${rendered.code}`); continue; }
            layout.push(`${name}=${rendered.signature}`);
          }
        } catch (error) {
          // Dynamic forms can replace a matching node between lookup and inspection.
          if (error.name !== 'TimeoutError' && !/not attached|detached from.*DOM|Execution context was destroyed/i.test(error.message ?? '')) throw error;
          pending.push(name);
        }
      }
      if (pending.length === 0) {
        const signature = layout.join(';');
        if (!readySince || signature !== lastLayout) {
          readySince = Date.now();
          lastLayout = signature;
        }
        if (Date.now() - readySince >= settleMs) return;
        pending = ['<settling>'];
      } else {
        readySince = 0;
      }
    }
    const signature = pending.join(',');
    if (signature !== lastPending || Date.now() - lastReport >= 10000) {
      onPending?.([...pending]);
      lastPending = signature;
      lastReport = Date.now();
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(200, remaining), undefined, { signal });
  } while (Date.now() < deadline);
  checkWaiting(page, signal);
  if (assertPage && !await assertPage()) {
    throw new AutomationError('UNEXPECTED_PAGE', '等待结束后仍未进入指定验证会话，请检查登录、跳转或链接状态');
  }
  throw new AutomationError('FORM_NOT_READY', `表单等待超时，以下字段未出现或不可操作：${pending.join(', ')}。请检查页面加载状态及对应选择器`);
}

// Native selects and Downshift-style comboboxes require different interactions.
// Custom controls must select a real option; filling their text alone does not commit a value.
export async function selectChoice(locator, { value, label, labels = [label], searchText, timeoutMs, signal, field, allowLocationSuffix = false, normalizeLabelSeparators = false, retrySearch = false, interaction, assertReady, onPending, isSelectionCommitted }) {
  checkWaiting(locator.page(), signal);
  await assertReady?.();
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const probe = () => ({ timeout: Math.min(750, remaining()) });
  const action = () => ({ timeout: Math.min(1500, remaining()) });
  const tag = await locator.evaluate(element => element.tagName.toLowerCase());
  if (tag === 'select') {
    await setField(locator, value ?? label, { timeoutMs: remaining(), signal, labels, onPending });
    return;
  }
  await locator.click({ timeout: remaining() });
  if (searchText !== undefined && ['input', 'textarea'].includes(tag) && await locator.isEditable()) {
    if (interaction) await interaction.typeText(locator, searchText);
    else await locator.fill(searchText, { timeout: remaining() });
  }
  let sawOptions = false;
  let sawMatch = false;
  let selectionAttempted = false;
  let lastClickAt = 0;
  let commitLabels = labels;
  let committedSince = 0;
  let stableSince = 0;
  let lastCandidate = '';
  let nextReport = 0;
  let phase = 'OPTIONS_LOADING';
  let searchRetried = false;
  let noMatchSince = 0;
  let noMatchSignature;

  const findCandidate = async scope => {
    const options = scope.getByRole('option').filter({ visible: true });
    let candidate = scope.getByRole('option', { name: exactLabelsPattern(labels) }).filter({ visible: true });
    let count = await candidate.count();
    if (count === 0 && normalizeLabelSeparators) {
      candidate = scope.getByRole('option', { name: optionLabelPattern(label) }).filter({ visible: true });
      count = await candidate.count();
    }
    if (count === 0 && allowLocationSuffix) {
      candidate = scope.getByRole('option', { name: locationLabelPattern(label) }).or(
        options.filter({ has: locator.page().getByText(label, { exact: true }) }),
      ).filter({ visible: true });
      count = await candidate.count();
    }
    if (count > 1) {
      throw new AutomationError('AMBIGUOUS_OPTION', `字段 ${field} 匹配到多个候选项；学校请在 organization.optionText 中填写含城市/州的完整名称`);
    }
    sawMatch ||= count === 1;
    return count === 1 ? candidate : null;
  };

  const advance = async () => {
    // A timed-out click may already have committed. Check before any further click;
    // never clear/retype the search or reopen a closed menu after attempting selection.
    if (selectionAttempted) {
      phase = 'OPTION_COMMIT_PENDING';
      // Some applications replace the search input with a selected-value control.
      // Inspect that application-owned state before touching the obsolete locator.
      const replacementCommitted = await isSelectionCommitted?.({ labels: commitLabels, timeoutMs: probe().timeout });
      const state = replacementCommitted ? { committed: true, expanded: false, code: 'OPTION_COMMITTED_REPLACEMENT' }
        : await choiceCommitState(locator, { labels: commitLabels, tag, options: probe() });
      phase = state.code;
      if (state.committed) {
        committedSince ||= Date.now();
        return Date.now() - committedSince >= 300;
      }
      committedSince = 0;
      if (!state.expanded || Date.now() - lastClickAt < 1000) return false;
    }
    phase = 'OPTIONS_LOADING';
    // Some widgets attach or replace aria-controls only after the async menu loads.
    const scope = await choiceScope(locator, probe());
    const options = scope.getByRole('option').filter({ visible: true });
    sawOptions ||= await options.count() > 0;
    let candidate = await findCandidate(scope);
    const busy = await choiceBusy(locator, scope, probe());
    if (!candidate || busy || !await candidate.isEnabled(probe())) {
      stableSince = 0;
      lastCandidate = '';
      if (!candidate && !busy && retrySearch && !searchRetried && !selectionAttempted
        && tag === 'input' && typeof searchText === 'string' && Array.from(searchText.trim()).length > 1) {
        const signature = JSON.stringify(await options.allTextContents());
        if (!noMatchSince || signature !== noMatchSignature) {
          noMatchSince = Date.now();
          noMatchSignature = signature;
        }
        if (Date.now() - noMatchSince >= 5000 && remaining() > 1000) {
          await assertReady?.();
          checkWaiting(locator.page(), signal);
          // Do not edit a user-modified input, a selected replacement or a menu
          // whose results changed while we were checking page readiness.
          const freshScope = await choiceScope(locator, probe());
          if (await findCandidate(freshScope) || await choiceBusy(locator, freshScope, probe())
            || JSON.stringify(await freshScope.getByRole('option').filter({ visible: true }).allTextContents()) !== signature) {
            noMatchSince = 0;
            return false;
          }
          searchRetried = true; // Count even a timed-out key action; never delete twice.
          if (await locator.isEditable(probe()) && await locator.inputValue(probe()) === searchText) {
            await locator.press('End', action());
            checkWaiting(locator.page(), signal);
            if (Date.now() < deadline && await locator.inputValue(probe()) === searchText) {
              await locator.press('Backspace', action());
              phase = 'SEARCH_RETRIGGERED';
              onPending?.(phase);
              nextReport = Date.now() + 10000;
            }
          }
          noMatchSince = 0;
        }
      } else {
        noMatchSince = 0;
      }
      return false;
    }
    noMatchSince = 0;
    phase = 'OPTION_STABILIZING';
    const text = (await candidate.innerText(probe())).trim();
    if (text !== lastCandidate || !stableSince) {
      lastCandidate = text;
      stableSince = Date.now();
    }
    if (Date.now() - stableSince < 300) return false;
    await interaction?.beforeOption(field);
    await assertReady?.();
    checkWaiting(locator.page(), signal);
    if (Date.now() >= deadline) return false;

    // Re-resolve both menu and option after the pause; async results may replace them.
    const freshScope = await choiceScope(locator, probe());
    candidate = await findCandidate(freshScope);
    if (!candidate || await choiceBusy(locator, freshScope, probe())
      || (await candidate.innerText(probe())).trim() !== text) {
      stableSince = 0;
      phase = 'OPTIONS_RELOADING';
      return false;
    }
    phase = 'OPTION_CLICK_PENDING';
    // Bound each action so a stale/covered result cannot consume the entire deadline.
    await candidate.click({ ...action(), trial: true });
    if (Date.now() >= deadline) return false;
    selectionAttempted = true;
    commitLabels = [...labels, text].filter(item => item.trim().length > 0);
    lastClickAt = Date.now();
    await candidate.click(action());
    stableSince = 0;
    phase = 'OPTION_COMMIT_PENDING';
    return false;
  };

  do {
    checkWaiting(locator.page(), signal);
    await assertReady?.();
    try {
      if (await advance()) return;
    } catch (error) {
      checkWaiting(locator.page(), signal);
      // Detached nodes and short action timeouts are transient during result refreshes.
      if (error.name !== 'TimeoutError' && !/element.*not attached|detached from.*DOM/i.test(error.message ?? '')) throw error;
      stableSince = 0;
      committedSince = 0;
      noMatchSince = 0;
      phase = phase === 'OPTION_CLICK_PENDING' ? 'OPTION_CLICK_RETRY'
        : selectionAttempted ? 'OPTION_COMMIT_PENDING' : 'OPTIONS_RELOADING';
    }
    if (Date.now() >= nextReport) {
      onPending?.(phase);
      nextReport = Date.now() + 10000;
    }
    if (Date.now() < deadline) await delay(Math.min(200, remaining()), undefined, { signal });
  } while (Date.now() < deadline);
  if (selectionAttempted) {
    throw new AutomationError('OPTION_NOT_COMMITTED', `字段 ${field} 在等待期限内未能确认选中成功，已停止后续填写；请检查页面选中状态或校验提示`);
  }
  if (sawMatch) {
    throw new AutomationError('OPTION_NOT_SELECTABLE', `字段 ${field} 的匹配选项在等待期限内持续刷新、被遮挡或不可点击，已停止后续填写`);
  }
  throw new AutomationError(sawOptions ? 'OPTION_LABEL_MISMATCH' : 'OPTION_NOT_FOUND',
    sawOptions
      ? `字段 ${field} 未出现唯一、稳定且可点击的匹配选项；请检查页面语言、配置名称及加载状态`
      : `字段 ${field} 等待候选项超时；请检查网络、搜索内容和页面语言，未继续填写后续字段`);
}

async function choiceScope(locator, options) {
  const controls = await locator.getAttribute('aria-controls', options) || await locator.getAttribute('aria-owns', options);
  const ids = controls?.trim().split(/\s+/).filter(Boolean) ?? [];
  return ids.length
    ? locator.page().locator(ids.map(id => `[id=${JSON.stringify(id)}]`).join(','))
    : locator.page().getByRole('listbox').filter({ visible: true });
}

async function choiceBusy(locator, scope, options) {
  return await locator.evaluate(element => Boolean(element.closest('[aria-busy="true"]')), undefined, options)
    || await scope.locator(':scope[aria-busy="true"], [aria-busy="true"], [role="progressbar"]').filter({ visible: true }).count() > 0;
}

function exactLabelsPattern(labels) {
  const escaped = [...new Set(labels)].map(label => label.trim().split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  return new RegExp(`^(?:${escaped.join('|')})$`, 'i');
}

async function choiceCommitState(locator, { labels, tag, options }) {
  // A widget can remove aria-controls on close. Never inspect other menus or
  // page-wide spinners (e.g. human verification) to decide whether it committed.
  const controls = await locator.getAttribute('aria-controls', options) || await locator.getAttribute('aria-owns', options);
  const expandedAttribute = await locator.getAttribute('aria-expanded', options);
  const expanded = expandedAttribute === 'true';
  const scope = controls?.trim() ? await choiceScope(locator, options) : null;
  const menuClosed = scope ? await scope.getByRole('option').filter({ visible: true }).count() === 0 : expandedAttribute === 'false';
  const closed = !expanded && menuClosed;
  const value = ['input', 'textarea'].includes(tag) ? await locator.inputValue(options) : null;
  const matches = value === null || labels.some(label => optionLabelPattern(label).test(value.trim()));
  const committed = closed && matches && await locator.getAttribute('aria-invalid', options) !== 'true'
    && await locator.getAttribute('aria-busy', options) !== 'true';
  const code = !closed ? 'OPTION_MENU_OPEN' : !matches ? 'OPTION_VALUE_MISMATCH'
    : !committed ? 'OPTION_VALIDATION_PENDING' : 'OPTION_COMMIT_PENDING';
  return { committed, expanded, code };
}

function optionLabelPattern(label) {
  const parts = label.trim().split(/\s*,\s*|\s+/)
    .filter(Boolean).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('(?:\\s*,\\s*|\\s+)')}$`, 'i');
}

function locationLabelPattern(label) {
  const escaped = label.trim().split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp(`^${escaped}(?:\\s*,\\s*.+|\\s+\\([^\\r\\n]+\\))?$`, 'i');
}

export async function visibleField(page, selectors, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    checkWaiting(page);
    const locator = await findVisibleField(page, selectors, name);
    if (locator) return locator;
    await delay(150);
  } while (Date.now() < deadline && !page.isClosed());
  throw new AutomationError('FIELD_NOT_FOUND', `找不到字段 ${name}，请检查页面状态与选择器`);
}

export async function setField(locator, value, { timeoutMs = 15000, signal, interaction, labels = [], onPending } = {}) {
  const tag = await locator.evaluate(element => element.tagName.toLowerCase());
  if (tag !== 'select') {
    if (interaction) await interaction.typeText(locator, value);
    else await locator.fill(String(value));
    await locator.blur();
    return;
  }
  // Native selects may use padded or unpadded numeric values, or translated labels.
  const deadline = Date.now() + timeoutMs;
  let nextReport = 0;
  do {
    checkWaiting(locator.page(), signal);
    const matches = await locator.locator('option').evaluateAll((options, { input, labels }) => {
      const enabled = options.filter(option => !option.disabled && !option.parentElement?.disabled);
      const exactValue = enabled.filter(option => option.value === input);
      const exact = exactValue.length ? exactValue : enabled.filter(option => option.textContent.trim() === input || labels.includes(option.textContent.trim()));
      const numeric = /^\d+$/.test(input)
        ? enabled.filter(option => /^\d+$/.test(option.value) && Number(option.value) === Number(input)) : [];
      return (exact.length ? exact : numeric).map(option => option.value);
    }, { input: String(value), labels });
    if (matches.length > 1) throw new AutomationError('AMBIGUOUS_OPTION', '下拉选项不唯一，请检查配置值');
    if (matches.length === 1) {
      await locator.selectOption(matches[0], { timeout: Math.max(1, deadline - Date.now()) });
      return;
    }
    if (Date.now() >= nextReport) {
      onPending?.();
      nextReport = Date.now() + 10000;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(200, remaining), undefined, { signal });
  } while (Date.now() < deadline);
  throw new AutomationError('OPTION_NOT_FOUND', '等待下拉选项超时，请检查选项是否加载完成及配置值是否匹配');
}
