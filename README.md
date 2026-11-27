<p align="center">
  <img src="docs/logo.svg" width="96" height="96" alt="LingoLens logo">
</p>

<h1 align="center">LingoLens</h1>

<p align="center">
  <b>Read real English, with Chinese meanings only where you need them.</b><br>
  读真实的英文，只在你可能不认识的词上方标注中文。
</p>

LingoLens is a reading app for Chinese speakers learning English. Add an article, a web page, an e-book or a PDF, and LingoLens shows it as a clean page with short Chinese glosses above the words and phrases a reader at your level probably doesn't know. Everything else stays plain English, so you keep reading instead of translating.

It runs on your own server and uses your own AI key. One server can host a whole family or class, with a separate shelf for each person.

## What you can do

**Read at your level**
- Choose your level from A1 to C2, shown with familiar Chinese equivalents such as 高考, 四级 / 六级 and 雅思 / 托福. The higher your level, the fewer words get glosses, and words your level certainly knows never get one.
- Phrases like *take into account*, *by and large* and *run out of* are glossed as a whole, not word by word.
- Tap any word, glossed or not, to hear it or choose **Look Up** or **Details** for its meaning in this sentence, other meanings and examples. The model is only asked when you choose.
- Select a sentence and choose **Ask AI** to ask about its grammar, a translation or more examples.
- Your Ask AI conversations are kept in **Ask AI history**, so you can reread them and keep asking where you left off.
- Mark words you know so their glosses go away (and bring them back in Settings).

