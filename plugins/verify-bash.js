// verify-bash — 6-MODEL CONSENSUS gate for bash commands (Architecture B from HARNESS.md).
//
// MAXIMUM-DETERMINISM MODE: nearly every bash command is sent to a 6-model
// panel. Only zero-argument, zero-side-effect trivia (pwd / whoami / date /
// hostname) skip the LLM. Arguments matter (`ls /etc/`, `cat .env`, etc.) so
// argument-bearing forms always go to the panel.
//
// 6-MODEL PARALLEL CONSENSUS — top OpenAI + Anthropic only, no DeepSeek.
// Cheaper tiers added so the panel is broader (better blind-spot coverage)
// without breaking the cost budget. ICE / Iterative Consensus Ensemble pattern:
// more diverse voices catch more errors.
//
//   OpenAI (via auth.openai-api API key):
//     • gpt-5.5         — flagship
//     • gpt-5.4         — mid
//     • gpt-5.4-mini    — cheap
//
//   Anthropic (via auth.anthropic-personal API key):
//     • claude-opus-4-6    — flagship
//     • claude-sonnet-4-6  — mid
//     • claude-haiku-4-5   — cheap
//
// All six called CONCURRENTLY via Promise.all → total latency ≈ slowest model,
// not 6× single-call latency.
//
// STRICT CONSENSUS DECISION RULE — paranoid by default:
//   • At least 3 models must respond with ALLOW AND zero models say DENY → ALLOW.
//   • ANY model says DENY → DENY (block, cite the dissenters).
//   • Fewer than 3 ALLOW responses → DENY (insufficient consensus).
//   • Unparseable response → counted as DENY.
//   • All 6 abstain (network/auth/rate-limit on every rung) → fall through to
//     opencode's native `ask` permission (user decides).
//
// SAFETY GUARANTEES
//   - Never silently allows a command any panel member said DENY for.
//   - On total panel failure, defers to opencode's existing permission flow —
//     never blocks unexpectedly when classifiers are unreachable.
//   - Coexists with guard-secrets / guard-xcodebuild / git-safety; those run
//     first and may throw before this plugin runs.
//
// CAVEAT #5894
//   tool.execute.* hooks DON'T fire for `task`-spawned subagents — this plugin
//   covers PRIMARY-agent bash only. Pairs with subagents-read-only and
//   xcodebuild-serialized-through-orchestrator policies in HARNESS.md.
//
// TUNING
//   - SAFE_RE — patterns that skip the panel. Keep MINIMAL.
//   - SENTRY — the policy the panel follows. The detailed rulebook is here.
//   - OPENCODE_VERIFY_BASH=off — kill switch.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const AUTH_PATH = path.join(os.homedir(), ".local/share/opencode/auth.json")
const DISABLED = process.env.OPENCODE_VERIFY_BASH === "off"

// MINIMAL safe list — only exact, zero-argument, zero-side-effect commands.
const SAFE_RE = /^\s*(pwd|whoami|hostname|date)\s*$/

