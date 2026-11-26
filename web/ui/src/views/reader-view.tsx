import * as React from "react"
import { Hash, Languages, Loader2, Search, Volume2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { useApp, get, reduceMotion, showBanner, type Book } from "@/app/store"
import { useT } from "@/app/hooks"
import { useReading } from "@/app/reading"
import { bookStat, expiryText } from "@/app/books"
import { engine, onArticleClick, onCardAction, rubyEl, hideFab, dismissHint, closeCard } from "@/app/engine"
import { openChat } from "@/app/chat"
import { formatAsMarkdown } from "@/app/session"
import { detectFormat } from "@/lib/library.js"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { SparkIcon } from "@/components/icons"

export function ReaderView() {
  const view = useApp((s) => s.view)
  const book = useApp((s) => s.book)
  useApp((s) => s.rev) // progress and title change in place
  useApp((s) => s.lang)
  const r = useReading()
  const stat = book ? [bookStat(book), expiryText(book)].filter(Boolean).join(" · ") : ""
  const article = React.useCallback((el: HTMLElement | null) => { if (el) engine.article = el }, [])
  return (
    <section id="reader-view" hidden={view !== "reader"} className="reader mx-auto mt-14 max-w-(--read-width) max-sm:mt-8">
      <header className="reader-head mb-10 border-b border-border/80 pb-7 max-sm:mb-8 max-sm:pb-6">
        <h1 id="book-title" className="book-heading m-0 font-reading text-[clamp(28px,4.2vw,38px)] leading-[1.18] font-bold tracking-[-0.025em]">
          {book?.title}
        </h1>
        <p id="book-stat" className="book-stat mt-3.5 mb-0 text-sm text-muted-foreground tabular-nums">{stat}</p>
        {book && <MarkdownOffer book={book} />}
      </header>
      {/* The text itself is drawn by the reading engine (app/engine.ts), not React. */}
      <article
        id="article"
        ref={article}
        className={cn("article", r.hideWords && "hide-words", r.hidePhrases && "hide-phrases")}
        onClick={(e) => onArticleClick(e.nativeEvent)}
      />
    </section>
  )
}

// A text saved as plain text whose marks say it's Markdown (lists in lists,
// headings, emphasis): offer to show it formatted. "Keep Plain Text" is
// remembered for that text on this device.
function MarkdownOffer({ book }: { book: Book }) {
  const t = useT()
  const key = `lingolens.plain.${book.id}`
  const content = book.content || ""
  const looks = React.useMemo(() => book.format === "text" && detectFormat(content) === "markdown", [book.format, content])
  const [kept, setKept] = React.useState(() => { try { return localStorage.getItem(key) === "1" } catch { return false } })
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => { try { setKept(localStorage.getItem(key) === "1") } catch { /* private mode */ } }, [key])
  if (!looks || kept) return null
  const keep = () => {
    try { localStorage.setItem(key, "1") } catch { /* private mode: asks again next time */ }
    setKept(true)
  }
  const apply = async () => {
    setBusy(true)
    try {
      await formatAsMarkdown(book)
    } catch (err: any) {
      showBanner(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div id="md-offer" role="status" className="anim-rise mt-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl bg-card px-4 py-3 text-sm shadow-xs ring-1 ring-border">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><Hash className="size-4" /></span>
      <span className="min-w-[14rem] flex-1 text-ink-2">{t("reader.mdOffer")}</span>
      <span className="flex shrink-0 gap-2">
        <Button id="md-keep" variant="ghost" size="sm" onClick={keep} disabled={busy}>{t("reader.mdKeep")}</Button>
        <Button id="md-apply" size="sm" onClick={apply} disabled={busy} aria-busy={busy || undefined}>
          {busy && <Spinner />}{t("reader.mdApply")}
        </Button>
      </span>
    </div>
  )
}

// Places el next to rect (page coordinates): centred under it, or above it
// when there's no room below (or when asked to).
function positionNear(el: HTMLElement, rect: DOMRect, above = false) {
  const margin = 8
  const w = el.offsetWidth
  const h = el.offsetHeight
  let left = rect.left + window.scrollX + rect.width / 2 - w / 2
  left = Math.max(window.scrollX + 16, Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 16))
  let top = above ? rect.top + window.scrollY - h - margin : rect.bottom + window.scrollY + margin
  if (!above && rect.bottom + h + margin > window.innerHeight && rect.top - h - margin > 60) {
    top = rect.top + window.scrollY - h - margin
  }
  if (above && rect.top - h - margin < 60) top = rect.bottom + window.scrollY + margin
  el.style.left = `${left}px`
  el.style.top = `${top}px`
}

// ------------------------------------------------------------------ word card

// The card goes under the word, or above it when there's more room there, and
// is never taller than that room (it scrolls inside). On a phone it's a sheet
// at the bottom of the screen instead (see its classes).
function placeCard(el: HTMLElement, rect: DOMRect) {
  if (matchMedia("(width < 40rem)").matches) {
    el.style.maxHeight = el.style.left = el.style.top = ""
    return
  }
  const margin = 8
  const edge = 12
  const header = 64
  el.style.maxHeight = ""
  const w = el.offsetWidth
  const h = el.offsetHeight
  const below = window.innerHeight - rect.bottom - margin - edge
  const above = rect.top - margin - header
  const under = h <= below || below >= above
  const room = Math.max(160, Math.min(under ? below : above, 560))
  el.style.maxHeight = `${room}px`
  const shown = Math.min(h, room)
  let left = rect.left + window.scrollX + rect.width / 2 - w / 2
  left = Math.max(window.scrollX + 16, Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 16))
  el.style.left = `${left}px`
  el.style.top = `${(under ? rect.bottom + margin : rect.top - margin - shown) + window.scrollY}px`
}

