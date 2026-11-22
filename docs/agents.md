# AI agents

Let Claude Code (or any agent or script) save replies to your shelf, so you can read them later with glosses at your level. Agents connect in one of two ways: the **skill** (a script for agents that run shell commands) or the **MCP server** (tools for agents that speak the Model Context Protocol). Both use the same agent token and can do the same things.

## Set up

1. In LingoLens, open **Settings → Agent Access**, name a token and create it. Copy the two lines it shows into your shell profile or your agent's environment:
   ```sh
   export LINGOLENS_URL=https://read.example.com
   export LINGOLENS_TOKEN=llat_…
   ```
   Agents often run commands in a shell that hasn't read your profile, so the skill's script also looks for these two lines in `~/.zshenv`, `~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile` and `~/.config/lingolens/env` when they aren't set. It reads the values as text and never runs those files.
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

## Or connect over MCP

LingoLens is also an MCP server, at `/mcp` on your server's address (Streamable HTTP; **Settings → Agent Access** shows the address). It offers five tools:

| Tool | Does |
|---|---|
| `create_book` | Save a Markdown text to the shelf: `{markdown, title?, ttlDays?, note?}` → its id and link. `note` is the agent's own note on it, such as its session id, to find it by later |
| `list_books` | The texts agents saved, newest change first, a page at a time: `{note?, limit?, cursor?}` → `{books, nextCursor, total}`; pass `nextCursor` back as `cursor` for the next page (1–100 a page, 20 by default). With `note`, only the texts whose note contains it |
| `show_book` | One of them, with its Markdown, length, link and how much you've read: `{id}` |
| `update_book` | Rewrite one (`mode: "replace"`, the default; a `title` renames it) or add to its end (`mode: "append"`): `{id, markdown, mode?, title?, note?}`. A `note` replaces its note (`""` removes it) |
| `delete_book` | Delete one: `{id}` |

Send the token as a header, `Authorization: Bearer llat_…`. For Claude Code, with `LINGOLENS_TOKEN` set as above:

```sh
claude mcp add --transport http lingolens https://read.example.com/mcp \
  --header "Authorization: Bearer $LINGOLENS_TOKEN"
```

Other clients (Codex, Cursor, VS Code and so on) take the same address and header in their MCP settings. The skill tells agents to use these tools when they're connected, so you can have both.

## Use

Ask the agent things like "explain the present perfect and save it to LingoLens" or "write me a B1 article about coffee for LingoLens". It replies with a link to the new text.

Ask it to add more on the same topic ("add a part about roasting to my coffee text") and it adds to the end of that text, after a separator line, instead of starting a new one.

Agents note where a text came from (their session id, for instance) when they save it, so they find their own texts again in a later turn without guessing by title.

Ask it to change a text it saved ("fix the mistakes in my coffee text", "rewrite the phrasal verbs one at A2") and it rewrites that text in place: same link, same place in your reading.

Ask it to delete one ("delete my coffee notes from LingoLens") and it does, after asking which one if it isn't sure. Deleting can't be undone.

If the text is open when an agent changes it, LingoLens shows the new version within 30 seconds (at once when you come back to the tab) and tells you: **New content was added at the end**, with **Show** to jump to it, or **This text was updated**.

Texts saved by agents delete themselves after 30 days, so quick replies don't pile up. Adding to a text starts its 30 days again. To keep one, open it and choose **Edit text → Delete automatically → Never**, or ask the agent to keep it when saving.

## What a token can do

A token can add texts to its owner's shelf, and list, read, rewrite, add to and delete the texts agents saved, over the agent API or MCP. It can't read, change or delete the texts you added yourself. Revoke a token any time in **Settings → Agent Access**.

## Without the skill

Any script can upload Markdown:

```sh
curl -X POST "$LINGOLENS_URL/api/agent/texts?title=Notes" \
  -H "Authorization: Bearer $LINGOLENS_TOKEN" \
  -H "Content-Type: text/markdown" --data-binary @notes.md
```

See the [agent API](api.md#agent-api) for listing, reading, rewriting, adding to and deleting texts.
