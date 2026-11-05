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
  /^#{1,6}[ \t]+\S/m, // heading
  /^(```|~~~)/m, // code fence
  /^\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m, // table rule
];
const MD_LINK = /\[[^\]\n]+\]\((https?:\/\/|\/|#)[^)\s]*\)/g;
const MD_WEAK = [
  /^[ \t]*([-*+]|\d{1,3}[.)])[ \t]+\S/gm, // list item
  /^>[ \t]?\S/gm, // quote
  /\*\*[^*\n]+\*\*|__[^_\n]+__/g, // bold
  /`[^`\n]+`/g, // code span
];
const upTo2 = (re, s) => Math.min(2, (s.match(re) || []).length);

export function detectFormat(content) {
  const s = content.slice(0, 200_000);
  let score = 0;
  for (const re of MD_STRONG) if (re.test(s)) score += 3;
  score += 2 * upTo2(MD_LINK, s);
  for (const re of MD_WEAK) score += upTo2(re, s);
  return score >= 3 ? 'markdown' : 'text';
}

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
