// LingoLens frontend: render pasted text, request annotations, wrap them in <ruby>,
// and let the learner chat with the LLM about any selection.
/* global marked, DOMPurify */

import { t, getLang, setLang, applyI18n } from './i18n.js';
import { api, postStream, net } from './api.js';
import {
  openUser, forgetUser, finishPendingLogout, cachedMe, rememberMe, loadData, sync, flush,
  cachedAnns, saveAnns, cachedLookup, saveLookup,
  savePrefs as queuePrefs, putWord, deleteWord, setKnown, clearKnown, LOCAL_ID,
} from './offline.js';
import {
  MAX_CHARS, MAX_EPUB_BYTES, getBook, createBook, updateBook, deleteBook, saveProgress,
  importURL, importPage, importEPUB, detectFormat,
  minutesLeft, isFinished, tintFor, readLegacyData, hasLegacyData, clearLegacyData,
} from './library.js';
import { readPDF, isPDF, PDFError } from './pdftext.js';

const $ = (sel) => document.querySelector(sel);

// ------------------------------------------------------------------ providers

// `label` is a brand name; `labelKey`/`noteKey` are translated via i18n.js.
const PRESETS = {
  anthropic: { label: 'Anthropic (Claude)', kind: 'anthropic', base_url: '', model: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'], noteKey: 'note.anthropic' },
  openai: { label: 'OpenAI', kind: 'openai', base_url: 'https://api.openai.com/v1', model: '', models: [], noteKey: 'note.openai' },
  deepseek: { label: 'DeepSeek', kind: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'] },
  openrouter: { label: 'OpenRouter', kind: 'openai', base_url: 'https://openrouter.ai/api/v1', model: '', models: [], noteKey: 'note.openrouter' },
  litellm: { label: 'LiteLLM Proxy', kind: 'openai', base_url: 'http://localhost:4000/v1', model: '', models: [], noteKey: 'note.litellm' },
  qwen: { labelKey: 'preset.qwen', kind: 'openai', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  moonshot: { label: 'Moonshot / Kimi', kind: 'openai', base_url: 'https://api.moonshot.cn/v1', model: '', models: [] },
  ollama: { labelKey: 'preset.ollama', kind: 'openai', base_url: 'http://localhost:11434/v1', model: '', models: [], noteKey: 'note.ollama' },
  custom: { labelKey: 'preset.custom', kind: 'openai', base_url: '', model: '', models: [] },
  fake: { labelKey: 'preset.fake', kind: 'fake', base_url: '', model: 'fake', models: [], devOnly: true, noteKey: 'note.fake' },
};

const presetLabel = (p) => p.label || t(p.labelKey);

let serverConfig = { levels: [], default_level: 'B1', allow_fake: false };
const CONFIG_KEY = 'lingolens.config';

// The signed-in user's model settings, as the server reports them: the active
// preset, its configuration, and whether a key is saved (never the key itself).
function activeModel() {
  const m = state.model || {};
  const preset = m.active || '';
  const conf = m.providers?.[preset] || {};
  return {
    preset,
    kind: conf.kind || PRESETS[preset]?.kind || '',
    model: conf.model || '',
    hasKey: !!m.has_key?.[preset],
  };
}

function providerProblem() {
  const m = activeModel();
  if (!m.preset) return t('problem.noModel');
  if (m.kind === 'fake') return serverConfig.allow_fake ? '' : t('problem.fake');
  if (m.kind === 'anthropic' && !m.hasKey) return t('problem.anthropicKey');
  if (m.kind === 'openai' && !m.model) return t('problem.model');
  return '';
}

// ------------------------------------------------------------------ state

const state = {
  me: null, // the signed-in user
  prefs: { level: 'B1', lang: 'en', readSize: 'm', readWidth: 'm', theme: 'system', readFont: 'literata', glossFont: 'sans' },
  model: null,
  books: [], // the shelf, without content
  segments: new Map(), // id -> { el, text }
  anns: [], // index -> { ...annotation, segId }
  known: new Set(),
  wordbook: [],
  chat: null,
  book: null, // the open book in the reader
  activeAnn: null,
};

// Show a spinner on a button while its request runs.
function busy(btn, on) {
  btn.disabled = on;
  if (on) btn.setAttribute('aria-busy', 'true');
  else btn.removeAttribute('aria-busy');
}

// Save profile changes; the UI has already applied them. Offline they wait in
// the outbox.
function savePrefs(patch) {
  Object.assign(state.prefs, patch);
  queuePrefs(patch).catch((err) => showBanner(err.message));
}

// ------------------------------------------------------------------ helpers

function renderMarkdown(src) {
  return DOMPurify.sanitize(marked.parse(src, { gfm: true }));
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sentenceAround(text, start, end) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const s = Math.max(before.search(/[^.!?。！？]*$/), 0);
  const m = after.match(/^[^.!?。！？]*[.!?。！？]?["”’)]?/);
  return (before.slice(s) + text.slice(start, end) + (m ? m[0] : '')).replace(/\s+/g, ' ').trim();
}

function showBanner(text, kind = 'error', { settingsLink = false } = {}) {
  $('#banner-text').textContent = text;
  $('#banner').className = `banner ${kind === 'info' ? 'info' : ''}`;
  $('#banner-action').hidden = !settingsLink || document.body.dataset.view === 'settings';
  $('#banner').hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

// ------------------------------------------------------------------ segmentation

const BLOCK_SEL = 'p,li,h1,h2,h3,h4,h5,h6,td,th,dt,dd,blockquote,figcaption';

// Text nodes that belong directly to `block` (not to a nested block, not to <rt>, not in <pre>).
function ownTextNodes(block) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || p.closest('rt, pre, script, style')) return NodeFilter.FILTER_REJECT;
      return p.closest(BLOCK_SEL) === block ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function collectSegments(root) {
  state.segments.clear();
  let i = 0;
  for (const el of root.querySelectorAll(BLOCK_SEL)) {
    if (el.closest('pre')) continue;
    const text = ownTextNodes(el).map((n) => n.data).join('');
    if (!/[A-Za-z]{2,}/.test(text)) continue;
    const id = `s${i++}`;
    el.dataset.seg = id;
    state.segments.set(id, { el, text });
  }
}

// ------------------------------------------------------------------ annotation rendering

const rubyEl = (idx) => document.querySelector(`ruby.ann[data-ann="${idx}"]`);

function applyAnnotations(segId, anns) {
  const seg = state.segments.get(segId);
  if (!seg || !anns?.length) return;
  let pos = 0;
  const spans = ownTextNodes(seg.el).map((n) => {
    const s = pos;
    pos += n.data.length;
    return { n, s, e: pos };
  });
  // Wrap from the end so earlier offsets stay valid while nodes are split.
  for (const a of [...anns].sort((x, y) => y.start - x.start)) {
    const sp = spans.find((x) => a.start >= x.s && a.end <= x.e);
    if (!sp || sp.n.parentElement.closest('code, ruby')) continue; // e.g. already looked up by the user
    const node = sp.n;
    const local = a.start - sp.s;
    if (node.data.slice(local, a.end - sp.s) !== a.text) continue; // offsets drifted; skip
    node.splitText(a.end - sp.s);
    const mid = node.splitText(local);
    const idx = state.anns.push({ ...a, segId }) - 1;
    mid.replaceWith(makeRuby(mid.data, a, idx));
  }
}

function makeRuby(text, a, idx) {
  const ruby = document.createElement('ruby');
  ruby.className = `ann ann-${a.kind === 'phrase' ? 'phrase' : 'word'}`;
  if (state.known.has(a.lemma.toLowerCase())) ruby.classList.add('known');
  ruby.dataset.ann = String(idx);
  ruby.append(text);
  if (a.zh) {
    const rt = document.createElement('rt');
    rt.textContent = a.zh;
    ruby.append(rt);
  }
  return ruby;
}

function setGloss(idx) {
  const el = rubyEl(idx);
  const a = state.anns[idx];
  if (!el || !a?.zh) return;
  let rt = el.querySelector('rt');
  if (!rt) {
    rt = document.createElement('rt');
    el.append(rt);
  }
  rt.textContent = a.zh;
}

function refreshKnownMarks() {
  for (const el of document.querySelectorAll('ruby.ann')) {
    const a = state.anns[+el.dataset.ann];
    el.classList.toggle('known', !!a && state.known.has(a.lemma.toLowerCase()));
  }
}

// ------------------------------------------------------------------ annotate flow (lazy)

// Paragraphs are annotated only when they come near the viewport, in batches of
// about LAZY.batchChars characters, so a long article never spends tokens on parts
// that are not read. The server additionally caches results per paragraph.
const LAZY = { batchChars: 1800, maxInFlight: 2, rootMargin: '1000px 0px' };
const lazy = { gen: 0, observer: null, queue: [], inFlight: 0, ctls: new Set(), lastError: '' };

function resetLazy() {
  lazy.gen++;
  lazy.observer?.disconnect();
  lazy.observer = null;
  for (const c of lazy.ctls) c.abort();
  lazy.ctls.clear();
  lazy.queue = [];
  lazy.inFlight = 0;
  lazy.lastError = '';
  updateProgress();
}

function updateProgress() {
  const segs = [...state.segments.values()];
  const done = segs.filter((s) => s.status === 'done' || s.status === 'failed').length;
  $('#progress').hidden = lazy.inFlight === 0;
  $('#progress-fill').style.width = segs.length ? `${(100 * done) / segs.length}%` : '0';
  $('#progress-text').textContent = t('progress', { done, total: segs.length });
}

function startAnnotating() {
  resetLazy();
  const problem = providerProblem();
  if (problem) {
    showBanner(t('banner.noAnn', { problem }), 'error', { settingsLink: true });
    return;
  }
  lazy.observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      lazy.observer.unobserve(en.target);
      const id = en.target.dataset.seg;
      const seg = state.segments.get(id);
      if (seg && seg.status !== 'done') {
        seg.status = 'queued';
        seg.el.classList.remove('seg-failed');
        lazy.queue.push(id);
      }
    }
    pump();
  }, { rootMargin: LAZY.rootMargin });
  for (const seg of state.segments.values()) {
    if (seg.status !== 'done') lazy.observer.observe(seg.el);
  }
}

function pump() {
  const gen = lazy.gen;
  lazy.queue.sort((a, b) => +a.slice(1) - +b.slice(1)); // reading order
  while (lazy.inFlight < LAZY.maxInFlight && lazy.queue.length) {
    const batch = [];
    let size = 0;
    while (lazy.queue.length) {
      const len = state.segments.get(lazy.queue[0]).text.length;
      if (batch.length && size + len > LAZY.batchChars) break;
      batch.push(lazy.queue.shift());
      size += len;
    }
    runBatch(batch, gen);
  }
}

function finishSegment(id, ok) {
  const seg = state.segments.get(id);
  if (!seg) return;
  seg.status = ok ? 'done' : 'failed';
  seg.el.classList.toggle('seg-failed', !ok);
}

async function runBatch(ids, gen) {
  const ctl = new AbortController();
  lazy.ctls.add(ctl);
  lazy.inFlight++;
  updateProgress();
  const level = getLevel();
  const pending = new Set(ids);
  // Paragraphs glossed before come from this browser, without the network.
  const saved = await cachedAnns(level, ids.map((id) => state.segments.get(id).text));
  if (gen !== lazy.gen) return;
  for (const id of ids) {
    const anns = saved.get(state.segments.get(id).text);
    if (!anns) continue;
    applyAnnotations(id, anns);
    finishSegment(id, true);
    pending.delete(id);
  }
  let offline = false;
  try {
    if (!pending.size) return;
    if (!net.online) {
      offline = true;
      return;
    }
    const events = await postStream('/api/annotate', {
      level,
      segments: [...pending].map((id) => ({ id, text: state.segments.get(id).text })),
    }, ctl.signal);
    for await (const ev of events) {
      if (gen !== lazy.gen) return;
      if (ev.type === 'segment') {
        const seg = state.segments.get(ev.id);
        if (seg) saveAnns(level, seg.text, ev.annotations);
        applyAnnotations(ev.id, ev.annotations);
        finishSegment(ev.id, true);
        pending.delete(ev.id);
      } else if (ev.type === 'error') {
        lazy.lastError = ev.error;
        for (const id of ev.ids || []) {
          finishSegment(id, false);
          pending.delete(id);
        }
      }
      updateProgress();
    }
  } catch (err) {
    if (err.name === 'AbortError' || gen !== lazy.gen) return;
    // Lost the connection (or the stream broke off): try again once back online.
    if (err.offline || err instanceof TypeError) offline = true;
    else lazy.lastError = err.message;
  } finally {
    lazy.ctls.delete(ctl);
    if (gen === lazy.gen) finishBatch(pending, offline);
  }
}

function finishBatch(pending, offline) {
  lazy.inFlight--;
  for (const id of pending) {
    const seg = state.segments.get(id);
    if (offline && seg) {
      seg.status = 'waiting'; // glossed when the connection is back (see 'netchange')
    } else {
      finishSegment(id, false);
    }
  }
  updateProgress();
  if (offline) return;
  if (lazy.lastError) {
    const msg = lazy.lastError;
    showBanner(t('banner.annFail', { msg }));
    if (/key|auth|401|403/i.test(msg)) {
      resetLazy(); // stop hammering the provider with a bad key
      showBanner(t('banner.annFail', { msg }), 'error', { settingsLink: true });
      return;
    }
    lazy.lastError = '';
  }
  pump();
}

// ------------------------------------------------------------------ reader

// Plain text: blank lines separate paragraphs; single line breaks are kept.
// The "\n" before each <br> keeps words on either side apart in the segment text.
function renderPlainText(src) {
  return src.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim())
    .map((p) => `<p>${p.split('\n').map(escapeHTML).join('<br>\n')}</p>`)
    .join('\n');
}

function renderSource(book) {
  return book.format === 'markdown' ? renderMarkdown(book.content) : renderPlainText(book.content);
}

let returnTo = '#/'; // where "Back" on the settings page goes

// The header gets its bottom line once content scrolls underneath it.
function markScrolled() {
  document.body.classList.toggle('scrolled', window.scrollY > 2);
}

function setView(view) {
  document.body.dataset.view = view;
  requestAnimationFrame(markScrolled);
  if (view !== 'reader') hideHint();
  if (view !== 'settings' && !$('#token-new').hidden) { // don't leave a token on screen
    $('#token-new').hidden = true;
    $('#tk-env').textContent = '';
  }
  $('#library-view').hidden = view !== 'library';
  $('#reader-view').hidden = view !== 'reader';
  $('#settings-view').hidden = view !== 'settings';
  $('#clip-view').hidden = view !== 'clip';
  $('#login-view').hidden = view !== 'login';
  if (view === 'settings') $('#banner-action').hidden = true; // already here
  renderCrumbs(view);
}

// Header breadcrumb after the logo: Shelf / book, or Shelf / (book /) Settings.
// Labels with an i18n key follow language changes through applyI18n.
function renderCrumbs(view) {
  const items = [{ key: 'reader.back', href: '#/', home: true }];
  if (view === 'reader' && state.book) items.push({ label: state.book.title });
  if (view === 'settings') {
    const m = returnTo.match(/^#\/read\/([^/]+)$/);
    const id = m && decodeURIComponent(m[1]);
    const book = id && ([state.book, ...(state.books || [])].find((b) => b && String(b.id) === id));
    if (book) items.push({ label: book.title, href: returnTo });
    items.push({ key: 'settings.page' });
  }
  if (view === 'clip') items.push({ key: 'clip.crumb' });
  $('#crumbs ol').replaceChildren(...items.map((c, i) => {
    const li = document.createElement('li');
    li.className = c.home ? 'crumb-home' : c.key ? '' : 'crumb-title';
    const el = document.createElement(c.href ? 'a' : 'span');
    el.className = 'crumb';
    if (c.href) el.href = c.href;
    if (i === items.length - 1) el.setAttribute('aria-current', 'page');
    if (c.key) { el.dataset.i18n = c.key; el.textContent = t(c.key); }
    else { el.textContent = c.label; el.title = c.label; }
    li.append(el);
    return li;
  }));
}

function bookStat(book, level = getLevel()) {
  if (isFinished(book)) return t('book.finished');
  const m = minutesLeft(book, level);
  const p = Math.floor((book.progress || 0) * 100);
  return p > 0 ? t('book.left', { p, m }) : t('book.minRead', { m });
}

function updateBookStat() {
  if (state.book) $('#book-stat').textContent = [bookStat(state.book), expiryText(state.book)].filter(Boolean).join(' · ');
}

// Texts with a time to live: whole days left, rounded up (0 once it has run out).
const daysLeft = (b) => Math.max(0, Math.ceil((Date.parse(b.expiresAt) - Date.now()) / 864e5));
const isExpired = (b) => !!b.expiresAt && Date.parse(b.expiresAt) <= Date.now();

function expiryText(b) {
  if (!b.expiresAt) return '';
  const n = daysLeft(b);
  return n <= 1 ? t('book.expiresSoon') : t('book.expires', { n });
}

// The "Delete automatically" choices; editing a text that has a time already
// offers to leave it as it is.
const TTL_CHOICES = [0, 1, 7, 30, 90, 365];
function fillTTL(book) {
  const sel = $('#src-ttl');
  const label = (n) => (n === 0 ? t('ttl.never') : n === 1 ? t('ttl.day') : n === 365 ? t('ttl.year') : t('ttl.days', { n }));
  const opts = TTL_CHOICES.map((n) => `<option value="${n}">${escapeHTML(label(n))}</option>`);
  if (book?.expiresAt) opts.unshift(`<option value="keep">${escapeHTML(t('ttl.current', { d: shortDate(book.expiresAt) }))}</option>`);
  sel.innerHTML = opts.join('');
  sel.value = book?.expiresAt ? 'keep' : '0';
}

// The chosen time to live: days, or undefined to leave it as it is.
function chosenTTL() {
  const v = $('#src-ttl').value;
  return v === 'keep' ? undefined : Number(v);
}

let openSeq = 0; // ignores a slow load if the reader has moved on

// keepPlace: reopening the same text after it changed; stay where the reader is.
async function openBook(id, { keepPlace = false } = {}) {
  const seq = ++openSeq;
  const placeY = window.scrollY;
  flushProgress();
  let book;
  try {
    book = await getBook(id);
  } catch (err) {
    if (seq !== openSeq) return;
    if (err.status !== 401) showBanner(err.message);
    if (err.status === 404 || err.offline) location.hash = '#/';
    return;
  }
  if (seq !== openSeq) return;
  state.book = book;
  closeCard();
  hideFab();
  hideBanner();
  setView('reader');
  document.title = `${book.title} – LingoLens`;
  $('#book-title').textContent = book.title;
  updateBookStat();

  resetLazy();
  const article = $('#article');
  article.innerHTML = renderSource(book);
  for (const a of article.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  state.anns = [];
  collectSegments(article);
  buildContents(article);

  // Return to where the reader left off.
  requestAnimationFrame(() => {
    const top = article.getBoundingClientRect().top + window.scrollY;
    if (keepPlace) window.scrollTo(0, placeY);
    else window.scrollTo(0, book.pos > 0 ? top + book.pos * article.offsetHeight - 96 : 0);
    trackReading(false);
    armShortTextTimer();
  });
  startAnnotating();
  maybeShowHint();
}

// A table of contents for long texts with sections (EPUB chapters, long articles).
function buildContents(article) {
  const heads = [...article.querySelectorAll('h1, h2, h3')];
  // Skip a single top heading that just repeats the title.
  const top = Math.min(...heads.map((h) => +h.tagName[1]));
  const list = $('#toc-list');
  list.innerHTML = '';
  $('#btn-toc').hidden = heads.length < 3;
  heads.forEach((h, i) => {
    h.id ||= `sec-${i + 1}`;
    const li = document.createElement('li');
    li.className = `lv${+h.tagName[1] - top + 1}`;
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.dataset.target = h.id;
    a.textContent = h.textContent.trim();
    li.append(a);
    list.append(li);
  });
}

function openContents() {
  // Mark the section being read: the last heading above the top of the screen.
  let current = null;
  for (const a of $('#toc-list').querySelectorAll('a')) {
    const h = document.getElementById(a.dataset.target);
    a.removeAttribute('aria-current');
    if (h && h.getBoundingClientRect().top < 120) current = a;
  }
  current?.setAttribute('aria-current', 'true');
  $('#toc-dialog').showModal();
  (current || $('#toc-list a'))?.scrollIntoView({ block: 'center' });
  (current || $('#toc-list a'))?.focus();
}

function showLibrary() {
  flushProgress();
  state.book = null;
  resetLazy();
  closeCard();
  hideFab();
  closeChat();
  setView('library');
  document.title = 'LingoLens';
  renderShelf();
  loadShelf(); // refresh progress and anything changed on another device
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ reading progress

let saveTimer = 0;
let shortTextTimer = 0;

// Where the viewport is within the article. Progress only counts once the reader
// scrolls, so opening a book doesn't mark its first screen as read.
function trackReading(count = true) {
  const book = state.book;
  if (!book) return;
  const a = $('#article');
  const r = a.getBoundingClientRect();
  const h = a.offsetHeight || 1;
  const pos = Math.min(1, Math.max(0, -r.top / h));
  const seen = Math.min(1, Math.max(0, (window.innerHeight - r.top) / h));
  $('#read-thread > div').style.width = `${Math.round(Math.max(seen, book.progress || 0) * 100)}%`;
  book.pos = pos;
  if (!count) return;
  book.progress = Math.max(book.progress || 0, seen > 0.985 ? 1 : seen);
  updateBookStat();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushProgress, 400);
}

function flushProgress({ closing = false } = {}) {
  clearTimeout(saveTimer);
  clearTimeout(shortTextTimer);
  const b = state.book;
  if (!b || (b.pos === b.savedPos && b.progress === b.savedProgress)) return;
  b.savedPos = b.pos;
  b.savedProgress = b.progress;
  saveProgress(b.id, b.pos || 0, b.progress || 0, { closing });
}

// A text that fits on one screen can't be scrolled; count it as read after
// half its estimated reading time.
function armShortTextTimer() {
  clearTimeout(shortTextTimer);
  const book = state.book;
  if (!book || document.documentElement.scrollHeight > window.innerHeight + 8) return;
  const ms = Math.min(120_000, minutesLeft(book, getLevel()) * 30_000);
  shortTextTimer = setTimeout(() => { if (state.book === book) trackReading(true); }, ms);
}

// ------------------------------------------------------------------ click any word to look it up

// Find the English word under the pointer in a plain (un-annotated) text node.
function wordAtPoint(x, y) {
  let node;
  let offset;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    node = p.offsetNode;
    offset = p.offset;
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (!r) return null;
    node = r.startContainer;
    offset = r.startOffset;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const parent = node.parentElement;
  if (!parent || parent.closest('ruby, rt, code, pre, a')) return null;
  const block = parent.closest(BLOCK_SEL);
  if (!block?.dataset.seg) return null;

  const text = node.data;
  const isWordChar = (ch) => /[A-Za-z'’-]/.test(ch);
  let s = offset;
  let e = offset;
  while (s > 0 && isWordChar(text[s - 1])) s--;
  while (e < text.length && isWordChar(text[e])) e++;
  while (s < e && /['’-]/.test(text[s])) s++;
  while (e > s && /['’-]/.test(text[e - 1])) e--;
  if (e - s < 2) return null;

  // Make sure the pointer is actually on the word, not in the margin next to it.
  const range = document.createRange();
  range.setStart(node, s);
  range.setEnd(node, e);
  const hit = [...range.getClientRects()].some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);
  return hit ? { node, s, e, block } : null;
}

function lookupWordAt(w) {
  const { node, s, e, block } = w;
  let base = 0;
  for (const n of ownTextNodes(block)) {
    if (n === node) break;
    base += n.data.length;
  }
  node.splitText(e);
  const mid = node.splitText(s);
  const a = {
    start: base + s, end: base + e, text: mid.data, kind: 'word',
    lemma: mid.data, ipa: '', pos: '', zh: '', segId: block.dataset.seg, lookup: true,
  };
  const idx = state.anns.push(a) - 1;
  const ruby = makeRuby(mid.data, a, idx);
  mid.replaceWith(ruby);
  openCard(ruby);
  fetchDetail(idx);
}

async function fetchDetail(idx) {
  const a = state.anns[idx];
  if (!a || a.loading) return;
  const problem = providerProblem();
  if (problem) {
    a.error = problem;
    renderCard();
    showBanner(problem, 'error', { settingsLink: true });
    return;
  }
  a.loading = true;
  a.error = '';
  renderCard();
  const seg = state.segments.get(a.segId);
  const level = getLevel();
  const sentence = seg ? sentenceAround(seg.text, a.start, a.end) : a.text;
  try {
    // Looked up before in this sentence: no need to ask again. Offline, an
    // explanation from another sentence is better than none.
    let data = await cachedLookup(level, a.text, sentence, { anySentence: !net.online });
    if (!data) {
      data = await api('POST', '/api/lookup', { level, term: a.text, sentence });
      saveLookup(level, a.text, sentence, data);
    }
    a.entry = data;
    a.ipa ||= data.ipa || '';
    a.pos ||= data.pos || '';
    if (!a.zh) {
      a.zh = data.zh;
      a.lemma = data.lemma || a.text;
      setGloss(idx);
      refreshKnownMarks();
    }
  } catch (err) {
    a.error = err.offline ? t('net.lookupOffline') : err.message;
  } finally {
    a.loading = false;
  }
  if (state.activeAnn === idx) renderCard();
}

// ------------------------------------------------------------------ word card

function entryHTML(e) {
  const list = (items, fn) => `<ul>${items.map(fn).join('')}</ul>`;
  const parts = [];
  if (e.explanation) parts.push(`<p class="expl">${escapeHTML(e.explanation)}</p>`);
  if (e.senses?.length) {
    parts.push(`<h4>${t('card.senses')}</h4>` + list(e.senses, (s) =>
      `<li><i>${escapeHTML(s.pos)}</i> ${escapeHTML(s.zh)} <span class="muted">${escapeHTML(s.en)}</span></li>`));
  }
  if (e.collocations?.length) {
    parts.push(`<h4>${t('card.collocations')}</h4>` + list(e.collocations, (c) =>
      `<li>${escapeHTML(c.en)} <span class="muted">${escapeHTML(c.zh)}</span></li>`));
  }
  if (e.examples?.length) {
    parts.push(`<h4>${t('card.examples')}</h4>` + list(e.examples, (x) =>
      `<li>${escapeHTML(x.en)}<br><span class="muted">${escapeHTML(x.zh)}</span></li>`));
  }
  return `<div class="detail">${parts.join('')}</div>`;
}

function cardHTML(a) {
  const key = a.lemma.toLowerCase();
  const known = state.known.has(key);
  const saved = state.wordbook.some((w) => w.key === key);
  let body = '';
  if (a.loading) body = `<div class="detail muted">${t('card.loading')}</div>`;
  else if (a.error) body = `<div class="detail error">${escapeHTML(a.error)}</div>`;
  else if (a.entry) body = entryHTML(a.entry);
  const speak = 'speechSynthesis' in window
    ? `<button class="btn small ghost speak" data-act="speak" title="${t('card.speak')}">🔊</button>` : '';
  return `
    <div class="head">
      <span class="lemma">${escapeHTML(a.lemma)}</span>
      ${a.ipa ? `<span class="ipa">/${escapeHTML(a.ipa)}/</span>` : ''}
      ${a.pos ? `<span class="pos">${escapeHTML(a.pos)}</span>` : ''}
    </div>
    ${a.zh ? `<div class="zh">${escapeHTML(a.zh)}</div>` : ''}
    ${a.zh && a.text.toLowerCase() !== key ? `<div class="surface">${escapeHTML(t('card.surface', { t: a.text }))}</div>` : ''}
    ${body}
    <div class="actions">
      ${!a.entry && !a.loading ? `<button class="btn small" data-act="detail">${t(a.error ? 'card.retry' : 'card.details')}</button>` : ''}
      ${a.zh ? `<button class="btn small" data-act="save">${t(saved ? 'card.saved' : 'card.save')}</button>` : ''}
      ${a.zh ? `<button class="btn small" data-act="known">${t(known ? 'card.unknown' : 'card.known')}</button>` : ''}
      <button class="btn small" data-act="ask">${t('ask')}</button>
      ${speak}
    </div>`;
}

function openCard(el) {
  const idx = +el.dataset.ann;
  if (!state.anns[idx]) return;
  dismissHint();
  closeCard();
  state.activeAnn = idx;
  el.classList.add('active');
  renderCard();
}

function renderCard() {
  const idx = state.activeAnn;
  const a = state.anns[idx];
  const el = rubyEl(idx);
  if (idx == null || !a || !el) return;
  const card = $('#card');
  card.innerHTML = cardHTML(a);
  card.hidden = false;
  positionNear(card, el.getBoundingClientRect());
}

function closeCard() {
  $('#card').hidden = true;
  document.querySelector('ruby.ann.active')?.classList.remove('active');
  state.activeAnn = null;
}

function positionNear(el, rect, above = false) {
  const margin = 8;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = rect.left + window.scrollX + rect.width / 2 - w / 2;
  left = Math.max(window.scrollX + 16, Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 16));
  let top = above ? rect.top + window.scrollY - h - margin : rect.bottom + window.scrollY + margin;
  if (!above && rect.bottom + h + margin > window.innerHeight && rect.top - h - margin > 60) {
    top = rect.top + window.scrollY - h - margin;
  }
  if (above && rect.top - h - margin < 60) top = rect.bottom + window.scrollY + margin;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function onCardAction(act) {
  const idx = state.activeAnn;
  const a = state.anns[idx];
  if (!a) return;
  const key = a.lemma.toLowerCase();
  const seg = state.segments.get(a.segId);
  if (act === 'detail') {
    fetchDetail(idx);
  } else if (act === 'known') {
    const known = !state.known.has(key);
    if (known) state.known.add(key);
    else state.known.delete(key);
    setKnown(key, known).catch((err) => showBanner(err.message));
    refreshKnownMarks();
    closeCard();
  } else if (act === 'save') {
    const i = state.wordbook.findIndex((w) => w.key === key);
    if (i >= 0) {
      state.wordbook.splice(i, 1);
      deleteWord(key).catch((err) => showBanner(err.message));
    } else {
      const entry = {
        key, lemma: a.lemma, text: a.text, zh: a.zh, ipa: a.ipa || '', pos: a.pos || '', kind: a.kind,
        note: a.entry?.explanation || '',
        context: seg ? sentenceAround(seg.text, a.start, a.end) : '', added: new Date().toISOString(),
      };
      state.wordbook.unshift(entry);
      putWord(entry).catch((err) => showBanner(err.message));
    }
    updateWordbookBadge();
    renderCard();
  } else if (act === 'ask') {
    const sentence = seg ? sentenceAround(seg.text, a.start, a.end) : a.text;
    closeCard();
    openChat(sentence, seg?.text || sentence, t('chat.askWord', { w: a.text }));
  } else if (act === 'speak') {
    const u = new SpeechSynthesisUtterance(a.text);
    u.lang = 'en-US';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
}

// ------------------------------------------------------------------ selection -> ask AI

// Selected text without the Chinese glosses inside <rt>.
function cleanSelectionText(range) {
  const frag = range.cloneContents();
  frag.querySelectorAll('rt').forEach((rt) => rt.remove());
  return frag.textContent.replace(/\s+/g, ' ').trim();
}

function selectionInfo() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const article = $('#article');
  if (!article.contains(range.commonAncestorContainer)) return null;
  const text = cleanSelectionText(range);
  if (text.length < 2 || !/[A-Za-z]/.test(text)) return null;
  const segOf = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-seg]');
  const ids = [...new Set([segOf(range.startContainer), segOf(range.endContainer)].filter(Boolean).map((e) => e.dataset.seg))];
  const passage = ids.map((id) => state.segments.get(id)?.text || '').join('\n\n').trim() || text;
  return { text, passage, rect: range.getBoundingClientRect() };
}

function maybeShowFab() {
  const info = selectionInfo();
  if (!info) return hideFab();
  const fab = $('#ask-fab');
  fab.hidden = false;
  fab._info = info;
  // Mouse: just above the selection. Touch: docked at the bottom of the screen,
  // clear of the system's Copy / Look Up menu, which iOS and Android put above or
  // below the selection depending on the room there.
  const docked = isTouch();
  fab.classList.toggle('docked', docked);
  if (docked) fab.style.left = fab.style.top = '';
  else positionNear(fab, info.rect, true);
}
function hideFab() { $('#ask-fab').hidden = true; }

const isTouch = () => matchMedia('(pointer: coarse)').matches;

// ------------------------------------------------------------------ first-run hint

// Shown once per browser, the first time someone opens a text; gone for good after
// "Got It", or as soon as they look up a word or ask AI (they've found the features).
const HINT_KEY = 'lingolens.hint.reader';
let hintTimer = 0;

function hintSeen() {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return true; }
}

function maybeShowHint() {
  clearTimeout(hintTimer);
  if (hintSeen()) return;
  hintTimer = setTimeout(() => {
    if (document.body.dataset.view !== 'reader' || hintSeen()) return;
    const word = $('#hint-word');
    word.dataset.i18n = isTouch() ? 'hint.tap' : 'hint.click';
    word.textContent = t(word.dataset.i18n);
    const el = $('#hint');
    el.classList.remove('leaving');
    el.hidden = false;
  }, 1200);
}

function hideHint() {
  clearTimeout(hintTimer);
  const el = $('#hint');
  if (el.hidden) return;
  el.classList.add('leaving');
  setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); }, 200);
}

function dismissHint() {
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ }
  hideHint();
}

// ------------------------------------------------------------------ chat


function openChat(selection, passage, autoQuestion) {
  dismissHint();
  state.chat?.ctl?.abort();
  state.chat = { selection, passage, messages: [], ctl: null };
  $('#chat-quote').textContent = selection;
  $('#chat-log').innerHTML = '';
  renderChips();
  $('#chat').hidden = false;
  document.body.classList.add('chat-open');
  if (autoQuestion) sendChat(autoQuestion);
  else $('#chat-input').focus();
}

function renderChips() {
  const chips = $('#chat-chips');
  chips.innerHTML = '';
  for (const c of t('chat.chips')) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = c;
    b.onclick = () => sendChat(c);
    chips.append(b);
  }
}

