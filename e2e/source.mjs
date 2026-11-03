// Add Source (text with Markdown detection, web page, EPUB), Contents, and Agent Access.
import { chromium, devices } from 'playwright';
import { BASE, SITE, fixture, freshUser, signIn, checker } from './helpers.mjs';

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
check('three kinds: Text, Web Page, EPUB', JSON.stringify(await kinds()) === '["text","url","epub"]');
check('no Markdown option any more', !(await page.$('#src-kinds input[value="markdown"]')));
check('nothing disabled or "coming soon"', (await page.$$('#src-kinds input:disabled')).length === 0);
await page.fill('#src-text', 'Dear Sam,\n\nThanks for the letter. I hope you are well.');
check('plain text: no Markdown note', !(await visible('#src-md')));
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
const fmt = await page.evaluate(() => fetch('/api/books/' + location.hash.split('/').pop()).then((r) => r.json()).then((b) => b.format));
check('stored as markdown', fmt === 'markdown');

// ---- web page
await openDialog();
await page.click('#src-kinds label:has(input[value="url"])');
check('URL field focused', await page.evaluate(() => document.activeElement.id === 'src-url'));
await page.fill('#src-url', SITE + 'missing.html');
await page.click('#src-save');
await page.waitForFunction(() => document.querySelector('#src-error').textContent.length > 0);
check('a broken link shows the site error', (await page.textContent('#src-error')).includes('404'));
check('dialog stays open after an error', await visible('#source-dialog'));
await page.fill('#src-url', SITE + 'article.html');
await page.screenshot({ path: `${OUT}/s-url.png` });
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])');
const art = await page.textContent('#article');
check('page title used', (await page.textContent('#book-title')).includes('The Art of Slow Travel'));
check('article text imported', art.includes('settle into one place') && art.includes('better stories'));
check('menus, ads and footer left out', !/Hot Deals|cheap flights|newsletter/.test(art));
check('section heading kept', !!(await page.$('#article h2')));

// ---- EPUB
await openDialog();
await page.click('#src-kinds label:has(input[value="epub"])');
check('Import Book label', (await page.textContent('#src-save')) === 'Import Book');
await page.click('#src-save');
check('asks for a file first', (await page.textContent('#src-error')).includes('Choose an EPUB'));
await page.setInputFiles('#src-file', fixture('notes.txt'));
check('a non-EPUB file is refused', (await page.textContent('#src-error')).includes('isn’t an EPUB'));
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

// ---- a novel-sized book
await openDialog();
await page.click('#src-kinds label:has(input[value="epub"])');
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
check('skill download link', (await page.getAttribute('.token-head a[download]', 'href')) === '/skills/lingolens.zip');
await page.screenshot({ path: `${OUT}/s-agent.png`, fullPage: true });

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
await pp.click('#src-kinds label:has(input[value="epub"])');
const fit = await pp.evaluate(() => {
  const d = document.querySelector('#source-dialog').getBoundingClientRect();
  const k = document.querySelector('#src-kinds').getBoundingClientRect();
  return d.right <= innerWidth && k.right <= d.right && document.documentElement.scrollWidth <= innerWidth;
});
check('dialog fits a phone', fit);
await pp.screenshot({ path: `${OUT}/s-phone-epub.png` });
await pp.click('#src-kinds label:has(input[value="url"])');
await pp.screenshot({ path: `${OUT}/s-phone-url.png` });
await phone.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
