#!/usr/bin/env bash
# setup.sh — install global plugin symlinks so opencode picks up harness plugins
# from this repo. Idempotent — safe to re-run (e.g. after `git pull` or on a new machine).

set -e
H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL=~/.config/opencode/plugins
mkdir -p "$GLOBAL"

for p in verify-bash-auto-allow.js verify-bash.js guard-config-review.js validation-gate.js block-inline-scripts.js trace-log.js guard-secrets.js; do
  if [[ -e "$GLOBAL/$p" && ! -L "$GLOBAL/$p" ]]; then
    mv "$GLOBAL/$p" "$GLOBAL/$p.bak.$(date +%s)"
    echo "  backed up existing non-symlink: $GLOBAL/$p"
  fi
  ln -sfn "$H/plugins/$p" "$GLOBAL/$p"
done

echo "✓ harness plugins symlinked into $GLOBAL"
ls -la "$GLOBAL" | grep -E '\.js'
echo
echo "Next:"
echo "  • For NEW projects:       $H/init.sh /path/to/project [--lang swift|ruby|ts]"
echo "  • Refresh template files: $H/init.sh /path/to/project --update"
echo "  • Pull harness updates:   git -C $H pull"
