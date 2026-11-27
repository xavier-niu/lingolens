// The sidebar on wide screens, in place of the header: the name, the shelf,
// the latest Ask AI conversations, statistics (of the open text or the shelf:
// progress, AI tokens spent, questions asked), the status and the account
// (which holds Settings). Narrowed, it's a strip of icons, as it is below
// 1440px while Ask AI is open. The text's own tools float at the top right.
import { chromium, devices } from 'playwright';
import { BASE, freshUser, signIn, checker, glossesSettled, settled } from './helpers.mjs';

const OUT = process.argv[2];
const { check } = checker();
const browser = await chromium.launch();
const errors = [];
const user = await freshUser(browser);

const para = (i) => `Paragraph ${i}. By and large, extraordinary results take time, and a number of careful readers make sense of difficult passages slowly.`;
const md = ['# Field Notes', '', ...Array.from({ length: 6 }, (_, s) => [`## Section ${s + 1}`, '', ...Array.from({ length: 5 }, (_, i) => [para(s * 5 + i + 1), '']).flat()]).flat()].join('\n');

const add = (page, title, content, format = 'text') => page.evaluate(([title, content, format]) => fetch('/api/books', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content, format }),
}).then((r) => r.json()), [title, content, format]);

const layout = (page) => page.evaluate(() => {
  const shown = (s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0; };
  const rail = document.querySelector('#rail')?.getBoundingClientRect();
  const col = document.querySelector('#reader-view:not([hidden]), #library-view:not([hidden]), #settings-view:not([hidden])')?.getBoundingClientRect();
  return {
    rail: shown('#rail'), mode: document.querySelector('#rail')?.dataset.mode || '', railRight: rail?.right ?? 0, railHeight: rail?.height ?? 0,
    header: shown('header.topbar'), toggle: shown('#btn-rail'),
    colLeft: col?.left ?? 0, colTop: col?.top ?? 0, margin: parseFloat(getComputedStyle(document.querySelector('main')).marginLeft),
    vw: document.documentElement.clientWidth, vh: window.innerHeight, scrollW: document.documentElement.scrollWidth,
  };
});
const inRail = (page, sel) => page.evaluate((sel) => !!document.querySelector(sel)?.closest('#rail'), sel);

// ---- wide screen, on the shelf
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
await signIn(page, user);
const a = await add(page, 'Morning Briefing', Array.from({ length: 20 }, (_, i) => para(i + 1)).join('\n\n'));
const b = await add(page, 'Field Notes', md, 'markdown');
const c = await add(page, 'A Short Letter', para(1));
await page.reload();
await page.waitForSelector('#library-view:not([hidden]) .book');

let r = await layout(page);
check('shelf: the sidebar, full height, in place of the header', r.rail && r.mode === 'full' && !r.header && r.railHeight === r.vh, JSON.stringify(r));
check('shelf: the page makes room for it', r.margin === 256 && r.colLeft >= r.railRight + 16 && r.scrollW <= r.vw, JSON.stringify(r));
check('shelf: the name is in the sidebar, and goes to the shelf', await inRail(page, '#home-link') && (await page.getAttribute('#home-link', 'href')) === '#/');
check('shelf: the sidebar marks the shelf', (await page.getAttribute('#rail-shelf', 'aria-current')) === 'page');
check('shelf: the sidebar counts the texts', (await page.textContent('#rail-shelf')).trim().endsWith('3'), await page.textContent('#rail-shelf'));
check('shelf: statistics of the shelf', (await page.getAttribute('#rail-stats', 'data-scope')) === 'shelf' && (await page.textContent('#stat-texts')) === '3'
  && (await page.textContent('#stat-finished')) === '0' && (await page.textContent('#rail-tokens')) === '0', await page.textContent('#rail-stats'));
check('shelf: no recent texts any more', !(await page.$('#rail-recent')));
await page.waitForSelector('#rail-chats-empty');
check('shelf: no conversations yet, and how to have one', /Ask AI/.test(await page.textContent('#rail-chats-empty')));
check('the account is at the bottom of the sidebar', await inRail(page, '#btn-account')
  && await page.evaluate(() => document.querySelector('#btn-account').getBoundingClientRect().bottom > innerHeight - 24));
await page.click('#btn-account');
await settled(page, '#account-pop');
check('Settings is in the account menu, which opens upwards', await page.isVisible('#acct-settings')
  && await page.evaluate(() => document.querySelector('#account-pop').getBoundingClientRect().bottom <= document.querySelector('#btn-account').getBoundingClientRect().top));
