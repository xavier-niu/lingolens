#!/usr/bin/env bash
# Install the LingoLens agent skill.
#
#   curl -fsSL https://raw.githubusercontent.com/xavier-niu/lingolens/master/skills/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --dir ~/.codex/skills
#   skills/install.sh                       (from a clone: installs the local copy)
#
# Options:
#   --dir DIR    skills folder to install into (default: ~/.claude/skills, Claude Code's;
#                or set LINGOLENS_SKILLS_DIR)
#   --ref REF    branch or tag to download (default: master)
#   --remote     download even when run from a clone
#
# Puts the skill in DIR/lingolens, replacing an older copy. Needs bash and curl.
# The skill reads LINGOLENS_URL and LINGOLENS_TOKEN; create a token in LingoLens
# under Settings → Agent Access.
set -euo pipefail

REPO="xavier-niu/lingolens"
NAME="lingolens"
# Every file of the skill (a test keeps this list in step with skills/lingolens).
FILES=(SKILL.md scripts/upload.sh)

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

dir="${LINGOLENS_SKILLS_DIR:-$HOME/.claude/skills}"
ref="master"
remote=0
while (($#)); do
  case "$1" in
    --dir) [[ $# -ge 2 ]] || die "--dir needs a folder"; dir="$2"; shift 2 ;;
    --dir=*) dir="${1#--dir=}"; shift ;;
    --ref) [[ $# -ge 2 ]] || die "--ref needs a branch or tag"; ref="$2"; shift 2 ;;
    --ref=*) ref="${1#--ref=}"; shift ;;
    --remote) remote=1; shift ;;
    -h | --help)
      if [[ -f "${BASH_SOURCE[0]:-}" ]]; then sed -n '2,17s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"
      else echo "Usage: see https://github.com/$REPO/blob/master/skills/install.sh"; fi
      exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done
dir="${dir/#\~/$HOME}"

# Run from a clone? Then copy the files next to this script; piped from curl, download them.
src=""
if ((remote == 0)) && [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [[ -f "$here/$NAME/SKILL.md" ]] && src="$here/$NAME"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/$NAME"

for f in "${FILES[@]}"; do
  mkdir -p "$tmp/$NAME/$(dirname "$f")"
  if [[ -n "$src" ]]; then
    cp "$src/$f" "$tmp/$NAME/$f"
  else
    command -v curl >/dev/null || die "curl is required"
    url="https://raw.githubusercontent.com/$REPO/$ref/skills/$NAME/$f"
    curl -fsSL --retry 2 -o "$tmp/$NAME/$f" "$url" || die "could not download $url"
  fi
done
chmod +x "$tmp/$NAME"/scripts/*.sh
grep -q "^name: $NAME\$" "$tmp/$NAME/SKILL.md" || die "the downloaded SKILL.md doesn't look right; nothing installed"

# Swap in the new copy only once every file is here.
mkdir -p "$dir"
rm -rf "${dir:?}/$NAME.new"
mv "$tmp/$NAME" "$dir/$NAME.new"
rm -rf "${dir:?}/$NAME"
mv "$dir/$NAME.new" "$dir/$NAME"

from="$REPO@$ref"
[[ -n "$src" ]] && from="local copy"
printf 'Installed the LingoLens skill in %s/%s (from %s).\n' "$dir" "$NAME" "$from"
if [[ -n "${LINGOLENS_URL:-}" && -n "${LINGOLENS_TOKEN:-}" ]]; then
  "$dir/$NAME/scripts/upload.sh" --check || true
else
  cat <<'EOF'

Next: create a token in LingoLens (Settings → Agent Access) and set the two lines it
shows in your shell profile or your agent's environment:

  export LINGOLENS_URL=https://read.example.com
  export LINGOLENS_TOKEN=llat_...

Then ask your agent, for example: "write me a B1 article about coffee and put it in LingoLens".
EOF
fi
