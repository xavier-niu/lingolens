// Chat: talk about pasted text without adding it to the shelf. Chats are kept
// apart from Ask AI's conversations about texts being read.
import { chromium, devices } from 'playwright';
import { BASE, freshUser, signIn, checker } from './helpers.mjs';

const OUT = process.argv[2];
const { check } = checker();
const browser = await chromium.launch();
const errors = [];
const user = await freshUser(browser);
const GRAMMAR = 'Check the grammar and fix any mistakes';
const TEXT = 'Yesterday I go to the market and buyed three apple. They was very fresh.';

const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
await signIn(page, user);
const chats = () => page.evaluate(() => fetch('/api/chats').then((r) => r.json()));
const chipTexts = () => page.$$eval('#chat-chips .chip', (cs) => cs.map((c) => c.textContent.trim()));
const openChatPage = async () => {
  await page.click('#btn-chat');
  await page.waitForSelector('#chat:not([hidden])');
};

// ---- the way in: a labelled button in the top bar, unlike the icon buttons
const look = (sel) => page.$eval(sel, (el) => ({ bg: getComputedStyle(el).backgroundColor, text: el.textContent.trim() }));
const [btn, hist] = [await look('#btn-chat'), await look('#btn-history')];
check('Chat is in the top bar on the shelf', await page.isVisible('#btn-chat'));
check('…labelled, and set apart from the icon buttons', btn.text === 'Chat' && btn.bg !== hist.bg, JSON.stringify([btn, hist]));
await openChatPage();
check('it opens the Chat page', (await page.evaluate(() => location.hash)) === '#/chat' && (await page.getAttribute('#btn-chat', 'aria-current')) === 'page');
check('the page is called Chat, not Ask AI', (await page.textContent('#chat-title-text')) === 'Chat' && (await page.textContent('#crumbs [aria-current="page"]')) === 'Chat');
check('the box for the text has the focus', await page.evaluate(() => document.activeElement?.id === 'chat-text'));
check('nothing to ask about yet: no suggestions, no sending', await page.isHidden('#chat-chips') && await page.$eval('#chat-send', (b) => b.disabled));
check('a page, not a sidebar: no close button', await page.isHidden('#chat-close') && await page.isHidden('#btn-history'));
const panel = await page.$eval('#chat', (el) => el.getBoundingClientRect().toJSON());
check('the conversation fills the page under the top bar', panel.top >= 50 && panel.left > 100 && panel.width > 600, JSON.stringify(panel));

// ---- the text, from the clipboard
await page.evaluate((t) => navigator.clipboard.writeText(t), TEXT);
check('a Paste button, where the clipboard can be read', await page.isVisible('#chat-paste-btn'));
await page.click('#chat-paste-btn');
await page.waitForFunction((t) => document.querySelector('#chat-text').value === t, TEXT);
let chips = await chipTexts();
check('then the suggestions, grammar check first', await page.isVisible('#chat-chips') && chips[0] === GRAMMAR && chips.length === 5, chips.join(' | '));
await page.fill('#chat-input', 'x');
check('…and a question can be sent', await page.$eval('#chat-send', (b) => !b.disabled));
await page.fill('#chat-input', '');
await page.screenshot({ path: `${OUT}/c-paste.png` });

// ---- asking
await page.click('#chat-chips .chip >> nth=0');
await page.waitForSelector('#chat-turns .msg-actions');
check('the answer streams in', (await page.textContent('#chat-turns .msg.assistant')).length > 10);
check('the text is settled into a quote', await page.isHidden('#chat-paste') && (await page.textContent('#chat-quote')) === TEXT);
check('…under the label Text', (await page.textContent('#chat-context-label')) === 'Text');
await page.waitForFunction(() => fetch('/api/chats').then((r) => r.json()).then((l) => l.length === 1));
const [saved] = await chats();
check('kept in history, with no book', saved.bookId === '' && saved.selection === TEXT && saved.question === GRAMMAR, JSON.stringify(saved));
check('nothing added to the shelf', (await page.evaluate(() => fetch('/api/books').then((r) => r.json()))).length === 0);
await page.screenshot({ path: `${OUT}/c-answer.png` });

