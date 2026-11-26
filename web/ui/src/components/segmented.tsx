import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export interface SegmentOption {
  value: string
  content: ReactNode
  label?: string // for screen readers and the tooltip, when the content is an icon
  lang?: string
}

// A row of buttons, one pressed: the choice. Each button carries its value as
// data-<attr>, so a choice can be found by what it means.
export function Segmented({
  id, label, attr, value, options, onChange, className, buttonClassName, hidden, ...rest
}: {
  id?: string
  hidden?: boolean
  label: string
  attr: string
  value: string
  options: SegmentOption[]
  onChange: (value: string) => void
  className?: string
  buttonClassName?: string
  [data: `data-${string}`]: string | undefined
}) {
  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      hidden={hidden}
      className={cn("inline-flex gap-0.5 rounded-[10px] bg-muted p-[3px] ring-1 ring-border/60 ring-inset", className)}
      {...rest}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          {...{ [`data-${attr}`]: o.value }}
          aria-pressed={o.value === value}
          aria-label={o.label}
          title={o.label}
          lang={o.lang}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-7 min-w-8 flex-1 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] duration-150 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/35 aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[0_1px_2px_rgb(0_0_0/.08),0_0_0_.5px_rgb(0_0_0/.06)] dark:aria-pressed:bg-accent dark:aria-pressed:shadow-none [&_svg]:size-[15px] [&_svg]:shrink-0",
            buttonClassName,
          )}
        >
          {o.content}
        </button>
      ))}
    </div>
  )
}
