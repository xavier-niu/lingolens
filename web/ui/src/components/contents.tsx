import * as React from "react"
import { ListTree } from "lucide-react"
import { cn } from "@/lib/utils"
import { useApp, get, reduceMotion, type TocItem } from "@/app/store"
import { useT } from "@/app/hooks"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

// Contents: the sections of a long text, with the one being read marked as the
// reader scrolls. It floats beside the text when there's room to its right;
// otherwise a round button at the bottom right opens it over the page.

const GAP = 40 // between the text and the list
const EDGE = 16 // between the list and the window's edge (or the open sidebar)
const MIN_WIDTH = 160
const MAX_WIDTH = 260
const READ_LINE = 120 // a section is being read once its heading is above this line

export function Contents() {
  const t = useT()
  const view = useApp((s) => s.view)
  const toc = useApp((s) => s.toc)
  const hint = useApp((s) => s.hint.shown)
  const shown = view === "reader" && toc.length > 0
  const place = useRoomBeside(shown)
  const [current, pinCurrent] = useCurrentSection(shown ? toc : null)
  const [open, setOpen] = React.useState(false)
  const list = React.useRef<HTMLOListElement>(null)

  // The marked section stays in sight in a long list.
  React.useEffect(() => {
    const ol = list.current
    const a = ol?.querySelector<HTMLElement>("a[aria-current]")
    if (ol && a && !inView(ol, a)) ol.scrollTo({ top: centred(ol, a), behavior: reduceMotion() ? "auto" : "smooth" })
  }, [current, place])

  React.useEffect(() => { if (!shown || place) setOpen(false) }, [shown, place])

  if (!shown) return null

  const go = (id: string) => {
    setOpen(false)
    const h = document.getElementById(id)
    if (!h) return
    h.scrollIntoView({ block: "start" })
    pinCurrent(id)
  }
  const title = <p id="toc-title" className="m-0 mb-2 pl-4 text-[11.5px] font-semibold tracking-[.06em] text-muted-foreground uppercase">{t("toc.title")}</p>

  if (place) {
    return (
      <nav
        id="toc"
        data-mode="beside"
        aria-labelledby="toc-title"
        className="toc anim-fade fixed top-24 z-20 flex max-h-[calc(100dvh-120px)] flex-col"
        style={{ left: place.left, width: place.width }}
      >
        {title}
        <SectionList toc={toc} current={current} onGo={go} listRef={list} className="min-h-0 flex-1" />
      </nav>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id="btn-toc"
          type="button"
          title={t("toc.title")}
          aria-label={t("toc.title")}
          className={cn(
            "toc-btn fixed right-4 bottom-[calc(20px+env(safe-area-inset-bottom))] z-20 grid size-11 place-items-center rounded-full border bg-card text-ink-2 shadow-(--shadow-float) transition-[color,transform] outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-95 aria-expanded:text-foreground",
            "sm:[body.chat-open_&]:right-[456px]", // beside the open sidebar
            hint && "max-sm:hidden", // the first-run hint spans the bottom of a phone
          )}
        >
          <ListTree className="size-5" strokeWidth={1.8} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id="toc-pop"
        side="top"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        aria-labelledby="toc-title"
        className="w-[min(320px,calc(100vw-32px))] gap-0 rounded-2xl p-3 pt-3.5 shadow-(--shadow-float)"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const ol = list.current
          const a = ol?.querySelector<HTMLElement>("a[aria-current]") || ol?.querySelector<HTMLElement>("a")
          if (!ol || !a) return
          ol.scrollTop = centred(ol, a)
          a.focus({ preventScroll: true })
        }}
      >
        <nav aria-labelledby="toc-title">
          {title}
          <SectionList toc={toc} current={current} onGo={go} listRef={list} className="max-h-[min(60vh,480px)]" />
        </nav>
      </PopoverContent>
    </Popover>
  )
}

