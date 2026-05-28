# Security review gate — design

**Status:** designed, not yet implemented
**Plugin:** `plugins/guard-config-review.js` (global)
**Companion agent:** `agents/script-curator.md` (global)
**Decision date:** 2026-05-28

---

## Why this exists

Today the only protection on agent-authored config and script changes is
`plugins/block-inline-scripts.js`, which blocks `node -e` / `python -c` inline
forms. The user correctly identified this as a thin wrapper:

> "i dont think thats very secure, in theory it could write whatever it wants
> to the scripts and run it. that doesnt seem like its solving the problem we
> set out to fix. we need independent reviewers of any settings or script
> changes for security flaws."

A determined or prompt-injected agent can write `scripts/util/exfil.mjs` with
arbitrary content and then run it by path — and `block-inline-scripts` happily
allows the path form because that's its design. The argv-based guard never sees
the *contents* of the file.

This document specifies the gate that does: a **content-review consensus** that
fires BEFORE any write commits to a security-sensitive path.

---

## Threat model

What we're defending against:

1. **Self-authored exfil** — agent writes `scripts/util/foo.mjs` that reads
   secrets and POSTs them, then runs it via the allowed file-path form.
2. **Plugin disablement** — agent edits `plugins/verify-bash.js`,
   `guard-secrets.js`, or the global config to weaken denies / drop the panel.
3. **Allow-rule expansion** — agent adds `Bash(*)` or `read: allow` to
   `opencode.json` / `.claude/settings.json`.
4. **Agent injection** — agent drops a new file in `.claude/agents/` or
   `.opencode/agents/` defining an agent with `bash: allow` + a malicious system
   prompt.
5. **Supply-chain smuggling** — agent adds a malicious dep to `package.json`
   or `Package.swift`, OR pins an existing dep to a malicious tag.
6. **Hook bypass** — agent edits `scripts/util/guard-xcodebuild.sh` or
   `scripts/util/block-inline-scripts.sh` to no-op.
7. **Capability escalation via project.yml** — agent adds an entitlement or
   capability that wasn't there before (e.g., keychain-sharing, full disk).

The pattern shared by all seven: **content of the proposed change reveals
intent**. A reviewer that reads the unified diff catches all of them.

What we're NOT defending against (out of scope):

- Code that's already merged to main — covered by `gh pr review` + human review.
- Compromise of opencode itself, the auth store, or the host OS.
- Genuinely novel zero-day social engineering that fools all reviewers in the
  panel simultaneously.

---

## Sensitive-path globs

The gate fires when the proposed `write`/`edit`/`patch` target matches:

| Glob | Why |
|---|---|
| `opencode.json`, `.opencode/opencode.json` | permission rules, agent defs, MCP config |
| `.opencode/plugins/**`, `~/.config/opencode/plugins/**` | hook code runs unsandboxed |
| `.opencode/INSTRUCTIONS.md`, `.opencode/agents/**`, `~/.config/opencode/agents/**` | agent identity + system prompts |
| `.claude/settings.json`, `.claude/settings.local.json` | Claude Code perms + hooks |
| `.claude/agents/**`, `.claude/skills/**`, `.claude/plugins/**`, `.claude/hooks/**` | Claude Code agent + hook surface |
| `~/.claude/settings.json`, `~/.claude/agents/**`, `~/.claude/skills/**` | global Claude Code surface |
| `scripts/**` (excluding `scripts/*.tmp.*`) | durable executable code |
| `package.json`, `package-lock.json`, `Package.swift`, `Package.resolved` | dep declarations |
| `project.yml`, `*.xcconfig` | iOS capabilities + entitlements |
| `.github/workflows/**` | CI gets repo secrets and write access |
| `Fastfile`, `fastlane/**` | release pipeline |
| `*.entitlements` | iOS capability surface |

Everything outside this list bypasses the gate at zero cost — the goal is to
make the safe path the default path.

**Ephemeral escape hatches** (write freely, never reviewed):

- `/tmp/**`, `/private/tmp/**`
- `.scratch/**` (already gitignored)
- `.opencode/runs/**`, `.opencode/logs/**`, `.opencode/screenshots/**`
- `DerivedData/**`, `.build/**`, `node_modules/**`

