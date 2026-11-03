// Shelf + reader flow, plus screenshots for design review.
import { chromium, devices } from 'playwright';
import { BASE, freshUser, signIn, checker } from './helpers.mjs';
const OUT = process.argv[2];
const { check } = checker();
const LONG = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}. The extraordinary committee deliberated extensively, and by and large reached unanimous conclusions about infrastructure.`).join('\n\n');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); });

// Empty shelf (a fresh account)
await signIn(page, await freshUser(browser));
check('empty shelf shown', await page.isVisible('#shelf-empty'));
check('english by default', (await page.textContent('#shelf-empty h2')) === 'Your Shelf Is Empty');
await page.screenshot({ path: `${OUT}/d-empty.png` });

// Sample via empty state -> reader
await page.click('#btn-sample-empty');
await page.waitForSelector('ruby.ann rt');
check('sample opens in reader', (await page.textContent('#book-title')) === 'Why Small Habits Matter');
check('reader stat shows read time', /min read/.test(await page.textContent('#book-stat')), await page.textContent('#book-stat'));
check('plain text renders 4 paragraphs', (await page.$$('#article p')).length === 4);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/d-reader.png` });

// Click a plain word -> lookup card
const pt = await page.evaluate(() => {
  const w = document.createTreeWalker(document.querySelector('#article'), NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const n = w.currentNode; const i = n.data.indexOf('dinner');
    if (i >= 0 && !n.parentElement.closest('ruby')) {
      const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 4);
      const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
  }
});
await page.mouse.click(pt.x, pt.y);
await page.waitForSelector('#card:not([hidden]) .detail h4');
check('lookup card for un-annotated word', (await page.textContent('#card .lemma')) === 'dinner');
await page.screenshot({ path: `${OUT}/d-card.png` });
await page.keyboard.press('Escape');

// Select a paragraph -> Ask AI
await page.evaluate(() => {
  const p = document.querySelectorAll('#article p')[1];
  const r = document.createRange(); r.selectNodeContents(p);
  getSelection().removeAllRanges(); getSelection().addRange(r);
});
const pb = await page.$eval('#article p:nth-of-type(2)', (p) => { const b = p.getBoundingClientRect(); return { x: b.left + 30, y: b.top + 10 }; });
await page.mouse.move(pb.x, pb.y); await page.mouse.up();
await page.waitForSelector('#ask-fab:not([hidden])');
await page.click('#ask-fab');
await page.click('#chat-chips .chip');
await page.waitForFunction(() => document.querySelector('.msg.assistant:not(.pending)'));
check('chat answer streamed', (await page.textContent('.msg.assistant')).length > 10);
await page.screenshot({ path: `${OUT}/d-chat.png` });
await page.click('#chat-close');

// Scroll to the end -> finished
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(700);
check('progress thread full at end', (await page.$eval('#read-thread > div', (d) => d.style.width)) === '100%');
check('reader says finished', (await page.textContent('#book-stat')) === 'Finished');

// Add a long text through the dialog
await page.click('#home-link');
await page.waitForSelector('#shelf .book');
check('shelf marks the finished text', await page.isVisible('.book-stat.done'));
await page.click('#btn-add');
check('dialog offers Text, Web Page and EPUB', (await page.$$eval('#src-kinds input', (xs) => xs.map((x) => x.value).join())) === 'text,url,epub');
check('Text selected by default', await page.$eval('input[value="text"]', (i) => i.checked));
await page.click('#src-save');
check('empty text is rejected', (await page.textContent('#src-error')).includes('Paste'));
await page.fill('#src-title', 'The Committee Report on Infrastructure Planning in Coastal Cities');
await page.fill('#src-text', LONG);
await page.screenshot({ path: `${OUT}/d-dialog.png` });
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden]) ruby.ann');
check('added text opens in reader', (await page.textContent('#book-title')).startsWith('The Committee'));
await page.waitForTimeout(600);
const lazyBefore = await page.$$eval('#article p', (ps) => ps.filter((p) => p.querySelector('ruby.ann')).length);
check('lazy: only nearby paragraphs annotated', lazyBefore > 0 && lazyBefore < 60, `${lazyBefore}/60`);
// read about half
await page.evaluate(() => { const a = document.querySelector('#article'); window.scrollTo(0, a.offsetTop + a.offsetHeight * 0.4); });
await page.waitForTimeout(800);
await page.click('#home-link');
await page.waitForSelector('.book-stat:has-text("% read")');
const stats = await page.$$eval('.book-stat', (s) => s.map((x) => x.textContent));
check('in-progress book shows % and time left', stats.some((s) => /% read, \d+ min left/.test(s)), stats.join(' | '));

