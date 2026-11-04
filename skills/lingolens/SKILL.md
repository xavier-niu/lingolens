---
name: lingolens
description: Save a reply, explanation, article or notes to the user's LingoLens shelf as a Markdown text, so they can read it later with Chinese glosses pitched at their English level, or add to, fix or rewrite a text saved there before. Use when the user asks to send, save or put something "in LingoLens", "on my shelf" or "in my reading list", asks for English reading material for LingoLens (for example "write me a B1 article about coffee and put it in LingoLens"), or asks to add to, update, correct, rewrite or retitle a text already in LingoLens.
---

# LingoLens

LingoLens is a reading app for Chinese speakers learning English. It shows a text
with Chinese glosses above the words and phrases the reader probably doesn't know
at their CEFR level (A1–C2), and lets them tap any word or ask AI about a
sentence. This skill uploads Markdown to the user's shelf through the agent API:
as a new text, added to the end of one saved before, or as a new version of one
saved before.

## Setup

The upload needs two environment variables:

- `LINGOLENS_URL`: the address of the user's LingoLens, such as `https://read.example.com`
- `LINGOLENS_TOKEN`: an agent token starting with `llat_`

The user creates the token in LingoLens under **Settings → Agent Access**; the page
shows both lines ready to copy.

**Just run the script.** Your shell may not have these variables even when the
user has set them up: commands often run in a shell that never read `~/.zshrc`
or `~/.bashrc`. The script handles that itself. When a variable isn't in the
environment, it reads the `export LINGOLENS_…=` line from the user's shell
startup files (`~/.zshenv`, `~/.zshrc`, `~/.zprofile`, `~/.bashrc`,
`~/.bash_profile`, `~/.profile`) or from `~/.config/lingolens/env`. So don't
check `$LINGOLENS_URL` or `$LINGOLENS_TOKEN` yourself, don't source or read those
files, and don't ask the user for them: run the script, and only if it fails,
check the setup with:

```bash
scripts/upload.sh --check
```

If that fails too, tell the user how to set it up (the message says what's
missing) and stop. Don't guess an address or ask them to paste the token into the
chat.

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

## Finding a text saved before

To add to or change a text, you need its ID. If it was saved in this
conversation, the ID is the end of its link (`…/#/read/ID`). Otherwise list the
texts agents saved, newest change first:

```bash
scripts/upload.sh --list
```

Each line is `ID`, words, last changed and title, separated by tabs. Pick the one
whose title matches what the user means. If none matches, say so (and, when they
asked to add to it, save a new text). If several might, ask the user which one;
don't guess.

Only texts saved by agents can be read, added to or changed. The user's own texts
(pasted, web pages, books) aren't listed, and the API answers 404 for them.

## Adding to a text on the same topic

When the user asks to update a topic that is already in LingoLens, or to save
more on the same topic as a text saved before ("add this to my coffee notes",
"put the follow-up in the same text", "update the phrasal verbs one"), add it to
the end of that text instead of saving a new one. LingoLens puts a separator line
(`---`) before the new part; the text keeps its title, link and the reader's
place.

1. **Find the text's ID** (above).
2. **Write only the new part.** Start it with a `##` heading saying what it adds
   (not the `#` title again), and don't repeat what the text already says. The
   same writing rules apply, at the same level as before.
3. **Add it:**

   ```bash
   scripts/upload.sh more.md --append ID
   ```

   Give the user the link it prints; it's the same link as before. Adding
   starts the 30 days again (a longer time, or "never", stays as it is).

If adding fails with 404, the text was deleted or isn't an agent's: save a new
text and say why. If it fails with 413, the text would grow past the limit: save
the new part as a new text, titled like "Coffee, Part 2".

## Changing a text

When the user asks to change a text saved before ("fix the mistakes in my coffee
text", "rewrite the phrasal verbs one at A2", "rename it to …", "remove the part
about prices"), rewrite it in place instead of saving a new copy. It keeps its
link and the reader's place, and its 30 days start again.

1. **Find the text's ID** (above).
2. **Get what it says now:**

   ```bash
   scripts/upload.sh --get ID > text.md
   ```

   It prints the whole Markdown. Edit that, so the parts the user didn't ask
   about stay as they were; don't rewrite it from memory. To change only the
   title, keep the content as it is and pass `--title`.
3. **Save the new version:**

   ```bash
   scripts/upload.sh text.md --replace ID
   scripts/upload.sh text.md --replace ID --title "New Title"
   ```

   Without `--title` the text keeps its title. Give the user the link it
   prints and say in a line what changed.

To add a new section, prefer adding to the text (above) over rewriting it. A
rewrite replaces the whole text, including anything added to it since you read
it, so get it again right before you change it.

## Without the script

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
fields. To rewrite one, send the whole new text the same way to
`PUT $LINGOLENS_URL/api/agent/texts/ID` (a title renames it; none keeps it).
`GET $LINGOLENS_URL/api/agent/texts/ID` returns one with its Markdown (with
`Accept: text/markdown`, the Markdown alone), and
`GET $LINGOLENS_URL/api/agent/texts` lists the texts agents saved, newest change
first, with the same fields.

| Status | Meaning |
| --- | --- |
| 401 | Token missing, wrong or revoked. Ask the user to create a new one. |
| 400 | The text was rejected (for example, it was empty); the `error` field says why. |
| 404 | Reading or changing a text that was deleted or that the user added themselves. Save a new text. |
| 413 | Too large. Split it into parts and upload each one; when adding, save the new part as a new text. |

## Privacy

Upload only what the user asked to save. Never print the token or include it in
the uploaded text.
