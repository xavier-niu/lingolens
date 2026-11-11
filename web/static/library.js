// The shelf: the signed-in user's texts, each shown as a thread-bound book.
// Books live on the server, with a copy in this browser for reading offline
// (offline.js); this module names the book calls and holds pure helpers.

import { api } from './api.js';

export const MAX_CHARS = 2_000_000; // matches the server's limit
export const MAX_EPUB_BYTES = 50 * 1024 * 1024;

// Reading speed for a learner at each level, in words per minute.
const WPM = { A1: 70, A2: 90, B1: 120, B2: 150, C1: 180, C2: 220 };


// These work offline: a new or edited text is kept here and sent when the server
// can be reached again.
export {
  getText as getBook, deleteText as deleteBook, saveProgress,
} from './offline.js';
import { createText, updateText } from './offline.js';
// ttlDays: delete the text after this many days; 0 keeps it forever. Left out
// on an edit, the text keeps the time it has.
export const createBook = ({ title, content, format = 'text', ttlDays }) => createText({ title, content, format, ttlDays });
export const updateBook = (id, { title, content, format, ttlDays }) => updateText(id, { title, content, format, ttlDays });

// Imports need the server (it fetches the page or reads the EPUB).
export const importURL = (url, title, ttlDays) => api('POST', '/api/books/import/url', { url, title, ttlDays });
// A page the bookmarklet sent from the user's browser: the article, or just the selection.
export const importPage = ({ url, title, html, selection }) =>
  api('POST', '/api/books/import/page', selection ? { url, title, selection } : { url, title, html });
export const importEPUB = (file, title, ttlDays = 0) => api('POST', `/api/books/import/epub?title=${encodeURIComponent(title || '')}&ttlDays=${ttlDays}`, file, { type: 'application/epub+zip' });

// Mirrors store.DetectFormat on the server: is pasted text Markdown?
const MD_STRONG = [
  /^ {0,3}#{1,6}[ \t\u00a0]+\S/m, // heading
  /^ {0,3}(```|~~~)/m, // code fence
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/m, // table rule
  /^ ?([-*+]|\d{1,3}[.)])[ \t]+\S[^\n]*\n[ \t]{2,}([-*+]|\d{1,3}[.)])[ \t]+\S/m, // list in a list
  /^[ \t]*\S[^\n]*\n {0,3}={3,}[ \t]*$/m, // heading underlined with ===
  /(^|[^\w*])\*\*[^\s*]([^*\n]*[^\s*])?\*\*/m, // **bold**
  /\[[^\]\n]*\]\([^)\s]*[/.#:][^)\s]*([ \t]+("[^"\n]*"|'[^'\n]*'))?\)/, // link or image
];
const MD_WEAK = [
  /^[ \t]*([-*+]|\d{1,3}[.)])[ \t]+\S/gm, // list item
  /^ {0,3}>[ \t]?\S/gm, // quote
  /`[^`\n]+`/g, // code span
  /(^|[^\w*])\*[^\s*]([^*\n]*[^\s*])?\*/gm, // *italic*
  /(^|[^\w_])__?[^\s_]([^_\n]*[^\s_])?__?($|[^\w_])/gm, // _italic_, __bold__
  /~~[^\s~]([^~\n]*[^\s~])?~~/g, // ~~struck~~
  /\[[^\]\n]+\]\[[^\]\n]*\]/g, // [reference link][1]
  /^ {0,3}\[[^\]\n]+\]:[ \t]*\S/gm, // [1]: its address
];
// Would-be code: Markdown shows a block indented 4 spaces as code.
const MD_INDENTED = /(^|\n[ \t]*\n)( {4,}|\t)\S/;
const upTo2 = (re, s) => Math.min(2, (s.match(re) || []).length);

// How much pasted text looks like Markdown: at 3 it's Markdown. Below that it's
// plain text, but with 2 or more marks the dialog offers Markdown instead.
// Text wrapped at a fixed width counts a little: Markdown joins lines, which
// loses nothing when they're only wrapped (unless it has a block to show as code).
export function markdownScore(content) {
  const s = content.slice(0, 200_000).replace(/\r\n?/g, '\n');
  let score = 0;
  for (const re of MD_STRONG) if (re.test(s)) score += 3;
  for (const re of MD_WEAK) score += upTo2(re, s);
  if (wrapWidth(s) && !MD_INDENTED.test(s)) score += 1;
  return score;
}

