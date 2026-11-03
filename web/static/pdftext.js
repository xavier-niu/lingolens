// Reads the text of a PDF in the browser with pdf.js (Mozilla, Apache-2.0) and
// rebuilds it as Markdown for the shelf. A PDF stores positioned bits of text,
// not paragraphs, so lines are rebuilt from their baselines and joined into
// paragraphs (across line breaks, hyphenation and pages); larger type becomes
// headings, and running headers, footers and page numbers are left out.
// The file never leaves the device: the text is added like pasted text.

// A problem worth showing as is; .key is an i18n key.
export class PDFError extends Error {
  constructor(key) {
    super(key);
    this.key = key;
  }
}

let lib = null;

// pdf.js is 1.8 MB, so it loads on first use (and the service worker keeps it).
async function loadLib() {
  if (!lib) {
    const mod = await import('./vendor/pdfjs/pdf.min.js');
    mod.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
    lib = mod;
  }
  return lib;
}

export const isPDF = (file) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf';

// readPDF(file, {onPage(i, n)}) → {title, content}, content in Markdown.
export async function readPDF(file, { onPage } = {}) {
  let pdfjs;
  try {
    pdfjs = await loadLib();
  } catch {
    throw new PDFError('pdf.needsNet');
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false, // never compile code from a file
    disableFontFace: true, // text only: no fonts to load
    stopAtErrors: false, // read what can be read
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    task.destroy();
    throw new PDFError(err?.name === 'PasswordException' ? 'pdf.password' : 'pdf.invalid');
  }
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      onPage?.(i, doc.numPages);
      const page = await doc.getPage(i);
      pages.push(pageLines((await page.getTextContent()).items));
      page.cleanup();
    }
    const blocks = toBlocks(pages);
    if (toMarkdown(blocks).match(/\p{L}/gu)?.length < 40 || !blocks.length) throw new PDFError('pdf.noText');
    const info = await doc.getMetadata().then((m) => m?.info, () => null);
    const title = pickTitle(info?.Title, blocks, file.name);
    // The reader shows the title above the text already.
    const same = (a, b) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
    if (blocks[0]?.kind === 'h' && same(blocks[0].text, title)) blocks.shift();
    return { title, content: toMarkdown(blocks) };
  } finally {
    task.destroy();
  }
}

// ------------------------------------------------------------------ lines

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

// The page's text items → lines {text, x, y, end, size}, in reading order as the
// PDF stores it. y grows upwards; size is the type size, averaged over the line.
export function pageLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue; // marked-content markers
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || it.height || 0;
    const str = it.str.replace(/[ﬀ-ﬆ]/g, (ch) => LIGATURES[ch]).replace(/­/g, '');
    // Sideways text (margin stamps, rotated labels) isn't part of the reading.
    if (str.trim() && Math.abs(b) <= Math.abs(a) && size > 0) {
      if (!cur || Math.abs(y - cur.y) > Math.max(size, cur.size) * 0.5) {
        cur = { text: '', x, y, end: x, size, chars: 0, weight: 0 };
        lines.push(cur);
      } else if (x - cur.end > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(str)) {
        cur.text += ' '; // a gap in the line without a space character
      }
      cur.text += str;
      cur.x = Math.min(cur.x, x);
      cur.end = Math.max(cur.end, x + (it.width || 0));
      const n = str.trim().length;
      cur.weight += size * n;
      cur.chars += n;
      cur.size = cur.weight / cur.chars;
    }
    if (it.hasEOL) cur = null;
  }
  return lines
    .map(({ text, x, y, end, size }) => ({ text: text.replace(/\s+/g, ' ').trim(), x, y, end, size }))
    .filter((l) => l.text);
}

// ------------------------------------------------------------------ paragraphs

const isPageNumber = (t) => /^(page\s+)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t)
  || /^[-–—]\s*\d{1,4}\s*[-–—]$/.test(t) || /^[ivxlc]{1,7}$/.test(t);

// Running headers and footers: the top and bottom lines that repeat (numbers
// aside) on many pages, and lone page numbers there.
function dropRunningLines(pages) {
  const key = (t) => t.toLowerCase().replace(/\d+/g, '#');
  const edges = (lines) => {
    const byY = [...lines].sort((p, q) => q.y - p.y);
    return new Set([...byY.slice(0, 2), ...byY.slice(-2)]);
  };
  const counts = new Map();
  for (const lines of pages) {
    for (const k of new Set([...edges(lines)].map((l) => key(l.text)))) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const repeats = Math.max(3, Math.ceil(pages.length * 0.3));
  return pages.map((lines) => {
    const edge = edges(lines);
    return lines.filter((l) => !edge.has(l) || !(isPageNumber(l.text) || counts.get(key(l.text)) >= repeats));
  });
}

function weightedMedian(pairs) {
  const sorted = [...pairs].sort((p, q) => p[0] - q[0]);
  const half = sorted.reduce((s, p) => s + p[1], 0) / 2;
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= half) return v;
  }
  return sorted.at(-1)?.[0] || 0;
}

