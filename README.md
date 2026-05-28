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
    ├── verify-bash.js           ← 6-model consensus gate on every bash
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

`setup.sh` symlinks all five plugins into `~/.config/opencode/plugins/`.
`doctor.sh` runs a 6-section sanity check and tells you exactly what to fix if anything's off.

### Auth (per machine, not per project)

```bash
opencode auth login
  → Other → anthropic-personal → personal Anthropic API key
  → Other → openai-api         → OpenAI API key (powers verify-bash + premium orchestrator)
  → Anthropic / OpenAI / Deepseek / OpenCode Zen / OpenCode Go → for built-in providers as needed
```

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
| **`verify-bash`** | 6-model parallel consensus on every non-trivial bash command (GPT-5.5/5.4/5.4-mini + Opus 4.6 / Sonnet 4.6 / Haiku 4.5). LRU cache, fetch timeout, classification log, configurable panel + thresholds. |
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

- `verify-bash`: SAFE_RE bypass, 6-model consensus (allow / deny / insufficient / unparseable / all-abstain), LRU cache hit, classification log emission, `OPENCODE_VERIFY_BASH=off` short-circuit.
- `validation-gate`: pattern detection (ast-grep underuse, DENY clustering, fallthrough warnings), gate execution, session summary serialization.

---

## Caveats — read before you ship this anywhere serious

### 1. opencode #5894 — subagent hooks don't fire

`tool.execute.before` / `tool.execute.after` are **NOT triggered** for subagents spawned via the `task` tool. So `verify-bash`, `guard-secrets`, `block-inline-scripts`, and `trace-log` cover the **primary agent only**. The orchestrator prompts in the base config keep builds in the orchestrator's lane and all subagents read-only — if you write new agents, follow that pattern or your guards silently won't fire.

### 2. Claude Code coexistence

If you also use Claude Code (`.claude/`) in the same repo, both runtimes can race on `xcodebuild` / lint hooks / staged-file edits. Use `bin/with-build-lock` from both runtimes for destructive ops, or don't run them concurrently in the same worktree on build-heavy projects.

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
│   └── validation-gate.test.mjs
└── package.json
```

---

## License

MIT. See `LICENSE`.
