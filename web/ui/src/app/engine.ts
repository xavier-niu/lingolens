// The reading engine: the text in #article, its paragraphs (segments), the
// glosses wrapped around words in <ruby>, annotation as paragraphs come into
// view, and words looked up by clicking. It works on the DOM of the article
// directly; React draws everything around it (ReaderView owns the element).
import { t } from "@/lib/i18n.js"
import { postStream, api, net } from "@/lib/api.js"
import { cachedAnns, saveAnns, cachedLookup, saveLookup, setKnown } from "@/lib/offline.js"
import { wrapWidth, wrapsBefore } from "@/lib/library.js"
import { renderMarkdown, escapeHTML, sentenceAround } from "@/lib/markdown"
import { get, set, showBanner, getLevel, isTouch, type Book, type SelectionInfo } from "./store"
import { providerProblem } from "./session"
import { openChat } from "./chat"
import { noteTokens } from "./books"

export interface Ann {
  start: number
  end: number
  text: string
  kind: string
  lemma: string
  zh: string
  ipa?: string
  pos?: string
  segId: string
  lookup?: boolean // looked up by clicking, not annotated
  glossed?: boolean // …and its gloss added to the text
  entry?: Entry
  loading?: boolean
  error?: string
}
export interface Entry {
  zh: string
  lemma?: string
  ipa?: string
  pos?: string
  explanation?: string
  senses?: { pos: string; zh: string; en: string }[]
  collocations?: { en: string; zh: string }[]
  examples?: { en: string; zh: string }[]
}
interface Seg { el: HTMLElement; text: string; near?: boolean; status?: "queued" | "done" | "failed" | "waiting" }

export const engine = {
  article: null as HTMLElement | null,
  segments: new Map<string, Seg>(),
  anns: [] as Ann[],
  activeAnn: null as number | null,
}

const articleEl = () => engine.article ?? (document.getElementById("article") as HTMLElement)

// ------------------------------------------------------------------ rendering

// Plain text: blank lines separate paragraphs; single line breaks are kept,
// except in text wrapped at a fixed width (see wrapWidth), where lines that
// only ran out of room flow on. A "\n" stays between lines either way, so the
// segment text (and the glosses' offsets in it) doesn't change; a kept break
// adds a <br>. A line of dashes on its own (what goes between a text and what
// was added to it) is a dividing line.
function renderPlainText(src: string): string {
  const text = src.replace(/\r\n?/g, "\n")
  const width = wrapWidth(text)
  const lines = (p: string) => p.split("\n").map((line, i, all) => escapeHTML(line)
    + (i === all.length - 1 ? "" : width && wrapsBefore(line, all[i + 1], width) ? "\n" : "<br>\n")).join("")
  return text.split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim())
    .map((p) => (/^-{3,}$/.test(p.trim()) ? "<hr>" : `<p>${lines(p)}</p>`))
    .join("\n")
}

const renderSource = (book: Book) => (book.format === "markdown" ? renderMarkdown(book.content || "") : renderPlainText(book.content || ""))

// Puts a book's text in the article and finds its paragraphs and sections.
export function renderBook(book: Book) {
  const article = articleEl()
  article.innerHTML = renderSource(book)
  for (const a of article.querySelectorAll("a[href]")) {
    (a as HTMLAnchorElement).target = "_blank";
    (a as HTMLAnchorElement).rel = "noopener noreferrer"
  }
  engine.anns = []
  collectSegments(article)
  buildContents(article)
}

export function clearArticle() {
  const article = articleEl()
  if (article) article.innerHTML = ""
  engine.segments.clear()
  engine.anns = []
  set({ toc: [] })
}

// ------------------------------------------------------------------ segmentation

export const BLOCK_SEL = "p,li,h1,h2,h3,h4,h5,h6,td,th,dt,dd,blockquote,figcaption"