await page.keyboard.press('Escape');
await page.screenshot({ path: `${OUT}/r-shelf.png` });

// A conversation from before shows up, newest first.
const saveChat = (id, bookId, selection, question) => page.evaluate(([id, bookId, selection, question]) => fetch(`/api/chats/${id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ bookId, selection, passage: selection, messages: [{ role: 'user', content: question }, { role: 'assistant', content: 'Because.' }] }),
}), [id, bookId, selection, question]);
await saveChat('railchat0001', a.id, 'extraordinary results take time', 'What does "by and large" mean?');
await page.reload();
await page.waitForSelector('#rail-chat-list button');
const first = await page.$eval('#rail-chat-list button', (x) => x.textContent);
check('shelf: a conversation, by its question and its text', first.includes('What does "by and large" mean?') && first.includes('Morning Briefing'), first);
check('shelf: one question asked in all', (await page.textContent('#stat-questions')) === '1');

// ---- the shelf as a list
const cardOrder = await page.$$eval('#shelf .book-link', (as) => as.map((x) => x.getAttribute('href')));
await page.click('#shelf-view [data-view="list"]');
await page.waitForSelector('#shelf-list');
const list = await page.evaluate(() => ({
  cols: [...document.querySelectorAll('#shelf-list th')].map((th) => th.textContent).filter(Boolean),
  rows: [...document.querySelectorAll('#shelf-list .book-row .book-link')].map((a) => a.getAttribute('href')),
  cells: [...document.querySelectorAll('#shelf-list .book-row')[0].querySelectorAll('td')].map((td) => td.textContent),
  cards: !!document.querySelector('#shelf'),
}));
check('list: a row a text, in the shelf\'s order, instead of cards', list.rows.join() === cardOrder.join() && !list.cards, JSON.stringify(list));
check('list: title, words, progress, time left, last read, updated, AI tokens',
  list.cols.join() === 'Title,Words,Progress,Time left,Last read,Updated,AI tokens,Delete', list.cols.join());
check('list: a fresh text reads 0%, not read yet', list.cells.includes('0%') && list.cells.includes('Not yet'), list.cells.join('|'));
await page.screenshot({ path: `${OUT}/r-shelf-list.png` });
await page.reload();
await page.waitForSelector('#library-view:not([hidden])');
check('list: this device remembers', !!(await page.waitForSelector('#shelf-list', { timeout: 3000 }).catch(() => null)));
await page.click('#shelf-view [data-view="grid"]');
await page.waitForSelector('#shelf .book-link');
check('grid again', !(await page.$('#shelf-list')));

// ---- open a text
await page.goto(BASE + '#/read/' + b.id);
await page.waitForSelector('#reader-view:not([hidden])');
check('reader: the shelf is no longer marked', (await page.getAttribute('#rail-shelf', 'aria-current')) === null);
await page.waitForSelector('#rail-chats-empty');
check('reader: only this text\'s conversations (none yet)', !(await page.$('#rail-chat-list button')) && /this text/.test(await page.textContent('#rail-chats-empty')));
check('reader: statistics of this text', (await page.getAttribute('#rail-stats', 'data-scope')) === 'text' && (await page.textContent('#rail-stats-title')) === 'This text'
  && (await page.textContent('#stat-words')) === '608' && (await page.textContent('#stat-progress')) === '0%', await page.textContent('#rail-stats'));
await glossesSettled(page);
await page.waitForFunction(() => +document.querySelector('#rail-tokens')?.dataset.total > 0, null, { timeout: 8000 }).catch(() => {});
const stored = async (id) => page.evaluate((id) => fetch('/api/books').then((r) => r.json()).then((bs) => bs.find((x) => x.id === id)), id);
let sb = await stored(b.id);
let shown = +await page.getAttribute('#rail-tokens', 'data-total');
check('reader: glossing the text spends tokens on it', sb.tokensIn > 0 && sb.tokensOut > 0, JSON.stringify(sb));
check('reader: the sidebar shows them', shown === sb.tokensIn + sb.tokensOut, `${shown} vs ${sb.tokensIn}+${sb.tokensOut}`);
check('reader: …split into read and written in its tooltip', /\d.* in · \d.* out/.test(await page.getAttribute('#rail-tokens', 'title')), await page.getAttribute('#rail-tokens', 'title'));
check('reader: the other texts spent nothing', !(await stored(a.id)).tokensIn && !(await stored(c.id)).tokensIn);

// A word looked up costs more, and the count follows.
await page.locator('#article ruby.ann').first().click();
await page.waitForSelector('#card:not([hidden])');
await page.click('#card [data-act="detail"]');
await page.waitForFunction((n) => +document.querySelector('#rail-tokens').dataset.total > n, shown, { timeout: 5000 }).catch(() => {});
sb = await stored(b.id);
const after = +await page.getAttribute('#rail-tokens', 'data-total');
check('reader: a lookup adds to the count', after > shown && after === sb.tokensIn + sb.tokensOut, `${shown} -> ${after}, stored ${sb.tokensIn}+${sb.tokensOut}`);
await page.keyboard.press('Escape');

r = await layout(page);
check('reader: the text sits clear of the sidebar', r.colLeft >= r.railRight + 16 && r.scrollW <= r.vw, JSON.stringify(r));
check('reader: contents still float beside the text', await page.isVisible('#toc[data-mode="beside"]'));
check('reader: time left in minutes', /\d+ min/.test(await page.textContent('#stat-left')), await page.textContent('#stat-left'));
check('reader: no questions asked yet', (await page.textContent('#stat-questions')) === '0');

// Statistics at the foot, above the account.
const order = await page.evaluate(() => {
  const y = (s) => document.querySelector(s).getBoundingClientRect();
  return { chats: y('#rail-chats').top, stats: y('#rail-stats').top, statsEnd: y('#rail-stats').bottom, account: y('#btn-account').top };
});
check('reader: statistics at the foot, above the account', order.chats < order.stats && order.statsEnd <= order.account, JSON.stringify(order));

// The text's tools float at the top right, over the contents.
const pill = await page.evaluate(() => {
  const p = document.querySelector('#reader-tools').getBoundingClientRect();
  return { ids: [...document.querySelectorAll('#reader-tools button')].map((x) => x.id).join(), top: p.top, right: p.right, bottom: p.bottom,
    toc: document.querySelector('#toc').getBoundingClientRect().top, vw: document.documentElement.clientWidth, inRail: !!document.querySelector('#rail #btn-edit') };
});
check('reader: Reading Options, Edit and Append float at the top right', pill.ids === 'btn-display,btn-edit,btn-append' && pill.top === 16 && pill.right === pill.vw - 16 && !pill.inRail, JSON.stringify(pill));
check('reader: the contents start below them', pill.toc >= pill.bottom + 8, JSON.stringify(pill));
await page.click('#btn-display');
await settled(page, '#display-pop');
check('reader: reading options open under their button', await page.evaluate(() => {
  const b = document.querySelector('#btn-display').getBoundingClientRect();
  const p = document.querySelector('#display-pop').getBoundingClientRect();
  return p.top >= b.bottom && p.right <= document.documentElement.clientWidth;
}));
await page.keyboard.press('Escape');
await page.click('#btn-edit');
await page.waitForSelector('#source-dialog[data-state="open"]');
check('reader: Edit opens the text', true);
await page.keyboard.press('Escape');
await page.waitForSelector('#source-dialog', { state: 'detached' }).catch(() => {});
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/r-reader.png` });

