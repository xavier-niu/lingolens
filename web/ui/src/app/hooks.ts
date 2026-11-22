import { t } from "@/lib/i18n.js"
import { useApp } from "./store"

// t() for components: redraws them when the interface language changes.
export function useT(): (key: string, vars?: Record<string, unknown>) => any {
  useApp((s) => s.lang)
  return t
}