// Text nodes that belong directly to `block` (not to a nested block, not to <rt>, not in <pre>).
function ownTextNodes(block: Element): Text[] {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement
      if (!p || p.closest("rt, pre, script, style")) return NodeFilter.FILTER_REJECT
      return p.closest(BLOCK_SEL) === block ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

function collectSegments(root: HTMLElement) {
  engine.segments.clear()
  let i = 0
  for (const el of root.querySelectorAll<HTMLElement>(BLOCK_SEL)) {
    if (el.closest("pre")) continue
    const text = ownTextNodes(el).map((n) => n.data).join("")
    if (!/[A-Za-z]{2,}/.test(text)) continue
    const id = `s${i++}`
    el.dataset.seg = id
    engine.segments.set(id, { el, text })
  }
}

// ------------------------------------------------------------------ annotation rendering

export const rubyEl = (idx: number | null) =>
  idx == null ? null : articleEl()?.querySelector<HTMLElement>(`ruby.ann[data-ann="${idx}"]`) ?? null

function applyAnnotations(segId: string, anns: Ann[]) {
  const seg = engine.segments.get(segId)
  if (!seg || !anns?.length) return
  let pos = 0
  const spans = ownTextNodes(seg.el).map((n) => {
    const s = pos
    pos += n.data.length
    return { n, s, e: pos }
  })
  // Wrap from the end so earlier offsets stay valid while nodes are split.
  for (const a of [...anns].sort((x, y) => y.start - x.start)) {
    const sp = spans.find((x) => a.start >= x.s && a.end <= x.e)
    if (!sp || sp.n.parentElement!.closest("code, ruby")) continue // e.g. already looked up by the user
    const node = sp.n
    const local = a.start - sp.s
    if (node.data.slice(local, a.end - sp.s) !== a.text) continue // offsets drifted; skip
    node.splitText(a.end - sp.s)
    const mid = node.splitText(local)
    const idx = engine.anns.push({ ...a, segId }) - 1
    mid.replaceWith(makeRuby(mid.data, a, idx))
  }
}

function makeRuby(text: string, a: Ann, idx: number) {
  const ruby = document.createElement("ruby")
  ruby.className = `ann ann-${a.kind === "phrase" ? "phrase" : "word"}`
  if (get().known.has(a.lemma.toLowerCase())) ruby.classList.add("known")
  ruby.dataset.ann = String(idx)
  ruby.append(text)
  if (a.zh) {
    const rt = document.createElement("rt")
    rt.textContent = a.zh
    ruby.append(rt)
  }
  return ruby
}

function setGloss(idx: number) {
  const el = rubyEl(idx)
  const a = engine.anns[idx]
  if (!el || !a?.zh) return
  let rt = el.querySelector("rt")
  if (!rt) {
    rt = document.createElement("rt")
    el.append(rt)
  }
  rt.textContent = a.zh
}

export function refreshKnownMarks() {
  const known = get().known
  for (const el of articleEl()?.querySelectorAll<HTMLElement>("ruby.ann") ?? []) {
    const a = engine.anns[+el.dataset.ann!]
    el.classList.toggle("known", !!a && known.has(a.lemma.toLowerCase()))
  }
}

// ------------------------------------------------------------------ annotate flow (lazy)

// Paragraphs are annotated only when they come near the viewport, in batches of
// about LAZY.batchChars characters, so a long article never spends tokens on parts
// that are not read. The server additionally caches results per paragraph.
//
// A model answers a whole batch at once, so what's on screen goes first and in
// smaller batches, and work on paragraphs the reader has moved away from gives way:
// after a jump through Contents, the new screen doesn't wait for the old one.
const LAZY = {
  batchChars: 1800, screenBatchChars: 900, maxInFlight: 2, rootMargin: "1000px 0px",
  headerH: 56, spinnerShow: 300, spinnerHide: 100,
}
interface Batch { ctl: AbortController; pending: Set<string>; left: boolean }
const lazy = {
  gen: 0,
  observer: null as IntersectionObserver | null,
  queue: [] as string[],
  batches: new Set<Batch>(),
  lastError: "",
  spinnerTimer: 0,
}

export function resetLazy() {
  lazy.gen++
  lazy.observer?.disconnect()
  lazy.observer = null
  for (const b of lazy.batches) b.ctl.abort()
  lazy.batches.clear()
  lazy.queue = []
  lazy.lastError = ""
  clearTimeout(lazy.spinnerTimer)
  lazy.spinnerTimer = 0
  set({ annotating: { shown: false, n: 0 } })
}

export const annotatingBusy = () => lazy.queue.length > 0 || lazy.batches.size > 0

// How far a paragraph is from being read: 0 on screen, then what's coming up, then
// what has been passed, nearest first.
function screenDistance(el: Element) {
  const { top, bottom } = el.getBoundingClientRect()
  if (bottom <= LAZY.headerH) return 1e6 + LAZY.headerH - bottom
  return Math.max(0, top - innerHeight)
}

// The header says so while text on screen is waiting for its glosses. Paragraphs
// annotated ahead of the reader need no announcing. It takes a moment to change, so
// glosses saved in this browser don't flash it, and it doesn't blink on a jump, where
// the scroll is noticed just before the paragraphs on the new screen are.
export function updateProgress() {
  const waiting = [...lazy.queue, ...[...lazy.batches].flatMap((b) => [...b.pending])]
  const n = waiting.filter((id) => {
    const seg = engine.segments.get(id)
    return seg && screenDistance(seg.el) === 0
  }).length
  const cur = get().annotating
  if (n && cur.n !== n) set({ annotating: { ...cur, n } })
  const shown = get().annotating.shown
  if (!!n === shown) {
    clearTimeout(lazy.spinnerTimer)
    lazy.spinnerTimer = 0
  } else if (!lazy.spinnerTimer) {
    lazy.spinnerTimer = window.setTimeout(() => {
      lazy.spinnerTimer = 0
      const a = get().annotating
      set({ annotating: { ...a, shown: !a.shown } })
    }, n ? LAZY.spinnerShow : LAZY.spinnerHide)
  }
}

export function startAnnotating() {
  resetLazy()
  const problem = providerProblem()
  if (problem) {
    showBanner(t("banner.noAnn", { problem }), "error", { settingsLink: true })
    return
  }
  lazy.observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const id = (en.target as HTMLElement).dataset.seg!
      const seg = engine.segments.get(id)
      if (!seg) continue
      seg.near = en.isIntersecting
      if (seg.near && !seg.status) {
        seg.status = "queued"
        lazy.queue.push(id)
      }
    }
    pump()
  }, { rootMargin: LAZY.rootMargin })
  for (const seg of engine.segments.values()) {
    if (seg.status !== "done") lazy.observer.observe(seg.el)
  }
}

