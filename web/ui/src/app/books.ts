// What the shelf and the reader say about a text: time left, and when it
// deletes itself.
import { t } from "@/lib/i18n.js"
import { isFinished, minutesLeft } from "@/lib/library.js"
import { get, set, bump, getLevel, type Book } from "./store"

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
// the server counts them. A request for a text sends back its new totals.
export interface BookTokens { input: number; output: number }

export function noteTokens(id: string, tokens?: BookTokens | null) {
  if (!id || !tokens) return
  const open = get().book
  if (open?.id === id) {
    open.tokensIn = tokens.input
    open.tokensOut = tokens.output
    bump()
  }
  set((s) => ({ books: s.books.map((b) => (b.id === id ? { ...b, tokensIn: tokens.input, tokensOut: tokens.output } : b)) }))
}

// The open text's totals: the larger of its own and the shelf's (the shelf may
// have heard from another device since it was opened; the counts only grow).
export function tokensOf(book: Book, books: Book[]) {
  const listed = books.find((b) => b.id === book.id)
  const input = Math.max(book.tokensIn || 0, listed?.tokensIn || 0)
  const output = Math.max(book.tokensOut || 0, listed?.tokensOut || 0)
  return { input, output, total: input + output }
}