const median = (xs) => (xs.length ? [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)] : 0);
const BULLET = /^[•◦▪‣●○■–]\s*/;
const ENDS_SENTENCE = /[.!?:;"”’)\]]$/;

// Lines of all pages → blocks {kind: 'h'|'p'|'li', level?, text}.
export function toBlocks(rawPages) {
  const pages = dropRunningLines(rawPages);
  const all = pages.flat();
  if (!all.length) return [];
  const body = weightedMedian(all.map((l) => [l.size, l.text.length]));
  const isBody = (l) => Math.abs(l.size - body) <= body * 0.1;
  const gaps = [];
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i - 1].y - lines[i].y;
      if (g > 0 && isBody(lines[i]) && isBody(lines[i - 1])) gaps.push(g);
    }
  }
  const gap = median(gaps) || body * 1.2;

  const blocks = [];
  let para = null;
  const flush = () => {
    if (para) blocks.push(para);
    para = null;
  };
  for (const lines of pages) {
    // Where full lines start and end: a line that stops well short ends a paragraph.
    const bodyLines = lines.filter(isBody);
    const right = median(bodyLines.map((l) => l.end).sort((p, q) => q - p).slice(0, 10));
    const left = bodyLines.length ? Math.min(...bodyLines.map((l) => l.x)) : 0;
    let prev = null;
    for (const l of lines) {
      const ratio = l.size / body;
      if (ratio >= 1.15 && l.text.length <= 150 && /\p{L}/u.test(l.text)) {
        const level = ratio >= 1.6 ? 1 : 2;
        if (para?.kind === 'h' && para.level === level && prev && prev.y - l.y < l.size * 1.8) {
          para.text += ' ' + l.text; // a heading on two lines
        } else {
          flush();
          para = { kind: 'h', level, text: l.text };
        }
        prev = l;
        continue;
      }
      let start = !para || para.kind === 'h' || BULLET.test(l.text) || !isBody(l) !== !isBody(para.last)
        || (para.kind === 'li' && l.x <= para.x0 + body * 0.3); // a list item goes on only indented
      if (!start) {
        const ended = ENDS_SENTENCE.test(para.text);
        if (!prev) {
          start = ended; // first line of a page: carry on unless the last one ended a sentence
        } else {
          const dy = prev.y - l.y;
          start = dy > gap * 1.45 // space between paragraphs
            || (dy < 0 && ended) // up into the next column
            || (ended && l.x > prev.x + body * 0.8) // first-line indent
            || (ended && right && prev.end < right - body * 2) // the last line stopped short
            // A line under 60% of the width ends its paragraph even without a full
            // stop: list items whose bullets are drawn, addresses, verse.
            || (right > left && prev.end - left < (right - left) * 0.6);
        }
      }
      if (start) {
        flush();
        para = BULLET.test(l.text)
          ? { kind: 'li', text: l.text.replace(BULLET, ''), last: l, x0: l.x }
          : { kind: 'p', text: l.text, last: l };
      } else {
        para.text = joinLines(para.text, l.text);
        para.last = l;
      }
      prev = l;
    }
  }
  flush();
  return blocks.map(({ kind, level, text }) => ({ kind, level, text }));
}

// "inter-" + "national" → "international"; other line breaks become spaces.
function joinLines(a, b) {
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

// ------------------------------------------------------------------ Markdown

// As internal/importer escapes HTML text: Markdown characters in prose stay text.
const escapeText = (s) => s.replace(/[\\*_`[\]<]/g, '\\$&');

function escapeLeading(s) {
  const m = s.match(/^(#{1,6}\s|>|[-+]\s|={3,}|-{3,}|(\d+)([.)])\s)/);
  if (!m) return s;
  return m[2] ? `${m[2]}\\${s.slice(m[2].length)}` : `\\${s}`;
}

// Blocks (or pages of lines) → the Markdown the reader renders.
export function toMarkdown(blocksOrPages) {
  const blocks = Array.isArray(blocksOrPages[0]) ? toBlocks(blocksOrPages) : blocksOrPages;
  return blocks.map(render).join('\n\n');
}

function render(b) {
  if (b.kind === 'h') return `${'#'.repeat(b.level === 1 ? 1 : 2)} ${escapeText(b.text)}`;
  if (b.kind === 'li') return `- ${escapeText(b.text)}`;
  return escapeLeading(escapeText(b.text));
}

// The document's own title, unless it's a leftover like "Microsoft Word - x.docx";
// then the first big heading, then the file name.
function pickTitle(meta, blocks, filename) {
  const m = String(meta || '').replace(/\s+/g, ' ').trim();
  const junk = /^(untitled|microsoft (word|powerpoint)\b|document\d*$|slide \d+$)|\.(docx?|pdf|tex|indd|rtf|odt|pages|pptx?)$/i;
  if (m.length >= 3 && /\p{L}/u.test(m) && !junk.test(m)) return m;
  const h = blocks.find((b) => b.kind === 'h' && b.level === 1);
  if (h) return h.text.slice(0, 200);
  return filename.replace(/\.pdf$/i, '');
}