// ---- leaving and coming back
await page.click('#home-link');
await page.waitForSelector('#library-view:not([hidden])');
check('leaving the page hides it', await page.isHidden('#chat'));
await openChatPage();
check('coming back shows the same chat', (await page.textContent('#chat-quote')) === TEXT && (await page.$$('#chat-turns .turn')).length === 1);
await page.click('#chat-new');
check('New Chat starts again with an empty box', await page.isVisible('#chat-text') && (await page.inputValue('#chat-text')) === '' && (await page.$$('#chat-turns .turn')).length === 0);

// ---- history: the page lists Chats, and they can be continued
await page.reload();
await page.waitForSelector('#chat:not([hidden]) #chat-text');
check('reloading the page opens a new chat', (await page.inputValue('#chat-text')) === '');
await page.click('#chat-hist-btn');
await page.waitForSelector('#chat-history:not([hidden]) .hist-item');
check('the page lists its chats', (await page.$$('#hist-list .hist-item')).length === 1 && (await page.textContent('.hist-quote')) === TEXT);
await page.click('.hist-open');
await page.waitForSelector('#chat-log:not([hidden]) #chat-turns .msg.assistant');
await page.fill('#chat-input', 'Why is “buyed” wrong?');
await page.press('#chat-input', 'Enter');
await page.waitForFunction(() => fetch('/api/chats').then((r) => r.json()).then((l) => l.length === 1 && l[0].questions === 2));
check('a chat from history can be continued', true);
chips = await chipTexts();
check('…with the suggestions not yet asked', chips.length === 4 && !chips.includes(GRAMMAR), chips.join(' | '));

// ---- Ask AI keeps to conversations about texts
await page.click('#home-link');
await page.waitForSelector('#library-view:not([hidden])');
await page.click('#btn-history');
await page.waitForFunction(() => document.querySelector('#hist-status').textContent.length > 0);
check('Ask AI history leaves Chats out', (await page.$$('#hist-list .hist-item')).length === 0, await page.textContent('#hist-status'));
await page.keyboard.press('Escape');

// ---- too long for a chat
await openChatPage();
await page.click('#chat-new');
await page.fill('#chat-text', 'word '.repeat(1300));
check('a text too long says so', (await page.textContent('#chat-text-note')).startsWith('Too long: 6,499 of 6,000'), await page.textContent('#chat-text-note'));
await page.fill('#chat-input', 'Translate it');
check('…and can’t be asked about', await page.isHidden('#chat-chips') && await page.$eval('#chat-send', (b) => b.disabled));
await page.fill('#chat-text', TEXT);
check('shorter again, it can', await page.isVisible('#chat-chips') && await page.$eval('#chat-send', (b) => !b.disabled) && (await page.textContent('#chat-text-note')) === '');
await ctx.close();

// ---- on a phone, in both interface languages
for (const lang of ['en', 'zh']) {
  const pctx = await browser.newContext({ ...devices['iPhone 13'] });
  const pp = await pctx.newPage();
  pp.on('pageerror', (e) => errors.push(String(e)));
  await signIn(pp, user);
  await pp.evaluate((l) => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }), lang);
  await pp.reload();
  await pp.waitForSelector('#library-view:not([hidden])');
  const b = await pp.$eval('#btn-chat', (el) => el.getBoundingClientRect().toJSON());
  const name = lang === 'en' ? 'Chat' : '对话';
  check(`phone/${lang}: Chat is a round button that keeps its name`, b.width <= 40 && Math.abs(b.width - b.height) < 1 && await pp.getByRole('link', { name, exact: true }).isVisible(), JSON.stringify(b));
  await pp.click('#btn-chat');
  await pp.waitForSelector('#chat:not([hidden]) #chat-text');
  const r = await pp.evaluate(() => ({ panel: document.querySelector('#chat').getBoundingClientRect().toJSON(), vw: innerWidth, scrollW: document.documentElement.scrollWidth }));
  check(`phone/${lang}: the page spans the screen under the top bar`, r.panel.left === 0 && r.panel.width === r.vw && r.panel.top >= 50 && r.scrollW <= r.vw, JSON.stringify(r));
  check(`phone/${lang}: titled in the interface language`, (await pp.textContent('#chat-title-text')) === name);
  await pp.screenshot({ path: `${OUT}/c-phone-${lang}.png` });
  if (lang === 'zh') await pp.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'en' }) }));
  await pctx.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
