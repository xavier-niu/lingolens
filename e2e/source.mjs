// Add Source (text with Markdown detection, web page, EPUB), Contents, and Agent Access.
// PDFs have their own suite (pdf.mjs).
import { chromium, devices } from 'playwright';
import { BASE, SITE, fixture, freshUser, signIn, checker, articleText, waitForArticleText, glossesSettled } from './helpers.mjs';

const OUT = process.argv[2];
const { check } = checker();
const browser = await chromium.launch();
const errors = [];
const user = await freshUser(browser);

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept());
await signIn(page, user);

const openDialog = async () => {
  await page.goto(BASE + '#/');
  await page.waitForSelector('#library-view:not([hidden])');
  await page.locator('#btn-add:visible, #btn-add-empty:visible').first().click();
  await page.waitForSelector('#source-dialog[open]');
};
const kinds = () => page.$$eval('#src-kinds input', (xs) => xs.map((x) => x.value));
const visible = (sel) => page.isVisible(sel);

// ---- the dialog
await openDialog();
check('empty shelf: sample text offered', await visible('#src-sample'));
await page.click('#src-sample');
check('…and it fills the form', (await page.inputValue('#src-text')).length > 200 && (await page.inputValue('#src-title')).length > 0);
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
await openDialog();
check('once a text is on the shelf: no sample', !(await visible('#src-sample')));
check('three kinds: Text, Web Page, Book or PDF', JSON.stringify(await kinds()) === '["text","url","file"]');
check('no Markdown option any more', !(await page.$('#src-kinds input[value="markdown"]')));
check('nothing disabled or "coming soon"', (await page.$$('#src-kinds input:disabled')).length === 0);
await page.fill('#src-text', 'Dear Sam,\n\nThanks for the letter. I hope you are well.');
check('plain text: no Markdown note', !(await visible('#src-md')));
const titleHint = () => page.getAttribute('#src-title', 'placeholder');
check('the title just says it’s optional', (await titleHint()) === 'Optional', await titleHint());
await page.fill('#src-text', 'Two reasons:\n1. It is cheap.\n2. It is fast.');
check('a few Markdown marks: plain text, with Markdown offered', await visible('#src-md')
  && (await page.textContent('#src-md-text')) === 'Saved as plain text, without formatting.' && (await page.textContent('#src-md-switch')) === 'Use Markdown');
await page.fill('#src-text', 'The test:\n1. It sends requests.\n2. It checks:\n   - they all succeed\n   - the kill came first');
check('a list in a list is Markdown', (await page.textContent('#src-md-text')).startsWith('Markdown detected'));
await page.fill('#src-text', '# Packing List\n\n- passport\n- **charger**\n\nRemember the [map](https://example.com).');
check('Markdown pasted: detected', await visible('#src-md'));
await page.screenshot({ path: `${OUT}/s-text-md.png` });
await page.fill('#src-text', 'https://example.com/some/article');
check('a pasted link offers to import the page', await visible('#src-link-hint'));
await page.click('#src-use-link');
check('…and switches to Web Page with the link', (await page.inputValue('#src-url')) === 'https://example.com/some/article' && await visible('#src-url'));
check('save button says Import Page', (await page.textContent('#src-save')) === 'Import Page');

// ---- Markdown text is saved as Markdown and rendered
await page.click('#src-kinds label:has(input[value="text"])');
await page.fill('#src-text', '# Packing List\n\n- passport\n- **charger**\n- a good book');
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
check('Markdown renders as a list', (await page.$$('#article ul li')).length === 3);
check('…with bold kept', !!(await page.$('#article strong')));
const format = () => page.evaluate(() => fetch('/api/books/' + location.hash.split('/').pop(), { cache: 'no-store' }).then((r) => r.json()).then((b) => b.format));
check('stored as markdown', (await format()) === 'markdown');

// ---- …unless the reader keeps it plain; Edit Text can switch it later
await openDialog();
await page.fill('#src-text', '**Packing List**\n\n- passport\n- *charger*');
check('a bold title alone is Markdown', await visible('#src-md') && (await page.textContent('#src-md-text')).startsWith('Markdown detected'));
check('…and the note offers plain text instead', (await page.textContent('#src-md-switch')) === 'Use plain text instead');
await page.click('#src-md-switch');
check('plain text picked: the note says so, and offers Markdown back',
  (await page.textContent('#src-md-text')).startsWith('Saved as plain text') && (await page.textContent('#src-md-switch')) === 'Use Markdown');