// A third, unread book so the shelf has variety
await page.click('#btn-add');
await page.fill('#src-text', 'A Letter to My Younger Self\n\nDear you, slow down. The things that feel urgent now will rarely matter in a year.');
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
await page.goto(BASE + '#/');
await page.waitForSelector('#shelf .book');
check('title derived from first line', (await page.$$eval('.cover-title', (s) => s.map((x) => x.textContent))).includes('A Letter to My Younger Self'));
check('shelf summary', /3 texts, about \d+ min/.test(await page.textContent('#shelf-summary')), await page.textContent('#shelf-summary'));
await page.mouse.move(5, 5);
await page.screenshot({ path: `${OUT}/d-shelf.png` });

// Resume position: reopen the long book
await page.click('.book-link:has-text("The Committee")');
await page.waitForTimeout(600);
check('reopening resumes near last position', await page.evaluate(() => window.scrollY > 600), String(await page.evaluate(() => window.scrollY)));
await page.click('#home-link');

// Header: quick level switch in the reader
await page.click('.book-link:has-text("Why Small")');
await page.waitForSelector('#btn-level:visible');
await page.click('#btn-level');
await page.waitForSelector('#level-pop:popover-open');
const anchored = await page.evaluate(() => {
  const b = document.querySelector('#btn-level').getBoundingClientRect();
  const p = document.querySelector('#level-pop').getBoundingClientRect();
  return Math.abs(p.right - b.right) < 2 && p.top >= b.bottom;
});
check('level popover opens under its chip', anchored);
await page.screenshot({ path: `${OUT}/d-level-pop.png` });
await page.click('#level-list [data-level="C1"]');
await page.waitForTimeout(300);
check('reader level chip switches level', (await page.textContent('#lv-code')) === 'C1');
await page.evaluate(() => window.scrollTo(0, 400));
await page.waitForTimeout(300);
check('book title shown in the header breadcrumb', (await page.textContent('#crumbs [aria-current="page"]')) === 'Why Small Habits Matter');
await page.screenshot({ path: `${OUT}/d-reader-bar.png` });
await page.click('#btn-display');
await page.click('#size-seg [data-size="l"]');
check('text size option applies', await page.evaluate(() => getComputedStyle(document.querySelector('#article')).fontSize) === '23px');
const articleWidth = () => page.evaluate(() => Math.round(document.querySelector('#article').getBoundingClientRect().width));
check('standard line width by default', await articleWidth() === 820, String(await articleWidth()));
check('standard width marked', (await page.getAttribute('#width-seg [data-width="m"]', 'aria-pressed')) === 'true');
await page.screenshot({ path: `${OUT}/d-display-pop.png` });
await page.click('#width-seg [data-width="w"]');
check('wide line width applies', await articleWidth() === 1040, String(await articleWidth()));
await page.click('#width-seg [data-width="n"]');
check('narrow line width applies', await articleWidth() === 680, String(await articleWidth()));
await page.waitForTimeout(600);
check('line width saved to the account', await page.evaluate(() => fetch('/api/me').then((r) => r.json()).then((m) => m.user.prefs.readWidth)) === 'n');
await page.reload();
await page.waitForSelector('#reader-view:not([hidden])');
check('line width kept after reload', await articleWidth() === 680, String(await articleWidth()));
await page.click('#btn-display');
await page.click('#width-seg [data-width="m"]');
await page.keyboard.press('Escape');

