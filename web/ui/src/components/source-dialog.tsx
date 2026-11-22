import * as React from "react"
import { flushSync } from "react-dom"
import { AlignLeft, BookOpen, Check, FilePlus2, Globe, PencilLine, Trash2, Upload, WifiOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { net } from "@/lib/api.js"
import { flush } from "@/lib/offline.js"
import {
  MAX_CHARS, MAX_EPUB_BYTES, createBook, updateBook, importURL, importEPUB, detectFormat, markdownScore,
} from "@/lib/library.js"
import { readPDF, isPDF, PDFError } from "@/lib/pdftext.js"
import { useApp, get, set, type Book } from "@/app/store"
import { useT } from "@/app/hooks"
import { ttlOptions } from "@/app/books"
import { flushProgress, holdProgress } from "@/app/progress"
import { openBook, openSettingsAt, deleteBook, SAMPLE_TEXT, SAMPLE_TITLE } from "@/app/session"
import { articleBlocks, showNewPart } from "@/app/engine"
import { showToast } from "@/app/notice"
import { t as tr } from "@/lib/i18n.js"
import { confirmDialog } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

type Kind = "text" | "url" | "file"
type Mode = "edit" | "append"

const APPEND_SEPARATOR = "\n\n---\n\n" // as the server puts between a text and what an agent adds

const looksLikeURL = (s: string) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(s.trim()) && !/\s/.test(s.trim())
const isEPUB = (file: File) => /\.epub$/i.test(file.name) || file.type === "application/epub+zip"
const formatBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

const closeSource = () => set({ source: null })

// Add a text (pasted, a web page, an EPUB or a PDF), or change one on the shelf:
// edit the whole of it, or append more to its end, after a dividing line.
export function SourceDialog() {
  const source = useApp((s) => s.source)
  return (
    <Dialog open={!!source} onOpenChange={(open) => { if (!open) closeSource() }}>
      {source && <SourceForm key={source.seq} book={source.book} append={source.append} />}
    </Dialog>
  )
}

function SourceForm({ book, append }: { book: Book | null; append: boolean }) {
  const t = useT()
  const books = useApp((s) => s.books)
  const online = useNetOnline()
  const editing = !!book
  const [kind, setKind] = React.useState<Kind>("text")
  const [mode, setMode] = React.useState<Mode>(append ? "append" : "edit")
  const [title, setTitle] = React.useState(book?.title || "")
  const [text, setText] = React.useState(book?.content || "")
  const [more, setMore] = React.useState("")
  const [url, setUrl] = React.useState("")
  const [file, setFile] = React.useState<File | null>(null)
  const [fileMeta, setFileMeta] = React.useState("")
  const [ttl, setTtl] = React.useState(book?.expiresAt ? "keep" : "0")
  // 'markdown' or 'text' once the reader picks one in the note under the text;
  // until then chosenFormat decides.
  const [picked, setPicked] = React.useState<"markdown" | "text" | null>(null)
  const [error, setError] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const refs = {
    text: React.useRef<HTMLTextAreaElement>(null),
    more: React.useRef<HTMLTextAreaElement>(null),
    url: React.useRef<HTMLInputElement>(null),
    file: React.useRef<HTMLInputElement>(null),
    save: React.useRef<HTMLButtonElement>(null),
  }
  const editingFormat = book?.format || null
  const editingLooksMd = editingFormat === "text" && detectFormat(book?.content || "") === "markdown" // kept plain on purpose
  const appending = editing && mode === "append"
  const panel = appending ? "append" : kind

  // Web pages and EPUB books are read by the server; offline, pasted text and
  // PDFs (read here) can still be added.
  React.useEffect(() => {
    if (!online && kind === "url") setKind("text")
  }, [online, kind])

  // Shows a panel at once (it was hidden until now), then puts the cursor in it.
  const focusFor = (k: Kind | "append", change?: () => void) => {
    if (change) flushSync(change)
    ;({ text: refs.text, url: refs.url, file: refs.file, append: refs.more }[k].current?.focus())
  }

  // What saving makes the text: as edited, or with the addition at its end.
  const pendingText = () => {
    const whole = text.replace(/\s+$/, "")
    if (!appending) return whole
    const add = more.trim()
    return whole && add ? whole + APPEND_SEPARATOR + add : whole || add
  }

  // Markdown or plain text: what the reader picked in the note, else what an
  // edited text was saved as (imports are Markdown; plain text that already
  // looked like Markdown was kept plain on purpose), else what it looks like.
  const chosenFormat = (content: string, looks = detectFormat(content)) => {
    if (picked) return picked
    if (editingFormat === "markdown" || editingLooksMd) return editingFormat as "markdown" | "text"
    return looks
  }

  // The count, the link hint and the format note follow what's typed.
  const typed = appending ? more : text
  const n = typed.length
  const isLink = !editing && n > 0 && n < 2000 && looksLikeURL(typed)
  const noteWanted = kind === "text" && n > 0 && !isLink
  const content = noteWanted ? pendingText() : ""
  const score = noteWanted ? markdownScore(content) : 0
  const looks = score >= 3 ? "markdown" : "text"
  const format = noteWanted ? chosenFormat(content, looks) : "text"
  const noteHidden = !noteWanted || (format === "text" && score < 2)
  const plain = format === "text"
  const says = plain ? "source.mdPlain" : looks === "markdown" ? "source.mdDetected" : "source.mdSaved"

  const pickFile = (f: File | undefined) => {
    if (!f) return
    setError("")
    if (!isEPUB(f) && !isPDF(f)) {
      setFile(null)
      setError(t("source.notFile"))
      return
    }
    setFile(f)
    setFileMeta("")
    if (f.size > MAX_EPUB_BYTES) setError(t("source.tooBig"))
  }

  const heading = t(appending ? "source.append" : editing ? "source.edit" : "source.add")
  const saveLabel = t(appending ? "source.saveAppend" : editing ? "source.saveEdit"
    : { text: "source.save", url: "source.saveUrl", file: file && isPDF(file) ? "source.savePdf" : "source.saveEpub" }[kind])

  const fail = (msg: string, field?: keyof typeof refs) => {
    setError(msg)
    if (field) refs[field].current?.focus()
  }

  const submit = async () => {
    if (busy) return
    let body = ""
    const adding = appending
    if (adding) {
      // The text as it stands in Edit (usually as saved), then the addition.
      if (!more.trim()) return fail(t("source.emptyMore"), "more")
      body = pendingText()
      if (body.length > MAX_CHARS) return fail(t("source.tooLong", { n: body.length.toLocaleString(), max: MAX_CHARS.toLocaleString() }), "more")
    } else if (kind === "text") {
      body = pendingText()
      if (!body.trim()) return fail(t("source.empty"), "text")
      if (body.length > MAX_CHARS) return fail(t("source.tooLong", { n: body.length.toLocaleString(), max: MAX_CHARS.toLocaleString() }), "text")
    } else if (kind === "url") {
      if (!url.trim()) return fail(t("source.noUrl"), "url")
    } else {
      if (!file) return fail(t("source.noFile"), "file")
      if (file.size > MAX_EPUB_BYTES) return fail(t("source.tooBig"), "file")
    }

    let saved: Book
    setBusy(true)
    setError("")
    const ttlDays = ttl === "keep" ? undefined : Number(ttl)
    try {
      if (book) {
        await sendProgress(book.id)
        saved = await updateBook(book.id, { title, content: body, format: chosenFormat(body), ttlDays })
        holdProgress(book.id)
      } else if (kind === "text") {
        saved = await createBook({ title, content: body, format: chosenFormat(body), ttlDays })
      } else if (kind === "url") {
        saved = await importURL(url.trim(), title, ttlDays)
      } else if (isPDF(file!)) {
        // A PDF is read here (pdftext.js) and added like pasted Markdown, so it
        // also works offline once pdf.js has been loaded.
        const pdf = await readPDF(file!, { onPage: (i: number, n: number) => setFileMeta(tr("pdf.reading", { i, n })) })
        if (pdf.content.length > MAX_CHARS) {
          throw new Error(tr("source.tooLong", { n: pdf.content.length.toLocaleString(), max: MAX_CHARS.toLocaleString() }))
        }
        saved = await createBook({ title: title.trim() || pdf.title, content: pdf.content, format: "markdown", ttlDays })
      } else {
        saved = await importEPUB(file!, title, ttlDays)
      }
    } catch (e: any) {
      setBusy(false)
      setFileMeta("") // the page count goes
      return fail(e instanceof PDFError ? t((e as PDFError & { key: string }).key) : e.message, adding ? "more" : ({ text: "text", url: "url", file: "file" } as const)[editing ? "text" : kind])
    }
    setBusy(false)
    closeSource()
    const target = `#/read/${encodeURIComponent(saved.id)}`
    if (location.hash !== target) {
      location.hash = target
    } else if (!adding) {
      openBook(saved.id) // edited the open book: re-render it
    } else {
      // Added to the open book: the reader stays where they are, and can go to
      // the new part.
      const oldBlocks = articleBlocks()
      await openBook(saved.id, { keepPlace: true })
      if (get().book?.id === saved.id) {
        showToast(t("source.appended"), { action: { label: t("reader.showNew"), run: () => showNewPart(oldBlocks) } })
      }
    }
  }

  const remove = async () => {
    if (!book || !(await confirmDialog(t("book.confirmDelete", { t: book.title }), { confirm: t("book.delete"), destructive: true }))) return
    if (!(await deleteBook(book.id))) return
    set({ book: null })
    closeSource()
    location.hash = "#/"
  }

  const options = ttlOptions(book)
  const KindIcon = { text: AlignLeft, url: Globe, file: BookOpen }

  return (
    <DialogContent
      id="source-dialog"
      className="max-h-[calc(100dvh-32px)] gap-0 overflow-y-auto overscroll-contain rounded-2xl p-0 sm:max-w-[680px]"
      showCloseButton={!busy}
      onOpenAutoFocus={(e) => { e.preventDefault(); focusFor(appending ? "append" : "text") }}
      onInteractOutside={(e) => e.preventDefault()} // a click beside it shouldn't lose what was typed
      onEscapeKeyDown={(e) => { if (busy) e.preventDefault() }}
    >
      <form
        id="source-form"
        noValidate
        inert={busy}
        className="flex flex-col gap-4 p-6 max-sm:px-4 max-sm:py-5"
        onSubmit={(e) => { e.preventDefault(); submit() }}
      >
        <DialogHeader className="gap-1 pr-8">
          <DialogTitle id="source-heading" className="font-serif text-xl font-semibold tracking-tight">{heading}</DialogTitle>
          <DialogDescription className="sr-only">{heading}</DialogDescription>
        </DialogHeader>

        <div id="src-kinds" role="radiogroup" aria-label={t("source.kind")} hidden={editing} className="source-kinds inline-flex w-fit max-w-full gap-0.5 rounded-xl bg-muted p-1 ring-1 ring-border/70 ring-inset">
          {(["text", "url", "file"] as Kind[]).map((k) => {
            const Icon = KindIcon[k]
            const disabled = k === "url" && !online
            return (
              <label key={k} className={cn("kind relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[13.5px] font-medium text-muted-foreground transition-[color,background-color,box-shadow] select-none hover:text-foreground has-checked:bg-card has-checked:text-foreground has-checked:shadow-sm has-disabled:cursor-not-allowed has-disabled:opacity-45 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 dark:has-checked:bg-accent max-sm:px-2.5", disabled && "pointer-events-none")}>
                <input
                  type="radio" name="kind" value={k} className="peer sr-only" checked={kind === k} disabled={disabled}
                  onChange={() => focusFor(k, () => { setKind(k); setError("") })}
                />
                <Icon className="size-4" strokeWidth={1.8} />
                <span>{t({ text: "source.text", url: "source.url", file: "source.file" }[k])}</span>
              </label>
            )
          })}
        </div>
        <div id="src-modes" role="radiogroup" aria-label={t("source.mode")} hidden={!editing} className="source-kinds inline-flex w-fit gap-0.5 rounded-xl bg-muted p-1 ring-1 ring-border/70 ring-inset">
          {(["edit", "append"] as Mode[]).map((m) => {
            const Icon = m === "edit" ? PencilLine : FilePlus2
            return (
              <label key={m} className="kind inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[13.5px] font-medium text-muted-foreground transition-[color,background-color,box-shadow] select-none hover:text-foreground has-checked:bg-card has-checked:text-foreground has-checked:shadow-sm has-focus-visible:ring-3 has-focus-visible:ring-ring/50 dark:has-checked:bg-accent">
                <input
                  type="radio" name="mode" value={m} className="sr-only" checked={mode === m}
                  onChange={() => focusFor(m === "append" ? "append" : "text", () => { setMode(m); setError("") })}
                />
                <Icon className="size-4" strokeWidth={1.8} />
                <span>{t(m === "edit" ? "source.modeEdit" : "source.modeAppend")}</span>
              </label>
            )
          })}
        </div>

        <p id="src-offline" hidden={online || editing} className="src-note src-offline m-0 flex gap-2 rounded-lg bg-muted px-3 py-2 text-[13px] text-ink-2">
          <WifiOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>{t("net.sourceOffline")}</span>
        </p>

        <div className="src-panel grid gap-2" data-kind="url" hidden={panel !== "url"}>
          <Label htmlFor="src-url">{t("source.link")}</Label>
          <Input
            id="src-url" ref={refs.url} name="url" type="url" inputMode="url" autoComplete="url" spellCheck={false}
            placeholder="https://…" className="h-10" value={url}
            onChange={(e) => { setUrl(e.target.value); setError("") }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit() } }}
          />
          <p className="src-note m-0 text-[13px] text-muted-foreground">{t("source.urlNote")}</p>
          <p className="src-note m-0 text-[13px] text-muted-foreground">
            {t("source.blocked")}{" "}
            <a
              href="#/settings" data-clip-setup className="font-medium text-foreground underline underline-offset-3"
              onClick={(e) => { e.preventDefault(); openSettingsAt("set-clip-h") }}
            >
              {t("source.blockedLink")}
            </a>
          </p>
        </div>

        <div className="src-panel" data-kind="file" hidden={panel !== "file"}>
          <label
            id="src-drop"
            className={cn(
              "dropzone group/drop flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-input bg-muted/40 px-6 py-8 text-center transition-colors hover:border-ring/60 hover:bg-accent/50 has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
              file && "has-file border-solid border-ring/40 bg-card",
            )}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("dragging", "border-ring") }}
            onDragLeave={(e) => e.currentTarget.classList.remove("dragging", "border-ring")}
            onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove("dragging", "border-ring"); pickFile(e.dataTransfer.files[0]) }}
          >
            <input
              id="src-file" ref={refs.file} name="file" type="file" className="sr-only"
              accept=".epub,.pdf,application/epub+zip,application/pdf"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            <span className="mb-1 grid size-10 place-items-center rounded-full bg-card text-muted-foreground ring-1 ring-border">
              {file ? <Check className="size-5 text-success" /> : <Upload className="size-5" />}
            </span>
            <span id="src-file-name" className="drop-title font-medium">{file ? file.name : t("source.choose")}</span>
            <small id="src-file-meta" className="text-[13px] text-muted-foreground">
              {fileMeta || (file ? t("source.fileMeta", { size: formatBytes(file.size) }) : t("source.fileNote"))}
            </small>
          </label>
        </div>

        <div className="field-pair grid grid-cols-[minmax(0,1fr)_auto] gap-3 max-[520px]:grid-cols-1">
          <div className="grid gap-2">
            <Label htmlFor="src-title">{t("source.title")}</Label>
            <Input
              id="src-title" name="title" type="text" autoComplete="off" placeholder={t("source.titlePh")} className="h-10"
              value={title} onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="field-ttl grid gap-2">
            <Label htmlFor="src-ttl">{t("source.ttl")}</Label>
            <NativeSelect id="src-ttl" name="ttl" value={ttl} onChange={(e) => setTtl(e.target.value)} className="w-full min-w-[150px] [&_select]:h-10 [&_select]:pl-3">
              {options.map((o) => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        </div>

        <div className="src-panel grid gap-2" data-kind="text" hidden={panel !== "text"}>
          <Label htmlFor="src-text">{t("source.body")}</Label>
          <Textarea
            id="src-text" ref={refs.text} name="content" rows={12} spellCheck={false} autoComplete="off"
            placeholder={t("source.bodyPh")} value={text}
            className="field-sizing-fixed min-h-[260px] font-reading text-[15px] leading-relaxed max-sm:min-h-[180px]"
            onChange={(e) => { setText(e.target.value); setError("") }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit() }}
          />
          <p id="src-link-hint" hidden={!isLink} className="src-note m-0 text-[13px] text-muted-foreground">
            <span>{t("source.linkPasted")}</span>{" "}
            <button
              type="button" id="src-use-link" className="link-btn font-medium text-foreground underline underline-offset-3"
              onClick={() => {
                flushSync(() => { setUrl(text.trim()); setText(""); setKind("url") })
                refs.save.current?.focus()
              }}
            >
              {t("source.importPage")}
            </button>
          </p>
        </div>

        <div className="src-panel grid gap-2" data-kind="append" hidden={panel !== "append"}>
          <Label htmlFor="src-more">{t("source.more")}</Label>
          <Textarea
            id="src-more" ref={refs.more} name="more" rows={12} spellCheck={false} autoComplete="off"
            placeholder={t("source.morePh")} value={more}
            className="field-sizing-fixed min-h-[260px] font-reading text-[15px] leading-relaxed max-sm:min-h-[180px]"
            onChange={(e) => { setMore(e.target.value); setError("") }}
          />
        </div>

        {/* Under the text, or what's added to it: Markdown or plain text, and a switch. */}
        <p id="src-md" aria-live="polite" hidden={noteHidden} className={cn("src-note src-detected m-0 flex items-start gap-2 text-[13px]", plain ? "is-plain text-muted-foreground" : "text-success")}>
          <Check className="mt-0.5 size-4 shrink-0" />
          <span>
            <span id="src-md-text">{t(says)}</span>{" "}
            <button
              type="button" id="src-md-switch" className="link-btn font-medium text-foreground underline underline-offset-3"
              onClick={() => setPicked(chosenFormat(pendingText()) === "markdown" ? "text" : "markdown")}
            >
              {t(plain ? "source.useMarkdown" : "source.usePlain")}
            </button>
          </span>
        </p>

        <p id="src-error" role="alert" className="field-error m-0 text-[13px] text-destructive empty:hidden">{error}</p>

        <div className="row -mx-6 -mb-6 mt-1 flex flex-wrap items-center gap-2 border-t bg-muted/50 px-6 py-3.5 max-sm:-mx-4 max-sm:-mb-5 max-sm:px-4">
          <Button
            type="button" id="src-sample" variant="ghost" size="sm" hidden={editing || kind !== "text" || books.length > 0}
            onClick={() => { setTitle(SAMPLE_TITLE); setText(SAMPLE_TEXT) }}
          >
            {t("source.sample")}
          </Button>
          <Button type="button" id="src-delete" variant="ghost" size="sm" hidden={!editing} className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={remove}>
            <Trash2 data-icon="inline-start" />{t("source.delete")}
          </Button>
          <span id="src-count" hidden={kind !== "text"} className="text-[13px] text-muted-foreground tabular-nums">
            {n ? t("chars", { n: n.toLocaleString() }) : ""}
          </span>
          <span className="flex-1" />
          <Button type="button" variant="ghost" onClick={closeSource} disabled={busy}>{t("settings.cancel")}</Button>
          <Button type="submit" id="src-save" ref={refs.save} value="save" disabled={busy} aria-busy={busy || undefined} className="min-w-28">
            {busy && <Spinner />}
            {saveLabel}
          </Button>
        </div>
      </form>
    </DialogContent>
  )
}

// Before the open text is saved in a new version: what's been read of it goes
// first (or waits first in the outbox), so the server keeps it and scales it
// with the text when only added to.
async function sendProgress(id: string) {
  if (get().book?.id !== id) return
  await flushProgress()
  if (net.online) await flush()
}

// Whether the server can be reached, as a component state.
function useNetOnline() {
  const [online, setOnline] = React.useState(net.online)
  React.useEffect(() => {
    const on = () => setOnline(net.online)
    window.addEventListener("netchange", on)
    return () => window.removeEventListener("netchange", on)
  }, [])
  return online
}