await page.click('#src-md-switch');
check('…which switches back', (await page.textContent('#src-md-text')).startsWith('Markdown detected'));
await page.click('#src-md-switch');
await page.fill('#src-text', '**Packing List**\n\n- passport\n- *charger*\n- a map');
check('the pick holds while typing', (await page.textContent('#src-md-switch')) === 'Use Markdown');
await page.screenshot({ path: `${OUT}/s-text-plain.png` });
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
await waitForArticleText(page, 'a map');
check('saved as plain text: the marks show as typed',
  (await format()) === 'text' && !(await page.$('#article ul, #article strong')) && (await articleText(page)).includes('**Packing List**'));
await page.click('#btn-menu');
await page.click('#btn-edit');
await page.waitForSelector('#source-dialog[open]');
check('Edit Text keeps it plain, and offers Markdown', await visible('#src-md') && (await page.textContent('#src-md-switch')) === 'Use Markdown');
await page.click('#src-md-switch');
await page.click('#src-save');
await page.waitForSelector('#article ul');
check('switched to Markdown in Edit Text: it renders', (await page.$$('#article ul li')).length === 3 && !!(await page.$('#article strong')) && (await format()) === 'markdown');

// ---- text copied from a terminal: lines wrapped at its width
await openDialog();
const WRAPPED = 'It is a truth universally acknowledged, that a single man in\n'
  + 'possession of a good fortune, must be in want of a wife. However\n'
  + 'little known the feelings or views of such a man may be on his\n'
  + 'first entering a neighbourhood, this truth is so well fixed.';
await page.fill('#src-text', `${WRAPPED}\n\n  - The control requests all succeeded, so the gateway path\n    is fine.\n  - Every target request succeeded.`);
check('wrapped, two list items are enough for Markdown', (await page.textContent('#src-md-text')).startsWith('Markdown detected'));
await page.fill('#src-text', `${WRAPPED}\n\nRoses are red,\nViolets are blue.`);
check('wrapped prose alone stays plain text', !(await visible('#src-md')));
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
await waitForArticleText(page, 'Violets');
const brs = await page.$$eval('#article p', (ps) => ps.map((p) => p.querySelectorAll('br').length));
check('…its wrapped lines flow on; short lines keep their breaks', brs.join() === '0,1', brs.join());

// ---- web page
await openDialog();
await page.click('#src-kinds label:has(input[value="url"])');
check('URL field focused', await page.evaluate(() => document.activeElement.id === 'src-url'));
check('…the title still just Optional', (await titleHint()) === 'Optional', await titleHint());
await page.fill('#src-url', SITE + 'missing.html');
await page.click('#src-save');
await page.waitForFunction(() => document.querySelector('#src-error').textContent.length > 0);
check('a broken link shows the site error', (await page.textContent('#src-error')).includes('404'));
check('dialog stays open after an error', await visible('#source-dialog'));
await page.fill('#src-url', SITE + 'article.html');
await page.screenshot({ path: `${OUT}/s-url.png` });
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
// The stored text: the reader's text gets glosses inside it as it's annotated.
const art = await page.evaluate(() => fetch('/api/books/' + location.hash.split('/').pop()).then((r) => r.json()).then((b) => b.content));
check('page title used', (await page.textContent('#book-title')).includes('The Art of Slow Travel'));
check('article text imported', art.includes('settle into one place') && art.includes('better stories'));
check('menus, ads and footer left out', !/Hot Deals|cheap flights|newsletter/.test(art));
check('section heading kept', !!(await page.$('#article h2')));

// ---- EPUB
await openDialog();
await page.click('#src-kinds label:has(input[value="file"])');
check('Import Book label', (await page.textContent('#src-save')) === 'Import Book');
check('…and the title Optional', (await titleHint()) === 'Optional', await titleHint());
await page.click('#src-save');
check('asks for a file first', (await page.textContent('#src-error')).includes('Choose an EPUB or PDF'));
await page.setInputFiles('#src-file', fixture('notes.txt'));
check('a file that is neither EPUB nor PDF is refused', (await page.textContent('#src-error')).includes('isn’t an EPUB or a PDF'));
await page.setInputFiles('#src-file', fixture('drm.epub'));
await page.click('#src-save');
await page.waitForFunction(() => document.querySelector('#src-error').textContent.includes('DRM'));
check('DRM book explained', true);
await page.setInputFiles('#src-file', fixture('book.epub'));
check('chosen file shown', (await page.textContent('#src-file-name')) === 'book.epub');
await page.screenshot({ path: `${OUT}/s-epub.png` });
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
check('book title from the EPUB', (await page.textContent('#book-title')) === 'The Harbour Stories');
check('all five chapters', (await page.$$('#article h2')).length === 5);