function closeChat() {
  state.chat?.ctl?.abort();
  $('#chat').hidden = true;
  document.body.classList.remove('chat-open');
}

function addBubble(role, text = '') {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role !== 'assistant') div.textContent = text; // the answer is rendered as Markdown later
  $('#chat-log').append(div);
  div.scrollIntoView({ block: 'end' });
  return div;
}

async function sendChat(question) {
  const chat = state.chat;
  question = question.trim();
  if (!chat || !question || chat.ctl) return;
  const problem = providerProblem();
  if (problem) {
    addBubble('error', problem);
    showBanner(problem, 'error', { settingsLink: true });
    return;
  }
  if (!net.online) {
    addBubble('error', t('net.chatOffline'));
    return;
  }
  chat.messages.push({ role: 'user', content: question });
  addBubble('user', question);
  const bubble = addBubble('assistant');
  bubble.classList.add('pending');
  $('#chat-input').value = '';
  setChatBusy(true);

  const ctl = new AbortController();
  chat.ctl = ctl;
  let answer = '';
  let error = '';
  let raf = 0;
  const paint = () => {
    raf = 0;
    bubble.innerHTML = renderMarkdown(answer);
    const log = $('#chat-log');
    if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
  };
  try {
    const events = await postStream('/api/chat', {
      level: getLevel(), passage: chat.passage, selection: chat.selection, messages: chat.messages,
    }, ctl.signal);
    for await (const ev of events) {
      if (ev.type === 'delta') {
        answer += ev.text;
        if (!raf) raf = requestAnimationFrame(paint);
      } else if (ev.type === 'error') {
        error = ev.error;
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') error = err.message;
  }
  if (raf) cancelAnimationFrame(raf);
  paint();
  bubble.classList.remove('pending');
  if (state.chat !== chat) return; // chat was replaced meanwhile
  chat.ctl = null;
  setChatBusy(false);
  if (answer) {
    chat.messages.push({ role: 'assistant', content: answer });
  } else {
    chat.messages.pop(); // keep user/assistant alternation for the next turn
    bubble.remove();
  }
  if (error) addBubble('error', error);
}

function setChatBusy(busy) {
  const btn = $('#chat-send');
  btn.textContent = t(busy ? 'chat.stop' : 'chat.send');
  btn.classList.toggle('primary', !busy);
}

// ------------------------------------------------------------------ settings page

function fillPresetOptions() {
  const sel = $('#s-preset');
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(PRESETS)) {
    if (p.devOnly && !serverConfig.allow_fake) continue;
    sel.append(new Option(presetLabel(p), id));
  }
}

// The key field never shows a saved key: the server keeps it and only says
// whether one is set. Typing a new key replaces it; "Remove key" deletes it.
function loadPresetIntoForm(preset) {
  const p = PRESETS[preset];
  const saved = state.model?.providers?.[preset];
  const hasKey = !!state.model?.has_key?.[preset];
  $('#s-base').value = saved ? saved.base_url : p.base_url;
  $('#s-base').placeholder = p.kind === 'anthropic' ? t('settings.anthropicBase') : 'https://…/v1';
  $('#s-model').value = saved ? saved.model : p.model;
  $('#s-key').value = '';
  $('#s-key').placeholder = hasKey ? t('settings.keySaved') : 'sk-…';
  $('#s-key').type = 'password';
  $('#s-key-toggle').textContent = t('settings.show');
  $('#s-key-remove').hidden = !hasKey;
  const dl = $('#s-models');
  dl.innerHTML = '';
  for (const m of p.models) dl.append(new Option(m));
  $('#s-note').textContent = p.noteKey ? t(p.noteKey) : '';
  const disabled = p.kind === 'fake';
  for (const id of ['#s-base', '#s-model', '#s-key']) $(id).disabled = disabled;
}

function loadModelForm() {
  fillPresetOptions();
  const active = state.model?.active;
  $('#s-preset').value = PRESETS[active] ? active : 'deepseek';
  loadPresetIntoForm($('#s-preset').value);
  $('#s-status').textContent = '';
}

async function saveModel({ removeKey = false } = {}) {
  const preset = $('#s-preset').value;
  const body = {
    preset,
    kind: PRESETS[preset].kind,
    base_url: $('#s-base').value.trim(),
    model: $('#s-model').value.trim(),
  };
  const key = $('#s-key').value.trim();
  if (removeKey) body.api_key = '';
  else if (key) body.api_key = key; // left empty: keep the saved key
  busy($('#s-save'), true);
  try {
    state.model = await api('PUT', '/api/me/model', body);
    loadPresetIntoForm(preset);
    hideBanner();
    $('#s-status').textContent = t(removeKey ? 'settings.keyRemoved' : 'settings.saved');
  } catch (err) {
    $('#s-status').textContent = err.message;
  } finally {
    busy($('#s-save'), false);
  }
}

// Profile: the English level as six cards, A1 to C2.
function renderProfileLevels() {
  const current = getLevel();
  $('#profile-levels').innerHTML = serverConfig.levels.map((l) => `
    <button type="button" class="level-card" role="radio" data-level="${l.id}" aria-checked="${l.id === current}">
      <span class="lc-code">${l.id}</span>
      <span class="lc-name">${escapeHTML(levelName(l))}</span>
      <span class="lc-hint">${escapeHTML(l.hint)}</span>
      <span class="lc-hint">${escapeHTML(t('level.words', { n: l.vocab.toLocaleString() }))}</span>
    </button>`).join('');
}

function showSettings() {
  flushProgress();
  state.book = null;
  resetLazy();
  closeCard();
  hideFab();
  closeChat();
  setView('settings');
  document.title = `${t('settings.page')} – LingoLens`;
  renderProfileLevels();
  markPressed('#lang-seg', 'lang', getLang());
  loadModelForm();
  renderAccount();
  $('#token-new').hidden = true; // a token is shown once, then gone
  $('#tk-env').textContent = '';
  loadTokens();
  renderBookmarklet();
  if (scrollToBookmarklet) $('#set-clip-h').closest('section').scrollIntoView({ block: 'start' });
  else window.scrollTo(0, 0);
  scrollToBookmarklet = false;
}

// ------------------------------------------------------------------ bookmarklet

// Some sites refuse requests from servers (HTTP 403), and some pages need the
// reader's own sign-in. The bookmarklet reads the page in the reader's browser
// instead: run on any page, it opens LingoLens at #/clip and hands that tab the
// page (or just the selected part) once the tab says it's ready. It posts only to
// this server's origin, and the tab asks before adding anything to the shelf.
let scrollToBookmarklet = false; // "Set it up" links open Settings at this section

function bookmarkletCode() {
  const app = location.origin + location.pathname;
  // Plain ES2017, no comments: it runs inside other people's pages. Scripts,
  // styles and frames are dropped to keep the message small.
  const js = `(()=>{const A=${JSON.stringify(app)},O=new URL(A).origin,d=document,`
    + `c=d.documentElement.cloneNode(true);`
    + `c.querySelectorAll('script,style,noscript,template,iframe,svg,canvas,object,embed,link').forEach(n=>n.remove());`
    + `let s='';const g=getSelection();`
    + `if(g&&!g.isCollapsed){const b=d.createElement('div');for(let i=0;i<g.rangeCount;i++)b.append(g.getRangeAt(i).cloneContents());s=b.innerHTML}`
    + `const p={type:'lingolens:page',url:location.href,title:d.title,html:'<!doctype html>'+c.outerHTML,selection:s},w=open(A+'#/clip');`
    + `if(!w){alert(${JSON.stringify(t('clip.popup'))});return}`
    + `const f=e=>{if(e.source===w&&e.origin===O&&e.data==='lingolens:ready')w.postMessage(p,O)};`
    + `addEventListener('message',f);setTimeout(()=>removeEventListener('message',f),6e5)})()`;
  return 'javascript:' + encodeURIComponent(js);
}

function renderBookmarklet() {
  const code = bookmarkletCode();
  $('#bm-link').href = code;
  $('#bm-code').textContent = code;
  $('#bm-status').textContent = '';
}

// #/clip: the page the bookmarklet sent, shown for a check before it's added.
let clip = null; // { url, title, html, selection, host, words }
let clipWaited = false;
let clipTimer = 0;

function receiveClip(e) {
  const d = e.data;
  if (!window.opener || e.source !== window.opener || d?.type !== 'lingolens:page') return;
  let from;
  try { from = new URL(d.url); } catch { return; }
  // A page may only speak for its own site, so the shelf can't be told a page
  // came from somewhere else.
  if (from.origin !== e.origin || !/^https?:$/.test(from.protocol) || typeof d.html !== 'string') return;
  // DOMParser makes inert documents: nothing in them runs or loads.
  const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
  const selection = typeof d.selection === 'string' ? d.selection : '';
  const words = selection ? (parse(selection).body.textContent.match(/\S+/g) || []).length : 0;
  const headings = [...parse(d.html).querySelectorAll('h1, h2')].map((h) => h.textContent);
  clip = {
    url: from.href, html: d.html, selection, words,
    title: sitelessTitle(String(d.title || '').trim().slice(0, 300), headings),
    host: from.hostname.replace(/^www\./, ''),
  };
  clearTimeout(clipTimer);
  if (document.body.dataset.view === 'clip') renderClip();
}

// Mirrors siteless in internal/importer: "Night Trains | The Journal" becomes
// "Night Trains" when that is also a heading on the page.
function sitelessTitle(title, headings) {
  const norm = (x) => x.replace(/\s+/g, ' ').trim().toLowerCase();
  const heads = new Set(headings.map(norm));
  for (const sep of [' | ', ' – ', ' — ', ' - ', ' · ', ' :: ']) {
    const last = title.lastIndexOf(sep);
    if (last < 0) continue;
    for (const head of [title.slice(0, last), title.slice(0, title.indexOf(sep))]) {
      if (head.trim() && heads.has(norm(head))) return head.trim();
    }
  }
  return title;
}

function showClip() {
  flushProgress();
  state.book = null;
  resetLazy();
  closeCard();
  hideFab();
  closeChat();
  hideBanner();
  setView('clip');
  document.title = `${t('clip.crumb')} – LingoLens`;
  $('#clip-error').textContent = '';
  clipWaited = false;
  if (!clip) {
    // Tell the bookmarklet's tab we're here; it answers with the page.
    window.opener?.postMessage('lingolens:ready', '*');
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => { clipWaited = true; renderClip(); }, window.opener ? 8000 : 0);
  }
  renderClip();
  window.scrollTo(0, 0);
}

