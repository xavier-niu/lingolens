// Phone + tablet checks: layout fits, tap-to-lookup works, card/drawer stay in view.
import { chromium, devices } from 'playwright';
import { freshUser, signIn, checker } from './helpers.mjs';

const OUT = process.argv[2];
const { check } = checker();

const SAMPLE_SETUP = async (page, browser) => {
  await signIn(page, await freshUser(browser));
  await page.click('#btn-sample-empty');
  await page.waitForSelector('ruby.ann rt');
};

const inViewport = (page, sel) => page.$eval(sel, (el) => {
  const r = el.getBoundingClientRect();
  return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
});

const browser = await chromium.launch();
for (const [label, device] of [['phone', devices['iPhone 13']], ['tablet', devices['iPad (gen 7)']], ['tablet-landscape', devices['iPad (gen 7) landscape']]]) {
  // Use Chromium with the device's viewport/touch settings.
  const ctx = await browser.newContext({ ...device, defaultBrowserType: undefined });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await SAMPLE_SETUP(page, browser);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${label}: no horizontal overflow`, overflow <= 0, `${overflow}px`);
  const headerH = await page.$eval('.topbar', (h) => h.getBoundingClientRect().height);
  check(`${label}: header height reasonable`, headerH < 170, `${Math.round(headerH)}px`);
  const hdr = await page.$eval('.topbar', (h) => h.scrollWidth - h.clientWidth);
  check(`${label}: header fits without scrolling`, hdr <= 0, `${hdr}px`);
  check(`${label}: level switch visible`, await inViewport(page, '#btn-level'));
  const broken = await page.$$eval('ruby.ann', (rs) => rs.filter((r) => r.getClientRects().length > 1).length);
  check(`${label}: no ruby split across lines`, broken === 0, `${broken} split`);

  // Tap a plain word.
  const pt = await page.evaluate(() => {
    const w = document.createTreeWalker(document.querySelector('#article'), NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const n = w.currentNode; const i = n.data.indexOf('dinner');
      if (i >= 0 && !n.parentElement.closest('ruby')) {
        n.parentElement.scrollIntoView({ block: 'center' });
        const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 4);
        const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
    }
    return null;
  });
  await page.touchscreen.tap(pt.x, pt.y);
  await page.waitForSelector('#card:not([hidden]) .detail h4', { timeout: 5000 });
  check(`${label}: tap word opens card with details`, (await page.textContent('#card .lemma')) === 'dinner');
  check(`${label}: card fully in viewport`, await inViewport(page, '#card'));
  await page.screenshot({ path: `${OUT}/${label}-card.png` });

  // Open chat via the card and check the drawer fits.
  await page.tap('#card [data-act="ask"]');
  await page.waitForSelector('#chat:not([hidden])');
  await page.waitForFunction(() => document.querySelector('.msg.assistant:not(.pending)'));
  check(`${label}: chat drawer in viewport`, await inViewport(page, '#chat'));
  check(`${label}: chat input visible`, await inViewport(page, '#chat-form'));
  await page.screenshot({ path: `${OUT}/${label}-chat.png` });
  check(`${label}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}
await browser.close();