// ---- Contents
await page.click('#btn-menu');
check('Contents offered for a book with chapters', await visible('#btn-toc'));
await page.click('#btn-toc');
await page.waitForSelector('#toc-dialog[open]');
const items = await page.$$eval('#toc-list a', (as) => as.map((a) => a.textContent));
check('Contents lists the chapters', items.join('|') === 'Chapter One|Chapter Two|Chapter Three|Chapter Four|Chapter Five', items.join('|'));
await page.screenshot({ path: `${OUT}/s-toc.png` });
await page.click('#toc-list a >> nth=3');
await page.waitForTimeout(400);
const top = await page.$eval('#article h2 >> nth=3', (h) => h.getBoundingClientRect().top);
check('jumps to the chapter, below the header', top > 50 && top < 120, String(top));
check('route unchanged', (await page.evaluate(() => location.hash)).startsWith('#/read/'));
await page.click('#btn-menu');
await page.click('#btn-toc');
check('current chapter marked', (await page.textContent('#toc-list a[aria-current="true"]')) === 'Chapter Four');
await page.keyboard.press('Escape');

// ---- editing a Markdown import keeps it Markdown
await page.click('#btn-menu');
await page.click('#btn-edit');
await page.waitForSelector('#source-dialog[open]');
check('editing hides the kind switch', !(await visible('#src-kinds')));
check('editing an import keeps Markdown', await visible('#src-md'));
await page.keyboard.press('Escape');