function renderClip() {
  if (document.body.dataset.view !== 'clip') return;
  $('#clip-wait').hidden = !!clip || clipWaited;
  $('#clip-none').hidden = !!clip || !clipWaited;
  $('#clip-page').hidden = !clip;
  if (!clip) return;
  $('#clip-title').textContent = clip.title || clip.host;
  $('#clip-from').textContent = t('clip.from', { host: clip.host });
  $('#clip-what').textContent = clip.selection ? t('clip.selection', { n: clip.words.toLocaleString() }) : t('clip.article');
  $('#clip-save').focus();
}

async function saveClip() {
  const btn = $('#clip-save');
  busy(btn, true);
  $('#clip-error').textContent = '';
  let book;
  try {
    book = await importPage(clip);
  } catch (err) {
    busy(btn, false);
    $('#clip-error').textContent = err.message;
    return;
  }
  busy(btn, false);
  clip = null;
  location.replace(`#/read/${encodeURIComponent(book.id)}`); // Back shouldn't return here
}

function cancelClip() {
  clip = null;
  window.close(); // the bookmarklet opened this tab; closing returns to the page
  setTimeout(() => location.replace('#/'), 100); // if the browser keeps it open
}


// ------------------------------------------------------------------ wordbook dialog

function updateWordbookBadge() {
  $('#wb-count').textContent = state.wordbook.length ? String(state.wordbook.length) : '';
}

