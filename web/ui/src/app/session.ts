// Accounts, pages and sync: signing in and out, which page is shown (the #hash
// routes), opening texts, the shelf, and keeping everything in step with the
// server and other devices.
import { t, getLang, setLang } from "@/lib/i18n.js"
import { api, net } from "@/lib/api.js"
import {
  openUser, forgetUser, finishPendingLogout, cachedMe, rememberMe, loadData, sync, flush,
  useGlossVersion, savePrefs as queuePrefs,
} from "@/lib/offline.js"
import {
  getBook, createBook, updateBook, saveProgress, deleteBook as removeBook, readLegacyData, hasLegacyData, clearLegacyData,
} from "@/lib/library.js"
import { PRESETS } from "@/lib/presets"
import {
  get, set, bump, showBanner, hideBanner, getLevel, type Book, type Prefs, type ServerConfig, type View,
} from "./store"
import { applyReading, currentReading, loadDeviceReading } from "./reading"
import {
  renderBook, resetLazy, startAnnotating, closeCard, hideFab, hideHint, maybeShowHint, refreshKnownMarks,
  resumeAnnotating, clearArticle, articleBlocks, showNewPart, screenInArticle,
} from "./engine"
import { flushProgress, holdProgress, leavePlace, settlePlace, noteInput } from "./progress"
import { closeChat, resetChats } from "./chat"
import { hideToast, showToast } from "./notice"
import { loadTokens, loadMembers, resetTokenShown } from "./settings"
import { prepareClip } from "./clip"

const CONFIG_KEY = "lingolens.config"

// ------------------------------------------------------------------ providers

// The signed-in user's model settings, as the server reports them: the active
// preset, its configuration, and whether a key is saved (never the key itself).
export function activeModel() {
  const m = get().model || {}
  const preset: string = m.active || ""
  const conf = m.providers?.[preset] || {}
  return {
    preset,
    kind: conf.kind || PRESETS[preset]?.kind || "",
    model: conf.model || "",
    hasKey: !!m.has_key?.[preset],
  }
}

export function providerProblem(): string {
  const m = activeModel()
  if (!m.preset) return t("problem.noModel")
  if (m.kind === "fake") return get().config.allow_fake ? "" : t("problem.fake")
  if (m.kind === "anthropic" && !m.hasKey) return t("problem.anthropicKey")
  if (m.kind === "openai" && !m.model) return t("problem.model")
  return ""
}

// Save profile changes; the UI has already applied them. Offline they wait in
// the outbox.
export function savePrefs(patch: Partial<Prefs>) {
  set((s) => ({ prefs: { ...s.prefs, ...patch } }))
  queuePrefs(patch).catch((err: Error) => showBanner(err.message))
}

// The level lives in the profile and is chosen in Settings; the reader
// annotates for it when a text is opened.
export function setLevel(id: string) {
  if (id === getLevel()) return
  savePrefs({ level: id })
}

export function chooseLanguage(lang: string) {
  if (lang === getLang()) return
  setLang(lang)
  if (get().me) savePrefs({ lang })
}

// ------------------------------------------------------------------ pages

function setView(view: View) {
  document.body.dataset.view = view
  if (view !== "reader") { hideHint(); hideToast() }
  if (view !== "settings") resetTokenShown() // don't leave a token on screen
  set({ view })
}

let openSeq = 0 // ignores a slow load if the reader has moved on

// keepPlace: reopening the same text after it changed; stay where the reader is.
export async function openBook(id: string, { keepPlace = false } = {}) {
  const seq = ++openSeq
  const y = window.scrollY
  flushProgress()
  let book: Book
  try {
    book = await getBook(id)
  } catch (err: any) {
    if (seq !== openSeq) return
    if (err.status !== 401) showBanner(err.message)
    if (err.status === 404 || err.offline) location.hash = "#/"
    return
  }
  if (seq !== openSeq) return
  if (!keepPlace) hideToast()
  leavePlace()
  closeCard()
  hideFab()
  hideBanner()
  set({ book })
  setView("reader")
  document.title = `${book.title} – LingoLens`

  resetLazy()
  renderBook(book)

  // Return to where the reader left off.
  requestAnimationFrame(() => {
    const article = document.getElementById("article")!
    const top = article.getBoundingClientRect().top + window.scrollY
    if (keepPlace) window.scrollTo(0, y)
    else window.scrollTo(0, (book.pos || 0) > 0 ? top + book.pos! * article.offsetHeight - 96 : 0)
    settlePlace()
    if (keepPlace) book.pos = screenInArticle().top
    bump()
    noteInput()
  })
  startAnnotating()
  maybeShowHint()
}