// ---- appending: more at the end, after a dividing line; the reader keeps their place
{
  const OLD = Array.from({ length: 60 }, (_, i) => `Morning ${i + 1}. The harbour was quiet, and the boats rocked gently on the grey water.`).join('\n\n');
  const MORE = Array.from({ length: 30 }, (_, i) => `Noon ${i + 1}. The fishermen came back with their nets full of silver fish.`).join('\n\n');
  // Back at the middle of a text read to 90%: the screen is all read, so
  // progress holds still while the dialog is open.
  const book = await page.evaluate(async (content) => {
    const json = { 'Content-Type': 'application/json' };
    const b = await fetch('/api/books', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Harbour Mornings', content }) }).then((r) => r.json());
    await fetch(`/api/books/${b.id}/progress`, { method: 'PUT', headers: json, body: JSON.stringify({ pos: 0.5, progress: 0.9 }) });
    return b;
  }, OLD);
  const saved = () => page.evaluate((id) => fetch('/api/books/' + id, { cache: 'no-store' }).then((r) => r.json()), book.id);
  // The paragraph at the top of the screen, and where it sits.
  const atTop = () => page.evaluate(() => {
    const p = [...document.querySelectorAll('#article [data-seg]')].find((el) => el.getBoundingClientRect().bottom > 80);
    return { seg: p.dataset.seg, top: Math.round(p.getBoundingClientRect().top) };
  });
  await page.goto(BASE + '#/read/' + book.id);
  await waitForArticleText(page, 'Morning 60.');
  await page.waitForFunction(() => window.scrollY > 300);
  await glossesSettled(page);
  const place = await atTop();

  check('Append Text is a button in the bar, beside the ⋯ menu', await visible('#btn-append')
    && (await page.getAttribute('#btn-append', 'aria-label')) === 'Append Text' && (await page.$eval('#btn-append', (b) => b.nextElementSibling.id)) === 'btn-menu');
  await page.click('#btn-menu');
  const menuItems = await page.$$eval('#menu-pop .menu-item', (els) => els.filter((e) => e.checkVisibility()).map((e) => e.id));
  check('…and not in the menu as well', menuItems.join() === 'btn-edit,btn-settings', menuItems.join());
  await page.keyboard.press('Escape');
  await page.click('#btn-append');
  await page.waitForSelector('#source-dialog[open]');
  const dialog = () => page.evaluate(() => ({
    heading: document.querySelector('#source-heading').textContent,
    mode: document.querySelector('#src-modes input:checked')?.value,
    save: document.querySelector('#src-save').textContent,
    focus: document.activeElement?.id,
  }));
  let d = await dialog();
  check('it opens the text on Append', d.heading === 'Append Text' && d.mode === 'append' && d.save === 'Append', JSON.stringify(d));
  check('…with an empty box for the new text, in focus', await visible('#src-more') && !(await visible('#src-text')) && d.focus === 'src-more' && (await page.inputValue('#src-more')) === '');
  check('…with no note under it', !(await page.$('.src-panel[data-kind="append"] .src-note')));
  check('…and the title and kind switch as when editing', (await page.inputValue('#src-title')) === 'Harbour Mornings' && !(await visible('#src-kinds')));
  check('…and the text’s time to live: Never, with nothing added', (await page.$eval('#src-ttl', (s) => `${s.value}:${s.selectedOptions[0].textContent}:${s.options.length}`)) === '0:Never:6');
  await page.click('#src-save');
  check('nothing to add: says so', (await page.textContent('#src-error')) === 'Paste the text to add first.', await page.textContent('#src-error'));
  await page.click('#src-modes label:has(input[value="edit"])');
  d = await dialog();
  check('Edit shows the whole text again', d.heading === 'Edit Text' && d.save === 'Save Changes' && await visible('#src-text') && !(await visible('#src-more')) && (await page.inputValue('#src-text')) === OLD, JSON.stringify(d));
  await page.click('#src-modes label:has(input[value="append"])');
  await page.fill('#src-more', `\n${MORE}\n\n`);
  check('the count is of what’s added', (await page.textContent('#src-count')) === `${(MORE.length + 3).toLocaleString('en-US')} characters`, await page.textContent('#src-count'));
  await page.screenshot({ path: `${OUT}/s-append.png` });
  await page.click('#src-save');
  await page.waitForSelector('#toast:not([hidden])');

  const after = await saved();
  check('added at the end, after a --- line', after.content === `${OLD}\n\n---\n\n${MORE}`, JSON.stringify(after.content.slice(OLD.length - 20, OLD.length + 30)));
  check('…the same text, not a new one', (await page.evaluate(() => fetch('/api/books').then((r) => r.json()))).filter((b) => b.title === 'Harbour Mornings').length === 1);
  const share = OLD.length / after.content.length;
  check('the place and progress stay, as a share of the longer text',
    Math.abs(after.pos - 0.5 * share) < 0.001 && Math.abs(after.progress - 0.9 * share) < 0.001,
    `pos ${after.pos}, progress ${after.progress}, want ${0.5 * share} and ${0.9 * share}`);
  await glossesSettled(page);
  const placeAfter = await atTop();
  check('the reader stays where they were', placeAfter.seg === place.seg && Math.abs(placeAfter.top - place.top) < 30, `${JSON.stringify(placeAfter)} vs ${JSON.stringify(place)}`);
  const shown = await page.evaluate(() => ({ hrs: document.querySelectorAll('#article hr').length, last: [...document.querySelectorAll('#article p')].pop().textContent }));
  check('a plain text shows the line as a divider', shown.hrs === 1 && shown.last.startsWith('Noon 30.'), JSON.stringify(shown));
  check('a note says it was added', (await page.textContent('#toast-text')) === 'Added to the end of the text.');
  await page.click('#toast-action');
  // A smooth scroll that puts the dividing line just under the header.
  await page.waitForFunction(() => Math.abs(document.querySelector('#article hr').getBoundingClientRect().top - 80) < 4, null, { timeout: 3000 }).catch(() => {});
  const next = await page.$eval('#article hr', (hr) => ({ top: hr.getBoundingClientRect().top, text: hr.nextElementSibling.textContent }));
  check('Show goes to the new part', Math.abs(next.top - 80) < 20 && next.text.startsWith('Noon 1.'), JSON.stringify(next));
  await page.screenshot({ path: `${OUT}/s-appended.png` });

  // In Chinese, after a reload: the progress shown is what was kept
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'zh' }) }));
  await page.reload();
  await waitForArticleText(page, 'Noon 30.');
  const bar = await page.$eval('#read-thread > div', (d) => parseInt(d.style.width, 10));
  check('after a reload, the progress bar shows what was kept', bar >= Math.round(0.9 * share * 100) && bar < 100, `${bar}%`);
  check('zh: the bar button says 追加内容', (await page.getAttribute('#btn-append', 'aria-label')) === '追加内容' && (await page.getAttribute('#btn-append', 'title')) === '追加内容');
  await page.click('#btn-append');
  await page.waitForSelector('#source-dialog[open]');
  d = await dialog();
  check('zh: the dialog speaks Chinese', d.heading === '追加内容' && d.save === '追加' && (await page.textContent('#src-modes')).includes('编辑'), JSON.stringify(d));
  await page.fill('#src-more', '## Noon\n\nThe boats came back.');
  check('zh: Markdown to add: the note, with plain text offered', await visible('#src-md') && (await page.textContent('#src-md-switch')) === '改用纯文本', await page.textContent('#src-md'));
  check('zh: the title is 可选', (await titleHint()) === '可选', await titleHint());
  check('zh: 永不', (await page.$eval('#src-ttl', (s) => s.selectedOptions[0].textContent)) === '永不');
  await page.screenshot({ path: `${OUT}/s-append-zh.png` });
  await page.keyboard.press('Escape');
  await page.evaluate(() => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'en' }) }));
  await page.reload();
  await page.waitForSelector('#reader-view:not([hidden])');
}

