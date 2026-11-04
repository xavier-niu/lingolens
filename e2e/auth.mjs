// Accounts: sign-in, members, per-user isolation, key handling, browser-data import.
import { chromium } from 'playwright';
import { BASE, ADMIN, freshUser, signIn, checker } from './helpers.mjs';

const OUT = process.argv[2];
const { check } = checker();
const browser = await chromium.launch();
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|400 \(Bad Request\)/.test(m.text())) errors.push(m.text()); });
};

// ---- sign-in page
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
watch(page);
await page.goto(BASE);
await page.waitForSelector('#login-view:not([hidden])');
check('signed-out visitors see the sign-in page', await page.isVisible('#login-form'));
check('header hidden on sign-in page', !(await page.isVisible('.topbar')));
check('no first-run setup once accounts exist', (await page.textContent('#login-title')) === 'Sign In to LingoLens' && !(await page.isVisible('#setup-confirm')));
await page.screenshot({ path: `${OUT}/a-login.png` });
await page.click('#login-submit');
check('empty form explains what to enter', (await page.textContent('#login-error')).includes('Enter your email'));
await page.fill('#login-email', ADMIN.email);
await page.fill('#login-password', 'wrong password');
await page.click('#login-submit');
await page.waitForFunction(() => document.querySelector('#login-error').textContent.length > 0);
check('wrong password is rejected', (await page.textContent('#login-error')).includes('incorrect'));
await page.click('#login-lang [data-lang="zh"]');
check('sign-in page switches to Chinese', (await page.textContent('#login-view h1')) === '登录 LingoLens');
await page.screenshot({ path: `${OUT}/a-login-zh.png` });
await page.click('#login-lang [data-lang="en"]');

// ---- admin creates a member from Settings
await page.fill('#login-password', ADMIN.password);
await page.click('#login-submit');
await page.waitForSelector('#library-view:not([hidden])');
check('admin signs in', true);
await page.click('#btn-account'); await page.click('#acct-settings');
await page.waitForSelector('#settings-view:not([hidden])');
check('admin sees Members', await page.isVisible('#members-section'));
const memberEmail = `member${Date.now()}@example.com`;
await page.fill('#m-email', memberEmail);
await page.fill('#m-name', 'Mei');
const tempPw = await page.inputValue('#m-password');
check('a temporary password is suggested', tempPw.length >= 12);
await page.click('#member-form button[type="submit"]');
await page.waitForFunction((e) => document.querySelector('#member-list').textContent.includes(e), memberEmail);
check('new member listed', true);
check('creation message shows the temporary password', (await page.textContent('#m-status')).includes(tempPw));
await page.screenshot({ path: `${OUT}/a-settings-admin.png`, fullPage: true });

// ---- an admin's text isn't visible to the member
await page.evaluate(() => fetch('/api/books', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Admin private notes', content: 'Only the admin should see this.' }),
}));
await page.click('#btn-logout');
await page.waitForSelector('#login-view:not([hidden])');
check('sign out returns to sign-in page', true);
await page.reload();
await page.waitForSelector('#login-view:not([hidden])');
check('signed out stays signed out after reload', await page.isVisible('#login-form'));

await page.fill('#login-email', memberEmail);
await page.fill('#login-password', tempPw);
await page.click('#login-submit');
await page.waitForSelector('#library-view:not([hidden])');
check('member signs in with the temporary password', true);
check('member starts with an empty shelf', await page.isVisible('#shelf-empty'));
check('member is asked to choose a model', (await page.textContent('#banner-text')).includes('AI model'));
await page.click('#banner-action');
await page.waitForSelector('#settings-view:not([hidden])');
check('banner opens Settings', true);
check('member does not see Members', !(await page.isVisible('#members-section')));

// ---- model settings: the key is saved but never shown again
await page.selectOption('#s-preset', 'deepseek');
await page.fill('#s-key', 'sk-e2e-secret-key');
await page.click('#s-save');
await page.waitForFunction(() => document.querySelector('#s-status').textContent === 'Saved.');
check('key field is cleared after saving', (await page.inputValue('#s-key')) === '');
check('key field says a key is saved', (await page.getAttribute('#s-key', 'placeholder')).startsWith('Saved'));
check('remove-key action offered', await page.isVisible('#s-key-remove'));
const me = await page.evaluate(() => fetch('/api/me').then((r) => r.text()));
check('the key never comes back from the server', !me.includes('sk-e2e-secret-key'));
await page.reload();
await page.waitForSelector('#settings-view:not([hidden])');
check('saved provider restored after reload', (await page.inputValue('#s-preset')) === 'deepseek');
await page.click('#s-key-remove');
await page.waitForFunction(() => document.querySelector('#s-status').textContent === 'Key removed.');
check('key can be removed', !(await page.isVisible('#s-key-remove')));

// ---- change password
await page.fill('#pw-current', tempPw);
await page.fill('#pw-new', 'my own password');
await page.click('#password-form button[type="submit"]');
await page.waitForFunction(() => document.querySelector('#pw-status').textContent.length > 0);
check('member changes their password', (await page.textContent('#pw-status')).startsWith('Password updated'));
await page.click('#btn-account');
await page.click('#acct-signout'); // sign out from the header's account menu
await page.waitForSelector('#login-view:not([hidden])');
check('signs out from the account menu', true);
await page.fill('#login-email', memberEmail);
await page.fill('#login-password', 'my own password');
await page.click('#login-submit');
await page.waitForSelector('#library-view:not([hidden])');
check('new password works', true);
await ctx.close();

// ---- texts kept in this browser before accounts are imported on first sign-in
const user = await freshUser(browser);
const legacy = await browser.newContext();
const lp = await legacy.newPage();
watch(lp);
await lp.goto(BASE);
await lp.evaluate(() => {
  localStorage.setItem('lingolens.library', JSON.stringify([
    { id: 'old1', title: 'An Old Saved Text', format: 'text', content: 'Something I pasted before accounts existed.', progress: 0.4, pos: 0.3 },
  ]));
  localStorage.setItem('lingolens.wordbook', JSON.stringify([{ key: 'serendipity', lemma: 'serendipity', zh: '意外发现' }]));
  localStorage.setItem('lingolens.known', JSON.stringify(['apple']));
});
await signIn(lp, user, { model: false });
await lp.waitForSelector('#shelf .book');
const titles = await lp.$$eval('.cover-title', (s) => s.map((x) => x.textContent));
check('browser texts imported into the account', titles.includes('An Old Saved Text'), titles.join(' | '));
check('import keeps reading progress', (await lp.textContent('.book-stat')).includes('40% read'));
check('wordbook imported', (await lp.textContent('#wb-count')) === '1');
check('browser copy removed after import', await lp.evaluate(() => localStorage.getItem('lingolens.library') === null));
await legacy.close();

check('no console/page errors', errors.length === 0, errors.join(' | '));
await browser.close();
