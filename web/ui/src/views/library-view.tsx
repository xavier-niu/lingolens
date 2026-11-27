import { Bookmark, Check, Clock3, LayoutGrid, List, Plus, Search, Sparkles, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { isFinished, minutesLeft, tintFor } from "@/lib/library.js"
import { useApp, set, getLevel, type Book } from "@/app/store"
import { useT } from "@/app/hooks"
import { addSampleBook, deleteBook } from "@/app/session"
import { bookStat, daysLeft, expiryText, isExpired, isReadLater, openSource, shelfBooks, showShelf, toggleReadLater } from "@/app/books"
import { confirmDialog } from "@/components/confirm"
import { Segmented } from "@/components/segmented"
import { fmtWhen } from "@/components/chat-panel"
import { Button } from "@/components/ui/button"

function setShelfView(shelfView: "grid" | "list") {
  try { localStorage.setItem("lingolens.shelfView", shelfView) } catch { /* private mode */ }
  set({ shelfView })
}

export function LibraryView() {
  const t = useT()
  const view = useApp((s) => s.view)
  const all = useApp((s) => s.books)
  const loaded = useApp((s) => s.booksLoaded)
  const shelfView = useApp((s) => s.shelfView)
  const filter = useApp((s) => s.shelfFilter)
  const query = useApp((s) => s.shelfQuery)
  useApp((s) => s.prefs.level)
  const books = all.filter((b) => !isExpired(b)) // the server deletes them; offline, hide them
  const level = getLevel()
  const left = books.reduce((sum, b) => sum + minutesLeft(b, level), 0)
  let summary = ""
  if (books.length && left === 0) summary = t("shelf.summaryDone")
  else if (books.length === 1) summary = t("shelf.summaryOne", { m: left, level })
  else if (books.length > 1) summary = t("shelf.summary", { n: books.length, m: left, level })
  // A filter or a search: the texts it finds, under the filter's name.
  const shown = shelfBooks(books, filter, query)
  const narrowed = filter !== "all" || !!query.trim()
  if (filter !== "all") summary = shown.length === 1 ? t("shelf.countOne") : t("shelf.count", { n: shown.length })

  return (
    <section id="library-view" hidden={view !== "library"} className="library mx-auto mt-14 max-w-[1080px] max-sm:mt-8">
      <div className="shelf-head mb-9 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 max-sm:mb-6" hidden={books.length === 0}>
        <div className="min-w-0">
          <h1 id="shelf-title" className="m-0 text-[clamp(26px,3.4vw,32px)] leading-tight font-semibold tracking-[-0.025em]">{t(filter === "all" ? "shelf.title" : `filter.${filter}`)}</h1>
          <p id="shelf-summary" className="shelf-summary mt-1.5 mb-0 text-[15px] text-muted-foreground tabular-nums">{summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 max-sm:w-full">
          <label className="relative max-sm:min-w-0 max-sm:flex-1">
            <span className="sr-only">{t("shelf.search")}</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.8} aria-hidden="true" />
            <input
              id="shelf-search"
              type="search"
              value={query}
              placeholder={t("shelf.search")}
              autoComplete="off"
              onChange={(e) => set({ shelfQuery: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); set({ shelfQuery: "" }) } }}
              className="h-9 w-56 rounded-full border border-input bg-card pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15 max-sm:w-full"
            />
          </label>
          <Segmented
            id="shelf-view" label={t("shelf.view")} attr="view" value={shelfView} onChange={(v) => setShelfView(v as "grid" | "list")}
            buttonClassName="h-7 w-8 px-0 [&_svg]:size-4"
            options={[
              { value: "grid", label: t("shelf.grid"), content: <LayoutGrid strokeWidth={1.8} /> },
              { value: "list", label: t("shelf.list"), content: <List strokeWidth={1.8} /> },
            ]}
          />
          <Button id="btn-add" className="h-9 rounded-full pr-4 pl-3.5" onClick={openSource}>
            <Plus data-icon="inline-start" strokeWidth={2.2} />{t("shelf.add")}
          </Button>
        </div>
      </div>

      {narrowed && books.length > 0 && shown.length === 0 && (
        <div id="shelf-none" className="mx-auto max-w-[420px] py-16 text-center">
          <p className="m-0 text-[15px] text-muted-foreground">{t(query.trim() ? "shelf.noMatch" : `filter.${filter}Empty`)}</p>
          <Button variant="outline" className="mt-5 h-9 rounded-full px-4" onClick={() => { set({ shelfQuery: "" }); showShelf("all") }}>{t("shelf.showAll")}</Button>
        </div>
      )}

      {shelfView === "list" && shown.length > 0
        ? <BookTable books={shown} level={level} />
        : (
          <div id="shelf" className="shelf grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-5 max-sm:grid-cols-2 max-sm:gap-3">
            {shown.map((b) => <BookCard key={b.id} book={b} level={level} />)}
          </div>
        )}

      <div id="shelf-empty" hidden={books.length > 0 || !loaded} className="shelf-empty mx-auto max-w-[460px] pt-16 pb-6 text-center">
        <div className="empty-art relative mx-auto h-[132px] w-[156px]" aria-hidden="true">
          <span className="cover absolute top-5 left-0 aspect-[4/5] w-[86px] -rotate-8 rounded-2xl shadow-xs ring-1 ring-black/5" data-tint="0" />
          <span className="cover absolute top-5 right-0 aspect-[4/5] w-[86px] rotate-8 rounded-2xl shadow-xs ring-1 ring-black/5" data-tint="3" />
          <span className="absolute top-0 left-[35px] grid aspect-[4/5] w-[86px] place-items-center rounded-2xl bg-card shadow-(--elev-soft) ring-1 ring-border">
            <span className="flex w-12 flex-col gap-1.5">
              <span className="h-1 w-6 rounded-full bg-gloss/80" />
              <span className="h-2 w-12 rounded-full bg-foreground/15" />
              <span className="h-2 w-9 rounded-full bg-foreground/10" />
            </span>
          </span>
        </div>
        <h2 className="mt-8 mb-2 text-[22px] font-semibold tracking-[-0.02em]">{t("shelf.emptyTitle")}</h2>
        <p className="m-0 text-[15px] text-muted-foreground">{t("shelf.emptyBody")}</p>
        <div className="mt-7 flex flex-wrap justify-center gap-2.5">
          <Button id="btn-add-empty" className="h-10 rounded-full pr-4.5 pl-4" onClick={openSource}>
            <Plus data-icon="inline-start" strokeWidth={2.2} />{t("shelf.add")}
          </Button>
          <Button id="btn-sample-empty" variant="outline" className="h-10 rounded-full pr-4.5 pl-4" onClick={addSampleBook}>
            <Sparkles data-icon="inline-start" />{t("shelf.sample")}
          </Button>
        </div>
      </div>
    </section>
  )
}

