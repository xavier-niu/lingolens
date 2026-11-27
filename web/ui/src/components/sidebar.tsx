import * as React from "react"
import { Bookmark, BookOpen, ChevronsUpDown, CircleCheck, CircleDashed, Clock3, History, Library, PanelLeft, PanelLeftClose, PanelLeftOpen, Plus, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { isFinished, tintFor } from "@/lib/library.js"
import { useApp, type Book, type ShelfFilter } from "@/app/store"
import { useT } from "@/app/hooks"
import { continueReading, inFilter, isExpired, openSource, showShelf, tokensOf } from "@/app/books"
import { chats, historyItems, loadHistory, resumeChat, toggleHistory } from "@/app/chat"
import { slideRail, toggleRail, useBare, useRailMakingRoom, useRailMode, useRailSlides } from "@/app/rail"
import { LogoMark } from "@/components/icons"
import { Avatar } from "@/components/avatar"
import { AccountMenuContent, Annotating, NetStatus } from "@/components/header"
import { fmtWhen } from "@/components/chat-panel"
import { floating, floatingAway, floatingButton, useAwayWhileReading } from "@/components/reader-tools"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

// The sidebar on wide screens, in place of the header (the text's own tools
// float at the top right of the page: reader-tools.tsx). From the top: the
// name and the shelf; in a text, the latest Ask AI conversations about it, and
// at the foot its statistics. Then what's happening
// (glosses on the way, syncing), and the account. Narrowed, it's a
// strip of icons. On narrower screens it's hidden until the button floating at
// the top left slides it in over the page. See app/rail.ts for when it shows
// and how wide.

const CHATS = 8

export function Sidebar() {
  const mode = useRailMode()
  const slides = useRailSlides()
  const bare = useBare()
  const slid = useApp((s) => s.railSlid)
  React.useLayoutEffect(() => {
    if (mode) document.body.dataset.rail = mode
    else delete document.body.dataset.rail
    document.body.toggleAttribute("data-bare", bare) // no header (see index.css)
  }, [mode, bare])
  React.useEffect(() => { if (!slides) slideRail(false) }, [slides])
  if (mode) return mode === "full" ? <FullRail /> : <IconRail />
  if (!slides) return null
  return (
    <>
      <FloatStart />
      {slid && <SlidRail />}
    </>
  )
}

// Narrower screens: the button that slides the sidebar in, and beside it what's
// happening (glosses on the way, syncing), floating at the top left.
function FloatStart() {
  const t = useT()
  const slid = useApp((s) => s.railSlid)
  const away = useAwayWhileReading(!slid)
  return (
    <div id="float-start" data-away={away || undefined} className={cn(floating, "float-start left-4 max-sm:top-3 max-sm:left-3", away && floatingAway)}>
      <button
        id="btn-rail"
        type="button"
        className={floatingButton}
        title={t("rail.open")}
        aria-label={t("rail.open")}
        aria-expanded={slid}
        aria-controls={slid ? "rail" : undefined}
        onClick={() => slideRail(true)}
      >
        <PanelLeft strokeWidth={1.7} />
      </button>
      <Annotating place="float" />
      <NetStatus place="float" />
    </div>
  )
}

// Slid in over the page, on a phone or tablet. It goes again on its own once
// used: on going anywhere (a link, the account menu), on Ask AI opening, on a
// press outside it, and on Escape. Focus moves into it and back to the button.
function SlidRail() {
  const view = useApp((s) => s.view)
  const bookId = useApp((s) => s.book?.id)
  const first = React.useRef(true)
  React.useEffect(() => {
    if (first.current) { first.current = false; return }
    slideRail(false)
  }, [view, bookId])
  React.useEffect(() => {
    const away = () => slideRail(false)
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[data-radix-popper-content-wrapper]")) away()
    }
    window.addEventListener("hashchange", away)
    document.addEventListener("keydown", key)
    const root = document.documentElement
    root.style.overflow = "hidden" // the page stays put underneath
    document.querySelector<HTMLElement>("#rail-close")?.focus({ preventScroll: true })
    return () => {
      window.removeEventListener("hashchange", away)
      document.removeEventListener("keydown", key)
      root.style.overflow = ""
      document.querySelector<HTMLElement>("#btn-rail")?.focus({ preventScroll: true })
    }
  }, [])
  return (
    <>
      <div id="rail-backdrop" className="rail-backdrop fixed inset-0 z-40 bg-black/25 dark:bg-black/50" aria-hidden="true" onClick={() => slideRail(false)} />
      <FullRail slid />
    </>
  )
}

// A row: an icon and its name, quiet until hovered or current.
const row =
  "flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[14px] text-ink-2 no-underline transition-colors duration-150 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/35 aria-expanded:bg-accent aria-expanded:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground [&_svg]:size-[17px] [&_svg]:shrink-0 [&_svg]:text-muted-foreground"

