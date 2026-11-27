# API

JSON in and out; streaming endpoints return NDJSON (one JSON object per line). Everything except `/api/health`, `/api/config` and `/api/auth/*` needs a session.

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login`, `POST /api/auth/logout` | `{email, password}` → session cookie |
| `POST /api/auth/setup` | First-run setup: `{email, password, name?}` creates the first admin and signs in; `409` once any account exists |
| `GET /api/me` | The user, their profile (`prefs`) and model settings (`has_key`, never the key) |
| `PUT /api/me/prefs` | Profile; send only what changes. `level` (`A1`–`C2`), `lang` (`en`, `zh`), `readSize` (`s`, `sm`, `m`, `l`), `readWidth` (`n`, `m`, `w`), `theme` (`system`, `light`, `dark`), `readFont` (`sans`, `serif`, `lexend`, `legible`), `glossFont` (`sans`, `song`, `kai`), `hideWords`, `hidePhrases` (`true`, `false`). The reading settings are defaults for every device; Reading Options in the web app change them on one device only. Unknown values are ignored |
| `PUT /api/me/password`, `PUT /api/me/model` | Password; `{preset, kind, base_url, model, api_key?}` (omit `api_key` to keep it, `""` to remove it) |
| `GET/POST /api/books`, `GET/PUT/DELETE /api/books/{id}`, `PUT /api/books/{id}/progress`, `PUT /api/books/{id}/later` | The shelf. `format` is `text`, `markdown` or `auto` (detect); up to 2,000,000 characters. A create may carry `clientRef` (a device's id for a text added offline): sending it again returns the same book. Create and edit take `ttlDays`: the text deletes itself that many days later (1–3650), and `0` keeps it forever; a new text without it is kept forever, and an edit without it keeps the text's time. An edit that only adds to the end (the app's **Append Text** puts a `---` line before the addition) keeps the reading place and progress, as a share of the longer text; any other change to the content starts them over at 0. Books carry `expiresAt` (empty when kept), and `tokensIn`, `tokensCached` and `tokensOut`: what the AI model has read afresh, read from the provider's prompt cache, and written for the text, in all; and `readLaterAt`, when the reader marked it to read later (empty when not). `/later` takes `{later, at?}` to mark or clear it (`at`, when a device syncs a change made offline), and leaves `updatedAt` alone. Progress is `{pos, progress, at?}`; `progress` only grows, and `pos` is ignored if newer reading was recorded after `at` |
| `POST /api/books/import/url` | `{url, title?, ttlDays?}` → fetches the page and shelves its article as Markdown |
| `POST /api/books/import/page` | `{url, html}` → shelves the article of a page the browser sent (the bookmarklet); `{url, title, selection}` keeps just the selected HTML. ≤ 8 MB |
| `POST /api/books/import/epub?title=&ttlDays=` | Body: the `.epub` file with `Content-Type: application/epub+zip` (≤ 50 MB) |
| `GET/POST /api/me/tokens`, `DELETE /api/me/tokens/{id}` | Agent tokens: list (name and hint only), create `{name}` (returns the token once), revoke |
| `GET/DELETE /api/known`, `PUT/DELETE /api/known/{lemma}` | Words marked known (their glosses are hidden) |
| `GET/POST /api/admin/users`, `PUT /api/admin/users/{id}/password`, `DELETE /api/admin/users/{id}` | Admins only |
| `POST /api/annotate` | `{book?, level, segments:[{id,text}]}` → stream of `{type:"segment", id, annotations}` / `{type:"error"}` / `{type:"done", bookTokens?}`. Offsets are UTF-16 (JavaScript string indices). |
| `POST /api/lookup` | `{book?, level, term, sentence}` → dictionary entry, with `bookTokens?` |
| `POST /api/chat` | `{book?, level, passage, selection, messages}` → stream of `{type:"delta", text}` / `{type:"error"}` / `{type:"done", bookTokens?}` |
| `GET /api/chats?book=`, `GET/PUT/DELETE /api/chats/{id}` | Ask AI history. The list (newest first, optionally for one text) carries `{id, bookId, bookTitle, selection, question, questions, updatedAt}`; one conversation adds `passage` and `messages`. `PUT` saves a conversation under an id the browser chose (8–64 letters, digits, `-`, `_`): `{bookId, selection, passage, messages}` with complete question/answer pairs, up to 60 of them. Conversations are deleted with their text; an account keeps its latest 500 |

The LLM endpoints use the signed-in user's saved provider and key. With `book` (the id of one of the user's texts), the tokens they spend are added to that text's totals, and the reply carries the new totals as `bookTokens: {input, cached, output}` (`input` leaves out what was read from the provider's prompt cache, which is `cached`); it's left out when nothing was spent (answered from the cache) or the text isn't on the server. OpenAI-compatible providers that don't report usage in streams count nothing for Ask AI.

## Agent API

Authenticated with `Authorization: Bearer llat_…` (an agent token), never the session cookie.

| Endpoint | Purpose |
|---|---|
| `POST /api/agent/texts?title=&ttlDays=&note=` | Raw Markdown body (`Content-Type: text/markdown`), or JSON `{title?, markdown, ttlDays?, note?}` → `201 {id, title, format, words, expiresAt, note, url}`; `url` opens the text in the reader. The text deletes itself after `ttlDays` (default 30; 0 keeps it). `note` (up to 500 characters) is the agent's note to find it by, such as its session id |
| `GET /api/agent/texts?note=&limit=&cursor=` | Texts agents added (not the user's own), newest change first; with `note`, those whose note contains it. With `limit` (1–100), a page: `{texts: [{id, title, format, words, progress, updatedAt, expiresAt, url}], nextCursor, total}`; pass `nextCursor` as `cursor` for the next page (none on the last). Without `limit`, all of them as a plain list `[{id, title, format, words, updatedAt, expiresAt, url}]` |
| `GET /api/agent/texts/{id}` | One text an agent added, with its Markdown: `{id, title, …, markdown}`, or the Markdown alone with `Accept: text/markdown`. `404` for the user's own texts |
| `PUT /api/agent/texts/{id}?title=` | Rewrite a text an agent added; same bodies as a new text. A title renames it, none keeps the old one (`ttlDays` is ignored) → `200 {id, title, …}`. Same link and reading place; starts its 30 days again. A `note` replaces its note (`""` removes it), none keeps it. `404` for the user's own texts |
| `POST /api/agent/texts/{id}/append` | Add to the end of a text an agent added, after a `---` line; same bodies as a new text (a title is ignored) → `200 {id, title, …}`. Starts its 30 days again (a longer time to live, or none, stays). `404` for the user's own texts, `413` past the length limit |
| `DELETE /api/agent/texts/{id}` | Delete a text an agent added → `204`. `404` for the user's own texts |
| `GET /api/agent/whoami` | Check a token: `{ok, user, shelf}` |
| `POST /mcp` | The same as an [MCP server](agents.md#or-connect-over-mcp) (Streamable HTTP, no sessions, JSON responses): tools `create_book`, `list_books`, `show_book`, `update_book`, `delete_book`. `401` without a valid agent token |
| `GET /skills/lingolens.zip` | The agent skill, ready to unzip into a skills folder (public) |
