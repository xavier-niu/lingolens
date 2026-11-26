import * as React from "react"
import { BookOpenText, Bot, Check, ChevronLeft, Copy, Download, Eye, EyeOff, KeyRound, LogOut, MousePointerClick, Smartphone, Sparkles, UserRound, Users } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api.js"
import { PRESETS, presetLabel } from "@/lib/presets"
import { useApp, get, set, hideBanner, getLevel, showBanner } from "@/app/store"
import { useT } from "@/app/hooks"
import { chooseLanguage, setLevel, signOut } from "@/app/session"
import { READING, ownReading, readingDefaults, resetDeviceReading, setReadingDefault, type ReadingKey } from "@/app/reading"
import { clearKnown } from "@/lib/offline.js"
import { refreshKnownMarks } from "@/app/engine"
import { bookmarkletCode } from "@/app/clip"
import {
  useSettings, createToken, revokeToken, loadMembers, setMemberStatus, generatePassword, copyText,
} from "@/app/settings"
import { confirmDialog, promptDialog } from "@/components/confirm"
import { FontChoice, GlossChoice, SizeChoice, ThemeChoice, WidthChoice } from "@/components/reading-options"
import { Segmented } from "@/components/segmented"
import { LogoMark } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

const SECTIONS = [
  { id: "set-profile-h", key: "profile.title", icon: UserRound },
  { id: "set-reading-h", key: "reading.title", icon: BookOpenText },
  { id: "set-model-h", key: "settings.title", icon: Sparkles },
  { id: "set-clip-h", key: "clip.title", icon: MousePointerClick },
  { id: "set-agent-h", key: "agent.title", icon: Bot },
  { id: "set-account-h", key: "account.title", icon: KeyRound },
  { id: "set-members-h", key: "members.title", icon: Users, admin: true },
]

export function SettingsView() {
  const t = useT()
  const view = useApp((s) => s.view)
  const me = useApp((s) => s.me)
  const shown = view === "settings"
  return (
    <section id="settings-view" hidden={!shown} className="settings-page mx-auto mt-14 max-w-[1040px] max-sm:mt-8">
      <BackToText />
      <h1 className="page-title m-0 mb-10 text-[clamp(26px,3.4vw,32px)] leading-tight font-semibold tracking-[-0.025em] max-sm:mb-7">{t("settings.page")}</h1>
      <div className="grid gap-12 lg:grid-cols-[196px_minmax(0,1fr)]">
        <nav aria-label={t("settings.page")} className="sticky top-20 hidden self-start lg:block">
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {SECTIONS.filter((s) => !s.admin || me?.is_admin).map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13.5px] font-medium text-muted-foreground transition-colors duration-150 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/35"
                  onClick={() => document.getElementById(s.id)?.closest("section")?.scrollIntoView({ block: "start", behavior: "smooth" })}
                >
                  <s.icon className="size-4" strokeWidth={1.8} />{t(s.key)}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-14">
          <ProfileSection />
          <ReadingSection />
          <ModelSection shown={shown} />
          <ClipSection shown={shown} />
          <AgentSection />
          <AccountSection shown={shown} />
          {me?.is_admin && <MembersSection shown={shown} />}
        </div>
      </div>
    </section>
  )
}

