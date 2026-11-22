// Shelf + reader flow, plus screenshots for design review.
import { chromium, devices } from 'playwright';
import { BASE, freshUser, signIn, checker, accept, settled } from './helpers.mjs';
const OUT = process.argv[2];
const { check } = checker();
const LONG = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}. The extraordinary committee deliberated extensively, and by and large reached unanimous conclusions about infrastructure.`).join('\n\n');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.clock.install(); // time runs as usual, and reading tests can skip ahead
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); });

// Empty shelf (a fresh account)
const reader = await freshUser(browser);
await signIn(page, reader);
check('empty shelf shown', await page.isVisible('#shelf-empty'));
check('header avatar shows the initial', (await page.textContent('#avatar')) === 'R');
await page.click('#btn-account');
await page.waitForSelector('#account-pop[data-state="open"]');
check('account menu shows who is signed in', (await page.textContent('#acct-pop-name')) === reader.email);
await page.screenshot({ path: `${OUT}/d-account.png` });
await page.keyboard.press('Escape');
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
let lookups = 0;
page.on('request', (r) => { if (r.url().endsWith('/api/lookup')) lookups++; });
await page.mouse.click(pt.x, pt.y);
await page.waitForSelector('#card:not([hidden]) [data-act="detail"]');
check('card for un-annotated word', (await page.textContent('#card .lemma')) === 'dinner');
check('the card offers to look the word up', (await page.textContent('#card [data-act="detail"]')) === 'Look Up');
await page.waitForTimeout(300);
check('clicking a word asks the model nothing', lookups === 0 && !(await page.$('#card .detail')), String(lookups));
check('the card still offers Ask AI', await page.isVisible('#card [data-act="ask"]'));
await page.screenshot({ path: `${OUT}/d-card-new.png` });
await page.click('#card [data-act="detail"]');
await page.waitForSelector('#card:not([hidden]) .detail h4');
check('Look Up fills the card', (await page.textContent('#card .zh')).length > 0);
check('Look Up asks the model once', lookups === 1, String(lookups));
check('…and the button is gone', !(await page.$('#card [data-act="detail"]')));
// Its gloss goes into the text only when asked for.
const dinnerGlosses = () => page.$$eval('#article ruby.ann', (rs) => rs.filter((r) => r.firstChild?.textContent === 'dinner').map((r) => r.querySelector('rt')?.textContent || ''));
check('looking a word up leaves the text as it is', (await dinnerGlosses()).every((g) => g === ''));
check('the card offers to add the gloss', (await page.textContent('#card [data-act="gloss"]')) === 'Add Gloss');
await page.screenshot({ path: `${OUT}/d-card.png` });
await page.keyboard.press('Escape');
check('closed without adding: plain text again', (await dinnerGlosses()).length === 0);
await page.mouse.click(pt.x, pt.y);
await page.waitForSelector('#card:not([hidden]) [data-act="gloss"]');
check('a word looked up before shows at no cost', lookups === 1 && !!(await page.$('#card .detail h4')), String(lookups));
await page.click('#card [data-act="gloss"]');
check('Add Gloss puts the gloss above the word', (await dinnerGlosses())[0]?.length > 0);
check('…and offers to take it away again', (await page.textContent('#card [data-act="gloss"]')) === 'Remove Gloss');
await page.screenshot({ path: `${OUT}/d-card-glossed.png` });
await page.keyboard.press('Escape');
check('an added gloss stays', (await dinnerGlosses())[0]?.length > 0);
// "I Know This": the word's gloss goes (Settings can bring it back, below).
const dinner = await page.$$eval('#article ruby.ann', (rs) => {
  const b = rs.find((r) => r.firstChild?.textContent === 'dinner').getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.bottom - 8 };
});
await page.mouse.click(dinner.x, dinner.y);
await page.click('#card [data-act="known"]');
check('"I Know This" hides the word\'s gloss', await page.$$eval('#article ruby.ann', (rs) => rs.filter((r) => r.firstChild?.textContent === 'dinner')
  .every((r) => r.classList.contains('known') && getComputedStyle(r.querySelector('rt')).display === 'none')));

// A double-click opens a word's card and selects the word too. The card has
// Ask AI, so the Ask AI button for selections stays away.
const askShown = () => page.isVisible('#ask-fab');
const selected = () => page.evaluate(() => !getSelection().isCollapsed);
// The first word on screen without a gloss, and where to click it.
const plainWord = () => page.evaluate(() => {
  const w = document.createTreeWalker(document.querySelector('#article'), NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const n = w.currentNode; const m = /[A-Za-z]{5,}/.exec(n.data);
    if (m && !n.parentElement.closest('ruby, a, code')) {
      const r = document.createRange(); r.setStart(n, m.index + 1); r.setEnd(n, m.index + m[0].length - 1);
      const b = r.getBoundingClientRect(); const x = b.left + b.width / 2; const y = b.top + b.height / 2;
      if (b.top > 60 && b.bottom < innerHeight && document.elementFromPoint(x, y) === n.parentElement) return { word: m[0], x, y };
    }
  }
});
const plain = await plainWord();
await page.mouse.dblclick(plain.x, plain.y);
await page.waitForSelector('#card:not([hidden]) [data-act="ask"]');
await page.waitForTimeout(150);
check('double-clicking a word shows its card, without the Ask AI button',
  (await page.textContent('#card .lemma')) === plain.word && await selected() && !(await askShown()));
await page.keyboard.press('Escape');
const dinnerNow = await page.$$eval('#article ruby.ann', (rs) => {
  const b = rs.find((r) => r.firstChild?.textContent === 'dinner').getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.bottom - 8 };
});
await page.mouse.dblclick(dinnerNow.x, dinnerNow.y);
await page.waitForSelector('#card:not([hidden])');
await page.waitForTimeout(150);
check('…and a glossed word too', (await page.textContent('#card .lemma')) === 'dinner' && await selected() && !(await askShown()));
// Selecting more than the word: the selection is what to ask about.
await page.evaluate(() => {
  const r = document.createRange(); r.selectNodeContents(document.querySelectorAll('#article p')[1]);
  getSelection().removeAllRanges(); getSelection().addRange(r);
});
const free = await page.evaluate(() => {
  const b = document.querySelectorAll('#article p')[1].getBoundingClientRect();
  for (let y = b.top + 4; y < b.bottom; y += 8) {
    for (const x of [b.left + 20, b.right - 20]) if (!document.elementFromPoint(x, y)?.closest('#card')) return { x, y };
  }
});
await page.mouse.move(free.x, free.y); await page.mouse.up();
await page.waitForSelector('#ask-fab:not([hidden])');
check('selecting more than the word closes its card for the Ask AI button', !(await page.$('#card')));
await page.evaluate(() => getSelection().removeAllRanges());

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
check('chat starts with the suggestions under the quote', await page.$eval('#chat-chips', (c) => c.classList.contains('start') && c.parentElement.id === 'chat-log' && c.children.length === 4));
check('send is disabled while the input is empty', await page.$eval('#chat-send', (b) => b.disabled));
await page.click('#chat-chips .chip');
await page.waitForSelector('.msg.assistant .thinking, .msg.assistant .caret', { state: 'attached' });
check('answer shows progress while it streams', true);
await page.waitForFunction(() => document.querySelector('.msg.assistant:not(.pending)'));
check('chat answer streamed', (await page.textContent('.msg.assistant')).length > 10);
check('answer is rendered as Markdown', await page.$$eval('.msg.assistant h3, .msg.assistant li', (els) => els.length >= 3));
check('no caret or thinking left after the answer', !(await page.$('.msg.assistant .caret, .msg.assistant .thinking')));
check('finished answer can be copied', await page.isVisible('.turn .msg-act'));
check('suggestions move above the input, without the one asked', await page.$eval('#chat-chips', (c) => c.classList.contains('follow') && c.parentElement.id === 'chat-dock' && c.children.length === 3));
await page.screenshot({ path: `${OUT}/d-chat.png` });
await page.fill('#chat-input', 'Why "put off"?');
await page.keyboard.press('Enter');
await page.waitForSelector('#chat-send.busy');
await page.click('#chat-send'); // stop
await page.waitForFunction(() => !document.querySelector('#chat-send.busy'));
check('stopping ends the answer', !(await page.$('.msg.assistant.pending')) && (await page.$$('.turn')).length === 2);
await page.click('#chat-close');

// Ask AI history: saved after each answer, reopened, continued
const savedChats = () => page.evaluate(() => fetch('/api/chats').then((r) => r.json()));
await page.waitForFunction(() => fetch('/api/chats').then((r) => r.json()).then((l) => l.length === 1));
check('conversation saved to the account', (await savedChats())[0].question === 'Translate this sentence');
await page.click('#btn-history');
await page.waitForSelector('#chat-history:not([hidden]) .hist-item');
await page.waitForSelector('#hist-scope:not([hidden])');
check('history opens from the header, on this text', await page.isVisible('#hist-scope') && (await page.textContent('.hist-quote')).length > 20);
await page.screenshot({ path: `${OUT}/d-chat-history.png` });
await page.click('.hist-open');
await page.waitForSelector('#chat-log:not([hidden]) #chat-turns .turn');
check('reopened conversation shows its answers', (await page.$$('#chat-turns .msg.assistant')).length >= 1 && await page.isVisible('#chat-dock'));
const asked = (await savedChats())[0].questions;
await page.fill('#chat-input', 'One more example, please.');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('#chat-turns .turn:last-child .msg-actions'));
await page.waitForFunction((n) => fetch('/api/chats').then((r) => r.json()).then((l) => l.length === 1 && l[0].questions === n + 1), asked);
check('asking more continues the same conversation', true);
// Hiding the sidebar doesn't stop an answer: it goes on, and says when it's done.
await page.fill('#chat-input', 'And a harder one?');
await page.keyboard.press('Enter');
await page.waitForSelector('#chat-send.busy');
await page.click('#chat-close');
await page.waitForSelector('#chat', { state: 'hidden' });
check('closing the sidebar leaves the answer going', await page.isVisible('#btn-history.live'));
await page.click('#btn-history');
await page.waitForSelector('.hist-live');
check('history shows it being answered', (await page.textContent('.hist-item:first-child .hist-live')) === 'Answering…');
await page.waitForTimeout(350); // the sidebar slides in
await page.screenshot({ path: `${OUT}/d-chat-answering.png` });
await page.click('#chat-close');
await page.waitForSelector('#toast:not([hidden])', { timeout: 15000 });
check('says when it has answered', (await page.textContent('#toast-text')) === 'Ask AI has answered.' && !(await page.isVisible('#btn-history.live')));
check('…with the Ask AI icon', (await page.isVisible('#toast .toast-icon.spark')) && !(await page.isVisible('#toast [data-icon="update"]')));
await page.waitForTimeout(350);
await page.screenshot({ path: `${OUT}/d-chat-answered.png` });
await page.click('#toast-action');
await page.waitForSelector('#chat:not([hidden])');
check('Show brings back the conversation with the whole answer', (await page.$$('#chat-turns .turn')).length === asked + 2
  && !(await page.$('.msg.assistant.pending')) && await page.isVisible('#chat-turns .turn:last-child .msg-actions'));
await page.waitForFunction((n) => fetch('/api/chats').then((r) => r.json()).then((l) => l.length === 1 && l[0].questions === n + 2), asked);
check('…and it was saved', true);
await page.click('#chat-close');
// Asking about the same selection again offers the earlier conversation.
await page.evaluate(() => {
  const p = document.querySelectorAll('#article p')[1];
  const r = document.createRange(); r.selectNodeContents(p);
  getSelection().removeAllRanges(); getSelection().addRange(r);
});
await page.mouse.move(pb.x, pb.y); await page.mouse.up();
await page.waitForSelector('#ask-fab:not([hidden])');
await page.click('#ask-fab');
await page.waitForSelector('#chat-resume:not([hidden])');
check('same selection offers to continue', (await page.textContent('#chat-resume')).includes('Continue'));
await page.click('#chat-resume');
await page.waitForSelector('#chat-turns .turn');
check('continue reopens that conversation', (await page.$$('#chat-turns .turn')).length === asked + 2);
await page.click('#chat-hist-btn');
await page.waitForSelector('.hist-item');
await page.mouse.click(300, 400); // outside the sidebar
await page.waitForSelector('#chat', { state: 'hidden' });
check('clicking outside closes the sidebar', true);
await page.click('#btn-history');
await page.waitForSelector('.hist-item');
await page.hover('.hist-item');
await page.click('.hist-del');
check('deleting a conversation asks first', await accept(page));
await page.waitForSelector('#hist-status:not(:empty)');
check('conversation deleted from history', (await savedChats()).length === 0);
await page.click('#chat-close');

// Time spent at the end reads the text to its end.
const threadWidth = () => page.$eval('#read-thread > div', (d) => parseInt(d.style.width, 10) || 0);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.clock.runFor(90_000);
check('progress thread full after reading to the end', (await threadWidth()) === 100, `${await threadWidth()}%`);
check('reader says finished', (await page.textContent('#book-stat')) === 'Finished');

// Back on the shelf
await page.click('#home-link');
await page.waitForSelector('#shelf .book');
check('shelf marks the finished text', await page.isVisible('.book-stat.done'));
await page.click('#btn-add');
// Add a long text through the dialog
check('dialog offers Text, Web Page and Book or PDF', (await page.$$eval('#src-kinds input', (xs) => xs.map((x) => x.value).join())) === 'text,url,file');
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
check('lazy: only nearby paragraphs annotated', lazyBefore > 0 && lazyBefore < 60, `${lazyBefore}/120`);
const longBook = page.url();
const savedLong = () => page.evaluate(async (id) => (await (await fetch(`/api/books/${id}`)).json()), longBook.split('/').pop());
const backToLong = async () => {
  await page.click('#home-link');
  await page.waitForSelector('#shelf .book');
  await page.goto(longBook);
  await page.waitForSelector('#reader-view:not([hidden]) ruby.ann');
  await page.waitForTimeout(200);
};
// Waits for the page to settle. Glosses landing for the paragraphs now on screen shift the
// text and fire more scroll events, which count as a reader still scrolling, and the clock
// can skip seconds ahead before they arrive.
const scrollToShare = (share) => page.evaluate((share) => new Promise((done) => {
  const a = document.querySelector('#article');
  let quiet;
  const finish = () => { window.removeEventListener('scroll', wait); changes.disconnect(); done(); };
  const wait = () => { clearTimeout(quiet); quiet = setTimeout(finish, 800); };
  const changes = new MutationObserver(wait);
  changes.observe(a, { childList: true, subtree: true });
  window.addEventListener('scroll', wait, { passive: true });
  wait();
  window.scrollTo(0, a.offsetTop + a.offsetHeight * share);
}), share);

// A quick look at the end: it doesn't count as reading, and the place to come
// back to stays.
await scrollToShare(1);
await page.waitForTimeout(500);
check('a jump to the end doesn’t fill the progress thread', (await threadWidth()) < 20, `${await threadWidth()}%`);
check('a jump to the end doesn’t finish the text', (await page.textContent('#book-stat')) !== 'Finished', await page.textContent('#book-stat'));
await backToLong();
check('a quick look at the end keeps the place', (await page.evaluate(() => window.scrollY)) < 200, String(await page.evaluate(() => window.scrollY)));
const afterLook = await savedLong();
check('a quick look at the end barely counts', afterLook.progress < 0.3, String(afterLook.progress));

// Stay somewhere, and that becomes the place to come back to.
await scrollToShare(0.4);
await page.clock.runFor(30_000);
const beforeLeaving = await threadWidth();
await backToLong();
const placeBack = await page.evaluate(() => { const a = document.querySelector('#article'); return (window.scrollY - a.offsetTop) / a.offsetHeight; });
check('staying somewhere moves the place there', Math.abs(placeBack - 0.4) < 0.05, String(placeBack));
check('progress follows the time spent, not the position', beforeLeaving > 0 && beforeLeaving < 40, `${beforeLeaving}%`);

// A text left open stops counting after a while.
const idleBefore = await threadWidth();
await scrollToShare(1);
await page.clock.runFor(150_000);
const idleSoon = await threadWidth();
await page.clock.runFor(600_000);
check('a text left open stops counting', idleSoon > idleBefore && idleSoon < 100 && (await threadWidth()) === idleSoon, `${idleBefore}% → ${idleSoon}% → ${await threadWidth()}%`);
// Going back over what's been read moves the place at once (checked on reopening below).
await scrollToShare(0.3);
await page.mouse.move(600, 500);
await page.waitForTimeout(100);

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

// Reading options: what this device shows, kept in this browser. The level
// and the defaults are in Settings.
const accountPrefs = () => page.evaluate(() => fetch('/api/me').then((r) => r.json()).then((m) => m.user.prefs));
const onDevice = () => page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.startsWith('lingolens.reading.'));
  return key ? JSON.parse(localStorage.getItem(key)) : {};
});
await page.click('.book-link:has-text("Why Small")');
await page.waitForSelector('#btn-display:visible');
await page.click('#btn-display');
await page.waitForSelector('#display-pop[data-state="open"]');
await settled(page, '#display-pop');
const anchored = await page.evaluate(() => {
  const b = document.querySelector('#btn-display').getBoundingClientRect();
  const p = document.querySelector('#display-pop').getBoundingClientRect();
  return Math.abs(p.right - b.right) < 2 && p.top >= b.bottom;
});
check('reading options open under their button', anchored);
check('reading options leave the level to Settings', !(await page.$('#display-pop [data-level]')));
check('reading options say they stay on this device', (await page.textContent('#display-pop .display-foot')).startsWith('Saved on this device only.'));
const popFits = await page.$eval('#display-pop', (p) => ({ sw: p.scrollWidth, cw: p.clientWidth, w: p.getBoundingClientRect().width,
  kids: [...p.children].map((c) => `${c.id || c.className}:${Math.round(c.getBoundingClientRect().right - p.getBoundingClientRect().right)}`).join(' ') }));
check('the note doesn\'t widen reading options', popFits.sw <= popFits.cw && popFits.w < 360, JSON.stringify(popFits));
await page.keyboard.press('Escape');
await page.waitForSelector('#display-pop', { state: 'detached' });
await page.evaluate(() => window.scrollTo(0, 400));
await page.waitForTimeout(300);
check('book title shown in the header breadcrumb', (await page.textContent('#crumbs [aria-current="page"]')) === 'Why Small Habits Matter');
await page.screenshot({ path: `${OUT}/d-reader-bar.png` });
await page.click('#btn-display');
await page.click('#size-seg [data-size="l"]');
check('text size option applies', await page.evaluate(() => getComputedStyle(document.querySelector('#article')).fontSize) === '23px');
await page.click('#size-seg [data-size="sm"]');
check('in-between text size applies', await page.evaluate(() => getComputedStyle(document.querySelector('#article')).fontSize) === '18.5px');
await page.setViewportSize({ width: 390, height: 844 });
const phoneSize = await page.evaluate(() => getComputedStyle(document.querySelector('#article')).fontSize);
check('a phone shows the same text size', phoneSize === '18.5px', phoneSize);
await page.setViewportSize({ width: 1280, height: 860 });
await page.waitForTimeout(600);
check('text size kept on this device, not sent to the account', (await accountPrefs()).readSize === 'm' && (await onDevice()).readSize === 'sm', JSON.stringify(await onDevice()));
await page.click('#size-seg [data-size="l"]');
const articleWidth = () => page.evaluate(() => Math.round(document.querySelector('#article').getBoundingClientRect().width));
check('standard line width by default', await articleWidth() === 820, String(await articleWidth()));
check('standard width marked', (await page.getAttribute('#width-seg [data-width="m"]', 'aria-pressed')) === 'true');
await page.screenshot({ path: `${OUT}/d-display-pop.png` });
await page.click('#width-seg [data-width="w"]');
check('wide line width applies', await articleWidth() === 1040, String(await articleWidth()));
await page.click('#width-seg [data-width="n"]');
check('narrow line width applies', await articleWidth() === 680, String(await articleWidth()));
await page.waitForTimeout(600);
check('line width kept on this device, not sent to the account', (await accountPrefs()).readWidth === 'm' && (await onDevice()).readWidth === 'n');
await page.reload();
await page.waitForSelector('#reader-view:not([hidden])');
check('line width kept after reload', await articleWidth() === 680, String(await articleWidth()));
await page.click('#btn-display');
await page.click('#width-seg [data-width="m"]');
check('choosing the default again follows the default', !('readWidth' in await onDevice()), JSON.stringify(await onDevice()));

// Fonts: English text and Chinese glosses, each chosen on its own.
const fonts = () => page.evaluate(() => ({
  read: getComputedStyle(document.querySelector('#article p')).fontFamily,
  gloss: getComputedStyle(document.querySelector('#article rt') || document.body).fontFamily,
  title: getComputedStyle(document.querySelector('#book-title')).fontFamily,
}));
check('Literata and 黑体 by default', (await fonts()).read.startsWith('Literata') && (await page.getAttribute('#font-seg [data-font="literata"]', 'aria-pressed')) === 'true' && (await page.getAttribute('#gloss-seg [data-gloss="sans"]', 'aria-pressed')) === 'true');
await page.click('#font-seg [data-font="legible"]');
await page.click('#gloss-seg [data-gloss="kai"]');
const chosen = await fonts();
check('reading font applies to the text and title', chosen.read.startsWith('"Atkinson Hyperlegible Next"') && chosen.title === chosen.read, JSON.stringify(chosen));
check('gloss font applies', chosen.gloss.includes('Kai'), chosen.gloss);
check('the chosen font loads', await page.evaluate(() => document.fonts.ready.then(() => document.fonts.check('16px "Atkinson Hyperlegible Next"'))));
await page.screenshot({ path: `${OUT}/d-display-fonts.png` });
await page.waitForTimeout(600);
const accountFonts = await accountPrefs();
check('fonts kept on this device, not sent to the account', `${accountFonts.readFont}/${accountFonts.glossFont}` === 'literata/sans' && JSON.stringify(await onDevice()) === '{"readSize":"l","readFont":"legible","glossFont":"kai"}', JSON.stringify(await onDevice()));
await page.reload();
await page.waitForSelector('#reader-view:not([hidden])');
check('fonts kept after reload', (await fonts()).read.startsWith('"Atkinson Hyperlegible Next"'));
await page.click('#btn-display');
await page.click('#font-seg [data-font="literata"]');
await page.click('#gloss-seg [data-gloss="sans"]');

// Glosses: the switches hide word or phrase glosses on this device.
const wordGlossShown = () => page.$eval('#article ruby.ann-word rt', (rt) => getComputedStyle(rt).display !== 'none');
check('word glosses shown by default', await wordGlossShown() && await page.isChecked('#show-words'));
await page.click('#display-pop label:has(#show-words)');
check('the switch hides word glosses', !(await wordGlossShown()));
await page.waitForTimeout(600);
check('…on this device only', (await accountPrefs()).hideWords === false && (await onDevice()).hideWords === true);
await page.keyboard.press('Escape');

// Settings: the level, and the reading defaults for every device.
await page.click('#btn-menu');
await page.click('#btn-settings');
await page.waitForSelector('#settings-view:not([hidden])');
check('Settings counts the words marked known', (await page.textContent('#known-count')).includes(': 1.'), await page.textContent('#known-count'));
await page.click('#known-clear');
check('…and can show their glosses again', await accept(page)
  && (await page.evaluate(() => fetch('/api/known').then((r) => r.json()))).length === 0 && await page.isDisabled('#known-clear'));
check('profile shows the level', await page.$eval('#profile-levels [aria-checked="true"]', (b) => b.dataset.level) === 'B1');
await page.click('#profile-levels [data-level="C1"]');
await page.waitForTimeout(300);
check('profile level saved to the account', (await accountPrefs()).level === 'C1');
await page.click('#profile-levels [data-level="B1"]');
check('Settings shows the defaults, not this device\'s choices', (await page.getAttribute('#def-size-seg [data-size="m"]', 'aria-pressed')) === 'true' && await page.isChecked('#def-words'));
check('Settings says what this device sets for itself', await page.isVisible('#reading-local')
  && (await page.textContent('#reading-local-text')) === 'This device has its own Reading Options for: Word glosses, Text size.', await page.textContent('#reading-local-text'));
await page.screenshot({ path: `${OUT}/d-settings.png`, fullPage: true });
await page.click('#def-size-seg [data-size="s"]');
await page.click('#def-font-seg [data-font="sans"]');
await page.click('#settings-view label:has(#def-phrases)');
await page.waitForTimeout(600);
const defaults = await accountPrefs();
check('defaults from Settings saved to the account', defaults.readSize === 's' && defaults.readFont === 'sans' && defaults.hidePhrases === true, JSON.stringify(defaults));
check('…and this device uses the one just chosen', !('readSize' in await onDevice()) && (await page.textContent('#reading-local-text')) === 'This device has its own Reading Options for: Word glosses.');
await page.click('#reading-reset');
check('"Use the defaults here" drops this device\'s choices', JSON.stringify(await onDevice()) === '{}' && !(await page.isVisible('#reading-local')));
check('settings breadcrumb: Shelf / book / Settings', (await page.$$eval('#crumbs .crumb', (els) => els.map((e) => e.textContent))).join(' / ') === 'Shelf / Why Small Habits Matter / Settings');
await page.click('#crumbs a[href^="#/read/"]');
await page.waitForSelector('#reader-view:not([hidden])');
check('settings back returns to the book', (await page.textContent('#book-title')) === 'Why Small Habits Matter');
const shown = await page.evaluate(() => {
  const a = document.querySelector('#article');
  return { size: getComputedStyle(a).fontSize, font: getComputedStyle(a).fontFamily, words: !a.classList.contains('hide-words'), phrases: !a.classList.contains('hide-phrases') };
});
check('the reader follows the defaults', shown.size === '17px' && !shown.font.startsWith('Literata') && shown.words && !shown.phrases, JSON.stringify(shown));
await page.click('#btn-display');
check('reading options show them', (await page.getAttribute('#size-seg [data-size="s"]', 'aria-pressed')) === 'true' && !(await page.isChecked('#show-phrases')));
await page.click('#display-defaults');
await page.waitForSelector('#settings-view:not([hidden])');
const atReading = await page.$eval('#set-reading-h', (h) => Math.round(h.closest('section').getBoundingClientRect().top));
check('"Change the defaults" opens Settings at Reading', atReading >= 0 && atReading < 120, String(atReading));
await page.click('#def-size-seg [data-size="m"]');
await page.click('#def-font-seg [data-font="literata"]');
await page.click('#settings-view label:has(#def-phrases)');
await page.waitForTimeout(600);
const restored = await accountPrefs();
check('defaults restored', restored.readSize === 'm' && restored.readFont === 'literata' && restored.hidePhrases === false, JSON.stringify(restored));
await page.click('#home-link');
await page.waitForSelector('#library-view:not([hidden])');

// Language (now in the profile) + dark mode
await page.click('#btn-account'); await page.click('#acct-settings');
await page.click('#lang-seg [data-lang="zh"]');
check('settings page in Chinese', (await page.textContent('.page-title')) === '设置');
await page.screenshot({ path: `${OUT}/d-settings-zh.png` });
await page.click('#home-link');
check('chinese shelf title', (await page.textContent('.shelf-head h1')) === '我的书架');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/d-shelf-dark-zh.png` });
await page.click('#btn-account'); await page.click('#acct-settings');
await page.click('#lang-seg [data-lang="en"]');
await page.click('#home-link');
await page.emulateMedia({ colorScheme: 'light' });

// Delete a book
const before = (await page.$$('.book')).length;
await page.hover('.book >> nth=0');
await page.click('.book >> nth=0 >> .book-del');
check('deleting a book asks first', await accept(page));
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
await pp.waitForSelector('#btn-display:visible');
const rdOv = await pp.$eval('.topbar', (h) => h.scrollWidth - h.clientWidth);
check('phone reader header fits', rdOv <= 0, `${rdOv}px`);
await pp.screenshot({ path: `${OUT}/p-reader.png` });
await pp.goto(BASE + '#/settings');
await pp.waitForSelector('#settings-view:not([hidden])');
const setOv = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('phone settings no overflow', setOv <= 0, `${setOv}px`);
await pp.screenshot({ path: `${OUT}/p-settings.png`, fullPage: true });

check('no console/page errors', errors.length === 0, errors.join(' | '));
await browser.close();
