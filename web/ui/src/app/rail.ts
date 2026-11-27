import * as React from "react"
import { useApp, set } from "@/app/store"

// The sidebar on wide screens (1024px and up) takes the header's place beside
// the shelf, a text and Settings. It's full width, or a strip of icons: when
// the reader narrows it (remembered on this device), and below 1440px while
// Ask AI is open, so the text keeps its width. "" where there's no sidebar
// (narrower screens, signing in), and the header shows instead.
export type RailMode = "" | "full" | "compact"

const PAGES = new Set(["library", "reader", "settings"])

function useMedia(query: string) {
  const mql = React.useMemo(() => window.matchMedia(query), [query])
  return React.useSyncExternalStore(
    (change) => {
      mql.addEventListener("change", change)
      return () => mql.removeEventListener("change", change)
    },
    () => mql.matches,
  )
}

export function useRailMode(): RailMode {
  const wide = useMedia("(min-width: 1024px)")
  const roomy = useMedia("(min-width: 1440px)")
  const page = useApp((s) => !!s.me && PAGES.has(s.view))
  const open = useApp((s) => s.railOpen)
  const chat = useApp((s) => s.drawer === "open")
  if (!wide || !page) return ""
  return open && (roomy || !chat) ? "full" : "compact"
}

// The pages the sidebar serves have no header, on any screen: the sidebar
// holds what one would, and the page's own controls float in its corners.
export function useBare() {
  return useApp((s) => !!s.me && PAGES.has(s.view))
}

// Narrower screens (phones, tablets) have no room to keep the sidebar beside
// the page: it slides in over it from the button at the top left, and goes
// again as soon as it has been used (see Sidebar).
export function useRailSlides() {
  const wide = useMedia("(min-width: 1024px)")
  const page = useApp((s) => !!s.me && PAGES.has(s.view))
  return !wide && page
}

export const slideRail = (railSlid: boolean) => { if (useApp.getState().railSlid !== railSlid) set({ railSlid }) }

// Whether the sidebar is narrow only because Ask AI is open beside it.
export function useRailMakingRoom() {
  return useApp((s) => s.railOpen && s.drawer === "open")
}

export function toggleRail() {
  set((s) => {
    const railOpen = !s.railOpen
    try { localStorage.setItem("lingolens.rail", railOpen ? "on" : "off") } catch { /* private mode */ }
    return { railOpen }
  })
}
