// What the shelf and the reader say about a text: time left, and when it
// deletes itself.
import { t } from "@/lib/i18n.js"
import { isFinished, minutesLeft } from "@/lib/library.js"
import { getLevel, type Book } from "./store"

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