const heading = "m-0 px-3 text-[12px] font-medium text-muted-foreground"

function FullRail({ slid = false }: { slid?: boolean }) {
  const t = useT()
  const view = useApp((s) => s.view)
  const book = useApp((s) => s.book)
  useApp((s) => s.rev) // the open text's progress changes in place
  const reading = view === "reader" ? book : null
  return (
    <aside
      id="rail"
      data-mode={slid ? "slid" : "full"}
      aria-label={t("rail.label")}
      className={cn(
        "rail fixed inset-y-0 left-0 flex flex-col border-r bg-background",
        slid ? "rail-slid z-50 w-[min(288px,calc(100vw-48px))] pb-[env(safe-area-inset-bottom)] shadow-(--elev-float)" : "z-20 w-(--rail)",
      )}
    >
      <div className={cn("flex shrink-0 items-center justify-between pr-2.5 pl-6", slid ? "h-14" : "h-16")}>
        <a
          id={slid ? undefined : "home-link"}
          href="#/"
          title={t("reader.back")}
          className="brand inline-flex min-w-0 items-center gap-2.5 rounded-md text-foreground no-underline outline-none focus-visible:ring-3 focus-visible:ring-ring/35"
        >
          <LogoMark className="size-7" />
          <span className="wordmark text-base font-semibold tracking-[-0.02em]" translate="no">LingoLens</span>
        </a>
        {slid
          ? (
            <button id="rail-close" type="button" className={cn(iconButton, "size-9")} title={t("rail.close")} aria-label={t("rail.close")} onClick={() => slideRail(false)}>
              <X strokeWidth={1.8} />
            </button>
          )
          : <RailToggle />}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-3 pt-2 pb-4">
        <button id="rail-add" type="button" className={row} onClick={() => { slideRail(false); openSource() }}>
          <Plus strokeWidth={1.9} />{t("shelf.add")}
        </button>
        <ContinueReading />
        <nav aria-label={t("a11y.pages")} className="-mt-3">
          <ShelfLink />
          <Filters />
        </nav>
        {reading && <Conversations book={reading} />}
      </div>

      <div className="shrink-0 px-3 pb-3">
        {reading && <Stats book={reading} />}
        <div className="flex flex-col gap-0.5 border-t pt-2">
          {!slid && <Annotating place="row" />}
          {!slid && <NetStatus place="row" />}
          <AccountButton />
        </div>
      </div>
    </aside>
  )
}

// Narrowed: the same, as icons (their names in tooltips).
function IconRail() {
  const t = useT()
  const view = useApp((s) => s.view)
  const live = useApp((s) => s.liveAway)
  const history = useApp((s) => s.drawer === "open" && s.chatMode === "history")
  const makingRoom = useRailMakingRoom()
  return (
    <aside id="rail" data-mode="compact" aria-label={t("rail.label")} className="rail fixed inset-y-0 left-0 z-20 flex w-(--rail) flex-col items-center border-r bg-background">
      <div className="flex h-16 shrink-0 items-center justify-center">
        <a
          id="home-link"
          href="#/"
          title={t("reader.back")}
          aria-label="LingoLens"
          className="brand inline-flex rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/35"
        >
          <LogoMark className="size-7" />
        </a>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto pt-2 pb-4">
        {!makingRoom && <RailToggle />}
        <button id="rail-add" type="button" className={iconButton} title={t("shelf.add")} aria-label={t("shelf.add")} onClick={openSource}>
          <Plus strokeWidth={1.9} />
        </button>
        <nav aria-label={t("a11y.pages")} className="contents">
          <a id="rail-shelf" href="#/" title={t("reader.back")} aria-label={t("reader.back")} aria-current={view === "library" ? "page" : undefined} className={iconButton} onClick={() => showShelf("all")}>
            <Library strokeWidth={1.8} />
          </a>
        </nav>
        <button
          id="btn-history"
          type="button"
          className={cn(iconButton, live && "live")}
          title={t("chat.history")}
          aria-label={t("chat.history")}
          aria-pressed={history}
          onClick={toggleHistory}
        >
          <History strokeWidth={1.8} />
        </button>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1 pb-3">
        <Annotating place="icon" />
        <NetStatus place="icon" />
        <AccountButton compact />
      </div>
    </aside>
  )
}

const iconButton =
  "relative grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/35 aria-expanded:bg-accent aria-expanded:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground [&_svg]:size-[19px]"

