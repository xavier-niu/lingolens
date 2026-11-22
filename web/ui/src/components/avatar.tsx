import { cn } from "@/lib/utils"
import type { User } from "@/app/store"

// Muted, saturated colours that carry a white letter in light and dark themes.
const COLORS = ["#2b4a75", "#2f6763", "#3f6b45", "#b0533d", "#9a6a1f", "#4b5563"]

// The signed-in person: the first letter of the name (or email) on a colour
// that stays the same for each account.
export function Avatar({ user, id, size = "default", className }: { user: User; id?: string; size?: "default" | "lg"; className?: string }) {
  const label = (user.name || user.email || "?").trim()
  const initial = ([...label][0] || "?").toLocaleUpperCase()
  let h = 0
  for (const ch of user.email || label) h = (h * 31 + ch.codePointAt(0)!) % 6
  return (
    <span
      id={id}
      data-c={h}
      aria-hidden="true"
      style={{ backgroundColor: COLORS[h] }}
      className={cn(
        "avatar inline-grid shrink-0 place-items-center rounded-full leading-none font-semibold text-white select-none",
        size === "lg" ? "size-10 text-[17px]" : "size-[30px] text-[13.5px]",
        className,
      )}
    >
      {initial}
    </span>
  )
}
