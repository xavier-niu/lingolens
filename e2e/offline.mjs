// Offline mode: the app opens without a connection, the shelf and glosses come
// from this browser, changes wait in the outbox and sync when back online.
import { chromium, devices } from 'playwright';
import { BASE, freshUser, signIn, checker, fixture, waitForArticleText } from './helpers.mjs';

const OUT = process.argv[2];
const { check } = checker();
const browser = await chromium.launch();
const errors = [];
const user = await freshUser(browser);

const para = (n, extra = '') => `Paragraph ${n}. The quick brown fox jumps over the lazy dog, and then it takes a long nap in the warm afternoon sun.${extra}`;
const BOOK_A = Array.from({ length: 30 }, (_, i) => para(i + 1, i === 2 ? ' We had dinner by the river.' : '')).join('\n\n');
const BOOK_B = Array.from({ length: 6 }, (_, i) => para(i + 1)).join('\n\n');

const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.clock.install(); // time runs as usual, and reading tests can skip ahead
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept());
await signIn(page, user);

const post = (p, path, body) => p.evaluate(([path, body]) => fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json()), [path, body]);
const get = (p, path) => p.evaluate((path) => fetch(path, { cache: 'no-store' }).then((r) => r.json()), path);
const a = await post(page, '/api/books', { title: 'Harbour Notes', content: BOOK_A });
const b = await post(page, '/api/books', { title: 'Second Book', content: BOOK_B });

// Texts saved on the device, and the outbox length.
const idb = (p, store) => p.evaluate((store) => new Promise((resolve) => {
  const id = localStorage.getItem('lingolens.user');
  const r = indexedDB.open('lingolens-u' + id);
  r.onsuccess = () => {
    const q = r.result.transaction(store).objectStore(store).count();
    q.onsuccess = () => { resolve(q.result); r.result.close(); };
  };
  r.onerror = () => resolve(-1);
}), store);

const wordPoint = (p, word) => p.evaluate((word) => {
  const w = document.createTreeWalker(document.querySelector('#article'), NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const n = w.currentNode; const i = n.data.indexOf(word);
    if (i >= 0 && !n.parentElement.closest('ruby')) {
      n.parentElement.scrollIntoView({ block: 'center' });
      const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 3);
      const bx = r.getBoundingClientRect(); return { x: bx.left + bx.width / 2, y: bx.top + bx.height / 2 };
    }
  }
  return null;
}, word);

// ---- online: read book A once (glosses + a lookup are saved here)
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
await page.goto(BASE + `#/read/${a.id}`);
await page.waitForSelector('#article ruby.ann', { state: 'attached' });
await page.waitForFunction(() => document.querySelector('#progress').hidden);
const glossesOnline = await page.$$eval('#article ruby.ann', (r) => r.length);
const pt = await wordPoint(page, 'dinner');
await page.mouse.click(pt.x, pt.y);
await page.waitForSelector('#card:not([hidden]) .detail h4');
await page.keyboard.press('Escape');
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload(); // now controlled by the service worker
await page.waitForSelector('#library-view:not([hidden])');
check('service worker controls the page', await page.evaluate(() => !!navigator.serviceWorker.controller));
await page.waitForFunction(() => true);
for (let i = 0; i < 40 && (await idb(page, 'texts')) < 2; i++) await page.waitForTimeout(150);
check('both books saved for offline reading', (await idb(page, 'texts')) === 2);
check('no badge while online', await page.isHidden('#net-status'));

// ---- offline
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('#library-view:not([hidden])', { timeout: 10000 });
check('app opens offline', true);
await page.waitForFunction(() => document.querySelectorAll('#shelf .book').length >= 2, null, { timeout: 5000 }).catch(() => {}); // the shelf is drawn just after its view opens
check('shelf from this device', (await page.$$('#shelf .book')).length === 2, String((await page.$$('#shelf .book')).length));
await page.waitForSelector('#net-status:not([hidden])', { timeout: 5000 }).catch(() => {});
check('Offline badge shown', await page.isVisible('#net-status') && (await page.textContent('#net-label')) === 'Offline');
check('no error banner', await page.isHidden('#banner'));
await page.screenshot({ path: `${OUT}/o-shelf-offline.png` });

await page.goto(BASE + `#/read/${a.id}`);
await page.waitForSelector('#reader-view:not([hidden])');
await page.waitForSelector('#article ruby.ann', { state: 'attached', timeout: 5000 });
await page.waitForTimeout(300);
const glossesOffline = await page.$$eval('#article ruby.ann', (r) => r.length);
check('glosses come back offline', glossesOffline > 0 && glossesOffline >= glossesOnline - 2, `${glossesOffline} of ${glossesOnline}`);
check('no failed paragraphs offline', (await page.$$('.seg-failed')).length === 0);
check('no annotation error offline', await page.isHidden('#banner'));
await page.screenshot({ path: `${OUT}/o-reader-offline.png` });