const SENTRY = [
  "You are a bash safety classifier for an opencode coding agent working in the",
  "curlbro-app iOS/SwiftUI repo. The user wants MAXIMUM DETERMINISM and SAFETY.",
  "Assume nothing. When in doubt — DENY.",
  "",
  "REPLY FORMAT — EXACTLY one line:",
  "  ALLOW: <one-line reason>",
  "  DENY:  <one-line reason>",
  "",
  "------- HARD DENY (never allowed, no matter the context) -------",
  "",
  "SECRETS / CREDENTIALS:",
  "  • Any reference to `.env` / `.env.*` / `**/.env` at any path.",
  "  • Any reference to `~/.local/share/opencode` (the opencode auth store).",
  "  • Any reference to `~/.ssh`, `~/.aws/credentials`, `~/.config/gh/`, Keychain.",
  "  • Any env-dump: `env`, `printenv`, `set`, `export -p`, `declare -p`, `compgen -v`.",
  "  • Any token/key/credential-named path or variable.",
  "",
  "PRIVILEGE ESCALATION:",
  "  • `sudo`, `doas`, `su`, `pfctl`, anything that asks for elevated privileges.",
  "",
  "SHELL-INJECTION BYPASSES (used to defeat other guards):",
  "  • `bash -c`, `sh -c`, `zsh -c`, `dash -c`, `csh -c`.",
  "  • `eval`, `source <(...)`, `. <(...)` of dynamic content.",
  "  • `base64 -d | sh`, `xxd -r | bash`, any decode-then-execute pipeline.",
  "  • Command substitution that hides intent: `$(echo .env)`, backticks with obfuscation.",
  "  • `perl -e`, `ruby -e`, `awk 'BEGIN{system(...)}'` — inline interpreter execution.",
  "",
  "PIPED REMOTE EXECUTION:",
  "  • `curl ... | sh`, `wget ... | bash`, `curl ... | python`, `curl ... | node`.",
  "",
  "DESTRUCTIVE FILESYSTEM:",
  "  • `rm -rf`, `rm -fr` — DENY unconditionally.",
  "  • `rm -r` outside the repo root — DENY.",
  "  • `rm` with wildcards across the whole repo (`rm *`) — DENY.",
  "  • `find ... -delete`, `find ... -exec rm`, `xargs rm`.",
  "  • `dd`, `shred`, `truncate -s 0`, `mkfs`, `format`, partition tools.",
  "  • `chmod -R` or `chown -R` outside the repo.",
  "",
  "GIT HISTORY DESTRUCTION / HOOK BYPASS:",
  "  • `git push --force`, `git push -f`, `--force-with-lease`.",
  "  • `git filter-branch`, `git filter-repo`.",
  "  • `git reset --hard` (always — recovery requires explicit user direction).",
  "  • `git branch -D`, `git branch --delete --force`.",
  "  • `git worktree remove --force` / `-f`.",
  "  • `git checkout --force` / `-f`.",
  "  • `git restore .` (mass discard).",
  "  • `git submodule deinit --force` / `-f`.",
  "  • Any `--no-verify` flag (bypasses hooks).",
  "",
  "OPENCODE SAFETY BYPASS:",
  "  • `--dangerously-skip-permissions` anywhere.",
  "",
  "SYSTEM MUTATION:",
  "  • `defaults write` (macOS user defaults).",
  "  • `launchctl load`, `launchctl unload`.",
  "  • `brew uninstall` of a system-shared package.",
  "  • Background daemon launching, `nohup`, `disown`.",
  "",
  "EGRESS TO UNTRUSTED HOSTS:",
  "  • `curl`, `wget`, `nc`, `netcat`, `socat`, `ssh`, `scp`, `rsync` to a host that is",
  "    not a recognized dev resource (github.com, api.github.com, raw.githubusercontent.com,",
  "    apple.com / *.apple.com, swift.org, registry.npmjs.org, anthropic.com,",
  "    api.openai.com, api.deepseek.com, opencode.ai).",
  "",
  "DEPENDENCY INSTALLATION (these need user approval, not yours):",
  "  • `brew install`, `npm install`, `npm i`, `pip install`, `gem install`, `cargo install`.",
  "",
  "UNREADABLE / OBFUSCATED COMMANDS:",
  "  • Anything you cannot understand at a glance — DENY.",
  "  • Heredocs that hide content; redirection to unusual paths; multi-stage pipes",
  "    where intent is unclear.",
  "",
  "------- ALLOW (only when CLEARLY fitting this list) -------",
  "",
  "  • Read-only inspection of REPO files (not .env / not secrets): `ls`, `cat`,",
  "    `head`, `tail`, `wc`, `grep`/`rg`/`sed -n` over repo paths.",
  "  • Read-only inspection outside the repo IF the path is the documented",
  "    web-app reference: `~/Documents/GitHub/curlbro/workout-builder/`.",
  "  • Read-only git: `git status`, `git log`, `git diff`, `git show`,",
  "    `git ls-tree`, `git check-ignore`.",
  "  • Git mutations to in-repo state with concrete arguments: `git add <paths>`,",
  "    `git commit -m \"...\"`, `git switch <branch>`, `git checkout <branch>`",
  "    (NOT --force), `git stash`, `git mv`, `git fetch`, `git pull`,",
  "    `git push` (NOT --force).",
  "  • Read-only `gh`: `pr view/list/diff/checks/status`, `issue view/list`,",
  "    `release view/list`, `api` for read-only endpoints.",
  "  • Build/test toolchain: `xcodebuild` (build/test, NOT clean/destroy),",
  "    `xcodegen generate`, `xcrun simctl` (list/boot/install/launch/screenshot",
  "    — NOT `erase all`), `xcrun xcresulttool`, `swiftlint`.",
  "  • Project scripts: `scripts/sim.sh ...`, `scripts/catalog.sh ...`,",
  "    `scripts/qa/run-scenario.sh ...`, `scripts/qa/parallel-scenarios.sh ...`,",
  "    `npm run validate-catalog`, `npm run test-catalog`,",
  "    `node scripts/<path>`, `python3 scripts/<path>` (path must be in scripts/).",
  "  • Simulator control: `open -a Simulator`, `killall Simulator`,",
  "    `pkill Simulator`.",
  "  • Path creation in repo: `mkdir -p <repo-path>`, `touch <repo-path>`.",
  "  • UI testing: `axe ...`.",
  "  • Screenshot viewing: `open .opencode/screenshots/*.png`.",
  "",
  "------- DECISION RULE -------",
  "",
  "If the command is on the ALLOW list AND its arguments are clearly scoped to",
  "the repo (or the web-app reference) AND nothing in HARD DENY matches —",
  "ALLOW. Otherwise — DENY.",
  "",
  "Be CONSERVATIVE. A false-DENY costs the user one re-run. A false-ALLOW can",
  "leak secrets, delete files, or push bad code. Always prefer DENY.",
].join("\n")

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"))
  } catch {
    return null
  }
}

