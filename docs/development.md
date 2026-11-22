# Development

LingoLens is a Go server (one binary, SQLite, the web app embedded) and a web app built with React, TypeScript and [shadcn/ui](https://ui.shadcn.com/) (Radix UI and Tailwind CSS), bundled by Vite.

## Run from source

Requires Go 1.27+ and Node 20+ (or Docker, which `make ui` uses when Node is missing).

```sh
make build        # the web app (web/ui → web/dist), then ./lingolens with it embedded
./lingolens       # http://127.0.0.1:8080
```

`go build` alone works too, but the server then shows a page asking for the web app to be built: it embeds whatever `make ui` last wrote to `web/dist`.

To work on the UI with hot reload, run the demo server and Vite's dev server side by side:

```sh
make demo         # the API on :8080, with the Fake model
make ui-dev       # the web app on http://localhost:5173, using that API
```

Components come from shadcn/ui and live in `web/ui/src/components/ui`, as code to edit. Add more with `cd web/ui && npx shadcn@latest add <name>`.

`make demo` runs a demo server on `0.0.0.0:8080` (data in `/tmp/lingolens-demo`, sign in as `demo@admin.com` / `admin`, the Fake model enabled); `make demo-reset` wipes it. Short passwords are accepted only for that first admin and only with `LINGOLENS_DEV_FAKE=1`; keep the demo off shared networks.

## Tests

| Command | Runs |
|---|---|
| `make test` | `go vet` and the Go unit and integration tests (store, importer, LLM clients, HTTP API); run `make ui` first for the service-worker check |
| `make ui` | Type-checks and builds the web app into `web/dist` |
| `make e2e` | Browser tests with local Node 20+ and Playwright's Chromium (first time on Linux: `cd e2e && npx playwright install-deps chromium`) |
| `make e2e-docker` | The same browser tests inside Playwright's Docker image (the web app builds with local Node, or in Node's image) |

The browser tests build the server, start it on a free port with a throwaway data directory and the Fake model, and run ten suites: first-run setup (on its own empty server), sign-in and accounts, shelf and reader, phones and tablets, header, theme, Add Source (text, web page, EPUB, agent API), PDFs (printed by Chromium with running headers and page numbers, and offline), the bookmarklet (against a fixture site that refuses the server) and offline sync. `make e2e SUITES="shelf offline"` runs only those. Screenshots and the server log land in `e2e/out/` (CI uploads them when a run fails).

## Layout

```
cmd/lingolens/        main: serve, and the `user` subcommands
internal/store/       SQLite: users, sessions, agent tokens, books, known words, settings; API-key encryption; Markdown detection
internal/levels/      CEFR levels, per-level annotation guidance, and the words each level knows (words.txt, from genwords.go)
internal/llm/         provider adapters (OpenAI-compatible via net/http, Anthropic via the Go SDK)
internal/annotate/    prompts, chunking, alignment of LLM output to exact offsets, caches, lookup
internal/importer/    web-page (readability + SSRF-safe fetcher, or a page the bookmarklet sent) and EPUB import, HTML → Markdown (PDFs are read in the browser: web/ui/src/lib/pdftext.js)
internal/server/      HTTP handlers, sessions, CSRF guard, sign-in throttling, NDJSON streaming, chat prompt
skills/lingolens/     agent skill (SKILL.md + upload script), embedded and served as a zip; skills/install.sh installs it
e2e/                  browser tests (Playwright): run.mjs starts a fresh server and runs the suites; fixtures/ for imports
web/ui/               the web app (React, TypeScript, shadcn/ui, Tailwind CSS; built by Vite into web/dist, which web/embed.go embeds)
  src/app/            the logic: store (zustand), session and routes, the reading engine (glosses, lazy annotation, lookups), reading progress, Ask AI and its streaming reveal, reading options
  src/components/     the header, sidebar, dialogs and menus; ui/ holds the shadcn/ui components
  src/views/          the pages: sign-in, shelf, reader, settings, bookmarklet import
  src/lib/            api.js, offline.js (device copy, outbox, sync), library.js (shelf), i18n.js, pdftext.js (PDF → Markdown), Markdown rendering (marked, DOMPurify)
  public/             theme.js (applied before the page paints), pdf.js (Apache-2.0, loaded on first PDF), Inter, Literata and Atkinson Hyperlegible Next (OFL; the last loaded only when chosen)
  sw.template.js      the service worker; the build fills in the files it keeps
docs/                 this documentation and the logo
```

## Continuous integration

`.github/workflows/docker.yml` builds the web app and runs the Go tests (`go vet`, `go test -race`) and the browser tests in parallel. Once both pass, it builds a multi-arch image (`linux/amd64`, `linux/arm64`) and pushes it to Docker Hub as [`xavierniu/lingolens`](https://hub.docker.com/r/xavierniu/lingolens) on pushes to `main` or `master` and on `v*` tags (pull requests build without pushing). Repository secrets:

| Secret | Value |
|---|---|
| `DOCKERHUB_TOKEN` | Docker Hub access token (Read & Write); required to push |
| `DOCKERHUB_USERNAME` | Docker Hub user or organisation; defaults to `xavierniu` |
| `DOCKERHUB_REPO` | Repository name; defaults to `lingolens` |

Tags: `latest` (default branch), `X.Y.Z` and `X.Y` (from `vX.Y.Z` tags), branch name, and short SHA.
