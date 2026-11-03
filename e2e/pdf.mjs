// PDF sources: read in the browser with pdf.js, rebuilt into paragraphs and
// headings, without running headers, footers and page numbers. Test PDFs are
// printed by Chromium itself, so they're real PDFs with embedded fonts.
import { chromium } from 'playwright';
import { BASE, freshUser, signIn, checker } from './helpers.mjs';
import { toMarkdown } from '../web/static/pdftext.js';

const OUT = process.argv[2];
const { check } = checker();

// ---- paragraph rules, on lines as pdf.js would give them
const L = (text, y, o = {}) => ({ text, x: o.x ?? 72, y, end: o.end ?? 540, size: o.size ?? 11 });
const md = toMarkdown([
  [L('THE JOURNAL', 770, { size: 9 }), L('A Day by the Sea', 700, { size: 22 }),
    L('The morning was grey and the beach was', 660), L('almost empty, except for a few inter-', 646),
    L('national visitors walking their dogs.', 632, { end: 300 }),
    L('Later the sun came out and everyone', 610, { x: 90 }), L('arrived at once, carrying * chairs and', 596), L('1', 40, { size: 9 })],
  [L('THE JOURNAL', 770, { size: 9 }), L('umbrellas down to the water.', 760, { end: 260 }),
    L('• towels and a long', 730), L('blue umbrella', 716, { x: 84, end: 200 }), L('• a [good] book', 700), L('2', 40, { size: 9 })],
  [L('THE JOURNAL', 770, { size: 9 }), L('1984. That was the year it all began.', 700), L('Page 3 of 3', 40, { size: 9 })],
]).split('\n\n');
check('larger type becomes a heading', md[0] === '# A Day by the Sea', md[0]);
check('lines joined, hyphenated word rejoined', md[1] === 'The morning was grey and the beach was almost empty, except for a few international visitors walking their dogs.', md[1]);
check('indent starts a paragraph; it carries on over the page', md[2] === 'Later the sun came out and everyone arrived at once, carrying \\* chairs and umbrellas down to the water.', md[2]);
check('bullets become a list, with indented lines kept', md[3] === '- towels and a long blue umbrella' && md[4] === '- a \\[good\\] book', md.slice(3, 5).join(' | '));
check('prose that looks like Markdown stays prose', md[5] === '1984\\. That was the year it all began.', md[5]);
check('running header and page numbers left out', md.length === 6 && !/JOURNAL|Page 3/.test(md.join(' ')) && !md.includes('1'), md.join(' | '));

