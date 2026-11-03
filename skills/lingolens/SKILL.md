---
name: lingolens
description: Save a reply, explanation, article or notes to the user's LingoLens shelf as a Markdown text, so they can read it later with Chinese glosses pitched at their English level, or add more to a text saved earlier on the same topic. Use when the user asks to send, save or put something "in LingoLens", "on my shelf" or "in my reading list", asks for English reading material for LingoLens (for example "write me a B1 article about coffee and put it in LingoLens"), or asks to add to or update a topic already in LingoLens.
---

# LingoLens

LingoLens is a reading app for Chinese speakers learning English. It shows a text
with Chinese glosses above the words and phrases the reader probably doesn't know
at their CEFR level (A1–C2), and lets them tap any word or ask AI about a
sentence. This skill uploads Markdown to the user's shelf through the agent API,
as a new text or added to the end of one saved before.

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

### How long texts stay

A text you save **deletes itself after 30 days**, so quick replies don't pile up
on the shelf. Tell the user so when you give them the link. The user can keep it
in LingoLens (Edit text → Delete automatically → Never). Choose differently only
when the user asks:

- "keep it", "save it for good", "permanently": `--ttl 0` (never deleted)
- a time ("for a week", "for three months"): `--ttl 7`, `--ttl 90` (days, up to 3650)

```bash
scripts/upload.sh reply.md --title "Optional Title" --ttl 0
```

## Adding to a text on the same topic

When the user asks to update a topic that is already in LingoLens, or to save
more on the same topic as a text saved before ("add this to my coffee notes",
"put the follow-up in the same text", "update the phrasal verbs one"), add it to
the end of that text instead of saving a new one. LingoLens puts a separator line
(`---`) before the new part; the text keeps its title, link and the reader's
place.

1. **Find the text's ID.** If it was saved in this conversation, the ID is the
   end of its link (`…/#/read/ID`). Otherwise list the texts agents saved,
   newest first:

   ```bash
   scripts/upload.sh --list
   ```

   Each line is `ID`, words, last changed and title, separated by tabs. Pick the
   one whose title matches the topic. If none matches, save a new text. If
   several might, ask the user which one; don't guess.
2. **Write only the new part.** Start it with a `##` heading saying what it adds
   (not the `#` title again), and don't repeat what the text already says. The
   same writing rules apply, at the same level as before.
3. **Add it:**

   ```bash
   scripts/upload.sh more.md --append ID
   ```

   Give the user the link it prints; it's the same link as before. Adding
   starts the 30 days again (a longer time, or "never", stays as it is).

Only texts saved by agents can be added to; the user's own texts (pasted, web
pages, books) can't be changed and aren't listed. If adding fails with 404, the
text was deleted or isn't an agent's: save a new text and say why. If it fails
with 413, the text would grow past the limit: save the new part as a new text,
titled like "Coffee, Part 2".

### Without the script

```bash
curl -fsS -X POST "$LINGOLENS_URL/api/agent/texts?title=Optional%20Title" \
  -H "Authorization: Bearer $LINGOLENS_TOKEN" \
  -H "Content-Type: text/markdown; charset=utf-8" \
  --data-binary @reply.md
```

JSON works too: `Content-Type: application/json` with `{"title": "…", "markdown": "…", "ttlDays": 30}`.
`ttlDays` (or `?ttlDays=` with raw Markdown) is how many days the text stays,
30 when left out and 0 for never. A successful response is `201` with
`{"id", "title", "format", "words", "updatedAt", "expiresAt", "url"}`; `expiresAt`
is empty for a text that is kept.

To add to a text, send the new part the same way (a title is ignored) to
`POST $LINGOLENS_URL/api/agent/texts/ID/append`; it answers `200` with the same
fields. `GET $LINGOLENS_URL/api/agent/texts` lists the texts agents saved, newest
change first, with the same fields.

| Status | Meaning |
| --- | --- |
| 401 | Token missing, wrong or revoked. Ask the user to create a new one. |
| 400 | The text was rejected (for example, it was empty); the `error` field says why. |
| 404 | Adding to a text that was deleted or that the user added themselves. Save a new text. |
| 413 | Too large. Split it into parts and upload each one; when adding, save the new part as a new text. |

## Privacy

Upload only what the user asked to save. Never print the token or include it in
the uploaded text.
