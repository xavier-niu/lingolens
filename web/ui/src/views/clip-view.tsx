import * as React from "react"
import { Globe, MousePointerClick } from "lucide-react"
import { useApp } from "@/app/store"
import { useT } from "@/app/hooks"
import { cancelClip, saveClip } from "@/app/clip"
import { openSettingsAt } from "@/app/session"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// #/clip: a page sent by the bookmarklet from another tab, waiting to be added.
export function ClipView() {
  const t = useT()
  const view = useApp((s) => s.view)
  const clip = useApp((s) => s.clip)
  const waited = useApp((s) => s.clipWaited)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const save = React.useRef<HTMLButtonElement>(null)
  const shown = view === "clip"

  React.useEffect(() => {
    if (shown) setError("")
  }, [shown])
  React.useEffect(() => {
    if (shown && clip) save.current?.focus()
  }, [shown, clip])

  return (
    <section id="clip-view" hidden={!shown} className="clip mx-auto mt-16 max-w-[560px] max-sm:mt-8">
      <div className="clip-card rounded-2xl border bg-card p-7 shadow-(--shadow-soft) max-sm:p-5">
        <p className="clip-kicker m-0 mb-4 inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          <Globe className="size-3.5" />{t("clip.kicker")}
        </p>
        <div id="clip-wait" role="status" hidden={!!clip || waited} className="clip-wait flex items-center gap-2.5 py-2 text-sm text-muted-foreground">
          <Spinner />{t("clip.waiting")}
        </div>
        <div id="clip-none" hidden={!!clip || !waited}>
          <h1 className="m-0 font-serif text-2xl font-semibold tracking-tight">{t("clip.noneTitle")}</h1>
          <p className="clip-from mt-2 mb-0 text-sm text-muted-foreground">{t("clip.none")}</p>
          <div className="mt-6 flex">
            <Button asChild variant="outline">
              <a href="#/settings" data-clip-setup onClick={(e) => { e.preventDefault(); openSettingsAt("set-clip-h") }}>
                <MousePointerClick data-icon="inline-start" />{t("clip.setup")}
              </a>
            </Button>
          </div>
        </div>
        <div id="clip-page" hidden={!clip}>
          {clip && (<>
            <h1 id="clip-title" className="m-0 font-serif text-2xl leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]">{clip.title || clip.host}</h1>
            <p id="clip-from" className="clip-from mt-2 mb-0 text-sm text-muted-foreground">{t("clip.from", { host: clip.host })}</p>
            <p id="clip-what" className="src-note mt-4 mb-0 rounded-lg bg-muted px-3 py-2 text-[13.5px] text-ink-2">
              {clip.selection ? t("clip.selection", { n: clip.words.toLocaleString() }) : t("clip.article")}
            </p>
          </>)}
          <p id="clip-error" role="alert" className="field-error mt-3 mb-0 text-[13px] text-destructive empty:hidden">{error}</p>
          <div className="row mt-6 flex items-center gap-2">
            <span className="flex-1" />
            <Button type="button" id="clip-cancel" variant="ghost" onClick={cancelClip}>{t("settings.cancel")}</Button>
            <Button
              type="button" id="clip-save" ref={save} disabled={busy} aria-busy={busy || undefined}
              onClick={async () => {
                setBusy(true)
                setError("")
                try {
                  await saveClip()
                } catch (err: any) {
                  setError(err.message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy && <Spinner />}{t("clip.save")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
