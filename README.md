# opencode-partypack

> A **pack** of LLMs throwing a **party** to classify every bash command before opencode runs it — plus everything else you'd want in a serious opencode setup. Drop-in plugins, agents, slash commands, a per-session self-improvement gate, and an `init.sh` that scaffolds a new project in one command.

The name? Six models vote on whether each bash command is safe. That's the party.

---

## What problem this solves

Vanilla opencode is excellent but ships intentionally bare. To get a setup that:

- Has **multi-tier model routing** (cheap-default, escalate-on-complexity, fall-back-on-rate-limit)
- Catches **destructive bash** before it runs, **including ones a weak model thinks are fine**
- Has **anti-hallucination guardrails** baked into every agent
- Loads **opt-in slash commands** for the 90% workflows (`/plan` `/orchestrate` `/review` `/commit` `/clarify` `/scope-check` `/approve` `/cheatsheet`)
- **Self-improves** by running gates and pattern-detecting on every session end
- Keeps **secrets out of agent reach** (already-global `guard-secrets`)
- **Updates everywhere** when you `git pull` the harness

…you'd otherwise be hand-rolling several hundred lines across `opencode.json`, plugin files, and INSTRUCTIONS.md per project. This repo is that work, packaged.

---

## How it works

Two layers:

```
Global (installed once, via setup.sh symlinks):
  ~/.config/opencode/plugins/
    ├── verify-bash.js           ← hybrid 3+2 cheap-first consensus gate on every bash
    ├── guard-config-review.js   ← multi-model security review on every write to sensitive paths
    ├── validation-gate.js       ← session.idle: run gates + pattern-detect + queue work for next session
    ├── guard-secrets.js         ← block any bash touching .env or the auth store
    ├── block-inline-scripts.js  ← block `node -e` / `python -c` (force file-path form)
    └── trace-log.js             ← .opencode/logs/trace.log per project, per session

Per project (scaffolded once, via init.sh):
  <project>/
    ├── opencode.json            ← agents, commands, providers, permission scaffold
    └── .opencode/
        ├── INSTRUCTIONS.md      ← Grounding rules + Clarification gates + Anti-overengineering
        ├── logs/                ← trace.log, verify-bash.log, session-<id>.summary.json
        ├── verify-bash.config.json   ← (optional) tune the consensus panel per project
        └── NEXT-SESSION.md      ← validation-gate appends self-improvement items here
```

Layer 1 doesn't need per-project setup — symlinks mean updates propagate when you `git pull` this repo. Layer 2 is a copy, so each project can customize without affecting others.

---

## Install

```bash
git clone https://github.com/SpacemanSpiff7/opencode-partypack.git ~/Documents/GitHub/opencode-partypack
~/Documents/GitHub/opencode-partypack/setup.sh
~/Documents/GitHub/opencode-partypack/doctor.sh   # sanity-check the install
```

`setup.sh` symlinks all six plugins into `~/.config/opencode/plugins/`.
`doctor.sh` runs a 6-section sanity check and tells you exactly what to fix if anything's off.

### Auth (per machine, not per project)

```bash
opencode auth login
  → Other → anthropic-personal → personal Anthropic API key
  → Other → openai-api         → OpenAI API key (powers verify-bash + premium orchestrator)
  → Anthropic / OpenAI / Deepseek / OpenCode Zen / OpenCode Go → for built-in providers as needed
```

#### Two OpenAI credentials are NOT interchangeable

`openai` (oauth — sign in with your ChatGPT account) and `openai-api` (paste a raw API key from platform.openai.com) are **separate provider IDs** with separate rate-limit pools, separate quotas, and separate model availability:

| | `openai` (oauth) | `openai-api` (raw key) |
|---|---|---|
| Auth flow | Browser OAuth via `opencode auth login` → OpenAI | Paste key from platform.openai.com |
| Billed to | ChatGPT subscription quota (free for Pro / Plus) | API meter (pay-per-use) |
| Models exposed | Models available to your ChatGPT plan tier | Only models enabled on the **project** the key belongs to |
| Usable in verify-bash panel | **No** — verify-bash needs a raw key for direct HTTP | **Yes** |

Practical implications:

