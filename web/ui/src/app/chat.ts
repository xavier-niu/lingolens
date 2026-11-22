// Ask AI: conversations about a selection, in the sidebar. An answer being
// written goes on when the sidebar is hidden or another conversation is shown;
// it is kept, saved to Ask AI history, and announced when done.
import { flushSync } from "react-dom"
import { t } from "@/lib/i18n.js"
import { api, postStream, net } from "@/lib/api.js"
import { get, set, bumpChat, showBanner, getLevel, reduceMotion, type HistoryItem } from "./store"
import { providerProblem } from "./session"
import { dismissHint, hideFab } from "./engine"
import { showToast } from "./notice"
import type { AnswerView } from "./answer-view"

export interface Message { role: "user" | "assistant"; content: string }

export interface Turn {
  key: number
  question: string // empty for a turn that only says something went wrong
  answer: string // what has arrived so far, or all of it
  pending: boolean // still being answered
  error: string
  fresh?: boolean // just asked: drawn at the top of the log, with room below
  view: AnswerView | null // the bubble drawing it, while one is on screen
}

export interface Chat {
  id: string
  bookId: string
  bookTitle: string
  selection: string
  passage: string
  messages: Message[]
  asked: Set<string>
  ctl: AbortController | null
  saved?: boolean
  deleting?: boolean
  updatedAt?: string
  turns: Turn[] // what the sidebar shows of it
  live: Turn | null // the turn being answered
  resume: { id: string; questions: number } | null // asked about before
  draws: number // times drawn afresh in the sidebar
}

const MAX_SAVED_MESSAGES = 120 // as the server allows
const MAX_SENT_MESSAGES = 39 // the server takes 40; odd, so it starts with a question

let turnKeys = 0
const newTurn = (question: string, fields: Partial<Turn> = {}): Turn =>
  ({ key: ++turnKeys, question, answer: "", pending: false, error: "", view: null, ...fields })

export const chats = {
  current: null as Chat | null, // the conversation being had (state.chat)
  drawn: null as Chat | null, // the one whose turns the sidebar holds
  live: new Map<string, Chat>(), // still being answered, by id
}

// Set by the sidebar: update its "jump to latest" button.
export const chatUI = {
  updateJump: () => {},
}

// Conversations are saved to the account (Ask AI history) under an id made
// here, so the first save can happen before the server knows the chat.
function newChatId() {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("")
}

let hideTimer = 0

function showDrawer(mode: "chat" | "history") {
  clearTimeout(hideTimer)
  set({ drawer: "open", chatMode: mode })
  document.body.classList.add("chat-open")
  updateHistoryDot()
}

export function openChat(selection: string, passage: string, autoQuestion?: string) {
  dismissHint()
  const book = get().book
  chats.current = {
    id: newChatId(), bookId: book ? String(book.id) : "", bookTitle: book?.title || "",
    selection, passage, messages: [], asked: new Set(), ctl: null, turns: [], live: null, resume: null, draws: 0,
  }
  showConversation()
  if (autoQuestion) sendChat(autoQuestion)
  else {
    // Now, while the tap that asked is still going: iOS brings up the keyboard
    // only for focus given then.
    document.getElementById("chat-input")?.focus({ preventScroll: true })
    offerResume(chats.current)
  }
}

// Draw the current conversation afresh in the sidebar: its earlier turns, and
// the one still being answered.
function showConversation() {
  const chat = chats.current!
  chats.drawn = chat
  chat.draws++
  chat.resume = null
  chat.turns = []
  for (let i = 0; i + 1 < chat.messages.length; i += 2) {
    chat.turns.push(newTurn(chat.messages[i].content, { answer: chat.messages[i + 1].content }))
  }
  if (chat.live) chat.turns.push(chat.live)
  // Drawn at once, so the input is there to take the cursor.
  flushSync(() => {
    showDrawer("chat")
    bumpChat()
  })
}

// Back to a conversation: as it was left (scrolled where it was, an answer
// still arriving) when the sidebar still holds it, otherwise drawn afresh.
export function openConversation(chat: Chat) {
  dismissHint()
  hideFab()
  if (chats.current !== chat || chats.drawn !== chat) {
    chats.current = chat
    showConversation()
    return
  }
  showDrawer("chat")
  requestAnimationFrame(() => chatUI.updateJump())
}

const inView = () => get().drawer === "open" && get().chatMode === "chat"