function pump() {
  const gen = lazy.gen
  const seg = (id: string) => engine.segments.get(id)!
  // Forget paragraphs the reader has moved away from; they return if the reader does.
  lazy.queue = lazy.queue.filter((id) => {
    if (!seg(id).near) seg(id).status = undefined
    return seg(id).near
  })
  // A request for them shouldn't hold up what the reader moved to, either.
  if (lazy.queue.length) {
    for (const batch of lazy.batches) {
      if ([...batch.pending].some((id) => engine.segments.get(id)?.near)) continue
      batch.left = true
      batch.ctl.abort()
    }
  }
  const away = new Map(lazy.queue.map((id) => [id, screenDistance(seg(id).el)]))
  lazy.queue.sort((a, b) => away.get(a)! - away.get(b)! || +a.slice(1) - +b.slice(1))
  while (lazy.batches.size < LAZY.maxInFlight && lazy.queue.length) {
    const onScreen = away.get(lazy.queue[0]) === 0
    const limit = onScreen ? LAZY.screenBatchChars : LAZY.batchChars
    const batch: string[] = []
    let size = 0
    while (lazy.queue.length) {
      const id = lazy.queue[0]
      const len = seg(id).text.length
      if (batch.length && (size + len > limit || (away.get(id) === 0) !== onScreen)) break
      batch.push(lazy.queue.shift()!)
      size += len
    }
    runBatch(batch, gen)
  }
  updateProgress()
}

