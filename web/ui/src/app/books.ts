// What the shelf and the reader say about a text: time left, and when it
// deletes itself.
import { t } from "@/lib/i18n.js"
import { isFinished, minutesLeft } from "@/lib/library.js"
import { setReadLater } from "@/lib/offline.js"
import { get, set, bump, getLevel, showBanner, type Book, type ShelfFilter } from "./store"

export function bookStat(book: Book, level = getLevel()) {
  if (isFinished(book)) return t("book.finished")
  const m = minutesLeft(book, level)
  const p = Math.floor((book.progress || 0) * 100)
  return p > 0 ? t("book.left", { p, m }) : t("book.minRead", { m })
}

// Texts with a time to live: whole days left, rounded up (0 once it has run out).
export const daysLeft = (b: Book) => Math.max(0, Math.ceil((Date.parse(b.expiresAt!) - Date.now()) / 864e5))
export const isExpired = (b: Book) => !!b.expiresAt && Date.parse(b.expiresAt) <= Date.now()

export function expiryText(b: Book) {
  if (!b.expiresAt) return ""
  const n = daysLeft(b)
  return n <= 1 ? t("book.expiresSoon") : t("book.expires", { n })
}

// The "Delete automatically" choices. Editing or adding to a text that has a
// time to live adds one more, first and chosen: the days it has left, marked
// "(inherited)", which leaves its date as it is.
export const TTL_CHOICES = [0, 1, 7, 30, 90, 365]
const ttlLabel = (n: number) => (n === 0 ? t("ttl.never") : n === 1 ? t("ttl.day") : n === 365 ? t("ttl.year") : t("ttl.days", { n }))

export function ttlOptions(book: Book | null): { value: string; label: string }[] {
  const opts = TTL_CHOICES.map((n) => ({ value: String(n), label: ttlLabel(n) }))
  if (book?.expiresAt) opts.unshift({ value: "keep", label: t("ttl.inherited", { t: ttlLabel(Math.max(1, daysLeft(book))) }) })
  return opts
}

// Tokens: what the AI model has spent on a text (glosses, lookups, Ask AI), as
// the server counts them: input read afresh, input read from the provider's
// prompt cache, and output. A request for a text sends back its new totals.
export interface BookTokens { input: number; cached: number; output: number }
export interface TokenTotals extends BookTokens { total: number }

export function noteTokens(id: string, tokens?: BookTokens | null) {
  if (!id || !tokens) return
  const fields = { tokensIn: tokens.input, tokensCached: tokens.cached || 0, tokensOut: tokens.output }
  const open = get().book
  if (open?.id === id) {
    Object.assign(open, fields)
    bump()
  }
  set((s) => ({ books: s.books.map((b) => (b.id === id ? { ...b, ...fields } : b)) }))
}

// The open text's totals: the larger of its own and the shelf's (the shelf may
// have heard from another device since it was opened; the counts only grow).
export function tokensOf(book: Book, books: Book[]): TokenTotals {
  const listed = books.find((b) => b.id === book.id)
  const most = (k: "tokensIn" | "tokensCached" | "tokensOut") => Math.max(book[k] || 0, listed?.[k] || 0)
  const input = most("tokensIn"), cached = most("tokensCached"), output = most("tokensOut")
  return { input, cached, output, total: input + cached + output }
}

// ------------------------------------------------------------------ the shelf

// Adding a text: the source dialog, empty.
export const openSource = () => set((s) => ({ source: { book: null, append: false, seq: (s.source?.seq ?? 0) + 1 } }))

// Read later: a text put aside to come back to. Shown at once, then saved
// (queued while offline).
export const isReadLater = (b: Book) => !!b.readLaterAt

export function toggleReadLater(book: Book) {
  const later = !isReadLater(book)
  const readLaterAt = later ? new Date().toISOString() : ""
  const open = get().book
  if (open?.id === book.id) {
    open.readLaterAt = readLaterAt
    bump()
  }
  set((s) => ({ books: s.books.map((b) => (b.id === book.id ? { ...b, readLaterAt } : b)) }))
  setReadLater(book.id, later).catch((err: Error) => showBanner(err.message))
}

// The shelf's filters, and which texts each keeps. "Deleting soon": a time to
// live with a week or less left.
export const SHELF_FILTERS: ShelfFilter[] = ["all", "later", "reading", "new", "done", "expiring"]

export function inFilter(b: Book, f: ShelfFilter) {
  switch (f) {
    case "later": return isReadLater(b)
    case "reading": return (b.progress || 0) > 0 && !isFinished(b)
    case "new": return !((b.progress || 0) > 0)
    case "done": return isFinished(b)
    case "expiring": return !!b.expiresAt && daysLeft(b) <= 7
    default: return true
  }
}

// The texts the shelf shows: the filter's, with the search in their titles.
// Read later, the latest put aside first; otherwise in the shelf's order.
export function shelfBooks(books: Book[], f: ShelfFilter, query: string) {
  const q = query.trim().toLocaleLowerCase()
  const out = books.filter((b) => !isExpired(b) && inFilter(b, f) && (!q || b.title.toLocaleLowerCase().includes(q)))
  if (f === "later") out.sort((a, b) => (b.readLaterAt || "").localeCompare(a.readLaterAt || ""))
  return out
}

// Shows the shelf with a filter (from anywhere).
export function showShelf(f: ShelfFilter) {
  set({ shelfFilter: f })
  if (location.hash !== "#/" && location.hash !== "") location.hash = "#/"
  window.scrollTo(0, 0)
}

// The text to go back to: the one last read and not yet finished.
export function continueReading(books: Book[]) {
  let best: Book | null = null
  for (const b of books) {
    if (!b.lastReadAt || isFinished(b) || isExpired(b)) continue
    if (!best || b.lastReadAt > best.lastReadAt!) best = b
  }
  return best
}