function RailToggle() {
  const t = useT()
  const open = useApp((s) => s.railOpen)
  const label = t(open ? "rail.hide" : "rail.show")
  const Icon = open ? PanelLeftClose : PanelLeftOpen
  return (
    <button
      id="btn-rail"
      type="button"
      className={cn(iconButton, "rail-toggle size-9 aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-accent aria-expanded:hover:text-foreground")}
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-controls="rail"
      onClick={toggleRail}
    >
      <Icon strokeWidth={1.7} />
    </button>
  )
}

function ShelfLink() {
  const t = useT()
  const view = useApp((s) => s.view)
  const filter = useApp((s) => s.shelfFilter)
  const books = useApp((s) => s.books)
  const loaded = useApp((s) => s.booksLoaded)
  const n = books.filter((b) => !isExpired(b)).length
  return (
    <a
      id="rail-shelf"
      href="#/"
      aria-current={view === "library" && filter === "all" ? "page" : undefined}
      className={row}
      onClick={(e) => { e.preventDefault(); slideRail(false); showShelf("all") }}
    >
      <Library strokeWidth={1.8} />
      <span className="flex-1">{t("reader.back")}</span>
      {loaded && n > 0 && <span className="text-xs font-normal text-muted-foreground tabular-nums">{n}</span>}
    </a>
  )
}

// The shelf's filters, under it, with how many texts each has. "Deleting
// soon" only when there are some.
const FILTERS: { f: ShelfFilter; icon: typeof Bookmark }[] = [
  { f: "later", icon: Bookmark },
  { f: "reading", icon: BookOpen },
  { f: "new", icon: CircleDashed },
  { f: "done", icon: CircleCheck },
  { f: "expiring", icon: Clock3 },
]