This separation answers the "is this too much overhead?" question directly:
debug one-shots and exploratory scripts live in `.scratch/` or `/tmp/` and pay
nothing. Only **durable** code (promoted to `scripts/util/`) pays the gate.
That promotion is exactly when content review should happen.

---

## Panel: hybrid 3+2 (cheap pre-filter → frontier decision)

Per user decision, two stages:

**Stage 1 — Cheap pre-filter (always runs):**
- `anthropic-personal/claude-haiku-4-5`
- `deepseek/deepseek-v4-flash`

Both vote ALLOW or FLAG with a one-line reason. If **either** flags or if the
diff exceeds 200 lines of changed code, escalate to Stage 2. Catches obvious
slop (exfil URLs, `chmod 777`, hardcoded keys, `rm -rf`) for $0.001/review.

**Stage 2 — Frontier decision (only if Stage 1 escalates):**
- `anthropic-personal/claude-opus-4-7` (xhigh thinking)
- `openai-api/gpt-5.5-pro` (xhigh)
- `anthropic-personal/claude-sonnet-4-6`

All three vote ALLOW or DENY with reasons. **ANY DENY → block.**
≥2 ALLOW + 0 DENY → permit the write. <2 ALLOW or any model abstains → block
on insufficient consensus.

**Expected cost:**
- Most edits hit only Stage 1 → $0.001
- Escalations (~10–20% of sensitive writes) → ~$0.05 each
- Daily ceiling at typical edit rate: <$1/day
- All gated behind sensitive-path filter, so most writes pay $0

**Cache:** SHA-256(path + unified diff). Identical re-proposal within 24h hits
cache, no re-bill. Cache lives in `.opencode/guard-config-review.cache.json`.

---

## DENY behavior — hard block + pause (no override)

Per user decision, no `/approve` bypass, no push notification.

On DENY:
1. Plugin throws structured error with verdict + each dissenter's reason.
2. Bash/Write tool fails. Primary agent receives the error.
3. Agent reports verbatim to the user — does NOT rephrase, retry, work around,
   or paraphrase the change.
4. User decides: manually apply the edit themselves, refine instructions for
   the agent, or accept the DENY and pick a different approach.
5. Every decision (ALLOW or DENY) logged to `.opencode/logs/guard-config-review.log`.

