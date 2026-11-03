# Configuration

LingoLens is configured with command-line flags or environment variables. In Docker, pass environment variables with `-e NAME=value` (or under `environment:` in Compose).

| Flag / env | Default | Meaning |
|---|---|---|
| `-addr` / `LINGOLENS_ADDR` | `127.0.0.1:8080` (`0.0.0.0:8080` in Docker) | Listen address |
| `-data` / `LINGOLENS_DATA` | `./data` (`/data` in Docker) | Holds `lingolens.db` and `secret.key` |
| `LINGOLENS_SECRET` | generated into `secret.key` | 32-byte key (hex or base64) that encrypts stored API keys |
| `LINGOLENS_ADMIN_EMAIL`, `LINGOLENS_ADMIN_PASSWORD` | unset | Create this admin on first start (only while there are no accounts) |
| `LINGOLENS_SECURE_COOKIES=1` | off | Mark the session cookie `Secure`; set it when serving over HTTPS (e.g. behind a TLS proxy) |
| `LINGOLENS_PUBLIC_URL` | from each request | How people reach the app, e.g. `https://read.example.com`; used in the links returned to agents. Set it behind a proxy. |
| `-static` / `LINGOLENS_STATIC_DIR` | embedded | Serve the UI from a directory instead (frontend development, no rebuild needed) |
| `LINGOLENS_FETCH_ALLOW_PRIVATE=1` | off | Let web-page import reach private and loopback addresses. For local testing only. |
| `LINGOLENS_DEV_FAKE=1` | off | Enables an offline "Fake" provider for UI development and tests. It does not translate. |

Everything a user saves lives in a SQLite database in the data directory. Keep it on a volume, and back up `secret.key` (or keep `LINGOLENS_SECRET`) together with the database: without it, stored API keys can't be decrypted and users must enter them again.

## Accounts

**First admin.** A server with no accounts offers first-run setup in the browser, and anyone who reaches it first becomes admin. Finish it right after starting the server, or skip it by creating the admin before anyone can connect: set `LINGOLENS_ADMIN_EMAIL` and `LINGOLENS_ADMIN_PASSWORD`, or run `lingolens user add -admin -email you@example.com`. Setup closes for good once any account exists.

After that, accounts are created by an admin, either in **Settings → Members** or on the command line:

```sh
lingolens user add -email reader@example.com [-name "Mei"] [-admin]
lingolens user list
lingolens user passwd -email reader@example.com   # also signs them out everywhere
lingolens user delete -email reader@example.com   # deletes their shelf, wordbook and settings
```

In Docker, run these inside the container: `docker exec -it lingolens /lingolens user add -email reader@example.com`.

Passwords are prompted without echo, read from stdin when piped, or taken from `LINGOLENS_PASSWORD`. Users can change their own password in Settings.

Texts kept in a browser by older versions are moved into the account on its first sign-in.

## Docker notes

Inside the container, `localhost` refers to the container itself. To reach Ollama or LiteLLM running on the host, use `http://host.docker.internal:…` as the API address (add `--add-host=host.docker.internal:host-gateway` on Linux).

Images are published to Docker Hub as [`xavierniu/lingolens`](https://hub.docker.com/r/xavierniu/lingolens) for `linux/amd64` and `linux/arm64`. Tags: `latest` (the default branch), `X.Y.Z` and `X.Y` (releases), the branch name, and the short commit SHA.

To build the image yourself:

```sh
docker build -t lingolens .
docker run -d -p 8080:8080 -v lingolens-data:/data lingolens
```
