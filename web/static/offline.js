// Offline support. Each account gets its own IndexedDB database in this browser:
//
//   kv       the last copy of the server's data: "me", "books", "wordbook", "known"
//   texts    book contents, so the whole shelf can be read offline
//   anns     glosses per paragraph and level, so they come back without the network
//   lookups  word explanations
//   outbox   changes not yet on the server, in order
//
// Changes (reading progress, words, settings, texts) are applied locally and put in
// the outbox, which is sent whenever the server is reachable. What the app shows is
// the server's last copy with the outbox replayed on top, so a change made offline
// stays visible until the server has it. After the outbox empties, the app pulls
// fresh data from the server, which picks up changes made on other devices.
//
// Without IndexedDB (some private windows) everything still works online; only the
// offline copy is missing.

import { t } from './i18n.js';
import { api, net, setOnline, offlineError, ApiError } from './api.js';

const DB_PREFIX = 'lingolens-u';
const USER_KEY = 'lingolens.user'; // localStorage: the account whose data is kept here
const LOGOUT_KEY = 'lingolens.logout'; // a sign-out made offline, sent when back online
export const LOCAL_ID = 'local-'; // books created offline get a temporary id

let db = null;
let uid = null;

const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ------------------------------------------------------------------ IndexedDB

const done = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

function openDB(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      d.createObjectStore('texts', { keyPath: 'id' });
      d.createObjectStore('anns');
      d.createObjectStore('lookups').createIndex('term', 'term');
      d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('blocked'));
  });
}

