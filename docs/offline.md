# Offline use

Each browser keeps a copy of the signed-in account: the shelf with every text's content (downloaded in the background), glosses for paragraphs already annotated, looked-up words, the wordbook, known words and the profile. A service worker ([`sw.js`](../web/static/sw.js)) keeps the app itself.

## What works offline

You can read any text on the shelf (paragraphs annotated before show their glosses; the others are glossed when you're back), open words you looked up before, save words, mark words known, add pasted text or a PDF (once a PDF has been read online, which loads the PDF reader), edit or delete texts and change settings.

New lookups, Ask AI, web-page and EPUB imports and account settings need a connection.

A badge in the header says **Offline**, then **Syncing…** and **Synced**.

## Syncing

Changes wait in an outbox (IndexedDB) and are sent in order when the server is reachable again (checked on reconnect and every 15 s), then fresh data is fetched, so changes from other devices arrive too. The app also syncs when you come back to its tab, so a text that changed elsewhere (say, an AI agent added to it) shows its new version, in place.

Conflicts resolve simply: furthest progress wins, a reading position only replaces a newer one from another device if it is newer itself, and otherwise the last change sent wins. If the server rejects a change (say, a text it finds invalid), the app says so instead of retrying forever.

Signing out removes the account's copy from the browser; if changes haven't synced yet, it asks first.

## HTTPS is required

Browsers only run service workers on secure origins: serve LingoLens over **HTTPS** (or use it on `localhost`). Over plain HTTP on a LAN address the app still works online and keeps its data copy, but a reload without a connection can't open it.