// A dot on the header's history button while an answer arrives out of sight.
export function updateHistoryDot() {
  const shown = inView()
  const away = [...chats.live.values()].some((c) => !(shown && c === chats.drawn))
  if (get().liveAway !== away) set({ liveAway: away })
}

// Asking about something asked about before (same text, same selection):
// offer to pick that conversation up again.
async function offerResume(chat: Chat) {
  if (!chat.bookId || !net.online) return
  let list: HistoryItem[]
  try {
    list = await api("GET", `/api/chats?book=${encodeURIComponent(chat.bookId)}`)
  } catch {
    return
  }
  const prev = list.find((c) => c.selection === chat.selection.trim())
  if (!prev || chats.current !== chat || chat.messages.length) return
  chat.resume = { id: prev.id, questions: prev.questions }
  bumpChat()
}

export async function resumeChat(id: string) {
  const here = [chats.current, ...chats.live.values()].find((c) => c?.id === id)
  if (here) {
    openConversation(here)
    return
  }
  let c: any
  try {
    c = await api("GET", `/api/chats/${encodeURIComponent(id)}`)
  } catch (err: any) {
    showBanner(err.message)
    return
  }
  chats.current = {
    id: c.id, bookId: c.bookId, bookTitle: c.bookTitle, selection: c.selection, passage: c.passage,
    messages: c.messages, asked: new Set(c.messages.filter((m: Message) => m.role === "user").map((m: Message) => m.content)), ctl: null,
    saved: true, turns: [], live: null, resume: null, draws: 0,
  }
  setHist({ items: null }) // its order changes once it's continued
  showConversation()
}

// Save after each answer. Only the latest turns are kept once a conversation
// gets very long; the server sends the model fewer still.
function saveChat(chat: Chat) {
  const messages = chat.messages.slice(-MAX_SAVED_MESSAGES)
  chat.saved = true
  setHist({ items: null })
  api("PUT", `/api/chats/${encodeURIComponent(chat.id)}`, {
    bookId: chat.bookId, selection: chat.selection, passage: chat.passage, messages,
  }).catch(() => { /* history is best effort */ })
}

// ------------------------------------------------------------------ Ask AI history

const setHist = (patch: Partial<ReturnType<typeof get>["hist"]>) => set((s) => ({ hist: { ...s.hist, ...patch } }))

const inBook = () => (get().view === "reader" && get().book ? get().book : null)

export async function openHistory() {
  dismissHint()
  hideFab()
  showDrawer("history")
  const book = inBook()
  setHist({ scope: book ? "book" : "all" })
  if (!get().hist.items) {
    setHist({ status: t("chat.histLoading") })
    try {
      setHist({ items: await api("GET", "/api/chats"), status: "" })
    } catch (err: any) {
      setHist({ status: err.offline ? t("net.needsConnection") : err.message })
    }
  }
  // Nothing about this text yet: show everything instead of an empty list.
  if (book && get().hist.items && !historyItems().some((c) => c.bookId === String(book.id))) setHist({ scope: "all" })
}

// The saved conversations, with this session's first: the server may not have
// their latest turn yet, or any turn while the first answer is still arriving.
export function historyItems(items = get().hist.items): HistoryItem[] {
  const mine = [...new Set([...chats.live.values(), chats.current])].filter((c): c is Chat => !!c?.messages.length && (!!c.ctl || !!c.saved))
  return [
    ...mine.map((c) => {
      const qs = c.messages.filter((m) => m.role === "user")
      return {
        id: c.id, bookId: c.bookId, bookTitle: c.bookTitle, selection: c.selection,
        question: qs[0]?.content || "", questions: qs.length, updatedAt: c.updatedAt || new Date().toISOString(), live: !!c.ctl,
      }
    }),
    ...(items || []).filter((x) => !mine.some((c) => c.id === x.id)),
  ]
}

export async function deleteChat(id: string) {
  try {
    await api("DELETE", `/api/chats/${encodeURIComponent(id)}`)
  } catch (err: any) {
    if (err.status !== 404) {
      showBanner(err.message)
      return
    }
  }
  setHist({ items: (get().hist.items || []).filter((c) => c.id !== id) })
  // Still being answered: stop, and don't save it again.
  const live = chats.live.get(id)
  if (live) {
    live.deleting = true
    live.ctl?.abort()
    chats.live.delete(id)
  }
  if (chats.current?.id === id) { // asking more starts a new one
    chats.current.id = newChatId()
    chats.current.saved = false
  }
  updateHistoryDot()
  bumpChat()
}