// Run `fn(stores…)` in one transaction; resolves with its result once committed.
function tx(names, mode, fn) {
  if (!db) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(names, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let result;
    Promise.resolve(fn(...[].concat(names).map((n) => t.objectStore(n))))
      .then((v) => { result = v; }, (err) => { try { t.abort(); } catch { /* done */ } reject(err); });
    t.oncomplete = () => resolve(result);
    t.onerror = t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

const quiet = (p) => p.catch(() => undefined); // the cache is best effort
const kvGet = (k) => quiet(tx('kv', 'readonly', (s) => done(s.get(k))));
const kvSet = (k, v) => quiet(tx('kv', 'readwrite', (s) => { s.put(v, k); }));

// ------------------------------------------------------------------ the signed-in account

export const cachedUserId = () => ls.get(USER_KEY);

// Open this account's data. Another account's data left in this browser is removed.
export async function openUser(id) {
  id = String(id);
  if (uid === id && db) return;
  closeUser();
  const prev = cachedUserId();
  if (prev && prev !== id) await deleteDB(prev);
  ls.set(USER_KEY, id);
  uid = id;
  try {
    db = await openDB(DB_PREFIX + id);
  } catch {
    db = null;
  }
  await dropOldGlosses();
  await countPending();
  navigator.storage?.persist?.().catch(() => {});
}

function closeUser() {
  db?.close();
  db = null;
  uid = null;
  net.pending = 0;
}

async function deleteDB(id) {
  await new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(DB_PREFIX + id);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

// Sign-out removes everything this account kept here. When offline, the server
// session is ended as soon as the server can be reached again.
export async function forgetUser({ serverLoggedOut }) {
  const id = uid || cachedUserId();
  closeUser();
  ls.del(USER_KEY);
  if (id) await deleteDB(id);
  if (!serverLoggedOut) ls.set(LOGOUT_KEY, '1');
}

export async function finishPendingLogout() {
  if (!ls.get(LOGOUT_KEY)) return;
  try {
    await api('POST', '/api/auth/logout', {});
    ls.del(LOGOUT_KEY);
  } catch (err) {
    if (!err.offline) ls.del(LOGOUT_KEY);
  }
}
export const logoutPending = () => !!ls.get(LOGOUT_KEY);

export const rememberMe = (me) => kvSet('me', me);

// This browser's copy of /api/me, for starting up while the server can't be reached.
export async function cachedMe() {
  const id = cachedUserId();
  if (!id || logoutPending()) return null;
  if (!db || uid !== id) await openUser(id);
  return (await view('me')) || null;
}

// ------------------------------------------------------------------ hashing

// A fast 53-bit string hash (cyrb53); keys for paragraphs and sentences.
export function hash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + str.length.toString(36);
}

// ------------------------------------------------------------------ glosses and lookups

const annKey = (level, text) => `${level}|${hash(text)}`;

// The rules glosses are made by (the server's gloss_version). Glosses saved under
// other rules are dropped, so a change to the rules reaches texts read before.
let glossVersion = '';
export function useGlossVersion(version) { glossVersion = version || ''; }

function dropOldGlosses() {
  if (!glossVersion) return undefined;
  return quiet(tx(['kv', 'anns'], 'readwrite', async (kv, anns) => {
    if (await done(kv.get('glossVersion')) === glossVersion) return;
    anns.clear();
    kv.put(glossVersion, 'glossVersion');
  }));
}

// Cached glosses for these paragraphs: Map text -> annotations.
export async function cachedAnns(level, texts) {
  const out = new Map();
  await quiet(tx('anns', 'readonly', async (s) => {
    const got = await Promise.all(texts.map((text) => done(s.get(annKey(level, text)))));
    got.forEach((v, i) => { if (v) out.set(texts[i], v.anns); });
  }));
  return out;
}

export function saveAnns(level, text, anns) {
  quiet(tx('anns', 'readwrite', (s) => { s.put({ anns, at: Date.now() }, annKey(level, text)); }));
}

const termKey = (level, term) => `${level}|${term.trim().toLowerCase()}`;

export function saveLookup(level, term, sentence, entry) {
  quiet(tx('lookups', 'readwrite', (s) => {
    s.put({ term: termKey(level, term), entry, at: Date.now() }, `${termKey(level, term)}|${hash(sentence)}`);
  }));
}

// The explanation saved for this word in this sentence; with `anySentence`, one
// saved for the word in another sentence (better than nothing offline).
export async function cachedLookup(level, term, sentence, { anySentence = false } = {}) {
  return quiet(tx('lookups', 'readonly', async (s) => {
    const exact = await done(s.get(`${termKey(level, term)}|${hash(sentence)}`));
    if (exact || !anySentence) return exact?.entry;
    const other = await done(s.index('term').get(termKey(level, term)));
    return other?.entry;
  }));
}

// ------------------------------------------------------------------ the outbox

// An operation: { seq, key, kind, method, path, body, at }. Operations with the same
// key are merged while waiting (only the latest reading position matters, a word
// saved then removed is a removal, a text edited twice is one edit).
let sendingSeq = null; // the operation on its way to the server; never merged into
const BOOK_KINDS = new Set(['create', 'update', 'delete', 'progress']);
const aboutBook = (o, id) => BOOK_KINDS.has(o.kind) && o.id === id;

const opsFor = (all, key) => all.filter((o) => o.key === key && o.seq !== sendingSeq);
const bookPath = (id) => `/api/books/${encodeURIComponent(id)}`;

async function enqueue(op) {
  op.at ||= new Date().toISOString();
  if (!db) return false;
  try {
    await tx('outbox', 'readwrite', async (s) => {
      const all = await done(s.getAll());
      const same = opsFor(all, op.key);
      const last = same[same.length - 1];
      const drop = (o) => s.delete(o.seq);
      if (op.kind === 'knownClear') {
        all.filter((o) => (o.kind === 'known' || o.kind === 'knownClear') && o.seq !== sendingSeq).forEach(drop);
        s.add(op);
      } else if (op.kind === 'delete') {
        // Nothing else about a deleted book needs sending.
        const id = op.id;
        all.filter((o) => aboutBook(o, id) && o.seq !== sendingSeq && o.kind !== 'create').forEach(drop);
        const create = all.find((o) => o.kind === 'create' && o.id === id);
        if (create && create.seq !== sendingSeq) drop(create); // never reached the server
        else s.add(op);
      } else if (last && op.kind === 'update' && last.kind === 'create') {
        last.body = { ...last.body, ...op.body };
        s.put(last);
      } else if (last && op.kind === 'prefs') {
        last.body = { ...last.body, ...op.body };
        last.at = op.at;
        s.put(last);
      } else if (last && op.kind === 'update' && last.kind === 'update') {
        const contentChanged = last.meta.contentChanged || op.meta.contentChanged;
        s.put({ ...op, seq: last.seq, meta: { ...op.meta, contentChanged, kept: keptThrough(last.meta, op.meta) } });
      } else if (last && op.kind === 'progress' && all.some((o) => o.kind === 'update' && o.id === op.id && o.seq > last.seq)) {
        s.add(op); // reading the edited text: it goes after the edit, not before it
      } else if (last && last.kind !== 'create') {
        s.put({ ...op, seq: last.seq });
      } else {
        s.add(op);
      }
    });
  } catch {
    return false;
  }
  await countPending();
  if (net.online) flush();
  return true;
}

async function outbox() {
  return (await quiet(tx('outbox', 'readonly', (s) => done(s.getAll())))) || [];
}

async function countPending() {
  const n = db ? (await outbox()).length : 0;
  if (n !== net.pending) {
    net.pending = n;
    window.dispatchEvent(new CustomEvent('netchange'));
  }
  return n;
}

// Replay waiting operations on the server's last copy of "me", "books",
// "wordbook" or "known".
function replay(name, data, ops = pendingOps) {
  if (data == null) return data;
  data = structuredClone(data);
  for (const o of ops) {
    if (name === 'me' && o.kind === 'prefs') {
      data.user.prefs = { ...data.user.prefs, ...o.body };
    } else if (name === 'books') {
      const i = data.findIndex((b) => b.id === o.id);
      if (o.kind === 'progress' && i >= 0) {
        data[i].pos = o.body.pos;
        data[i].progress = Math.max(data[i].progress || 0, o.body.progress);
        data[i].lastReadAt = o.at;
      } else if (o.kind === 'create' && i < 0) {
        data.unshift({ ...o.meta, ...metaFor(o.body), id: o.id });
      } else if (o.kind === 'update' && i >= 0) {
        const changed = o.body.content !== undefined && o.meta?.contentChanged;
        data[i] = { ...data[i], ...metaFor(o.body), updatedAt: o.meta?.updatedAt || data[i].updatedAt };
        if (o.meta?.expiresAt !== undefined) data[i].expiresAt = o.meta.expiresAt;
        if (changed) {
          const kept = o.meta.kept || 0; // as the server does: kept when added to, 0% when rewritten
          Object.assign(data[i], { progress: (data[i].progress || 0) * kept, pos: (data[i].pos || 0) * kept });
        }
      } else if (o.kind === 'delete' && i >= 0) {
        data.splice(i, 1);
      }
    } else if (name === 'wordbook' && o.kind === 'word') {
      const i = data.findIndex((w) => w.key === o.id);
      if (i >= 0) data.splice(i, 1);
      if (o.method === 'PUT') data.unshift(o.body);
    } else if (name === 'known') {
      if (o.kind === 'knownClear') data = [];
      else if (o.kind === 'known') {
        data = data.filter((k) => k !== o.id);
        if (o.method === 'PUT') data.push(o.id);
      }
    }
  }
  if (name === 'books') {
    data.sort((a, b) => (b.lastReadAt || b.updatedAt || '').localeCompare(a.lastReadAt || a.updatedAt || ''));
  }
  return data;
}

let pendingOps = []; // kept in step with the outbox for replay()

async function loadPendingOps() {
  pendingOps = db ? await outbox() : [];
  return pendingOps;
}

// The app's view of the data: the server's last copy plus waiting changes.
async function view(name, fallback) {
  const base = await kvGet(name);
  await loadPendingOps();
  return replay(name, base ?? fallback);
}

const PATHS = { me: '/api/me', books: '/api/books', wordbook: '/api/wordbook', known: '/api/known' };

// "me", "books", "wordbook" or "known" as the app should show it. Comes from the
// server when there is no copy here yet (or no IndexedDB at all).
export async function loadData(name) {
  const base = db ? await kvGet(name) : undefined;
  if (base === undefined) {
    const fresh = await api('GET', PATHS[name]);
    if (!db) return fresh;
    await kvSet(name, fresh);
  }
  return view(name);
}

// ------------------------------------------------------------------ texts the server would count

const WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const countWords = (s) => (s.match(WORD_RE) || []).length;

function deriveTitle(content) {
  for (let line of content.split('\n')) {
    line = line.replace(/^[#>*\- \t]+/, '').trim();
    if (!line) continue;
    const r = [...line];
    if (r.length <= 60) return line;
    let cut = r.slice(0, 60).join('');
    const i = cut.lastIndexOf(' ');
    if (i > 30) cut = cut.slice(0, i);
    return cut + '…';
  }
  return 'Untitled';
}

// When a text with ttlDays deletes itself, as the server will set it.
export const expiresFor = (ttlDays, from = Date.now()) =>
  (ttlDays > 0 ? new Date(from + ttlDays * 864e5).toISOString().replace(/\.\d+Z$/, 'Z') : '');

// Mirrors store.keptShare: when `next` only adds to the end of `old`, the share
// of it that `old` takes up, by which the reading place and progress scale to
// stay at the same spot. Undefined when the text was rewritten.
function keptShare(old, next) {
  const base = old.trimEnd();
  return base && next.startsWith(base) ? base.length / next.length : undefined;
}

// Two edits waiting as one: the share kept through both (an edit that left
// the content alone keeps it all), or undefined if either rewrote the text.
function keptThrough(a, b) {
  const kept = (m) => (m.contentChanged ? m.kept : 1);
  const [x, y] = [kept(a), kept(b)];
  return x === undefined || y === undefined ? undefined : x * y;
}

function metaFor(body) {
  const m = {};
  if (body.title !== undefined) m.title = (body.title || '').trim() || deriveTitle(body.content || '');
  if (body.format) m.format = body.format;
  if (body.content !== undefined) m.words = countWords(body.content);
  return m;
}

// ------------------------------------------------------------------ changes

// Reading position and progress. `closing` also sends it right away with
// keepalive, so it reaches the server even if the page is closing.
export function saveProgress(id, pos, progress, { closing = false } = {}) {
  const body = { pos, progress, at: new Date().toISOString() };
  const queued = enqueue({ key: `progress:${id}`, kind: 'progress', id, method: 'PUT', path: `${bookPath(id)}/progress`, body });
  if ((closing || !db) && net.online && !id.startsWith(LOCAL_ID)) {
    api('PUT', `${bookPath(id)}/progress`, body, { keepalive: closing }).catch(() => {});
  }
  return queued;
}

export function savePrefs(patch) {
  return sendOrQueue({ key: 'prefs', kind: 'prefs', method: 'PUT', path: '/api/me/prefs', body: patch });
}

export function putWord(entry) {
  return sendOrQueue({ key: `word:${entry.key}`, kind: 'word', id: entry.key, method: 'PUT', path: `/api/wordbook/${encodeURIComponent(entry.key)}`, body: entry });
}

export function deleteWord(key) {
  return sendOrQueue({ key: `word:${key}`, kind: 'word', id: key, method: 'DELETE', path: `/api/wordbook/${encodeURIComponent(key)}` });
}

export function setKnown(lemma, known) {
  return sendOrQueue({ key: `known:${lemma}`, kind: 'known', id: lemma, method: known ? 'PUT' : 'DELETE', path: `/api/known/${encodeURIComponent(lemma)}` });
}

export function clearKnown() {
  return sendOrQueue({ key: 'knownClear', kind: 'knownClear', method: 'DELETE', path: '/api/known' });
}

// Small changes always go through the outbox, so they survive going offline
// mid-request; without IndexedDB they are sent directly.
async function sendOrQueue(op) {
  if (await enqueue(op)) return;
  await api(op.method, op.path, op.body).catch((err) => { if (!err.offline) throw err; });
}

// Adding, editing and deleting texts talk to the server directly when it is
// reachable, so its answer (an error, or the new book) comes back at once.
// Offline they are queued, and the app carries on with a local copy.
export async function createText(body) {
  if (net.online || !db) {
    try {
      const book = await api('POST', '/api/books', body);
      await storeText(book);
      await mergeSnapshot('books', (list) => [stripContent(book), ...list.filter((b) => b.id !== book.id)]);
      return book;
    } catch (err) {
      if (!err.offline || !db) throw err;
    }
  }
  const id = LOCAL_ID + Math.random().toString(36).slice(2, 10);
  const now = new Date().toISOString();
  const meta = { id, progress: 0, pos: 0, createdAt: now, updatedAt: now, lastReadAt: '', local: true, expiresAt: expiresFor(body.ttlDays) };
  await storeText({ id, content: body.content, format: body.format, updatedAt: now });
  await enqueue({ key: `book:${id}`, kind: 'create', id, method: 'POST', path: '/api/books', body: { ...body, clientRef: id }, meta });
  return { ...meta, ...metaFor(body), content: body.content };
}

export async function updateText(id, body) {
  const queuedBefore = (await outbox()).some((o) => aboutBook(o, id) && o.kind !== 'progress');
  if ((net.online || !db) && !id.startsWith(LOCAL_ID) && !queuedBefore) {
    try {
      const book = await api('PUT', bookPath(id), body);
      await storeText(book);
      await mergeSnapshot('books', (list) => list.map((b) => (b.id === id ? stripContent(book) : b)));
      return book;
    } catch (err) {
      if (!err.offline || !db) throw err;
    }
  }
  const old = await quiet(tx('texts', 'readonly', (s) => done(s.get(id))));
  const now = new Date().toISOString();
  const contentChanged = !old || old.content !== body.content;
  const kept = contentChanged && old ? keptShare(old.content, body.content) : undefined;
  await storeText({ id, content: body.content, format: body.format, updatedAt: now });
  const expiresAt = body.ttlDays === undefined ? undefined : expiresFor(body.ttlDays);
  await enqueue({ key: `book:${id}`, kind: 'update', id, method: 'PUT', path: bookPath(id), body, meta: { updatedAt: now, contentChanged, kept, expiresAt } });
  const book = (await view('books', [])).find((b) => b.id === id);
  return { ...book, content: body.content };
}

export async function deleteText(id) {
  if ((net.online || !db) && !id.startsWith(LOCAL_ID)) {
    try {
      await api('DELETE', bookPath(id));
      await quiet(tx('texts', 'readwrite', (s) => { s.delete(id); }));
      await mergeSnapshot('books', (list) => list.filter((b) => b.id !== id));
      await enqueueCleanup(id);
      return;
    } catch (err) {
      if (!err.offline || !db) throw err;
    }
  }
  await quiet(tx('texts', 'readwrite', (s) => { s.delete(id); }));
  await enqueue({ key: `book:${id}`, kind: 'delete', id, method: 'DELETE', path: bookPath(id) });
}

// A book deleted online can still have a waiting position update; drop it.
async function enqueueCleanup(id) {
  await quiet(tx('outbox', 'readwrite', async (s) => {
    for (const o of await done(s.getAll())) if (aboutBook(o, id) && o.seq !== sendingSeq) s.delete(o.seq);
  }));
  await countPending();
}

const stripContent = ({ content, ...meta }) => meta;

function storeText(book) {
  return quiet(tx('texts', 'readwrite', (s) => {
    s.put({ id: book.id, content: book.content, format: book.format, updatedAt: book.updatedAt });
  }));
}

async function mergeSnapshot(name, fn) {
  const cur = await kvGet(name);
  if (cur) await kvSet(name, fn(cur));
}

// ------------------------------------------------------------------ reading

// A book with its content: from this browser when the saved copy is current,
// otherwise from the server (and saved for next time).
export async function getText(id) {
  const meta = (await view('books', [])).find((b) => b.id === id);
  const saved = await quiet(tx('texts', 'readonly', (s) => done(s.get(id))));
  const current = saved && meta && (saved.updatedAt === meta.updatedAt || id.startsWith(LOCAL_ID));
  if (current || (saved && !net.online)) return { ...meta, format: saved.format || meta?.format, content: saved.content };
  try {
    const book = await api('GET', bookPath(id));
    await storeText(book);
    return replay('books', [book])[0] || book;
  } catch (err) {
    if (err.offline && saved) return { ...meta, content: saved.content };
    if (err.offline) throw new ApiError(t('net.notSaved'), 0, { offline: true });
    throw err;
  }
}

// ------------------------------------------------------------------ sync

let flushing = null;
let needsPull = false; // fetch fresh data once the outbox is empty
let retryTimer = 0;
let retryDelay = 5000;

// Send the outbox in order. Stops when the server can't be reached (it is sent
// again when it can) or the session has ended (it is sent after signing in).
export function flush() {
  // Set `flushing` before any of doFlush runs: it fires events whose listeners
  // call flush() again, which must join this run, not start a second one.
  flushing ||= (async () => {
    await null;
    return doFlush();
  })().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  if (!db || !net.online) return;
  let sent = 0;
  const failures = [];
  clearTimeout(retryTimer);
  setSyncing(true);
  try {
    for (;;) {
      const [op] = await outbox();
      if (!op) break;
      sendingSeq = op.seq;
      let res;
      let err;
      try {
        res = await api(op.method, op.path, op.body);
      } catch (e) {
        err = e;
      } finally {
        sendingSeq = null;
      }
      if (err?.offline || err?.status === 401) break;
      if (err && (err.status >= 500 || err.status === 429 || err.status === 408)) {
        retryTimer = setTimeout(flush, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 120_000);
        break;
      }
      retryDelay = 5000;
      if (err && err.status !== 404) failures.push({ op, message: err.message });
      await settle(op, res, err);
      sent++;
    }
  } finally {
    setSyncing(false);
  }
  await countPending();
  if (failures.length) {
    window.dispatchEvent(new CustomEvent('sync-failed', { detail: failures }));
  }
  if (sent) needsPull = true;
  if (needsPull && net.pending === 0 && net.online) await pull();
}

// Send waiting changes, then fetch fresh data (at sign-in, and when back online).
export function sync() {
  needsPull = true;
  return flush();
}

// After an operation was answered: record the result in the server's copy.
async function settle(op, res, err) {
  await quiet(tx('outbox', 'readwrite', (s) => { s.delete(op.seq); }));
  if (op.kind === 'create') {
    if (err) {
      // The server refused a text made offline: drop it and what was queued for it.
      await enqueueCleanup(op.id);
      await quiet(tx('texts', 'readwrite', (s) => { s.delete(op.id); }));
      return;
    }
    await adoptId(op.id, res);
    return;
  }
  if (err) return;
  if (op.kind === 'update' && res?.id) {
    await storeText(res);
    await mergeSnapshot('books', (list) => list.map((b) => (b.id === res.id ? stripContent(res) : b)));
    return;
  }
  for (const name of ['me', 'books', 'wordbook', 'known']) {
    const cur = await kvGet(name);
    if (cur) await kvSet(name, replay(name, cur, [op]));
  }
}

// A text created offline got its real id: move everything over to it.
async function adoptId(tempId, book) {
  const realPath = bookPath(book.id);
  await quiet(tx('outbox', 'readwrite', async (s) => {
    for (const o of await done(s.getAll())) {
      if (!aboutBook(o, tempId)) continue;
      o.id = book.id;
      o.key = o.key.replace(tempId, book.id);
      o.path = o.path.replace(bookPath(tempId), realPath);
      s.put(o);
    }
  }));
  const saved = await quiet(tx('texts', 'readonly', (s) => done(s.get(tempId))));
  await quiet(tx('texts', 'readwrite', (s) => {
    s.delete(tempId);
    s.put({ id: book.id, content: saved?.content ?? book.content, format: book.format, updatedAt: book.updatedAt });
  }));
  await mergeSnapshot('books', (list) => [stripContent(book), ...list.filter((b) => b.id !== book.id)]);
  window.dispatchEvent(new CustomEvent('book-id', { detail: { from: tempId, to: book.id } }));
}

// Fetch the account's data from the server (only with an empty outbox, so the
// server's copy already has every local change).
async function pull() {
  if (!db || !net.online) return false;
  try {
    const [me, books, wordbook, known] = await Promise.all([
      api('GET', '/api/me'), api('GET', '/api/books'), api('GET', '/api/wordbook'), api('GET', '/api/known'),
    ]);
    await Promise.all([kvSet('me', me), kvSet('books', books), kvSet('wordbook', wordbook), kvSet('known', known)]);
    needsPull = false;
    window.dispatchEvent(new CustomEvent('synced'));
    saveTextsForOffline(books);
    return true;
  } catch {
    return false;
  }
}

// Save every book's content, so the whole shelf can be read offline. One at a
// time, in the background; texts already saved and unchanged are skipped.
let saving = false;
async function saveTextsForOffline(books) {
  if (saving || !db) return;
  saving = true;
  try {
    const saved = new Map(((await quiet(tx('texts', 'readonly', (s) => done(s.getAll())))) || []).map((x) => [x.id, x.updatedAt]));
    const ids = new Set(books.map((b) => b.id));
    const waiting = new Set((await outbox()).filter((o) => BOOK_KINDS.has(o.kind)).map((o) => o.id));
    await quiet(tx('texts', 'readwrite', (s) => {
      for (const id of saved.keys()) if (!ids.has(id) && !waiting.has(id)) s.delete(id);
    }));
    for (const b of books) {
      if (!net.online || !db) break;
      if (saved.get(b.id) === b.updatedAt) continue;
      try {
        await storeText(await api('GET', bookPath(b.id)));
      } catch (err) {
        if (err.offline || err.status === 401) break;
      }
    }
  } finally {
    saving = false;
  }
}

// ------------------------------------------------------------------ connectivity

function setSyncing(on) {
  if (!!net.syncing === on) return;
  net.syncing = on;
  window.dispatchEvent(new CustomEvent('netchange'));
}

let pingTimer = 0;

// While offline, ask the server now and then whether it is back.
async function ping() {
  clearTimeout(pingTimer);
  if (net.online) return;
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok) setOnline(true);
  } catch { /* still offline */ }
  if (!net.online) pingTimer = setTimeout(ping, 15_000);
}

window.addEventListener('netchange', () => {
  if (!net.online) needsPull = true; // other devices may change things meanwhile
  if (net.online) {
    clearTimeout(pingTimer);
    if (net.pending || needsPull) flush();
  } else if (!pingTimer) {
    pingTimer = setTimeout(ping, 15_000);
  }
});
window.addEventListener('online', () => { setOnline(true); ping(); flush(); });
window.addEventListener('offline', () => setOnline(false));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!net.online) ping();
  else if (net.pending) flush();
});

// Re-exported so the app has one place for network state.
export { net, offlineError };
