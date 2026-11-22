// The bookmarklet, and #/clip: the page it sent, shown for a check before it's
// added.
//
// Some sites refuse requests from servers (HTTP 403), and some pages need the
// reader's own sign-in. The bookmarklet reads the page in the reader's browser
// instead: run on any page, it opens LingoLens at #/clip and hands that tab the
// page (or just the selected part) once the tab says it's ready. It posts only to
// this server's origin, and the tab asks before adding anything to the shelf.
import { t } from "@/lib/i18n.js"
import { importPage } from "@/lib/library.js"
import { get, set } from "./store"

export function bookmarkletCode() {
  const app = location.origin + location.pathname
  // Plain ES2017, no comments: it runs inside other people's pages. Scripts,
  // styles and frames are dropped to keep the message small. F gives the
  // pictures copied into k what their originals (o, in the same order) show: the
  // address the browser chose (from a srcset, or after lazy loading) and the
  // size they're shown at, also before they load when the page sets it, so the
  // server can tell photos and charts from icons and avatars.
  const js = `(()=>{const A=${JSON.stringify(app)},O=new URL(A).origin,d=document,I=[...d.querySelectorAll('img')],`
    + `F=(k,o)=>{const q=k.querySelectorAll('img');if(q.length===o.length)q.forEach((m,i)=>{const x=o[i],u=x.currentSrc||x.src;`
    + `if(/^https?:/.test(u))m.setAttribute('src',u);if(x.width&&x.height){m.setAttribute('width',x.width);m.setAttribute('height',x.height)}})},`
    + `c=d.documentElement.cloneNode(true);F(c,I);`
    + `c.querySelectorAll('script,style,noscript,template,iframe,svg,canvas,object,embed,link').forEach(n=>n.remove());`
    + `let s='';const g=getSelection();`
    + `if(g&&!g.isCollapsed){const b=d.createElement('div');for(let i=0;i<g.rangeCount;i++){const r=g.getRangeAt(i),k=r.cloneContents();`
    + `F(k,I.filter(m=>r.intersectsNode(m)));b.append(k)}s=b.innerHTML}`
    + `const p={type:'lingolens:page',url:location.href,title:d.title,html:'<!doctype html>'+c.outerHTML,selection:s},w=open(A+'#/clip');`
    + `if(!w){alert(${JSON.stringify(t("clip.popup"))});return}`
    + `const f=e=>{if(e.source===w&&e.origin===O&&e.data==='lingolens:ready')w.postMessage(p,O)};`
    + `addEventListener('message',f);setTimeout(()=>removeEventListener('message',f),6e5)})()`
  return "javascript:" + encodeURIComponent(js)
}

let clipTimer = 0

export function receiveClip(e: MessageEvent) {
  const d = e.data
  if (!window.opener || e.source !== window.opener || d?.type !== "lingolens:page") return
  let from: URL
  try { from = new URL(d.url) } catch { return }
  // A page may only speak for its own site, so the shelf can't be told a page
  // came from somewhere else.
  if (from.origin !== e.origin || !/^https?:$/.test(from.protocol) || typeof d.html !== "string") return
  // DOMParser makes inert documents: nothing in them runs or loads.
  const parse = (html: string) => new DOMParser().parseFromString(html, "text/html")
  const selection = typeof d.selection === "string" ? d.selection : ""
  const words = selection ? (parse(selection).body.textContent?.match(/\S+/g) || []).length : 0
  const headings = [...parse(d.html).querySelectorAll("h1, h2")].map((h) => h.textContent || "")
  clearTimeout(clipTimer)
  set({
    clip: {
      url: from.href, html: d.html, selection, words,
      title: sitelessTitle(String(d.title || "").trim().slice(0, 300), headings),
      host: from.hostname.replace(/^www\./, ""),
    },
  })
}

// Mirrors siteless in internal/importer: "Night Trains | The Journal" becomes
// "Night Trains" when that is also a heading on the page.
function sitelessTitle(title: string, headings: string[]) {
  const norm = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase()
  const heads = new Set(headings.map(norm))
  for (const sep of [" | ", " – ", " — ", " - ", " · ", " :: "]) {
    const last = title.lastIndexOf(sep)
    if (last < 0) continue
    for (const head of [title.slice(0, last), title.slice(0, title.indexOf(sep))]) {
      if (head.trim() && heads.has(norm(head))) return head.trim()
    }
  }
  return title
}

// Opening #/clip: tell the bookmarklet's tab we're here; it answers with the
// page. Without an answer, say how to use it.
export function prepareClip() {
  set({ clipWaited: false })
  if (get().clip) return
  window.opener?.postMessage("lingolens:ready", "*")
  clearTimeout(clipTimer)
  clipTimer = window.setTimeout(() => set({ clipWaited: true }), window.opener ? 8000 : 0)
}

export async function saveClip() {
  const book = await importPage(get().clip)
  set({ clip: null })
  location.replace(`#/read/${encodeURIComponent(book.id)}`) // Back shouldn't return here
}

export function cancelClip() {
  set({ clip: null })
  window.close() // the bookmarklet opened this tab; closing returns to the page
  setTimeout(() => location.replace("#/"), 100) // if the browser keeps it open
}