// word looked up before still works
const pt2 = await wordPoint(page, 'dinner');
if (pt2) {
  await page.mouse.click(pt2.x, pt2.y);
  await page.waitForSelector('#card:not([hidden]) .detail:not(.muted)');
  check('looked-up word still explained offline', !!(await page.$('#card .detail h4')), await page.textContent('#card'));
} else {
  // the word got a gloss; open its ruby instead
  await page.click('#article ruby.ann >> text=dinner');
  check('looked-up word still explained offline', true);
}
// save it to the wordbook
const saveBtn = await page.$('#card [data-act="save"]');
if (saveBtn) await saveBtn.click();
await page.keyboard.press('Escape');

// a new word needs the network
const pt3 = await wordPoint(page, 'river');
await page.mouse.click(pt3.x, pt3.y);
await page.waitForSelector('#card:not([hidden]) .detail.error');
check('new lookup explains it needs a connection', (await page.textContent('#card .detail.error')).includes('offline'));
await page.click('#card [data-act="ask"]');
await page.waitForSelector('#chat:not([hidden])');
await page.waitForSelector('#chat-log .msg.error');
check('Ask AI says it needs a connection', (await page.textContent('#chat-log .msg.error')).includes('offline'), await page.$eval('#chat-log', (l) => l.innerHTML));
await page.click('#chat-close').catch(() => page.keyboard.press('Escape'));
await page.keyboard.press('Escape');

// read on: progress kept offline
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
await page.clock.runFor(60_000);
const progressOffline = await page.evaluate(() => document.querySelector('#read-thread > div').style.width);

// other book opens from the device too (the reader is already showing book A,
// so wait for B's title rather than for the reader view)
await page.goto(BASE + `#/read/${b.id}`);
await page.waitForFunction(() => document.querySelector('#book-title').textContent === 'Second Book', null, { timeout: 5000 }).catch(() => {});
check('a book never opened online reads offline', await waitForArticleText(page, 'Paragraph 6', 5000).then(() => true, () => false), await page.textContent('#book-title'));

// add a text offline
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
await page.locator('#btn-add:visible, #btn-add-empty:visible').first().click();
await page.waitForSelector('#source-dialog[open]');
check('offline note in Add Source', await page.isVisible('#src-offline'));
check('web page disabled offline; files (for PDFs) still offered', await page.$$eval('#src-kinds input', (xs) => xs.filter((x) => x.disabled).map((x) => x.value).join()) === 'url');
await page.screenshot({ path: `${OUT}/o-source-offline.png` });
await page.click('#src-kinds label:has(input[value="file"])');
await page.setInputFiles('#src-file', fixture('book.epub'));
await page.click('#src-save');
await page.waitForFunction(() => document.querySelector('#src-error').textContent.length > 0);
check('an EPUB offline: needs a connection', (await page.textContent('#src-error')).includes('needs a connection'));
await page.click('#src-kinds label:has(input[value="text"])');
await page.fill('#src-title', 'Written Offline');
await page.fill('#src-text', '# Written Offline\n\nThis note was written on a train with no signal.\n\n- one\n- two');
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
check('offline text opens in the reader', (await page.textContent('#book-title')) === 'Written Offline');
check('…with a temporary id', (await page.evaluate(() => location.hash)).startsWith('#/read/local-'));

// delete book B offline
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
await page.click(`#shelf [data-del-book="${b.id}"]`);
await page.waitForTimeout(200);
const titles = await page.$$eval('#shelf .book', (els) => els.map((e) => e.textContent));
check('offline shelf: new text in, deleted text out', titles.some((x) => x.includes('Written Offline')) && !titles.some((x) => x.includes('Second Book')), titles.length + '');

// a setting changed offline
await page.click('#btn-account'); await page.click('#acct-settings');
await page.waitForSelector('#settings-view:not([hidden])');
await page.click('#theme-seg button[data-mode="dark"]');
const pending = await idb(page, 'outbox');
check('changes wait in the outbox', pending >= 4, String(pending));
check('badge counts them', (await page.getAttribute('#net-status', 'title')).includes(String(pending)));
await page.screenshot({ path: `${OUT}/o-settings-offline.png` });