// ---- a novel-sized book
await openDialog();
await page.click('#src-kinds label:has(input[value="file"])');
await page.setInputFiles('#src-file', fixture('big.epub'));
let t0 = Date.now();
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
await page.waitForSelector('#article h2');
const openMs = Date.now() - t0;
const words = await page.evaluate(() => fetch('/api/books').then((r) => r.json()).then((b) => b.find((x) => x.title === 'A Very Long Novel').words));
check('long book imported and opened', words > 150000, `${words} words in ${openMs} ms`);
check('…in reasonable time', openMs < 8000, `${openMs} ms`);
await page.click('#btn-menu');
await page.click('#btn-toc');
check('60 chapters in Contents', (await page.$$('#toc-list a')).length === 60);
await page.keyboard.press('Escape');

// ---- jumping to a chapter: its glosses come first, and the header says they're coming
{
  const jctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const p = await jctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await signIn(p, user);
  // A model that answers only when told to, so nothing here depends on timing.
  const held = [];
  const cancelled = new Set();
  p.on('requestfailed', (req) => cancelled.add(req));
  await p.route('**/api/annotate', (route) => {
    const segments = route.request().postDataJSON().segments;
    held.push({ route, ids: segments.map((s) => s.id), chars: segments.reduce((n, s) => n + s.text.length, 0) });
  });
  const answer = (calls) => Promise.all(calls.map((c) => c.route.continue().catch(() => {})));
  const until = async (ok) => {
    for (let i = 0; i < 100 && !ok(); i++) await p.waitForTimeout(50);
    return ok();
  };
  const jumpTo = async (n) => {
    await p.click('#btn-menu');
    await p.click('#btn-toc');
    await p.waitForSelector('#toc-dialog[open]');
    await p.click(`#toc-list a >> nth=${n}`);
  };
  const onScreen = () => p.$$eval('#article [data-seg]', (els) => els.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 56 && r.top < innerHeight;
  }).map((el) => el.dataset.seg));

  const big = await p.evaluate(() => fetch('/api/books').then((r) => r.json()).then((b) => b.find((x) => x.title === 'A Very Long Novel').id));
  await p.goto(BASE + `#/read/${big}`);
  await p.waitForSelector('#article h2');
  check('opening a book: two requests at most', await until(() => held.length === 2), String(held.length));
  await p.waitForSelector('#progress:not([hidden])');
  check('text on screen waiting: the header says so', true);

  const opening = held.splice(0);
  await p.$eval('#progress', (el) => {
    window.badgeChanges = 0;
    new MutationObserver(() => { window.badgeChanges++; }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });
  await jumpTo(29);
  check('a jump starts on the new screen at once', await until(() => held.length === 2), String(held.length));
  check('…cancelling the requests it left behind', opening.every((c) => cancelled.has(c.route.request())));
  const screen = await onScreen();
  const first = held.slice(0, 2);
  const asked = first.flatMap((c) => c.ids);
  check('…asking for what is on screen and nothing else', screen.every((id) => asked.includes(id)) && asked.every((id) => screen.includes(id)), `${asked} / ${screen}`);
  check('…in small batches', first.every((c) => c.chars <= 900 || c.ids.length === 1), first.map((c) => c.chars).join());
  check('the indicator stays up through the jump', (await p.evaluate(() => window.badgeChanges)) === 0);
  const badge = await p.locator('#progress').boundingBox();
  check('the indicator is on screen after the jump', badge && badge.y >= 0 && badge.y + badge.height <= 56, JSON.stringify(badge));
  check('…and counts what is on screen', (await p.textContent('#progress')).includes(`${screen.length} left`), await p.textContent('#progress'));

  await answer(first);
  await p.waitForSelector('#progress', { state: 'hidden' });
  await p.waitForSelector(`[data-seg="${screen[0]}"] ruby.ann, [data-seg="${screen[1]}"] ruby.ann`, { state: 'attached' });
  check('glosses arrive and the indicator goes', true);

  check('then the text around it', await until(() => held.length >= 3), String(held.length));
  await p.waitForTimeout(500); // longer than the indicator's delay
  check('annotating ahead of the reader stays quiet', await p.isHidden('#progress'));
  await p.$eval(`[data-seg="${held[2].ids[0]}"]`, (el) => el.scrollIntoView({ block: 'center' }));
  await p.waitForSelector('#progress:not([hidden])');
  check('reading into it brings the indicator back', true);

  const back = held.length;
  await jumpTo(0);
  check('back at the start: what was cancelled is asked for again', await until(() => held.slice(back).some((c) => c.ids.includes(opening[0].ids[0]))));
  check('no paragraph is marked as failed', (await p.$$('#article .seg-failed')).length === 0);
  await p.unroute('**/api/annotate');
  await answer(held.slice(back));
  await p.waitForSelector('#progress', { state: 'hidden' });
  const firstScreen = await onScreen();
  check('…and gets its glosses', await p.evaluate((ids) => ids.some((id) => document.querySelector(`[data-seg="${id}"] ruby.ann`)), firstScreen));
  await p.screenshot({ path: `${OUT}/s-jump.png` });
  await jctx.close();
}

