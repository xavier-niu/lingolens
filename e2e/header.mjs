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

const saveWords = (page, n) => page.evaluate((n) => Promise.all(Array.from({ length: n }, (_, i) => fetch(`/api/wordbook/word${i}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: `word${i}`, lemma: `word${i}`, zh: '词' }),
}))), n);

const overlap = (a, b) => a && b && a.right > b.left + 0.5 && b.right > a.left + 0.5;

let bookId;
for (const [name, opts] of [
  ['phone', { ...devices['iPhone 13'] }],
  ['small-phone', { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true }],
  ['tablet', { ...devices['iPad Mini'] }],
  ['narrow-desktop', { viewport: { width: 1000, height: 800 } }],
  ['desktop', { viewport: { width: 1440, height: 900 } }],
]) {
  for (const lang of ['en', 'zh']) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await signIn(page, user);
    if (!bookId) {
      bookId = (await makeBook(page)).id;
      await saveWords(page, 12); // the count widens the wordbook button
    }
    await page.evaluate((l) => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }), lang);
    await page.goto(BASE + '#/read/' + bookId);
    await page.reload();
    await page.waitForSelector('#reader-view:not([hidden])');
    await page.evaluate(() => window.scrollTo(0, 900));
    const narrow = opts.viewport?.width < 360;
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.width ? { left: b.left, right: b.right } : null; };
      const visible = [...document.querySelectorAll('.bar-end > *, .brand')].filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width);
      const title = document.querySelector('#crumbs [aria-current="page"]');
      const look = (s) => {
        const c = getComputedStyle(document.querySelector(s));
        return [c.width, c.height, c.color, c.backgroundColor, c.borderRadius, c.borderTopWidth, c.fontSize].join();
      };
      return {
        title: box(title), parts: visible.map((e) => ({ id: e.id || e.className, ...box(e) })),
        looks: ['#btn-display', '#btn-history'].map(look),
        vw: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth,
        truncated: title.scrollWidth > title.clientWidth,
      };
    });
    const hits = r.parts.filter((p) => overlap(r.title, p)).map((p) => p.id);
    check(`${name}/${lang}: title clear of header buttons`, hits.length === 0, hits.join(','));
    check(`${name}/${lang}: buttons inside the screen`, r.parts.every((p) => p.left >= 0 && p.right <= r.vw + 0.5) && r.scrollW <= r.vw, JSON.stringify(r.parts));
    const buttons = r.parts.map((p) => p.id).filter((id) => id.startsWith('btn-')).join();
    check(`${name}/${lang}: reading options sit next to History, with no level button`, /^btn-display,btn-history,btn-wordbook,btn-menu(,btn-account)?$/.test(buttons), buttons);
    check(`${name}/${lang}: reading options look like History`, new Set(r.looks).size === 1, r.looks.join(' | '));
    if (narrow) check(`${name}/${lang}: title hidden when there is no room`, r.title === null, JSON.stringify(r.title));
    else check(`${name}/${lang}: long title still readable`, r.title && r.title.right - r.title.left >= 100, JSON.stringify(r.title));
    check(`${name}/${lang}: interface language applied`, (await page.getAttribute('html', 'lang'))?.startsWith(lang));
    await page.screenshot({ path: `${OUT}/h-${name}-${lang}.png`, clip: { x: 0, y: 0, width: r.vw, height: 70 } });
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
      title: box(document.querySelector('#crumbs [aria-current="page"]')),
      badge: box(document.querySelector('#progress')),
      words: box(document.querySelector('#progress-text')),
      vw: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth,
    };
  });
  const phone = opts.viewport.width <= 640;
  check(`${name}: annotating badge inside the screen`, r.badge.left >= 0 && r.badge.right <= r.vw && r.scrollW <= r.vw, JSON.stringify(r));
  check(`${name}: annotating badge clear of the title`, !overlap(r.title, r.badge), JSON.stringify(r));
  check(`${name}: ${phone ? 'just the spinner' : 'the badge has words'}`, phone ? r.words.right - r.words.left <= 1 : r.words.right - r.words.left > 40, JSON.stringify(r));
  await page.screenshot({ path: `${OUT}/h-annotating-${name}.png`, clip: { x: 0, y: 0, width: r.vw, height: 70 } });
  await ctx.close();
}

// ---- the wordbook button: an icon like History, with its count beside it
for (const [name, opts] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone', devices['iPhone 13']]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await signIn(page, await freshUser(browser));
  const measure = () => page.evaluate(() => {
    const box = (s) => document.querySelector(s).getBoundingClientRect().toJSON();
    return { history: box('#btn-history'), button: box('#btn-wordbook'), icon: box('#btn-wordbook svg'), count: box('#wb-count') };
  });
  const sameSize = (m) => m.button.width === m.history.width && m.button.height === m.history.height;
  const clear = (m) => m.count.left >= m.icon.right && m.count.right <= m.button.right;

  // After a reload the page shows its saved copy first, then what the server has.
  const showCount = async (n) => {
    await saveWords(page, n);
    await page.reload();
    await page.waitForFunction((n) => document.querySelector('#wb-count').textContent === String(n), n);
    return measure();
  };

  let m = await measure();
  check(`${name}: wordbook button is the size of History`, sameSize(m), JSON.stringify(m));
  check(`${name}: wordbook button still has a name`, await page.getByRole('button', { name: 'Wordbook' }).isVisible());
  m = await showCount(1);
  check(`${name}: a single digit leaves the button's size alone`, sameSize(m), JSON.stringify(m));
  check(`${name}: a single digit covers nothing`, clear(m), JSON.stringify(m));
  m = await showCount(128);
  check(`${name}: a long count widens the button and stays in it`, m.button.width > m.history.width && clear(m), JSON.stringify(m));
  await page.screenshot({ path: `${OUT}/h-wordbook-${name}.png`, clip: { x: 0, y: 0, width: page.viewportSize().width, height: 70 } });
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
