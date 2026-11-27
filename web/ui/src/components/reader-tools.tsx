import * as React from "react"
import { FilePlus2, PencilLine } from "lucide-react"
import { cn } from "@/lib/utils"
import { useApp } from "@/app/store"
import { useT } from "@/app/hooks"
import { useRailMode } from "@/app/rail"
import { TextSizeIcon } from "@/components/icons"
import { ReadingOptions } from "@/components/reading-options"
import { editText } from "@/components/header"
import { Popover, PopoverTrigger } from "@/components/ui/popover"

// The open text's tools, on every screen: a small pill floating at the top
// right of the page (left of Ask AI when it's open), as the sidebar's button
// floats at the top left on narrower screens. There, over the text, both step
// aside while the reader scrolls on, and come back when they scroll back.
export function ReaderTools() {
  const reader = useApp((s) => s.view === "reader" && !!s.me)
  return reader ? <Pill /> : null
}

// (Its own component, so a menu left open goes with it.)
function Pill() {
  const t = useT()
  const rail = useRailMode()
  const [open, setOpen] = React.useState(false)
  const away = useAwayWhileReading(!rail && !open)
  return (
    <div
      id="reader-tools"
      role="toolbar"
      aria-label={t("menu.title")}
      data-away={away || undefined}
      className={cn(floating, "reader-tools right-4 max-sm:right-3 sm:[body.chat-open_&]:right-[456px]", !rail && "max-sm:top-3", away && floatingAway)}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button id="btn-display" type="button" className={floatingButton} title={t("display.title")} aria-label={t("display.title")}>
            <TextSizeIcon />
          </button>
        </PopoverTrigger>
        <ReadingOptions onClose={() => setOpen(false)} />
      </Popover>
      <button id="btn-edit" type="button" className={floatingButton} title={t("btn.edit")} aria-label={t("btn.edit")} onClick={() => editText(false)}>
        <PencilLine strokeWidth={1.7} />
      </button>
      <button id="btn-append" type="button" className={floatingButton} title={t("btn.append")} aria-label={t("btn.append")} onClick={() => editText(true)}>
        <FilePlus2 strokeWidth={1.7} />
      </button>
    </div>
  )
}

// The corners' floating pills.
export const floating =
  "fixed top-4 z-20 flex items-center gap-0.5 rounded-full border bg-background/85 p-1 shadow-(--elev-xs) backdrop-blur-md transition-[translate,opacity] duration-200"
export const floatingAway = "pointer-events-none -translate-y-3 opacity-0"
export const floatingButton =
  "grid size-8 place-items-center rounded-full text-muted-foreground transition-colors duration-150 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/35 aria-expanded:bg-accent aria-expanded:text-foreground [&_svg]:size-[17px]"

// Scrolling on (down) puts it away; scrolling back, or reaching the top,
// brings it back. A move that comes with the page changing height (glosses
// arriving above the screen, which the browser keeps the reader's place
// through) isn't the reader's, and changes nothing.
export function useAwayWhileReading(on: boolean) {
  const [away, setAway] = React.useState(false)
  React.useEffect(() => {
    if (!on) { setAway(false); return }
    let last = window.scrollY
    const scroll = () => {
      const y = window.scrollY
      if (y < 80) setAway(false)
      else if (y > last + 4) setAway(true)
      else if (y < last - 4) setAway(false)
      last = y
    }
    // The page's height changing: start again from where the browser put it.
    const ro = new ResizeObserver(() => { last = window.scrollY })
    ro.observe(document.body)
    window.addEventListener("scroll", scroll, { passive: true })
    return () => {
      ro.disconnect()
      window.removeEventListener("scroll", scroll)
    }
  }, [on])
  return away
}