export function setHistScope(scope: "book" | "all") {
  setHist({ scope })
}

// Hides the sidebar. An answer being written goes on (see chats.live).
export function closeChat() {
  document.body.classList.remove("chat-open")
  const d = get().drawer
  if (d === "closed") return
  if (reduceMotion()) {
    set({ drawer: "closed" })
    updateHistoryDot()
    return
  }
  set({ drawer: "closing" })
  updateHistoryDot()
  clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => { if (get().drawer === "closing") set({ drawer: "closed" }) }, 160)
}

// The history button in the header: open history, or close it.
export function toggleHistory() {
  if (get().drawer === "open" && get().chatMode === "history") closeChat()
  else openHistory()
}

// The history button in the sidebar: to history, or back to the conversation.
export function toggleSidebarHistory() {
  if (get().chatMode === "history" && chats.current) openConversation(chats.current)
  else if (get().chatMode !== "history") openHistory()
}

// Forget every conversation (signing out).
export function resetChats() {
  for (const c of chats.live.values()) c.ctl?.abort()
  chats.current?.ctl?.abort()
  chats.live.clear()
  chats.current = chats.drawn = null
  setHist({ items: null })
  closeChat()
  set({ drawer: "closed", liveAway: false })
}

// ------------------------------------------------------------------ asking

// A turn that only says what went wrong (no provider, offline).
function errorTurn(chat: Chat, error: string) {
  for (const x of chat.turns) x.fresh = false
  chat.turns = [...chat.turns, newTurn("", { error, fresh: true })]
  bumpChat()
}

export async function sendChat(question: string) {
  const chat = chats.current
  question = question.trim()
  if (!chat || !question || chat.ctl) return
  const problem = providerProblem()
  if (problem) {
    errorTurn(chat, problem)
    showBanner(problem, "error", { settingsLink: true })
    return
  }
  if (!net.online) {
    errorTurn(chat, t("net.chatOffline"))
    return
  }
  chat.messages.push({ role: "user", content: question })
  chat.asked.add(question)
  chat.updatedAt = new Date().toISOString()
  chat.resume = null
  // A new question goes to the top of the conversation, with room below for the
  // answer, so the answer is read as it arrives instead of chasing the bottom.
  for (const x of chat.turns) x.fresh = false
  const turn = newTurn(question, { pending: true, fresh: true })
  chat.turns = [...chat.turns, turn]

  const ctl = new AbortController()
  chat.ctl = ctl
  chat.live = turn
  chats.live.set(chat.id, chat)
  setHist({ items: null }) // listed from here until saved
  bumpChat()
  ctl.signal.addEventListener("abort", () => turn.view?.flush())
  let answer = ""
  let error = ""
  try {
    const events = await postStream("/api/chat", {
      level: getLevel(), passage: chat.passage, selection: chat.selection,
      messages: chat.messages.slice(-MAX_SENT_MESSAGES),
    }, ctl.signal)
    for await (const ev of events) {
      if (ev.type === "delta") {
        const first = !answer
        answer += ev.text
        turn.answer = answer
        turn.view?.push(answer)
        if (first) bumpChat() // "Thinking…" makes way for the text
      } else if (ev.type === "error") {
        error = ev.error
      }
    }
  } catch (err: any) {
    if (err.name !== "AbortError") error = err.message
  }
  await turn.view?.end()
  turn.pending = false
  // The conversation may be out of sight by now (sidebar hidden, another
  // conversation open): the answer is kept and saved all the same.
  chat.ctl = null
  chat.live = null
  if (chats.live.get(chat.id) === chat) chats.live.delete(chat.id)
  chat.updatedAt = new Date().toISOString()
  if (answer) {
    chat.messages.push({ role: "assistant", content: answer })
    if (!chat.deleting) saveChat(chat)
    chat.deleting = false
  } else {
    chat.messages.pop() // keep user/assistant alternation for the next turn
    chat.asked.delete(question)
  }
  turn.error = error // under the question, and the answer if any arrived
  updateHistoryDot()
  bumpChat()
  // Answered out of sight: say so, with a way back to it.
  const shown = chats.current === chat && chats.drawn === chat
  if (answer && !(shown && inView()) && !ctl.signal.aborted && get().me) {
    showToast(t("chat.answered"), { icon: "spark", action: { label: t("chat.show"), run: () => openConversation(chat) } })
  }
}

export function stopChat() {
  chats.current?.ctl?.abort()
}
