# API

JSON in and out; streaming endpoints return NDJSON (one JSON object per line). Everything except `/api/health`, `/api/config` and `/api/auth/*` needs a session.

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login`, `POST /api/auth/logout` | `{email, password}` → session cookie |
| `POST /api/auth/setup` | First-run setup: `{email, password, name?}` creates the first admin and signs in; `409` once any account exists |
| `GET /api/me` | The user, their profile (`prefs`) and model settings (`has_key`, never the key) |
| `PUT /api/me/prefs` | Profile; send only what changes. `level` (`A1`–`C2`), `lang` (`en`, `zh`), `readSize` (`s`, `sm`, `m`, `l`), `readWidth` (`n`, `m`, `w`), `theme` (`system`, `light`, `dark`), `readFont` (`literata`, `classic`, `sans`, `legible`), `glossFont` (`sans`, `song`, `kai`). Unknown values are ignored |
| `PUT /api/me/password`, `PUT /api/me/model` | Password; `{preset, kind, base_url, model, api_key?}` (omit `api_key` to keep it, `""` to remove it) |
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
| `GET /api/chats?book=`, `GET/PUT/DELETE /api/chats/{id}` | Ask AI history. The list (newest first, optionally for one text) carries `{id, bookId, bookTitle, selection, question, questions, updatedAt}`; one conversation adds `passage` and `messages`. `PUT` saves a conversation under an id the browser chose (8–64 letters, digits, `-`, `_`): `{bookId, selection, passage, messages}` with complete question/answer pairs, up to 60 of them. Conversations are deleted with their text; an account keeps its latest 500 |

The LLM endpoints use the signed-in user's saved provider and key.

## Agent API

Authenticated with `Authorization: Bearer llat_…` (an agent token), never the session cookie.

| Endpoint | Purpose |
|---|---|
| `POST /api/agent/texts?title=&ttlDays=` | Raw Markdown body (`Content-Type: text/markdown`), or JSON `{title?, markdown, ttlDays?}` → `201 {id, title, format, words, expiresAt, url}`; `url` opens the text in the reader. The text deletes itself after `ttlDays` (default 30; 0 keeps it) |
| `GET /api/agent/texts` | Texts agents added (not the user's own), newest change first: `[{id, title, format, words, updatedAt, expiresAt, url}]` |
| `POST /api/agent/texts/{id}/append` | Add to the end of a text an agent added, after a `---` line; same bodies as a new text (a title is ignored) → `200 {id, title, …}`. Starts its 30 days again (a longer time to live, or none, stays). `404` for the user's own texts, `413` past the length limit |
| `GET /api/agent/whoami` | Check a token: `{ok, user, shelf}` |
| `GET /skills/lingolens.zip` | The agent skill, ready to unzip into a skills folder (public) |