function renderWordbook() {
  const list = $('#wb-list');
  if (!state.wordbook.length) {
    list.innerHTML = `<div class="wb-empty">${escapeHTML(t('wb.empty'))}</div>`;
  } else {
    list.innerHTML = state.wordbook.map((w, i) => `
      <div class="wb-item">
        <div class="w">${escapeHTML(w.lemma)}<small>${w.ipa ? `/${escapeHTML(w.ipa)}/ ` : ''}${escapeHTML(w.pos)} ${escapeHTML(w.zh)}</small></div>
        <button class="btn small ghost del" data-del="${i}">${t('wb.delete')}</button>
        <div class="ctx">${escapeHTML(w.context)}</div>
      </div>`).join('');
  }
  $('#wb-known').textContent = t('wb.known', { n: state.known.size });
}

function exportCSV() {
  const rows = [['word', 'ipa', 'pos', 'chinese', 'context', 'added']];
  for (const w of state.wordbook) rows.push([w.lemma, w.ipa, w.pos, w.zh, w.context, w.added]);
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'lingolens-wordbook.csv' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ shelf

const SAMPLE_TITLE = 'Why Small Habits Matter';
const SAMPLE_TEXT = `Most people take for granted that big goals require big changes. In practice, by and large, the opposite is true: lasting progress tends to come from small, almost invisible adjustments that compound over time.

Consider someone who wants to read more. Rather than vowing to finish a book every week, they might commit to reading two pages after dinner. The task is so modest that it is hard to put off, and once the habit is established, it naturally expands.

Researchers point out a number of reasons this works. Small actions reduce the friction of getting started, so we are less likely to give up. Repetition makes behaviour automatic, freeing up attention for other things. And visible progress, however slight, reinforces our sense of identity as someone who follows through.

Of course, habits are not a panacea. They have to be taken into account alongside our circumstances, and when life gets hectic we may run out of energy for even the smallest routine. Still, in terms of sheer cost-effectiveness, few strategies come close.`;

// Draw the shelf from state.books; call loadShelf() to refresh from the server.
function renderShelf() {
  const books = state.books.filter((b) => !isExpired(b)); // the server deletes them; offline, hide them
  const level = getLevel();
  $('#shelf-empty').hidden = books.length > 0 || !state.booksLoaded;
  $('.shelf-head').hidden = books.length === 0;
  const left = books.reduce((sum, b) => sum + minutesLeft(b, level), 0);
  let summary = '';
  if (books.length && left === 0) summary = t('shelf.summaryDone');
  else if (books.length === 1) summary = t('shelf.summaryOne', { m: left, level });
  else if (books.length > 1) summary = t('shelf.summary', { n: books.length, m: left, level });
  $('#shelf-summary').textContent = summary;
  $('#shelf').innerHTML = books.map((b) => bookHTML(b, level)).join('');
}

function bookHTML(b, level) {
  const p = Math.floor((b.progress || 0) * 100);
  const done = isFinished(b);
  const title = escapeHTML(b.title);
  return `
    <article class="book">
      <a class="book-link" href="#/read/${encodeURIComponent(b.id)}">
        <div class="cover" data-tint="${tintFor(b.id)}">
          <span class="cover-top">
            <span class="cover-words" aria-hidden="true">${escapeHTML(t('book.words', { n: b.words.toLocaleString() }))}</span>
            ${b.expiresAt ? `<span class="cover-ttl" title="${escapeHTML(expiryText(b))}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>${escapeHTML(t('book.ttlShort', { n: daysLeft(b) }))}<span class="sr-only">, ${escapeHTML(expiryText(b))}</span></span>` : ''}
          </span>
          <span class="cover-title">${title}</span>
        </div>
      </a>
      <div class="book-meta">
        <span class="book-stat${done ? ' done' : ''}">${escapeHTML(bookStat(b, level))}</span>
        <button class="book-del" type="button" data-del-book="${escapeHTML(b.id)}"
          aria-label="${escapeHTML(t('book.delete'))}: ${title}" title="${escapeHTML(t('book.delete'))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
        </button>
      </div>
      ${p > 0 && !done ? `<div class="book-bar" aria-hidden="true"><div style="width:${p}%"></div></div>` : ''}
    </article>`;
}

// ------------------------------------------------------------------ add / edit source

let editingId = null;

// Kinds: pasted text (Markdown detected automatically), a web page, a file (an
// EPUB book, read by the server, or a PDF, read here).
let srcKind = 'text';
let srcFile = null;
let editingFormat = null;

function openSourceDialog(book = null) {
  editingId = book?.id || null;
  editingFormat = book?.format || null;
  $('#src-title').value = book?.title || '';
  $('#src-text').value = book?.content || '';
  fillTTL(book);
  $('#src-url').value = '';
  setSourceFile(null);
  setSourceKind('text');
  updateSrcCount();
  updateSourceOffline();
  $('#source-dialog').showModal();
  $('#src-text').focus();
}

function setSourceKind(kind) {
  srcKind = kind;
  for (const r of document.querySelectorAll('#src-kinds input')) r.checked = r.value === kind;
  for (const p of document.querySelectorAll('.src-panel')) p.hidden = p.dataset.kind !== kind;
  $('#src-error').textContent = '';
  labelSourceDialog();
}

function labelSourceDialog() {
  const editing = !!editingId;
  $('#source-heading').textContent = t(editing ? 'source.edit' : 'source.add');
  $('#src-kinds').hidden = editing;
  $('#src-save').textContent = t(editing ? 'source.saveEdit'
    : { text: 'source.save', url: 'source.saveUrl', file: srcFile && isPDF(srcFile) ? 'source.savePdf' : 'source.saveEpub' }[srcKind]);
  $('#src-title').placeholder = t({ text: 'source.titlePh', url: 'source.titleUrl', file: 'source.titleFile' }[srcKind]);
  // The sample is for getting started: offered only while the shelf is empty.
  $('#src-sample').hidden = editing || srcKind !== 'text' || state.books.length > 0;
  $('#src-delete').hidden = !editing;
  $('#src-count').hidden = srcKind !== 'text';
  if (srcFile) $('#src-file-meta').textContent = t('source.fileMeta', { size: formatBytes(srcFile.size) });
}

// Web pages and EPUB books are read by the server; offline, pasted text and
// PDFs (read here) can still be added: they are saved here and sent later.
function updateSourceOffline() {
  const offline = !net.online;
  for (const r of document.querySelectorAll('#src-kinds input')) {
    if (r.value === 'url') r.disabled = offline;
  }
  $('#src-offline').hidden = !offline || !!editingId;
  if (offline && srcKind === 'url' && $('#source-dialog').open) setSourceKind('text');
}

const looksLikeURL = (s) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(s.trim()) && !/\s/.test(s.trim());

function updateSrcCount() {
  const text = $('#src-text').value;
  const n = text.length;
  $('#src-count').textContent = n ? t('chars', { n: n.toLocaleString() }) : '';
  const isLink = !editingId && n > 0 && n < 2000 && looksLikeURL(text);
  $('#src-link-hint').hidden = !isLink;
  // An edited Markdown text stays Markdown (imports are stored that way).
  $('#src-md').hidden = isLink || !(editingFormat === 'markdown' || (n > 0 && detectFormat(text) === 'markdown'));
}

function formatBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function setSourceFile(file) {
  srcFile = file;
  const zone = $('#src-drop');
  zone.classList.toggle('has-file', !!file);
  const name = $('#src-file-name');
  const meta = $('#src-file-meta');
  if (file) {
    name.removeAttribute('data-i18n');
    name.textContent = file.name;
    meta.removeAttribute('data-i18n');
    meta.textContent = t('source.fileMeta', { size: formatBytes(file.size) });
  } else {
    $('#src-file').value = '';
    name.dataset.i18n = 'source.choose';
    name.textContent = t('source.choose');
    meta.dataset.i18n = 'source.fileNote';
    meta.textContent = t('source.fileNote');
  }
  $('#src-error').textContent = '';
  labelSourceDialog(); // "Import Book" or "Import PDF"
}

const isEPUB = (file) => /\.epub$/i.test(file.name) || file.type === 'application/epub+zip';

function pickFile(file) {
  if (!file) return;
  if (!isEPUB(file) && !isPDF(file)) {
    setSourceFile(null);
    $('#src-error').textContent = t('source.notFile');
    return;
  }
  setSourceFile(file);
  if (file.size > MAX_EPUB_BYTES) $('#src-error').textContent = t('source.tooBig');
}

// The shelf as last seen (instantly, and offline), then fresh from the server:
// sync() sends waiting changes, fetches, and fires "synced" (see onSynced).
async function loadShelf() {
  try {
    state.books = await loadData('books');
    state.booksLoaded = true;
  } catch (err) {
    if (err.status !== 401) showBanner(err.message);
  }
  if (document.body.dataset.view === 'library') renderShelf();
  if (net.online) sync();
}

async function submitSource() {
  const title = $('#src-title').value;
  const err = $('#src-error');
  const fail = (msg, field) => {
    err.textContent = msg;
    field?.focus();
  };
  let content = '';
  if (srcKind === 'text') {
    content = $('#src-text').value.replace(/\s+$/, '');
    if (!content.trim()) return fail(t('source.empty'), $('#src-text'));
    if (content.length > MAX_CHARS) {
      return fail(t('source.tooLong', { n: content.length.toLocaleString(), max: MAX_CHARS.toLocaleString() }), $('#src-text'));
    }
  } else if (srcKind === 'url') {
    if (!$('#src-url').value.trim()) return fail(t('source.noUrl'), $('#src-url'));
  } else {
    if (!srcFile) return fail(t('source.noFile'), $('#src-file'));
    if (srcFile.size > MAX_EPUB_BYTES) return fail(t('source.tooBig'), $('#src-file'));
  }

  let book;
  const form = $('#source-form');
  busy($('#src-save'), true);
  form.inert = true; // no edits while a slow import runs
  const ttlDays = chosenTTL();
  try {
    if (editingId) {
      const format = editingFormat === 'markdown' ? 'markdown' : detectFormat(content);
      book = await updateBook(editingId, { title, content, format, ttlDays });
    } else if (srcKind === 'text') {
      book = await createBook({ title, content, format: detectFormat(content), ttlDays });
    } else if (srcKind === 'url') {
      book = await importURL($('#src-url').value.trim(), title, ttlDays);
    } else if (isPDF(srcFile)) {
      book = await importPDF(srcFile, title, ttlDays);
    } else {
      book = await importEPUB(srcFile, title, ttlDays);
    }
  } catch (e) {
    form.inert = false;
    busy($('#src-save'), false);
    if (srcKind === 'file' && srcFile) setSourceFile(srcFile); // the page count goes
    const field = { text: '#src-text', url: '#src-url', file: '#src-file' }[editingId ? 'text' : srcKind];
    return fail(e instanceof PDFError ? t(e.key) : e.message, $(field));
  }
  form.inert = false;
  busy($('#src-save'), false);
  $('#source-dialog').close();
  const target = `#/read/${encodeURIComponent(book.id)}`;
  if (location.hash === target) openBook(book.id); // edited the open book: re-render it
  else location.hash = target;
}

// A PDF is read here (pdftext.js) and added like pasted Markdown, so it also
// works offline once pdf.js has been loaded.
async function importPDF(file, title, ttlDays) {
  const meta = $('#src-file-meta');
  meta.removeAttribute('data-i18n');
  const pdf = await readPDF(file, { onPage: (i, n) => { meta.textContent = t('pdf.reading', { i, n }); } });
  if (pdf.content.length > MAX_CHARS) {
    throw new Error(t('source.tooLong', { n: pdf.content.length.toLocaleString(), max: MAX_CHARS.toLocaleString() }));
  }
  return createBook({ title: title.trim() || pdf.title, content: pdf.content, format: 'markdown', ttlDays });
}

async function addSampleBook() {
  try {
    const book = await createBook({ title: SAMPLE_TITLE, content: SAMPLE_TEXT });
    location.hash = `#/read/${encodeURIComponent(book.id)}`;
  } catch (err) {
    showBanner(err.message);
  }
}

let lastHash = location.hash || '#/';

function route() {
  if (!state.me) {
    showLogin();
    return;
  }
  const hash = location.hash || '#/';
  if (hash === '#/settings') {
    if (lastHash !== '#/settings') returnTo = lastHash;
    showSettings();
  } else if (hash === '#/clip') {
    showClip();
  } else {
    const m = hash.match(/^#\/read\/([^/]+)$/);
    if (m) openBook(decodeURIComponent(m[1]));
    else showLibrary();
  }
  lastHash = hash;
}

// ------------------------------------------------------------------ language

function getLevel() {
  const ids = serverConfig.levels.map((l) => l.id);
  const v = state.prefs.level;
  return ids.length && !ids.includes(v) ? (serverConfig.default_level || 'B1') : v;
}

function levelName(lv) {
  return getLang() === 'zh' ? lv.label.replace(/^\S+\s*/, '') : lv.name;
}

// The level chip in the header, and the A1–C2 ladder in its popover.
function renderLevelUI() {
  const current = getLevel();
  const lv = serverConfig.levels.find((l) => l.id === current);
  $('#lv-code').textContent = current;
  $('#lv-name').textContent = lv ? levelName(lv) : '';
  $('#level-list').innerHTML = serverConfig.levels.map((l) => `
    <button type="button" class="level-opt" role="option" data-level="${l.id}" aria-selected="${l.id === current}">
      <span class="lo-code">${l.id}</span>
      <span><span class="lo-name">${escapeHTML(levelName(l))}</span>
      <span class="lo-hint">${escapeHTML(l.hint)}, ${escapeHTML(t('level.words', { n: l.vocab.toLocaleString() }))}</span></span>
    </button>`).join('');
}

// The level lives in the profile; the reader's chip is a quick way to change it.
function setLevel(id) {
  $('#level-pop').hidePopover?.();
  if (id === getLevel()) return;
  savePrefs({ level: id });
  renderLevelUI();
  const view = document.body.dataset.view;
  if (view === 'settings') renderProfileLevels();
  else if (state.book) openBook(state.book.id); // re-annotate for the new level
  else renderShelf();
}

function markPressed(groupSel, attr, value) {
  for (const b of document.querySelectorAll(`${groupSel} button`)) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
}

const READ_SIZES = { s: '17px', m: '20px', l: '23px' };
function applyReadSize(size) {
  const v = READ_SIZES[size] ? size : 'm';
  document.documentElement.style.setProperty('--read-size', READ_SIZES[v]);
  markPressed('#size-seg', 'size', v);
}

// Reading column width; it only matters on screens wider than the column.
const READ_WIDTHS = { n: '680px', m: '820px', w: '1040px' };
function applyReadWidth(width) {
  const v = READ_WIDTHS[width] ? width : 'm';
  document.documentElement.style.setProperty('--read-width', READ_WIDTHS[v]);
  markPressed('#width-seg', 'width', v);
}

// The reading font and the Chinese gloss font (Reading Options).
const READ_FONTS = ['literata', 'classic', 'sans', 'legible'];
const GLOSS_FONTS = ['sans', 'song', 'kai'];
function applyFonts({ readFont, glossFont }) {
  const read = READ_FONTS.includes(readFont) ? readFont : 'literata';
  const gloss = GLOSS_FONTS.includes(glossFont) ? glossFont : 'sans';
  const root = document.documentElement.style;
  root.setProperty('--read-font', `var(--font-${read})`);
  root.setProperty('--zh', `var(--zh-${gloss})`);
  markPressed('#font-seg', 'font', read);
  markPressed('#gloss-seg', 'gloss', gloss);
}

// "system" follows the device; theme.js (loaded in <head>) does the work and
// remembers the choice in this browser so the next visit paints correctly at once.
function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  const t = window.lingolensTheme ? window.lingolensTheme(theme) : 'system';
  markPressed('.theme-seg', 'mode', t);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}

// Popovers sit in the top layer; place each under the button that opened it.
// Called on "beforetoggle", before the popover is drawn, so there's no flash at
// the corner: align right edges (no width needed), then keep it on screen.
function anchorPopover(pop) {
  const btn = document.querySelector(`[popovertarget="${pop.id}"]`);
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  pop.style.left = 'auto';
  pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  pop.style.top = `${r.bottom + 6}px`;
}

function keepPopoverOnScreen(pop) {
  const b = pop.getBoundingClientRect();
  if (b.left < 8) {
    pop.style.right = 'auto';
    pop.style.left = '8px';
  }
}

// Re-render everything that holds translated text after a language switch.
function refreshLanguage() {
  renderLevelUI();
  markPressed('#lang-seg', 'lang', getLang());
  if (document.body.dataset.view === 'library') renderShelf();
  else updateBookStat();
  if ($('#source-dialog').open) {
    labelSourceDialog();
    updateSrcCount();
  }
  setChatBusy(!!state.chat?.ctl);
  if (!$('#chat').hidden && state.chat) renderChips();
  if (!$('#card').hidden) renderCard();
  if ($('#wordbook').open) renderWordbook();
  if (document.body.dataset.view === 'login') {
    renderLoginMode();
    markPressed('#login-lang', 'lang', getLang());
  }
  if (document.body.dataset.view === 'settings') {
    document.title = `${t('settings.page')} – LingoLens`;
    renderProfileLevels();
    renderAccount();
    setView('settings');
    const preset = $('#s-preset').value;
    fillPresetOptions();
    $('#s-preset').value = preset;
    $('#s-note').textContent = PRESETS[preset]?.noteKey ? t(PRESETS[preset].noteKey) : '';
    $('#s-status').textContent = '';
  } else if (document.body.dataset.view === 'reader') {
    setView('reader');
  }
  if (!$('#progress').hidden) updateProgress();
}

// ------------------------------------------------------------------ offline and sync

// The badge in the header: "Offline" while the server can't be reached, then
// "Syncing…" and "Synced" as changes made meanwhile go up. Saving a reading
// position online doesn't show it; that's routine.
let wasOffline = false;
let netTimer = 0;

function renderNet(mode) {
  const el = $('#net-status');
  clearTimeout(netTimer);
  if (!net.online) wasOffline = true; // also when the app started offline
  if (!mode) {
    if (!state.me) mode = '';
    else if (!net.online) mode = 'offline';
    else if (wasOffline && (net.pending || net.syncing)) mode = 'syncing';
    else if (net.pending && !net.syncing) mode = 'waiting';
    else mode = '';
  }
  if (mode === 'waiting') {
    // Give a routine save a moment before calling it "not synced".
    if (el.dataset.mode !== 'waiting') {
      netTimer = setTimeout(() => { if (net.pending && !net.syncing) renderNet('waiting!'); }, 4000);
      return;
    }
  }
  mode = mode.replace('!', '');
  el.dataset.mode = mode;
  el.hidden = !mode;
  if (!mode) return;
  $('#net-label').textContent = t(`net.${mode}`);
  el.setAttribute('aria-label', t(`net.${mode}`));
  el.title = net.pending ? t('net.pending', { n: net.pending }) : t(`net.${mode}`);
  if (mode === 'synced') netTimer = setTimeout(() => renderNet(), 2500);
}

function onNetChange() {
  if (!net.online) wasOffline = true;
  renderNet();
  updateSourceOffline();
  if (net.online && state.book) resumeAnnotating();
}

// Paragraphs that came into view offline get their glosses now.
function resumeAnnotating() {
  if (!lazy.observer) return;
  let n = 0;
  for (const [id, seg] of state.segments) {
    if (seg.status !== 'waiting') continue;
    seg.status = 'queued';
    lazy.queue.push(id);
    n++;
  }
  if (n) pump();
}

// Fresh data arrived from the server (after sign-in, opening the shelf, or
// coming back online): show it.
async function onSynced() {
  if (!state.me) return;
  let me, books, wordbook, known;
  try {
    [me, books, wordbook, known] = await Promise.all(['me', 'books', 'wordbook', 'known'].map(loadData));
  } catch {
    return;
  }
  if (!state.me || me?.user?.id !== state.me.id) return;
  const before = { level: getLevel(), lang: state.prefs.lang, readSize: state.prefs.readSize, readWidth: state.prefs.readWidth, theme: state.prefs.theme, readFont: state.prefs.readFont, glossFont: state.prefs.glossFont };
  state.me = me.user;
  state.model = me.model;
  state.prefs = { ...state.prefs, ...me.user.prefs };
  state.books = books;
  state.booksLoaded = true;
  state.wordbook = wordbook;
  state.known = new Set(known);
  if (state.prefs.theme !== before.theme) applyTheme(state.prefs.theme);
  if (state.prefs.readSize !== before.readSize) applyReadSize(state.prefs.readSize);
  if (state.prefs.readWidth !== before.readWidth) applyReadWidth(state.prefs.readWidth);
  if (state.prefs.readFont !== before.readFont || state.prefs.glossFont !== before.glossFont) applyFonts(state.prefs);
  updateWordbookBadge();
  refreshKnownMarks();
  if (state.prefs.lang && state.prefs.lang !== getLang()) {
    setLang(state.prefs.lang);
    refreshLanguage(); // re-renders everything on screen
  } else {
    renderLevelUI();
    const view = document.body.dataset.view;
    if (view === 'library') renderShelf();
    if (view === 'reader') updateBookStat();
    if (view === 'settings') renderProfileLevels();
    if ($('#wordbook').open) renderWordbook();
  }
  if (state.book && getLevel() !== before.level) openBook(state.book.id);
  else refreshOpenBook(books);
  if (wasOffline) {
    wasOffline = false;
    renderNet('synced');
  } else if ($('#net-status').dataset.mode !== 'synced') {
    renderNet();
  }
}

// The open text changed elsewhere (an agent added to it, another device edited
// it): show the new version, keeping the reader's place.
async function refreshOpenBook(books) {
  const open = state.book;
  const fresh = open && books.find((b) => b.id === open.id);
  if (!fresh || fresh.updatedAt === open.updatedAt || document.body.dataset.view !== 'reader') return;
  const seq = openSeq;
  const book = await getBook(open.id).catch(() => null);
  if (!book || state.book !== open || openSeq !== seq) return;
  if (book.content === open.content) {
    open.updatedAt = book.updatedAt;
    return;
  }
  openBook(open.id, { keepPlace: true });
}

// A text added offline reached the server and got its real id.
function onBookId(e) {
  const { from, to } = e.detail;
  for (const b of state.books) if (b.id === from) b.id = to;
  if (editingId === from) editingId = to;
  if (state.book?.id === from) {
    state.book.id = to;
    history.replaceState(null, '', `#/read/${encodeURIComponent(to)}`);
    lastHash = location.hash;
  }
}

// ------------------------------------------------------------------ accounts

async function boot() {
  await finishPendingLogout(); // a sign-out made offline
  let me;
  try {
    me = await api('GET', '/api/me');
  } catch (err) {
    if (err.status === 401) {
      showLogin();
      return;
    }
    // The server can't be reached: carry on with this browser's copy, if any.
    const cached = (err.offline || err.status >= 500) && await cachedMe();
    if (cached) {
      await startSession(cached, { offline: true });
      return;
    }
    if (err.offline) {
      showLogin();
      $('#login-error').textContent = t('net.loginOffline');
    } else {
      showBanner(err.message);
    }
    return;
  }
  await startSession(me);
}

// Load everything that belongs to the signed-in user, then show the page they asked for.
async function startSession(me, { offline = false } = {}) {
  await openUser(me.user.id);
  if (!offline) await rememberMe(me);
  me = (await loadData('me').catch(() => null)) || me; // with settings changed offline
  state.me = me.user;
  state.model = me.model;
  state.prefs = { ...state.prefs, ...me.user.prefs };
  if (state.prefs.lang && state.prefs.lang !== getLang()) setLang(state.prefs.lang);
  applyReadSize(state.prefs.readSize);
  applyReadWidth(state.prefs.readWidth);
  applyFonts(state.prefs);
  applyTheme(state.prefs.theme);
  try {
    const [wordbook, known] = await Promise.all([loadData('wordbook'), loadData('known')]);
    state.wordbook = wordbook;
    state.known = new Set(known);
  } catch (err) {
    showBanner(err.message);
  }
  renderNet();
  if (hasLegacyData() && net.online) await importLegacyData();
  refreshLanguage();
  updateWordbookBadge();
  await loadShelf();
  if (!activeModel().preset) showBanner(t('banner.firstRun'), 'info', { settingsLink: true });
  lastHash = '';
  route();
}

function showLogin() {
  flushProgress();
  Object.assign(state, { me: null, model: null, book: null, books: [], booksLoaded: false, wordbook: [], known: new Set() });
  resetLazy();
  closeCard();
  hideFab();
  closeChat();
  hideBanner();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  for (const p of document.querySelectorAll('[popover]:popover-open')) p.hidePopover();
  setView('login');
  renderNet();
  renderLoginMode();
  markPressed('#login-lang', 'lang', getLang());
  $('#login-error').textContent = '';
  $('#login-email').focus();
}

// The sign-in card doubles as first-run setup while the server has no accounts.
function renderLoginMode() {
  const setup = !!serverConfig.needs_setup;
  const texts = setup
    ? { '#login-title': 'setup.title', '#login-sub': 'setup.sub', '#login-submit': 'setup.submit', '#login-note': 'setup.note' }
    : { '#login-title': 'login.title', '#login-sub': 'login.sub', '#login-submit': 'login.submit', '#login-note': 'login.note' };
  for (const [sel, key] of Object.entries(texts)) {
    const el = $(sel);
    el.dataset.i18n = key;
    el.textContent = t(key);
  }
  $('#setup-confirm-field').hidden = !setup;
  const pw = $('#login-password');
  pw.autocomplete = setup ? 'new-password' : 'current-password';
  pw.placeholder = setup ? t('setup.passwordHint') : '';
  document.title = `${t(setup ? 'setup.title' : 'login.title')} – LingoLens`;
}

function setNeedsSetup(on) {
  serverConfig.needs_setup = on;
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(serverConfig)); } catch { /* private mode */ }
}