function getApiKey(auth, provider) {
  const e = auth?.[provider]
  if (!e) return null
  return e.key || e.apiKey || e.api_key || null
}

async function callOpenAI(bearer, model, body) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + bearer,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        messages: [
          { role: "system", content: SENTRY },
          { role: "user", content: body },
        ],
      }),
    })
    if (!res.ok) return null
    const j = await res.json()
    return j?.choices?.[0]?.message?.content || null
  } catch {
    return null
  }
}

async function callAnthropic(key, model, body) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: SENTRY,
        messages: [{ role: "user", content: body }],
      }),
    })
    if (!res.ok) return null
    const j = await res.json()
    return j?.content?.[0]?.text || null
  } catch {
    return null
  }
}

// Classify one model's verdict. Returns { name, status: 'allow'|'deny'|'abstain', detail }.
function classify(name, verdict) {
  if (!verdict) return { name, status: "abstain", detail: "no response (network/auth/rate-limit)" }
  const v = verdict.trim().split("\n")[0]
  if (/^ALLOW\b/i.test(v)) return { name, status: "allow", detail: v }
  if (/^DENY\b/i.test(v)) return { name, status: "deny", detail: v }
  // Unparseable response → treated as DENY for safety.
  return { name, status: "deny", detail: "unparseable response: " + v }
}

