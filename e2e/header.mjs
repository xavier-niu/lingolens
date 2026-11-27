// Header layout with a long title at several widths, and the one-time reading hint.
import { chromium, devices } from 'playwright';
import { BASE, freshUser, signIn, checker } from './helpers.mjs';

const OUT = process.argv[2];
const { check } = checker();
const browser = await chromium.launch();
const errors = [];
const user = await freshUser(browser);

const LONG = 'The Remarkable and Somewhat Lengthy History of How Ordinary People Learned to Read Faster';
const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog, and then it takes a long nap in the warm afternoon sun.`).join('\n\n');

async function makeBook(page) {
  return page.evaluate(([title, content]) => fetch('/api/books', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }),
  }).then((r) => r.json()), [LONG, body]);
}


let bookId;
for (const [name, opts] of [
  ['phone', { ...devices['iPhone 13'] }],
  ['small-phone', { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true }],
  ['tablet', { ...devices['iPad Mini'] }],
  ['narrow-desktop', { viewport: { width: 1000, height: 800 } }],
  // Wider screens keep the sidebar beside the page (rail.mjs).
]) {
  for (const lang of ['en', 'zh']) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await signIn(page, user);
    if (!bookId) bookId = (await makeBook(page)).id;
    await page.evaluate((l) => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }), lang);
    await page.goto(BASE + '#/read/' + bookId);
    await page.reload();
    await page.waitForSelector('#reader-view:not([hidden])');
    await page.waitForTimeout(300);
    // No header: the sidebar's button floats at the top left, the text's tools
    // at the top right, with the title clear below them.
    const r = await page.evaluate(() => {
      const box = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b?.width ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null; };
      const look = (s) => {
        const c = getComputedStyle(document.querySelector(s));
        return [c.width, c.height, c.color, c.backgroundColor, c.borderRadius, c.borderTopWidth].join();
      };
      return {
        start: box('#float-start'), tools: box('#reader-tools'), title: box('#book-title'),
        startIds: [...document.querySelectorAll('#float-start button')].filter((e) => e.getBoundingClientRect().width).map((e) => e.id).join(),
        toolIds: [...document.querySelectorAll('#reader-tools button')].map((e) => e.id).join(),
        looks: ['#btn-rail', '#btn-display', '#btn-edit', '#btn-append'].map(look),
        header: !!document.querySelector('header.topbar'),
        vw: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth,
      };
    });
    const inside = (x) => x && x.left >= 0 && x.right <= r.vw + 0.5 && x.top >= 0;
    check(`${name}/${lang}: no header`, !r.header);
    check(`${name}/${lang}: the sidebar's button at the top left, the text's tools at the top right`,
      inside(r.start) && inside(r.tools) && r.start.left <= 16 && r.vw - r.tools.right <= 16 && Math.abs(r.start.top - r.tools.top) < 1 && r.start.right < r.tools.left && r.scrollW <= r.vw, JSON.stringify(r));
    check(`${name}/${lang}: Reading Options, Edit, Append and Read Later`, r.startIds === 'btn-rail' && r.toolIds === 'btn-display,btn-edit,btn-append,btn-later', `${r.startIds} | ${r.toolIds}`);
    check(`${name}/${lang}: all the same kind of button`, new Set(r.looks).size === 1, r.looks.join(' | '));
    check(`${name}/${lang}: the title clear below them`, r.title.top >= Math.max(r.start.bottom, r.tools.bottom) + 8, JSON.stringify(r));
    check(`${name}/${lang}: interface language applied`, (await page.getAttribute('html', 'lang'))?.startsWith(lang));
    await page.screenshot({ path: `${OUT}/h-${name}-${lang}.png`, clip: { x: 0, y: 0, width: r.vw, height: 140 } });
    // Reading on, they step aside; scrolling back brings them back. (Each move
    // waits for the next frame, which is when the page hears of it.)
    const scrollBy = (dy) => page.evaluate((dy) => new Promise((done) => {
      window.scrollBy(0, dy);
      requestAnimationFrame(() => requestAnimationFrame(done));
    }), dy);
    await scrollBy(600);
    await scrollBy(300);
    const gone = await page.waitForFunction(() => document.querySelector('#reader-tools[data-away]') && document.querySelector('#float-start[data-away]'), null, { timeout: 2000 }).then(() => true, () => false);
    check(`${name}/${lang}: they step aside while reading on`, gone);
    await scrollBy(-200);
    const back = await page.waitForFunction(() => !document.querySelector('#reader-tools[data-away], #float-start[data-away]'), null, { timeout: 2000 }).then(() => true, () => false);
    check(`${name}/${lang}: and come back on scrolling back`, back);
    await page.evaluate((l) => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }), 'en');
    await ctx.close();
  }
}

// ---- the annotating badge: fits beside the title at any width
for (const [name, opts] of [
  ['phone', { ...devices['iPhone 13'] }],
  ['small-phone', { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true }],
  ['tablet', { ...devices['iPad Mini'] }],
  ['desktop', { viewport: { width: 1440, height: 900 } }],
]) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await signIn(page, user);
  await page.route('**/api/annotate', () => {}); // never answered: the text keeps waiting
  await page.goto(BASE + '#/read/' + bookId);
  await page.waitForSelector('#progress:not([hidden])');
  const r = await page.evaluate(() => {
    const box = (el) => { const b = el?.getBoundingClientRect(); return b?.width ? { left: b.left, right: b.right } : null; };
    return {
      badge: box(document.querySelector('#progress')),
      words: box(document.querySelector('#progress-text')),
      vw: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth,
    };
  });
  const phone = opts.viewport.width < 1024; // the status floats at the top left, as a spinner
  check(`${name}: annotating badge inside the screen`, r.badge.left >= 0 && r.badge.right <= r.vw && r.scrollW <= r.vw, JSON.stringify(r));
  // On a wide screen it's a line at the foot of the sidebar, under the name.
  check(`${name}: annotating ${phone ? 'beside the sidebar\'s button' : 'at the foot of the sidebar'}`, await page.evaluate((phone) => !!document.querySelector('#progress').closest(phone ? '#float-start' : '#rail'), phone), JSON.stringify(r));
  check(`${name}: ${phone ? 'just the spinner' : 'the badge has words'}`, phone ? r.words.right - r.words.left <= 1 : r.words.right - r.words.left > 40, JSON.stringify(r));
  await page.screenshot({ path: `${OUT}/h-annotating-${name}.png`, clip: { x: 0, y: 0, width: r.vw, height: 70 } });
  await ctx.close();
}

// ---- the one-time hint
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
await signIn(page, user, { hint: true });
check('no tip text at the end of the article', (await page.goto(BASE + '#/read/' + bookId), await page.$('.reader-tip')) === null);
await page.waitForSelector('#hint:not([hidden])', { timeout: 4000 });
check('hint appears on first visit', true);
check('hint uses touch wording on phones', (await page.textContent('#hint')).includes('Tap any word'));
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/h-hint-phone.png` });
const zh = await browser.newContext({ ...devices['iPhone SE'] });
const zp = await zh.newPage();
await signIn(zp, user, { hint: true });
await zp.evaluate((l) => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }), 'zh');
await zp.goto(BASE + '#/read/' + bookId);
await zp.reload();
await zp.waitForSelector('#hint:not([hidden])', { timeout: 4000 });
await zp.waitForTimeout(500);
check('hint in Chinese', (await zp.textContent('#hint')).includes('轻点任意单词'));
await zp.screenshot({ path: `${OUT}/h-hint-phone-zh.png` });
await zp.evaluate((l) => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }), 'en');
await zh.close();
await page.click('#hint-ok');
await page.waitForSelector('#hint', { state: 'hidden' });
check('Got It dismisses the hint', true);
await page.reload();
await page.waitForSelector('#reader-view:not([hidden])');
await page.waitForTimeout(1800);
check('hint stays dismissed after reload', await page.isHidden('#hint'));
await ctx.close();

const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const p2 = await ctx2.newPage();
await signIn(p2, user, { hint: true });
await p2.goto(BASE + '#/read/' + bookId);
await p2.waitForSelector('#hint:not([hidden])', { timeout: 4000 });
check('desktop wording says click', (await p2.textContent('#hint')).includes('Click any word'));
await p2.waitForTimeout(500);
await p2.screenshot({ path: `${OUT}/h-hint-desktop.png` });
await p2.locator('#article p').first().click({ position: { x: 30, y: 12 } });
await p2.waitForSelector('#card:not([hidden])');
await p2.waitForSelector('#hint', { state: 'hidden' });
check('looking up a word retires the hint', await p2.evaluate(() => localStorage.getItem('lingolens.hint.reader') === '1'));
await p2.goto(BASE + '#/');
await p2.goto(BASE + '#/read/' + bookId);
await p2.waitForTimeout(1800);
check('hint not shown again', await p2.isHidden('#hint'));
await ctx2.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
