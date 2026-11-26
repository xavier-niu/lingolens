// What the interface shows, in one store. The controllers in this folder (ported
// from the old app.js) change it; components read it. Objects that change many
// times a second or in place (the open book's progress, a conversation as its
// answer arrives) are mutated where they are, and `rev` is bumped to redraw.
import { create } from "zustand"
import { getLang } from "@/lib/i18n.js"

export type View = "boot" | "login" | "library" | "reader" | "settings" | "clip"
export type NetMode = "" | "offline" | "syncing" | "waiting" | "synced"

export interface Level { id: string; name: string; label: string; hint: string; vocab: number }
export interface ServerConfig {
  levels: Level[]
  default_level: string
  allow_fake: boolean
  needs_setup?: boolean
  gloss_version?: string
}

export interface User { id: string | number; email: string; name?: string; is_admin?: boolean; prefs?: Partial<Prefs> }

export interface Prefs {
  level: string
  lang: string
  readSize: string
  readWidth: string
  theme: string
  readFont: string
  glossFont: string
  hideWords: boolean
  hidePhrases: boolean
}

export interface Book {
  id: string
  title: string
  words: number
  content?: string
  format?: string
  progress?: number
  pos?: number
  expiresAt?: string
  updatedAt?: string
  savedPos?: number
  savedProgress?: number
  [k: string]: unknown
}

export interface TocItem { id: string; text: string; level: number }

export interface Banner { text: string; kind: "error" | "info"; settingsLink: boolean }

export interface SelectionInfo { text: string; passage: string; rect: DOMRect }

export interface SourceOpen {
  book: Book | null
  append: boolean
  seq: number // a new opening resets the dialog's fields
}

export interface Clip { url: string; title: string; html: string; selection: string; host: string; words: number }

export interface HistoryItem {
  id: string
  bookId: string
  bookTitle: string
  selection: string
  question: string
  questions: number
  updatedAt: string
  live?: boolean
}

export interface AppState {
  lang: string
  config: ServerConfig
  me: User | null
  model: any
  prefs: Prefs
  books: Book[]
  booksLoaded: boolean
  known: Set<string>

  view: View
  returnTo: string // where "Back" on the settings page goes
  settingsAt: string // a heading to open Settings at
  rev: number

  // reader
  book: Book | null
  toc: TocItem[]
  annotating: { shown: boolean; n: number }
  card: { idx: number; rev: number } | null
  fab: { info: SelectionInfo; docked: boolean } | null
  hint: { shown: boolean; leaving: boolean; touch: boolean }

  banner: Banner | null
  net: { mode: NetMode; title: string }
  deviceReading: Record<string, unknown>

  // dialogs
  source: SourceOpen | null

  // Ask AI sidebar
  drawer: "closed" | "open" | "closing"
  chatMode: "chat" | "history"
  chatRev: number
  liveAway: boolean // an answer is arriving out of sight
  hist: { scope: "book" | "all"; items: HistoryItem[] | null; status: string }

  // login
  loginError: string

  // #/clip
  clip: Clip | null
  clipWaited: boolean
}

export const DEFAULT_PREFS: Prefs = {
  level: "B1", lang: "en", readSize: "m", readWidth: "m", theme: "system",
  readFont: "sans", glossFont: "sans", hideWords: false, hidePhrases: false,
}

export const useApp = create<AppState>()(() => ({
  lang: getLang(),
  config: { levels: [], default_level: "B1", allow_fake: false },
  me: null,
  model: null,
  prefs: { ...DEFAULT_PREFS },
  books: [],
  booksLoaded: false,
  known: new Set(),

  view: "boot",
  returnTo: "#/",
  settingsAt: "",
  rev: 0,

  book: null,
  toc: [],
  annotating: { shown: false, n: 0 },
  card: null,
  fab: null,
  hint: { shown: false, leaving: false, touch: false },

  banner: null,
  net: { mode: "", title: "" },
  deviceReading: {},

  source: null,

  drawer: "closed",
  chatMode: "chat",
  chatRev: 0,
  liveAway: false,
  hist: { scope: "all", items: null, status: "" },

  loginError: "",

  clip: null,
  clipWaited: false,
}))

export const get = useApp.getState
export const set = useApp.setState

// Redraw what depends on objects changed in place.
export const bump = () => set((s) => ({ rev: s.rev + 1 }))
export const bumpChat = () => set((s) => ({ chatRev: s.chatRev + 1 }))

export function showBanner(text: string, kind: "error" | "info" = "error", { settingsLink = false } = {}) {
  set({ banner: { text, kind, settingsLink } })
}
export const hideBanner = () => set({ banner: null })

export const isTouch = () => matchMedia("(pointer: coarse)").matches
export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches

// The reading level: the profile's, if the server still offers it.
export function getLevel(): string {
  const { config, prefs } = get()
  const ids = config.levels.map((l) => l.id)
  const v = prefs.level
  return ids.length && !ids.includes(v) ? config.default_level || "B1" : v
}
