import * as React from "react"
import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronLeft, Copy, History, Square, Trash2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { getLang } from "@/lib/i18n.js"
import { renderMarkdown } from "@/lib/markdown"
import { useApp, get, reduceMotion, type HistoryItem } from "@/app/store"
import { useT } from "@/app/hooks"
import {
  chats, chatUI, closeChat, deleteChat, historyItems, openConversation, resumeChat, sendChat, setHistScope, stopChat,
  toggleSidebarHistory, type Turn,
} from "@/app/chat"
import { answerView } from "@/app/answer-view"
import { SparkIcon } from "@/components/icons"
import { Segmented } from "@/components/segmented"
import { confirmDialog } from "@/components/confirm"
import { Button } from "@/components/ui/button"

// The Ask AI sidebar: a conversation about a selection, or Ask AI history. It
// sits beside the text (on wide screens the text makes room), not over it.
export function ChatPanel() {
  const t = useT()
  const drawer = useApp((s) => s.drawer)
  const mode = useApp((s) => s.chatMode)
  useApp((s) => s.chatRev)
  const chat = chats.drawn
  const current = chats.current
  const ref = React.useRef<HTMLElement>(null)

  // Fit the sidebar above the on-screen keyboard (see useKeyboardFit).
  useKeyboardFit(ref)

  const history = mode === "history"
  return (
    <aside
      id="chat"
      ref={ref}
      hidden={drawer === "closed"}
      data-state={drawer}
      data-mode={mode}
      aria-label={t("chat.title")}
      className="drawer fixed right-0 z-30 flex w-[min(440px,100vw)] flex-col overscroll-contain border-l bg-background shadow-(--elev-float) max-sm:w-screen max-sm:border-l-0 min-[1180px]:shadow-none"
    >
      <header className={cn("drawer-head mb-2 flex h-16 shrink-0 items-center gap-1 border-b border-border/70 pr-3 pl-[18px] max-sm:h-14", history && current && "pl-2")}>
        <Button
          id="chat-back" variant="ghost" size="icon-sm" hidden={!(history && current)} className="head-back text-muted-foreground"
          aria-label={t("chat.back")} title={t("chat.back")} onClick={() => current && openConversation(current)}
        >
          <ChevronLeft />
        </Button>
        <h2 className="chat-title m-0 flex min-w-0 flex-1 items-center gap-2 text-[15px] font-semibold tracking-tight">
          <SparkIcon className="spark size-5" />
          <span id="chat-title-text">{t(history ? "chat.historyTitle" : "chat.title")}</span>
        </h2>
        <div className="head-actions flex items-center gap-0.5">
          <Button
            id="chat-hist-btn" variant="ghost" size="icon-sm" aria-pressed={history} className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground pointer-coarse:size-10"
            aria-label={t("chat.history")} title={t("chat.history")} onClick={toggleSidebarHistory}
          >
            <History />
          </Button>
          <Button id="chat-close" variant="ghost" size="icon-sm" className="text-muted-foreground pointer-coarse:size-10" aria-label={t("btn.close")} title={t("btn.close")} onClick={closeChat}>
            <X />
          </Button>
        </div>
      </header>
      <HistoryList hidden={!history} />
      {chat ? <Conversation hidden={history} /> : (<><div id="chat-log" hidden /><div id="chat-dock" hidden /></>)}
    </aside>
  )
}

// ------------------------------------------------------------------ history

export function fmtWhen(iso: string) {
  const d = new Date(iso)
  const locale = getLang() === "zh" ? "zh-CN" : "en-US"
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
  if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric"
  return d.toLocaleDateString(locale, opts)
}

