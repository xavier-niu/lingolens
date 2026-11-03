// The bookmarklet: run on another site's page, it hands the page to a LingoLens
// tab (#/clip), which asks before adding it. Covers a site that refuses the
// server (403), a selection, signing in first, Cancel, and spoofed messages.
import { chromium, devices } from 'playwright';
import { BASE, SITE, freshUser, signIn, checker } from './helpers.mjs';

const OUT = process.argv[2];
const { check } = checker();
const browser = await chromium.launch();
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/40[13]|422/.test(m.text())) errors.push(m.text()); });
};
const user = await freshUser(browser);
const text = (page, sel) => page.textContent(sel).then((s) => s.trim());

const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
ctx.on('page', watch);
const app = await ctx.newPage();
await signIn(app, user);

// ---- the server can't fetch the page: the Add Source hint leads to the bookmarklet
await app.locator('#btn-add:visible, #btn-add-empty:visible').first().click();
await app.waitForSelector('#source-dialog[open]');
await app.click('#src-kinds label:has(input[value="url"])');
check('Web Page panel mentions the bookmarklet', await app.isVisible('#source-dialog [data-clip-setup]'));
await app.fill('#src-url', SITE + 'blocked.html');
await app.click('#src-save');
await app.waitForFunction(() => document.querySelector('#src-error').textContent.length > 0);
check('the server gets 403 from the site', (await text(app, '#src-error')).includes('403'));
await app.click('#source-dialog [data-clip-setup]');
await app.waitForSelector('#settings-view:not([hidden])');
check('"Set it up" closes the dialog', !(await app.isVisible('#source-dialog')));
await app.waitForTimeout(200);
const top = await app.$eval('#set-clip-h', (h) => h.getBoundingClientRect().top);
check('…and opens Settings at the bookmarklet, below the header', top >= 60 && top < 200, String(top));

// ---- Settings: the button to drag, and the code for phones
const href = await app.getAttribute('#bm-link', 'href');
check('bookmarklet is a javascript: link', href.startsWith('javascript:'));
check('phone code is the same bookmarklet', (await text(app, '#bm-code')) === href);
const code = decodeURIComponent(href.slice('javascript:'.length));
check('it posts only to this server', code.includes(JSON.stringify(BASE)) && code.includes('postMessage(p,O)'));
await app.click('#bm-link');
check('clicking it here explains to drag it', (await text(app, '#bm-status')).includes('bookmarks bar'));
check('…and opens nothing', ctx.pages().length === 1);
await app.locator('section.set-section:has(> .set-head #set-clip-h)').screenshot({ path: `${OUT}/c-settings.png` });

// The text as stored: the reader's own text gets glosses inside it as it's annotated.
const stored = (page) => page.evaluate(() => fetch('/api/books/' + location.hash.split('/').pop()).then((r) => r.json()).then((b) => b.content));

// Runs the bookmarklet on a page, as clicking it in the bookmarks bar does.
async function runBookmarklet(page) {
  const [tab] = await Promise.all([ctx.waitForEvent('page'), page.evaluate(code)]);
  return tab;
}

// ---- the blocked page, read in the browser instead
const site = await ctx.newPage();
await site.goto(SITE + 'blocked.html');
let tab = await runBookmarklet(site);
await tab.waitForSelector('#clip-page:not([hidden])', { timeout: 10000 });
check('new tab shows the page to add, without the site name', (await text(tab, '#clip-title')) === 'Night Trains of Europe');
check('…and where it is from', (await text(tab, '#clip-from')) === 'From 127.0.0.1');
check('…and that the article is kept', (await text(tab, '#clip-what')).includes('article'));
check('breadcrumb: Shelf / Add Page', (await tab.$$eval('#crumbs li', (l) => l.map((x) => x.textContent.trim()).join(' / '))) === 'Shelf / Add Page');
await tab.screenshot({ path: `${OUT}/c-clip.png` });
await tab.click('#clip-save');
await tab.waitForSelector('#reader-view:not([hidden])', { timeout: 10000 });
let art = await stored(tab);
const bookTitle = await text(tab, '#book-title');
check('added and opened, with the article’s title', bookTitle === 'Night Trains of Europe', bookTitle);
check('article text kept', art.includes('fall asleep to the sound of the wheels'));
check('text added by the page’s scripts kept', art.includes('a conductor knocks on the door'));
check('menus and footer left out', !/Join now|Members only/.test(art));
await tab.goBack().catch(() => {});
check('Back doesn’t return to the import', !(await tab.evaluate(() => location.hash)).startsWith('#/clip'));
await tab.close();