function Filters() {
  const t = useT()
  const view = useApp((s) => s.view)
  const current = useApp((s) => s.shelfFilter)
  const books = useApp((s) => s.books)
  const loaded = useApp((s) => s.booksLoaded)
  const shelf = books.filter((b) => !isExpired(b))
  return (
    <ul id="rail-filters" className="m-0 mt-px flex list-none flex-col gap-px p-0">
      {FILTERS.map(({ f, icon: Icon }) => {
        const n = shelf.filter((b) => inFilter(b, f)).length
        if (f === "expiring" && !n) return null
        return (
          <li key={f}>
            <button
              type="button"
              data-filter={f}
              aria-current={view === "library" && current === f ? "page" : undefined}
              className={cn(row, "pl-6")}
              onClick={() => { slideRail(false); showShelf(f) }}
            >
              <Icon strokeWidth={1.8} />
              <span className="flex-1">{t(`filter.${f}`)}</span>
              {loaded && <span className="text-xs font-normal text-muted-foreground tabular-nums">{n}</span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// The text last read and not yet finished, to go back to in one go (not
// while reading it).
function ContinueReading() {
  const t = useT()
  const books = useApp((s) => s.books)
  const openId = useApp((s) => (s.view === "reader" ? s.book?.id : null))
  useApp((s) => s.rev)
  const b = continueReading(books)
  if (!b || b.id === openId) return null
  const p = Math.floor((b.progress || 0) * 100)
  return (
    <section id="rail-continue" aria-labelledby="rail-continue-title">
      <h2 id="rail-continue-title" className={cn(heading, "mb-1")}>{t("rail.continue")}</h2>
      <a href={`#/read/${encodeURIComponent(b.id)}`} data-book={b.id} title={b.title} className={cn(row, "h-auto min-h-9 py-1.5")} onClick={() => slideRail(false)}>
        <span className="cover h-4 w-3 shrink-0 rounded-[3px] ring-1 ring-black/5" data-tint={tintFor(b.id)} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{b.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{p}%</span>
      </a>
    </section>
  )
}

// Statistics of the open text, at the foot: how far along it is, and what Ask
// AI and the glosses have cost on it (read afresh, read from the provider's
// prompt cache, written).
function Stats({ book }: { book: Book }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const books = useApp((s) => s.books)
  const locale = lang === "zh" ? "zh-CN" : "en"
  const compact = React.useMemo(() => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }), [locale])
  const exact = (n: number) => n.toLocaleString(locale)

  const done = isFinished(book)
  const progress = done ? 100 : Math.floor((book.progress || 0) * 100)
  const tokens = tokensOf(book, books)
  const count = (n: number) => (n ? compact.format(n) : "0")
  const title = (n: number) => (n >= 1000 ? exact(n) : undefined)
  const rows: { id: string; label: string; value: React.ReactNode; title?: string; sub?: boolean }[] = [
    { id: "stat-progress", label: t("rail.progress"), value: done ? t("book.finished") : `${progress}%` },
    { id: "rail-tokens", label: t("rail.tokens"), value: count(tokens.total), title: title(tokens.total) },
    { id: "stat-tokens-in", label: t("rail.tokensIn"), value: count(tokens.input), title: title(tokens.input), sub: true },
    { id: "stat-tokens-cached", label: t("rail.tokensCached"), value: count(tokens.cached), title: title(tokens.cached), sub: true },
    { id: "stat-tokens-out", label: t("rail.tokensOut"), value: count(tokens.output), title: title(tokens.output), sub: true },
  ]

  return (
    <section id="rail-stats" aria-labelledby="rail-stats-title" className="px-3 pt-3 pb-4">
      <h2 id="rail-stats-title" className="m-0 text-[12px] font-medium text-muted-foreground">{t("rail.statsText")}</h2>
      <div
        className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-label={t("rail.progress")}
      >
        <div className={cn("h-full rounded-full bg-(--thread) transition-[width] duration-500", done && "bg-success")} style={{ width: `${progress}%` }} />
      </div>
      <dl className="m-0 mt-2.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-[12.5px]">
        {rows.map((r) => (
          <React.Fragment key={r.id}>
            <dt className={cn("text-muted-foreground", r.sub && "pl-3 text-[12px] text-muted-foreground/80")}>{r.label}</dt>
            <dd
              id={r.id}
              className={cn("m-0 text-right tabular-nums", r.sub ? "text-[12px] text-muted-foreground" : "font-medium")}
              title={r.title}
              data-total={r.id === "rail-tokens" ? tokens.total : undefined}
            >
              {r.value}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  )
}

// The Ask AI conversations about the open text, the latest first, to pick one
// up again; all of them in the Ask AI sidebar.
function Conversations({ book }: { book: Book }) {
  const t = useT()
  const hist = useApp((s) => s.hist)
  const live = useApp((s) => s.liveAway)
  const history = useApp((s) => s.drawer === "open" && s.chatMode === "history")
  const showing = useApp((s) => s.drawer === "open" && s.chatMode === "chat")
  useApp((s) => s.chatRev)
  React.useEffect(() => { if (!hist.items) loadHistory() }, [hist.items])

  const items = historyItems(hist.items)
    .filter((c) => c.bookId === String(book.id))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, CHATS)
  const empty = items.length ? "" : hist.items ? t("rail.chatsNone") : hist.status

  return (
    <section id="rail-chats" aria-labelledby="rail-chats-title">
      <div className="mb-1 flex items-center justify-between pr-1.5">
        <h2 id="rail-chats-title" className={heading}>{t("chat.history")}</h2>
        <button
          id="btn-history"
          type="button"
          className={cn("relative rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/35 aria-pressed:text-foreground", live && "live")}
          title={t("chat.history")}
          aria-pressed={history}
          onClick={toggleHistory}
        >
          {t("rail.seeAll")}
        </button>
      </div>
      {empty && <p id="rail-chats-empty" className="m-0 px-3 py-1 text-[12.5px] leading-relaxed text-muted-foreground">{empty}</p>}
      <ol id="rail-chat-list" className="m-0 flex list-none flex-col gap-px p-0">
        {items.map((c) => {
          const about = c.questions === 1 ? t("chat.question1") : t("chat.questions", { n: c.questions })
          return (
            <li key={c.id}>
              <button
                type="button"
                data-id={c.id}
                aria-current={showing && chats.drawn?.id === c.id ? "true" : undefined}
                title={c.selection}
                className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-1.5 text-left transition-colors duration-150 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/35 aria-[current=true]:bg-accent"
                onClick={() => resumeChat(c.id)}
              >
                <span className="w-full truncate text-[13.5px] leading-snug text-ink-2">{c.question || c.selection}</span>
                <span className="w-full truncate text-[11.5px] text-muted-foreground">
                  {[about, c.live ? "" : fmtWhen(c.updatedAt)].filter(Boolean).join(" · ")}
                  {c.live && <>{about && " · "}<span className="font-medium text-brand">{t("chat.answering")}</span></>}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function AccountButton({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const me = useApp((s) => s.me)!
  const who = me.name ? `${me.name} (${me.email})` : me.email
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button id="btn-account" type="button" aria-label={t("account.menu")} title={who} className="avatar-btn group mt-1 inline-grid size-10 place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/35">
            <Avatar id="avatar" user={me} className="size-8 text-[13px] transition-[filter,transform] group-hover:brightness-110 group-active:scale-95" />
          </button>
        ) : (
          <button
            id="btn-account"
            type="button"
            aria-label={t("account.menu")}
            title={who}
            className="avatar-btn flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/35 data-[state=open]:bg-accent"
          >
            <Avatar id="avatar" user={me} className="size-7 text-[12px]" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{me.name || me.email}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
          </button>
        )}
      </DropdownMenuTrigger>
      <AccountMenuContent side={compact ? "right" : "top"} align={compact ? "end" : "start"} sideOffset={compact ? 20 : 8} />
    </DropdownMenu>
  )
}
