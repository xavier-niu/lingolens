import DOMPurify from "dompurify"
import { marked, type Token, type TokensList } from "marked"

export { marked, DOMPurify }

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(marked.parse(src, { gfm: true, async: false }) as string)
}

// One block of an answer being written (see answerView).
export function renderToken(tok: Token, links: TokensList["links"]): string {
  const list = [tok] as unknown as TokensList
  list.links = links
  return DOMPurify.sanitize(marked.parser(list, { gfm: true }))
}

// Pictures in texts load from their own sites, without a Referer: it would tell
// them where they're shown, and sites that refuse other sites' pages their
// pictures let requests without one through. Lazily, as the reader nears them.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "IMG") return
  node.setAttribute("referrerpolicy", "no-referrer")
  node.setAttribute("loading", "lazy")
  node.setAttribute("decoding", "async")
})

export function escapeHTML(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

export function sentenceAround(text: string, start: number, end: number): string {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const s = Math.max(before.search(/[^.!?。！？]*$/), 0)
  const m = after.match(/^[^.!?。！？]*[.!?。！？]?["”’)]?/)
  return (before.slice(s) + text.slice(start, end) + (m ? m[0] : "")).replace(/\s+/g, " ").trim()
}
