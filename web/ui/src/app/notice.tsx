// A short notice under the header that goes away on its own ("This text was
// updated", "Ask AI has answered"), shown with sonner. `action` adds a button:
// { label, run }; `icon` is "update" or "spark" (Ask AI). It stays while the
// pointer is on it.
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import { SparkIcon } from "@/components/icons"

let current: string | number | null = null
let seq = 0

export function showToast(text: string, { action = null as null | { label: string; run: () => void }, ms = 6000, icon = "update" } = {}) {
  hideToast()
  const id = `notice-${++seq}`
  current = id
  toast.custom(() => (
    <div
      id="toast"
      role="status"
      className="pointer-events-auto mx-auto flex min-h-10 max-w-[calc(100vw-32px)] items-center gap-2.5 rounded-[20px] bg-primary py-1.5 pr-1.5 pl-3.5 text-[13.5px] leading-snug text-primary-foreground shadow-(--shadow-float) has-[#toast-action]:pr-1.5 not-has-[#toast-action]:pr-4"
    >
      {icon === "spark"
        ? <SparkIcon className="toast-icon spark size-[15px] fill-current opacity-85" />
        : <RefreshCw className="toast-icon size-[15px] shrink-0 opacity-85" strokeWidth={2.2} data-icon="update" aria-hidden />}
      <span id="toast-text" className="min-w-0">{text}</span>
      {action && (
        <button
          id="toast-action"
          type="button"
          className="h-7 shrink-0 rounded-full bg-primary-foreground/15 px-3 font-semibold transition-colors hover:bg-primary-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onClick={() => { hideToast(); action.run() }}
        >
          {action.label}
        </button>
      )}
    </div>
  ), { id, duration: action ? Math.max(ms, 9000) : ms, unstyled: true, onAutoClose: () => { if (current === id) current = null } })
}

export function hideToast() {
  if (current !== null) toast.dismiss(current)
  current = null
}
