import { Clock3, Plus, Sparkles, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { isFinished, minutesLeft, tintFor } from "@/lib/library.js"
import { useApp, set, getLevel, type Book } from "@/app/store"
import { useT } from "@/app/hooks"
import { addSampleBook, deleteBook } from "@/app/session"
import { bookStat, daysLeft, expiryText, isExpired } from "@/app/books"
import { confirmDialog } from "@/components/confirm"
import { Button } from "@/components/ui/button"

const openSource = () => set((s) => ({ source: { book: null, append: false, seq: (s.source?.seq ?? 0) + 1 } }))

export function LibraryView() {
  const t = useT()
  const view = useApp((s) => s.view)
  const all = useApp((s) => s.books)
  const loaded = useApp((s) => s.booksLoaded)
  useApp((s) => s.prefs.level)
  const books = all.filter((b) => !isExpired(b)) // the server deletes them; offline, hide them
  const level = getLevel()
  const left = books.reduce((sum, b) => sum + minutesLeft(b, level), 0)
  let summary = ""
  if (books.length && left === 0) summary = t("shelf.summaryDone")
  else if (books.length === 1) summary = t("shelf.summaryOne", { m: left, level })
  else if (books.length > 1) summary = t("shelf.summary", { n: books.length, m: left, level })

  return (
    <section id="library-view" hidden={view !== "library"} className="library mx-auto mt-12 max-w-[1040px] max-sm:mt-7">
      <div className="shelf-head mb-8 flex flex-wrap items-end justify-between gap-4" hidden={books.length === 0}>
        <div>
          <h1 className="m-0 font-serif text-[clamp(28px,3.6vw,36px)] leading-tight font-semibold tracking-tight">{t("shelf.title")}</h1>
          <p id="shelf-summary" className="shelf-summary mt-1.5 mb-0 text-muted-foreground tabular-nums">{summary}</p>
        </div>
        <Button id="btn-add" size="lg" className="h-10 px-4" onClick={openSource}>
          <Plus data-icon="inline-start" />{t("shelf.add")}
        </Button>
      </div>

      <div id="shelf" className="shelf grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-6 gap-y-9 max-sm:grid-cols-2 max-sm:gap-x-3.5 max-sm:gap-y-7">
        {books.map((b) => <BookCard key={b.id} book={b} level={level} />)}
      </div>

      <div id="shelf-empty" hidden={books.length > 0 || !loaded} className="shelf-empty mx-auto max-w-[440px] pt-14 pb-6 text-center">
        <div className="empty-art relative mx-auto h-[130px] w-[140px]" aria-hidden="true">
          <span className="absolute top-4 left-0.5 aspect-[4/5] w-[84px] -rotate-9 rounded-xl border bg-[color-mix(in_srgb,var(--phrase)_10%,var(--card))] shadow-xs" />
          <span className="absolute top-4 right-0.5 aspect-[4/5] w-[84px] rotate-9 rounded-xl border bg-[color-mix(in_srgb,var(--gloss)_10%,var(--card))] shadow-xs" />
          <span className="absolute top-0 left-7 grid aspect-[4/5] w-[84px] place-items-center rounded-xl border bg-card shadow-(--shadow-soft)">
            <span className="flex w-12 flex-col gap-1.5">
              <span className="h-1 w-6 rounded-full bg-gloss/70" />
              <span className="h-2 w-12 rounded-full bg-foreground/15" />
              <span className="h-2 w-9 rounded-full bg-foreground/10" />
            </span>
          </span>
        </div>
        <h2 className="mt-7 mb-1.5 font-serif text-[22px] font-semibold tracking-tight">{t("shelf.emptyTitle")}</h2>
        <p className="m-0 text-muted-foreground">{t("shelf.emptyBody")}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2.5">
          <Button id="btn-add-empty" size="lg" className="h-10 px-4" onClick={openSource}>
            <Plus data-icon="inline-start" />{t("shelf.add")}
          </Button>
          <Button id="btn-sample-empty" size="lg" variant="outline" className="h-10 px-4" onClick={addSampleBook}>
            <Sparkles data-icon="inline-start" />{t("shelf.sample")}
          </Button>
        </div>
      </div>
    </section>
  )
}

// A generated cover: a soft tint and the title in serif type.
function BookCard({ book: b, level }: { book: Book; level: string }) {
  const t = useT()
  const p = Math.floor((b.progress || 0) * 100)
  const done = isFinished(b)
  const remove = async () => {
    if (await confirmDialog(t("book.confirmDelete", { t: b.title }), { confirm: t("book.delete"), destructive: true })) deleteBook(b.id)
  }
  return (
    <article className="book group/book relative min-w-0">
      <a className="book-link block rounded-xl no-underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-4 focus-visible:ring-offset-background" href={`#/read/${encodeURIComponent(b.id)}`}>
        <div
          className="cover relative flex aspect-[4/5] flex-col justify-between gap-3 overflow-hidden rounded-xl border border-(--tint-line) bg-(--tint-bg) px-4 pt-4 pb-[18px] text-(--tint-fg) transition-[transform,box-shadow] duration-200 group-hover/book:-translate-y-0.5 group-hover/book:shadow-(--shadow-soft) pointer-coarse:group-hover/book:translate-y-0 pointer-coarse:group-hover/book:shadow-none max-sm:px-3 max-sm:pt-3 max-sm:pb-3.5"
          data-tint={tintFor(b.id)}
        >
          {/* The spine: a soft fold down the left edge. */}
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-2.5 bg-linear-to-r from-black/[.06] to-transparent dark:from-black/25" />
          <span className="cover-top flex items-center justify-between gap-2">
            <span className="cover-words text-[11.5px] font-semibold tabular-nums opacity-65" aria-hidden="true">{t("book.words", { n: b.words.toLocaleString() })}</span>
            {b.expiresAt && (
              <span className="cover-ttl inline-flex items-center gap-[3px] text-[11.5px] font-semibold whitespace-nowrap tabular-nums opacity-80" title={expiryText(b)}>
                <Clock3 className="size-3" strokeWidth={2.2} />
                {t("book.ttlShort", { n: daysLeft(b) })}
                <span className="sr-only">, {expiryText(b)}</span>
              </span>
            )}
          </span>
          <span className="cover-title line-clamp-5 font-serif text-[19px] leading-[1.2] font-semibold tracking-tight [overflow-wrap:anywhere] max-sm:text-base">{b.title}</span>
        </div>
      </a>
      <div className="book-meta mt-2 flex min-h-7 items-center gap-2">
        <span className={cn("book-stat min-w-0 flex-1 text-[13px] text-muted-foreground tabular-nums", done && "done text-success before:content-['✓_']")}>
          {bookStat(b, level)}
        </span>
        <button
          type="button"
          className="book-del -mr-1.5 inline-grid size-7 place-items-center rounded-md text-muted-foreground opacity-0 transition-[opacity,color] group-focus-within/book:opacity-100 group-hover/book:opacity-100 hover:bg-accent hover:text-destructive focus-visible:opacity-100 pointer-coarse:opacity-100"
          data-del-book={b.id}
          aria-label={`${t("book.delete")}: ${b.title}`}
          title={t("book.delete")}
          onClick={remove}
        >
          <Trash2 className="size-4" strokeWidth={1.8} />
        </button>
      </div>
      {p > 0 && !done && (
        <div className="book-bar mt-1 h-[3px] overflow-hidden rounded-full bg-border" aria-hidden="true">
          <div className="h-full rounded-full bg-(--thread)" style={{ width: `${p}%` }} />
        </div>
      )}
    </article>
  )
}
