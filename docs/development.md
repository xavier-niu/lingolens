# Development

LingoLens is a Go server (one binary, SQLite, the web app embedded) and a plain JavaScript web app without a build step.

## Run from source

Requires Go 1.27+.

```sh
go run ./cmd/lingolens   # http://127.0.0.1:8080
```

To work on the UI without rebuilding, serve it from the source folder and use the offline "Fake" model:

```sh
LINGOLENS_DEV_FAKE=1 LINGOLENS_ADMIN_EMAIL=dev@example.com LINGOLENS_ADMIN_PASSWORD='dev password' \
  go run ./cmd/lingolens -static web/static -data /tmp/lingolens-dev   # edit UI files and reload
```

`make demo` runs a demo server on `0.0.0.0:8080` (data in `/tmp/lingolens-demo`, sign in as `demo@admin.com` / `admin`, the Fake model enabled); `make demo-reset` wipes it. Short passwords are accepted only for that first admin and only with `LINGOLENS_DEV_FAKE=1`; keep the demo off shared networks.

## Tests

| Command | Runs |
|---|---|
| `make test` | `go vet` and the Go unit and integration tests (store, importer, LLM clients, HTTP API) |
| `make e2e` | Browser tests with local Node 20+ and Playwright's Chromium (first time on Linux: `cd e2e && npx playwright install-deps chromium`) |
| `make e2e-docker` | The same browser tests inside Playwright's Docker image; no Node needed |

The browser tests build the server, start it on a free port with a throwaway data directory and the Fake model, and run ten suites: first-run setup (on its own empty server), sign-in and accounts, shelf and reader, phones and tablets, header, theme, Add Source (text, web page, EPUB, agent API), PDFs (printed by Chromium with running headers and page numbers, and offline), the bookmarklet (against a fixture site that refuses the server) and offline sync. `make e2e SUITES="shelf offline"` runs only those. Screenshots and the server log land in `e2e/out/` (CI uploads them when a run fails).

## Layout

```
cmd/lingolens/        main: serve, and the `user` subcommands
internal/store/       SQLite: users, sessions, agent tokens, books, wordbook, settings; API-key encryption; Markdown detection
internal/levels/      CEFR levels and per-level annotation guidance
internal/llm/         provider adapters (OpenAI-compatible via net/http, Anthropic via the Go SDK)
internal/annotate/    prompts, chunking, alignment of LLM output to exact offsets, caches, lookup
internal/importer/    web-page (readability + SSRF-safe fetcher, or a page the bookmarklet sent) and EPUB import, HTML → Markdown (PDFs are read in the browser: web/static/pdftext.js)
internal/server/      HTTP handlers, sessions, CSRF guard, sign-in throttling, NDJSON streaming, chat prompt
skills/lingolens/     agent skill (SKILL.md + upload script), embedded and served as a zip; skills/install.sh installs it
e2e/                  browser tests (Playwright): run.mjs starts a fresh server and runs the suites; fixtures/ for imports
web/static/           UI: app.js, api.js, library.js (shelf), offline.js (device copy, outbox, sync), sw.js (service worker), i18n.js; pdftext.js (PDF → Markdown); vendored marked, DOMPurify, pdf.js (Apache-2.0, loaded on first PDF), Literata and Atkinson Hyperlegible Next (OFL; the latter loaded only when chosen); embedded into the binary
docs/                 this documentation and the logo
```

## Continuous integration

`.github/workflows/docker.yml` runs the Go tests (`go vet`, `go test -race`) and the browser tests in parallel. Once both pass, it builds a multi-arch image (`linux/amd64`, `linux/arm64`) and pushes it to Docker Hub as [`xavierniu/lingolens`](https://hub.docker.com/r/xavierniu/lingolens) on pushes to `main` or `master` and on `v*` tags (pull requests build without pushing). Repository secrets:

| Secret | Value |
|---|---|
| `DOCKERHUB_TOKEN` | Docker Hub access token (Read & Write); required to push |
| `DOCKERHUB_USERNAME` | Docker Hub user or organisation; defaults to `xavierniu` |
| `DOCKERHUB_REPO` | Repository name; defaults to `lingolens` |

Tags: `latest` (default branch), `X.Y.Z` and `X.Y` (from `vX.Y.Z` tags), branch name, and short SHA.
