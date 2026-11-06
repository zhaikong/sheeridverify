import { Camoufox, NewContext, DefaultAddons } from 'camoufox';
import { browserProxy } from '../core/network.js';

// Keep the owned browser session alive without polling or an arbitrary time limit.
export function waitForSessionClose({ browser, context, page }, signal) {
  return new Promise(resolve => {
    const finish = () => {
      browser.removeListener('disconnected', finish);
      context.removeListener('close', finish);
      page.removeListener('close', finish);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    browser.once('disconnected', finish);
    context.once('close', finish);
    page.once('close', finish);
    signal?.addEventListener('abort', finish, { once: true });
    // Check after subscribing so a close/abort between setup steps cannot be missed.
    if (signal?.aborted || !browser.isConnected() || page.isClosed()) finish();
  });
}

export async function createSession(config) {
  // Generate a fresh launch identity on every call. Never supply a saved fingerprint,
  // preset object, persistent profile directory, or restored storage state here.
  const browser = await Camoufox({
    headless: config.browser.headless,
    locale: config.browser.locale,
    persistent_context: false,
    fingerprint_preset: false,
    humanize: 1.5,
    // Let the page load its verification resources without the bundled ad blocker.
    exclude_addons: [DefaultAddons.UBO],
    proxy: browserProxy(),
    geoip: true,
  });
  try {
    // Unlike plain browser.newContext(), Camoufox's helper also draws and installs
    // a fresh context identity. Omitting preset lets the library use new randomness.
    const context = await NewContext(browser, {
      locale: config.browser.locale,
      // NewContext generates a fixed viewport by default. In a visible window,
      // use its actual content area so maximizing/resizing does not leave a blank strip.
      // Playwright JS uses null here (Python: no_viewport=True), never a boolean.
      ...(config.browser.headless ? {} : { viewport: null, deviceScaleFactor: undefined }),
    });
    context.setDefaultTimeout(config.timeouts.actionMs);
    context.setDefaultNavigationTimeout(config.timeouts.navigationMs);
    const page = await context.newPage();
    return { browser, context, page, close: () => browser.close() };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}
