import * as React from "react"
import { get, isTouch } from "@/app/store"
import { useT } from "@/app/hooks"
import { init } from "@/app/session"
import { startReadingClock, noteInput, noteScroll } from "@/app/progress"
import { annotatingBusy, closeCard, hideFab, maybeShowFab, updateProgress } from "@/app/engine"
import { closeChat } from "@/app/chat"
import { receiveClip } from "@/app/clip"
import { Header } from "@/components/header"
import { Banner } from "@/components/banner"
import { ChatPanel, useChatDismiss } from "@/components/chat-panel"
import { SourceDialog } from "@/components/source-dialog"
import { ContentsDialog } from "@/components/dialogs"
import { ConfirmHost } from "@/components/confirm"
import { SparkGradient } from "@/components/icons"
import { Toaster } from "@/components/ui/sonner"
import { LoginView } from "@/views/login-view"
import { LibraryView } from "@/views/library-view"
import { ReaderView, WordCard, AskFab, Hint, useCardDismiss } from "@/views/reader-view"
import { SettingsView } from "@/views/settings-view"
import { ClipView } from "@/views/clip-view"

let started = false

export function App() {
  const t = useT()
  const fabPressedAt = React.useRef(0)
  useCardDismiss()
  useChatDismiss()
  useSelectionWatch(fabPressedAt)
  useReadingInput()
  useEscape()

  // Start once the page is drawn: the reading engine needs #article.
  React.useEffect(() => {
    if (started) return
    started = true
    window.addEventListener("message", receiveClip)
    startReadingClock()
    init()
  }, [])

  return (
    <>
      <SparkGradient />
      <a
        className="skip-link fixed top-[-48px] left-3 z-[100] rounded-md bg-primary px-3.5 py-2 font-semibold text-primary-foreground no-underline focus-visible:top-3"
        href="#main"
        // Routes live in the #hash: move focus to the page without changing it.
        onClick={(e) => {
          e.preventDefault()
          const main = document.getElementById("main")!
          main.tabIndex = -1
          main.focus()
        }}
      >
        {t("a11y.skip")}
      </a>
      <Header />
      <Banner />
      <main id="main" className="px-[clamp(16px,4vw,32px)] pb-24 in-data-[view=login]:p-0">
        <LoginView />
        <LibraryView />
        <ReaderView />
        <SettingsView />
        <ClipView />
      </main>
      <WordCard />
      <AskFab pressedAt={fabPressedAt} />
      <Hint />
      <ChatPanel />
      <SourceDialog />
      <ContentsDialog />
      <ConfirmHost />
      <Toaster
        position="top-center"
        offset={{ top: 68 }}
        mobileOffset={{ top: 60, left: 16, right: 16 }}
        visibleToasts={1}
        className="lingolens-toaster"
      />
    </>
  )
}

// Selecting text in the article offers Ask AI. Touch devices select by
// long-press and handles, with no mouseup: the button shows once the selection
// has settled.
function useSelectionWatch(pressedAt: React.RefObject<number>) {
  React.useEffect(() => {
    let timer = 0
    const up = (e: MouseEvent) => {
      if ((e.target as Element).closest?.("#ask-fab, #card, #chat")) return
      setTimeout(maybeShowFab, 0)
    }
    const key = (e: KeyboardEvent) => { if (e.shiftKey) maybeShowFab() }
    const change = () => {
      const sel = window.getSelection()
      clearTimeout(timer)
      // A tap on the button can clear the selection before its click arrives.
      if (!sel || sel.isCollapsed) { if (Date.now() - pressedAt.current > 800) hideFab() }
      else if (isTouch()) timer = window.setTimeout(maybeShowFab, 400)
    }
    document.addEventListener("mouseup", up)
    document.addEventListener("keyup", key)
    document.addEventListener("selectionchange", change)
    return () => {
      document.removeEventListener("mouseup", up)
      document.removeEventListener("keyup", key)
      document.removeEventListener("selectionchange", change)
    }
  }, [pressedAt])
}

// Reading progress counts only while someone is there: scrolling, moving the
// pointer, typing. Scrolling also brings the paragraphs on screen forward.
function useReadingInput() {
  React.useEffect(() => {
    const scroll = () => {
      noteScroll()
      if (annotatingBusy()) updateProgress()
    }
    window.addEventListener("scroll", scroll, { passive: true })
    for (const type of ["pointermove", "pointerdown", "keydown"]) window.addEventListener(type, noteInput, { passive: true })
    return () => {
      window.removeEventListener("scroll", scroll)
      for (const type of ["pointermove", "pointerdown", "keydown"]) window.removeEventListener(type, noteInput)
    }
  }, [])
}

// Escape closes the word card, else the Ask AI sidebar (menus and dialogs
// close themselves).
function useEscape() {
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (get().card) { closeCard(); return }
      if (document.querySelector("[data-radix-popper-content-wrapper], [role=dialog][data-state=open], [role=alertdialog][data-state=open]")) return
      if (get().drawer === "open") closeChat()
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])
}