function finishSegment(id: string, ok: boolean) {
  const seg = engine.segments.get(id)
  if (!seg) return
  seg.status = ok ? "done" : "failed"
  seg.el.classList.toggle("seg-failed", !ok)
  lazy.observer?.unobserve(seg.el)
}

async function runBatch(ids: string[], gen: number) {
  const batch: Batch = { ctl: new AbortController(), pending: new Set(ids), left: false }
  const { ctl, pending } = batch
  lazy.batches.add(batch)
  const level = getLevel()
  // Paragraphs glossed before come from this browser, without the network.
  const saved = await cachedAnns(level, ids.map((id) => engine.segments.get(id)!.text))
  if (gen !== lazy.gen) return
  for (const id of ids) {
    const anns = saved.get(engine.segments.get(id)!.text)
    if (!anns) continue
    applyAnnotations(id, anns)
    finishSegment(id, true)
    pending.delete(id)
  }
  updateProgress()
  let offline = false
  try {
    if (!pending.size) return
    if (!net.online) {
      offline = true
      return
    }
    const book = get().book?.id || ""
    const events = await postStream("/api/annotate", {
      book,
      level,
      segments: [...pending].map((id) => ({ id, text: engine.segments.get(id)!.text })),
    }, ctl.signal)
    for await (const ev of events) {
      if (ev.type === "done") noteTokens(book, ev.bookTokens) // spent, whether or not the reader stayed
      if (gen !== lazy.gen) return
      if (ev.type === "segment") {
        const seg = engine.segments.get(ev.id)
        if (seg) saveAnns(level, seg.text, ev.annotations)
        applyAnnotations(ev.id, ev.annotations)
        finishSegment(ev.id, true)
        pending.delete(ev.id)
      } else if (ev.type === "error") {
        lazy.lastError = ev.error
        for (const id of ev.ids || []) {
          finishSegment(id, false)
          pending.delete(id)
        }
      }
      updateProgress()
    }
  } catch (err: any) {
    if (err.name === "AbortError" || gen !== lazy.gen) return
    // Lost the connection (or the stream broke off): try again once back online.
    if (err.offline || err instanceof TypeError) offline = true
    else lazy.lastError = err.message
  } finally {
    lazy.batches.delete(batch)
    if (gen === lazy.gen) finishBatch(batch, offline)
  }
}

function finishBatch({ pending, left }: Batch, offline: boolean) {
  for (const id of pending) {
    const seg = engine.segments.get(id)
    if (left && seg) {
      lazy.queue.push(id) // pump() forgets it unless the reader is already back
    } else if (offline && seg) {
      seg.status = "waiting" // glossed when the connection is back (see 'netchange')
    } else {
      finishSegment(id, false)
    }
  }
  updateProgress()
  if (offline) return
  if (lazy.lastError) {
    const msg = lazy.lastError
    showBanner(t("banner.annFail", { msg }))
    if (/key|auth|401|403/i.test(msg)) {
      resetLazy() // stop hammering the provider with a bad key
      showBanner(t("banner.annFail", { msg }), "error", { settingsLink: true })
      return
    }
    lazy.lastError = ""
  }
  pump()
}

// Paragraphs that came into view offline get their glosses now.
export function resumeAnnotating() {
  if (!lazy.observer) return
  let n = 0
  for (const [id, seg] of engine.segments) {
    if (seg.status !== "waiting") continue
    seg.status = "queued"
    lazy.queue.push(id)
    n++
  }
  if (n) pump()
}

// ------------------------------------------------------------------ contents

