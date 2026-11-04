#!/usr/bin/env bash
# Upload Markdown to the LingoLens shelf and print the link to read it.
#
#   upload.sh FILE [--title TITLE] [--ttl DAYS]
#                                      upload a Markdown file as a new text; it is
#                                      deleted after 30 days, or DAYS (0: keep it)
#   upload.sh - [--title TITLE]        upload Markdown from stdin
#   upload.sh FILE --append ID         add to the end of text ID, after a --- line
#   upload.sh FILE --replace ID [--title TITLE]
#                                      rewrite text ID with FILE (a title renames it)
#   upload.sh --get ID                 print the Markdown of text ID
#   upload.sh --list                   list the texts agents saved: ID, words, title
#   upload.sh --check                  check LINGOLENS_URL and LINGOLENS_TOKEN
#
# Needs bash and curl. Reads LINGOLENS_URL and LINGOLENS_TOKEN from the environment,
# or else from the export lines in the user's shell startup files (create a token
# in LingoLens: Settings → Agent Access).
set -euo pipefail

die() { printf 'lingolens: %s\n' "$*" >&2; exit 1; }

# Agents often run commands in a shell that never read ~/.zshrc or ~/.bashrc, so
# when a variable isn't set, take it from a plain `export NAME=value` line there.
# The value is read as text, never run: one that needs the shell ($…, `…`) is skipped.
from_profile() {
  local name="$1" f line val
  for f in "${LINGOLENS_ENV_FILE:-}" "$HOME/.config/lingolens/env" "$HOME/.zshenv" \
    "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [[ -n "$f" && -f "$f" && -r "$f" ]] || continue
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$name=" "$f" | tail -n 1)" || true
    [[ -n "$line" ]] || continue
    val="${line#*=}"
    case "$val" in
      \"*) val="${val#\"}"; val="${val%%\"*}" ;;
      \'*) val="${val#\'}"; val="${val%%\'*}" ;;
      *) val="${val%%[[:space:];]*}" ;;
    esac
    [[ -n "$val" && "$val" != *[\$\`\\]* ]] || continue
    printf -v "$name" '%s' "$val"
    found_in+=("${f/#"$HOME"/\~}")
    return 0
  done
}
found_in=()
[[ -n "${LINGOLENS_URL:-}" ]] || from_profile LINGOLENS_URL || true
[[ -n "${LINGOLENS_TOKEN:-}" ]] || from_profile LINGOLENS_TOKEN || true
[[ -n "${LINGOLENS_URL:-}" ]] || die "LINGOLENS_URL is not set, in the environment or a shell startup file (e.g. export LINGOLENS_URL=https://read.example.com in ~/.zshrc)."
[[ -n "${LINGOLENS_TOKEN:-}" ]] || die "LINGOLENS_TOKEN is not set, in the environment or a shell startup file. Create a token in LingoLens: Settings → Agent Access."
command -v curl >/dev/null || die "curl is required."
base="${LINGOLENS_URL%/}"

# Percent-encode a string byte by byte (works for UTF-8 titles).
urlencode() {
  local LC_ALL=C s="$1" out="" c i hex
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) printf -v hex '%%%02X' "'$c"; out+="$hex" ;;
    esac
  done
  printf '%s' "$out"
}

# request METHOD PATH [curl args…]: prints the body; fails with the server's message.
request() {
  local method="$1" path="$2" out status body
  shift 2
  out="$(curl -sS -X "$method" "$base$path" \
    -H "Authorization: Bearer $LINGOLENS_TOKEN" \
    -w $'\n%{http_code}' "$@")" || die "couldn't reach $base."
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
  if [[ "$status" != 2* ]]; then
    local msg
    msg="$(printf '%s' "$body" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')"
    die "HTTP $status: ${msg:-$body}"
  fi
  printf '%s' "$body"
}

# The value of a JSON string field, escapes kept (\" stays \").
field() { sed -nE "s/.*\"$1\":\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p"; }

if [[ "${1:-}" == "--check" ]]; then
  body="$(request GET /api/agent/whoami)"
  printf 'OK: uploads go to the shelf of %s (%s)\n' "$(printf '%s' "$body" | field user)" "$(printf '%s' "$body" | field shelf)"
  ((${#found_in[@]} == 0)) || printf 'Settings read from %s\n' "$(printf '%s\n' "${found_in[@]}" | sort -u | paste -sd, - | sed 's/,/, /g')"
  exit 0
fi

if [[ "${1:-}" == "--get" || "${1:-}" == --get=* ]]; then
  if [[ "$1" == --get=* ]]; then id="${1#--get=}"; else id="${2:-}"; fi
  [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || die "--get needs a text ID (see --list)"
  md="$(request GET "/api/agent/texts/$id" -H "Accept: text/markdown")"
  printf '%s\n' "$md"
  exit 0
fi

if [[ "${1:-}" == "--list" ]]; then
  body="$(request GET /api/agent/texts)"
  # One object per line, then: ID<TAB>WORDS<TAB>UPDATED<TAB>TITLE, newest first.
  rows="$(printf '%s' "$body" | sed 's/},{/}\n{/g')"
  [[ "$rows" == "[]" ]] && { echo "No texts saved by agents yet."; exit 0; }
  printf '%s\n' "$rows" | while IFS= read -r row; do
    printf '%s\t%s\t%s\t%s\n' "$(printf '%s' "$row" | field id)" \
      "$(printf '%s' "$row" | sed -n 's/.*"words":\([0-9]*\).*/\1/p')" \
      "$(printf '%s' "$row" | field updatedAt)" "$(printf '%s' "$row" | field title)"
  done
  exit 0
fi

src="${1:-}"
[[ -n "$src" && "$src" != --* ]] || die "usage: upload.sh FILE|- [--title TITLE] [--ttl DAYS] | FILE|- --append ID | FILE|- --replace ID [--title TITLE] | --get ID | --list | --check"
shift
title=""
append=""
replace=""
ttl=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) [[ $# -ge 2 ]] || die "--title needs a value"; title="$2"; shift 2 ;;
    --title=*) title="${1#--title=}"; shift ;;
    --append) [[ $# -ge 2 ]] || die "--append needs a text ID (see --list)"; append="$2"; shift 2 ;;
    --append=*) append="${1#--append=}"; shift ;;
    --replace) [[ $# -ge 2 ]] || die "--replace needs a text ID (see --list)"; replace="$2"; shift 2 ;;
    --replace=*) replace="${1#--replace=}"; shift ;;
    --ttl) [[ $# -ge 2 ]] || die "--ttl needs a number of days (0: keep forever)"; ttl="$2"; shift 2 ;;
    --ttl=*) ttl="${1#--ttl=}"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -z "$append" || "$append" =~ ^[A-Za-z0-9_-]+$ ]] || die "not a text ID: $append"
[[ -z "$append" || -z "$title" ]] || die "--append keeps the text's title; leave out --title"
[[ -z "$append" || -z "$ttl" ]] || die "--append renews the text's own time; leave out --ttl"
[[ -z "$replace" || "$replace" =~ ^[A-Za-z0-9_-]+$ ]] || die "not a text ID: $replace"
[[ -z "$append" || -z "$replace" ]] || die "use --append or --replace, not both"
[[ -z "$replace" || -z "$ttl" ]] || die "--replace renews the text's own time; leave out --ttl"
[[ -z "$ttl" || "$ttl" =~ ^[0-9]+$ ]] || die "--ttl takes a number of days (0: keep forever)"

if [[ "$src" == "-" ]]; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  cat >"$tmp"
  src="$tmp"
fi
[[ -f "$src" ]] || die "no such file: $src"
[[ -s "$src" ]] || die "the file is empty: $src"

method=POST
if [[ -n "$append" ]]; then
  path="/api/agent/texts/$append/append"
  done_msg='Added to "%s" (%s words now)\n%s\n'
elif [[ -n "$replace" ]]; then
  method=PUT
  path="/api/agent/texts/$replace"
  [[ -n "$title" ]] && path+="?title=$(urlencode "$title")"
  done_msg='Rewrote "%s" (%s words now)\n%s\n'
else
  path="/api/agent/texts?ttlDays=${ttl:-30}"
  [[ -n "$title" ]] && path+="&title=$(urlencode "$title")"
  done_msg='Saved "%s" (%s words)\n%s\n'
fi
body="$(request "$method" "$path" -H "Content-Type: text/markdown; charset=utf-8" --data-binary "@$src")"

printf "$done_msg" \
  "$(printf '%s' "$body" | field title)" \
  "$(printf '%s' "$body" | sed -n 's/.*"words":\([0-9]*\).*/\1/p')" \
  "$(printf '%s' "$body" | field url)"
expires="$(printf '%s' "$body" | field expiresAt)"
if [[ -n "$expires" ]]; then printf 'Deleted on its own after %s (UTC) unless kept.\n' "$expires"
else printf 'Kept until deleted.\n'; fi
