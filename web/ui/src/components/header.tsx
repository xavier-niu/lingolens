import * as React from "react"
import { Check, CloudOff, FilePlus2, History, LogOut, MoreHorizontal, PencilLine, RefreshCw, Settings } from "lucide-react"
import { cn } from "@/lib/utils"
import { net } from "@/lib/api.js"
import { useApp, get, set, showBanner } from "@/app/store"
import { useT } from "@/app/hooks"
import { toggleHistory } from "@/app/chat"
import { signOut } from "@/app/session"
import { LogoMark, TextSizeIcon } from "@/components/icons"
import { ReadingOptions } from "@/components/reading-options"
import { confirmDialog } from "@/components/confirm"
import { Avatar } from "@/components/avatar"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"

// Header icons: bare, with no box; they darken on hover and take the accent
// colour while their menu or sidebar is open.
export const barButton =
  "relative inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/35 aria-expanded:text-brand aria-pressed:text-brand pointer-coarse:size-10 [&_svg]:size-[19px] [&_svg]:shrink-0"

const navLink =
  "nav-link inline-flex h-9 items-center px-3 text-sm font-medium text-ink-2 no-underline transition-colors duration-150 outline-none hover:text-brand focus-visible:rounded-md focus-visible:ring-3 focus-visible:ring-ring/35 aria-[current=page]:text-brand"

// The header, plain as a documentation site's: the name on the left (it goes
// to the shelf); on the right the pages, a thin divider, then this page's tools
// as bare icons. Nothing under it: a hairline appears once the page scrolls.
export function Header() {
  const t = useT()
  const view = useApp((s) => s.view)
  const me = useApp((s) => s.me)
  const [scrolled, setScrolled] = React.useState(false)
  React.useEffect(() => {
    const on = () => setScrolled(window.scrollY > 2)
    on()
    window.addEventListener("scroll", on, { passive: true })
    return () => window.removeEventListener("scroll", on)
  }, [view])

  const reader = view === "reader"

  return (
    <header
      hidden={view === "login" || view === "boot"}
      className={cn(
        "topbar sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-transparent bg-background px-8 transition-[border-color] duration-200 max-lg:px-6 max-sm:h-14 max-sm:gap-2 max-sm:pr-2 max-sm:pl-4",
        scrolled && "border-border",
      )}
    >
      <a
        id="home-link"
        href="#/"
        title={t("reader.back")}
        className="brand inline-flex min-w-0 shrink-0 items-center gap-2.5 rounded-md text-foreground no-underline outline-none focus-visible:ring-3 focus-visible:ring-ring/35"
      >
        <LogoMark className="size-7" />
        <span className={cn("wordmark text-base font-semibold tracking-[-0.02em]", reader && "max-sm:sr-only")} translate="no">LingoLens</span>
      </a>

      <div className="bar-end flex shrink-0 items-center">
        <Annotating />
        <NetStatus />
        <nav aria-label={t("a11y.pages")} className="bar-nav flex items-center max-md:hidden">
          <a className={navLink} href="#/" aria-current={view === "library" ? "page" : undefined}>{t("reader.back")}</a>
          <a className={navLink} href="#/settings" aria-current={view === "settings" ? "page" : undefined}>{t("settings.page")}</a>
        </nav>
        <span className="bar-divider mx-2 h-6 w-px bg-border max-md:hidden" aria-hidden="true" />
        <div className="bar-tools flex items-center max-sm:gap-0">
          {reader && <ReadingOptionsButton />}
          <HistoryButton />
          {reader && (
            <button
              id="btn-append"
              type="button"
              className={cn(barButton, "max-sm:hidden")}
              title={t("btn.append")}
              aria-label={t("btn.append")}
              onClick={() => { const b = get().book; if (b) set((s) => ({ source: { book: b, append: true, seq: (s.source?.seq ?? 0) + 1 } })) }}
            >
              <FilePlus2 strokeWidth={1.7} />
            </button>
          )}
          {reader && <ReaderMenu />}
        </div>
        {me && <AccountMenu hideOnPhone={reader} />}
      </div>
    </header>
  )
}

// Text on screen waiting for its glosses: a quiet line of text, not a badge.
function Annotating() {
  const t = useT()
  const { shown, n } = useApp((s) => s.annotating)
  return (
    <div
      id="progress"
      role="status"
      hidden={!shown}
      className="annotating net-in mr-3 inline-flex h-7 items-center gap-2 text-[13px] whitespace-nowrap text-muted-foreground max-sm:mr-1"
    >
      <Spinner className="size-3.5 text-brand" />
      <span id="progress-text" className="max-sm:sr-only">{n ? t("progress", { n }) : ""}</span>
    </div>
  )
}

