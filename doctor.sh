#!/usr/bin/env bash
# doctor.sh — sanity-check the harness install on this machine.
# Reports green / red for each check; prints fix hints for reds.

set +e  # don't bail on individual check failures
H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
WARN=0

ok()    { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()   { echo "  ✗ $1" >&2;  FAIL=$((FAIL+1)); }
warn()  { echo "  ⚠ $1" >&2;  WARN=$((WARN+1)); }

echo "=== opencode-harness doctor ==="
echo "harness: $H"
echo

echo "[1/6] harness repo + plugins"
for p in verify-bash-auto-allow.js verify-bash.js guard-config-review.js validation-gate.js block-inline-scripts.js trace-log.js guard-secrets.js; do
  if [[ -f "$H/plugins/$p" ]] && node --check "$H/plugins/$p" 2>/dev/null; then
    ok "plugins/$p (syntax OK)"
  else
    bad "plugins/$p missing or broken — run setup.sh"
  fi
done

echo
echo "[2/6] global symlinks → repo"
for p in verify-bash-auto-allow.js verify-bash.js guard-config-review.js validation-gate.js block-inline-scripts.js trace-log.js guard-secrets.js; do
  target="$(readlink ~/.config/opencode/plugins/$p 2>/dev/null)"
  expected="$H/plugins/$p"
  if [[ "$target" == "$expected" ]]; then
    ok "~/.config/opencode/plugins/$p → $expected"
  else
    bad "~/.config/opencode/plugins/$p not symlinked correctly (got '$target', want '$expected') — run $H/setup.sh"
  fi
done

echo
echo "[3/6] opencode CLI"
if command -v opencode >/dev/null 2>&1; then
  ok "opencode $(opencode --version 2>/dev/null || echo '(version unknown)')"
else
  bad "opencode not on PATH — install via brew/npm and re-run"
fi

echo
echo "[4/6] auth.json + credentials"
AUTH=~/.local/share/opencode/auth.json
if [[ -f "$AUTH" ]] && jq -e . "$AUTH" >/dev/null 2>&1; then
  ok "auth.json exists and parses"
  for prov in anthropic-personal openai-api openai; do
    if jq -e --arg p "$prov" '.[$p]' "$AUTH" >/dev/null 2>&1; then
      ok "  credential present: $prov"
    else
      warn "  credential MISSING: $prov — run 'opencode auth login' → Other → $prov"
    fi
  done
else
  bad "$AUTH missing or unparseable — run 'opencode auth login'"
fi

echo
echo "[5/6] ast-grep + context7 MCPs"
if command -v npx >/dev/null 2>&1; then
  ok "npx available (MCPs launch on demand via npx)"
else
  bad "npx missing — install Node.js"
fi

echo
echo "[6/6] verify-bash live reachability test (anthropic + openai APIs)"
ANT_KEY=$(jq -r '.["anthropic-personal"].key // empty' "$AUTH" 2>/dev/null)
OAI_KEY=$(jq -r '.["openai-api"].key // empty' "$AUTH" 2>/dev/null)
if [[ -n "$ANT_KEY" ]]; then
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "https://api.anthropic.com/v1/messages" \
    -H "x-api-key: $ANT_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
    --data '{"model":"claude-haiku-4-5","max_tokens":4,"messages":[{"role":"user","content":"hi"}]}' --max-time 8)
  [[ "$code" == "200" ]] && ok "anthropic API reachable + key valid (claude-haiku-4-5)" || bad "anthropic API returned HTTP $code — key invalid or rate-limited"
else
  warn "skipping anthropic check (no key)"
fi
if [[ -n "$OAI_KEY" ]]; then
  # Probe a CANDIDATE LIST: not every API key has gpt-5.4-mini enabled per project.
  # Pass if ANY candidate returns 200; report which one. Uses max_completion_tokens
  # for GPT-5.x reasoning-model compatibility (non-reasoning models accept it too).
  OPENAI_PROBE_MODELS=( "gpt-5.5-pro" "gpt-5.5" "gpt-5.4-mini" )
  probe_ok=""
  last_code=""
  for m in "${OPENAI_PROBE_MODELS[@]}"; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "https://api.openai.com/v1/chat/completions" \
      -H "Authorization: Bearer $OAI_KEY" -H "content-type: application/json" \
      --data "{\"model\":\"$m\",\"max_completion_tokens\":4,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" --max-time 8)
    if [[ "$code" == "200" ]]; then probe_ok="$m"; break; fi
    last_code="$code"
  done
  if [[ -n "$probe_ok" ]]; then
    ok "openai-api reachable + key valid (responded on $probe_ok)"
  else
    bad "openai-api returned HTTP $last_code on every candidate (${OPENAI_PROBE_MODELS[*]}) — enable at least one of these models for this project at platform.openai.com/settings/organization/limits"
  fi
else
  warn "skipping openai-api check (no key)"
fi

echo
echo "=== summary ==="
echo "  pass: $PASS   fail: $FAIL   warn: $WARN"
(( FAIL == 0 )) && echo "ready ✓" || { echo "fix the failures above before running opencode"; exit 1; }