**Trade-off (surfaced for the user's awareness):** false positives cannot be
unblocked from inside opencode. The recovery path is "edit the file yourself
via your editor of choice." The user explicitly accepted this in exchange for
the security guarantee. If false positives become annoying, we'll revisit
adding a `/approve` style bypass — but the default is paranoid.

---

## Script-curator agent (role-based write scoping)

Sub-question: **"maybe we can have an agent that's only allowed to edit
scripts that get reused. is that too much overhead?"**

**Answer:** No, not too much overhead — it pairs cleanly with the ephemeral
vs durable split above. Concrete design:

`agents/script-curator.md` — a subagent role with these permissions:

```yaml
---
name: script-curator
mode: subagent
model: anthropic-personal/claude-sonnet-4-6
description: >
  Promotes ephemeral scripts (/tmp/, .scratch/) to durable locations
  (scripts/util/). The ONLY agent allowed to edit scripts/util/** and
  scripts/seed-workouts/**. Always re-reviewed by guard-config-review on every
  write because curator writes still hit the sensitive-path glob.
permission:
  edit:
    "*": "deny"
    "scripts/util/**": "allow"
    "scripts/seed-workouts/**": "allow"
    "scripts/*.sh": "allow"
  bash: "deny"  # curator doesn't run scripts, only writes them
  read: "allow"
---
```

Other agents get the opposite rule in the global config: `edit.scripts/**: deny`
(or `ask`). They can write to `/tmp/` and `.scratch/` freely; promoting a
script to durable requires delegating to `script-curator`.

**Net workflow:**

```
build-fast: "I need a script that does X" → writes /tmp/foo.mjs → runs it
  ...iterates...
build-fast: "This is useful, promote it"
  → delegates to script-curator
    → curator reads /tmp/foo.mjs, refactors for reuse
    → writes scripts/util/foo.mjs
      → guard-config-review fires (Stage 1, probably ALLOW)
      → write commits
```

**Overhead:**
- Ephemeral debug scripts: zero. Same as today.
- Promotion to durable: one extra agent hop + ~1s pre-filter latency. Happens
  rarely (genuinely-reused scripts).
- Implementation: ~15 lines of YAML + a permission rule in global config.

---

## Subagents spawning subagents

Sub-question: **"can subagents spawn their own agents?"**

**Answer:** Yes, via the `task` tool, unless explicitly denied. But the
security implication matters:

| Mechanism | Applies to subagents? |
|---|---|
| `permission` engine (allow/deny/ask rules) | **Yes** — including transitively spawned subagents |
| `tool.execute.before` plugin hooks | **No** — opencode bug [#5894](https://github.com/sst/opencode/issues/5894) |
| `event` hooks (`file.edited`, `session.idle`) | Partial — `file.edited` crosses sessions, tool hooks do not |

This is load-bearing for the design:

- `guard-config-review` is a `tool.execute.before` hook → **does NOT fire for
  subagent writes**.
- Mitigation: the permission engine DOES apply to subagents. So we use it to
  block subagent writes to sensitive paths outright via global config:

  ```json
  "agent": {
    "build-go":   { "permission": { "edit": { "scripts/**": "deny", "opencode.json": "deny", ".claude/**": "deny" } } },
    "build-fast": { "permission": { "edit": { "scripts/**": "deny", "opencode.json": "deny", ".claude/**": "deny" } } },
    ...
  }
  ```

- Result: sensitive writes are forced through the primary agent (`orchestrator`
  / `orchestrator-gpt` / etc.), which IS covered by the plugin. Subagents have
  to delegate UP to a parent to write — and the parent's write fires the
  review.

- `script-curator` is the one exception: it's a subagent with explicit allow on
  `scripts/util/**`. Its writes still need review, so we'll also wire it
  through the primary agent's bash tool by having curator emit the proposed
  patch and the primary apply it. Alternative: accept that curator writes
  bypass the content review and rely on its `bash: deny` to limit damage.
  **Open question for implementation:** which path?

---

## Implementation plan (next PRs)

1. **`plugins/guard-config-review.js`** — hybrid 3+2 panel, sensitive-path
   glob, hard block on DENY, SHA-256 cache, JSON-line log. ~300 LoC.
2. **`tests/guard-config-review.test.mjs`** — same shape as `verify-bash.test.mjs`:
   mock fetch, exercise allow/deny/escalate/cache/ephemeral-bypass paths.
3. **`agents/script-curator.md`** — global subagent.
4. **`templates/opencode.base.json`** — add `edit` denies on sensitive paths
   to every builder agent's permission block.
5. **`templates/setup.sh`** — symlink `guard-config-review.js` into
   `~/.config/opencode/plugins/`.
6. **`README.md`** — document the gate, the curator role, and the
   "edit-the-file-yourself" recovery path for false positives.
7. **Bootstrap protection:** add `plugins/guard-config-review.js` itself to
   the sensitive-path list so the gate protects its own source.
8. **`docs/SECURITY-REVIEW-GATE.md`** — this file.

---

## Honest limits

- **Argv- and content-based, not OS-level.** A creatively-encoded malicious
  diff (steganographic comments, obfuscated control flow) could pass review.
  The panel is paranoid but not omniscient.
- **Bootstrapping paradox:** the gate's source code must itself be on the
  protected list, but the FIRST commit of the gate's source code has no gate
  to review it. We rely on `gh pr review` (human review) for the initial
  install and any change to the gate's own files. Future modifications to
  `guard-config-review.js` will pass through the gate (which catches obvious
  tampering) AND human PR review.
- **MCP servers and other plugins** run outside the permission model. Adding a
  new MCP or plugin = a sensitive write to `opencode.json`, so it WILL hit
  the gate. But once installed, the MCP itself is trusted code.
- **Subagent gap (#5894).** Permission engine closes most of it; the
  `script-curator` exception remains a known design choice (see above).
- **Cost ceiling not a guarantee.** A pathological burst of large diffs could
  blow past $1/day. Add a daily-spend kill switch as a follow-up if observed.
- **No defense against compromise of the panel models themselves.** If
  opus-4-7 + gpt-5.5-pro + sonnet-4.6 all coordinate to ALLOW malicious code,
  the gate fails open. This is fanciful but worth naming.

The only stronger defense is OS-level sandboxing, which we deliberately
rejected because it breaks the Xcode/Simulator toolchain. This gate is a
significant practical improvement over `block-inline-scripts`, not a perfect
guarantee.