// Settings opened from a text: the way back to it, above the title.
function BackToText() {
  const returnTo = useApp((s) => s.returnTo)
  const books = useApp((s) => s.books)
  const m = returnTo.match(/^#\/read\/([^/]+)$/)
  const id = m && decodeURIComponent(m[1])
  const from = id && books.find((b) => String(b.id) === id)
  if (!from) return null
  return (
    <a
      id="back-to-text"
      href={returnTo}
      className="back-to-text mb-3 -ml-0.5 inline-flex max-w-full items-center gap-1 text-[13.5px] font-medium text-muted-foreground no-underline transition-colors hover:text-brand"
    >
      <ChevronLeft className="size-4 shrink-0" strokeWidth={2} />
      <span className="truncate">{from.title}</span>
    </a>
  )
}

// A section: its heading and note, then its settings on a card.
function Section({ id, sectionId, title, note, children, className }: {
  id: string; sectionId?: string; title: string; note?: string; children: React.ReactNode; className?: string
}) {
  return (
    <section id={sectionId} className={cn("set-section scroll-mt-[76px]", className)} aria-labelledby={id}>
      <div className="set-head mb-4">
        <h2 id={id} className="m-0 text-[17px] font-semibold tracking-[-0.015em]">{title}</h2>
        {note && <p className="mt-1 mb-0 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">{note}</p>}
      </div>
      <div className="set-body flex flex-col gap-4">{children}</div>
    </section>
  )
}

// One card of settings.
function Block({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("set-block rounded-2xl bg-card p-5 shadow-xs ring-1 ring-border max-sm:p-4", className)} {...rest}>{children}</div>
}

function BlockHead({ title, help }: { title: string; help?: string }) {
  return (
    <div className="min-w-0">
      <h3 className="m-0 text-[15px] font-semibold">{title}</h3>
      {help && <p className="set-help mt-0.5 mb-0 text-[13px] text-muted-foreground">{help}</p>}
    </div>
  )
}

const status = "saved-status text-[13px] text-muted-foreground [overflow-wrap:anywhere]"

// ------------------------------------------------------------------ profile

function ProfileSection() {
  const t = useT()
  const levels = useApp((s) => s.config.levels)
  useApp((s) => s.prefs.level)
  const lang = useApp((s) => s.lang)
  const reading = readingDefaults({ prefs: useApp((s) => s.prefs) })
  const current = getLevel()
  const levelName = (l: (typeof levels)[number]) => (lang === "zh" ? l.label.replace(/^\S+\s*/, "") : l.name)
  return (
    <Section id="set-profile-h" title={t("profile.title")} note={t("profile.note")}>
      <Block>
        <BlockHead title={t("level.head")} help={t("level.title")} />
        <div id="profile-levels" role="radiogroup" aria-label={t("level.head")} className="level-cards mt-4 grid grid-cols-3 gap-2.5 max-sm:grid-cols-2">
          {levels.map((l) => {
            const on = l.id === current
            return (
              <button
                key={l.id}
                type="button"
                role="radio"
                data-level={l.id}
                aria-checked={on}
                onClick={() => setLevel(l.id)}
                className={cn(
                  "level-card relative flex flex-col items-start gap-0.5 rounded-xl border bg-card px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] duration-150 outline-none hover:border-input hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/35",
                  on && "border-brand bg-brand-soft shadow-[0_0_0_1px_var(--brand)] hover:border-brand hover:bg-brand-soft",
                )}
              >
                {on && <span className="absolute top-3 right-3 grid size-[18px] place-items-center rounded-full bg-brand text-white dark:text-[#141415]"><Check className="size-3" strokeWidth={3} /></span>}
                <span className="lc-code text-lg font-semibold tracking-tight">{l.id}</span>
                <span className="lc-name text-[13.5px] font-medium">{levelName(l)}</span>
                <span className="lc-hint text-xs text-muted-foreground">{l.hint}</span>
                <span className="lc-hint text-xs text-muted-foreground">{t("level.words", { n: l.vocab.toLocaleString() })}</span>
              </button>
            )
          })}
        </div>
      </Block>
      <Block className="set-inline flex flex-wrap items-center justify-between gap-4">
        <BlockHead title={t("menu.language")} help={t("profile.langNote")} />
        <Segmented
          id="lang-seg" label={t("menu.language")} attr="lang" value={lang} onChange={chooseLanguage}
          options={[{ value: "en", content: "English" }, { value: "zh", content: "中文" }]}
        />
      </Block>
      <Block className="set-inline flex flex-wrap items-center justify-between gap-4">
        <BlockHead title={t("theme.title")} help={t("theme.note")} />
        <ThemeChoice id="theme-seg" labels value={reading.theme} onChange={(v) => setReadingDefault("theme", v)} />
      </Block>
    </Section>
  )
}

// ------------------------------------------------------------------ reading defaults

// The defaults for Reading Options, saved to the account.
function ReadingSection() {
  const t = useT()
  const prefs = useApp((s) => s.prefs)
  const deviceReading = useApp((s) => s.deviceReading)
  const d = readingDefaults({ prefs })
  const own = ownReading({ deviceReading })
  const row = "set-row flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2.5"
  const set = (key: ReadingKey) => (v: string) => setReadingDefault(key, v)
  return (
    <Section id="set-reading-h" title={t("reading.title")} note={t("reading.note")}>
      <p id="reading-local" hidden={!own.length} className="set-local m-0 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-brand-soft px-4 py-3 text-[13.5px] text-ink-2">
        <Smartphone className="size-4 shrink-0 text-muted-foreground" />
        <span id="reading-local-text">{t("reading.local", { list: own.map((k) => t(READING[k].label)).join(t("list.sep")) })}</span>
        <button type="button" id="reading-reset" className="link-btn font-medium text-foreground underline underline-offset-3" onClick={resetDeviceReading}>
          {t("reading.reset")}
        </button>
      </p>
      <Block className="set-rows divide-y py-2">
        <label className={cn(row, "cursor-pointer")}>
          <span className="set-label text-sm font-medium">{t("toggle.words")}</span>
          <Switch id="def-words" checked={!d.hideWords} onCheckedChange={(on) => setReadingDefault("hideWords", !on)} />
        </label>
        <label className={cn(row, "cursor-pointer")}>
          <span className="set-label text-sm font-medium">{t("toggle.phrases")}</span>
          <Switch id="def-phrases" checked={!d.hidePhrases} onCheckedChange={(on) => setReadingDefault("hidePhrases", !on)} />
        </label>
        <div className={row}>
          <span className="set-label text-sm font-medium">{t("display.size")}</span>
          <SizeChoice id="def-size-seg" value={d.readSize} onChange={set("readSize")} />
        </div>
        <div className={row}>
          <span className="set-label text-sm font-medium">{t("display.width")}</span>
          <WidthChoice id="def-width-seg" labels value={d.readWidth} onChange={set("readWidth")} />
        </div>
        <div className={row}>
          <span className="set-label text-sm font-medium">{t("display.font")}</span>
          <FontChoice id="def-font-seg" value={d.readFont} onChange={set("readFont")} className="w-[400px] grid-cols-4 max-sm:w-full max-sm:grid-cols-2" />
        </div>
        <div className={row}>
          <span className="set-label text-sm font-medium">{t("display.glossFont")}</span>
          <GlossChoice id="def-gloss-seg" value={d.glossFont} onChange={set("glossFont")} className="w-[240px] max-sm:w-full" />
        </div>
        <KnownWords className={row} />
      </Block>
    </Section>
  )
}

// Words marked "I Know This" in the word card lose their glosses; here they
// can all have them back.
function KnownWords({ className }: { className: string }) {
  const t = useT()
  const n = useApp((s) => s.known.size)
  const clear = async () => {
    if (!n || !(await confirmDialog(t("known.confirmClear", { n }), { confirm: t("known.clear") }))) return
    set({ known: new Set() })
    clearKnown().catch((err: Error) => showBanner(err.message))
    refreshKnownMarks()
  }
  return (
    <div className={className}>
      <span className="min-w-0">
        <span className="set-label block text-sm font-medium">{t("known.title")}</span>
        <span id="known-count" className="set-help block text-[13px] text-muted-foreground">{t("known.count", { n: n.toLocaleString() })}</span>
      </span>
      <Button type="button" id="known-clear" variant="outline" size="sm" disabled={!n} onClick={clear}>{t("known.clear")}</Button>
    </div>
  )
}

// ------------------------------------------------------------------ AI model

// The key field never shows a saved key: the server keeps it and only says
// whether one is set. Typing a new key replaces it; "Remove key" deletes it.
function ModelSection({ shown }: { shown: boolean }) {
  const t = useT()
  const model = useApp((s) => s.model)
  const allowFake = useApp((s) => s.config.allow_fake)
  const [preset, setPreset] = React.useState("deepseek")
  const [base, setBase] = React.useState("")
  const [name, setName] = React.useState("")
  const [key, setKey] = React.useState("")
  const [showKey, setShowKey] = React.useState(false)
  const [msg, setMsg] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback((id: string) => {
    const p = PRESETS[id]
    const saved = get().model?.providers?.[id]
    setPreset(id)
    setBase(saved ? saved.base_url : p.base_url)
    setName(saved ? saved.model : p.model)
    setKey("")
    setShowKey(false)
  }, [])

  // Opening Settings shows the active choice.
  React.useEffect(() => {
    if (!shown) return
    const active = get().model?.active
    load(PRESETS[active] ? active : "deepseek")
    setMsg("")
  }, [shown, load])

  const p = PRESETS[preset]
  const hasKey = !!model?.has_key?.[preset]
  const fake = p.kind === "fake"

  const save = async (removeKey = false) => {
    const body: Record<string, string> = { preset, kind: p.kind, base_url: base.trim(), model: name.trim() }
    if (removeKey) body.api_key = ""
    else if (key.trim()) body.api_key = key.trim() // left empty: keep the saved key
    setBusy(true)
    try {
      set({ model: await api("PUT", "/api/me/model", body) })
      load(preset)
      hideBanner()
      setMsg(t(removeKey ? "settings.keyRemoved" : "settings.saved"))
    } catch (err: any) {
      setMsg(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section id="set-model-h" title={t("settings.title")} note={t("settings.privacy")}>
      <Block>
        <form id="settings-form" noValidate className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save() }} onInput={() => setMsg("")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="s-preset">{t("settings.provider")}</Label>
              <NativeSelect id="s-preset" name="provider" value={preset} onChange={(e) => load(e.target.value)} className="w-full [&_select]:h-10">
                {Object.entries(PRESETS).filter(([, x]) => !x.devOnly || allowFake).map(([id, x]) => (
                  <NativeSelectOption key={id} value={id}>{presetLabel(x)}</NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="s-model">{t("settings.model")}</Label>
              <Input
                id="s-model" name="model" list="s-models" placeholder="e.g. deepseek-chat…" autoComplete="off" spellCheck={false}
                className="h-10" value={name} disabled={fake} onChange={(e) => setName(e.target.value)}
              />
              <datalist id="s-models">{p.models.map((m) => <option key={m} value={m} />)}</datalist>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-base">Base URL</Label>
            <Input
              id="s-base" name="base_url" type="url" inputMode="url" autoComplete="off" spellCheck={false} className="h-10"
              placeholder={p.kind === "anthropic" ? t("settings.anthropicBase") : "https://…/v1"}
              value={base} disabled={fake} onChange={(e) => setBase(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-key">{t("settings.key")}</Label>
            <div className="key-row flex items-center gap-2">
              <div className="relative flex-1">
                <Input
                  id="s-key" name="api_key" type={showKey ? "text" : "password"} autoComplete="off" spellCheck={false}
                  className="h-10 pr-10 font-mono text-[13px]" placeholder={hasKey ? t("settings.keySaved") : "sk-…"}
                  value={key} disabled={fake} onChange={(e) => setKey(e.target.value)}
                />
                <Button
                  type="button" id="s-key-toggle" variant="ghost" size="icon-sm" className="absolute top-1 right-1 text-muted-foreground"
                  aria-label={t(showKey ? "settings.hide" : "settings.show")} title={t(showKey ? "settings.hide" : "settings.show")}
                  disabled={fake} onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              <Button type="button" id="s-key-remove" variant="ghost" className="h-10 text-destructive hover:bg-destructive/10 hover:text-destructive" hidden={!hasKey} onClick={() => save(true)}>
                {t("settings.removeKey")}
              </Button>
            </div>
          </div>
          <p id="s-note" className="note m-0 text-[13px] text-muted-foreground empty:hidden">{p.noteKey ? t(p.noteKey) : ""}</p>
          <div className="row flex items-center gap-3 border-t pt-4">
            <span id="s-status" role="status" className={status}>{msg}</span>
            <span className="flex-1" />
            <Button type="submit" id="s-save" disabled={busy} aria-busy={busy || undefined} className="min-w-20">
              {busy && <Spinner />}{t("settings.save")}
            </Button>
          </div>
        </form>
      </Block>
    </Section>
  )
}

// ------------------------------------------------------------------ bookmarklet

function ClipSection({ shown }: { shown: boolean }) {
  const t = useT()
  useApp((s) => s.lang) // the code says "allow pop-ups" in the interface language
  const [note, setNote] = React.useState("")
  const [copied, setCopied] = React.useState(false)
  const box = React.useRef<HTMLElement>(null)
  const link = React.useRef<HTMLAnchorElement>(null)
  React.useEffect(() => { if (shown) setNote("") }, [shown])
  const code = bookmarkletCode()
  // React refuses javascript: links (it would turn this one into an error), so
  // the bookmarklet goes on the element itself.
  React.useEffect(() => { link.current?.setAttribute("href", code) }, [code])
  return (
    <Section id="set-clip-h" title={t("clip.title")} note={t("clip.note")}>
      <Block className="bm-desktop pointer-coarse:hidden">
        <BlockHead title={t("clip.desktop")} />
        <div className="bm-drag mt-4 flex flex-wrap items-center gap-3">
          <a
            id="bm-link"
            ref={link}
            translate="no"
            className="bookmarklet inline-flex cursor-grab items-center gap-2 rounded-xl border border-dashed border-input bg-background py-1.5 pr-3.5 pl-2 text-sm font-semibold text-foreground no-underline shadow-xs transition-colors hover:border-ring/60 active:cursor-grabbing"
            onClick={(e) => { e.preventDefault(); setNote(t("clip.notHere")) }} // it's for other sites; here it would only open another tab
          >
            <LogoMark className="size-6" /><span>{t("clip.bmName")}</span>
          </a>
          <span className="set-help text-[13px] text-muted-foreground">{t("clip.drag")}</span>
        </div>
        <ol className="bm-steps mt-4 mb-0 grid list-decimal gap-1 pl-5 text-sm text-ink-2 marker:text-muted-foreground">
          <li>{t("clip.step1")}</li>
          <li>{t("clip.step2")}</li>
          <li>{t("clip.step3")}</li>
        </ol>
        <p id="bm-status" role="status" className="set-help bm-status mt-3 mb-0 text-[13px] text-muted-foreground empty:hidden">{note}</p>
      </Block>
      <Block>
        <BlockHead title={t("clip.phone")} />
        <ol className="bm-steps mt-3 mb-0 grid list-decimal gap-1 pl-5 text-sm text-ink-2 marker:text-muted-foreground">
          <li>{t("clip.phone1")}</li>
          <li>{t("clip.phone2")}</li>
          <li>{t("clip.phone3")}</li>
        </ol>
        <CodeBox className="bm-box mt-4">
          <code id="bm-code" ref={box} translate="no" className="bm-code block min-w-0 flex-1 max-h-20 overflow-y-auto font-mono text-xs leading-relaxed break-all text-ink-2">{code}</code>
          <CopyButton id="bm-copy" copied={copied} onClick={async () => { if (await copyText(code, box.current)) flash(setCopied) }} />
        </CodeBox>
      </Block>
    </Section>
  )
}

function CodeBox({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("token-box flex items-start gap-3 rounded-lg border bg-sunken py-2 pr-2 pl-3.5", className)}>{children}</div>
}

function CopyButton({ id, copied, onClick }: { id: string; copied: boolean; onClick: () => void }) {
  const t = useT()
  return (
    <Button type="button" id={id} variant="outline" size="sm" className="shrink-0" onClick={onClick}>
      {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      {t(copied ? "agent.copied" : "agent.copy")}
    </Button>
  )
}

const flash = (setter: (v: boolean) => void) => {
  setter(true)
  setTimeout(() => setter(false), 2000)
}

// ------------------------------------------------------------------ agent access

function shortDate(iso?: string) {
  if (!iso) return ""
  return new Date(iso).toLocaleDateString(get().lang === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", year: "numeric" })
}

function AgentSection() {
  const t = useT()
  const { tokens, tokenError, newToken } = useSettings()
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState<"" | "token" | "skill" | "mcp" | "mcp-cmd">("")
  const envBox = React.useRef<HTMLElement>(null)
  const skillBox = React.useRef<HTMLElement>(null)
  const mcpBox = React.useRef<HTMLElement>(null)
  const mcpCmdBox = React.useRef<HTMLElement>(null)
  const copyBtn = React.useRef<HTMLDivElement>(null)
  const copy = async (what: typeof copied, text: string, box: HTMLElement | null) => {
    if (await copyText(text, box)) {
      setCopied(what)
      setTimeout(() => setCopied(""), 2000)
    }
  }
  const SKILL = "npx skills add xavier-niu/lingolens"
  // The MCP server is on this same address (the server's own public address
  // when it sits behind a proxy is the one this page came from too).
  const MCP = `${location.origin}/mcp`
  const MCP_CMD = `claude mcp add --transport http lingolens ${MCP} --header "Authorization: Bearer $LINGOLENS_TOKEN"`
  return (
    <Section id="set-agent-h" title={t("agent.title")} note={t("agent.note")}>
      <Block>
        <form
          id="token-form"
          noValidate
          className="token-form flex items-end gap-3 max-sm:flex-col max-sm:items-stretch"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            if (await createToken(name)) {
              setName("")
              requestAnimationFrame(() => copyBtn.current?.querySelector("button")?.focus())
            }
            setBusy(false)
          }}
        >
          <div className="grid flex-1 gap-2">
            <Label htmlFor="tk-name">{t("agent.name")}</Label>
            <Input id="tk-name" name="token_name" type="text" autoComplete="off" spellCheck={false} maxLength={60} placeholder={t("agent.namePh")} className="h-10" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button type="submit" variant="outline" className="h-10" disabled={busy} aria-busy={busy || undefined}>
            {busy && <Spinner />}{t("agent.create")}
          </Button>
        </form>
        <div id="token-new" hidden={!newToken} className="token-new anim-rise mt-4 rounded-xl border border-success/30 bg-success/[.06] p-4">
          <p className="token-warn m-0 mb-3 flex items-center gap-2 text-sm font-medium text-foreground"><KeyRound className="size-4 text-success" />{t("agent.copyNow")}</p>
          <div className="token-box flex items-start gap-3 rounded-lg border bg-card p-3" ref={copyBtn}>
            <code id="tk-env" ref={envBox} translate="no" className="min-w-0 flex-1 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{newToken}</code>
            <CopyButton id="tk-copy" copied={copied === "token"} onClick={() => copy("token", newToken, envBox.current)} />
          </div>
          <p className="set-help mt-2 mb-0 text-[13px] text-muted-foreground">{t("agent.setup")}</p>
        </div>
        <p id="tk-status" role="alert" className="field-error mt-3 mb-0 text-[13px] text-destructive empty:hidden">{tokenError}</p>
      </Block>
      <Block>
        <BlockHead title={t("agent.install")} help={t("agent.installCli")} />
        <div className="token-box skill-box mt-3 flex items-center gap-3 rounded-lg border bg-sunken py-2 pr-2 pl-3.5">
          <code id="skill-cmd" ref={skillBox} translate="no" className="min-w-0 flex-1 font-mono text-[13px]">{SKILL}</code>
          <CopyButton id="skill-copy" copied={copied === "skill"} onClick={() => copy("skill", SKILL, skillBox.current)} />
        </div>
        <p className="set-help mt-3 mb-0 text-[13px] text-muted-foreground">
          <span>{t("agent.installZip")}</span>{" "}
          <a href="/skills/lingolens.zip" download className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-3">
            <Download className="size-3.5" />{t("agent.download")}
          </a>
        </p>
      </Block>
      <Block>
        <BlockHead title={t("agent.mcp")} help={t("agent.mcpNote")} />
        <div className="token-box mt-3 flex items-center gap-3 rounded-lg border bg-sunken py-2 pr-2 pl-3.5">
          <code id="mcp-url" ref={mcpBox} translate="no" className="min-w-0 flex-1 font-mono text-[13px] break-all">{MCP}</code>
          <CopyButton id="mcp-copy" copied={copied === "mcp"} onClick={() => copy("mcp", MCP, mcpBox.current)} />
        </div>
        <p className="set-help mt-3 mb-0 text-[13px] text-muted-foreground">{t("agent.mcpClaude")}</p>
        <div className="token-box mt-2 flex items-start gap-3 rounded-lg border bg-sunken py-2 pr-2 pl-3.5">
          <code id="mcp-cmd" ref={mcpCmdBox} translate="no" className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all">{MCP_CMD}</code>
          <CopyButton id="mcp-cmd-copy" copied={copied === "mcp-cmd"} onClick={() => copy("mcp-cmd", MCP_CMD, mcpCmdBox.current)} />
        </div>
      </Block>
      <Block>
        <div className="token-head">
          <BlockHead title={t("agent.tokens")} help={t("agent.scope")} />
        </div>
        <ul id="token-list" className="member-list token-list m-0 mt-3 list-none divide-y p-0 empty:hidden">
          {tokens.map((tk) => (
            <li key={tk.id} className="member flex flex-wrap items-center gap-3 py-3">
              <span className="member-who min-w-0 flex-1">
                <span className="member-name block text-sm font-medium">{tk.name}</span>
                <span className="member-email block text-[13px] text-muted-foreground">
                  <span className="token-hint font-mono" translate="no">{tk.hint}</span> ·{" "}
                  {t("agent.created", { d: shortDate(tk.created_at) })},{" "}
                  {tk.last_used_at ? t("agent.used", { d: shortDate(tk.last_used_at) }) : t("agent.never")}
                </span>
              </span>
              <Button
                type="button" variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                data-revoke={tk.id} data-name={tk.name}
                onClick={async () => {
                  if (await confirmDialog(t("agent.confirmRevoke", { n: tk.name }), { confirm: t("agent.revoke"), destructive: true })) revokeToken(tk.id)
                }}
              >
                {t("agent.revoke")}
              </Button>
            </li>
          ))}
        </ul>
        <p id="token-empty" hidden={tokens.length > 0} className="set-help token-empty mt-3 mb-0 text-[13px] text-muted-foreground">{t("agent.none")}</p>
      </Block>
    </Section>
  )
}

// ------------------------------------------------------------------ account

function AccountSection({ shown }: { shown: boolean }) {
  const t = useT()
  const me = useApp((s) => s.me)
  const [msg, setMsg] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const current = React.useRef<HTMLInputElement>(null)
  const fresh = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { if (shown) setMsg("") }, [shown])
  if (!me) return <Section id="set-account-h" title={t("account.title")}><span /></Section>
  const confirmLoss = (n: number) => confirmDialog(t("net.signOutPending", { n }), { confirm: t("account.signOut"), destructive: true })
  return (
    <Section id="set-account-h" title={t("account.title")} note={t("account.note")}>
      <Block className="set-inline flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 id="acct-name" className="m-0 truncate text-[15px] font-semibold">{me.name || me.email}</h3>
          <p className="set-help m-0 mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            <span id="acct-email">{me.name ? me.email : ""}</span>
            <span id="acct-role" className="role-tag rounded-full bg-brand-soft px-2 py-px text-[11px] font-semibold text-brand">{t(me.is_admin ? "members.admin" : "members.member")}</span>
          </p>
        </div>
        <Button type="button" id="btn-logout" variant="outline" onClick={() => signOut(confirmLoss)}>
          <LogOut data-icon="inline-start" />{t("account.signOut")}
        </Button>
      </Block>
      <Block>
        <form
          id="password-form"
          noValidate
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              await api("PUT", "/api/me/password", { current: current.current!.value, new: fresh.current!.value })
              current.current!.value = ""
              fresh.current!.value = ""
              setMsg(t("account.pwChanged"))
            } catch (err: any) {
              setMsg(err.message)
              current.current!.focus()
            } finally {
              setBusy(false)
            }
          }}
        >
          <BlockHead title={t("account.changePw")} />
          <div className="field-grid grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pw-current">{t("account.currentPw")}</Label>
              <Input id="pw-current" ref={current} name="current_password" type="password" autoComplete="current-password" className="h-10" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pw-new">{t("account.newPw")}</Label>
              <Input id="pw-new" ref={fresh} name="new_password" type="password" autoComplete="new-password" className="h-10" />
            </div>
          </div>
          <div className="row flex items-center gap-3">
            <span id="pw-status" role="status" className={status}>{msg}</span>
            <span className="flex-1" />
            <Button type="submit" variant="outline" disabled={busy} aria-busy={busy || undefined}>{busy && <Spinner />}{t("account.updatePw")}</Button>
          </div>
        </form>
      </Block>
    </Section>
  )
}

// ------------------------------------------------------------------ members

function MembersSection({ shown }: { shown: boolean }) {
  const t = useT()
  const me = useApp((s) => s.me)!
  const { members, memberStatus } = useSettings()
  const [email, setEmail] = React.useState("")
  const [name, setName] = React.useState("")
  const [password, setPassword] = React.useState(generatePassword)
  const [admin, setAdmin] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const emailRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { if (shown) setMemberStatus("") }, [shown])

  const act = async (kind: "reset" | "remove", m: (typeof members)[number]) => {
    try {
      if (kind === "reset") {
        const pw = await promptDialog(t("members.resetPrompt", { email: m.email }), generatePassword(), { confirm: t("members.resetPw") })
        if (!pw) return
        await api("PUT", `/api/admin/users/${m.id}/password`, { password: pw })
        setMemberStatus(t("members.resetDone", { email: m.email, pw }))
      } else {
        if (!(await confirmDialog(t("members.confirmRemove", { email: m.email }), { confirm: t("members.remove"), destructive: true }))) return
        await api("DELETE", `/api/admin/users/${m.id}`)
        setMemberStatus(t("members.removed", { email: m.email }))
        loadMembers()
      }
    } catch (err: any) {
      setMemberStatus(err.message)
    }
  }

  return (
    <Section id="set-members-h" sectionId="members-section" title={t("members.title")} note={t("members.note")}>
      <Block className="py-2">
        <ul id="member-list" className="member-list m-0 list-none divide-y p-0">
          {members.map((m) => (
            <li key={m.id} className="member flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
              <span className="member-who min-w-0 flex-1">
                <span className="member-name block truncate text-sm font-medium">{m.name || m.email}</span>
                {m.name && <span className="member-email block truncate text-[13px] text-muted-foreground">{m.email}</span>}
              </span>
              <span className="member-role text-[13px] text-muted-foreground">
                {t(m.is_admin ? "members.admin" : "members.member")}{m.id === me.id ? ` (${t("members.you")})` : ""}
              </span>
              <span className="member-actions flex gap-1 max-sm:-ml-2 max-sm:w-full">
                <Button type="button" variant="ghost" size="sm" data-reset={m.id} onClick={() => act("reset", m)}>{t("members.resetPw")}</Button>
                {m.id !== me.id && (
                  <Button type="button" variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" data-remove={m.id} onClick={() => act("remove", m)}>
                    {t("members.remove")}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Block>
      <Block>
        <form
          id="member-form"
          noValidate
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              const u = await api("POST", "/api/admin/users", { email: email.trim(), name: name.trim(), password, is_admin: admin })
              setMemberStatus(t("members.created", { email: u.email, pw: password }))
              setEmail("")
              setName("")
              setAdmin(false)
              setPassword(generatePassword())
              loadMembers()
            } catch (err: any) {
              setMemberStatus(err.message)
              emailRef.current?.focus()
            } finally {
              setBusy(false)
            }
          }}
        >
          <BlockHead title={t("members.add")} />
          <div className="field-grid grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="m-email">{t("login.email")}</Label>
              <Input id="m-email" ref={emailRef} name="member_email" type="email" inputMode="email" autoComplete="off" spellCheck={false} placeholder="reader@example.com" className="h-10" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="m-name">{t("members.name")}</Label>
              <Input id="m-name" name="member_name" type="text" autoComplete="off" placeholder="Mei…" className="h-10" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="m-password">{t("members.tempPw")}</Label>
            <Input id="m-password" name="member_password" type="text" autoComplete="off" spellCheck={false} className="h-10 font-mono text-[13px]" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <Label className="check w-fit cursor-pointer font-normal">
            <Checkbox id="m-admin" checked={admin} onCheckedChange={(v) => setAdmin(v === true)} />
            {t("members.makeAdmin")}
          </Label>
          <div className="row flex items-center gap-3 border-t pt-4">
            <span id="m-status" role="status" className={status}>{memberStatus}</span>
            <span className="flex-1" />
            <Button type="submit" disabled={busy} aria-busy={busy || undefined}>{busy && <Spinner />}{t("members.create")}</Button>
          </div>
        </form>
      </Block>
    </Section>
  )
}