// Connection: offline, waiting, syncing, synced.
function NetStatus() {
  const t = useT()
  const { mode, title } = useApp((s) => s.net)
  const Icon = mode === "syncing" ? RefreshCw : mode === "synced" ? Check : CloudOff
  return (
    <button
      id="net-status"
      type="button"
      hidden={!mode}
      data-mode={mode}
      aria-label={mode ? t(`net.${mode}`) : undefined}
      title={title}
      onClick={() => showBanner(t(net.online ? "net.syncInfo" : "net.offlineInfo"), "info")}
      className={cn(
        "net-status net-in mr-3 inline-flex h-7 items-center gap-1.5 rounded-md text-[13px] whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/35 max-sm:mr-0.5 max-sm:w-8 max-sm:justify-center",
        mode === "synced" && "text-success hover:text-success",
        mode === "offline" && "text-foreground",
      )}
    >
      <Icon className={cn("size-[15px] shrink-0", mode === "syncing" && "animate-spin [animation-duration:1.1s]")} strokeWidth={1.9} />
      <span id="net-label" className="net-label max-sm:hidden">{mode ? t(`net.${mode}`) : ""}</span>
    </button>
  )
}

function ReadingOptionsButton() {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button id="btn-display" type="button" className={barButton} title={t("display.title")} aria-label={t("display.title")}>
          <TextSizeIcon />
        </button>
      </PopoverTrigger>
      <ReadingOptions onClose={() => setOpen(false)} />
    </Popover>
  )
}

function HistoryButton() {
  const t = useT()
  const live = useApp((s) => s.liveAway)
  const pressed = useApp((s) => s.drawer === "open" && s.chatMode === "history")
  return (
    <button
      id="btn-history"
      type="button"
      className={cn(barButton, live && "live")}
      title={t("chat.history")}
      aria-label={t("chat.history")}
      aria-pressed={pressed}
      onClick={toggleHistory}
    >
      <History strokeWidth={1.8} />
    </button>
  )
}

const menuItem = "menu-item h-9 gap-2.5 rounded-lg px-2.5 text-sm [&_svg]:text-muted-foreground"

// The reader's ⋯ menu. On a phone it also holds Append Text, and Settings (the
// account button makes way for the title).
function ReaderMenu() {
  const t = useT()
  const edit = (append: boolean) => {
    const b = get().book
    if (b) set((s) => ({ source: { book: b, append, seq: (s.source?.seq ?? 0) + 1 } }))
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button id="btn-menu" type="button" className={barButton} title={t("menu.title")} aria-label={t("menu.title")}>
          <MoreHorizontal strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent id="menu-pop" align="end" sideOffset={8} className="w-auto min-w-52 p-1.5">
        <DropdownMenuItem id="btn-edit" className={menuItem} onSelect={() => edit(false)}>
          <PencilLine />{t("btn.edit")}
        </DropdownMenuItem>
        <DropdownMenuItem id="menu-append" className={cn(menuItem, "sm:hidden")} onSelect={() => edit(true)}>
          <FilePlus2 />{t("btn.append")}
        </DropdownMenuItem>
        <DropdownMenuItem id="btn-settings" className={menuItem} asChild>
          <a href="#/settings"><Settings />{t("settings.page")}</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountMenu({ hideOnPhone }: { hideOnPhone: boolean }) {
  const t = useT()
  const me = useApp((s) => s.me)!
  const confirmLoss = (n: number) => confirmDialog(t("net.signOutPending", { n }), { confirm: t("account.signOut"), destructive: true })
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          id="btn-account"
          type="button"
          className={cn("avatar-btn group ml-2 inline-grid size-9 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/35 max-sm:ml-1", hideOnPhone && "max-sm:hidden")}
          aria-label={t("account.menu")}
          title={me.name ? `${me.name} (${me.email})` : me.email}
        >
          <Avatar id="avatar" user={me} className="size-8 text-[13px] transition-[filter,transform,box-shadow] group-hover:brightness-110 group-active:scale-95" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent id="account-pop" align="end" sideOffset={8} className="w-auto max-w-[min(320px,calc(100vw-16px))] min-w-64 p-1.5">
        <div className="acct-card flex items-center gap-3 px-2.5 pt-2.5 pb-2">
          <Avatar id="avatar-lg" user={me} size="lg" />
          <div className="acct-who min-w-0">
            <p className="acct-line m-0 flex items-center gap-1.5">
              <span id="acct-pop-name" className="truncate text-[14.5px] font-semibold">{me.name || me.email}</span>
              {me.is_admin && <span id="acct-pop-role" className="shrink-0 rounded-full bg-brand-soft px-[7px] py-px text-[11px] font-semibold text-brand">{t("members.admin")}</span>}
            </p>
            {me.name && <p id="acct-pop-email" className="m-0 mt-0.5 truncate text-[13px] text-muted-foreground">{me.email}</p>}
          </div>
        </div>
        <DropdownMenuSeparator className="mx-1 my-1.5" />
        <DropdownMenuItem id="acct-settings" className={menuItem} asChild>
          <a href="#/settings"><Settings />{t("settings.page")}</a>
        </DropdownMenuItem>
        <DropdownMenuItem id="acct-signout" className={menuItem} onSelect={() => signOut(confirmLoss)}>
          <LogOut />{t("account.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
