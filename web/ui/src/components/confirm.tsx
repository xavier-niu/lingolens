// Questions that need an answer before something happens: "Delete this text?",
// or a new password to set. confirmDialog() and promptDialog() resolve with the
// answer; <ConfirmHost/> draws them.
import * as React from "react"
import { create } from "zustand"
import { t } from "@/lib/i18n.js"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { useT } from "@/app/hooks"

interface Ask {
  title: string
  body?: string
  confirm: string
  destructive?: boolean
  prompt?: { value: string; label: string }
  resolve: (value: string | null) => void
}

const useAsk = create<{ ask: Ask | null }>()(() => ({ ask: null }))

function ask(a: Omit<Ask, "resolve">) {
  return new Promise<string | null>((resolve) => {
    useAsk.getState().ask?.resolve(null)
    useAsk.setState({ ask: { ...a, resolve } })
  })
}

export async function confirmDialog(title: string, { body = "", confirm = t("confirm.ok"), destructive = false } = {}) {
  return (await ask({ title, body, confirm, destructive })) !== null
}

export function promptDialog(title: string, value: string, { label = "", confirm = t("confirm.ok") } = {}) {
  return ask({ title, confirm, prompt: { value, label } })
}

export function ConfirmHost() {
  const t = useT()
  const a = useAsk((s) => s.ask)
  const [value, setValue] = React.useState("")
  React.useEffect(() => { setValue(a?.prompt?.value ?? "") }, [a])
  const finish = (answer: string | null) => {
    if (!a) return
    useAsk.setState({ ask: null })
    a.resolve(answer)
  }
  return (
    <AlertDialog open={!!a} onOpenChange={(open) => { if (!open) finish(null) }}>
      <AlertDialogContent id="confirm-dialog" className="sm:max-w-md">
        <form onSubmit={(e) => { e.preventDefault(); finish(a?.prompt ? value : "ok") }} className="contents">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">{a?.title}</AlertDialogTitle>
            {a?.body ? <AlertDialogDescription>{a.body}</AlertDialogDescription> : <AlertDialogDescription className="sr-only">{a?.title}</AlertDialogDescription>}
          </AlertDialogHeader>
          {a?.prompt && (
            <Input
              id="confirm-input"
              aria-label={a.prompt.label || a.title}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel id="confirm-cancel" type="button">{t("settings.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              id="confirm-ok"
              type="submit"
              className={a?.destructive ? "bg-destructive text-white hover:bg-destructive/90 dark:text-background" : undefined}
              disabled={!!a?.prompt && !value.trim()}
              onClick={(e) => { e.preventDefault(); finish(a?.prompt ? value : "ok") }}
            >
              {a?.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}
