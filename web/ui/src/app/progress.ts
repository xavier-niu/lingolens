// Reading progress. Progress is how much of a text the reader has had time to
// read, not how far they have scrolled, so a jump to the end to see how long a
// text is doesn't finish it. Each second on the page, progress moves towards the
// bottom of the screen at no more than readingStep(): quick enough that real
// reading is never held back.
import { readingStep, saveProgress } from "@/lib/library.js"
import { get, bump, getLevel, type Book } from "./store"
import { screenInArticle } from "./engine"

const READ_TICK_MS = 1000
const READ_IDLE_MS = 120_000 // a text left open stops counting after this long without input
const PLACE_SETTLE_MS = 5000 // beyond what's been read, a place counts once the screen stays there
const SAVE_EVERY_MS = 10_000

let saveTimer = 0
let placeY: number | null = null // the scroll position book.pos was taken from; null while opening
let lastInputAt = 0
let lastScrollAt = 0

export const noteInput = () => { lastInputAt = Date.now() }
export const noteScroll = () => { lastScrollAt = Date.now(); noteInput() }

// Opening a text: not back in place yet.
export const leavePlace = () => { placeY = null }
// Back in place, at this scroll position.
export const settlePlace = () => { placeY = window.scrollY }

// The place to come back to follows the reader through what they've read, but a
// look further ahead only moves it if they stay there.
function updatePlace(book: Book) {
  const y = window.scrollY
  if (placeY === null || y === placeY) return false
  const { top, bottom } = screenInArticle()
  if (bottom > (book.progress || 0) && Date.now() - lastScrollAt < PLACE_SETTLE_MS) return false
  placeY = y
  book.pos = top
  return true
}

function tickReading() {
  const book = get().book
  if (!book || placeY === null || get().view !== "reader" || document.hidden) return
  if (Date.now() - lastInputAt > READ_IDLE_MS) return
  let changed = false
  const read = book.progress || 0
  const { bottom } = screenInArticle()
  if (bottom > read) {
    const next = Math.min(bottom, read + readingStep(book, getLevel()))
    book.progress = next > 0.985 ? 1 : next
    bump() // the thread under the header and the time left
    changed = true
  }
  if (updatePlace(book)) changed = true
  if (changed && !saveTimer) saveTimer = window.setTimeout(flushProgress, SAVE_EVERY_MS)
}

export function flushProgress({ closing = false } = {}) {
  clearTimeout(saveTimer)
  saveTimer = 0
  const b = get().book
  if (!b) return
  if (get().view === "reader") updatePlace(b)
  if (b.pos === b.savedPos && b.progress === b.savedProgress) return
  b.savedPos = b.pos
  b.savedProgress = b.progress
  return saveProgress(b.id, b.pos || 0, b.progress || 0, { closing })
}

// The open text was saved in a new version, which comes with its own reading
// place and progress (kept for an addition, 0% for a rewrite): what was read of
// the old one meanwhile isn't sent over them.
export function holdProgress(id: string) {
  clearTimeout(saveTimer)
  saveTimer = 0
  const b = get().book
  if (b?.id === id) Object.assign(b, { savedPos: b.pos, savedProgress: b.progress })
}

export function startReadingClock() {
  setInterval(tickReading, READ_TICK_MS)
}
