// First-run setup: with no accounts, the sign-in card creates the first admin.
// run.mjs gives this suite its own server with an empty database.
import { chromium, devices } from 'playwright';
import { BASE, checker } from './helpers.mjs';

const OUT = process.argv[2];
const { check } = checker();
const browser = await chromium.launch();
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|409|400 \(Bad Request\)/.test(m.text())) errors.push(m.text()); });
};
const ADMIN = { email: 'Owner@Example.com', password: 'owner password 1' };
const text = (page, sel) => page.textContent(sel).then((s) => s.trim());

// ---- the first visitor sees setup, not sign-in
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
watch(page);
await page.goto(BASE);
await page.waitForSelector('#login-view:not([hidden])');
check('setup instead of sign-in', (await text(page, '#login-title')) === 'Set Up LingoLens');
check('asks to confirm the password', await page.isVisible('#setup-confirm'));
check('button creates the admin', (await text(page, '#login-submit')) === 'Create Admin Account');
check('password field is for a new password', (await page.getAttribute('#login-password', 'autocomplete')) === 'new-password');
check('tab title says setup', (await page.title()).startsWith('Set Up LingoLens'));
await page.screenshot({ path: `${OUT}/u-setup.png` });

await page.click('#login-lang [data-lang="zh"]');
check('setup in Chinese', (await text(page, '#login-title')) === '设置 LingoLens' && (await text(page, '#login-submit')) === '创建管理员账号');
await page.screenshot({ path: `${OUT}/u-setup-zh.png` });
await page.click('#login-lang [data-lang="en"]');
check('back to English', (await text(page, '#login-title')) === 'Set Up LingoLens');

// A second visitor opens the page now, and tries to finish setup after the first.
const late = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const latePage = await late.newPage();
watch(latePage);
await latePage.goto(BASE);
await latePage.waitForSelector('#login-view:not([hidden])');

// ---- checks before sending
await page.click('#login-submit');
check('empty form explains what to enter', (await text(page, '#login-error')).includes('Enter your email'));
await page.fill('#login-email', ADMIN.email);
await page.fill('#login-password', 'short');
await page.fill('#setup-confirm', 'short');
await page.click('#login-submit');
check('short password refused', (await text(page, '#login-error')).includes('at least 8'));
await page.fill('#login-password', ADMIN.password);
await page.fill('#setup-confirm', 'something else');
await page.click('#login-submit');
check('mismatched passwords refused', (await text(page, '#login-error')).includes('don’t match'));

// ---- create the admin: signed straight in
await page.fill('#setup-confirm', ADMIN.password);
await page.click('#login-submit');
await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 });
check('setup signs the admin in', true);
const me = await page.evaluate(() => fetch('/api/me').then((r) => r.json()));
check('the new account is an admin', me.user.is_admin === true && me.user.email === ADMIN.email.toLowerCase(), JSON.stringify(me.user));
await page.goto(BASE + '#/settings');
await page.waitForSelector('#settings-view:not([hidden])');
check('admin can manage members', await page.waitForSelector('#members-section:not([hidden])', { timeout: 5000 }).then(() => true, () => false));

// ---- the late visitor can't become admin too
await latePage.fill('#login-email', 'intruder@example.com');
await latePage.fill('#login-password', 'intruder password');
await latePage.fill('#setup-confirm', 'intruder password');
await latePage.click('#login-submit');
await latePage.waitForFunction(() => document.querySelector('#login-error').textContent.length > 0);
check('late setup explains it is already done', (await text(latePage, '#login-error')).includes('already set up'));
check('…and turns into sign-in', (await text(latePage, '#login-title')) === 'Sign In to LingoLens' && !(await latePage.isVisible('#setup-confirm')));
const direct = await latePage.evaluate(() => fetch('/api/auth/setup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'intruder@example.com', password: 'intruder password' }),
}).then((r) => r.status));
check('setup API closed after the first admin', direct === 409, String(direct));
await late.close();

// ---- sign out and back in with the new account
await page.click('#btn-logout');
await page.waitForSelector('#login-view:not([hidden])');
check('after sign-out: the normal sign-in page', (await text(page, '#login-title')) === 'Sign In to LingoLens');
await page.fill('#login-email', ADMIN.email);
await page.fill('#login-password', ADMIN.password);
await page.click('#login-submit');
await page.waitForSelector('#library-view:not([hidden])');
check('signs in with the new account', true);
await ctx.close();

// ---- a fresh browser gets sign-in, even on a phone in dark mode
const phone = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' });
const pp = await phone.newPage();
watch(pp);
await pp.goto(BASE);
await pp.waitForSelector('#login-view:not([hidden])');
check('new visitors see sign-in once set up', (await text(pp, '#login-title')) === 'Sign In to LingoLens');
await pp.screenshot({ path: `${OUT}/u-phone-login-dark.png` });
await phone.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