function leaveBook() {
  flushProgress()
  resetLazy()
  closeCard()
  hideFab()
  closeChat()
  set({ book: null })
  clearArticle()
}

export function showLibrary() {
  leaveBook()
  setView("library")
  document.title = "LingoLens"
  loadShelf() // refresh progress and anything changed on another device
  window.scrollTo(0, 0)
}

export function showSettings() {
  leaveBook()
  setView("settings")
  document.title = `${t("settings.page")} – LingoLens`
  loadTokens()
  if (get().me?.is_admin) loadMembers()
  // Opened at one section ("Set it up", "Change the defaults"), or at the top.
  const at = get().settingsAt
  requestAnimationFrame(() => {
    const el = at && document.getElementById(at)
    if (el) el.closest("section")!.scrollIntoView({ block: "start" })
    else window.scrollTo(0, 0)
  })
  set({ settingsAt: "" })
}

export function showClip() {
  leaveBook()
  hideBanner()
  setView("clip")
  document.title = `${t("clip.crumb")} – LingoLens`
  prepareClip()
  window.scrollTo(0, 0)
}

// Links that open Settings at one section ("Set it up" for the bookmarklet,
// "Change the defaults" in Reading Options) say which heading.
export function openSettingsAt(heading: string) {
  set({ settingsAt: heading, source: null })
  if (location.hash === "#/settings") showSettings()
  else location.hash = "#/settings"
}

let lastHash = location.hash || "#/"

