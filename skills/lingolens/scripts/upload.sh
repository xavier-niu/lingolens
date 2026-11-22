#!/usr/bin/env bash
# Upload Markdown to the LingoLens shelf and print the link to read it.
#
#   upload.sh FILE [--title TITLE] [--ttl DAYS] [--note NOTE]
#                                      upload a Markdown file as a new text; it is
#                                      deleted after 30 days, or DAYS (0: keep it).
#                                      NOTE is kept with it to find it by later
#                                      (your session id, say)
#   upload.sh - [--title TITLE]        upload Markdown from stdin
#   upload.sh FILE --append ID [--note NOTE]
#                                      add to the end of text ID, after a --- line
#   upload.sh FILE --replace ID [--title TITLE] [--note NOTE]
#                                      rewrite text ID with FILE (a title renames it;
#                                      a note replaces its note, "" removes it)
#   upload.sh --get ID                 print the Markdown of text ID
#   upload.sh --delete ID              delete text ID from the shelf
#   upload.sh --list [--note NOTE] [--cursor CURSOR]
#                                      list the texts agents saved (with NOTE, those
#                                      whose note contains it), 20 at a time: ID,
#                                      words, last changed, title, note; then the
#                                      command for the next page, if there is one
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

if [[ "${1:-}" == "--delete" || "${1:-}" == --delete=* ]]; then
  if [[ "$1" == --delete=* ]]; then id="${1#--delete=}"; else id="${2:-}"; fi
  [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || die "--delete needs a text ID (see --list)"
  title="$(request GET "/api/agent/texts/$id" | field title)"
  request DELETE "/api/agent/texts/$id" >/dev/null
  printf 'Deleted "%s" from the shelf.\n' "$title"
  exit 0
fi

if [[ "${1:-}" == "--list" ]]; then
  shift
  cursor=""
  note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cursor) [[ $# -ge 2 && -n "$2" ]] || die "--cursor needs the cursor --list printed"; cursor="$2"; shift 2 ;;
      --cursor=*) cursor="${1#--cursor=}"; shift ;;
      --note) [[ $# -ge 2 ]] || die "--note needs the note to look for"; note="$2"; shift 2 ;;
      --note=*) note="${1#--note=}"; shift ;;
      *) die "usage: upload.sh --list [--note NOTE] [--cursor CURSOR]" ;;
    esac
  done
  [[ -z "$cursor" || "$cursor" =~ ^[A-Za-z0-9_-]+$ ]] || die "not a cursor from --list: $cursor"
  path="/api/agent/texts?limit=20"
  [[ -n "$note" ]] && path+="&note=$(urlencode "$note")"
  [[ -n "$cursor" ]] && path+="&cursor=$cursor"
  body="$(request GET "$path")"
  total="$(printf '%s' "$body" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')"
  next="$(printf '%s' "$body" | field nextCursor)"
  if [[ "${total:-0}" == 0 ]]; then
    if [[ -n "$note" ]]; then echo "No texts with a note containing \"$note\"."; else echo "No texts saved by agents yet."; fi
    exit 0
  fi
  # One object per line (the last one ended too, or read skips it), then:
  # ID<TAB>WORDS<TAB>UPDATED<TAB>TITLE<TAB>NOTE, newest first.
  printf '%s\n' "$body" | sed 's/},{/}\n{/g' | while IFS= read -r row; do
    id="$(printf '%s' "$row" | field id)"
    [[ -n "$id" ]] || continue
    printf '%s\t%s\t%s\t%s\t%s\n' "$id" \
      "$(printf '%s' "$row" | sed -n 's/.*"words":\([0-9]*\).*/\1/p')" \
      "$(printf '%s' "$row" | field updatedAt)" "$(printf '%s' "$row" | field title)" "$(printf '%s' "$row" | field note)"
  done
  if [[ -n "$next" ]]; then
    more="$0 --list"
    [[ -n "$note" ]] && more+=" --note $(printf '%q' "$note")"
    printf 'More: %s texts in all. Next page: %s --cursor %s\n' "$total" "$more" "$next"
  fi
  exit 0
fi

src="${1:-}"
[[ -n "$src" && "$src" != --* ]] || die "usage: upload.sh FILE|- [--title TITLE] [--ttl DAYS] | FILE|- --append ID | FILE|- --replace ID [--title TITLE] | --get ID | --delete ID | --list [--note NOTE] [--cursor CURSOR] | --check (any upload takes --note NOTE)"
shift
title=""
append=""
replace=""
ttl=""
note=""
note_set=""
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
    --note) [[ $# -ge 2 ]] || die "--note needs a note (\"\" removes one)"; note="$2"; note_set=1; shift 2 ;;
    --note=*) note="${1#--note=}"; note_set=1; shift ;;
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
query=""
if [[ -n "$append" ]]; then
  path="/api/agent/texts/$append/append"
  done_msg='Added to "%s" (%s words now)\n%s\n'
elif [[ -n "$replace" ]]; then
  method=PUT
  path="/api/agent/texts/$replace"
  [[ -n "$title" ]] && query+="&title=$(urlencode "$title")"
  done_msg='Rewrote "%s" (%s words now)\n%s\n'
else
  path="/api/agent/texts"
  query+="&ttlDays=${ttl:-30}"
  [[ -n "$title" ]] && query+="&title=$(urlencode "$title")"
  done_msg='Saved "%s" (%s words)\n%s\n'
fi
[[ -n "$note_set" ]] && query+="&note=$(urlencode "$note")"
[[ -n "$query" ]] && path+="?${query#&}"
body="$(request "$method" "$path" -H "Content-Type: text/markdown; charset=utf-8" --data-binary "@$src")"

printf "$done_msg" \
  "$(printf '%s' "$body" | field title)" \
  "$(printf '%s' "$body" | sed -n 's/.*"words":\([0-9]*\).*/\1/p')" \
  "$(printf '%s' "$body" | field url)"
saved_note="$(printf '%s' "$body" | field note)"
[[ -z "$saved_note" ]] || printf 'Note: %s\n' "$saved_note"
expires="$(printf '%s' "$body" | field expiresAt)"
if [[ -n "$expires" ]]; then printf 'Deleted on its own after %s (UTC) unless kept.\n' "$expires"
else printf 'Kept until deleted.\n'; fi