async function submitLogin(e) {
  e.preventDefault();
  const setup = !!serverConfig.needs_setup;
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const err = $('#login-error');
  if (!email || !password) {
    err.textContent = t('login.missing');
    $(email ? '#login-password' : '#login-email').focus();
    return;
  }
  if (setup && [...password].length < 8) {
    err.textContent = t('setup.short');
    $('#login-password').focus();
    return;
  }
  if (setup && password !== $('#setup-confirm').value) {
    err.textContent = t('setup.mismatch');
    $('#setup-confirm').select();
    return;
  }
  busy($('#login-submit'), true);
  err.textContent = '';
  try {
    await api('POST', setup ? '/api/auth/setup' : '/api/auth/login', { email, password });
    $('#login-password').value = '';
    $('#setup-confirm').value = '';
    if (setup) setNeedsSetup(false);
    await startSession(await api('GET', '/api/me'));
  } catch (error) {
    if (setup && error.status === 409) { // someone else finished setup first
      setNeedsSetup(false);
      renderLoginMode();
      err.textContent = t('setup.done');
      return;
    }
    err.textContent = error.message;
    $('#login-password').select();
  } finally {
    busy($('#login-submit'), false);
  }
}

// Signing out removes this account's copy from the browser. Changes that haven't
// reached the server yet would be lost, so ask first.
async function signOut() {
  flushProgress();
  if (net.online && net.pending) await flush();
  if (net.pending && !confirm(t('net.signOutPending', { n: net.pending }))) return;
  let serverLoggedOut = true;
  try {
    await api('POST', '/api/auth/logout', {});
  } catch (err) {
    serverLoggedOut = !err.offline; // otherwise it is sent when back online
  }
  await forgetUser({ serverLoggedOut });
  location.hash = '#/';
  showLogin();
}

