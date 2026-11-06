import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { firefox } from 'playwright-core';
import { listInstalled } from 'camoufox';
import { selectChoice } from '../src/browser/form.js';

// Local fixture pages only. Never download a browser or contact a verification site.
const installed = listInstalled().find(item => item.isActive);
const binary = process.platform === 'win32' ? 'camoufox.exe'
  : process.platform === 'darwin' ? '../MacOS/camoufox' : 'camoufox-bin';
const executablePath = installed && join(installed.path, binary);
const available = Boolean(executablePath && existsSync(executablePath));
const browserTest = { skip: available ? false : 'No installed Camoufox browser for local fixtures', timeout: 20000 };
let browser;
before(async () => { if (available) browser = await firefox.launch({ executablePath, headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(mode, operation) {
  const page = await browser.newPage();
  page.setDefaultTimeout(1500);
  try {
    await page.setContent('<input id="school" role="combobox" aria-controls="choices" aria-expanded="false"><ul id="choices" role="listbox" hidden></ul>');
    await page.evaluate(mode => {
      const input = document.querySelector('input');
      const list = document.querySelector('ul');
      window.state = { deletions: 0, chosen: null };
      const open = value => { list.hidden = !value; input.setAttribute('aria-expanded', String(value)); };
      const render = matched => {
        list.replaceChildren();
        const option = document.createElement('li');
        option.setAttribute('role', 'option');
        option.textContent = matched ? 'Marshall University' : 'Unrelated College';
        option.onclick = () => {
          window.state.chosen = option.textContent;
          input.value = option.textContent;
          if (mode === 'commitPending') input.setAttribute('aria-invalid', 'true');
          open(false);
        };
        list.append(option);
      };
      input.onclick = () => open(list.hidden);
      input.onkeydown = event => { if (event.key === 'Backspace') window.state.deletions++; };
      input.oninput = event => {
        render(mode === 'normal' || mode === 'commitPending'
          || (mode === 'refresh' && event.inputType === 'deleteContentBackward'));
        open(true);
      };
      render(false);
      if (mode === 'busy') {
        input.setAttribute('aria-busy', 'true');
        setTimeout(() => { input.removeAttribute('aria-busy'); render(true); }, 5500);
      }
      if (mode === 'edited') setTimeout(() => { input.value = 'User Changed Search'; }, 500);
    }, mode);
    const locator = page.locator('#school');
    const select = options => selectChoice(locator, {
      label: 'Marshall University', searchText: 'Marshall University', field: 'organization',
      timeoutMs: 8500, retrySearch: true, ...options,
    });
    await operation({ page, locator, select });
  } finally { await page.close(); }
}

test('stale school results refresh after one backspace and select the exact school', browserTest, async () => {
  await fixture('refresh', async ({ page, locator, select }) => {
    const phases = [];
    await select({ onPending: phase => phases.push(phase) });
    assert.equal(await locator.inputValue(), 'Marshall University');
    assert.deepEqual(await page.evaluate(() => window.state), { deletions: 1, chosen: 'Marshall University' });
    assert.equal(phases.filter(phase => phase === 'SEARCH_RETRIGGERED').length, 1);
  });
});

test('matching school results are selected without editing the search', browserTest, async () => {
  await fixture('normal', async ({ page, select }) => {
    await select();
    assert.equal(await page.evaluate(() => window.state.deletions), 0);
  });
});

test('school retry is bounded and never selects an unrelated option', browserTest, async () => {
  await fixture('missing', async ({ page, locator, select }) => {
    await assert.rejects(select({ timeoutMs: 11200 }), { code: 'OPTION_LABEL_MISMATCH' });
    assert.equal(await locator.inputValue(), 'Marshall Universit');
    assert.deepEqual(await page.evaluate(() => window.state), { deletions: 1, chosen: null });
  });
});

test('a busy school search is allowed to finish without deleting characters', browserTest, async () => {
  await fixture('busy', async ({ page, select }) => {
    await select();
    assert.deepEqual(await page.evaluate(() => window.state), { deletions: 0, chosen: 'Marshall University' });
  });
});

test('a user-edited search is not shortened', browserTest, async () => {
  await fixture('edited', async ({ page, locator, select }) => {
    await assert.rejects(select({ timeoutMs: 6500 }), { code: 'OPTION_LABEL_MISMATCH' });
    assert.equal(await locator.inputValue(), 'User Changed Search');
    assert.equal(await page.evaluate(() => window.state.deletions), 0);
  });
});

test('search is not retriggered after an option selection has been attempted', browserTest, async () => {
  await fixture('commitPending', async ({ page, select }) => {
    await assert.rejects(select({ timeoutMs: 6500 }), { code: 'OPTION_NOT_COMMITTED' });
    assert.equal(await page.evaluate(() => window.state.deletions), 0);
  });
});
