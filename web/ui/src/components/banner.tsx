import { AlertCircle, Info, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useApp, hideBanner } from "@/app/store"
import { useT } from "@/app/hooks"
import { Button } from "@/components/ui/button"

// A message across the top of the page: something went wrong, or something
// worth knowing ("Set up your AI model in Settings").
export function Banner() {
  const t = useT()
  const banner = useApp((s) => s.banner)
  const view = useApp((s) => s.view)
  if (!banner) return null
  const info = banner.kind === "info"
  const Icon = info ? Info : AlertCircle
  return (
    <div
      id="banner"
      role="status"
      className={cn(
        "banner anim-rise mx-auto mt-4 flex w-[calc(100%-32px)] max-w-[1040px] items-center gap-3 rounded-2xl border py-2 pr-2 pl-4 text-sm",
        info ? "info border-border bg-card shadow-xs" : "border-destructive/25 bg-destructive/[.06] text-foreground",
        "max-sm:w-full max-sm:rounded-none max-sm:border-x-0",
      )}
    >
      <Icon className={cn("size-4 shrink-0", info ? "text-muted-foreground" : "text-destructive")} />
      <span id="banner-text" className="min-w-0 flex-1">{banner.text}</span>
      {banner.settingsLink && view !== "settings" && (
        <Button id="banner-action" asChild size="sm" variant="outline">
          <a href="#/settings">{t("banner.openSettings")}</a>
        </Button>
      )}
      <Button id="banner-close" variant="ghost" size="icon-sm" aria-label={t("btn.close")} onClick={hideBanner}>
        <X />
      </Button>
    </div>
  )
}