// ---- PDFs printed by Chromium
const browser = await chromium.launch();
const maker = await (await browser.newContext()).newPage();
const sentence = (i) => `This is sentence ${i} of the story, and it keeps going for a while so that every paragraph wraps across several lines of the page`;
const para = (from, n) => Array.from({ length: n }, (_, k) => sentence(from + k)).join(', ') + '.';
const PARAS = [para(1, 4), para(5, 9), para(14, 6), para(20, 12), para(32, 5), para(37, 10), para(47, 7), para(54, 11)];
const articleHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rivers of the North</title>
<style>body{font:12pt/1.5 serif;margin:0} h1{font-size:28pt;margin:0 0 12pt} h2{font-size:17pt;margin:16pt 0 8pt} p{margin:0 0 10pt}</style></head><body>
<h1>Rivers of the North</h1>
${PARAS.slice(0, 3).map((p) => `<p>${p}</p>`).join('\n')}
<h2>The Spring Floods</h2>
${PARAS.slice(3, 6).map((p) => `<p>${p}</p>`).join('\n')}
<ul><li>Boots that keep the water out</li><li>A map of the old bridges</li></ul>
<h2>Quiet Summers</h2>
<p>${PARAS[6]}</p>
<h2>Winter Ice</h2>
<p>${PARAS[7]}</p>
</body></html>`;
async function printPDF(html, path, { headerFooter = false } = {}) {
  await maker.setContent(html);
  await maker.pdf({
    path, format: 'A5', printBackground: true,
    displayHeaderFooter: headerFooter,
    headerTemplate: '<div style="font-size:8px;width:100%;text-align:center">Rivers of the North · Field Notes</div>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    margin: { top: '50px', bottom: '50px', left: '40px', right: '40px' },
  });
  return path;
}
const article = await printPDF(articleHTML, `${OUT}/rivers.pdf`, { headerFooter: true });
const scanned = await printPDF('<!doctype html><title>Scan</title><div style="width:300px;height:400px;background:#888"></div>', `${OUT}/scan.pdf`);
const second = await printPDF(`<!doctype html><title>Offline Notes</title><style>body{font:12pt/1.5 serif}</style><p>${para(100, 6)}</p><p>${para(106, 4)}</p>`, `${OUT}/offline.pdf`);

const errors = [];
const user = await freshUser(browser);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
await signIn(page, user);

const openFileKind = async () => {
  await page.goto(BASE + '#/');
  await page.waitForSelector('#library-view:not([hidden])');
  await page.locator('#btn-add:visible, #btn-add-empty:visible').first().click();
  await page.waitForSelector('#source-dialog[open]');
  await page.click('#src-kinds label:has(input[value="file"])');
};
const errorText = async () => {
  await page.waitForFunction(() => document.querySelector('#src-error').textContent.length > 0, null, { timeout: 15000 });
  return page.textContent('#src-error');
};

// ---- a real PDF
await openFileKind();
await page.setInputFiles('#src-file', article);
check('PDF accepted, button says Import PDF', (await page.textContent('#src-save')) === 'Import PDF');
await page.screenshot({ path: `${OUT}/pdf-dialog.png` });
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])', { timeout: 30000 });
check('title from the PDF', (await page.textContent('#book-title')) === 'Rivers of the North');
const stored = await page.evaluate(() => fetch('/api/books/' + location.hash.split('/').pop()).then((r) => r.json()));
check('stored as Markdown', stored.format === 'markdown');
const blocks = stored.content.split('\n\n');
const prose = blocks.filter((b) => !b.startsWith('#'));
check('one paragraph per paragraph, also across pages', prose.length === PARAS.length + 2, `${prose.length} vs ${PARAS.length + 2}`);
check('paragraph text intact', PARAS.every((p) => blocks.includes(p)), PARAS.find((p) => !blocks.includes(p))?.slice(0, 80));
check('short lines (drawn bullets) stay apart', blocks.includes('Boots that keep the water out') && blocks.includes('A map of the old bridges'));
check('title not repeated as the first heading', !blocks[0].startsWith('# '), blocks[0].slice(0, 40));
check('headings kept', (await page.$$eval('#article h2', (h) => h.map((x) => x.textContent).join('|'))) === 'The Spring Floods|Quiet Summers|Winter Ice');
const art = await page.textContent('#article');
check('running header and page numbers left out', !/Field Notes|Page \d+ of \d+/.test(art));
await page.click('#btn-menu');
check('Contents offered', await page.isVisible('#btn-toc'));
await page.keyboard.press('Escape');
await page.screenshot({ path: `${OUT}/pdf-reader.png` });

// ---- files that can't be read
await openFileKind();
await page.setInputFiles('#src-file', scanned);
await page.click('#src-save');
check('scanned PDF explained', (await errorText()).includes('scanned'));
await page.setInputFiles('#src-file', { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not really a pdf') });
await page.click('#src-save');
check('broken PDF explained', (await errorText()).includes('couldn’t be read as a PDF'));
check('dialog stays open', await page.isVisible('#source-dialog'));

// ---- offline, once pdf.js has been loaded: added here, sent later
await page.keyboard.press('Escape');
await ctx.setOffline(true);
await openFileKind().catch(() => {}); // the page itself comes from the service worker
check('offline: Book or PDF still offered', !(await page.isDisabled('#src-kinds input[value="file"]')) && await page.isDisabled('#src-kinds input[value="url"]'));
await page.setInputFiles('#src-file', second);
await page.fill('#src-title', 'My Offline Notes');
await page.click('#src-save');
await page.waitForSelector('#reader-view:not([hidden])', { timeout: 30000 });
check('offline: PDF added to this device', (await page.textContent('#book-title')) === 'My Offline Notes' && (await page.textContent('#article')).includes('sentence 106'));
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
const synced = await page.waitForFunction(() => fetch('/api/books').then((r) => r.json()).then((b) => b.some((x) => x.title === 'My Offline Notes')), null, { timeout: 15000, polling: 500 }).then(() => true, () => false);
check('back online: sent to the server', synced);
await ctx.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