// Texts, words and the model choice kept in this browser before accounts existed
// are copied into the account once, then removed from the browser.
async function importLegacyData() {
  const data = readLegacyData();
  let books = 0;
  for (const b of data.books) {
    try {
      const created = await createBook({ title: b.title || '', content: b.content, format: b.format || 'text' });
      if (b.progress > 0) await saveProgress(created.id, b.pos || 0, b.progress);
      books++;
    } catch { /* skip texts the server rejects */ }
  }
  for (const w of data.wordbook) {
    if (state.wordbook.some((x) => x.key === w.key)) continue;
    try {
      await api('PUT', `/api/wordbook/${encodeURIComponent(w.key)}`, w);
      state.wordbook.push(w);
    } catch { /* skip */ }
  }
  for (const k of data.known) {
    if (state.known.has(k)) continue;
    try {
      await api('PUT', `/api/known/${encodeURIComponent(k)}`);
      state.known.add(k);
    } catch { /* skip */ }
  }
  const m = data.model;
  if (m && PRESETS[m.preset] && !state.model?.active) {
    try {
      state.model = await api('PUT', '/api/me/model', {
        preset: m.preset, kind: PRESETS[m.preset].kind,
        base_url: m.base_url ?? PRESETS[m.preset].base_url, model: m.model ?? PRESETS[m.preset].model,
        ...(m.api_key ? { api_key: m.api_key } : {}),
      });
    } catch { /* skip */ }
  }
  clearLegacyData();
  if (books) showBanner(t('import.done', { n: books }), 'info');
}

