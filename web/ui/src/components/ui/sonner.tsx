import * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// The theme comes from <html class="dark">, which theme.js keeps in step with
// the chosen theme (or the device's), not from next-themes.
function useDark() {
  const get = () => document.documentElement.classList.contains("dark")
  const [dark, setDark] = React.useState(get)
  React.useEffect(() => {
    const watch = new MutationObserver(() => setDark(get()))
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => watch.disconnect()
  }, [])
  return dark
}

const Toaster = ({ ...props }: ToasterProps) => {
  const dark = useDark()

  return (
    <Sonner
      theme={dark ? "dark" : "light"}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
