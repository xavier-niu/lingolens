# LingoLens

Read English with Chinese glosses above the words you probably don't know — at your level — using your own LLM API key.

- **A shelf of texts.** Each text you add gets a cover on your shelf, with reading progress and an estimated reading time for your level. Reopening a text returns you to where you stopped.
- **Add sources.** Paste text (Markdown is detected automatically), import a web page (just the article: no menus, ads or comments), or add a DRM-free EPUB book or a PDF. Long texts with sections get a Contents list.
- **Bookmarklet.** Some sites refuse requests from servers (*HTTP 403*). Click the LingoLens bookmarklet on the page instead: your browser hands the page to LingoLens, so it also works for pages you're signed in to and text added by scripts. See [Bookmarklet](#bookmarklet).
- **Agent access.** AI agents such as Claude Code can save their replies to your shelf with a per-user token and the bundled [skill](skills/lingolens/SKILL.md), and add later replies on the same topic to the same text.
- **Texts that clean up after themselves.** Any text can be set to delete itself after a day, a week, a month, three months or a year (Add Source or Edit text → *Delete automatically*); the shelf shows the days left. Texts are kept forever unless you choose, except agents' replies, which go after 30 days unless you keep them.

- **Level-aware annotations.** Pick a CEFR level (A1–C2, with Chinese exam equivalents). The higher the level, the fewer words are annotated. Glosses sit above words using `<ruby>`.
- **Fixed expressions.** Collocations, phrasal verbs and idioms (`take into account`, `by and large`, `run out of`) are detected and glossed as a unit, with a dotted underline.
- **Click any word.** CEFR is only a guess, so clicking any word — annotated or not — fetches a context-aware entry (meaning here, IPA, other senses, collocations, examples) and adds its gloss to the text.
- **Ask AI about a sentence.** Select text and press *Ask AI* to chat with the model about it (translation, grammar, vocabulary, more examples), grounded in the surrounding passage.
- **Wordbook.** Save words with their context sentence, mark words as known (their glosses are hidden), export to CSV (Anki-friendly).
- **Token-frugal.** Paragraphs are annotated lazily as they scroll into view, in ~1,800-character batches, and results are cached per paragraph on the server.
- **Accounts.** Several people can use one server, each with their own shelf, progress, wordbook, profile and AI key. Sign-in is email + password; an admin creates accounts.
- **Bring your own key.** Anthropic (official SDK) plus any OpenAI-compatible API: OpenAI, DeepSeek, OpenRouter, LiteLLM, Qwen, Moonshot, Ollama, vLLM… Keys are encrypted on the server and never sent back to the browser.
- **Works offline.** The app, your whole shelf, the glosses you've loaded, looked-up words and your wordbook stay on each device. Read, save words, add pasted text, delete texts and change settings without a connection; it all syncs when you're back online. (Needs HTTPS or `localhost`; see [Offline](#offline).)
- **UI in English or Chinese** (English by default), light and dark themes (following the device by default), works on desktop, tablet and phone.

Everything a user saves lives in a SQLite database on the server, in the data directory.

## Run

Requires Go 1.27+.

```sh
go run ./cmd/lingolens   # http://127.0.0.1:8080
```

The first visit sets up the server: while there are no accounts, the sign-in page asks for the admin's email and password instead, then signs you in. Then open **Settings**, pick your English level and an AI model, and add your API key. **Add source** puts a text on your shelf.

### Accounts

**First admin.** A server with no accounts offers first-run setup in the browser, and anyone who reaches it first becomes admin. Finish it right after starting the server, or skip it by creating the admin before anyone can connect: set `LINGOLENS_ADMIN_EMAIL` and `LINGOLENS_ADMIN_PASSWORD` (used only while there are no accounts), or run `lingolens user add -admin -email you@example.com`. Setup closes for good once any account exists.

After that, accounts are created by an admin, either in **Settings → Members** or on the command line:

```sh
lingolens user add -email reader@example.com [-name "Mei"] [-admin]
lingolens user list
lingolens user passwd -email reader@example.com   # also signs them out everywhere
lingolens user delete -email reader@example.com   # deletes their shelf, wordbook and settings
```

Passwords are prompted without echo, read from stdin when piped, or taken from `LINGOLENS_PASSWORD`. Users can change their own password in Settings.

Texts kept in a browser by older versions are moved into the account on its first sign-in.

### Docker

```sh
docker build -t lingolens .
docker run -d -p 8080:8080 -v lingolens-data:/data lingolens   # then open it and set up the admin
docker exec <container> /lingolens user add -email reader@example.com   # more accounts, or use Settings
```

To create the admin up front instead of in the browser, add `-e LINGOLENS_ADMIN_EMAIL=you@example.com -e LINGOLENS_ADMIN_PASSWORD='a long password'`; it applies only while the database has no accounts. Keep `/data` on a volume: it holds the database and the encryption secret.

Inside the container, `localhost` refers to the container itself: to reach Ollama or LiteLLM on the host, use `http://host.docker.internal:…` (add `--add-host=host.docker.internal:host-gateway` on Linux).

### GitHub Actions → Docker Hub

`.github/workflows/docker.yml` runs the Go tests (`go vet`, `go test -race`) and the browser tests (see [Development](#development)) in parallel. Once both pass, it builds a multi-arch image (`linux/amd64`, `linux/arm64`) and pushes it to Docker Hub as [`xavierniu/lingolens`](https://hub.docker.com/r/xavierniu/lingolens) on pushes to `main` or `master` and on `v*` tags (pull requests build without pushing). Repository secrets:

| Secret | Value |
|---|---|
| `DOCKERHUB_TOKEN` | Docker Hub access token (Read & Write); required to push |
| `DOCKERHUB_USERNAME` | Docker Hub user or organisation; defaults to `xavierniu` |
| `DOCKERHUB_REPO` | Repository name; defaults to `lingolens` |

Tags: `latest` (default branch), `X.Y.Z` and `X.Y` (from `vX.Y.Z` tags), branch name, and short SHA.

## Configuration

| Flag / env | Default | Meaning |
|---|---|---|
| `-addr` / `LINGOLENS_ADDR` | `127.0.0.1:8080` (`0.0.0.0:8080` in Docker) | Listen address |
| `-data` / `LINGOLENS_DATA` | `./data` (`/data` in Docker) | Holds `lingolens.db` and `secret.key` |
| `LINGOLENS_SECRET` | generated into `secret.key` | 32-byte key (hex or base64) that encrypts stored API keys |
| `LINGOLENS_ADMIN_EMAIL`, `LINGOLENS_ADMIN_PASSWORD` | unset | Create this admin on first start |
| `LINGOLENS_SECURE_COOKIES=1` | off | Mark the session cookie `Secure`; set it when serving over HTTPS (e.g. behind a TLS proxy) |
| `-static` / `LINGOLENS_STATIC_DIR` | embedded | Serve the UI from a directory instead (frontend development, no rebuild needed) |
| `LINGOLENS_PUBLIC_URL` | from each request | How people reach the app, e.g. `https://read.example.com`; used in the links returned to agents. Set it behind a proxy. |
| `LINGOLENS_FETCH_ALLOW_PRIVATE=1` | off | Let web-page import reach private and loopback addresses. For local testing only. |
| `LINGOLENS_DEV_FAKE=1` | off | Enables an offline "Fake" provider for UI development and tests. It does not translate. |

## Security

- **Passwords** are hashed with bcrypt. Failed sign-ins are limited per IP and per email (8 per 15 minutes).
- **Sessions** are random tokens in an `HttpOnly`, `SameSite=Lax` cookie, valid for 30 days of use; the database stores only their SHA-256. Changing a password signs out the account's other sessions.
- **Cross-site requests:** state-changing requests must send JSON or use a non-simple method, and a present `Origin` must match the host.
- **API keys** are encrypted with AES-256-GCM, bound to their owner's account, and never returned by the API. Back up `secret.key` (or keep `LINGOLENS_SECRET`) with the database: without it, stored keys can't be decrypted and users must re-enter them.
- **Bookmarklet:** it posts the page only to the LingoLens origin it was made for, and the LingoLens tab accepts it only from the tab that opened it, only when the page's claimed address matches its real origin, and only after you choose *Add to Shelf*. The import request itself is an ordinary same-site JSON call, so other sites still can't add to your shelf.
- **Web-page import** connects only to public internet addresses: loopback, private, link-local (including cloud metadata at `169.254.169.254`) and other internal ranges are refused at connect time, after DNS and on every redirect, so a pasted link can't probe the server's network. Pages are capped at 8 MB and 25 s; no proxy is used. Requests carry the headers desktop Chrome sends (many sites refuse anything else), and cookies live only for one fetch.
- **PDFs** are read in the browser with [pdf.js](https://mozilla.github.io/pdf.js/) (JavaScript evaluation off); the file itself is never uploaded, only the text taken from it.
- **EPUB import** refuses DRM-protected books, archives with too many entries, and any file that inflates past its limit (zip bombs). Uploads are capped at 50 MB.
- **Agent tokens** (`llat_…`) can only add texts to their owner's shelf, list and add to the texts agents added there (not the user's own, and never their content), and check themselves (`/api/agent/*`). Browser sessions don't work on those routes, and tokens don't work anywhere else. Only a SHA-256 of each token is stored; the token is shown once when created and can be revoked in Settings.
- **Isolation:** every query for user data is scoped to the signed-in user; tests check that one account can't read or change another's texts, progress or wordbook.
- The server calls whatever API base URL a user saves, so only give accounts to people you trust with that, and put HTTPS in front of it if it's reachable beyond your machine.

## API

JSON in and out; streaming endpoints return NDJSON (one JSON object per line). Everything except `/api/health`, `/api/config` and `/api/auth/*` needs a session.

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login`, `POST /api/auth/logout` | `{email, password}` → session cookie |
| `POST /api/auth/setup` | First-run setup: `{email, password, name?}` creates the first admin and signs in; `409` once any account exists |
| `GET /api/me` | The user, their profile (`prefs`) and model settings (`has_key`, never the key) |
| `PUT /api/me/prefs`, `PUT /api/me/password`, `PUT /api/me/model` | Profile `{level, lang, readSize, theme}` (theme: `system`, `light` or `dark`); password; `{preset, kind, base_url, model, api_key?}` (omit `api_key` to keep it, `""` to remove it) |
| `GET/POST /api/books`, `GET/PUT/DELETE /api/books/{id}`, `PUT /api/books/{id}/progress` | The shelf. `format` is `text`, `markdown` or `auto` (detect); up to 2,000,000 characters. A create may carry `clientRef` (a device's id for a text added offline): sending it again returns the same book. Create and edit take `ttlDays`: the text deletes itself that many days later (1–3650), and `0` keeps it forever; a new text without it is kept forever, and an edit without it keeps the text's time. Books carry `expiresAt` (empty when kept). Progress is `{pos, progress, at?}`; `progress` only grows, and `pos` is ignored if newer reading was recorded after `at` |
| `POST /api/books/import/url` | `{url, title?, ttlDays?}` → fetches the page and shelves its article as Markdown |
| `POST /api/books/import/page` | `{url, html}` → shelves the article of a page the browser sent (the bookmarklet); `{url, title, selection}` keeps just the selected HTML. ≤ 8 MB |
| `POST /api/books/import/epub?title=&ttlDays=` | Body: the `.epub` file with `Content-Type: application/epub+zip` (≤ 50 MB) |
| `GET/POST /api/me/tokens`, `DELETE /api/me/tokens/{id}` | Agent tokens: list (name and hint only), create `{name}` (returns the token once), revoke |
| `GET /api/wordbook`, `PUT/DELETE /api/wordbook/{key}`, `GET/DELETE /api/known`, `PUT/DELETE /api/known/{lemma}` | Wordbook and known words |
| `GET/POST /api/admin/users`, `PUT /api/admin/users/{id}/password`, `DELETE /api/admin/users/{id}` | Admins only |
| `POST /api/annotate` | `{level, segments:[{id,text}]}` → stream of `{type:"segment", id, annotations}` / `{type:"error"}` / `{type:"done"}`. Offsets are UTF-16 (JavaScript string indices). |
| `POST /api/lookup` | `{level, term, sentence}` → dictionary entry |
| `POST /api/chat` | `{level, passage, selection, messages}` → stream of `{type:"delta", text}` / `{type:"error"}` / `{type:"done"}` |

The LLM endpoints use the signed-in user's saved provider and key.

### Agent API

Authenticated with `Authorization: Bearer llat_…` (an agent token), never the session cookie.

| Endpoint | Purpose |
|---|---|
| `POST /api/agent/texts?title=&ttlDays=` | Raw Markdown body (`Content-Type: text/markdown`), or JSON `{title?, markdown, ttlDays?}` → `201 {id, title, format, words, expiresAt, url}`; `url` opens the text in the reader. The text deletes itself after `ttlDays` (default 30; 0 keeps it) |
| `GET /api/agent/texts` | Texts agents added (not the user's own), newest change first: `[{id, title, format, words, updatedAt, url}]` |
| `POST /api/agent/texts/{id}/append` | Add to the end of a text an agent added, after a `---` line; same bodies as a new text (a title is ignored) → `200 {id, title, …}`. Starts its 30 days again (a longer time to live, or none, stays). `404` for the user's own texts, `413` past the length limit |
| `GET /api/agent/whoami` | Check a token: `{ok, user, shelf}` |
| `GET /skills/lingolens.zip` | The agent skill, ready to unzip into a skills folder (public) |

## PDFs

Choose **Add Source → Book or PDF** and pick a `.pdf` (up to 50 MB). LingoLens reads it in your browser and rebuilds the text: lines joined into paragraphs (also across pages and hyphenated line breaks), larger type as headings, running headers, footers and page numbers left out. The title comes from the PDF, else its first big heading, else the file name.

The PDF needs text you can select: scanned pages are pictures of text, so run them through OCR first. Password-protected PDFs must be saved without the password. Tables, sidebars and footnotes come out as plain paragraphs; tidy a text afterwards with **Edit text** if needed.

## Bookmarklet

For sites that answer LingoLens with *HTTP 403* (or need you to be signed in), add the page from your own browser:

1. Open **Settings → Bookmarklet** and drag the **LingoLens** button to your bookmarks bar. (Show the bar with Ctrl/Cmd+Shift+B in Chrome and Edge, or *View → Show Favorites Bar* in Safari.)
2. On an article, click **LingoLens** in the bookmarks bar. To keep only part of the page, select it first.
3. A LingoLens tab opens (sign in if asked), shows the page's title and site, and adds it when you choose **Add to Shelf**. *Cancel* closes the tab.

On a phone or tablet there's no bar to drag to: copy the code from the same section, bookmark any page, edit that bookmark (name it *LingoLens*, paste the code as its address), then on an article type *LingoLens* in the address bar and tap the bookmark.

The bookmarklet contains this server's address, so re-add it if LingoLens moves. If nothing happens, allow pop-ups for that site. A few sites that isolate their windows (`Cross-Origin-Opener-Policy`) can't hand the page over; the new tab then says *No page arrived*. Select the text and paste it in **Add Source → Text** instead.

## Agents

Let Claude Code (or any agent or script) save replies to your shelf:

1. In LingoLens, open **Settings → Agent Access**, name a token and create it. Copy the two lines it shows:
   ```sh
   export LINGOLENS_URL=https://read.example.com
   export LINGOLENS_TOKEN=llat_…
   ```
2. Install the skill with the [skills CLI](https://github.com/vercel-labs/skills), which works for Claude Code, Codex, Cursor and other agents:
   ```sh
   npx skills add xavier-niu/lingolens        # this project; add -g for every project
   ```
   Without Node, use the install script (needs bash and curl). It puts the skill in `~/.claude/skills/lingolens`; pass `--dir` for another agent's skills folder, and run it again to update:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/xavier-niu/lingolens/master/skills/install.sh | bash
   curl -fsSL https://raw.githubusercontent.com/xavier-niu/lingolens/master/skills/install.sh | bash -s -- --dir ~/.codex/skills
   ```
   Or use **Download Skill** on the same page and unzip it into the agent's skills folder, or copy [`skills/lingolens`](skills/lingolens) from this repository. The CLI installs the skill from GitHub, so `npx skills update` picks up new versions.
3. Ask the agent things like "explain the present perfect and save it to LingoLens" or "write me a B1 article about coffee for LingoLens". It replies with a link to the new text. Ask it to add more on the same topic ("add a part about roasting to my coffee text") and it adds to the end of that text, after a separator line, instead of starting a new one.

Without the skill, any script can upload:

```sh
curl -X POST "$LINGOLENS_URL/api/agent/texts?title=Notes" \
  -H "Authorization: Bearer $LINGOLENS_TOKEN" \
  -H "Content-Type: text/markdown" --data-binary @notes.md
```

## Offline

Each browser keeps a copy of the signed-in account in IndexedDB: the shelf with every text's content (downloaded in the background), glosses for paragraphs already annotated, looked-up words, the wordbook, known words and the profile. A service worker ([`sw.js`](web/static/sw.js)) keeps the app itself.

Offline you can read any text on the shelf (paragraphs annotated before show their glosses; the others are glossed when you're back), open words you looked up before, save words, mark words known, add pasted text or a PDF (once a PDF has been read online, which loads the PDF reader), edit or delete texts and change settings. A badge in the header says **Offline**, then **Syncing…** and **Synced**. New lookups, Ask AI, web-page and EPUB imports and account settings need a connection.

Changes wait in an outbox and are sent in order when the server is reachable again (checked on reconnect and every 15 s), then fresh data is fetched, so changes from other devices arrive too. Conflicts resolve simply: furthest progress wins, a reading position only replaces a newer one from another device if it is newer itself, and otherwise the last change sent wins. If the server rejects a change (say, a text it finds invalid), the app says so instead of retrying forever.

Signing out removes the account's copy from the browser; if changes haven't synced yet, it asks first.

Browsers only run service workers on secure origins: serve LingoLens over **HTTPS** (or use it on `localhost`). Over plain HTTP on a LAN address the app still works online and keeps its data copy, but a reload without a connection can't open it.

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
web/static/           UI: app.js, api.js, library.js (shelf), offline.js (device copy, outbox, sync), sw.js (service worker), i18n.js; pdftext.js (PDF → Markdown); vendored marked, DOMPurify, pdf.js (Apache-2.0, loaded on first PDF), Literata (OFL); embedded into the binary
```

## Development

`make demo` runs a demo server on `0.0.0.0:8080` (data in `/tmp/lingolens-demo`, sign in as `demo@admin.com` / `admin`, the Fake model enabled); `make demo-reset` wipes it. Short passwords are accepted only for that first admin and only with `LINGOLENS_DEV_FAKE=1`; keep the demo off shared networks.

Tests:

| Command | Runs |
|---|---|
| `make test` | `go vet` and the Go unit and integration tests (store, importer, LLM clients, HTTP API) |
| `make e2e` | Browser tests with local Node 20+ and Playwright's Chromium (first time on Linux: `cd e2e && npx playwright install-deps chromium`) |
| `make e2e-docker` | The same browser tests inside Playwright's Docker image; no Node needed |

The browser tests build the server, start it on a free port with a throwaway data directory and the Fake model, and run ten suites: first-run setup (on its own empty server), sign-in and accounts, shelf and reader, phones and tablets, header, theme, Add Source (text, web page, EPUB, agent API), PDFs (printed by Chromium with running headers and page numbers, and offline), the bookmarklet (against a fixture site that refuses the server) and offline sync. `make e2e SUITES="shelf offline"` runs only those. Screenshots and the server log land in `e2e/out/` (CI uploads them when a run fails).

```sh
LINGOLENS_DEV_FAKE=1 LINGOLENS_ADMIN_EMAIL=dev@example.com LINGOLENS_ADMIN_PASSWORD='dev password' \
  go run ./cmd/lingolens -static web/static -data /tmp/lingolens-dev   # edit UI files and reload
```
