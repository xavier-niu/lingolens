import * as React from "react"
import { cn } from "@/lib/utils"
import { useApp, set } from "@/app/store"
import { useT } from "@/app/hooks"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

// ------------------------------------------------------------------ contents

// The sections of a long text; the one being read is marked, and in view.
export function ContentsDialog() {
  const t = useT()
  const open = useApp((s) => s.tocOpen)
  const toc = useApp((s) => s.toc)
  const current = useApp((s) => s.tocCurrent)
  const target = React.useRef("")
  const list = React.useRef<HTMLOListElement>(null)
  const top = Math.min(...toc.map((x) => x.level))
  return (
    <Dialog open={open} onOpenChange={(o) => set({ tocOpen: o })}>
      <DialogContent
        id="toc-dialog"
        aria-label={t("toc.title")}
        className="toc-dialog gap-3 rounded-2xl p-5 sm:max-w-[460px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const a = list.current?.querySelector<HTMLElement>('a[aria-current="true"]') || list.current?.querySelector("a")
          a?.scrollIntoView({ block: "center" })
          a?.focus()
        }}
        // After the dialog has gone and given the page its scrolling back.
        onCloseAutoFocus={(e) => {
          if (!target.current) return
          e.preventDefault()
          document.getElementById(target.current)?.scrollIntoView({ block: "start" })
          target.current = ""
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-serif text-lg font-semibold">{t("toc.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("toc.title")}</DialogDescription>
        </DialogHeader>
        <nav>
          <ol id="toc-list" ref={list} className="toc-list -mx-2 m-0 max-h-[min(65vh,560px)] list-none overflow-y-auto overscroll-contain p-0">
            {toc.map((item) => (
              <li key={item.id} className={`lv${item.level - top + 1}`}>
                <a
                  href={`#${item.id}`}
                  data-target={item.id}
                  aria-current={item.id === current ? "true" : undefined}
                  className={cn(
                    "block rounded-lg px-2.5 py-2 text-[14.5px] leading-snug text-foreground no-underline outline-none hover:bg-accent focus-visible:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-semibold",
                    item.level - top === 1 && "pl-6 text-ink-2",
                    item.level - top >= 2 && "pl-10 text-[13.5px] text-muted-foreground",
                  )}
                  onClick={(e) => {
                    e.preventDefault() // keep the #/read/… route in the address bar
                    target.current = item.id
                    set({ tocOpen: false })
                  }}
                >
                  {item.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </DialogContent>
    </Dialog>
  )
}
