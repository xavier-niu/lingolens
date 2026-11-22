import * as React from "react"
import { useApp } from "@/app/store"
import { useT } from "@/app/hooks"
import { chooseLanguage, submitLogin } from "@/app/session"
import { LogoMark } from "@/components/icons"
import { Segmented } from "@/components/segmented"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"

// Sign-in, or first-run setup while the server has no accounts.
export function LoginView() {
  const t = useT()
  const view = useApp((s) => s.view)
  const setup = useApp((s) => !!s.config.needs_setup)
  const error = useApp((s) => s.loginError)
  const lang = useApp((s) => s.lang)
  const [busy, setBusy] = React.useState(false)
  const email = React.useRef<HTMLInputElement>(null)
  const password = React.useRef<HTMLInputElement>(null)
  const confirm = React.useRef<HTMLInputElement>(null)
  const shown = view === "login"

  React.useEffect(() => {
    if (shown) email.current?.focus()
  }, [shown])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const field = await submitLogin(email.current!.value, password.current!.value, confirm.current?.value ?? "")
    setBusy(false)
    if (!field) {
      password.current!.value = ""
      if (confirm.current) confirm.current.value = ""
      return
    }
    const el = { email, password, confirm }[field].current
    if (field === "email") el?.focus()
    else el?.select()
  }

  const k = (key: string) => t(setup ? `setup.${key}` : `login.${key}`)

  return (
    <section
      id="login-view"
      hidden={!shown}
      className="login relative flex min-h-dvh flex-col items-center justify-center gap-5 overflow-hidden px-4 py-8"
    >
      {/* A quiet backdrop: the gloss colours, far off. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60rem_30rem_at_15%_-10%,color-mix(in_srgb,var(--phrase)_9%,transparent),transparent),radial-gradient(50rem_28rem_at_95%_110%,color-mix(in_srgb,var(--gloss)_8%,transparent),transparent)]" />
      <form
        id="login-form"
        noValidate
        onSubmit={submit}
        className="login-card w-full max-w-[400px] rounded-2xl border bg-card px-7 pt-8 pb-6 shadow-(--shadow-soft) max-sm:px-5 max-sm:pt-6 max-sm:pb-5"
      >
        <LogoMark className="mb-5 size-11" />
        <h1 id="login-title" className="m-0 font-serif text-2xl leading-tight font-semibold tracking-tight">{k("title")}</h1>
        <p id="login-sub" className="login-sub mt-1.5 mb-6 text-sm text-muted-foreground">{k("sub")}</p>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="login-email">{t("login.email")}</Label>
            <Input
              id="login-email" ref={email} name="email" type="email" inputMode="email" autoComplete="username"
              spellCheck={false} placeholder="you@example.com" className="h-10"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="login-password">{t("login.password")}</Label>
            <Input
              id="login-password" ref={password} name="password" type="password" className="h-10"
              autoComplete={setup ? "new-password" : "current-password"}
              placeholder={setup ? t("setup.passwordHint") : ""}
            />
          </div>
          <div id="setup-confirm-field" className="grid gap-2" hidden={!setup}>
            <Label htmlFor="setup-confirm">{t("setup.confirm")}</Label>
            <Input id="setup-confirm" ref={confirm} name="confirm" type="password" autoComplete="new-password" className="h-10" />
          </div>
        </div>

        <p id="login-error" role="alert" className="mt-3 mb-0 text-[13px] text-destructive empty:hidden">{error}</p>
        <Button id="login-submit" type="submit" size="lg" className="mt-6 h-11 w-full text-[15px]" disabled={busy} aria-busy={busy || undefined}>
          {busy && <Spinner />}
          {k("submit")}
        </Button>
        <p id="login-note" className="login-note mt-4 mb-0 text-center text-[13px] text-muted-foreground">{k("note")}</p>
      </form>
      <Segmented
        id="login-lang" label={t("menu.language")} attr="lang" value={lang} onChange={chooseLanguage}
        className="login-lang bg-card/70"
        options={[{ value: "en", content: "English" }, { value: "zh", content: "中文" }]}
      />
    </section>
  )
}