// A card: a generated cover (a soft tint, the title in serif type), then how
// long is left. The whole card opens the text; the bin deletes it.
function BookCard({ book: b, level }: { book: Book; level: string }) {
  const t = useT()
  const p = Math.floor((b.progress || 0) * 100)
  const done = isFinished(b)
  const remove = async () => {
    if (await confirmDialog(t("book.confirmDelete", { t: b.title }), { confirm: t("book.delete"), destructive: true })) deleteBook(b.id)
  }
  return (
    <article className="book group/book relative flex min-w-0 flex-col overflow-hidden rounded-2xl bg-card shadow-xs ring-1 ring-border transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-(--elev-soft) pointer-coarse:hover:translate-y-0 has-[.book-link:focus-visible]:ring-2 has-[.book-link:focus-visible]:ring-ring/60">
      <a
        className="book-link block no-underline outline-none after:absolute after:inset-0 after:z-[1] after:content-['']"
        href={`#/read/${encodeURIComponent(b.id)}`}
      >
        <div
          className="cover relative flex aspect-[16/11] flex-col justify-between gap-3 px-4 pt-3.5 pb-4 max-sm:aspect-[4/5] max-sm:px-3 max-sm:pt-3 max-sm:pb-3.5"
          data-tint={tintFor(b.id)}
        >
          <span className="cover-top flex items-center justify-between gap-2">
            <span className="cover-words text-[11.5px] font-semibold tabular-nums opacity-70" aria-hidden="true">{t("book.words", { n: b.words.toLocaleString() })}</span>
            {b.expiresAt && (
              <span className="cover-ttl inline-flex items-center gap-[3px] rounded-full bg-white/55 px-1.5 py-px text-[11px] font-semibold whitespace-nowrap tabular-nums dark:bg-black/25" title={expiryText(b)}>
                <Clock3 className="size-3" strokeWidth={2.2} />
                {t("book.ttlShort", { n: daysLeft(b) })}
                <span className="sr-only">, {expiryText(b)}</span>
              </span>
            )}
          </span>
          <span className="cover-title line-clamp-3 font-serif text-[20px] leading-[1.2] font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] max-sm:line-clamp-5 max-sm:text-[16.5px]">{b.title}</span>
        </div>
      </a>
      <div className="book-meta flex min-h-10 items-center gap-1.5 border-t border-border/70 py-1 pr-1.5 pl-4 max-sm:pl-3">
        <span className={cn("book-stat min-w-0 flex-1 truncate text-[13px] text-muted-foreground tabular-nums", done && "done font-medium text-success before:content-['✓_']")}>
          {bookStat(b, level)}
        </span>
        {/* Delete (on hover) to the left, so the bookmark keeps the corner. */}
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            className="book-del relative z-[2] inline-grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-[opacity,color,background-color] group-focus-within/book:opacity-100 group-hover/book:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/35 focus-visible:outline-none pointer-coarse:opacity-100"
            data-del-book={b.id}
            aria-label={`${t("book.delete")}: ${b.title}`}
            title={t("book.delete")}
            onClick={remove}
          >
            <Trash2 className="size-[15px]" strokeWidth={1.8} />
          </button>
          <LaterButton book={b} small />
        </span>
      </div>
      {p > 0 && !done && (
        <div className="book-bar absolute inset-x-0 bottom-0 h-[3px] bg-transparent" aria-hidden="true">
          <div className="h-full rounded-r-full bg-(--thread)" style={{ width: `${p}%` }} />
        </div>
      )}
    </article>
  )
}