// ---- Agent Access
await page.goto(BASE + '#/settings');
await page.waitForSelector('#settings-view:not([hidden])');
check('no tokens at first', await visible('#token-empty'));
await page.fill('#tk-name', 'Claude Code');
await page.click('#token-form button[type="submit"]');
await page.waitForSelector('#token-new:not([hidden])');
const env = await page.textContent('#tk-env');
check('new token shown once with setup lines', /export LINGOLENS_URL=http/.test(env) && /export LINGOLENS_TOKEN=llat_/.test(env));
check('token listed by name and hint only', (await page.textContent('#token-list')).includes('Claude Code') && !(await page.textContent('#token-list')).includes(env.split('=').pop()));
const token = env.match(/llat_\w+/)[0];
check('skills CLI command shown', (await page.textContent('#skill-cmd')) === 'npx skills add xavier-niu/lingolens');
check('skill download link', (await page.getAttribute('a[download][href="/skills/lingolens.zip"]', 'href')) === '/skills/lingolens.zip');
await page.screenshot({ path: `${OUT}/s-agent.png`, fullPage: true });
await page.locator('section.set-section:has(> .set-head #set-agent-h)').screenshot({ path: `${OUT}/s-agent-section.png` });

const up = await page.evaluate(async (tok) => {
  const r = await fetch('/api/agent/texts?title=From%20an%20Agent', {
    method: 'POST', credentials: 'omit',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'text/markdown' },
    body: '# Ignored heading\n\nA reply saved by an agent.',
  });
  return { status: r.status, body: await r.json() };
}, token);
check('agent upload with the token', up.status === 201 && up.body.title === 'From an Agent', JSON.stringify(up));
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
// The shelf shows this device's copy at once, then refreshes from the server.
await page.waitForFunction(() => document.querySelector('#shelf').textContent.includes('From an Agent'), null, { timeout: 5000 }).catch(() => {});
check('agent text on the shelf', (await page.textContent('#shelf')).includes('From an Agent'));

// Adding to it: the reader, which keeps a copy of the text, shows the new part after a rule.
await page.goto(BASE + '#/read/' + up.body.id);
await waitForArticleText(page, 'A reply saved by an agent', 30000);
const more = await page.evaluate(async (tok) => {
  const auth = { Authorization: `Bearer ${tok}` };
  const list = await fetch('/api/agent/texts', { credentials: 'omit', headers: auth }).then((r) => r.json());
  const r = await fetch(`/api/agent/texts/${list[0].id}/append`, {
    method: 'POST', credentials: 'omit', headers: { ...auth, 'Content-Type': 'text/markdown' },
    body: '## A Follow-up\n\nMore on the same topic.',
  });
  return { status: r.status, body: await r.json(), listed: list.map((b) => b.title) };
}, token);
check('agent lists its texts and adds to one', more.status === 200 && more.body.id === up.body.id && more.listed.join() === 'From an Agent', JSON.stringify(more));
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
await page.goto(BASE + '#/read/' + up.body.id);
const grown = await waitForArticleText(page, 'More on the same topic').then(() => true, () => false);
check('reader shows the added part', grown);
check('…after a separator line, under its own heading', await page.evaluate(() => {
  const hr = document.querySelector('#article hr');
  const h2 = [...document.querySelectorAll('#article h2')].find((h) => h.textContent.includes('A Follow-up'));
  return !!hr && !!h2 && !!(hr.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING);
}));
await page.screenshot({ path: `${OUT}/s-agent-append.png` });
// Added to while open: coming back to the tab shows it, in place.
await page.evaluate(async (tok) => {
  await fetch(`/api/agent/texts/${location.hash.split('/').pop()}/append`, {
    method: 'POST', credentials: 'omit', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'text/markdown' },
    body: 'A third part, added while the text was open.',
  });
  document.dispatchEvent(new Event('visibilitychange'));
}, token);
const live = await waitForArticleText(page, 'A third part').then(() => true, () => false);
check('added while open: shown on returning to the tab', live && (await page.$$eval('#article hr', (h) => h.length)) === 2);
const toastText = () => page.textContent('#toast-text');
check('…with a notice that offers to show the new part', (await page.isVisible('#toast')) && (await toastText()) === 'New content was added at the end.' && (await page.isVisible('#toast-action')), await toastText());
await page.screenshot({ path: `${OUT}/s-agent-toast-added.png` });
await page.click('#toast-action');
await page.waitForSelector('#toast', { state: 'hidden' });
check('Show brings the new part into view and lights it up', await page.evaluate(() => {
  const hr = document.querySelectorAll('#article hr')[1];
  const r = hr.getBoundingClientRect();
  return r.top >= 56 && r.bottom <= innerHeight && hr.nextElementSibling.classList.contains('fresh') && !hr.classList.contains('fresh');
}));
await page.screenshot({ path: `${OUT}/s-agent-show-new.png` });