// Ask AI about this text: the conversation shows up first, as this text's.
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
r = await layout(page);
check('wide: with Ask AI open the sidebar stays full', r.mode === 'full' && r.margin === 256, JSON.stringify(r));
await page.waitForFunction(() => document.querySelectorAll('#rail-chat-list button').length === 1);
const top = await page.$eval('#rail-chat-list button', (x) => ({ text: x.textContent, current: x.getAttribute('aria-current') }));
check('reader: the new conversation shows, marked open', top.text.includes('1 question') && top.current === 'true', JSON.stringify(top));
check('reader: one question asked about this text', (await page.textContent('#stat-questions')) === '1');
await page.screenshot({ path: `${OUT}/r-reader-chat.png` });
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.body.classList.contains('chat-open'));

// Back on the shelf: every text's conversations, the latest first.
await page.click('#rail-shelf');
await page.waitForSelector('#library-view:not([hidden])');
await page.waitForFunction(() => document.querySelectorAll('#rail-chat-list button').length === 2);
const all = await page.$$eval('#rail-chat-list button', (bs) => bs.map((x) => x.dataset.id + ':' + x.textContent));
check('shelf: all conversations, the latest first', all[0].includes('Field Notes') && all[1].startsWith('railchat0001') && all[1].includes('Morning Briefing'), all.join(' | '));
await page.click('#rail-chat-list button[data-id="railchat0001"]');
const reopened = await page.waitForFunction(() => document.querySelector('#chat')?.textContent.includes('by and large')
  && document.querySelector('#rail-chat-list button[data-id="railchat0001"]')?.getAttribute('aria-current') === 'true', null, { timeout: 5000 }).then(() => true, () => false);
