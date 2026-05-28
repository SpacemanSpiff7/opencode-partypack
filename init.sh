#!/usr/bin/env bash
# multiagent-harness-opencode — scaffold a project's opencode config + docs.
#
# Plugins are GLOBAL (symlinked from this repo into ~/.config/opencode/plugins/
# by setup.sh) — they apply to every opencode session automatically. This
# script only handles the per-project files: opencode.json, INSTRUCTIONS.md,
# CHEATSHEET.md, HARNESS.md.
#
# Usage:
#   init.sh <target-dir>                       # universal base config only
#   init.sh <target-dir> --lang swift|ruby|ts  # base + language overlay
#   init.sh <target-dir> --update              # refresh templates without overwriting opencode.json
#
# After init:
#   1. cd <target> && opencode auth login  (Other → anthropic-personal, openai-api, …)
#   2. Review opencode.json: model, external_directory allowlist, project bash entries.
#   3. Edit .opencode/INSTRUCTIONS.md: project-specific intent→skill mappings.

set -e
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=""
LANG_OVERLAY=""
UPDATE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang) LANG_OVERLAY="$2"; shift 2 ;;
    --update) UPDATE=1; shift ;;
    --help|-h) sed -n '2,18p' "$0" | sed 's/^# //;s/^#//'; exit 0 ;;
    *)
      if [[ -z "$TARGET" ]]; then TARGET="$1"
      else echo "ERROR: unexpected arg: $1" >&2; exit 1
      fi
      shift ;;
  esac
done

[[ -z "$TARGET" ]] && { echo "ERROR: target dir required. $0 --help" >&2; exit 1; }
TARGET="$(cd "$TARGET" && pwd)"

# Heads-up if setup.sh hasn't been run yet.
if [[ ! -L ~/.config/opencode/plugins/verify-bash.js ]]; then
  echo "WARNING: harness global plugins aren't symlinked yet."
  echo "         Run once:  $HARNESS_DIR/setup.sh"
  echo
fi

mkdir -p "$TARGET/.opencode/logs"

# Always refresh: INSTRUCTIONS, CHEATSHEET, HARNESS templates.
cp "$HARNESS_DIR/templates/INSTRUCTIONS.md" "$TARGET/.opencode/INSTRUCTIONS.md"
[[ -f "$HARNESS_DIR/templates/CHEATSHEET.md" ]] && cp "$HARNESS_DIR/templates/CHEATSHEET.md" "$TARGET/.opencode/CHEATSHEET.md"
[[ -f "$HARNESS_DIR/templates/HARNESS.md" ]] && cp "$HARNESS_DIR/templates/HARNESS.md" "$TARGET/.opencode/HARNESS.md"

# opencode.json — only on first init.
if [[ "$UPDATE" -eq 0 ]]; then
  if [[ -f "$TARGET/opencode.json" ]]; then
    echo "WARNING: $TARGET/opencode.json exists — skipped. Use --update to refresh templates only."
  else
    BASE="$HARNESS_DIR/templates/opencode.base.json"
    if [[ -n "$LANG_OVERLAY" ]]; then
      OVERLAY="$HARNESS_DIR/templates/overlays/${LANG_OVERLAY}.json"
      if [[ ! -f "$OVERLAY" ]]; then
        echo "ERROR: no overlay for --lang $LANG_OVERLAY (looked in $OVERLAY)" >&2
        echo "Available:" >&2; ls -1 "$HARNESS_DIR/templates/overlays/" >&2
        exit 1
      fi
      jq -s '.[0] * .[1]' "$BASE" "$OVERLAY" > "$TARGET/opencode.json"
    else
      cp "$BASE" "$TARGET/opencode.json"
    fi
    jq -e . "$TARGET/opencode.json" >/dev/null
  fi
fi

# .gitignore additions (idempotent).
if [[ -f "$TARGET/.gitignore" ]] && ! grep -q ".opencode/logs/" "$TARGET/.gitignore"; then
  cat >> "$TARGET/.gitignore" <<GITIEOF

# opencode harness runtime
.opencode/logs/
.opencode/verify-bash-next-approved
.opencode/verify-bash-approvals.log
GITIEOF
fi

echo
echo "✓ harness installed in $TARGET"
[[ -n "$LANG_OVERLAY" ]] && echo "  overlay: $LANG_OVERLAY"
echo
echo "Next:"
echo "  1. cd $TARGET && opencode auth login   (Other → anthropic-personal, openai-api, …)"
echo "  2. Review opencode.json: model, external_directory allowlist, project bash entries."
echo "  3. Edit .opencode/INSTRUCTIONS.md: project-specific intent→skill mappings."