// Rewritten by an agent while open: the new version in place, with a notice.
const agentPut = (query, body) => page.evaluate(async ([tok, query, body]) => {
  const r = await fetch(`/api/agent/texts/${location.hash.split('/').pop()}${query}`, {
    method: 'PUT', credentials: 'omit', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'text/markdown' }, body,
  });
  document.dispatchEvent(new Event('visibilitychange'));
  return r.status;
}, [token, query, body]);
check('agent rewrites its text', (await agentPut('', '# Rewritten\n\nA shorter, corrected reply.')) === 200);
const rewritten = await waitForArticleText(page, 'A shorter, corrected reply').then(() => true, () => false);
check('rewritten while open: the reader shows the new version', rewritten && !(await articleText(page)).includes('A third part'));
check('…and says the text was updated', (await toastText()) === 'This text was updated. You’re reading the latest version.' && !(await page.isVisible('#toast-action')), await toastText());
check('…keeping its title', (await page.textContent('#book-title')) === 'From an Agent');
await page.screenshot({ path: `${OUT}/s-agent-toast-updated.png` });
check('agent renames its text', (await agentPut('?title=From%20an%20Agent%2C%20Revised', '# Rewritten\n\nA shorter, corrected reply.')) === 200);
const renamed = await page.waitForFunction(() => document.querySelector('#book-title').textContent === 'From an Agent, Revised', null, { timeout: 8000 }).then(() => true, () => false);
check('renamed while open: new title with a notice', renamed && (await toastText()) === 'Renamed to “From an Agent, Revised”.', await toastText());

// Without leaving the page: a check every 30 seconds picks up changes.
const watcher = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: await ctx.storageState() });
const wp = await watcher.newPage();
wp.on('pageerror', (e) => errors.push(String(e)));
await wp.clock.install();
await wp.goto(page.url());
await waitForArticleText(wp, 'A shorter, corrected reply', 30000);
await wp.evaluate(async (tok) => {
  await fetch(`/api/agent/texts/${location.hash.split('/').pop()}/append`, {
    method: 'POST', credentials: 'omit', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'text/markdown' },
    body: 'Added while the reader watched.',
  });
}, token);
await wp.clock.fastForward(31_000);
const watched = await waitForArticleText(wp, 'Added while the reader watched').then(() => true, () => false);
check('open text updates on its own within 30 seconds', watched && (await wp.textContent('#toast-text')) === 'New content was added at the end.');
await watcher.close();

// ---- time to live: agents' texts delete themselves after 30 days unless kept
check('reader says when an agent’s text goes', (await page.textContent('#book-stat')).includes('deletes in 30 days'), await page.textContent('#book-stat'));
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
const agentCard = page.locator('.book', { has: page.locator('.cover-title', { hasText: 'From an Agent' }) });
check('shelf shows the days left', (await agentCard.locator('.cover-ttl').textContent()).includes('30d'));
check('…and only on texts that expire', (await page.$$('.cover-ttl')).length === 1);
await page.screenshot({ path: `${OUT}/s-ttl-shelf.png` });
await agentCard.locator('.book-link').click();
await page.waitForSelector('#reader-view:not([hidden])');
// Appending: the text's own time to live is the default, and can be set again.
const expiry = () => page.evaluate((id) => fetch('/api/books/' + id, { cache: 'no-store' }).then((r) => r.json()).then((b) => b.expiresAt), up.body.id);
const expiresBefore = await expiry();
const appendLine = async (line, ttl) => {
  await page.click('#btn-append');
  await page.waitForSelector('#source-dialog[open]');
  const offered = await page.$eval('#src-ttl', (s) => ({ value: s.value, label: s.selectedOptions[0].textContent, all: [...s.options].map((o) => o.textContent) }));
  if (ttl) await page.selectOption('#src-ttl', ttl);
  await page.fill('#src-more', line);
  await page.click('#src-save');
  await page.waitForFunction(() => !document.querySelector('#source-dialog').open);
  await waitForArticleText(page, line);
  return offered;
};
const offered = await appendLine('One more line, added by the reader.');
check('append: the text’s time to live is the default, as the days it has left', offered.value === 'keep' && offered.label === 'After 30 days (inherited)', JSON.stringify(offered));
check('…a new item, first, with the usual ones as they are', offered.all.join('|') === 'After 30 days (inherited)|Never|After 1 day|After 7 days|After 30 days|After 90 days|After 1 year', offered.all.join('|'));
check('…and appending keeps it', (await expiry()) === expiresBefore, `${expiresBefore} → ${await expiry()}`);
await appendLine('And one last line.', '7');
const expiresNow = Date.parse(await expiry());
check('…or sets a new one', Math.abs(expiresNow - (Date.now() + 7 * 864e5)) < 120e3 && (await page.textContent('#book-stat')).includes('deletes in 7 days'),
  `${new Date(expiresNow).toISOString()} · ${await page.textContent('#book-stat')}`);