export function route() {
  if (!get().me) {
    showLogin()
    return
  }
  const hash = location.hash || "#/"
  if (hash === "#/settings") {
    if (lastHash !== "#/settings") set({ returnTo: lastHash })
    showSettings()
  } else if (hash === "#/clip") {
    showClip()
  } else {
    const m = hash.match(/^#\/read\/([^/]+)$/)
    if (m) openBook(decodeURIComponent(m[1]))
    else showLibrary()
  }
  lastHash = hash
}

// ------------------------------------------------------------------ shelf

// The shelf as last seen (instantly, and offline), then fresh from the server:
// sync() sends waiting changes, fetches, and fires "synced" (see onSynced).
export async function loadShelf() {
  try {
    set({ books: await loadData("books"), booksLoaded: true })
  } catch (err: any) {
    if (err.status !== 401) showBanner(err.message)
  }
  if (net.online) sync()
}

export async function deleteBook(id: string) {
  try {
    await removeBook(id)
  } catch (err: any) {
    showBanner(err.message)
    return false
  }
  set((s) => ({ books: s.books.filter((b) => b.id !== id) }))
  return true
}

// A text saved as plain text that is really Markdown (pasted before the
// detection knew its marks, or sent by an agent as plain text): shown
// formatted from now on. Its words don't change, so it keeps its progress and
// place; what's been read goes first so the new version has it.
export async function formatAsMarkdown(book: Book) {
  await flushProgress()
  if (net.online) await flush()
  const saved = await updateBook(book.id, { title: book.title, content: book.content || "", format: "markdown" })
  holdProgress(book.id)
  if (get().book?.id === book.id) await openBook(saved.id)
}

export const SAMPLE_TITLE = "Why Small Habits Matter"
export const SAMPLE_TEXT = `Most people take for granted that big goals require big changes. In practice, by and large, the opposite is true: lasting progress tends to come from small, almost invisible adjustments that compound over time.

Consider someone who wants to read more. Rather than vowing to finish a book every week, they might commit to reading two pages after dinner. The task is so modest that it is hard to put off, and once the habit is established, it naturally expands.

Researchers point out a number of reasons this works. Small actions reduce the friction of getting started, so we are less likely to give up. Repetition makes behaviour automatic, freeing up attention for other things. And visible progress, however slight, reinforces our sense of identity as someone who follows through.

Of course, habits are not a panacea. They have to be taken into account alongside our circumstances, and when life gets hectic we may run out of energy for even the smallest routine. Still, in terms of sheer cost-effectiveness, few strategies come close.`

export async function addSampleBook() {
  try {
    const book = await createBook({ title: SAMPLE_TITLE, content: SAMPLE_TEXT })
    location.hash = `#/read/${encodeURIComponent(book.id)}`
  } catch (err: any) {
    showBanner(err.message)
  }
}

// ------------------------------------------------------------------ offline and sync

// The badge in the header: "Offline" while the server can't be reached, then
// "Syncing…" and "Synced" as changes made meanwhile go up. Saving a reading
// position online doesn't show it; that's routine.
let wasOffline = false
let netTimer = 0

export function renderNet(mode?: string) {
  clearTimeout(netTimer)
  if (!net.online) wasOffline = true // also when the app started offline
  if (!mode) {
    if (!get().me) mode = ""
    else if (!net.online) mode = "offline"
    else if (wasOffline && (net.pending || net.syncing)) mode = "syncing"
    else if (net.pending && !net.syncing) mode = "waiting"
    else mode = ""
  }
  if (mode === "waiting") {
    // Give a routine save a moment before calling it "not synced".
    if (get().net.mode !== "waiting") {
      netTimer = window.setTimeout(() => { if (net.pending && !net.syncing) renderNet("waiting!") }, 4000)
      return
    }
  }
  mode = mode.replace("!", "")
  const title = !mode ? "" : net.pending ? t("net.pending", { n: net.pending }) : t(`net.${mode}`)
  set({ net: { mode: mode as any, title } })
  if (mode === "synced") netTimer = window.setTimeout(() => renderNet(), 2500)
}

function onNetChange() {
  if (!net.online) wasOffline = true
  renderNet()
  if (net.online && get().book) resumeAnnotating()
}

// Fresh data arrived from the server (after sign-in, opening the shelf, or
// coming back online): show it.
async function onSynced() {
  if (!get().me) return
  let me: any, books: Book[], known: string[]
  try {
    [me, books, known] = await Promise.all(["me", "books", "known"].map(loadData))
  } catch {
    return
  }
  if (!get().me || me?.user?.id !== get().me!.id) return
  const before = { level: getLevel(), reading: JSON.stringify(currentReading()) }
  set((s) => ({
    me: me.user, model: me.model, prefs: { ...s.prefs, ...me.user.prefs },
    books, booksLoaded: true, known: new Set(known),
  }))
  // New defaults show where this device doesn't set its own.
  if (JSON.stringify(currentReading()) !== before.reading) applyReading()
  refreshKnownMarks()
  const lang = get().prefs.lang
  if (lang && lang !== getLang()) setLang(lang)
  const open = get().book
  if (open && getLevel() !== before.level) openBook(open.id)
  else refreshOpenBook(books)
  if (wasOffline) {
    wasOffline = false
    renderNet("synced")
  } else if (get().net.mode !== "synced") {
    renderNet()
  }
}

// The open text changed elsewhere (an agent added to it or rewrote it, another
// device edited it): show the new version, keeping the reader's place, and say
// so.
async function refreshOpenBook(books: Book[]) {
  const open = get().book
  const fresh = open && books.find((b) => b.id === open.id)
  if (!open || !fresh || fresh.updatedAt === open.updatedAt || get().view !== "reader") return
  // Not while the text is being edited here; the next check picks it up.
  if (get().source?.book?.id === open.id) return
  const seq = openSeq
  const book: Book | null = await getBook(open.id).catch(() => null)
  if (!book || get().book !== open || openSeq !== seq) return
  if (book.content === open.content) {
    open.updatedAt = book.updatedAt
    if (book.title !== open.title) {
      open.title = book.title
      document.title = `${book.title} – LingoLens`
      bump()
      showToast(t("reader.renamed", { title: book.title }))
    }
    return
  }
  // Added to the end (the old text is still all there): offer to jump to the
  // new part, which starts at the first block the old text didn't have.
  const old = (open.content || "").trimEnd()
  const added = (book.content || "").length > old.length && (book.content || "").startsWith(old)
  const oldBlocks = articleBlocks()
  await openBook(open.id, { keepPlace: true })
  if (get().book === open || get().book?.id !== open.id || openSeq !== seq + 1) return // didn't open
  if (!added) {
    showToast(t("reader.updated"))
    return
  }
  showToast(t("reader.added"), { action: { label: t("reader.showNew"), run: () => showNewPart(oldBlocks) } })
}

// While the shelf or a text is on screen, look for changes made elsewhere (an
// agent added a text or rewrote one, another device edited one) and sync when
// there are any. Coming back to the tab syncs at once (see visibilitychange).
const WATCH_MS = 30_000
let watching = false

async function checkForChanges() {
  const { view, me, booksLoaded, books } = get()
  if (watching || document.hidden || !me || !booksLoaded || !net.online || net.pending) return
  if (view !== "reader" && view !== "library") return
  watching = true
  try {
    const list: Book[] = await api("GET", "/api/books")
    const seen = new Map(books.map((b) => [b.id, b.updatedAt]))
    if (list.length !== seen.size || list.some((b) => seen.get(b.id) !== b.updatedAt)) await sync()
  } catch {
    // Offline or signed out: the usual handling takes over.
  } finally {
    watching = false
  }
}

// A text added offline reached the server and got its real id.
function onBookId(e: Event) {
  const { from, to } = (e as CustomEvent).detail
  set((s) => ({ books: s.books.map((b) => (b.id === from ? { ...b, id: to } : b)) }))
  const source = get().source
  if (source && source.book && source.book.id === from) source.book.id = to
  const open = get().book
  if (open && open.id === from) {
    open.id = to
    history.replaceState(null, "", `#/read/${encodeURIComponent(to)}`)
    lastHash = location.hash
    bump()
  }
}

// ------------------------------------------------------------------ accounts

async function boot() {
  await finishPendingLogout() // a sign-out made offline
  let me
  try {
    me = await api("GET", "/api/me")
  } catch (err: any) {
    if (err.status === 401) {
      showLogin()
      return
    }
    // The server can't be reached: carry on with this browser's copy, if any.
    const cached = (err.offline || err.status >= 500) && await cachedMe()
    if (cached) {
      await startSession(cached, { offline: true })
      return
    }
    if (err.offline) {
      showLogin()
      set({ loginError: t("net.loginOffline") })
    } else {
      showLogin()
      showBanner(err.message)
    }
    return
  }
  await startSession(me)
}

// Load everything that belongs to the signed-in user, then show the page they asked for.
export async function startSession(me: any, { offline = false } = {}) {
  await openUser(me.user.id)
  if (!offline) await rememberMe(me)
  me = (await loadData("me").catch(() => null)) || me // with settings changed offline
  set((s) => ({ me: me.user, model: me.model, prefs: { ...s.prefs, ...me.user.prefs } }))
  const lang = get().prefs.lang
  if (lang && lang !== getLang()) setLang(lang)
  loadDeviceReading()
  applyReading()
  try {
    set({ known: new Set(await loadData("known")) })
  } catch (err: any) {
    showBanner(err.message)
  }
  renderNet()
  if (hasLegacyData() && net.online) await importLegacyData()
  await loadShelf()
  if (!activeModel().preset) showBanner(t("banner.firstRun"), "info", { settingsLink: true })
  lastHash = ""
  route()
}

export function showLogin() {
  flushProgress()
  resetChats()
  leaveBook()
  set({
    me: null, model: null, books: [], booksLoaded: false, known: new Set(),
    source: null, tocOpen: false, loginError: "", banner: null,
  })
  setView("login")
  renderNet()
  document.title = `${t(get().config.needs_setup ? "setup.title" : "login.title")} – LingoLens`
}

function setNeedsSetup(on: boolean) {
  const config = { ...get().config, needs_setup: on }
  set({ config })
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)) } catch { /* private mode */ }
}

