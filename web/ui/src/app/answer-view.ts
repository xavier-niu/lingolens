// Streams an answer into el. Text is revealed at a smoothly varying speed that
// trails the network by a moment, so bursts and stalls even out. Each new
// character fades in over FADE ms; finished Markdown blocks are rendered once,
// and only blocks with characters still fading are re-rendered. A caret shows
// only when the stream pauses.
import { marked, renderToken } from "@/lib/markdown"
import { reduceMotion } from "./store"

const FADE = 340 // ms for a new character to fade in
const LAG = 420 // how far, in ms of reading, the reveal trails what has arrived

// Markdown cut off mid-stream: drop a dangling marker at the end (a lone "#",
// "-", "1." or "**") and close an open bold, italic or code span, so syntax
// never flashes on screen before it takes effect.
function tidyTail(src: string) {
  src = src.replace(/(^|\n)[ \t]*(#{1,6}|>|[-*+]|\d+[.)]?)[ \t]*$/, "$1").replace(/[*_`~]+$/, "")
  if ((src.match(/```/g) || []).length % 2) return src // inside a code block
  const block = src.slice(src.lastIndexOf("\n\n") + 1).replace(/```/g, "")
  let close = ""
  if ((block.match(/`/g) || []).length % 2) close += "`"
  const plain = block.replace(/`[^`]*`?/g, "")
  const singles = plain.replace(/\*\*/g, "").replace(/^[ \t]*\*[ \t]/gm, "")
  if ((singles.match(/\*/g) || []).length % 2) close += "*"
  if ((plain.match(/\*\*/g) || []).length % 2) close += "**"
  return close ? src.trimEnd() + close : src // a closer after a space wouldn't count
}

export interface AnswerView {
  push(text: string): void
  flush(): void
  end(): Promise<void>
}

interface Block { node: HTMLElement; raw?: string; start?: number; end?: number; fading?: boolean }

// onReveal: called as text appears (the sidebar's "jump to latest" button).
export function answerView(el: HTMLElement, onReveal: () => void = () => {}): AnswerView {
  const blocks: Block[] = []
  const times: number[] = [] // when each character of the answer was revealed
  let live: HTMLElement | null = null // node of the block still being written
  let target = ""
  let shown = 0
  let ended = false
  let raf = 0
  let last = 0
  let speed = 0 // characters per ms
  let carry = 0 // fractional characters not yet shown
  let fadingNow = false // characters on screen are still fading in
  let resolveDone!: () => void
  const done = new Promise<void>((r) => { resolveDone = r })
  const caret = document.createElement("span")
  caret.className = "caret"
  const fade = reduceMotion() ? 0 : FADE

  // Wrap the youngest characters of node in spans whose opacity follows their
  // age. Rendered text is matched back to the source from the end, skipping
  // Markdown syntax. Returns whether anything is still fading.
  const applyFade = (node: HTMLElement, start: number, end: number, now: number) => {
    if (!fade || end <= start || now - times[end - 1] >= fade) return false
    const texts: Text[] = []
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) if ((walker.currentNode as Text).data.trim()) texts.push(walker.currentNode as Text)
    let p = end - 1
    for (let k = texts.length - 1; k >= 0; k--) {
      const tn = texts[k]
      const str = tn.data
      const alpha: number[] = []
      let j = str.length - 1
      for (; j >= 0; j--) {
        const ch = str[j]
        let q = p
        while (q >= start && p - q < 8 && target[q] !== ch) q--
        if (q >= start && target[q] === ch) p = q
        const age = now - (times[Math.max(p, start)] ?? 0)
        if (age >= fade) break
        const x = Math.max(0, age / fade)
        alpha[j] = 1 - (1 - x) * (1 - x) // ease out
        if (target[p] === ch) p--
      }
      if (j === str.length - 1) return k < texts.length - 1 // everything earlier is settled
      const frag = document.createDocumentFragment()
      if (j >= 0) frag.append(str.slice(0, j + 1))
      // One span per run of similar opacity keeps the DOM small.
      for (let i = j + 1; i < str.length;) {
        const o = Math.round(alpha[i] * 20) / 20
        let e = i + 1
        while (e < str.length && Math.round(alpha[e] * 20) / 20 === o) e++
        const span = document.createElement("span")
        span.style.opacity = String(o)
        span.textContent = str.slice(i, e)
        frag.append(span)
        i = e
      }
      tn.replaceWith(frag)
      if (j >= 0) return true
    }
    return true
  }

  type Part = { tok: any; start: number; end: number }
  const render = (b: Block, part: Part, links: any, now: number) => {
    b.node.innerHTML = renderToken(part.tok, links)
    b.raw = part.tok.raw
    b.start = part.start
    b.end = part.end
    b.fading = applyFade(b.node, part.start, part.end, now)
  }

  const paint = (now: number) => {
    const final = ended && shown >= target.length
    const src = final ? target : tidyTail(target.slice(0, shown))
    const toks = marked.lexer(src, { gfm: true })
    const parts: Part[] = []
    let pos = 0
    for (const tok of toks) {
      const len = tok.raw.length
      if (tok.type !== "space") parts.push({ tok, start: Math.min(pos, shown), end: Math.min(pos + len, shown) })
      pos += len
    }
    const stable = final ? parts.length : Math.max(0, parts.length - 1)
    let fading = false
    for (let i = 0; i < stable; i++) {
      let b = blocks[i]
      if (b && b.raw === parts[i].tok.raw && !b.fading) continue
      if (!b) {
        // The block being written is finished: keep its node.
        b = blocks[i] = { node: live || document.createElement("div") }
        if (live) live = null
        else { b.node.className = "blk enter"; el.append(b.node) }
      }
      render(b, parts[i], toks.links, now)
      fading ||= !!b.fading
    }
    for (const b of blocks.splice(stable)) b.node.remove()
    const tail = final ? null : parts[stable]
    if (!tail) {
      live?.remove()
      live = null
      if (final) caret.remove()
      else el.append(caret)
      return fading
    }
    if (!live) {
      live = document.createElement("div")
      live.className = "blk enter"
      el.append(live)
    }
    const b: Block = { node: live }
    render(b, tail, toks.links, now)
    let at: Element = live
    while (at.lastElementChild && !/^(BR|HR|IMG|TABLE|SPAN)$/.test(at.lastElementChild.tagName)) at = at.lastElementChild
    at.append(caret)
    return fading || !!b.fading
  }

  const tick = (now: number) => {
    raf = 0
    const dt = Math.min(50, last ? now - last : 16)
    last = now
    const backlog = target.length - shown
    let revealed = 0
    if (backlog > 0) {
      if (!fade) revealed = backlog
      else {
        // Ease the speed toward what clears the backlog in LAG ms (faster
        // once the stream has ended), so bursts don't jerk the text.
        const want = Math.max(backlog / (ended ? LAG / 2 : LAG), 0.02)
        speed += (want - speed) * Math.min(1, dt / 140)
        carry += Math.max(speed, 0.02) * dt
        revealed = Math.min(backlog, Math.floor(carry))
        carry -= revealed
        const c = target.charCodeAt(shown + revealed - 1)
        if (revealed && c >= 0xd800 && c <= 0xdbff && revealed < backlog) revealed++ // keep surrogate pairs whole
      }
      // Spread this frame's characters over the frame, for an even fade.
      for (let k = 0; k < revealed; k++) times[shown + k] = now - dt + (dt * (k + 1)) / revealed
      shown += revealed
    } else {
      speed *= 0.5
      carry = 0
    }
    el.classList.toggle("waiting", !ended && shown >= target.length)
    if (revealed || fadingNow) fadingNow = paint(now)
    if (revealed) onReveal()
    if (shown < target.length || fadingNow) raf = requestAnimationFrame(tick)
    else if (ended) { paint(now); onReveal(); resolveDone() }
  }
  const kick = () => { if (!raf) { last = 0; raf = requestAnimationFrame(tick) } }
  return {
    push(text) { target = text; kick() },
    // Stop pacing: show everything received so far (it still fades in).
    flush() { const now = performance.now(); for (let i = shown; i < target.length; i++) times[i] = now; shown = target.length },
    end() { ended = true; kick(); return done },
  }
}