**Bring anything to read**
- Paste text, or Markdown with headings and lists (found on its own; keep it as plain text if you'd rather). Lines wrapped at a terminal's or an email's width flow back into paragraphs. Add more to the end of a text later with **Append Text**, and keep your place.
- Import a web page from its link: you get just the article, without menus, ads or comments.
- Add a DRM-free EPUB book, or a PDF with selectable text. Long texts get a table of contents.
- For sites that block imports, or pages you need to sign in to, use the **bookmarklet** from your browser's bookmarks bar.
- Let **AI agents** such as Claude Code save their replies to your shelf, add follow-ups to the same text, and list, update or delete what they saved, with the skill or the built-in **MCP server**.

**Read anywhere, your way**
- Works on phones, tablets and computers. You come back to where you stopped, on any device.
- Progress counts what you've had time to read, so jumping to the end to see how long a text is doesn't mark it finished.
- A sidebar replaces the top bar (on a phone or tablet it slides in from the button at the top left, and hides again once used): Add Source, the text to continue reading, and the shelf with filters (Read Later, Reading, Not Started, Finished, Deleting Soon). In a text it adds your Ask AI conversations about it, how far along you are, and the AI tokens it has used (read afresh, read from the prompt cache, and written).
- Mark any text to read later, from the shelf or while reading. Search the shelf by title, and show it as cards or as a list with each text's length, progress, time left and when it was updated.
- Works offline: read your whole shelf, save words and add texts without a connection. Everything syncs when you're back online.
- Choose the English font (Inter, Source Serif, Lexend or Atkinson Hyperlegible, all built in so they look the same on every device) and the Chinese font (黑体, 宋体 or 楷体), plus text size, line width, and a light or dark theme. Set your defaults in Settings for every device, or change them on one device while you read.
- The interface is in English or Chinese.
- Texts can delete themselves after a day, a week, a month or longer. Texts saved by AI agents go after 30 days unless you keep them.

## Deploy

### What you need

- **A computer to run it on:** a small cloud server, a home server or NAS, or your own laptop, with [Docker](https://docs.docker.com/get-docker/) installed.
- **An API key from an AI provider.** Anthropic (Claude), OpenAI, DeepSeek, OpenRouter, Qwen (通义千问) and Moonshot (Kimi) are built in. Any other OpenAI-compatible API also works, including models on your own machine through Ollama or LiteLLM. Each person adds their own key in Settings; keys are stored encrypted and never sent back to the browser.

LingoLens keeps API costs down by glossing paragraphs only as you scroll to them, and remembers the results.

### Start it with Docker

```sh
docker run -d --name lingolens --restart unless-stopped \
  -p 8080:8080 -v lingolens-data:/data \
  xavierniu/lingolens:latest
```

Open <http://localhost:8080> (or the server's address on port 8080). The first visit asks you to create the admin account.

> [!IMPORTANT]
> Whoever opens a new server first becomes its admin, so create your account right after starting it. To create the admin before anyone can connect, add `-e LINGOLENS_ADMIN_EMAIL=you@example.com -e LINGOLENS_ADMIN_PASSWORD='a long password'`. These are used only while the server has no accounts.

Or with Docker Compose, in a `compose.yaml`:

```yaml
services:
  lingolens:
    image: xavierniu/lingolens:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - lingolens-data:/data

volumes:
  lingolens-data:
```

Then run `docker compose up -d`.

### Put it on the internet with HTTPS

To use LingoLens from your phone or anywhere outside your home, put it behind a web server that provides HTTPS. HTTPS is also what lets the app open without a connection. With [Caddy](https://caddyserver.com/), which gets certificates for you, the whole configuration is:

```
read.example.com {
    reverse_proxy localhost:8080
}
```

Then start LingoLens so it is reachable only through Caddy and knows its public address:

```sh
docker run -d --name lingolens --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v lingolens-data:/data \
  -e LINGOLENS_SECURE_COOKIES=1 \
  -e LINGOLENS_PUBLIC_URL=https://read.example.com \
  xavierniu/lingolens:latest
```

All settings are listed in [Configuration](docs/configuration.md).

### Update

```sh
docker pull xavierniu/lingolens:latest
docker rm -f lingolens
# then run the same `docker run` command as before
```

With Compose, run `docker compose pull && docker compose up -d`. Your data stays in the `lingolens-data` volume, and the database is upgraded automatically on start.

If the app shows codes like `clip.title` instead of text after an update, your browser or a CDN in front of LingoLens is still serving old files. Reload with Ctrl+Shift+R (Cmd+Shift+R on a Mac), and purge the CDN's cache if you use one.

### Back up

Everything lives in the data volume: the database `lingolens.db` and `secret.key`, which encrypts the stored API keys. Back up both together. Without `secret.key`, everyone has to enter their API key again. To copy them to `lingolens-backup.tgz` in the current folder:

```sh
docker stop lingolens
docker run --rm -v lingolens-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/lingolens-backup.tgz -C /data .
docker start lingolens
```

### Without Docker

LingoLens is a single program with no other dependencies. To build it from source you need [Go](https://go.dev/dl/) 1.27 or later and [Node.js](https://nodejs.org/) 20 or later, for the web app built into it:

```sh
make build
./lingolens -addr 0.0.0.0:8080 -data /var/lib/lingolens
```

See [Development](docs/development.md) for more.

## First steps

1. **Create your account.** On a new server, the first visit asks for the admin's email and password.
2. **Set up your AI model.** Open **Settings**, choose your English level, pick a provider and model, and paste your API key.
3. **Add something to read.** Choose **Add Source** and paste text, enter a link, or pick a book or PDF. On an empty shelf, **Use a Sample Text** gives you something to try.
4. **Read.** Glosses appear as you scroll. Tap a word for details, select text to **Ask AI**, and use **Aa** for fonts and text size on this device.
5. **Invite others.** As admin, add accounts in **Settings → Members**. Each person sets up their own level and AI key.

## Learn more

- [Adding texts](docs/importing.md): web pages, PDFs and the bookmarklet
- [AI agents](docs/agents.md): let Claude Code and other agents save their replies to your shelf, with the skill or over MCP
- [Offline use](docs/offline.md): what works without a connection, and how syncing works
- [Configuration](docs/configuration.md): all settings, and managing accounts from the command line
- [Security](docs/security.md): how accounts, keys and imports are protected
- [API](docs/api.md): the HTTP API, including the agent API
- [Development](docs/development.md): build, test and contribute