function SectionList({ toc, current, onGo, listRef, className }: {
  toc: TocItem[]
  current: string
  onGo: (id: string) => void
  listRef: React.Ref<HTMLOListElement>
  className?: string
}) {
  const top = Math.min(...toc.map((x) => x.level))
  return (
    <ol id="toc-list" ref={listRef} className={cn("toc-list relative m-0 list-none overflow-y-auto overscroll-contain border-l p-0", className)}>
      {toc.map((item) => {
        const depth = item.level - top
        return (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              data-target={item.id}
              aria-current={item.id === current ? "location" : undefined}
              className={cn(
                "-ml-px block rounded-r-md border-l-2 border-transparent py-[5px] pr-2 pl-3.5 text-[13.5px] leading-snug text-muted-foreground no-underline transition-colors outline-none hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground pointer-coarse:py-2",
                "aria-[current=location]:border-(--thread) aria-[current=location]:font-medium aria-[current=location]:text-foreground",
                depth === 1 && "pl-6",
                depth >= 2 && "pl-9 text-[13px]",
              )}
              onClick={(e) => {
                e.preventDefault() // keep the #/read/… route in the address bar
                onGo(item.id)
              }}
            >
              {item.text}
            </a>
          </li>
        )
      })}
    </ol>
  )
}

const inView = (box: HTMLElement, el: HTMLElement) => {
  const b = box.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  return r.top >= b.top && r.bottom <= b.bottom
}

// The scroll that puts el (a link in the list) in the middle of the list.
const centred = (ol: HTMLElement, el: HTMLElement) => el.offsetTop - (ol.clientHeight - el.offsetHeight) / 2

// Where the list fits to the right of the text, clear of the Ask AI sidebar;
// null when it doesn't.
function useRoomBeside(on: boolean) {
  const drawer = useApp((s) => s.drawer)
  const [place, setPlace] = React.useState<{ left: number; width: number } | null>(null)
  React.useLayoutEffect(() => {
    if (!on) return
    const column = document.getElementById("reader-view")!
    const measure = () => {
      const r = column.getBoundingClientRect()
      let edge = document.documentElement.clientWidth
      if (get().drawer === "open" && edge >= 640) edge -= Math.min(440, edge)
      const room = Math.floor(edge - r.right - GAP - EDGE)
      const next = room >= MIN_WIDTH ? { left: Math.round(r.right + GAP), width: Math.min(room, MAX_WIDTH) } : null
      setPlace((p) => (p?.left === next?.left && p?.width === next?.width ? p : next))
    }
    measure()
    // The column moves with the window, the reading width, and the sidebar
    // (which makes room for itself on wide screens).
    const ro = new ResizeObserver(measure)
    ro.observe(column)
    ro.observe(document.getElementById("main")!)
    window.addEventListener("resize", measure)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [on, drawer])
  return on ? place : null
}

// The section being read: the last heading above the reading line, or at the
// end of the text, the last one in the top half of the screen. A section just
// jumped to stays marked until the page moves.
function useCurrentSection(toc: TocItem[] | null): [string, (id: string) => void] {
  const [current, setCurrent] = React.useState("")
  const pinned = React.useRef<{ id: string; y: number } | null>(null)
  React.useEffect(() => {
    if (!toc) return
    let frame = 0
    const update = () => {
      frame = 0
      const p = pinned.current
      if (p && Math.abs(window.scrollY - p.y) < 2) { setCurrent(p.id); return }
      pinned.current = null
      const end = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
      const line = end ? window.innerHeight / 2 : READ_LINE
      let id = ""
      for (const item of toc) {
        const h = document.getElementById(item.id)
        if (!h) continue
        if (h.getBoundingClientRect().top >= line) break
        id = item.id
      }
      setCurrent(id)
    }
    const later = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    window.addEventListener("scroll", later, { passive: true })
    window.addEventListener("resize", later)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", later)
      window.removeEventListener("resize", later)
    }
  }, [toc])
  const pin = React.useCallback((id: string) => {
    pinned.current = { id, y: window.scrollY }
    setCurrent(id)
  }, [])
  return [current, pin]
}