// The sign-in card doubles as first-run setup while the server has no accounts.
// Returns the field to focus when something is wrong.
export async function submitLogin(email: string, password: string, confirm: string): Promise<"email" | "password" | "confirm" | null> {
  const setup = !!get().config.needs_setup
  const fail = (msg: string, field: "email" | "password" | "confirm") => { set({ loginError: msg }); return field }
  email = email.trim()
  if (!email || !password) return fail(t("login.missing"), email ? "password" : "email")
  if (setup && [...password].length < 8) return fail(t("setup.short"), "password")
  if (setup && password !== confirm) return fail(t("setup.mismatch"), "confirm")
  set({ loginError: "" })
  try {
    await api("POST", setup ? "/api/auth/setup" : "/api/auth/login", { email, password })
    if (setup) setNeedsSetup(false)
    await startSession(await api("GET", "/api/me"))
    return null
  } catch (error: any) {
    if (setup && error.status === 409) { // someone else finished setup first
      setNeedsSetup(false)
      set({ loginError: t("setup.done") })
      return "password"
    }
    return fail(error.message, "password")
  }
}

// Signing out removes this account's copy from the browser. Changes that haven't
// reached the server yet would be lost, so ask first.
export async function signOut(confirmLoss: (n: number) => Promise<boolean>) {
  flushProgress()
  if (net.online && net.pending) await flush()
  if (net.pending && !(await confirmLoss(net.pending))) return
  let serverLoggedOut = true
  try {
    await api("POST", "/api/auth/logout", {})
  } catch (err: any) {
    serverLoggedOut = !err.offline // otherwise it is sent when back online
  }
  await forgetUser({ serverLoggedOut })
  location.hash = "#/"
  showLogin()
}

