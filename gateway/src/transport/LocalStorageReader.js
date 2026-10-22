// Shared Playwright-based localStorage reader.
//
// dayGLANCE, lastGLANCE, and lifeGLANCE are all localStorage SPAs with no
// server-side data. This reader launches a browser, navigates to the app,
// and reads the localStorage keys that hold each app's state. It returns a
// normalized snapshot that each adapter's #read() consumes.
//
// NOTE: these apps are auth-gated and encrypted. A production reader would
// need to replay the user's login (cookies) and decrypt the state. This
// implementation reads raw localStorage keys as a best-effort fallback and
// returns whatever it can find, leaving structured adapters to normalize.

import { chromium } from 'playwright';

export class LocalStorageReader {
  constructor({ webUrl, headless = true, timeoutMs = 30000, cookie } = {}) {
    this.webUrl = webUrl;
    this.headless = headless;
    this.timeoutMs = timeoutMs;
    this.cookie = cookie; // optional { name, value } to set before load
  }

  async #browser() {
    return await chromium.launch({ headless: this.headless });
  }

  /**
   * Read localStorage for a single app key (or all keys) from the page.
   * @param {object} opts
   * @param {string} opts.webUrl
   * @param {string} [opts.key] localStorage key to read; omit for all keys
   */
  async read({ webUrl, key }) {
    const browser = await this.#browser();
    try {
      const page = await browser.newPage();
      if (this.cookie) {
        await page.context().addCookies([{ name: this.cookie.name, value: this.cookie.value, url: webUrl }]);
      }
      await page.goto(webUrl, { waitUntil: 'networkidle', timeout: this.timeoutMs }).catch(() => {});
      const data = await page.evaluate((k) => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const name = localStorage.key(i);
          if (!k || name === k) out[name] = localStorage.getItem(name);
        }
        return out;
      }, key);
      return data;
    } finally {
      await browser.close();
    }
  }
}

export default LocalStorageReader;