// ---- only the selection
await site.goto(SITE + 'article.html');
await site.evaluate(() => {
  const r = document.createRange();
  r.setStartBefore(document.querySelectorAll('article p')[1]);
  r.setEndAfter(document.querySelectorAll('article p')[1]);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
});
tab = await runBookmarklet(site);
await tab.waitForSelector('#clip-page:not([hidden])', { timeout: 10000 });
const what = await text(tab, '#clip-what');
check('a selection is announced with its length', /selected .*\(3\d words\)/.test(what), what);
await tab.click('#clip-save');
await tab.waitForSelector('#reader-view:not([hidden])', { timeout: 10000 });
art = await stored(tab);
check('only the selection kept', art.startsWith('When you stay longer') && art.endsWith('Saturday morning.') && !art.includes('Slow travel is less'), art.slice(0, 80));
check('…under the article’s title', (await text(tab, '#book-title')) === 'The Art of Slow Travel');
await tab.close();
await site.evaluate(() => getSelection().removeAllRanges());

// ---- Cancel closes the tab and adds nothing
const before = (await app.evaluate(() => fetch('/api/books').then((r) => r.json()))).length;
tab = await runBookmarklet(site);
await tab.waitForSelector('#clip-page:not([hidden])', { timeout: 10000 });
await Promise.all([tab.waitForEvent('close'), tab.click('#clip-cancel')]);
check('Cancel closes the tab', tab.isClosed());
const after = (await app.evaluate(() => fetch('/api/books').then((r) => r.json()))).length;
check('…and adds nothing', after === before, `${before} → ${after}`);

// ---- a page can't pretend to be another site
const [spoofTab] = await Promise.all([ctx.waitForEvent('page'), site.evaluate((base) => {
  const w = open(base + '#/clip');
  addEventListener('message', (e) => {
    if (e.source === w && e.data === 'lingolens:ready') {
      w.postMessage({ type: 'lingolens:page', url: 'https://bank.example/statement', title: 'Statement', html: '<p>x</p>', selection: '' }, '*');
    }
  });
}, BASE)]);
await spoofTab.waitForSelector('#clip-view:not([hidden])');
await spoofTab.waitForTimeout(1500);
check('a page claiming another site is ignored', !(await spoofTab.isVisible('#clip-page')));
await spoofTab.close();

// ---- opened directly, not from the bookmarklet
await app.goto(BASE + '#/clip');
await app.waitForSelector('#clip-none:not([hidden])', { timeout: 3000 });
check('opened directly: explains what this is', (await text(app, '#clip-none h1')) === 'No page arrived');
await app.click('#clip-none [data-clip-setup]');
await app.waitForSelector('#settings-view:not([hidden])');
check('…and links to the setup', true);
await ctx.close();

// ---- signed out: sign in first, then the page is still there
const fresh = await browser.newContext({ viewport: { width: 1280, height: 860 } });
fresh.on('page', watch);
const site2 = await fresh.newPage();
await site2.goto(SITE + 'article.html');
const [tab2] = await Promise.all([fresh.waitForEvent('page'), site2.evaluate(code)]);
await tab2.waitForSelector('#login-view:not([hidden])');
check('signed out: asks to sign in first', true);
await tab2.fill('#login-email', user.email);
await tab2.fill('#login-password', user.password);
await tab2.click('#login-submit');
await tab2.waitForSelector('#clip-page:not([hidden])', { timeout: 10000 });
check('…then shows the page to add', (await text(tab2, '#clip-title')).startsWith('The Art of Slow Travel'));
await tab2.click('#clip-save');
await tab2.waitForSelector('#reader-view:not([hidden])', { timeout: 10000 });
check('…and adds it', (await stored(tab2)).includes('fewer photos and far better stories'));
await fresh.close();

// ---- phone, dark, Chinese
const phone = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' });
phone.on('page', watch);
const pp = await phone.newPage();
await signIn(pp, user);
await pp.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'zh' }) }));
const ps = await phone.newPage();
await ps.goto(SITE + 'blocked.html');
const [pt] = await Promise.all([phone.waitForEvent('page'), ps.evaluate(code)]);
await pt.waitForSelector('#clip-page:not([hidden])', { timeout: 10000 });
check('phone: in Chinese', (await text(pt, '#clip-save')) === '加入书架' && (await text(pt, '#clip-from')) === '来自 127.0.0.1');
check('phone: fits the screen', await pt.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await pt.screenshot({ path: `${OUT}/c-phone-clip.png` });
await pp.goto(BASE + '#/settings');
await pp.waitForSelector('#settings-view:not([hidden])');
await pp.locator('#set-clip-h').scrollIntoViewIfNeeded();
check('phone: settings fit the screen', await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
check('phone: no drag button, just the code', !(await pp.isVisible('#bm-link')) && await pp.isVisible('#bm-code'));
await pp.locator('section.set-section:has(> .set-head #set-clip-h)').screenshot({ path: `${OUT}/c-phone-settings.png` });
await phone.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