// Texts, known words and the model choice kept in this browser before accounts
// existed are copied into the account once, then removed from the browser
// (saved words too, though there's no wordbook to copy them to any more).
async function importLegacyData() {
  const data = readLegacyData()
  let books = 0
  for (const b of data.books) {
    try {
      const created = await createBook({ title: b.title || "", content: b.content, format: b.format || "text" })
      if (b.progress > 0) await saveProgress(created.id, b.pos || 0, b.progress)
      books++
    } catch { /* skip texts the server rejects */ }
  }
  for (const k of data.known) {
    if (get().known.has(k)) continue
    try {
      await api("PUT", `/api/known/${encodeURIComponent(k)}`)
      set((s) => ({ known: new Set([...s.known, k]) }))
    } catch { /* skip */ }
  }
  const m = data.model
  if (m && PRESETS[m.preset] && !get().model?.active) {
    try {
      set({
        model: await api("PUT", "/api/me/model", {
          preset: m.preset, kind: PRESETS[m.preset].kind,
          base_url: m.base_url ?? PRESETS[m.preset].base_url, model: m.model ?? PRESETS[m.preset].model,
          ...(m.api_key ? { api_key: m.api_key } : {}),
        }),
      })
    } catch { /* skip */ }
  }
  clearLegacyData()
  if (books) showBanner(t("import.done", { n: books }), "info")
}

// ------------------------------------------------------------------ start

export async function init() {
  // The server's levels and options; the last copy is used offline.
  let config: ServerConfig = get().config
  try {
    config = await (await fetch("/api/config")).json()
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
  } catch {
    try { config = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null") || config } catch { /* defaults */ }
  }
  set({ config })
  useGlossVersion(config.gloss_version)
  // Keeps the app itself for offline use (needs HTTPS, or localhost).
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* works online without it */ })
  }
  applyReading()

  window.addEventListener("langchange", () => {
    set({ lang: getLang() })
    if (get().view === "settings") document.title = `${t("settings.page")} – LingoLens`
    if (get().view === "login") document.title = `${t(get().config.needs_setup ? "setup.title" : "login.title")} – LingoLens`
  })
  window.addEventListener("pagehide", () => flushProgress({ closing: true }))
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      flushProgress({ closing: true })
      return
    }
    noteInput()
    if (get().me && net.online) sync() // back from another app, say an agent that added to this text
  })
  setInterval(checkForChanges, WATCH_MS)
  window.addEventListener("hashchange", route)
  window.addEventListener("auth-required", () => { if (get().me) showLogin() })
  window.addEventListener("netchange", onNetChange)
  window.addEventListener("synced", onSynced)
  window.addEventListener("book-id", onBookId)
  window.addEventListener("sync-failed", (e) => {
    const [first] = (e as CustomEvent).detail
    showBanner(t("net.syncFailed", { msg: first.message }))
  })
  await boot()
}