- **verify-bash + the premium-orchestrator agent require `openai-api`**, not oauth. If you only logged in via OAuth, verify-bash will silently abstain on every OpenAI voter.
- **Model availability** on `openai-api` is governed by *Project → Model limits* at [platform.openai.com/settings/organization/limits](https://platform.openai.com/settings/organization/limits). A freshly-issued key often has only a handful of models enabled. If `doctor.sh` reports HTTP 400 on the OpenAI probe, check this page first.
- **For rate-limit isolation** (e.g. ChatGPT Pro keeps cooking when API-key quota is exhausted, or vice versa), wire both credentials and split your orchestrators between them. The shipped `orchestrator-gpt` (oauth) and `orchestrator-gpt-xtra` (API key) already do this.

#### Tuning the verify-bash panel per project

If the default panel (`gpt-5.4` + `gpt-5.4-mini` + `claude-opus-4-6` + `claude-sonnet-4-6` + `claude-haiku-4-5` + `deepseek-v4-pro`) doesn't match what your account exposes, drop a `.opencode/verify-bash.config.json` in your project:

```json
{
  "models": [
    { "provider": "openai-api",         "model": "gpt-5.5" },
    { "provider": "openai-api",         "model": "gpt-5.4-mini" },
    { "provider": "anthropic-personal", "model": "claude-opus-4-6" },
    { "provider": "anthropic-personal", "model": "claude-sonnet-4-6" },
    { "provider": "anthropic-personal", "model": "claude-haiku-4-5" }
  ],
  "minAllow": 3
}
```

Rules of thumb:
- Pick across **generations and providers** for diversity — same-family voters share blind spots.
- Reserve expensive models (`gpt-5.5-pro`, `claude-opus-4-6`) for orchestrators, **not** for verify-bash — the panel runs on every bash command. Cheap fast models (`gpt-5.4-mini`, `claude-haiku-4-5`) are usually plenty.
- `minAllow: 3` of 5–6 voters is a good baseline. Lower it if too many abstentions cause `INSUFFICIENT CONSENSUS` errors; raise it for stricter consensus.

---

## Scaffold a new project

```bash
~/Documents/GitHub/opencode-partypack/init.sh /path/to/new-project --lang swift
```

Available overlays: **`swift`**, **`ruby`**, **`ts`**. Drop `--lang` for the universal base only.

`init.sh` writes (idempotent — re-runs are safe with `--update`):

- `opencode.json` — base config + overlay merged via `jq`
- `.opencode/INSTRUCTIONS.md` — Grounding + Clarification gates + Anti-overengineering
- `.opencode/logs/` (gitignored)
- `.gitignore` additions for the runtime files

Per-project plugins still go in `<project>/.opencode/plugins/` (opencode merges those with the globals).

### Updating everything

```bash
git -C ~/Documents/GitHub/opencode-partypack pull
```

Plugin updates take effect on the next opencode restart in every project — symlinks. For template updates (`opencode.json` base, `INSTRUCTIONS.md`, overlays), re-run `init.sh <project> --update`. `--update` refreshes templates but **never overwrites** the project's `opencode.json` (your customizations stay).

---

## What's in the box

### Plugins (all run on every project automatically)

| Plugin | Purpose |
|---|---|
| **`verify-bash`** | Hybrid 3+2 consensus on every non-trivial bash command: Stage 1 (haiku-4.5 + deepseek-v4-flash, $0.0005, ~700ms) flags anything suspicious; Stage 2 frontier (sonnet-4.6 + gpt-5.4 + deepseek-v4-pro) sees the cheap dissent reasoning and decides. LRU cache, fetch timeout, classification log, configurable panel + thresholds. |
| **`validation-gate`** | On `session.idle`: runs project gates (lint/test/build), pattern-detects across trace.log + verify-bash.log, writes per-session summary, appends actionable findings to `NEXT-SESSION.md` for the next session to pick up. |
| **`guard-secrets`** | Blocks any bash referencing `.env` or `~/.local/share/opencode/` (the auth store). |
| **`block-inline-scripts`** | Rejects `node -e` / `python -c` form — forces script files (reviewable, reusable). |
| **`trace-log`** | One JSON line per primary-agent tool call + every `file.edited` event. Auditable session trail. |

### Agents (in the per-project `opencode.json` base)

| Tier / role | Default model | Notes |
|---|---|---|
| `orchestrator` (primary) | `anthropic-personal/claude-opus-4-6` | Lead for hard tasks. Delegates reading + routes builds. |
| `orchestrator-gpt` (primary, daily) | `openai/gpt-5.4` (Codex oauth, free via ChatGPT Pro) | Daily GPT lead. |
| `orchestrator-gpt-xtra` (primary, premium) | `openai-api/gpt-5.5-pro` xhigh | Reserved for genuinely hardest tasks (API-billed). |
| `build-go` (T1) | `opencode-go/kimi-k2.6` | Cheapest — start here. |
| `build-fast` (T2) | `deepseek/deepseek-v4-pro` | Failover from T1. |
| `build-sonnet` (T3) | `anthropic-personal/claude-sonnet-4-6` | Asks before invoking (paid). |
| `build-gpt` (T4) | `openai/gpt-5.4` xhigh | Asks once per session. |
| `build-opus` (T5) | `anthropic-personal/claude-opus-4-6` | Asks every invocation. |
| `explore` (subagent) | `deepseek/deepseek-v4-flash` | Read-only recon, **mandated** to use ast-grep MCP. |
| `sentry` (subagent) | `openai/gpt-5.4` | Optional discussion-mode bash verifier. |
| `review` (subagent) | `openai/gpt-5.4` | Cross-model review — different family from author. |
| `review-deep` (subagent) | `anthropic-personal/claude-opus-4-6` | High-stakes / reviews GPT-built diffs. |
| `vision` (subagent) | `anthropic-personal/claude-sonnet-4-6` | Screenshot analysis. |

### Commands

`/plan` `/orchestrate` `/quick` `/explore` `/why` `/review` `/review-deep` `/escalate` `/clarify` `/scope-check` `/approve` `/commit` `/cheatsheet`

Language overlays add toolchain-specific commands (e.g. `--lang swift` adds `/build` `/test` `/lint` `/sim-shot`).

### MCPs (auto-installed via opencode)

- **`ast-grep`** — structural code search, way more token-efficient than raw `read` + `grep`. The `explore` agent's prompt MANDATES it.
- **`context7`** — official library docs lookup.

---

## Testing

```bash
cd ~/Documents/GitHub/opencode-partypack
npm install
npm test
```

Vitest covers:

- `verify-bash`: SAFE_RE bypass, 5-model consensus (allow / deny / insufficient / unparseable / all-abstain), LRU cache hit, classification log emission, `OPENCODE_VERIFY_BASH=off` short-circuit.
- `validation-gate`: pattern detection (ast-grep underuse, DENY clustering, fallthrough warnings), gate execution, session summary serialization.

---

## Caveats — read before you ship this anywhere serious

### 1. opencode #5894 — subagent hooks don't fire

`tool.execute.before` / `tool.execute.after` are **NOT triggered** for subagents spawned via the `task` tool. So `verify-bash`, `guard-secrets`, `block-inline-scripts`, and `trace-log` cover the **primary agent only**. The orchestrator prompts in the base config keep builds in the orchestrator's lane and all subagents read-only — if you write new agents, follow that pattern or your guards silently won't fire.

### 2. Concurrent sessions — use one worktree per agent

The failure mode you're protecting against: two agents (Claude Code + opencode, two opencode sessions, opencode + a human editor) holding uncommitted edits to the same file at the same time. Whoever commits or saves last silently wins; the loser's work is gone.

opencode itself has no opinion about this — neither does git. The workflow that eliminates the race is **one git worktree per session**:

```bash
# Open a fresh isolated working tree off main for a new task:
git worktree add ../<repo>-<task-slug> -b feat/<task-slug> main

# Then open the new session in that path:
opencode ../<repo>-<task-slug>
```

Each worktree is a separate checkout backed by the same `.git`. Sessions can't clobber each other's working trees; merges happen through the normal PR flow. `main` is the example start-point — substitute any ref to branch from elsewhere.

If you genuinely need two agents in the same worktree (rare): use `bin/with-build-lock` for destructive build/lint ops, commit before every context switch, and accept that silent-clobber is the cost of admission.

Existing projects pick up the INSTRUCTIONS.md guidance only after `~/Documents/GitHub/opencode-partypack/init.sh <project> --update`.

### 3. verify-bash defaults to ON

The plugin runs by default if `.opencode/verify-bash.config.json` is absent (matches the harness's "max safety" stance). To disable: set `"enabled": false` in that file, OR launch opencode with `OPENCODE_VERIFY_BASH=off`. Full config knobs in `plugins/verify-bash.js` header comment.

### 4. Model IDs drift

The verify-bash default panel hardcodes `gpt-5.5 / gpt-5.4 / gpt-5.4-mini / claude-opus-4-6 / claude-sonnet-4-6 / claude-haiku-4-5`. If/when these are retired or renamed, override the `models` array in `.opencode/verify-bash.config.json` per project. Don't edit plugin source.

---

## Layout

```
opencode-partypack/
├── README.md
├── setup.sh                    # one-time: symlink plugins into ~/.config/opencode/plugins/
├── init.sh                     # per project: scaffold config + docs
├── doctor.sh                   # sanity check on a new machine
├── bin/
│   └── with-build-lock         # stale-aware POSIX lock for cross-runtime build coordination
├── plugins/                    # symlinked into ~/.config/opencode/plugins/
│   ├── verify-bash.js
│   ├── guard-config-review.js
│   ├── validation-gate.js
│   ├── guard-secrets.js
│   ├── block-inline-scripts.js
│   └── trace-log.js
├── templates/
│   ├── opencode.base.json
│   ├── INSTRUCTIONS.md
│   └── overlays/{swift,ruby,ts}.json
├── tests/
│   ├── verify-bash.test.mjs
│   ├── guard-config-review.test.mjs
│   └── validation-gate.test.mjs
└── package.json
```

---

## `guard-config-review` — independent multi-model review of every sensitive write

> A multi-model security panel sits between your agent and any write to a config or script file. If the reviewers don't all green-light the diff, the write never lands.

`block-inline-scripts.js` was a thin wrapper: it blocks `node -e` and `python -c` inline forms, but it's content-blind — an agent can write `scripts/util/exfil.mjs` with arbitrary content and run it by file path, and the inline-block hook happily lets it through. The real defense isn't blocking *how* code runs, it's reviewing *what* gets written.

`guard-config-review.js` is that gate. It fires on every `write` / `edit` / `multiedit` / `patch` to a security-sensitive path, BEFORE the write commits.

### Sensitive paths (default — override per project)

- **opencode surface:** `opencode.json`, `.opencode/{opencode.json, plugins/**, INSTRUCTIONS.md, agents/**, skills/**}`
- **Claude Code surface:** `.claude/{settings*.json, agents/**, skills/**, plugins/**, hooks/**, rules/**, CLAUDE.md}`, plus `CLAUDE.md`
- **scripts:** `scripts/**` (durable executable code; anything you write is reviewed)
- **dep manifests:** `package.json`, `package-lock.json`, `Package.swift`, `Package.resolved`, `Gemfile`, `Podfile`, `requirements.txt`, `pyproject.toml`
- **iOS surface:** `project.yml`, `*.entitlements`, `*.xcconfig`
- **CI / release:** `.github/workflows/**`, `Fastfile`, `fastlane/**`
- **Home equivalents:** `~/.config/opencode/**` and `~/.claude/**`

### Ephemeral escape hatches (always bypass — zero cost)

`/tmp/**`, `.scratch/**`, `.opencode/{runs,logs,screenshots,state}/**`, `DerivedData/**`, `.build/**`, `node_modules/**`, `scripts/seed-workouts/output/**`, `scripts/util/_*.json`.

So debug one-shots, exploratory scripts, and build artifacts pay nothing. The gate fires only on durable, security-relevant writes.

### Hybrid 3+2 panel

**Stage 1 — cheap pre-filter (always runs, ~$0.001):**
- `anthropic-personal/claude-haiku-4-5`
- `deepseek/deepseek-v4-flash`

Each votes `ALLOW` or `FLAG`. Catches obvious slop (exfil URLs, `rm -rf`, hardcoded keys, weakened deny rules) for almost nothing.

**Stage 2 — frontier decision (only if Stage 1 flags, diff > 200 lines, or path is on the always-frontier list):**
- `anthropic-personal/claude-opus-4-7`
- `openai-api/gpt-5.5-pro`
- `anthropic-personal/claude-sonnet-4-6`

Each votes `ALLOW` or `DENY`. **ANY DENY → block.** Need ≥2 ALLOW + 0 DENY + 0 abstain to permit. Anything less → block on insufficient consensus.

**Always-frontier paths** (Stage 1 is skipped — paranoid review every time):
- `.opencode/plugins/**`, `.claude/plugins/**`, `.claude/hooks/**`
- `.opencode/agents/**`, `.claude/agents/**`
- The gate's own source (`plugins/guard-config-review.js`) — bootstrap protection.

### On DENY — hard block, present risk, one-shot user override, persistent audit

Every DENY is recorded to `.opencode/security-violations.log` (JSON line per violation, persistent across sessions). The line includes the full path, kind, dissenter reasons, both stage panels' votes with detail, and the SHA-256 diff hash. You build up a project history of every block — useful for "don't make this mistake again" review and for noticing patterns ("the agent keeps trying to weaken the sudo deny — investigate why").

The plugin throws with a structured error containing:
- the proposed path and kind
- each dissenter's verbatim verdict and reason
- a note that the violation has been recorded
- explicit USER OPTIONS (accept the deny, or override with `/approve-config`)
- explicit AGENT INSTRUCTIONS (do NOT retry, paraphrase, or work around — surface verbatim and wait)

If you decide the change IS safe — you've read the diff yourself or you know why the reviewers' concern is a false positive — run:

```
/approve-config "I reviewed the diff. This is a deploy script that needs network egress to the GitHub release API."
```

That command writes your rationale into `.opencode/guard-config-review-next-approved`. On the very next sensitive write, the plugin consumes the file, appends an entry to `.opencode/guard-config-review-approvals.log` with your rationale + the original dissenter reasons, and lets that one write through. The bypass is **one-shot** — every sensitive write after that goes back to full panel review.

**Two logs, two purposes:**

| File | Contents | Persistence |
|---|---|---|
| `.opencode/security-violations.log` | Every DENY. Original reviewer reasons, both stage votes, diff hash. | Forever. Survives override — the override gets its own log entry on top; this one stays as the canonical "this was flagged once". |
| `.opencode/guard-config-review-approvals.log` | Every override. Your rationale, the path, timestamp. | Forever. Auditable trail of when you chose to proceed despite the gate. |

Both files are added to `.gitignore` by `init.sh`. Optional: commit `security-violations.log` to your project history so the agent can read it in future sessions and learn from past denies. The harness intentionally does NOT auto-inject the violations log into the orchestrator's system prompt — you choose whether the past influences the future.

---
### Cost ceiling

- Most edits skip the gate entirely (not on a sensitive path) → $0
- Edits to a sensitive path that pass Stage 1 unanimously and stay small → ~$0.001
- Escalations to Stage 2 → ~$0.05 each (frontier reasoning)

Typical day: <$1 even with active config/script work. The SHA-256 cache (24h TTL on `.opencode/logs/guard-config-review.cache.json`) means identical re-proposals don't re-bill.

### Subagent gap (opencode #5894)

`tool.execute.*` plugin hooks **don't fire** for `task`-spawned subagent tool calls. That includes this gate. So a subagent that has `edit` permission on sensitive paths bypasses the review.

The mitigation is permission topology, not the plugin: deny `edit` on sensitive paths in every non-orchestrator agent's permission block. Subagents physically can't write the protected surface; only the primary orchestrator (covered by the plugin) can. Default templates ship this stance — see `templates/opencode.base.json`.

### Configuration

Per-project overrides go in `.opencode/guard-config-review.config.json`:

```json
{
  "enabled": true,
  "stage1Models": [...],
  "stage2Models": [...],
  "sensitivePatterns": ["extra/path/**"],
  "ephemeralPatterns": ["custom/scratch/**"],
  "alwaysFrontierPatterns": ["my/critical/**"],
  "timeoutMs": 20000,
  "escalateLineCount": 200,
  "cache": true
}
```

Project-supplied patterns are merged ON TOP of the defaults — they extend, never replace. To wholly replace, set `enabled: false` and roll your own.

### Kill switches

```
OPENCODE_GUARD_CONFIG_REVIEW=off          # disable for this opencode invocation
OPENCODE_GUARD_CONFIG_REVIEW_NOCACHE=1    # disable cache (every diff re-reviewed)
OPENCODE_GUARD_CONFIG_REVIEW_TIMEOUT=ms   # override per-call deadline
```

### Logs

Every decision lands in `.opencode/logs/guard-config-review.log` as one JSON line per write:

```json
{"ts":"2026-05-28T19:14:22Z","verdict":"ALLOW","reason":"stage1-pass","path":"/repo/scripts/util/foo.mjs","kind":"write","stage1Allows":2,"stage1Flags":0,"stage1Abstains":0,"latencyMs":1142,"lineCount":18}
{"ts":"2026-05-28T19:16:08Z","verdict":"DENY","reason":"stage2-deny","path":"/repo/opencode.json","kind":"write","stage1":[...],"stage2":[...],"dissenters":["[anthropic-personal/claude-opus-4-7] DENY: removes the sudo deny rule"],"latencyMs":4830,"lineCount":42}
```

Auditable trail of every reviewer decision, every cache hit, every ephemeral bypass.

### Script whitelist — review effort amortizes

When `guard-config-review` ALLOWs a `write` to an executable script path (`.mjs`, `.cjs`, `.js`, `.ts`, `.tsx`, `.py`, `.sh`, `.bash`, `.zsh`, `.fish`, `.rb`, `.pl`), it appends an entry to `.opencode/guard-config-review.whitelist.json`:

```json
{
  "/repo/scripts/util/foo.mjs": {
    "sha256": "abc123...",
    "approvedAt": "2026-05-28T19:14:22Z",
    "diffSha": "def456...",
    "stage": "stage1-pass"
  }
}
```

`verify-bash` consults this whitelist before classifying any bash command. If the command invokes a path that's whitelisted **AND** the script's current sha256 matches the approved sha256, the panel is skipped entirely — `ALLOW` with reason `whitelisted-script`. This means **one review approves the script forever** (or until you modify it).

If the script is modified post-approval, the hash mismatches, `verify-bash` logs `whitelist-stale` for that command, and falls through to the normal consensus panel. So edits don't silently exfiltrate trust — they require a fresh review (which the `write` tool delivers automatically via `guard-config-review`).

Command patterns recognized as script invocations:

```bash
node scripts/util/foo.mjs          # interpreter + path
python3 scripts/util/foo.py
bash scripts/util/deploy.sh
npx tsx scripts/util/bar.ts
./scripts/util/run.mjs             # bare invocation with leading ./
scripts/util/foo.mjs               # bare relative path
```

The whitelist file is protected three ways: opencode permission rules deny writes to it, the verify-bash sentry treats bash mutations of it as HARD DENY, and the gate's own write-path is a direct fs call that bypasses all tool layers (so the plugin can legitimately update it).

### Workflow: ephemeral → durable → reused

The split lines up naturally with how scripts actually evolve:

1. **Ephemeral exploration** — agent writes `/tmp/probe.mjs`, iterates, runs. Zero review cost.
2. **Promotion to durable** — agent decides the script is reusable, calls `Write { file_path: "scripts/util/probe.mjs", content: ... }`. `guard-config-review` reviews the content, ALLOWs, emits whitelist entry.
3. **Reuse** — subsequent `node scripts/util/probe.mjs` invocations skip the verify-bash panel via the whitelist. No re-billing, no latency, no re-review.
4. **Modification** — agent edits the script. The edit is itself a sensitive write, so `guard-config-review` re-reviews the new content. If approved, the whitelist entry is replaced with the new sha256. Old hash is gone.

You pay for review when content changes, not when scripts run.

---

### Honest limits

- **Argv- and content-based, not OS-level.** A creatively-encoded malicious diff (steganographic comments, obfuscated control flow) could pass review. The panel is paranoid but not omniscient.
- **Bootstrapping paradox.** The gate's source must itself be on the protected list, but the first commit of the gate's source has no gate to review it. Human PR review (`gh pr review`) backstops the initial install and any future change to the gate's own files.
- **Subagent gap.** Permission engine closes most of it; the plugin doesn't cover what it can't see. Design docs at `docs/SECURITY-REVIEW-GATE.md`.
- **False positives unrecoverable inside opencode.** Deliberate trade-off. Recovery is manual file edit.
- **Cost ceiling not a guarantee.** A pathological burst of huge diffs could blow past $1/day. Daily-spend kill switch is a future enhancement.

The only stronger defense is OS-level sandboxing, which breaks the Xcode/Simulator toolchain in our setup so it's not on the table. This gate is a significant practical improvement over `block-inline-scripts`, not a perfect guarantee.

---

## License

MIT. See `LICENSE`.