export default async ({ worktree, directory }) => ({
  "tool.execute.before": async (input, output) => {
    if (DISABLED) return
    const tool = output?.tool ?? input?.tool ?? ""
    if (tool !== "bash") return
    const cmd = String(input?.args?.command ?? output?.args?.command ?? "")
    if (!cmd) return
    if (SAFE_RE.test(cmd)) return // truly trivial — no LLM call

    // One-shot user approval. When the user explicitly approves a previously
    // denied command, the orchestrator (or the user) creates this file. Plugin
    // consumes (deletes) it on the next bash call, logs the approval, and lets
    // that bash through without classifying. The file is gone immediately, so
    // it's TRULY one-shot — the very next bash call goes back to consensus.
    const root = worktree || directory || process.cwd()
    const APPROVAL_FILE = path.join(root, ".opencode/verify-bash-next-approved")
    const APPROVAL_LOG = path.join(root, ".opencode/verify-bash-approvals.log")
    if (fs.existsSync(APPROVAL_FILE)) {
      try {
        fs.unlinkSync(APPROVAL_FILE)
        fs.mkdirSync(path.dirname(APPROVAL_LOG), { recursive: true })
        fs.appendFileSync(
          APPROVAL_LOG,
          JSON.stringify({
            ts: new Date().toISOString(),
            cmd,
            mode: "one-shot-user-approval",
          }) + "\n"
        )
      } catch {
        /* don't block on logging failures */
      }
      return // user-approved this single command — bypass the panel
    }

    const auth = loadAuth()
    if (!auth) return // no creds → fall through to opencode native ask

    const openaiKey = getApiKey(auth, "openai-api")
    const anthroKey = getApiKey(auth, "anthropic-personal")

    const body =
      "Proposed bash command (classify per policy):\n" +
      cmd +
      "\n\nReply EXACTLY one line: ALLOW: <reason> or DENY: <reason>."

    // 6-model panel — all CONCURRENT. Each may resolve to null (abstain).
    const panel = await Promise.all([
      openaiKey ? callOpenAI(openaiKey, "gpt-5.5", body) : Promise.resolve(null),
      openaiKey ? callOpenAI(openaiKey, "gpt-5.4", body) : Promise.resolve(null),
      openaiKey ? callOpenAI(openaiKey, "gpt-5.4-mini", body) : Promise.resolve(null),
      anthroKey ? callAnthropic(anthroKey, "claude-opus-4-6", body) : Promise.resolve(null),
      anthroKey ? callAnthropic(anthroKey, "claude-sonnet-4-6", body) : Promise.resolve(null),
      anthroKey ? callAnthropic(anthroKey, "claude-haiku-4-5", body) : Promise.resolve(null),
    ])

    const votes = [
      classify("gpt-5.5", panel[0]),
      classify("gpt-5.4", panel[1]),
      classify("gpt-5.4-mini", panel[2]),
      classify("opus-4.6", panel[3]),
      classify("sonnet-4.6", panel[4]),
      classify("haiku-4.5", panel[5]),
    ]

    const denies = votes.filter((v) => v.status === "deny")
    const allows = votes.filter((v) => v.status === "allow")
    const abstains = votes.filter((v) => v.status === "abstain")

    // All abstained → no consensus possible → fall through to opencode native ask.
    if (abstains.length === 6) return

    // STRICT CONSENSUS:
    //  - ANY DENY → block (cite all dissenters).
    //  - Need >=3 ALLOW responders to ALLOW. Otherwise DENY for insufficient consensus.
    if (denies.length > 0) {
      const reasons = denies.map((d) => `[${d.name}] ${d.detail}`).join(" | ")
      throw new Error(
        "\n🚫 verify-bash CONSENSUS DENY — HARD STOP. USER APPROVAL REQUIRED.\n\n" +
          "Command: " + cmd + "\n\n" +
          "Dissenters: " + reasons + "\n\n" +
          "DO NOT retry, rephrase, or work around this command without explicit user approval.\n" +
          "If the user approves: run `touch .opencode/verify-bash-next-approved` (one-shot bypass) and retry the EXACT same command.\n" +
          "If the user denies or wants a different approach: follow that direction.\n"
      )
    }

    if (allows.length < 3) {
      const abstainNames = abstains.map((a) => a.name).join(", ")
      throw new Error(
        "\n🚫 verify-bash INSUFFICIENT CONSENSUS — HARD STOP. USER APPROVAL REQUIRED.\n\n" +
          "Command: " + cmd + "\n\n" +
          "Only " + allows.length + " responder(s) said ALLOW; " +
          abstains.length + " abstained (" + abstainNames + "). Need ≥3 ALLOW votes.\n\n" +
          "DO NOT retry the command. Surface this to the user verbatim and wait for direction.\n" +
          "If the user approves: run `touch .opencode/verify-bash-next-approved` and retry.\n"
      )
    }

    // ≥3 ALLOW, 0 DENY → consensus ALLOW.
  },
})