// The list: a row a text, for a long shelf. Narrower screens drop the columns
// that matter least.
function BookTable({ books, level }: { books: Book[]; level: string }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const locale = lang === "zh" ? "zh-CN" : "en"
  const th = "py-2.5 pr-4 text-[12px] font-medium whitespace-nowrap text-muted-foreground"
  return (
    <div id="shelf-list" className="shelf-list overflow-hidden rounded-2xl bg-card shadow-xs ring-1 ring-border">
      <table className="w-full border-collapse text-[13.5px]">
        <thead>
          <tr className="border-b border-border/70 text-left">
            <th scope="col" className={cn(th, "pl-4")}>{t("shelf.colTitle")}</th>
            <th scope="col" className={cn(th, "text-right max-sm:hidden")}>{t("shelf.colWords")}</th>
            <th scope="col" className={th}>{t("shelf.colProgress")}</th>
            <th scope="col" className={cn(th, "text-right max-xl:hidden")}>{t("shelf.colLeft")}</th>
            <th scope="col" className={cn(th, "max-sm:hidden")}>{t("shelf.colUpdated")}</th>
            <th scope="col" className="w-[84px] p-0"><span className="sr-only">{t("shelf.colActions")}</span></th>
          </tr>
        </thead>
        <tbody>
          {books.map((b) => {
            const p = Math.floor((b.progress || 0) * 100)
            const done = isFinished(b)
            const remove = async () => {
              if (await confirmDialog(t("book.confirmDelete", { t: b.title }), { confirm: t("book.delete"), destructive: true })) deleteBook(b.id)
            }
            const td = "py-2 pr-4 whitespace-nowrap text-muted-foreground tabular-nums"
            return (
              <tr key={b.id} data-book={b.id} className="book-row group/row relative border-b border-border/70 transition-colors last:border-0 hover:bg-accent/50 has-[.book-link:focus-visible]:bg-accent/50">
                <td className="w-full max-w-0 py-2 pr-4 pl-4">
                  <a
                    className="book-link flex min-w-0 items-center gap-3 font-medium text-foreground no-underline outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
                    href={`#/read/${encodeURIComponent(b.id)}`}
                  >
                    <span className="cover h-5 w-4 shrink-0 rounded-[4px] ring-1 ring-black/5" data-tint={tintFor(b.id)} aria-hidden="true" />
                    <span className="truncate">{b.title}</span>
                    {b.expiresAt && (
                      <span className="inline-flex shrink-0 items-center gap-[3px] text-[12px] font-normal text-muted-foreground tabular-nums" title={expiryText(b)}>
                        <Clock3 className="size-3" strokeWidth={2.2} />{t("book.ttlShort", { n: daysLeft(b) })}
                        <span className="sr-only">, {expiryText(b)}</span>
                      </span>
                    )}
                  </a>
                </td>
                <td className={cn(td, "text-right max-sm:hidden")}>{b.words.toLocaleString(locale)}</td>
                <td className={td} title={bookStat(b, level)}>
                  {done
                    ? <span className="inline-flex items-center gap-1 font-medium text-success"><Check className="size-3.5" strokeWidth={2.4} />{t("book.finished")}</span>
                    : (
                      <span className="inline-flex items-center gap-2.5">
                        <span className="h-1 w-14 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                          <span className="block h-full rounded-full bg-(--thread)" style={{ width: `${p}%` }} />
                        </span>
                        <span className="book-progress w-8 text-right">{p}%</span>
                      </span>
                    )}
                </td>
                <td className={cn(td, "text-right max-xl:hidden")}>{done ? "—" : t("rail.minutes", { m: minutesLeft(b, level) })}</td>
                <td className={cn(td, "max-sm:hidden")}>{b.updatedAt ? fmtWhen(b.updatedAt) : "—"}</td>
                <td className="py-1 pr-1.5 text-right whitespace-nowrap">
                  <LaterButton book={b} />
                  <button
                    type="button"
                    className="book-del relative z-[2] inline-grid size-8 place-items-center rounded-lg text-muted-foreground opacity-0 transition-[opacity,color,background-color] group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/35 focus-visible:outline-none pointer-coarse:opacity-100"
                    data-del-book={b.id}
                    aria-label={`${t("book.delete")}: ${b.title}`}
                    title={t("book.delete")}
                    onClick={remove}
                  >
                    <Trash2 className="size-4" strokeWidth={1.8} />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Read later, on a card or a row: always in sight (unlike delete), filled
// once marked.
function LaterButton({ book: b, small = false }: { book: Book; small?: boolean }) {
  const t = useT()
  const on = isReadLater(b)
  const label = t(on ? "later.remove" : "later.add")
  return (
    <button
      type="button"
      className={cn(
        "book-later relative z-[2] inline-grid shrink-0 place-items-center text-muted-foreground/70 transition-[color,background-color] hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/35 focus-visible:outline-none",
        small ? "size-7 rounded-md" : "size-8 rounded-lg",
        on && "text-brand hover:text-brand",
      )}
      data-later={b.id}
      aria-pressed={on}
      aria-label={`${label}: ${b.title}`}
      title={label}
      onClick={() => toggleReadLater(b)}
    >
      <Bookmark className={cn(small ? "size-[15px]" : "size-4", on && "fill-current")} strokeWidth={1.8} />
    </button>
  )
}
