// Dark mode: follows the device by default, can be pinned light or dark, syncs through the profile.
import { chromium, devices } from 'playwright';
import { BASE, freshUser, signIn, checker } from './helpers.mjs';

const OUT = process.argv[2];
const { check } = checker();
const browser = await chromium.launch();
const errors = [];
const user = await freshUser(browser);
const LIGHT = 'rgb(250, 250, 250)';
const DARK = 'rgb(28, 27, 25)';
const bg = (p) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
const barColors = (p) => p.$$eval('meta[name="theme-color"]', (ms) => ms.map((m) => m.content));
const pressed = (p, sel) => p.$eval(`${sel} [aria-pressed="true"]`, (b) => b.dataset.mode);
const prefs = (p) => p.evaluate(() => fetch('/api/me').then((r) => r.json()).then((j) => j.user.prefs.theme));

// ---- device in dark mode, default "System"
const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
await signIn(page, user);
check('new accounts follow the device', (await prefs(page)) === 'system');
check('dark device → dark page', (await bg(page)) === DARK);
await page.screenshot({ path: `${OUT}/t-shelf-system-dark.png` });
await page.emulateMedia({ colorScheme: 'light' });
check('System switches live when the device does', (await bg(page)) === LIGHT);
await page.emulateMedia({ colorScheme: 'dark' });

await page.click('#btn-gear');
await page.waitForSelector('#settings-view:not([hidden])');
check('Settings shows System selected', (await pressed(page, '#theme-seg')) === 'system');
await page.click('#theme-seg [data-mode="light"]');
check('Light overrides a dark device', (await bg(page)) === LIGHT);
check('browser bar colour follows the pick', (await barColors(page)).every((c) => c === '#fafafa'));
await page.waitForTimeout(300);
check('choice saved to the profile', (await prefs(page)) === 'light');
await page.reload();
await page.waitForSelector('#settings-view:not([hidden])');
check('pinned theme survives reload', (await bg(page)) === LIGHT && (await pressed(page, '#theme-seg')) === 'light');

await page.click('#theme-seg [data-mode="dark"]');
check('Dark pins dark', (await bg(page)) === DARK);
await page.emulateMedia({ colorScheme: 'light' });
check('pinned Dark ignores a light device', (await bg(page)) === DARK);
await page.screenshot({ path: `${OUT}/t-settings-dark.png`, fullPage: true });

// ---- quick switch in the reader
const book = await page.evaluate(() => fetch('/api/books', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Night Reading', content: Array.from({ length: 4 }, (_, i) => `Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog, and then it takes a long nap in the warm afternoon sun.`).join('\n\n') }),
}).then((r) => r.json()));
await page.goto(BASE + '#/read/' + book.id);
await page.waitForSelector('#reader-view:not([hidden])');
await page.waitForSelector('ruby.ann', { state: 'attached' });
await page.click('#btn-display');
await page.waitForSelector('#display-pop:popover-open');
check('reader options show the same choice', (await pressed(page, '#display-pop .theme-seg')) === 'dark');
await page.screenshot({ path: `${OUT}/t-reader-dark-pop.png` });
await page.click('#display-pop [data-mode="light"]');
check('reader quick switch works', (await bg(page)) === LIGHT);
check('both switches stay in step', (await pressed(page, '#theme-seg')) === 'light');
await page.click('#display-pop [data-mode="dark"]');
await page.keyboard.press('Escape');
await page.screenshot({ path: `${OUT}/t-reader-dark.png` });
await page.waitForTimeout(300);
await ctx.close();

// ---- another device: the profile's choice applies after sign-in, and before paint next time
const phone = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'light' });
const pp = await phone.newPage();
pp.on('pageerror', (e) => errors.push(String(e)));
await signIn(pp, user);
check('profile theme follows to a new device', (await bg(pp)) === DARK);
const early = await pp.evaluate(() => new Promise((res) => {
  // Fetch the page fresh in an iframe and read <html data-theme> as soon as the head has run.
  const f = document.createElement('iframe');
  f.src = '/';
  f.onload = () => res(f.contentDocument.documentElement.dataset.theme || 'none');
  document.body.append(f);
}));
check('theme applied from this browser before sign-in finishes', early === 'dark', early);
await pp.screenshot({ path: `${OUT}/t-phone-dark.png` });
await pp.goto(BASE + '#/settings');
await pp.waitForSelector('#settings-view:not([hidden])');
await pp.click('#theme-seg [data-mode="system"]');
check('back to System follows the light device', (await bg(pp)) === LIGHT);
check('browser bar colours restored per scheme', JSON.stringify(await barColors(pp)) === JSON.stringify(['#fafafa', '#1c1b19']));
await pp.screenshot({ path: `${OUT}/t-phone-settings.png`, fullPage: true });
await phone.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
