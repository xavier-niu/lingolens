# AI agents

Let Claude Code (or any agent or script) save replies to your shelf, so you can read them later with glosses at your level.

## Set up

1. In LingoLens, open **Settings → Agent Access**, name a token and create it. Copy the two lines it shows into your shell profile or your agent's environment:
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
   Or use **Download Skill** on the same page and unzip it into the agent's skills folder, or copy [`skills/lingolens`](../skills/lingolens) from this repository. The CLI installs the skill from GitHub, so `npx skills update` picks up new versions.

## Use

Ask the agent things like "explain the present perfect and save it to LingoLens" or "write me a B1 article about coffee for LingoLens". It replies with a link to the new text.

Ask it to add more on the same topic ("add a part about roasting to my coffee text") and it adds to the end of that text, after a separator line, instead of starting a new one.

Texts saved by agents delete themselves after 30 days, so quick replies don't pile up. Adding to a text starts its 30 days again. To keep one, open it and choose **Edit text → Delete automatically → Never**, or ask the agent to keep it when saving.

## What a token can do

A token can add texts to its owner's shelf, list the texts agents saved, and add to those texts. It can't read any text's content or change the texts you added yourself. Revoke a token any time in **Settings → Agent Access**.

## Without the skill

Any script can upload Markdown:

```sh
curl -X POST "$LINGOLENS_URL/api/agent/texts?title=Notes" \
  -H "Authorization: Bearer $LINGOLENS_TOKEN" \
  -H "Content-Type: text/markdown" --data-binary @notes.md
```

See the [agent API](api.md#agent-api) for listing and adding to texts.