// A table of contents for long texts with sections (EPUB chapters, long articles).
function buildContents(article: HTMLElement) {
  const heads = [...article.querySelectorAll("h1, h2, h3")]
  // Skip a single top heading that just repeats the title.
  const top = Math.min(...heads.map((h) => +h.tagName[1]))
  heads.forEach((h, i) => { h.id ||= `sec-${i + 1}` })
  set({
    toc: heads.length < 3 ? [] : heads.map((h) => ({ id: h.id, text: (h.textContent || "").trim(), level: +h.tagName[1] - top + 1 })),
  })
}

// ------------------------------------------------------------------ click any word to look it up

// Find the English word under the pointer in a plain (un-annotated) text node.
export function wordAtPoint(x: number, y: number) {
  let node: Node | undefined
  let offset = 0
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y)
    if (!p) return null
    node = p.offsetNode
    offset = p.offset
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y)
    if (!r) return null
    node = r.startContainer
    offset = r.startOffset
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null
  const parent = node.parentElement
  if (!parent || parent.closest("ruby, rt, code, pre, a")) return null
  const block = parent.closest<HTMLElement>(BLOCK_SEL)
  if (!block?.dataset.seg) return null

  const text = (node as Text).data
  const isWordChar = (ch: string) => /[A-Za-z'’-]/.test(ch)
  let s = offset
  let e = offset
  while (s > 0 && isWordChar(text[s - 1])) s--
  while (e < text.length && isWordChar(text[e])) e++
  while (s < e && /['’-]/.test(text[s])) s++
  while (e > s && /['’-]/.test(text[e - 1])) e--
  if (e - s < 2) return null

  // Make sure the pointer is actually on the word, not in the margin next to it.
  const range = document.createRange()
  range.setStart(node, s)
  range.setEnd(node, e)
  const hit = [...range.getClientRects()].some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2)
  return hit ? { node: node as Text, s, e, block } : null
}

// Clicking a word without a gloss opens its card and spends nothing: the model is
// asked only when the reader chooses Look Up. Its gloss goes into the text when
// they choose Add Gloss. Closed without that, the word is plain text again (see
// closeCard).
export function lookupWordAt(w: NonNullable<ReturnType<typeof wordAtPoint>>) {
  const { node, s, e, block } = w
  let base = 0
  for (const n of ownTextNodes(block)) {
    if (n === node) break
    base += n.data.length
  }
  node.splitText(e)
  const mid = node.splitText(s)
  const a: Ann = {
    start: base + s, end: base + e, text: mid.data, kind: "word",
    lemma: mid.data, ipa: "", pos: "", zh: "", segId: block.dataset.seg!, lookup: true,
  }
  const idx = engine.anns.push(a) - 1
  const ruby = makeRuby(mid.data, a, idx)
  mid.replaceWith(ruby)
  openCard(ruby)
  showSavedLookup(idx)
}

function lookupSentence(a: Ann) {
  const seg = engine.segments.get(a.segId)
  return seg ? sentenceAround(seg.text, a.start, a.end) : a.text
}

// Looked up before in this sentence: the answer is on this device and costs
// nothing. Offline, an explanation from another sentence is better than none.
const savedLookup = (a: Ann): Promise<Entry | null> =>
  cachedLookup(getLevel(), a.text, lookupSentence(a), { anySentence: !net.online })

async function showSavedLookup(idx: number) {
  const a = engine.anns[idx]
  const data = await savedLookup(a)
  if (!data || engine.activeAnn !== idx || a.entry || a.loading) return
  applyLookup(idx, data)
  renderCard()
}

function applyLookup(idx: number, data: Entry) {
  const a = engine.anns[idx]
  a.entry = data
  a.ipa ||= data.ipa || ""
  a.pos ||= data.pos || ""
  if (!a.zh) {
    a.zh = data.zh
    a.lemma = data.lemma || a.text
    if (!a.lookup || a.glossed) setGloss(idx)
    refreshKnownMarks()
  }
}

async function fetchDetail(idx: number) {
  const a = engine.anns[idx]
  if (!a || a.loading) return
  const problem = providerProblem()
  if (problem) {
    a.error = problem
    renderCard()
    showBanner(problem, "error", { settingsLink: true })
    return
  }
  a.loading = true
  a.error = ""
  renderCard()
  const level = getLevel()
  const sentence = lookupSentence(a)
  try {
    let data = await savedLookup(a)
    if (!data) {
      const book = get().book?.id || ""
      const { bookTokens, ...entry } = await api("POST", "/api/lookup", { book, level, term: a.text, sentence })
      noteTokens(book, bookTokens)
      data = entry as Entry
      saveLookup(level, a.text, sentence, data)
    }
    applyLookup(idx, data!)
  } catch (err: any) {
    a.error = err.offline ? t("net.lookupOffline") : err.message
  } finally {
    a.loading = false
  }
  if (engine.activeAnn === idx) renderCard()
}

// ------------------------------------------------------------------ word card

export function openCard(el: HTMLElement) {
  const idx = +el.dataset.ann!
  if (!engine.anns[idx]) return
  dismissHint()
  hideFab()
  closeCard()
  engine.activeAnn = idx
  el.classList.add("active")
  renderCard()
}

export function renderCard() {
  const idx = engine.activeAnn
  if (idx == null || !engine.anns[idx] || !rubyEl(idx)) return
  set((s) => ({ card: { idx, rev: (s.card?.rev ?? 0) + 1 } }))
}

export function closeCard() {
  const idx = engine.activeAnn
  if (get().card) set({ card: null })
  articleEl()?.querySelector("ruby.ann.active")?.classList.remove("active")
  engine.activeAnn = null
  // A word looked up without adding its gloss goes back to plain text.
  const a = idx == null ? undefined : engine.anns[idx]
  const el = a?.lookup && !a.glossed && rubyEl(idx)
  if (el) {
    const parent = el.parentNode!
    el.replaceWith(a!.text)
    parent.normalize()
  }
}

export function onCardAction(act: string) {
  const idx = engine.activeAnn
  const a = idx == null ? undefined : engine.anns[idx]
  if (!a || idx == null) return
  const key = a.lemma.toLowerCase()
  const seg = engine.segments.get(a.segId)
  if (act === "detail") {
    fetchDetail(idx)
  } else if (act === "gloss") {
    a.glossed = !a.glossed
    if (a.glossed) setGloss(idx)
    else rubyEl(idx)?.querySelector("rt")?.remove()
    renderCard()
  } else if (act === "known") {
    const known = new Set(get().known)
    const now = !known.has(key)
    if (now) known.add(key)
    else known.delete(key)
    set({ known })
    setKnown(key, now).catch((err: Error) => showBanner(err.message))
    refreshKnownMarks()
    closeCard()
  } else if (act === "ask") {
    const sentence = seg ? sentenceAround(seg.text, a.start, a.end) : a.text
    closeCard()
    openChat(sentence, seg?.text || sentence, t("chat.askWord", { w: a.text }))
  } else if (act === "speak") {
    const u = new SpeechSynthesisUtterance(a.text)
    u.lang = "en-US"
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  }
}

// A click in the text: a gloss opens (or closes) its card; any other English
// word is looked up on demand.
export function onArticleClick(e: MouseEvent) {
  if (!window.getSelection()!.isCollapsed) return // finishing a text selection
  const ruby = (e.target as Element).closest<HTMLElement>("ruby.ann")
  if (ruby) {
    if (engine.activeAnn === +ruby.dataset.ann!) closeCard()
    else openCard(ruby)
    return
  }
  const w = wordAtPoint(e.clientX, e.clientY)
  if (w) lookupWordAt(w)
  else closeCard()
}

// ------------------------------------------------------------------ selection -> ask AI

// Selected text without the Chinese glosses inside <rt>.
function cleanSelectionText(range: Range) {
  const frag = range.cloneContents()
  frag.querySelectorAll("rt").forEach((rt) => rt.remove())
  return (frag.textContent || "").replace(/\s+/g, " ").trim()
}

function selectionInfo(): SelectionInfo | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  const article = articleEl()
  if (!article || !article.contains(range.commonAncestorContainer)) return null
  const text = cleanSelectionText(range)
  if (text.length < 2 || !/[A-Za-z]/.test(text)) return null
  const segOf = (node: Node) => (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>("[data-seg]")
  const ids = [...new Set([segOf(range.startContainer), segOf(range.endContainer)].filter(Boolean).map((e) => e!.dataset.seg!))]
  const passage = ids.map((id) => engine.segments.get(id)?.text || "").join("\n\n").trim() || text
  return { text, passage, rect: range.getBoundingClientRect() }
}

// Mouse: just above the selection. Touch: docked at the bottom of the screen,
// clear of the system's Copy / Look Up menu, which iOS and Android put above or
// below the selection depending on the room there.
//
// It never shows with a word's card, which has Ask AI too. Selecting the word
// whose card is open, as a double-click or a long-press on it does, leaves
// just the card. Selecting more closes the card: the selection is what to ask
// about.
export function maybeShowFab() {
  if (selectsCardWord()) return hideFab()
  let info = selectionInfo()
  if (info && engine.activeAnn != null) {
    closeCard()
    info = selectionInfo() // a word going back to plain text can move its ends
  }
  if (!info) return hideFab()
  set({ fab: { info, docked: isTouch() } })
}

// Whether the selection is (part of) the word whose card is open.
function selectsCardWord() {
  const idx = engine.activeAnn
  const ruby = rubyEl(idx)
  const sel = window.getSelection()
  if (!ruby || !sel || sel.isCollapsed || !sel.rangeCount) return false
  const range = sel.getRangeAt(0)
  return range.intersectsNode(ruby) && cleanSelectionText(range).length <= engine.anns[idx!].text.length
}
export function hideFab() {
  if (get().fab) set({ fab: null })
}

// ------------------------------------------------------------------ first-run hint

// Shown once per browser, the first time someone opens a text; gone for good after
// "Got It", or as soon as they look up a word or ask AI (they've found the features).
const HINT_KEY = "lingolens.hint.reader"
let hintTimer = 0

function hintSeen() {
  try { return localStorage.getItem(HINT_KEY) === "1" } catch { return true }
}

export function maybeShowHint() {
  clearTimeout(hintTimer)
  if (hintSeen()) return
  hintTimer = window.setTimeout(() => {
    if (get().view !== "reader" || hintSeen()) return
    set({ hint: { shown: true, leaving: false, touch: isTouch() } })
  }, 1200)
}

export function hideHint() {
  clearTimeout(hintTimer)
  const h = get().hint
  if (!h.shown || h.leaving) return
  set({ hint: { ...h, leaving: true } })
  setTimeout(() => set({ hint: { shown: false, leaving: false, touch: h.touch } }), 200)
}

export function dismissHint() {
  try { localStorage.setItem(HINT_KEY, "1") } catch { /* ignore */ }
  hideHint()
}

// Where the screen is within the article: the share above its top and the share
// above its bottom.
export function screenInArticle() {
  const a = articleEl()
  const r = a.getBoundingClientRect()
  const h = a.offsetHeight || 1
  return {
    top: Math.min(1, Math.max(0, -r.top / h)),
    bottom: Math.min(1, Math.max(0, (window.innerHeight - r.top) / h)),
  }
}

// Go to what was added at the end of the open text: the blocks after the
// first `oldBlocks`.
export function showNewPart(oldBlocks: number) {
  const fresh = [...articleEl().children].slice(oldBlocks) as HTMLElement[]
  if (!fresh.length) return
  const top = fresh[0].getBoundingClientRect().top + window.scrollY - 80
  window.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  // Light up the new part for a moment, so it's clear where it starts.
  for (const el of fresh) {
    if (el.tagName === "HR") continue
    el.classList.remove("fresh")
    void el.offsetWidth // restart the animation
    el.classList.add("fresh")
    el.addEventListener("animationend", () => el.classList.remove("fresh"), { once: true })
  }
}

export const articleBlocks = () => articleEl()?.childElementCount ?? 0
