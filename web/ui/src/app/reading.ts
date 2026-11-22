// Reading Options. Settings holds the defaults, saved to the profile and the
// same on every device. Reading Options in the reader change them on this device
// only: what differs from the default is kept in this browser and never sent.
import { useApp, get, set, type AppState } from "./store"
import { savePrefs } from "./session"

export type ReadingKey = "hideWords" | "hidePhrases" | "readSize" | "readWidth" | "readFont" | "glossFont" | "theme"
export type Reading = {
  hideWords: boolean
  hidePhrases: boolean
  readSize: string
  readWidth: string
  readFont: string
  glossFont: string
  theme: string
}

export const READING: Record<ReadingKey, { values?: string[]; label: string }> = {
  hideWords: { label: "toggle.words" },
  hidePhrases: { label: "toggle.phrases" },
  readSize: { values: ["s", "sm", "m", "l"], label: "display.size" },
  readWidth: { values: ["n", "m", "w"], label: "display.width" },
  readFont: { values: ["literata", "classic", "sans", "legible"], label: "display.font" },
  glossFont: { values: ["sans", "song", "kai"], label: "display.glossFont" },
  theme: { values: ["system", "light", "dark"], label: "theme.title" },
}
export const READING_DEFAULTS: Reading = {
  hideWords: false, hidePhrases: false, readSize: "m", readWidth: "m", readFont: "literata", glossFont: "sans", theme: "system",
}
const KEYS = Object.keys(READING) as ReadingKey[]

const validReading = (key: ReadingKey, v: unknown) =>
  READING[key].values ? READING[key].values!.includes(v as string) : typeof v === "boolean"

const deviceReadingKey = () => `lingolens.reading.${get().me?.id}`

export function loadDeviceReading() {
  let saved: Record<string, unknown> = {}
  try { saved = JSON.parse(localStorage.getItem(deviceReadingKey()) || "null") || {} } catch { /* none, or private mode */ }
  set({ deviceReading: Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in READING && validReading(k as ReadingKey, v))) })
}

function saveDeviceReading(device: Record<string, unknown>) {
  set({ deviceReading: device })
  try {
    if (Object.keys(device).length) localStorage.setItem(deviceReadingKey(), JSON.stringify(device))
    else localStorage.removeItem(deviceReadingKey())
  } catch { /* private mode: kept until the page closes */ }
}

const defaultIn = (s: Pick<AppState, "prefs">, key: ReadingKey) => {
  const v = (s.prefs as unknown as Record<string, unknown>)[key]
  return (validReading(key, v) ? v : READING_DEFAULTS[key]) as never
}
export const readingDefault = (key: ReadingKey) => defaultIn(get(), key)

export function readingDefaults(s: Pick<AppState, "prefs"> = get()): Reading {
  return Object.fromEntries(KEYS.map((k) => [k, defaultIn(s, k)])) as unknown as Reading
}

// What this device shows: its own choice, or else the default.
export function currentReading(s: Pick<AppState, "prefs" | "deviceReading"> = get()): Reading {
  return Object.fromEntries(KEYS.map((k) => [k, k in s.deviceReading ? s.deviceReading[k] : defaultIn(s, k)])) as Reading
}

// The keys this device sets for itself.
export const ownReading = (s: Pick<AppState, "deviceReading"> = get()) => KEYS.filter((k) => k in s.deviceReading)

// For components: redraws when the defaults or this device's choices change.
export function useReading(): Reading {
  const prefs = useApp((s) => s.prefs)
  const deviceReading = useApp((s) => s.deviceReading)
  return currentReading({ prefs, deviceReading })
}

// Reading Options: kept on this device. Choosing the default again drops the
// device's own choice, so it follows the default from then on.
export function setDeviceReading(key: ReadingKey, value: unknown) {
  if (!get().me || !validReading(key, value)) return
  const device = { ...get().deviceReading }
  if (value === readingDefault(key)) delete device[key]
  else device[key] = value
  saveDeviceReading(device)
  applyReading()
}

// Settings: the default, saved to the profile. Chosen here, so this device
// uses it too.
export function setReadingDefault(key: ReadingKey, value: unknown) {
  if (!get().me || !validReading(key, value)) return
  const device = { ...get().deviceReading }
  delete device[key]
  saveDeviceReading(device)
  if (value !== readingDefault(key)) savePrefs({ [key]: value })
  applyReading()
}

export function resetDeviceReading() {
  saveDeviceReading({})
  applyReading()
}

const READ_SIZES: Record<string, string> = { s: "17px", sm: "18.5px", m: "20px", l: "23px" }
// Reading column width; it only matters on screens wider than the column.
const READ_WIDTHS: Record<string, string> = { n: "680px", m: "820px", w: "1040px" }
const READ_FONTS: Record<string, string> = { literata: "literata", classic: "classic", sans: "plain", legible: "legible" }

// Puts this device's reading choices into effect: sizes and fonts through CSS
// variables (the gloss switches are classes on the text, see ReaderView), and
// the theme through theme.js.
export function applyReading(r: Reading = currentReading()) {
  const root = document.documentElement.style
  root.setProperty("--read-size", READ_SIZES[r.readSize] || READ_SIZES.m)
  root.setProperty("--read-width", READ_WIDTHS[r.readWidth] || READ_WIDTHS.m)
  root.setProperty("--read-font", `var(--font-${READ_FONTS[r.readFont] || "literata"})`)
  root.setProperty("--zh", `var(--zh-${validReading("glossFont", r.glossFont) ? r.glossFont : "sans"})`)
  if (r.theme !== appliedTheme()) applyTheme(r.theme)
}

// "system" follows the device; theme.js (loaded in <head>) does the work and
// remembers the choice in this browser so the next visit paints correctly at once.
declare global {
  interface Window { lingolensTheme?: (theme: string) => string }
}
export const appliedTheme = () => document.documentElement.dataset.theme || "system"
function applyTheme(theme: string) {
  const root = document.documentElement
  root.classList.add("theme-switching")
  window.lingolensTheme?.(theme)
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")))
}
