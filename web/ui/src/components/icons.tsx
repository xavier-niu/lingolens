import type { SVGProps } from "react"
import { cn } from "@/lib/utils"

// The logo: one word in a line of text, with its gloss above it.
export function LogoMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg className={cn("mark size-7 shrink-0", className)} viewBox="0 0 32 32" aria-hidden="true" {...props}>
      <rect className="m-tile" width="32" height="32" rx="7" />
      <rect className="m-gloss" x="7" y="7" width="9" height="3.4" rx="1.7" />
      <rect className="m-word" x="6" y="13" width="12" height="5" rx="2.5" />
      <rect className="m-line" x="20.5" y="13" width="5.5" height="5" rx="2.5" />
      <rect className="m-line" x="6" y="21.5" width="7.5" height="5" rx="2.5" />
      <rect className="m-line" x="16" y="21.5" width="10" height="5" rx="2.5" />
    </svg>
  )
}

const SPARK = "M12 2.5c.6 4.9 2.6 6.9 7.5 7.5-4.9.6-6.9 2.6-7.5 7.5-.6-4.9-2.6-6.9-7.5-7.5 4.9-.6 6.9-2.6 7.5-7.5zM19 15.5c.25 2 1.1 2.85 3 3.1-1.9.25-2.75 1.1-3 3.1-.25-2-1.1-2.85-3-3.1 1.9-.25 2.75-1.1 3-3.1z"

// Ask AI's sparkle. Filled with the gloss gradient (.spark, see SparkGradient)
// unless a class sets another fill.
export function SparkIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg className={cn("shrink-0", className)} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d={SPARK} />
    </svg>
  )
}

// The gradient .spark fills with, defined once on the page.
export function SparkGradient() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
      <defs>
        <linearGradient id="spark-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--gloss)" }} />
          <stop offset="1" style={{ stopColor: "var(--phrase)" }} />
        </linearGradient>
      </defs>
    </svg>
  )
}

// Reading options' "Aa".
export function TextSizeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M3 18L8 6l5 12M4.6 14h6.8M15 12.2c.6-1 1.6-1.5 2.8-1.5 1.8 0 2.9 1 2.9 2.8V18m0-3.6c-.9-.4-1.8-.6-2.8-.6-1.6 0-2.9.7-2.9 2.1s1.1 2.1 2.4 2.1c1.5 0 2.7-.8 3.3-2" />
    </svg>
  )
}

// Line widths: three lines of text, narrow to wide.
export function WidthIcon({ width, ...props }: SVGProps<SVGSVGElement> & { width: "n" | "m" | "w" }) {
  const d = { n: "M7.5 7h9M7.5 12h9M7.5 17h6", m: "M5.5 7h13M5.5 12h13M5.5 17h9", w: "M2.5 7h19M2.5 12h19M2.5 17h13" }[width]
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" {...props}>
      <path d={d} />
    </svg>
  )
}
