import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

// The Go server embeds ../dist (web/embed.go). Its .gitkeep stays, so the
// embed compiles before the first build.
const OUT = resolve(import.meta.dirname, "../dist")
const KEEP = ".gitkeep"

// Files the service worker doesn't keep up front: licences, and what loads
// only when needed (pdf.js on the first PDF, Atkinson when chosen). It keeps
// them from then on, like any file it fetches.
const NOT_CACHED = [/^index\.html$/, /^sw\.js$/, /\.txt$/, /LICENSE$/, /^vendor\/pdfjs\//, /atkinson/, new RegExp(`^${KEEP}$`)]

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

// Empties ../dist but keeps .gitkeep, then writes sw.js from sw.template.js
// with the list of files the app needs and a cache name made from them.
function lingolens(): Plugin {
  return {
    name: "lingolens",
    apply: "build",
    buildStart() {
      mkdirSync(OUT, { recursive: true })
      for (const path of files(OUT)) if (!path.endsWith(KEEP)) rmSync(path)
    },
    closeBundle() {
      const all = files(OUT).map((p) => relative(OUT, p).split("\\").join("/")).sort()
      const app = all.filter((f) => !NOT_CACHED.some((re) => re.test(f)))
      const hash = createHash("sha256")
      for (const f of app) hash.update(f).update(readFileSync(join(OUT, f)))
      const sw = readFileSync(resolve(import.meta.dirname, "sw.template.js"), "utf8")
        .replace("__VERSION__", hash.digest("hex").slice(0, 12))
        .replace("__APP_FILES__", JSON.stringify(["./", ...app], null, 2))
      writeFileSync(join(OUT, "sw.js"), sw)
    },
  }
}

// `npm run dev` serves the app with hot reload; the API comes from a LingoLens
// server on :8080 (`make demo`).
const API = process.env.LINGOLENS_API || "http://127.0.0.1:8080"

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), lingolens()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: OUT,
    emptyOutDir: false, // done by the plugin, keeping .gitkeep
    assetsDir: "assets",
    chunkSizeWarningLimit: 900,
  },
  server: {
    proxy: {
      "/api": API,
      "/skills": API,
    },
  },
})