// ------------------------------------------------------------------ settings: account & members

function renderAccount() {
  const u = state.me;
  if (!u) return;
  $('#acct-name').textContent = u.name || u.email;
  $('#acct-email').textContent = u.name ? u.email : '';
  $('#acct-role').textContent = t(u.is_admin ? 'members.admin' : 'members.member');
  $('#pw-status').textContent = '';
  $('#members-section').hidden = !u.is_admin;
  if (u.is_admin) {
    if (!$('#m-password').value) $('#m-password').value = generatePassword();
    loadMembers();
  }
}

async function changePassword(e) {
  e.preventDefault();
  const status = $('#pw-status');
  const btn = e.submitter || $('#password-form button[type="submit"]');
  busy(btn, true);
  try {
    await api('PUT', '/api/me/password', { current: $('#pw-current').value, new: $('#pw-new').value });
    $('#pw-current').value = '';
    $('#pw-new').value = '';
    status.textContent = t('account.pwChanged');
  } catch (err) {
    status.textContent = err.message;
    $('#pw-current').focus();
  } finally {
    busy(btn, false);
  }
}

function generatePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

let members = [];

// ------------------------------------------------------------------ agent tokens

function shortDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(getLang() === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function loadTokens() {
  let tokens;
  try {
    tokens = await api('GET', '/api/me/tokens');
  } catch (err) {
    $('#tk-status').textContent = err.message;
    return;
  }
  $('#token-list').innerHTML = tokens.map((tk) => `
    <li class="member">
      <span class="member-who">
        <span class="member-name">${escapeHTML(tk.name)}</span>
        <span class="member-email"><span class="token-hint" translate="no">${escapeHTML(tk.hint)}</span> ·
          ${escapeHTML(t('agent.created', { d: shortDate(tk.created_at) }))},
          ${escapeHTML(tk.last_used_at ? t('agent.used', { d: shortDate(tk.last_used_at) }) : t('agent.never'))}</span>
      </span>
      <span></span>
      <span class="member-actions">
        <button type="button" class="btn ghost small danger-link" data-revoke="${tk.id}" data-name="${escapeHTML(tk.name)}">${escapeHTML(t('agent.revoke'))}</button>
      </span>
    </li>`).join('');
}

async function createToken(e) {
  e.preventDefault();
  const btn = e.submitter || $('#token-form button[type="submit"]');
  busy(btn, true);
  $('#tk-status').textContent = '';
  try {
    const res = await api('POST', '/api/me/tokens', { name: $('#tk-name').value.trim() });
    $('#tk-env').textContent = `export LINGOLENS_URL=${res.endpoint}\nexport LINGOLENS_TOKEN=${res.token}`;
    $('#token-new').hidden = false;
    $('#tk-copy').textContent = t('agent.copy');
    $('#tk-name').value = '';
    $('#tk-copy').focus();
    loadTokens();
  } catch (err) {
    $('#tk-status').textContent = err.message;
  } finally {
    busy(btn, false);
  }
}

async function copyCode(code, btn) {
  try {
    await navigator.clipboard.writeText(code.textContent);
  } catch {
    // No clipboard access (e.g. plain http): select it so Ctrl/Cmd+C works.
    getSelection().selectAllChildren(code);
    return;
  }
  btn.textContent = t('agent.copied');
  setTimeout(() => { btn.textContent = t('agent.copy'); }, 2000);
}

async function revokeToken(btn) {
  if (!confirm(t('agent.confirmRevoke', { n: btn.dataset.name }))) return;
  try {
    await api('DELETE', `/api/me/tokens/${encodeURIComponent(btn.dataset.revoke)}`);
  } catch (err) {
    $('#tk-status').textContent = err.message;
    return;
  }
  loadTokens();
}

async function loadMembers() {
  try {
    members = await api('GET', '/api/admin/users');
  } catch (err) {
    $('#m-status').textContent = err.message;
    return;
  }
  $('#member-list').innerHTML = members.map((m) => `
    <li class="member">
      <span class="member-who">
        <span class="member-name">${escapeHTML(m.name || m.email)}</span>
        ${m.name ? `<span class="member-email">${escapeHTML(m.email)}</span>` : ''}
      </span>
      <span class="member-role">${escapeHTML(t(m.is_admin ? 'members.admin' : 'members.member'))}${m.id === state.me.id ? ` (${escapeHTML(t('members.you'))})` : ''}</span>
      <span class="member-actions">
        <button type="button" class="btn ghost small" data-reset="${m.id}">${escapeHTML(t('members.resetPw'))}</button>
        ${m.id === state.me.id ? '' : `<button type="button" class="btn ghost small danger-link" data-remove="${m.id}">${escapeHTML(t('members.remove'))}</button>`}
      </span>
    </li>`).join('');
}

async function createMember(e) {
  e.preventDefault();
  const status = $('#m-status');
  const body = {
    email: $('#m-email').value.trim(),
    name: $('#m-name').value.trim(),
    password: $('#m-password').value,
    is_admin: $('#m-admin').checked,
  };
  const btn = e.submitter || $('#member-form button[type="submit"]');
  busy(btn, true);
  try {
    const u = await api('POST', '/api/admin/users', body);
    status.textContent = t('members.created', { email: u.email, pw: body.password });
    $('#m-email').value = '';
    $('#m-name').value = '';
    $('#m-admin').checked = false;
    $('#m-password').value = generatePassword();
    loadMembers();
  } catch (err) {
    status.textContent = err.message;
    $('#m-email').focus();
  } finally {
    busy(btn, false);
  }
}

async function onMemberAction(e) {
  const resetId = e.target.closest('[data-reset]')?.dataset.reset;
  const removeId = e.target.closest('[data-remove]')?.dataset.remove;
  const m = members.find((x) => String(x.id) === (resetId || removeId));
  if (!m) return;
  const status = $('#m-status');
  try {
    if (resetId) {
      const pw = prompt(t('members.resetPrompt', { email: m.email }), generatePassword());
      if (!pw) return;
      await api('PUT', `/api/admin/users/${m.id}/password`, { password: pw });
      status.textContent = t('members.resetDone', { email: m.email, pw });
    } else {
      if (!confirm(t('members.confirmRemove', { email: m.email }))) return;
      await api('DELETE', `/api/admin/users/${m.id}`);
      status.textContent = t('members.removed', { email: m.email });
      loadMembers();
    }
  } catch (err) {
    status.textContent = err.message;
  }
}

// ------------------------------------------------------------------ init

async function init() {
  // The server's levels and options; the last copy is used offline.
  try {
    serverConfig = await (await fetch('/api/config')).json();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(serverConfig));
  } catch {
    try { serverConfig = JSON.parse(localStorage.getItem(CONFIG_KEY)) || serverConfig; } catch { /* defaults */ }
  }
  // Keeps the app itself for offline use (needs HTTPS, or localhost).
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* works online without it */ });
  }

  applyI18n();
  renderLevelUI();
  markPressed('#lang-seg', 'lang', getLang());
  applyReadSize('m');
  applyReadWidth('m');
  markPressed('.theme-seg', 'mode', document.documentElement.dataset.theme || 'system');

  // Header popovers
  for (const pop of document.querySelectorAll('[popover]')) {
    pop.addEventListener('beforetoggle', (e) => { if (e.newState === 'open') anchorPopover(pop); });
    pop.addEventListener('toggle', (e) => { if (e.newState === 'open') keepPopoverOnScreen(pop); });
  }
  window.addEventListener('resize', () => {
    for (const pop of document.querySelectorAll('[popover]:popover-open')) anchorPopover(pop);
  });
  $('#level-list').addEventListener('click', (e) => {
    const id = e.target.closest('[data-level]')?.dataset.level;
    if (id) setLevel(id);
  });
  for (const sel of ['#lang-seg', '#login-lang']) {
    $(sel).addEventListener('click', (e) => {
      const lang = e.target.closest('[data-lang]')?.dataset.lang;
      if (!lang || lang === getLang()) return;
      setLang(lang);
      if (state.me) savePrefs({ lang });
      refreshLanguage();
    });
  }
  for (const seg of document.querySelectorAll('.theme-seg')) {
    seg.addEventListener('click', (e) => {
      const theme = e.target.closest('[data-mode]')?.dataset.mode;
      if (!theme) return;
      applyTheme(theme);
      if (state.me) savePrefs({ theme });
    });
  }
  $('#size-seg').addEventListener('click', (e) => {
    const size = e.target.closest('[data-size]')?.dataset.size;
    if (!size) return;
    savePrefs({ readSize: size });
    applyReadSize(size);
  });
  $('#font-seg').addEventListener('click', (e) => {
    const readFont = e.target.closest('[data-font]')?.dataset.font;
    if (!readFont) return;
    savePrefs({ readFont });
    applyFonts({ ...state.prefs, readFont });
  });
  $('#gloss-seg').addEventListener('click', (e) => {
    const glossFont = e.target.closest('[data-gloss]')?.dataset.gloss;
    if (!glossFont) return;
    savePrefs({ glossFont });
    applyFonts({ ...state.prefs, glossFont });
  });
  $('#width-seg').addEventListener('click', (e) => {
    const width = e.target.closest('[data-width]')?.dataset.width;
    if (!width) return;
    savePrefs({ readWidth: width });
    applyReadWidth(width);
  });


  const article = $('#article');
  $('#show-words').addEventListener('change', (e) => article.classList.toggle('hide-words', !e.target.checked));
  $('#show-phrases').addEventListener('change', (e) => article.classList.toggle('hide-phrases', !e.target.checked));

  // Shelf and sources
  $('#btn-add').onclick = () => openSourceDialog();
  $('#btn-add-empty').onclick = () => openSourceDialog();
  $('#btn-sample-empty').onclick = addSampleBook;
  $('#btn-toc').onclick = () => {
    $('#menu-pop').hidePopover();
    openContents();
  };
  $('#toc-close').onclick = () => $('#toc-dialog').close();
  $('#toc-list').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-target]');
    if (!a) return;
    e.preventDefault(); // keep the #/read/… route in the address bar
    $('#toc-dialog').close();
    document.getElementById(a.dataset.target)?.scrollIntoView({ block: 'start' });
  });
  $('#btn-edit').onclick = () => {
    $('#menu-pop').hidePopover?.();
    if (state.book) openSourceDialog(state.book);
  };
  $('#shelf').addEventListener('click', (e) => {
    const id = e.target.closest('[data-del-book]')?.dataset.delBook;
    if (!id) return;
    const book = state.books.find((b) => b.id === id);
    if (!book || !confirm(t('book.confirmDelete', { t: book.title }))) return;
    deleteBook(id).then(() => {
      state.books = state.books.filter((b) => b.id !== id);
      renderShelf();
    }, (err) => showBanner(err.message));
  });
  $('#source-form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return; // Cancel / × close the dialog as usual
    e.preventDefault();
    submitSource();
  });
  $('#token-form').addEventListener('submit', createToken);
  $('#tk-copy').onclick = () => copyCode($('#tk-env'), $('#tk-copy'));
  $('#skill-copy').onclick = () => copyCode($('#skill-cmd'), $('#skill-copy'));
  $('#bm-copy').onclick = () => copyCode($('#bm-code'), $('#bm-copy'));
  $('#bm-link').addEventListener('click', (e) => {
    e.preventDefault(); // it's for other sites; run here it would only open another tab
    $('#bm-status').textContent = t('clip.notHere');
  });
  window.addEventListener('message', receiveClip);
  $('#clip-save').onclick = saveClip;
  $('#clip-cancel').onclick = cancelClip;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-clip-setup]')) return;
    $('#source-dialog').close();
    scrollToBookmarklet = true;
    if (location.hash === '#/settings') { e.preventDefault(); showSettings(); }
  });
  $('#token-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-revoke]');
    if (btn) revokeToken(btn);
  });
  $('#src-text').addEventListener('input', () => { updateSrcCount(); $('#src-error').textContent = ''; });
  $('#src-kinds').addEventListener('change', (e) => {
    if (e.target.name === 'kind') setSourceKind(e.target.value);
    (srcKind === 'url' ? $('#src-url') : srcKind === 'file' ? $('#src-file') : $('#src-text')).focus();
  });
  $('#src-use-link').onclick = () => {
    $('#src-url').value = $('#src-text').value.trim();
    $('#src-text').value = '';
    updateSrcCount();
    setSourceKind('url');
    $('#src-save').focus();
  };
  $('#src-url').addEventListener('input', () => { $('#src-error').textContent = ''; });
  $('#src-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitSource(); }
  });
  $('#src-file').addEventListener('change', (e) => pickFile(e.target.files[0]));
  const drop = $('#src-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    pickFile(e.dataTransfer.files[0]);
  });
  $('#src-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitSource();
  });
  $('#src-delete').onclick = async () => {
    const book = state.book?.id === editingId ? state.book : state.books.find((b) => b.id === editingId);
    if (!book || !confirm(t('book.confirmDelete', { t: book.title }))) return;
    try {
      await deleteBook(book.id);
    } catch (err) {
      $('#src-error').textContent = err.message;
      return;
    }
    state.books = state.books.filter((b) => b.id !== book.id);
    state.book = null;
    $('#source-dialog').close();
    location.hash = '#/';
  };
  $('#src-sample').onclick = () => {
    $('#src-title').value = SAMPLE_TITLE;
    $('#src-text').value = SAMPLE_TEXT;
    updateSrcCount();
  };
  $('#banner-close').onclick = hideBanner;

  // Reading progress
  let scrollRaf = 0;
  window.addEventListener('scroll', () => {
    markScrolled();
    if (!state.book || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; trackReading(true); });
  }, { passive: true });
  window.addEventListener('pagehide', () => flushProgress({ closing: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushProgress({ closing: true });
    else if (state.me && net.online) sync(); // back from another app, say an agent that added to this text
  });

  // Word card
  article.addEventListener('click', (e) => {
    if (!window.getSelection().isCollapsed) return; // finishing a text selection
    const ruby = e.target.closest('ruby.ann');
    if (ruby) {
      if (state.activeAnn === +ruby.dataset.ann) closeCard();
      else openCard(ruby);
      return;
    }
    // Any other English word: look it up on demand.
    const w = wordAtPoint(e.clientX, e.clientY);
    if (w) lookupWordAt(w);
    else closeCard();
  });
  $('#card').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) onCardAction(act);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#card').hidden && !e.target.closest('#card, ruby.ann')) closeCard();
  });

  // Selection -> ask AI
  $('#hint-ok').addEventListener('click', dismissHint);

  const fab = $('#ask-fab');
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('#ask-fab, #card, #chat')) return;
    setTimeout(maybeShowFab, 0);
  });
  document.addEventListener('keyup', (e) => { if (e.shiftKey) maybeShowFab(); });
  // Touch devices select by long-press + handles, with no mouseup: show the button
  // once the selection has settled.
  let selTimer = 0;
  let fabPressedAt = 0;
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    clearTimeout(selTimer);
    // A tap on the button can clear the selection before its click arrives.
    if (!sel || sel.isCollapsed) { if (Date.now() - fabPressedAt > 800) hideFab(); }
    else if (isTouch()) selTimer = setTimeout(maybeShowFab, 400);
  });
  fab.addEventListener('pointerdown', () => { fabPressedAt = Date.now(); });
  fab.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  fab.addEventListener('click', () => {
    const info = fab._info;
    hideFab();
    if (info) openChat(info.text, info.passage);
    window.getSelection()?.removeAllRanges();
  });

  // Chat drawer
  $('#chat-close').onclick = closeChat;
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.chat?.ctl) state.chat.ctl.abort();
    else sendChat($('#chat-input').value);
  });
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });

  // Settings
  $('#btn-settings').onclick = () => $('#menu-pop').hidePopover?.();
  $('#profile-levels').addEventListener('click', (e) => {
    const id = e.target.closest('[data-level]')?.dataset.level;
    if (id) setLevel(id);
  });
  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveModel();
  });
  $('#s-key-remove').onclick = () => saveModel({ removeKey: true });

  // Account
  $('#login-form').addEventListener('submit', submitLogin);
  $('#btn-logout').onclick = signOut;
  $('#password-form').addEventListener('submit', changePassword);
  $('#member-form').addEventListener('submit', createMember);
  $('#member-list').addEventListener('click', onMemberAction);
  $('#settings-form').addEventListener('input', () => { $('#s-status').textContent = ''; });
  $('#s-preset').addEventListener('change', (e) => loadPresetIntoForm(e.target.value));
  $('#s-key-toggle').onclick = () => {
    const k = $('#s-key');
    k.type = k.type === 'password' ? 'text' : 'password';
    $('#s-key-toggle').textContent = t(k.type === 'password' ? 'settings.show' : 'settings.hide');
  };

  // Wordbook
  updateWordbookBadge();
  $('#btn-wordbook').onclick = () => { renderWordbook(); $('#wordbook').showModal(); };
  $('#wb-close').onclick = () => $('#wordbook').close();
  $('#wb-export').onclick = exportCSV;
  $('#wb-clear-known').onclick = () => {
    if (!state.known.size || !confirm(t('wb.confirmClear', { n: state.known.size }))) return;
    state.known.clear();
    clearKnown().catch((err) => showBanner(err.message));
    refreshKnownMarks();
    renderWordbook();
  };
  $('#wb-list').addEventListener('click', (e) => {
    const i = e.target.closest('[data-del]')?.dataset.del;
    if (i == null) return;
    const [removed] = state.wordbook.splice(+i, 1);
    deleteWord(removed.key).catch((err) => showBanner(err.message));
    updateWordbookBadge();
    renderWordbook();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#card').hidden) closeCard();
    else if (!$('#chat').hidden) closeChat();
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('auth-required', () => { if (state.me) showLogin(); });

  // Offline and sync
  window.addEventListener('netchange', onNetChange);
  window.addEventListener('synced', onSynced);
  window.addEventListener('book-id', onBookId);
  window.addEventListener('sync-failed', (e) => {
    const [first] = e.detail;
    showBanner(t('net.syncFailed', { msg: first.message }));
  });
  $('#net-status').onclick = () => showBanner(t(net.online ? 'net.syncInfo' : 'net.offlineInfo'), 'info');
  await boot();
}

init();
