import * as React from "react"
import { Check, CloudOff, FilePlus2, History, LogOut, MoreHorizontal, PencilLine, RefreshCw, Settings } from "lucide-react"
import { cn } from "@/lib/utils"
import { net } from "@/lib/api.js"
import { useApp, get, set, showBanner, type Book } from "@/app/store"
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

// Header buttons: quiet icons that light up on hover, and while their menu is open.
export const barButton =
  "relative inline-flex h-[34px] min-w-[34px] shrink-0 items-center justify-center gap-1.5 rounded-md px-[9px] text-sm font-medium whitespace-nowrap text-ink-2 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-accent aria-expanded:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground pointer-coarse:h-10 pointer-coarse:min-w-10 [&_svg]:size-[18px] [&_svg]:shrink-0"

export function Header() {
  const t = useT()
  const view = useApp((s) => s.view)
  const book = useApp((s) => s.book)
  useApp((s) => s.rev) // the open book's progress and title change in place
  const me = useApp((s) => s.me)
  const [scrolled, setScrolled] = React.useState(false)
  React.useEffect(() => {
    const on = () => setScrolled(window.scrollY > 2)
    on()
    window.addEventListener("scroll", on, { passive: true })
    return () => window.removeEventListener("scroll", on)
  }, [view])

  const reader = view === "reader"
  const progress = Math.round((book?.progress || 0) * 100)

  return (
    <header
      hidden={view === "login" || view === "boot"}
      className={cn(
        "topbar sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-transparent bg-background/95 px-[clamp(12px,3vw,28px)] backdrop-blur-md backdrop-saturate-150 transition-[border-color] duration-200 max-sm:h-[52px] max-sm:gap-2 max-sm:pr-2 max-sm:pl-3",
        (scrolled || reader) && "border-border",
      )}
    >
      <div className="bar-start flex min-w-0 flex-auto items-center gap-0.5">
        <a
          id="home-link"
          href="#/"
          title={t("reader.back")}
          aria-label={t("reader.back")}
          className="brand -ml-1.5 inline-flex shrink-0 items-center gap-2.5 rounded-lg p-1.5 text-foreground no-underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&:not(:hover)_.mark]:opacity-100 hover:[&_.mark]:opacity-85"
        >
          <LogoMark className="transition-opacity" />
          {view === "library" && <span className="wordmark text-base font-semibold tracking-tight" translate="no" aria-hidden="true">LingoLens</span>}
        </a>
        {view !== "library" && <Crumbs view={view} book={book} />}
      </div>

      <div className="bar-end flex shrink-0 items-center justify-end gap-1 max-sm:gap-0">
        <Annotating />
        <NetStatus />
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
            <FilePlus2 strokeWidth={1.8} />
          </button>
        )}
        {reader && <ReaderMenu />}
        {me && <AccountMenu hideOnPhone={reader} />}
      </div>

      {reader && (
        <div id="read-thread" className="read-thread pointer-events-none absolute inset-x-0 -bottom-px h-0.5" aria-hidden="true">
          <div className="h-full rounded-r-full bg-(--thread) transition-[width] duration-1000 ease-linear" style={{ width: `${progress}%` }} />
        </div>
      )}
    </header>
  )
}

// Where you are, after the logo: Shelf / book, or Shelf / (book /) Settings.
function Crumbs({ view, book }: { view: string; book: Book | null }) {
  const t = useT()
  const returnTo = useApp((s) => s.returnTo)
  const books = useApp((s) => s.books)
  const items: { label: string; href?: string; home?: boolean; title?: boolean }[] = [{ label: t("reader.back"), href: "#/", home: true }]
  if (view === "reader" && book) items.push({ label: book.title, title: true })
  if (view === "settings") {
    const m = returnTo.match(/^#\/read\/([^/]+)$/)
    const id = m && decodeURIComponent(m[1])
    const from = id && books.find((b) => String(b.id) === id)
    if (from) items.push({ label: from.title, href: returnTo, title: true })
    items.push({ label: t("settings.page") })
  }
  if (view === "clip") items.push({ label: t("clip.crumb") })
  return (
    <nav id="crumbs" className={cn("crumbs min-w-0", view === "reader" && "max-[359px]:hidden")} aria-label={t("a11y.crumbs")}>
      <ol className="m-0 flex min-w-0 list-none items-center p-0 text-sm max-sm:text-[14.5px]">
        {items.map((c, i) => {
          const last = i === items.length - 1
          const cls = cn(
            "crumb block truncate rounded-md px-1.5 py-[5px] font-medium text-muted-foreground no-underline transition-colors",
            c.href && "hover:bg-accent hover:text-foreground",
            last && "font-semibold text-foreground",
          )
          return (
            <li
              key={i}
              className={cn(
                "flex shrink-0 items-center",
                c.home ? "crumb-home max-sm:hidden" : "before:mx-0.5 before:font-light before:text-muted-foreground/60 before:content-['/']",
                c.title && "crumb-title min-w-0 shrink",
              )}
            >
              {c.href
                ? <a className={cls} href={c.href} aria-current={last ? "page" : undefined} title={c.title ? c.label : undefined}>{c.label}</a>
                : <span className={cls} aria-current={last ? "page" : undefined} title={c.title ? c.label : undefined}>{c.label}</span>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

// Text on screen waiting for its glosses.
function Annotating() {
  const t = useT()
  const { shown, n } = useApp((s) => s.annotating)
  return (
    <div
      id="progress"
      role="status"
      hidden={!shown}
      className="annotating net-in mr-1 inline-flex h-7 items-center gap-1.5 rounded-full border bg-muted pr-2.5 pl-2 text-[12.5px] font-medium whitespace-nowrap text-ink-2 max-sm:px-[7px]"
    >
      <Spinner className="size-3.5" />
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
        "net-status net-in mr-1 inline-flex h-7 items-center gap-1.5 rounded-full border bg-muted pr-2.5 pl-2 text-[12.5px] font-medium whitespace-nowrap text-ink-2 transition-colors hover:text-foreground max-sm:mr-0.5 max-sm:w-7 max-sm:justify-center max-sm:p-0",
        mode === "synced" && "border-success/30 text-success",
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

const menuItem = "menu-item h-9 gap-2.5 px-2.5 text-sm [&_svg]:text-muted-foreground"

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
      <DropdownMenuContent id="menu-pop" align="end" sideOffset={6} className="w-auto min-w-52 p-1.5">
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
          className={cn("avatar-btn group ml-1 inline-grid size-[38px] shrink-0 place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:ml-0.5 max-sm:w-[34px]", hideOnPhone && "max-sm:hidden")}
          aria-label={t("account.menu")}
          title={me.name ? `${me.name} (${me.email})` : me.email}
        >
          <Avatar id="avatar" user={me} className="transition-[filter,transform] group-hover:brightness-110 group-active:scale-95 group-aria-expanded:brightness-110" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent id="account-pop" align="end" sideOffset={6} className="w-auto max-w-[min(320px,calc(100vw-16px))] min-w-60 p-1.5">
        <div className="acct-card flex items-center gap-3 px-2.5 pt-2 pb-1.5">
          <Avatar id="avatar-lg" user={me} size="lg" />
          <div className="acct-who min-w-0">
            <p className="acct-line m-0 flex items-center gap-1.5">
              <span id="acct-pop-name" className="truncate text-[14.5px] font-semibold">{me.name || me.email}</span>
              {me.is_admin && <span id="acct-pop-role" className="shrink-0 rounded-full border bg-muted px-[7px] py-px text-[11px] font-semibold text-muted-foreground">{t("members.admin")}</span>}
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