check('picking an older one opens it in Ask AI, and marks it', reopened && (await page.getAttribute('#chat', 'data-state')) === 'open');
await page.click('#btn-history');
await page.waitForSelector('#chat-history:not([hidden]) .hist-item');
check('"See all" opens the whole history', (await page.getAttribute('#btn-history', 'aria-pressed')) === 'true');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.body.classList.contains('chat-open'));

// ---- narrow it to icons; this device remembers
await page.goto(BASE + '#/read/' + b.id);
await page.waitForSelector('#reader-view:not([hidden])');
await page.click('#btn-rail');
r = await layout(page);
check('narrowed: a strip of icons, the text takes the room', r.mode === 'compact' && r.margin === 64 && !r.header && r.toggle, JSON.stringify(r));
const icons = await page.$$eval('#rail a, #rail button', (els) => els.filter((e) => e.getBoundingClientRect().width).map((e) => e.id));
check('narrowed: everything is still there', ['home-link', 'btn-rail', 'rail-shelf', 'btn-history', 'btn-account'].every((id) => icons.includes(id)) && await page.isVisible('#reader-tools'), icons.join());
check('narrowed: the toggle says it expands', (await page.getAttribute('#btn-rail', 'aria-label')) === 'Expand sidebar' && (await page.getAttribute('#btn-rail', 'aria-expanded')) === 'false');
await page.screenshot({ path: `${OUT}/r-compact.png` });
await page.click('#btn-account');
await settled(page, '#account-pop');
check('narrowed: the account menu opens to the right', await page.evaluate(() => document.querySelector('#account-pop').getBoundingClientRect().left >= document.querySelector('#rail').getBoundingClientRect().right));
await page.keyboard.press('Escape');
await page.reload();
await page.waitForSelector('#reader-view:not([hidden])');
check('narrowed: still narrow after a reload', (await layout(page)).mode === 'compact');
await page.click('#btn-rail');
check('expanded again', (await layout(page)).mode === 'full');

// ---- Settings: the sidebar beside its own list of sections
await page.goto(BASE + '#/settings');
await page.waitForSelector('#settings-view:not([hidden])');
r = await layout(page);
check('settings: the sidebar, no header', r.rail && !r.header && r.colLeft >= r.railRight, JSON.stringify(r));
check('settings: no Ask AI history there', !(await page.$('#rail-chats')));
await page.screenshot({ path: `${OUT}/r-settings.png` });
await ctx.close();

// ---- a laptop: the sidebar narrows for Ask AI
const lap = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const lp = await lap.newPage();
lp.on('pageerror', (e) => errors.push(String(e)));
await signIn(lp, user);
await lp.goto(BASE + '#/read/' + b.id);
await lp.waitForSelector('#toc');
await lp.waitForFunction(() => getComputedStyle(document.querySelector('#toc')).opacity === '1');
const g = await lp.evaluate(() => {
  const box = (s) => document.querySelector(s).getBoundingClientRect();
  const rail = box('#rail'), col = box('#reader-view'), toc = box('#toc');
  return { rail: rail.right, colLeft: col.left, colRight: col.right, colWidth: col.width, toc: toc.left, tocRight: toc.right, vw: document.documentElement.clientWidth };
});
check('laptop: contents float beside the text, which moves left for them', g.colWidth === 700 && g.colLeft >= g.rail + 16 && g.toc >= g.colRight + 40 && g.tocRight <= g.vw - 16, JSON.stringify(g));
await lp.screenshot({ path: `${OUT}/r-laptop-toc.png` });
await lp.click('#btn-history');
await lp.waitForSelector('#chat[data-state="open"]');
r = await layout(lp);
check('laptop: Ask AI open, the sidebar narrows, with no toggle', r.mode === 'compact' && r.margin === 64 && !r.toggle && !r.header, JSON.stringify(r));
const tl = await lp.evaluate(() => ({ tools: document.querySelector('#reader-tools').getBoundingClientRect().right, chat: document.querySelector('#chat').getBoundingClientRect().left }));
check('laptop: the text\'s tools move left of Ask AI', tl.tools <= tl.chat - 8, JSON.stringify(tl));
await lp.screenshot({ path: `${OUT}/r-laptop-chat.png` });
await lp.click('#btn-history');
await lp.waitForFunction(() => !document.body.classList.contains('chat-open'));
check('laptop: Ask AI closed, the sidebar is full again', (await layout(lp)).mode === 'full');
await lap.close();

