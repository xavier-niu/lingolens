import { Monitor, Moon, Sun } from "lucide-react"
import { cn } from "@/lib/utils"
import { useT } from "@/app/hooks"
import { useReading, setDeviceReading } from "@/app/reading"
import { openSettingsAt } from "@/app/session"
import { Segmented } from "@/components/segmented"
import { WidthIcon } from "@/components/icons"
import { PopoverContent } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"

type Change = (value: string) => void

// The choices, shared by Reading Options (this device) and Settings (the defaults).
export function SizeChoice({ id, value, onChange }: { id: string; value: string; onChange: Change }) {
  const t = useT()
  const sizes: [string, string, string][] = [["s", "display.small", "12px"], ["sm", "display.smallish", "14.5px"], ["m", "display.medium", "17px"], ["l", "display.large", "19.5px"]]
  return (
    <Segmented
      id={id} label={t("display.size")} attr="size" value={value} onChange={onChange} data-reading="readSize"
      options={sizes.map(([v, key, px]) => ({ value: v, label: t(key), content: <span style={{ fontSize: px }} className="font-reading">A</span> }))}
    />
  )
}

export function FontChoice({ id, value, onChange, className }: { id: string; value: string; onChange: Change; className?: string }) {
  const t = useT()
  return (
    <Segmented
      id={id} label={t("display.font")} attr="font" value={value} onChange={onChange} data-reading="readFont"
      className={cn("font-seg grid grid-cols-2", className)} buttonClassName="h-[34px] px-2 text-[15px] font-normal text-ink-2"
      options={[
        { value: "sans", content: t("font.sans") },
        { value: "serif", content: t("font.serif") },
        { value: "lexend", content: "Lexend" },
        { value: "legible", content: t("font.legible") },
      ]}
    />
  )
}

export function GlossChoice({ id, value, onChange, className }: { id: string; value: string; onChange: Change; className?: string }) {
  const t = useT()
  return (
    <Segmented
      id={id} label={t("display.glossFont")} attr="gloss" value={value} onChange={onChange} data-reading="glossFont"
      className={cn("font-seg zh grid grid-cols-3", className)} buttonClassName="h-[34px] px-2 text-[15px] font-normal text-ink-2 data-[gloss=kai]:text-base"
      options={[
        { value: "sans", label: t("gloss.sans"), content: "黑体", lang: "zh-CN" },
        { value: "song", label: t("gloss.song"), content: "宋体", lang: "zh-CN" },
        { value: "kai", label: t("gloss.kai"), content: "楷体", lang: "zh-CN" },
      ]}
    />
  )
}

export function WidthChoice({ id, value, onChange, labels = false, className }: { id: string; value: string; onChange: Change; labels?: boolean; className?: string }) {
  const t = useT()
  const widths: ["n" | "m" | "w", string][] = [["n", "display.narrow"], ["m", "display.standard"], ["w", "display.wide"]]
  return (
    <Segmented
      id={id} label={t("display.width")} attr="width" value={value} onChange={onChange} data-reading="readWidth"
      className={cn("width-seg", className)} buttonClassName={labels ? undefined : "px-[9px]"}
      options={widths.map(([v, key]) => ({
        value: v, label: labels ? undefined : t(key),
        content: <><WidthIcon width={v} />{labels && <span>{t(key)}</span>}</>,
      }))}
    />
  )
}

export function ThemeChoice({ id, value, onChange, labels = false, className }: { id?: string; value: string; onChange: Change; labels?: boolean; className?: string }) {
  const t = useT()
  const themes: [string, string, typeof Sun][] = [["system", "theme.system", Monitor], ["light", "theme.light", Sun], ["dark", "theme.dark", Moon]]
  return (
    <Segmented
      id={id} label={t("theme.title")} attr="mode" value={value} onChange={onChange} data-reading="theme"
      className={cn("theme-seg", className)} buttonClassName={labels ? undefined : "px-[9px]"}
      options={themes.map(([v, key, Icon]) => ({
        value: v, label: labels ? undefined : t(key),
        content: <><Icon strokeWidth={1.8} />{labels && <span>{t(key)}</span>}</>,
      }))}
    />
  )
}

const row = "pop-row flex min-h-10 items-center justify-between gap-4 rounded-lg px-2.5 py-1 text-sm"

// Reading Options, under the "Aa" button in the reader: kept on this device.
export function ReadingOptions({ onClose }: { onClose: () => void }) {
  const t = useT()
  const r = useReading()
  return (
    <PopoverContent
      id="display-pop"
      align="end"
      sideOffset={6}
      collisionPadding={8}
      className="w-[min(344px,calc(100vw-16px))] max-h-[calc(100dvh-80px)] gap-0 overflow-y-auto overscroll-contain rounded-2xl p-2 shadow-(--elev-float)"
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <p className="pop-head mx-2.5 mt-1.5 mb-1.5 text-[11px] font-semibold tracking-[.07em] text-muted-foreground uppercase">{t("display.title")}</p>
      <label className={cn(row, "cursor-pointer hover:bg-accent")}>
        <span>{t("toggle.words")}</span>
        <Switch id="show-words" checked={!r.hideWords} onCheckedChange={(on) => setDeviceReading("hideWords", !on)} />
      </label>
      <label className={cn(row, "cursor-pointer hover:bg-accent")}>
        <span>{t("toggle.phrases")}</span>
        <Switch id="show-phrases" checked={!r.hidePhrases} onCheckedChange={(on) => setDeviceReading("hidePhrases", !on)} />
      </label>
      <div className={row}>
        <span>{t("display.size")}</span>
        <SizeChoice id="size-seg" value={r.readSize} onChange={(v) => setDeviceReading("readSize", v)} />
      </div>
      <div className="pop-block px-2.5 pt-1.5 pb-2 text-sm">
        <span className="mb-1.5 block">{t("display.font")}</span>
        <FontChoice id="font-seg" value={r.readFont} onChange={(v) => setDeviceReading("readFont", v)} className="w-full" />
      </div>
      <div className="pop-block px-2.5 pt-1.5 pb-2 text-sm">
        <span className="mb-1.5 block">{t("display.glossFont")}</span>
        <GlossChoice id="gloss-seg" value={r.glossFont} onChange={(v) => setDeviceReading("glossFont", v)} className="w-full" />
      </div>
      <div className={cn(row, "width-row max-[900px]:hidden")}>
        <span>{t("display.width")}</span>
        <WidthChoice id="width-seg" value={r.readWidth} onChange={(v) => setDeviceReading("readWidth", v)} />
      </div>
      <div className={row}>
        <span>{t("theme.title")}</span>
        <ThemeChoice value={r.theme} onChange={(v) => setDeviceReading("theme", v)} />
      </div>
      {/* Wraps to the popover's width instead of widening it. */}
      <p className="pop-foot display-foot m-0 mt-1.5 w-0 min-w-full border-t px-2.5 pt-2.5 pb-1 text-[12.5px] leading-normal text-muted-foreground">
        <span>{t("display.local")}</span>{" "}
        <a
          id="display-defaults"
          href="#/settings"
          className="font-medium text-foreground underline underline-offset-3 hover:text-primary"
          onClick={(e) => { e.preventDefault(); onClose(); openSettingsAt("set-reading-h") }}
        >
          {t("display.defaults")}
        </a>
      </p>
    </PopoverContent>
  )
}
