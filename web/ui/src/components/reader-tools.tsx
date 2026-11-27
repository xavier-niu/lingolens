import * as React from "react"
import { FilePlus2, PencilLine } from "lucide-react"
import { useApp } from "@/app/store"
import { useT } from "@/app/hooks"
import { useRailMode } from "@/app/rail"
import { TextSizeIcon } from "@/components/icons"
import { ReadingOptions } from "@/components/reading-options"
import { editText } from "@/components/header"
import { Popover, PopoverTrigger } from "@/components/ui/popover"

// The open text's tools on wide screens, where the sidebar replaces the
// header: a small pill floating at the top right of the page (left of Ask AI
// when it's open). Narrower screens have them in the header.
export function ReaderTools() {
  const rail = useRailMode()
  const reader = useApp((s) => s.view === "reader")
  return rail && reader ? <Pill /> : null
}

// (Its own component, so a menu left open goes with it.)
function Pill() {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  return (
    <div
      id="reader-tools"
      role="toolbar"
      aria-label={t("menu.title")}
      className="reader-tools fixed top-4 right-4 z-20 flex items-center gap-0.5 rounded-full border bg-background/85 p-1 shadow-(--elev-xs) backdrop-blur-md sm:[body.chat-open_&]:right-[456px]"
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button id="btn-display" type="button" className={tool} title={t("display.title")} aria-label={t("display.title")}>
            <TextSizeIcon />
          </button>
        </PopoverTrigger>
        <ReadingOptions onClose={() => setOpen(false)} />
      </Popover>
      <button id="btn-edit" type="button" className={tool} title={t("btn.edit")} aria-label={t("btn.edit")} onClick={() => editText(false)}>
        <PencilLine strokeWidth={1.7} />
      </button>
      <button id="btn-append" type="button" className={tool} title={t("btn.append")} aria-label={t("btn.append")} onClick={() => editText(true)}>
        <FilePlus2 strokeWidth={1.7} />
      </button>
    </div>
  )
}

const tool =
  "grid size-8 place-items-center rounded-full text-muted-foreground transition-colors duration-150 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/35 aria-expanded:bg-accent aria-expanded:text-foreground [&_svg]:size-[17px]"