function HistoryList({ hidden }: { hidden: boolean }) {
  const t = useT()
  const hist = useApp((s) => s.hist)
  const view = useApp((s) => s.view)
  const book = useApp((s) => s.book)
  useApp((s) => s.chatRev)
  const inBook = view === "reader" && book ? book : null
  let items: HistoryItem[] = historyItems(hist.items)
  if (inBook && hist.scope === "book") items = items.filter((c) => c.bookId === String(inBook.id))
  const status = (!items.length && hist.status)
    || (hist.items && !items.length ? t(hist.scope === "book" && inBook ? "chat.histEmptyBook" : "chat.histEmpty") : "")
  const remove = async (id: string) => {
    if (await confirmDialog(t("chat.confirmDelete"), { confirm: t("chat.delete"), destructive: true })) deleteChat(id)
  }
  // By day, the latest first, under quiet headings as in the sidebar.
  const sorted = [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const today = new Date().setHours(0, 0, 0, 0)
  const groups: { key: string; items: HistoryItem[] }[] = []
  for (const c of sorted) {
    const at = c.live ? Date.now() : Date.parse(c.updatedAt)
    const key = at >= today ? "chat.histToday" : at >= today - 6 * 864e5 ? "chat.histWeek" : "chat.histEarlier"
    if (groups.at(-1)?.key !== key) groups.push({ key, items: [] })
    groups.at(-1)!.items.push(c)
  }
  let n = 0
  return (
    <div id="chat-history" hidden={hidden} className="chat-history anim-fade min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-1 pb-6">
      <Segmented
        id="hist-scope" label={t("chat.history")} attr="scope" value={hist.scope} onChange={(v) => setHistScope(v as "book" | "all")}
        className="hist-scope mx-3 mb-4 w-fit" hidden={!inBook || !hist.items}
        options={[{ value: "book", content: t("chat.histBook") }, { value: "all", content: t("chat.histAll") }]}
      />
      <p id="hist-status" role="status" className="hist-status mx-4 my-6 text-center text-sm leading-relaxed text-muted-foreground empty:hidden">{status}</p>
      {!hidden && groups.map((g) => (
        <section key={g.key} className="hist-group mb-4" aria-label={t(g.key)}>
          <h3 className="m-0 mb-1 px-3 text-[12px] font-medium text-muted-foreground">{t(g.key)}</h3>
          <ul className="hist-list m-0 flex list-none flex-col gap-px p-0">
            {g.items.map((c) => {
              const showBook = c.bookTitle && !(inBook && c.bookId === String(inBook.id))
              const meta = [showBook ? c.bookTitle : "", c.questions === 1 ? t("chat.question1") : t("chat.questions", { n: c.questions }), c.live ? "" : fmtWhen(c.updatedAt)].filter(Boolean)
              const i = n++
              return (
                <li key={c.id} className="hist-item group/hist anim-rise relative" style={{ animationDelay: `${Math.min(i, 3) * 30}ms` }}>
                  <button
                    type="button"
                    className="hist-open flex w-full flex-col gap-0.5 rounded-lg py-2 pr-11 pl-3 text-left transition-colors duration-150 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/35"
                    data-id={c.id}
                    onClick={() => resumeChat(c.id)}
                  >
                    <span className="hist-q w-full truncate text-[14px] text-foreground empty:hidden">{c.question || ""}</span>
                    <span className="hist-quote line-clamp-2 border-l-2 border-(--thread)/50 pl-2 text-[13px] leading-snug text-ink-2">{c.selection}</span>
                    <span className="hist-meta mt-0.5 w-full truncate text-[12px] text-muted-foreground">
                      {meta.map((m, j) => <React.Fragment key={j}>{j > 0 && <span aria-hidden="true"> · </span>}{m}</React.Fragment>)}
                      {c.live && <>{meta.length > 0 && <span aria-hidden="true"> · </span>}<span className="hist-live font-medium text-brand">{t("chat.answering")}</span></>}
                    </span>
                  </button>
                  <Button
                    variant="ghost" size="icon-sm"
                    className="hist-del absolute top-1.5 right-1.5 text-muted-foreground opacity-0 transition-opacity group-hover/hist:opacity-100 hover:text-destructive focus-visible:opacity-100 pointer-coarse:opacity-100"
                    data-del={c.id} aria-label={t("chat.delete")} title={t("chat.delete")} onClick={() => remove(c.id)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ conversation

function Conversation({ hidden }: { hidden: boolean }) {
  const t = useT()
  const view = useApp((s) => s.view)
  const book = useApp((s) => s.book)
  const chat = chats.drawn!
  const log = React.useRef<HTMLDivElement>(null)
  const input = React.useRef<HTMLTextAreaElement>(null)
  const quote = React.useRef<HTMLQuoteElement>(null)
  const [text, setText] = React.useState("")
  const [quoteState, setQuoteState] = React.useState<"" | "clamped" | "open">("")
  const [below, setBelow] = React.useState(false)
  const busy = !!chat.ctl
  const started = chat.messages.length > 0 || chat.turns.length > 0
  const here = view === "reader" && String(book?.id) === chat.bookId

  const updateJump = React.useCallback(() => {
    const l = log.current
    const last = l?.querySelector("#chat-turns")?.lastElementChild?.lastElementChild
    const gap = last && l ? last.getBoundingClientRect().bottom - l.getBoundingClientRect().bottom : 0
    setBelow(gap > 24)
  }, [])

  // The textarea grows with what is typed, up to about six lines.
  const fit = React.useCallback(() => {
    const el = input.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`
  }, [])

  React.useEffect(() => {
    chatUI.updateJump = updateJump
  }, [updateJump])

  // Drawn afresh (a new or another conversation): back to its start, or its end.
  React.useLayoutEffect(() => {
    setText("")
    if (input.current) { input.current.value = ""; fit() }
    if (log.current) log.current.scrollTop = chat.messages.length ? log.current.scrollHeight : 0
    setQuoteState("")
    requestAnimationFrame(() => {
      const q = quote.current
      if (q && q.scrollHeight > q.clientHeight + 2) setQuoteState("clamped")
      updateJump()
    })
  }, [chat, chat.draws, fit, updateJump])

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (chat.ctl) { stopChat(); return }
    const q = input.current?.value || ""
    if (!q.trim()) return
    sendChat(q)
    if (input.current) input.current.value = ""
    setText("")
    fit()
  }

  const chips: string[] = (t("chat.chips") as string[]).filter((c) => !(started && chat.asked.has(c)))
  const chipList = chips.length > 0 && (
    <div
      id="chat-chips"
      className={cn(
        "chips",
        started
          ? "follow no-scrollbar flex gap-1.5 overflow-x-auto px-0.5 pb-2.5 [mask-image:linear-gradient(90deg,#000_calc(100%-24px),transparent)]"
          : "start mb-2 flex flex-col gap-2",
      )}
    >
      {chips.map((c) => (
        <button
          key={c}
          type="button"
          className={cn(
            "chip outline-none focus-visible:ring-3 focus-visible:ring-ring/35",
            started
              ? "h-[30px] shrink-0 rounded-full border bg-card px-3 text-[12.5px] whitespace-nowrap text-ink-2 transition-colors hover:bg-accent hover:text-foreground pointer-coarse:h-[34px]"
              : "group/chip anim-rise flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border bg-card px-3.5 py-2.5 text-left text-sm text-ink-2 shadow-xs transition-colors duration-150 hover:border-input hover:bg-accent/60 hover:text-foreground",
          )}
          onClick={() => sendChat(c)}
        >
          <span>{c}</span>
          {!started && <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/chip:translate-x-0.5 group-hover/chip:text-foreground" />}
        </button>
      ))}
    </div>
  )

  return (
    <>
      <div
        id="chat-log"
        ref={log}
        hidden={hidden}
        onScroll={updateJump}
        className="chat-log min-h-0 flex-1 overflow-y-auto overscroll-contain px-[18px] pt-1 pb-6 [scrollbar-gutter:stable] max-sm:px-4"
      >
        <figure className="chat-context m-0 mb-[18px]">
          <figcaption className="mb-1.5 flex min-w-0 items-baseline gap-1.5 text-[11.5px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
            <span>{t("chat.context")}</span>
            {chat.bookId && chat.bookTitle && !here && (
              <a
                id="chat-book"
                href={`#/read/${encodeURIComponent(chat.bookId)}`}
                className="chat-book min-w-0 truncate text-xs font-medium tracking-normal text-muted-foreground normal-case no-underline before:mr-1.5 before:content-['·'] hover:text-foreground hover:underline"
              >
                {chat.bookTitle}
              </a>
            )}
          </figcaption>
          <blockquote
            id="chat-quote"
            ref={quote}
            className={cn(
              "quote relative m-0 rounded-xl border-y-[12px] border-transparent bg-sunken pr-3.5 pl-4 font-reading text-[15.5px] leading-[1.6] text-foreground",
              "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:rounded-r-[3px] before:bg-brand before:content-['']",
              quoteState && "cursor-pointer", quoteState,
            )}
            onClick={() => { if (quoteState) setQuoteState(quoteState === "open" ? "clamped" : "open") }}
          >
            {chat.selection}
          </blockquote>
        </figure>
        {chat.resume && !started && (
          <button
            id="chat-resume"
            type="button"
            className="chat-resume anim-rise -mt-1.5 mb-3.5 flex w-full items-center gap-2.5 rounded-xl border border-dashed border-input px-3.5 py-2.5 text-left text-[13.5px] text-ink-2 transition-colors hover:border-solid hover:bg-accent hover:text-foreground"
            onClick={() => resumeChat(chat.resume!.id)}
          >
            <History className="size-[17px] shrink-0 text-muted-foreground" />
            <span>{chat.resume.questions === 1 ? t("chat.resume1") : t("chat.resume", { n: chat.resume.questions })}</span>
          </button>
        )}
        {!started && chipList}
        <div id="chat-turns" aria-live="polite" aria-busy={busy || undefined}>
          {chat.turns.map((turn, i) => <TurnView key={turn.key} turn={turn} first={i === 0} log={log} />)}
        </div>
      </div>

      <div
        id="chat-dock"
        hidden={hidden}
        className={cn(
          "chat-dock relative shrink-0 bg-background px-4 pt-2.5 pb-3 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-5 before:bg-linear-to-b before:from-transparent before:to-background before:content-[''] max-sm:pb-[calc(12px+env(safe-area-inset-bottom))]",
          started && "started",
        )}
      >
        <button
          id="chat-jump"
          type="button"
          hidden={!below}
          aria-label={t("chat.jump")}
          className="chat-jump anim-rise absolute bottom-[calc(100%+10px)] left-1/2 z-[1] grid size-[34px] -translate-x-1/2 place-items-center rounded-full border bg-card text-ink-2 shadow-(--elev-soft)"
          onClick={() => {
            const l = log.current
            const last = l?.querySelector("#chat-turns")?.lastElementChild?.lastElementChild
            if (!l || !last) return
            const by = last.getBoundingClientRect().bottom - l.getBoundingClientRect().bottom + 24
            l.scrollBy({ top: by, behavior: reduceMotion() ? "auto" : "smooth" })
          }}
        >
          <ArrowDown className="size-4" />
        </button>
        {started && chipList}
        <form
          id="chat-form"
          className="chat-form flex items-end gap-2 rounded-[22px] border border-input bg-card py-1.5 pr-1.5 pl-3.5 shadow-(--elev-soft) transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/15"
          onSubmit={submit}
        >
          <textarea
            id="chat-input"
            ref={input}
            name="question"
            rows={1}
            autoComplete="off"
            enterKeyHint="send"
            aria-label={t("chat.inputLabel")}
            placeholder={t(started ? "chat.followup" : "chat.placeholder")}
            className="max-h-[150px] min-h-8 flex-1 resize-none border-0 bg-transparent py-1.5 text-[15px] leading-5 outline-none placeholder:text-muted-foreground pointer-coarse:text-base"
            onChange={(e) => { setText(e.target.value); fit() }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <button
            id="chat-send"
            type="submit"
            disabled={busy ? false : !text.trim()}
            aria-label={t(busy ? "chat.stop" : "chat.send")}
            className={cn(
              "send-btn grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-[opacity,transform] outline-none focus-visible:ring-3 focus-visible:ring-ring/35 enabled:hover:scale-105 disabled:opacity-20",
              busy && "busy",
            )}
          >
            {busy ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-[18px]" strokeWidth={2.2} />}
          </button>
        </form>
        <p className="chat-note mt-1.5 mb-0 text-center text-[11.5px] text-muted-foreground pointer-coarse:hidden">{t("chat.note")}</p>
      </div>
    </>
  )
}

// One question and its answer.
function TurnView({ turn, first, log }: { turn: Turn; first: boolean; log: React.RefObject<HTMLDivElement | null> }) {
  const t = useT()
  const ref = React.useRef<HTMLElement>(null)
  // A new question goes to the top of the log, with room below for the answer,
  // so the answer is read as it arrives instead of chasing the bottom.
  React.useLayoutEffect(() => {
    const el = ref.current
    const l = log.current
    if (!el || !l) return
    if (!turn.fresh || first) {
      el.style.minHeight = ""
      return
    }
    el.style.minHeight = `${l.clientHeight - 32}px`
    l.scrollTo({ top: el.offsetTop - 16, behavior: reduceMotion() ? "auto" : "smooth" })
  }, [turn.fresh, first, log])

  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turn.answer)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <section ref={ref} className="turn flex flex-col gap-3.5 pt-1.5 [&+.turn]:mt-[26px]">
      {turn.question && (
        <div className="msg user anim-pop max-w-[85%] self-end rounded-[18px_18px_6px_18px] bg-brand-soft px-3.5 py-[9px] text-[15px] leading-[1.55] whitespace-pre-wrap text-foreground [overflow-wrap:break-word]">
          {turn.question}
        </div>
      )}
      {(turn.pending || turn.answer) && <AnswerBubble turn={turn} />}
      {turn.error && (
        <div className="msg error anim-rise rounded-xl border border-destructive/25 bg-destructive/[.07] px-3.5 py-2.5 text-sm leading-[1.55] text-destructive">
          {turn.error}
        </div>
      )}
      {!turn.pending && turn.answer && (
        <div className="msg-actions anim-fade -mt-1.5 -ml-2 flex gap-1">
          <button
            type="button"
            className="msg-act inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={copy}
          >
            {copied ? <Check className="size-[15px]" /> : <Copy className="size-[15px]" />}
            <span>{t(copied ? "chat.copied" : "chat.copy")}</span>
          </button>
        </div>
      )}
    </section>
  )
}

// An answer: revealed as it streams in (answerView), or drawn whole once done.
function AnswerBubble({ turn }: { turn: Turn }) {
  const t = useT()
  const body = React.useRef<HTMLDivElement>(null)
  const pending = turn.pending
  React.useLayoutEffect(() => {
    const el = body.current!
    if (!pending) {
      el.classList.remove("waiting")
      el.innerHTML = turn.answer ? `<div class="blk">${renderMarkdown(turn.answer)}</div>` : ""
      return
    }
    el.innerHTML = ""
    const view = answerView(el, () => chatUI.updateJump())
    // Back to an answer still arriving: what came meanwhile shows at once.
    if (turn.answer) { view.push(turn.answer); view.flush() }
    turn.view = view
    return () => { if (turn.view === view) turn.view = null }
  }, [turn, pending])
  return (
    <div className={cn("msg assistant min-h-[1.7em] max-w-full text-[15px] leading-[1.7] text-ink-2 [overflow-wrap:break-word]", pending && "pending")}>
      {pending && !turn.answer && (
        <span className="thinking inline-flex items-center gap-2 text-sm">
          <SparkIcon className="spark size-4" />
          <span className="shimmer text-muted-foreground [--shimmer-color:var(--foreground)]">{t("chat.thinking")}…</span>
        </span>
      )}
      <div ref={body} className="msg-body" />
    </div>
  )
}

// iPhone and iPad keep the page its full height under the on-screen keyboard
// and slide what's on screen up to show the input, which carries the top of the
// sidebar (its title, the quote) and the text beside it off the screen. While
// the keyboard is up, fit the sidebar to the part of the screen above it (the
// conversation gets shorter), and slide the page back to where it was.
// keepPage: undo Safari's slides until the person scrolls something themselves.
function useKeyboardFit(ref: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    let keepPage = false
    const fit = (e?: Event) => {
      const drawer = ref.current
      const vv = window.visualViewport
      if (!drawer) return
      const input = document.getElementById("chat-input")
      if (e?.type === "focusin" && e.target === input) keepPage = true
      if (vv && document.activeElement === input && Math.abs(vv.scale - 1) < 0.01) {
        if (keepPage && vv.offsetTop > 0) window.scrollBy(0, -vv.offsetTop)
        drawer.style.setProperty("--vv-top", `${vv.offsetTop}px`)
        drawer.style.setProperty("--vv-height", `${vv.height}px`)
      } else {
        drawer.style.removeProperty("--vv-top")
        drawer.style.removeProperty("--vv-height")
      }
    }
    const focus = (e: FocusEvent) => { if ((e.target as Element)?.id === "chat-input") fit(e) }
    const stop = () => { keepPage = false }
    document.addEventListener("focusin", focus)
    document.addEventListener("focusout", focus)
    window.visualViewport?.addEventListener("resize", fit)
    window.visualViewport?.addEventListener("scroll", fit)
    // Safari can report where the visible part went only after the page has
    // finished scrolling, with no event of the visual viewport's own.
    window.addEventListener("scroll", fit, { passive: true })
    document.addEventListener("touchmove", stop, { passive: true, capture: true })
    return () => {
      document.removeEventListener("focusin", focus)
      document.removeEventListener("focusout", focus)
      window.visualViewport?.removeEventListener("resize", fit)
      window.visualViewport?.removeEventListener("scroll", fit)
      window.removeEventListener("scroll", fit)
      document.removeEventListener("touchmove", stop, { capture: true })
    }
  }, [ref])
}

// A press on a blank part of the page outside the sidebar closes it: the
// margins, between paragraphs, the header. A press on the text leaves it open,
// so the reader can select more to ask about, or look a word up. So do the
// word card, the Ask AI button, the history button, notices, and the menus
// and dialogs above it.
export function useChatDismiss() {
  React.useEffect(() => {
    const down = (e: PointerEvent) => {
      if (get().drawer !== "open" || e.button > 0) return
      const target = e.target as Element
      if (onText(target)) return
      if (target.closest?.("#chat, #card, #ask-fab, #btn-history, #rail-chats,#toast, [data-sonner-toaster], [data-radix-popper-content-wrapper], [data-slot=dialog-content], [data-slot=alert-dialog-content], [data-slot=dialog-overlay], [data-slot=alert-dialog-overlay], #banner")) return
      closeChat()
    }
    document.addEventListener("pointerdown", down)
    return () => document.removeEventListener("pointerdown", down)
  }, [])
}

// Whether a press on `target` is on the article's text. The article's blank
// parts (its margins, the space between paragraphs) are the article element
// itself; everything in it is text, but for pictures and rules.
function onText(target: Element) {
  const article = target.closest?.("#article")
  return !!article && target !== article && !target.closest("img, hr")
}