// Text copied from a terminal or an email, or a Project Gutenberg book, has
// line breaks wherever a line ran out of room. wrapWidth finds the width, or 0
// when the breaks mean something (a poem, an address, a paragraph per line):
// at least 2 breaks, and half of them, fall mid-sentence where the next word
// wouldn't have fit. Mirrors store.wrapWidth.
const BLOCK_START = /^([-*+]|\d{1,3}[.)]|#{1,6}|>)([ \t]|$)/; // a list item, heading or quote
const SENTENCE_END = /[.!?:;]["'”’)\]]*$/;
const codePoints = (s) => s.length - (s.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) || []).length;

// Was `line` broken before `next` only because the next word didn't fit?
export const wrapsBefore = (line, next, width) => !BLOCK_START.test(next)
  && codePoints(line.replace(/[ \t]+$/, '')) + 1 + codePoints(next.replace(/^[ \t]+/, '').split(/[ \t]/)[0]) > width;

export function wrapWidth(text) {
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const width = lines.reduce((w, l) => Math.max(w, codePoints(l)), 0);
  if (width < 50) return 0;
  let breaks = 0;
  let wrapped = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    const next = lines[i + 1].replace(/^[ \t]+/, '');
    if (!lines[i].trim() || !next || BLOCK_START.test(next)) continue;
    breaks++;
    if (!SENTENCE_END.test(lines[i]) && wrapsBefore(lines[i], next, width)) wrapped++;
  }
  return wrapped >= 2 && wrapped * 2 >= breaks ? width : 0;
}

export const detectFormat = (content) => (markdownScore(content) >= 3 ? 'markdown' : 'text');

// Minutes left to read, at least 1 unless finished.
export function minutesLeft(book, level) {
  const left = book.words * (1 - Math.min(1, book.progress || 0));
  return left <= 0 ? 0 : Math.max(1, Math.round(left / (WPM[level] || WPM.B1)));
}

// The most of a book a reader at this level can have read in a second, as a share
// of the book: three times their usual speed, which leaves room for fast readers.
export function readingStep(book, level) {
  return (3 * (WPM[level] || WPM.B1)) / 60 / Math.max(1, book.words);
}

export function isFinished(book) {
  return (book.progress || 0) >= 0.98;
}

// Each book gets one of six cover tints (see .cover[data-tint] in style.css).
export function tintFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}

// ---------------------------------------------------------------- one-time import

// Before accounts existed, texts, words and settings were kept in this browser.
// After the first sign-in they are copied into the account and removed here.
const LEGACY = {
  library: 'lingolens.library',
  source: 'lingolens.source',
  wordbook: 'lingolens.wordbook',
  known: 'lingolens.known',
  settings: 'lingolens.settings',
};

function readJSON(key, fallback, area = localStorage) {
  try {
    const v = area.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function readLegacyData() {
  const books = readJSON(LEGACY.library, []).filter((b) => b && typeof b.content === 'string');
  const source = readJSON(LEGACY.source, '');
  if (!books.length && typeof source === 'string' && source.trim()) books.push({ title: '', content: source, format: 'markdown' });
  const settings = readJSON(LEGACY.settings, null);
  let model = null;
  if (settings?.preset) {
    const key = readJSON(`lingolens.key.${settings.preset}`, '') || readJSON(`lingolens.key.${settings.preset}`, '', sessionStorage);
    model = { preset: settings.preset, ...(settings.providers?.[settings.preset] || {}), api_key: key || undefined };
  }
  return {
    books,
    wordbook: readJSON(LEGACY.wordbook, []).filter((w) => w?.key),
    known: readJSON(LEGACY.known, []).filter((k) => typeof k === 'string'),
    model,
  };
}

export function hasLegacyData() {
  const d = readLegacyData();
  return d.books.length + d.wordbook.length + d.known.length > 0 || !!d.model;
}

export function clearLegacyData() {
  try {
    for (const k of Object.values(LEGACY)) localStorage.removeItem(k);
    for (const k of Object.keys(localStorage)) if (k.startsWith('lingolens.key.')) localStorage.removeItem(k);
    for (const k of Object.keys(sessionStorage)) if (k.startsWith('lingolens.key.')) sessionStorage.removeItem(k);
    localStorage.removeItem('lingolens.view');
  } catch { /* ignore */ }
}
