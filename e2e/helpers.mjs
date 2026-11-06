// Shared test helpers: fresh accounts (via the admin API) and UI sign-in.
// run.mjs sets these for each suite; the defaults match a hand-started dev server.
export const BASE = process.env.E2E_BASE || 'http://127.0.0.1:18080/';
export const SITE = process.env.E2E_SITE || 'http://127.0.0.1:18081/'; // fixtures/ served over HTTP
// Local path of a file in fixtures/, for upload inputs.
export const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
export const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL || 'admin@example.com',
  password: process.env.E2E_ADMIN_PASSWORD || 'admin password 1',
};

let n = 0;
export async function freshUser(browser, { admin = false } = {}) {
  const ctx = await browser.newContext();
  const r = ctx.request;
  const login = await r.post(BASE + 'api/auth/login', { data: ADMIN });
  if (!login.ok()) throw new Error('admin login failed: ' + login.status());
  const user = { email: `reader${Date.now()}${n++}@example.com`, password: 'reader password 1' };
  const res = await r.post(BASE + 'api/admin/users', { data: { ...user, is_admin: admin } });
  if (!res.ok()) throw new Error('create user failed: ' + (await res.text()));
  await ctx.close();
  return user;
}

// Sign in through the form; optionally pick the fake model so glosses work.
export async function signIn(page, user, { model = true, hint = false } = {}) {
  await page.goto(BASE);
  // Other suites click near the bottom of the page; keep the first-run hint out of their way.
  if (!hint) await page.evaluate(() => localStorage.setItem('lingolens.hint.reader', '1'));
  await page.waitForSelector('#login-view:not([hidden])');
  await page.fill('#login-email', user.email);
  await page.fill('#login-password', user.password);
  await page.click('#login-submit');
  await page.waitForSelector('#library-view:not([hidden])');
  if (model) {
    await page.evaluate(() => fetch('/api/me/model', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'fake', kind: 'fake' }),
    }));
    await page.reload();
    await page.waitForSelector('#library-view:not([hidden])');
  }
}

export function checker() {
  const results = [];
  const check = (name, ok, extra = '') => {
    const line = `${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`;
    results.push(line);
    console.log(line);
  };
  return { results, check };
}

// The reader's text without the glosses above its words. Glosses can arrive at
// any moment and sit inside the text ("Paragraph〈par〉释义 6"), so a check on the
// words themselves has to leave them out or it depends on timing.
export const articleText = (page) => page.$eval('#article', (article) => {
  const copy = article.cloneNode(true);
  copy.querySelectorAll('rt').forEach((rt) => rt.remove());
  return copy.textContent;
});

// Waits until no new glosses have arrived for a moment. The header's indicator can't
// tell: it only covers what's on screen, not what is annotated ahead of the reader.
export async function glossesSettled(page) {
  const count = () => page.$$eval('#article ruby.ann', (r) => r.length);
  for (let last = -1, now = await count(); now !== last; now = await count()) {
    last = now;
    await page.waitForTimeout(400);
  }
}

// Waits until the reader's text holds `text`; rejects after `timeout` ms.
export const waitForArticleText = (page, text, timeout = 8000) => page.waitForFunction((text) => {
  const article = document.querySelector('#article');
  if (!article) return false;
  const copy = article.cloneNode(true);
  copy.querySelectorAll('rt').forEach((rt) => rt.remove());
  return copy.textContent.includes(text);
}, text, { timeout });