await page.click('#btn-menu');
await page.click('#btn-edit');
await page.waitForSelector('#source-dialog[open]');
check('edit: the time just set is inherited', (await page.$eval('#src-ttl', (s) => s.selectedOptions[0].textContent)) === 'After 7 days (inherited)');
await page.screenshot({ path: `${OUT}/s-ttl-dialog.png` });
await page.selectOption('#src-ttl', '0');
await page.click('#src-save');
await page.waitForFunction(() => !document.querySelector('#source-dialog').open);
await page.waitForFunction(() => !document.querySelector('#book-stat').textContent.includes('deletes'));
const kept = await page.evaluate((id) => fetch('/api/books/' + id).then((r) => r.json()), up.body.id);
check('kept forever: no time to live left', kept.expiresAt === '', kept.expiresAt);
// A new text with its own time to live.
await page.goto(BASE + '#/');
await page.waitForSelector('#library-view:not([hidden])');
await page.locator('#btn-add:visible, #btn-add-empty:visible').first().click();
await page.waitForSelector('#source-dialog[open]');
check('new text: kept forever unless chosen, with nothing inherited', (await page.inputValue('#src-ttl')) === '0'
  && !(await page.$$eval('#src-ttl option', (os) => os.some((o) => o.textContent.includes('inherited')))));
await page.fill('#src-text', 'A note for this week only.');
await page.selectOption('#src-ttl', '7');
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
check('new text with 7 days', (await page.textContent('#book-stat')).includes('deletes in 7 days'), await page.textContent('#book-stat'));
await page.goto(BASE + '#/settings');
await page.waitForSelector('#settings-view:not([hidden])');
check('token hidden after leaving Settings', !(await visible('#token-new')));
check('last use recorded', !(await page.textContent('#token-list')).includes('never used'));
await page.click('#token-list [data-revoke]');
await page.waitForSelector('#token-empty', { state: 'visible' });
check('token revoked', true);
const after = await page.evaluate((tok) => fetch('/api/agent/whoami', { credentials: 'omit', headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.status), token);
check('revoked token refused', after === 401);
await ctx.close();

// ---- phone + dark
const phone = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' });
const pp = await phone.newPage();
pp.on('pageerror', (e) => errors.push(String(e)));
await signIn(pp, user);
await pp.locator('#btn-add:visible, #btn-add-empty:visible').first().click();
await pp.waitForSelector('#source-dialog[open]');
await pp.click('#src-kinds label:has(input[value="file"])');
const fit = await pp.evaluate(() => {
  const d = document.querySelector('#source-dialog').getBoundingClientRect();
  const k = document.querySelector('#src-kinds').getBoundingClientRect();
  return d.right <= innerWidth && k.right <= d.right && document.documentElement.scrollWidth <= innerWidth;
});
check('dialog fits a phone', fit);
await pp.screenshot({ path: `${OUT}/s-phone-epub.png` });
await pp.click('#src-kinds label:has(input[value="url"])');
await pp.screenshot({ path: `${OUT}/s-phone-url.png` });
await pp.keyboard.press('Escape');
await pp.locator('.book-link').first().click();
await pp.waitForSelector('#reader-view:not([hidden])');
check('phone: no Append Text in the bar, so the title keeps its room', !(await pp.isVisible('#btn-append')));
await pp.click('#btn-menu');
check('phone: Append Text is in the ⋯ menu', await pp.isVisible('#menu-append'));
await pp.screenshot({ path: `${OUT}/s-phone-menu.png` });
await pp.click('#menu-append');
await pp.waitForSelector('#source-dialog[open]');
check('…and opens the text on Append', (await pp.$eval('#src-modes input:checked', (i) => i.value)) === 'append' && await pp.isVisible('#src-more'));
await phone.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