// ---- narrower screens: the header; the sidebar hidden until slid in, and
// gone again once used
for (const [name, opts] of [
  ['narrow-desktop', { viewport: { width: 1000, height: 800 } }],
  ['tablet', { viewport: { width: 768, height: 1024 }, hasTouch: true }],
  ['phone', { ...devices['iPhone 13'] }],
]) {
  const nc = await browser.newContext(opts);
  const np = await nc.newPage();
  np.on('pageerror', (e) => errors.push(String(e)));
  await signIn(np, user);
  await np.goto(BASE + '#/read/' + b.id);
  await np.waitForSelector('#reader-view:not([hidden])');
  r = await layout(np);
  check(`${name}: no header, the sidebar hidden`, !r.rail && !r.header && r.margin === 0 && r.scrollW <= r.vw, JSON.stringify(r));
  check(`${name}: the text's tools float at the top right, as on a computer`, await np.isVisible('#reader-tools #btn-display') && await np.isVisible('#reader-tools #btn-append'));
  check(`${name}: the sidebar's button floats at the top left`, await np.isVisible('#float-start #btn-rail'));

  const slide = async () => { await np.click('#btn-rail'); await np.waitForSelector('#rail[data-mode="slid"]'); await settled(np, '#rail'); };
  await slide();
  r = await layout(np);
  const over = await np.evaluate(() => ({
    left: document.querySelector('#rail').getBoundingClientRect().left,
    width: document.querySelector('#rail').getBoundingClientRect().width,
    focus: document.activeElement?.id,
    parts: ['#rail-shelf', '#rail-chats', '#btn-history', '#rail-stats', '#btn-account'].every((s) => document.querySelector(`#rail ${s}`)),
  }));
  check(`${name}: over the page, which stays put`, r.rail && r.margin === 0 && over.left === 0 && over.width <= r.vw - 48 && await np.isVisible('#rail-backdrop'), JSON.stringify({ r, over }));
  check(`${name}: the same sidebar: shelf, Ask AI history, statistics, account`, over.parts && (await np.getAttribute('#rail-stats', 'data-scope')) === 'text');
  check(`${name}: focus moves into it`, over.focus === 'rail-close', over.focus);
  await np.screenshot({ path: `${OUT}/r-slid-${name}.png` });
  await np.mouse.click(r.vw - 12, r.vh / 2);
  await np.waitForSelector('#rail', { state: 'detached' });
  check(`${name}: a press outside puts it away`, !(await np.$('#rail-backdrop')));
  await slide();
  await np.keyboard.press('Escape');
  await np.waitForSelector('#rail', { state: 'detached' });
  check(`${name}: so does Escape, back to its button`, await np.evaluate(() => document.activeElement?.id) === 'btn-rail');
  await slide();
  await np.click('#rail-shelf');
  await np.waitForSelector('#library-view:not([hidden])');
  check(`${name}: going somewhere puts it away`, !(await np.$('#rail')));
  await nc.close();
}

// ---- in Chinese
const zc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const zp = await zc.newPage();
zp.on('pageerror', (e) => errors.push(String(e)));
await signIn(zp, user);
await zp.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'zh' }) }));
await zp.goto(BASE + '#/read/' + b.id);
await zp.reload();
await zp.waitForSelector('#reader-view:not([hidden])');
await zp.waitForFunction(() => +document.querySelector('#rail-tokens')?.dataset.total > 0);
check('zh: sidebar in Chinese', (await zp.textContent('#rail-chats-title')) === '问答记录' && (await zp.textContent('#rail-stats-title')) === '这篇文本'
  && (await zp.getAttribute('#btn-edit', 'aria-label')) === '编辑原文', await zp.textContent('#rail-stats'));
await zp.waitForFunction(() => getComputedStyle(document.querySelector('#toc')).opacity === '1');
check('zh: contents beside the text too', await zp.isVisible('#toc[data-mode="beside"]'));
await zp.screenshot({ path: `${OUT}/r-reader-zh.png` });
await zp.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'en' }) }));
await zc.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