// Settings page: profile reflects the level; back returns to the book
await page.click('#btn-menu');
await page.click('#btn-settings');
await page.waitForSelector('#settings-view:not([hidden])');
check('profile shows the level chosen in the reader', await page.$eval('#profile-levels [aria-checked="true"]', (b) => b.dataset.level) === 'C1');
await page.click('#profile-levels [data-level="B1"]');
await page.waitForTimeout(300);
check('profile level saved to the account', await page.evaluate(() => fetch('/api/me').then((r) => r.json()).then((m) => m.user.prefs.level)) === 'B1');
await page.screenshot({ path: `${OUT}/d-settings.png`, fullPage: true });
check('settings breadcrumb: Shelf / book / Settings', (await page.$$eval('#crumbs .crumb', (els) => els.map((e) => e.textContent))).join(' / ') === 'Shelf / Why Small Habits Matter / Settings');
await page.click('#crumbs a[href^="#/read/"]');
await page.waitForSelector('#reader-view:not([hidden])');
check('settings back returns to the book', (await page.textContent('#book-title')) === 'Why Small Habits Matter');
await page.click('#home-link');
await page.waitForSelector('#library-view:not([hidden])');

// Language (now in the profile) + dark mode
await page.click('#btn-gear');
await page.click('#lang-seg [data-lang="zh"]');
check('settings page in Chinese', (await page.textContent('.page-title')) === '设置');
await page.screenshot({ path: `${OUT}/d-settings-zh.png` });
await page.click('#home-link');
check('chinese shelf title', (await page.textContent('.shelf-head h1')) === '我的书架');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/d-shelf-dark-zh.png` });
await page.click('#btn-gear');
await page.click('#lang-seg [data-lang="en"]');
await page.click('#home-link');
await page.emulateMedia({ colorScheme: 'light' });

// Delete a book
page.once('dialog', (d) => d.accept());
const before = (await page.$$('.book')).length;
await page.hover('.book >> nth=0');
await page.click('.book >> nth=0 >> .book-del');
await page.waitForTimeout(200);
check('delete removes a book', (await page.$$('.book')).length === before - 1);

// Phone
const phone = await browser.newContext({ ...devices['iPhone 13'] });
const pp = await phone.newPage();
await signIn(pp, await freshUser(browser));
await pp.evaluate(async () => {
  const add = async (title, content, progress) => {
    const b = await fetch('/api/books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }) }).then((r) => r.json());
    if (progress) await fetch(`/api/books/${b.id}/progress`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pos: progress, progress }) });
  };
  const text = 'Most people take for granted that big goals require big changes. '.repeat(30);
  await add('Why Small Habits Matter', text, 0);
  await add('On the Shortness of Life', text, 0.45);
  await add('Notes from a Small Island', text, 1);
});
await pp.reload();
await pp.waitForSelector('.book');
const ov = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('phone shelf no overflow', ov <= 0, `${ov}px`);
await pp.screenshot({ path: `${OUT}/p-shelf.png` });
const hdrOv = await pp.$eval('.topbar', (h) => h.scrollWidth - h.clientWidth);
check('phone shelf header fits', hdrOv <= 0, `${hdrOv}px`);
await pp.click('.book-link >> nth=0');
await pp.waitForSelector('#btn-level:visible');
const rdOv = await pp.$eval('.topbar', (h) => h.scrollWidth - h.clientWidth);
check('phone reader header fits', rdOv <= 0, `${rdOv}px`);
await pp.screenshot({ path: `${OUT}/p-reader.png` });
await pp.goto(BASE + '#/settings');
await pp.waitForSelector('#settings-view:not([hidden])');
await pp.screenshot({ path: `${OUT}/p-settings.png`, fullPage: true });

check('no console/page errors', errors.length === 0, errors.join(' | '));
await browser.close();