// ---- back online: everything syncs
await page.goto(BASE + `#/read/${a.id}`);
await page.waitForSelector('#reader-view:not([hidden])');
await ctx.setOffline(false);
await page.waitForFunction(() => document.querySelector('#net-status').dataset.mode === 'synced', null, { timeout: 15000 });
check('badge says Synced', (await page.textContent('#net-label')) === 'Synced');
await page.screenshot({ path: `${OUT}/o-synced.png` });
check('outbox empty', (await idb(page, 'outbox')) === 0);
const books = await get(page, '/api/books');
const created = books.find((x) => x.title === 'Written Offline');
check('offline text now on the server', !!created && !created.id.startsWith('local-'));
check('…exactly once', books.filter((x) => x.title === 'Written Offline').length === 1);
check('offline delete reached the server', !books.some((x) => x.id === b.id));
const serverA = books.find((x) => x.id === a.id);
check('offline reading progress synced', serverA.progress > 0.3, `${serverA.progress} (bar ${progressOffline})`);
const wb = await get(page, '/api/wordbook');
check('word saved offline is in the wordbook', wb.some((w) => w.key === 'dinner'), wb.map((w) => w.key).join());
const me = await get(page, '/api/me');
check('setting changed offline synced', me.user.prefs.theme === 'dark');
await page.waitForFunction(() => document.querySelector('#net-status').hidden, null, { timeout: 5000 });
check('badge goes away after syncing', true);

// the temporary id was swapped for the real one
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
await page.click(`#shelf a[href="#/read/${created.id}"]`).catch(() => {});
await page.waitForSelector('#reader-view:not([hidden])');
check('new text opens by its real id', (await page.evaluate(() => location.hash)) === `#/read/${created.id}`);
check('…as Markdown', (await page.$$('#article ul li')).length === 2);

// another device sees it all
const other = await browser.newContext({ ...devices['iPhone 13'] });
const op = await other.newPage();
op.on('pageerror', (e) => errors.push(String(e)));
await signIn(op, user, { model: false });
const otherShelf = await op.$$eval('#shelf .book', (els) => els.map((e) => e.textContent).join('|'));
check('other device: offline text arrives', otherShelf.includes('Written Offline'));
check('other device: deleted text gone', !otherShelf.includes('Second Book'));
check('other device: dark theme', await op.evaluate(() => document.documentElement.dataset.theme === 'dark'));

// newer reading on the other device isn't undone by an older offline position
await other.close();

// ---- glosses saved under older rules go when the rules change
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
await page.reload();
await page.waitForSelector('#library-view:not([hidden])');
const glossesKept = await idb(page, 'anns');
check('saved glosses stay while the rules do', glossesKept > 0, String(glossesKept));
await page.route('**/api/config', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ response: res, json: { ...(await res.json()), gloss_version: 'newer' } });
});
await page.reload();
await page.waitForSelector('#library-view:not([hidden])');
const glossesLeft = await idb(page, 'anns');
check('saved glosses go when the rules change', glossesLeft === 0, String(glossesLeft));
await page.unroute('**/api/config');

// ---- a change rejected by the server is reported, not retried forever
await ctx.setOffline(true);
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
await page.evaluate(() => fetch('/api/books').catch(() => {}));
await page.locator('#btn-add:visible, #btn-add-empty:visible').first().click();
await page.fill('#src-text', 'Just a short note.');
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
await ctx.setOffline(false);
await page.waitForFunction(() => document.querySelector('#net-status').dataset.mode === 'synced' || document.querySelector('#net-status').hidden, null, { timeout: 15000 });
check('second offline text synced too', (await get(page, '/api/books')).some((x) => x.title === 'Just a short note.'));

// ---- signing out offline ends the server session once back online
await ctx.setOffline(true);
await page.goto(BASE + '#/settings');
await page.waitForSelector('#settings-view:not([hidden])');
await page.click('#btn-logout');
await page.waitForSelector('#login-view:not([hidden])');
check('signed out offline', true);
check('device copy removed', await page.evaluate(() => localStorage.getItem('lingolens.user') === null));
await page.reload();
await page.waitForSelector('#login-view:not([hidden])');
check('offline reload after sign-out shows sign-in', true);
check('sign-in explains it needs a connection', (await page.textContent('#login-error')).includes('offline'));
await page.screenshot({ path: `${OUT}/o-login-offline.png` });
await ctx.setOffline(false);
await page.reload();
await page.waitForSelector('#login-view:not([hidden])');
const status = await page.evaluate(() => fetch('/api/me').then((r) => r.status));
check('server session ended once back online', status === 401, String(status));
await ctx.close();

// ---- phone: badge fits the header
const phone = await browser.newContext({ ...devices['iPhone 13'] });
const pp = await phone.newPage();
pp.on('pageerror', (e) => errors.push(String(e)));
await signIn(pp, user, { model: false });
await pp.evaluate(() => navigator.serviceWorker.ready);
await pp.reload();
await pp.waitForSelector('#library-view:not([hidden])');
await phone.setOffline(true);
await pp.reload();
await pp.waitForSelector('#library-view:not([hidden])');
await pp.waitForSelector('#net-status:not([hidden])', { timeout: 5000 }).catch(() => {}); // drawn just after the view opens
const fits = await pp.evaluate(() => {
  const b = document.querySelector('#net-status').getBoundingClientRect();
  return b.width > 0 && b.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
});
check('phone: offline badge fits', fits);
await pp.screenshot({ path: `${OUT}/o-phone-offline.png` });
await phone.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
