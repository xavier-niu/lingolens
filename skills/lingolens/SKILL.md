---
name: lingolens
description: Save a reply, explanation, article or notes to the user's LingoLens shelf as a Markdown text, so they can read it later with Chinese glosses pitched at their English level. Use when the user asks to send, save or put something "in LingoLens", "on my shelf" or "in my reading list", or asks for English reading material for LingoLens (for example "write me a B1 article about coffee and put it in LingoLens").
---

# LingoLens

LingoLens is a reading app for Chinese speakers learning English. It shows a text
with Chinese glosses above the words and phrases the reader probably doesn't know
at their CEFR level (A1–C2), and lets them tap any word or ask AI about a
sentence. This skill uploads Markdown to the user's shelf through the agent API.

## Setup

The upload needs two environment variables:

- `LINGOLENS_URL`: the address of the user's LingoLens, such as `https://read.example.com`
- `LINGOLENS_TOKEN`: an agent token starting with `llat_`

The user creates the token in LingoLens under **Settings → Agent Access**; the page
shows both lines ready to copy. Check the setup with:

```bash
scripts/upload.sh --check
```

If either variable is missing or the check fails, tell the user how to set it up
and stop. Don't guess an address or ask them to paste the token into the chat.

## Writing the text

- **English only.** LingoLens adds the Chinese glosses itself, so don't add
  translations, pinyin or vocabulary lists unless the user asks for them.
- **Match the level** if the user gives one: A1–A2 short sentences and everyday
  words; B1–B2 natural everyday English; C1–C2 rich, idiomatic English. Without a
  level, write clear, natural English.
- **Simple Markdown:** a `#` title, `##` section headings, paragraphs, lists,
  `**bold**`, `*italic*`, `> quotes` and code blocks. Avoid HTML, images and wide
  tables; texts are often read on a phone.
- The first heading becomes the title unless you pass `--title`.
- For long texts, use three or more `##` headings: the reader turns them into a
  Contents list.
- When saving an earlier reply, upload it as it was, minus chat asides like
  "Sure! Here's…".
- The limit is 2,000,000 characters.

## Uploading

Write the Markdown to a file, then:

```bash
scripts/upload.sh reply.md --title "Optional Title"
```

or pipe it in:

```bash
scripts/upload.sh - --title "Optional Title" < reply.md
```

The script prints a link that opens the text in the reader. Give the user that
link. The script lives next to this file: run it from the skill directory or by
its full path.

### Without the script

```bash
curl -fsS -X POST "$LINGOLENS_URL/api/agent/texts?title=Optional%20Title" \
  -H "Authorization: Bearer $LINGOLENS_TOKEN" \
  -H "Content-Type: text/markdown; charset=utf-8" \
  --data-binary @reply.md
```

JSON works too: `Content-Type: application/json` with `{"title": "…", "markdown": "…"}`.
A successful response is `201` with `{"id", "title", "format", "words", "url"}`.

| Status | Meaning |
| --- | --- |
| 401 | Token missing, wrong or revoked. Ask the user to create a new one. |
| 400 | The text was rejected (for example, it was empty); the `error` field says why. |
| 413 | Too large. Split it into parts and upload each one. |

## Privacy

Upload only what the user asked to save. Never print the token or include it in
the uploaded text.