export function WordCard() {
  const t = useT()
  const card = useApp((s) => s.card)
  const known = useApp((s) => s.known)
  const ref = React.useRef<HTMLDivElement>(null)
  const a = card ? engine.anns[card.idx] : undefined

  React.useLayoutEffect(() => {
    const el = rubyEl(card?.idx ?? null)
    if (ref.current && el) placeCard(ref.current, el.getBoundingClientRect())
  }, [card])

  // Fades in where it stands when it opens (for another word too), not when
  // its contents change.
  const idx = card?.idx
  React.useLayoutEffect(() => {
    if (idx != null && !reduceMotion()) ref.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: "ease-out" })
  }, [idx])

  if (!card || !a) return null
  const key = a.lemma.toLowerCase()
  const isKnown = known.has(key)
  const e = a.entry
  const act = (name: string) => () => onCardAction(name)
  const canSpeak = "speechSynthesis" in window

  return (
    <div
      id="card"
      ref={ref}
      role="dialog"
      aria-label={a.lemma}
      className={cn(
        "card absolute z-40 max-h-[min(70vh,560px)] w-[min(348px,calc(100vw-32px))] overflow-y-auto overscroll-contain rounded-2xl bg-popover p-4 pb-3.5 text-popover-foreground shadow-(--elev-float)",
        "max-sm:fixed max-sm:inset-x-0 max-sm:!top-auto max-sm:bottom-0 max-sm:!left-0 max-sm:max-h-[62vh] max-sm:w-full max-sm:rounded-b-none max-sm:rounded-t-3xl max-sm:px-5 max-sm:pt-5 max-sm:pb-[calc(16px+env(safe-area-inset-bottom))]",
      )}
    >
      <div className="head flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pr-9">
        <span className="lemma text-[21px] font-semibold tracking-[-0.02em]">{a.lemma}</span>
        {a.ipa && <span className="ipa font-mono text-[13px] text-muted-foreground">/{a.ipa}/</span>}
        {a.pos && <span className="pos rounded-md bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground">{a.pos}</span>}
      </div>
      {canSpeak && (
        <Button
          variant="ghost" size="icon-sm" className="speak absolute top-3 right-3 text-muted-foreground max-sm:top-4 max-sm:right-4"
          data-act="speak" title={t("card.speak")} aria-label={t("card.speak")} onClick={act("speak")}
        >
          <Volume2 />
        </Button>
      )}
      {a.zh && (
        <div className="zh-row mt-1.5 flex items-center justify-between gap-3">
          <div className="zh min-w-0 font-zh text-[19px] font-medium text-gloss">{a.zh}</div>
          {a.lookup && (
            <Button
              size="xs" variant={a.glossed ? "outline" : "default"} className="gloss-btn shrink-0"
              data-act="gloss" onClick={act("gloss")}
            >
              {t(a.glossed ? "card.removeGloss" : "card.addGloss")}
            </Button>
          )}
        </div>
      )}
      {a.zh && a.text.toLowerCase() !== key && (
        <div className="surface mt-0.5 text-[13px] text-muted-foreground">{t("card.surface", { t: a.text })}</div>
      )}

      {a.loading && (
        <div className="detail card-detail mt-3 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />{t("card.loading")}
        </div>
      )}
      {!a.loading && a.error && <div className="detail error card-detail mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{a.error}</div>}
      {!a.loading && !a.error && e && (
        <div className="detail card-detail mt-3">
          {e.explanation && <p className="expl">{e.explanation}</p>}
          {!!e.senses?.length && (<>
            <h4>{t("card.senses")}</h4>
            <ul>{e.senses.map((s, i) => <li key={i}><i>{s.pos}</i> {s.zh} <span className="text-muted-foreground">{s.en}</span></li>)}</ul>
          </>)}
          {!!e.collocations?.length && (<>
            <h4>{t("card.collocations")}</h4>
            <ul>{e.collocations.map((c, i) => <li key={i}>{c.en} <span className="text-muted-foreground">{c.zh}</span></li>)}</ul>
          </>)}
          {!!e.examples?.length && (<>
            <h4>{t("card.examples")}</h4>
            <ul>{e.examples.map((x, i) => <li key={i}>{x.en}<br /><span className="text-muted-foreground">{x.zh}</span></li>)}</ul>
          </>)}
        </div>
      )}

      <div className="actions mt-4 flex flex-wrap gap-1.5 border-t border-border/80 pt-3.5 [&_[data-slot=button]]:rounded-full [&_[data-slot=button]]:px-3">
        {!a.entry && !a.loading && (
          a.zh
            ? <Button size="sm" variant="outline" data-act="detail" onClick={act("detail")}>{t(a.error ? "card.retry" : "card.details")}</Button>
            : <Button size="sm" data-act="detail" onClick={act("detail")}>{t(a.error ? "card.retry" : "card.lookUp")}</Button>
        )}
        {a.zh && (
          <Button size="sm" variant="outline" data-act="known" onClick={act("known")}>
            {t(isKnown ? "card.unknown" : "card.known")}
          </Button>
        )}
        <Button size="sm" variant="outline" data-act="ask" onClick={act("ask")}>
          <SparkIcon className="spark size-4" data-icon="inline-start" />{t("ask")}
        </Button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ Ask AI button

// Mouse: just above the selection. Touch: docked at the bottom of the screen,
// clear of the system's Copy / Look Up menu.
export function AskFab({ pressedAt }: { pressedAt: React.RefObject<number> }) {
  const t = useT()
  const fab = useApp((s) => s.fab)
  const ref = React.useRef<HTMLButtonElement>(null)
  React.useLayoutEffect(() => {
    if (!fab || !ref.current) return
    if (fab.docked) ref.current.style.left = ref.current.style.top = ""
    else positionNear(ref.current, fab.info.rect, true)
  }, [fab])
  return (
    <button
      id="ask-fab"
      ref={ref}
      type="button"
      hidden={!fab}
      className={cn(
        "ask-fab z-[35] inline-flex items-center gap-1.5 rounded-full bg-primary font-semibold text-primary-foreground shadow-(--elev-float) ring-1 ring-white/10 transition-transform hover:scale-[1.03] active:scale-[.98]",
        fab?.docked
          ? "docked fab-docked fixed bottom-[calc(18px+env(safe-area-inset-bottom))] left-1/2 h-11 -translate-x-1/2 px-6 text-[15px]"
          : "absolute h-[34px] px-3.5 text-[13.5px]",
      )}
      onPointerDown={() => { pressedAt.current = Date.now() }}
      onMouseDown={(e) => e.preventDefault()} // keep the selection
      onClick={() => {
        const info = get().fab?.info
        hideFab()
        // Before the chat input takes focus: cleared after, the selection takes the
        // input's cursor with it on iOS, and the keyboard comes up typing nowhere.
        window.getSelection()?.removeAllRanges()
        if (info) openChat(info.text, info.passage)
      }}
    >
      <SparkIcon className="spark size-4" />
      {t("ask")}
    </button>
  )
}

// ------------------------------------------------------------------ first-run hint

export function Hint() {
  const t = useT()
  const hint = useApp((s) => s.hint)
  if (!hint.shown) return null
  return (
    <div
      id="hint"
      role="status"
      className={cn(
        "hint fixed bottom-[calc(20px+env(safe-area-inset-bottom))] left-1/2 z-[25] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-4 rounded-full bg-primary py-2 pr-2 pl-4.5 text-[13.5px] whitespace-nowrap text-primary-foreground shadow-(--elev-float) [body.chat-open_&]:hidden",
        "max-sm:w-[calc(100vw-32px)] max-sm:gap-3 max-sm:rounded-2xl max-sm:py-2.5 max-sm:pr-2.5 max-sm:pl-3.5 max-sm:whitespace-normal",
        hint.leaving ? "float-out" : "float-in",
      )}
    >
      <span className="hint-text contents max-sm:flex max-sm:min-w-0 max-sm:flex-1 max-sm:flex-col max-sm:gap-1.5">
        <span className="hint-item inline-flex items-center gap-2">
          <Languages className="size-[15px] shrink-0 text-(--mark-gloss)" />
          <span id="hint-word">{t(hint.touch ? "hint.tap" : "hint.click")}</span>
        </span>
        <span className="hint-item inline-flex items-center gap-2">
          <Search className="size-[15px] shrink-0 opacity-80" />
          <span>{t("hint.select")}</span>
        </span>
      </span>
      <button
        id="hint-ok"
        type="button"
        className="hint-ok h-7 shrink-0 rounded-full bg-primary-foreground/15 px-3 font-semibold transition-colors hover:bg-primary-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-sm:h-8"
        onClick={dismissHint}
      >
        {t("hint.ok")}
      </button>
    </div>
  )
}

// While a card is open: a press anywhere else closes it (another gloss opens its own).
export function useCardDismiss() {
  React.useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!get().card) return
      if ((e.target as Element).closest?.("#card, ruby.ann")) return
      closeCard()
    }
    document.addEventListener("pointerdown", down)
    return () => document.removeEventListener("pointerdown", down)
  }, [])
}
