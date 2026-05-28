// verify-bash — HYBRID 3+2 consensus gate for bash commands.
//
// v3 — staged cheap-first review with frontier escalation. Less false-positive
// friction than v2's flat 5-model panel; cheaper on the common case; better
// signal because the frontier sees WHY cheap models flagged a command.
//
// CONFIG (per project, optional): `.opencode/verify-bash.config.json`
//   {
//     "enabled": true,                       // false = no-op
//     "stage1Models": [ ... ],               // override Stage 1 panel
//     "stage2Models": [ ... ],               // override Stage 2 panel
//     "timeoutMs": 12000,                    // per-call fetch deadline
//     "cacheMax": 256,                       // LRU size; 0 = no cache
//     "safePatterns": ["^make help$", ...],  // extra regex patterns to skip
//     "sentryPrompt": "...optional override...",
//   }
//
// HYBRID 3+2 CONSENSUS:
//   Stage 1 (cheap, always): haiku-4-5 + deepseek-v4-flash. Vote ALLOW or FLAG.
//     • Unanimous ALLOW → permit. No Stage 2 call. ~$0.0005, ~700ms.
//     • Any FLAG (or any abstain) → escalate to Stage 2.
//   Stage 2 (frontier, only on escalation): sonnet-4-6 + gpt-5.4 + deepseek-v4-pro.
//     Each frontier model sees the Stage 1 dissent reasons in its prompt so it
//     can refute false positives. Vote ALLOW or DENY.
//     • ANY DENY → block (cite all dissenters).
//     • ≥2 ALLOW + 0 DENY + 0 abstain → permit.
//     • Anything else → block (insufficient consensus).
//   All-abstain at any stage → fallthrough to opencode native ask.
//
// ALWAYS_SAFE_RE mirrors opencode's read-only auto-allow set — those commands
// never hit the gate. The reviewers were rubber-stamping them at $0.001/call
// anyway, and single-model false positives on obvious idioms (e.g.
// `jq empty <file>`) caused unnecessary HARDSTOPs.
//
// LRU CACHE (in-memory, session-scoped, ALLOWs only). DENYs never cached.
//
// LOG: every decision appended to `.opencode/logs/verify-bash.log` as one JSON
// line. Auditable trail.
//
// FETCH TIMEOUT: each model has its own AbortSignal. A hung provider can't
// block the panel — it just abstains.
//
// ENV TUNING:
//   • OPENCODE_VERIFY_BASH=off       — kill switch (overrides config.enabled).
//   • OPENCODE_VERIFY_BASH_NOCACHE=1 — disable cache regardless of config.
//   • OPENCODE_VERIFY_BASH_TIMEOUT=ms — override timeout regardless of config.
//
// CAVEAT (opencode #5894): tool.execute.* hooks DON'T fire for task-spawned
// subagents. This plugin covers PRIMARY-agent bash only.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

const AUTH_PATH = path.join(os.homedir(), ".local/share/opencode/auth.json")
const NOCACHE_ENV = process.env.OPENCODE_VERIFY_BASH_NOCACHE === "1"
const TIMEOUT_ENV = Number(process.env.OPENCODE_VERIFY_BASH_TIMEOUT || 0) || null

// Mirrors opencode's read-only auto-allow set. Commands matching this pattern
// NEVER hit the consensus panel.
const ALWAYS_SAFE_RE = new RegExp(
  "^\\s*(" +
    // zero-arg trivia
    "pwd|whoami|hostname|date|uname|true|false|uptime|" +
    // tooling location
    "(which|command -v|type)\\s+[\\w/.-]+|" +
    // path inspection
    "ls(\\s+-[a-zA-Z0-9]+)*(\\s+[\\w./@~*-]+)*|" +
    "stat(\\s+-[a-zA-Z0-9]+)*\\s+\\S+|" +
    "file\\s+\\S+|" +
    "wc(\\s+-[a-zA-Z0-9]+)*\\s+\\S+|" +
    "du(\\s+-[a-zA-Z0-9]+)*(\\s+\\S+)?|" +
    "df(\\s+-[a-zA-Z0-9]+)*|" +
    "tree(\\s+\\S+)*|" +
    // process/system inspection
    "ps(\\s+-[a-zA-Z]+)*|" +
    "pgrep\\s+\\S+|" +
    "lsof(\\s+-[a-zA-Z]+)*(\\s+\\S+)?|" +
    // content reading (no redirects/pipes that mutate)
    "(cat|head|tail|nl)(\\s+-[a-zA-Z0-9]+)*\\s+[^|>&;]+|" +
    "(grep|rg|egrep|fgrep)(\\s+-[a-zA-Z]+)*\\s+[^|>&;]+|" +
    "sed\\s+-n\\s+[^|>&;]+|" +
    // jq read-only forms — jq empty <file>, jq . <file>, jq '<filter>' <file>
    // (no -i / --in-place — those are mutations)
    "jq(\\s+-[a-zA-Z]+)*\\s+\\S+(\\s+[^|>&;]+)?|" +
    // git read-only verbs
    "git\\s+(status|log|show|diff|blame|reflog|ls-files|ls-tree|rev-parse|" +
      "config\\s+--get|describe|tag|branch(\\s+-l)?|remote(\\s+-v)?|" +
      "check-ignore|cat-file|fsck|count-objects)(\\s+[^|>&;]+)?|" +
    // gh read-only
    "gh\\s+(pr\\s+(view|list|diff|checks|status)|issue\\s+(view|list|status)|" +
      "release\\s+(view|list)|workflow\\s+(view|list)|repo\\s+view|" +
      "auth\\s+status)(\\s+[^|>&;]+)?" +
  ")\\s*$",
)

// Stage 1 — cheap pre-filter. Fast, $0.0005-ish. Catches obvious slop.
const STAGE1_DEFAULT = [
  { provider: "anthropic-personal", model: "claude-haiku-4-5" },
  { provider: "deepseek", model: "deepseek-v4-flash" },
]

// Stage 2 — frontier, only fires on Stage 1 FLAG. Sees the cheap dissent
// reasons in its prompt so it can refute false positives.
const STAGE2_DEFAULT = [
  { provider: "anthropic-personal", model: "claude-sonnet-4-6" },
  { provider: "openai-api", model: "gpt-5.4" },
  { provider: "deepseek", model: "deepseek-v4-pro" },
]

const DEFAULT_SENTRY = [
  "You are a bash safety classifier for an opencode coding agent. The user wants",
  "MAXIMUM DETERMINISM and SAFETY. Assume nothing. When in doubt — DENY.",
  "",
  "REPLY FORMAT — EXACTLY one line:",
  "  ALLOW: <one-line reason>",
  "  DENY:  <one-line reason>",
  "",
  "(In Stage 1, FLAG: <reason> is also valid and triggers Stage 2 review.)",
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
  "SHELL-INJECTION BYPASSES:",
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
  "  • Background daemon launching: `nohup`, `disown`.",
  "",
  "EGRESS TO UNTRUSTED HOSTS:",
  "  • `curl`, `wget`, `nc`, `netcat`, `socat`, `ssh`, `scp`, `rsync` to a host not",
  "    a recognized dev resource (github.com, api.github.com, raw.githubusercontent.com,",
  "    apple.com / *.apple.com, swift.org, registry.npmjs.org, anthropic.com,",
  "    api.openai.com, api.deepseek.com, opencode.ai).",
  "",
  "DEPENDENCY INSTALLATION (need user approval, not yours):",
  "  • `brew install`, `npm install`, `npm i`, `pip install`, `gem install`, `cargo install`.",
  "",
  "GUARD INTEGRITY:",
  "  • Any mutation of `.opencode/guard-config-review.whitelist.json` is HARD DENY",
  "    (only the gate plugin's direct fs API may modify it).",
  "",
  "UNREADABLE / OBFUSCATED COMMANDS:",
  "  • Anything you cannot understand at a glance — DENY.",
  "",
  "------- ALLOW (only when CLEARLY fitting) -------",
  "  • Read-only repo inspection: `ls`, `cat`, `head`, `tail`, `wc`, `grep`/`rg`/`sed -n` over repo paths.",
  "  • Read-only git: status / log / diff / show / ls-tree / check-ignore / blame / reflog.",
  "  • Git mutations with concrete arguments: add / commit -m / switch / checkout <branch> (NOT --force) /",
  "    stash / mv / fetch / pull / push (NOT --force).",
  "  • Read-only gh: pr/issue/release view/list/diff/checks/status; gh api read-only endpoints.",
  "  • Build/test toolchain (whatever the project uses) with project-shape arguments.",
  "  • In-repo path creation: `mkdir -p <repo-path>`, `touch <repo-path>`.",
  "  • Read-only JSON validation: `jq empty <file>`, `jq . <file>`, `jq '<filter>' <file>` —",
  "    standard developer idioms, no side effects.",
  "  • Script execution from approved paths (the verify-bash whitelist covers content review).",
  "",
  "------- DECISION RULE -------",
  "If on the ALLOW list AND arguments clearly scoped to the repo AND nothing in",
  "HARD DENY matches — ALLOW. Otherwise — DENY (Stage 2) / FLAG (Stage 1).",
  "",
  "Stage 1: bias toward ALLOW for clear read-only idioms — escalate (FLAG) only on real",
  "concerns. Stage 2 will see your reasoning and adjudicate; you are not the final word.",
  "",
  "Stage 2: you ARE the final word. Read the Stage 1 dissent carefully and decide whether",
  "they were correct. False positives are recoverable (the user can /approve and retry);",
  "false ALLOWs can leak secrets, delete files, or push bad code. When in genuine doubt — DENY.",
].join("\n")

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"))
  } catch {
    return null
  }
}

function loadConfig(root) {
  const p = path.join(root, ".opencode/verify-bash.config.json")
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return {}
  }
}

function getApiKey(auth, provider) {
  const e = auth?.[provider]
  if (!e) return null
  return e.key || e.apiKey || e.api_key || null
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function callOpenAI(bearer, model, sentry, body, timeoutMs) {
  try {
    const res = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + bearer, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 200,
          messages: [
            { role: "system", content: sentry },
            { role: "user", content: body },
          ],
        }),
      },
      timeoutMs,
    )
    if (!res.ok) return null
    const j = await res.json()
    return j?.choices?.[0]?.message?.content || null
  } catch {
    return null
  }
}

async function callAnthropic(key, model, sentry, body, timeoutMs) {
  try {
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 200,
          system: sentry,
          messages: [{ role: "user", content: body }],
        }),
      },
      timeoutMs,
    )
    if (!res.ok) return null
    const j = await res.json()
    return j?.content?.[0]?.text || null
  } catch {
    return null
  }
}

async function callDeepSeek(key, model, sentry, body, timeoutMs) {
  try {
    const res = await fetchWithTimeout(
      "https://api.deepseek.com/v1/chat/completions",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 200,
          messages: [
            { role: "system", content: sentry },
            { role: "user", content: body },
          ],
        }),
      },
      timeoutMs,
    )
    if (!res.ok) return null
    const j = await res.json()
    return j?.choices?.[0]?.message?.content || null
  } catch {
    return null
  }
}

function callModel(spec, auth, sentry, body, timeoutMs) {
  if (spec.provider === "openai-api") {
    const key = getApiKey(auth, "openai-api")
    if (!key) return Promise.resolve(null)
    return callOpenAI(key, spec.model, sentry, body, timeoutMs)
  }
  if (spec.provider === "anthropic-personal") {
    const key = getApiKey(auth, "anthropic-personal")
    if (!key) return Promise.resolve(null)
    return callAnthropic(key, spec.model, sentry, body, timeoutMs)
  }
  if (spec.provider === "deepseek") {
    const key = getApiKey(auth, "deepseek")
    if (!key) return Promise.resolve(null)
    return callDeepSeek(key, spec.model, sentry, body, timeoutMs)
  }
  return Promise.resolve(null)
}

// Cross-plugin contract: guard-config-review writes
// .opencode/guard-config-review.whitelist.json with { absPath: { sha256, ... } } when
// it approves a write to an executable script. We check that here: if the proposed
// bash command invokes a whitelisted script AND the script's current content hash
// still matches the approved hash, ALLOW immediately. If the hash differs (script was
// modified post-approval), log "whitelist-stale" and fall through to the panel.
const SCRIPT_INVOKE_RES = [
  /^\s*(?:node|nodejs|npx|tsx|deno|bun|python3?|python|ruby|rb|bash|sh|zsh|perl)\s+(\S+)/,
  /^\s*(?:\.\/)?((?:scripts|bin)\/[^\s;|&]+\.(?:mjs|cjs|js|ts|tsx|py|sh|bash|zsh|rb|pl))(?:\s|$)/,
]

function checkWhitelistedScript(root, cmd) {
  const wlPath = path.join(root, ".opencode/guard-config-review.whitelist.json")
  let map
  try {
    map = JSON.parse(fs.readFileSync(wlPath, "utf8"))
  } catch {
    return { allowed: false }
  }
  const candidates = new Set()
  for (const re of SCRIPT_INVOKE_RES) {
    const m = cmd.match(re)
    if (m && m[1]) candidates.add(m[1])
  }
  for (const cand of candidates) {
    const abs = path.isAbsolute(cand) ? cand : path.join(root, cand)
    const entry = map[abs]
    if (!entry) continue
    let actualSha
    try {
      const content = fs.readFileSync(abs, "utf8")
      actualSha = crypto.createHash("sha256").update(content).digest("hex")
    } catch {
      continue // script gone — can't verify
    }
    if (actualSha === entry.sha256) {
      return {
        allowed: true,
        reason: "whitelisted-script",
        scriptPath: abs,
        approvedAt: entry.approvedAt,
      }
    }
    return { allowed: false, stale: true, scriptPath: abs }
  }
  return { allowed: false }
}

function classifyStage1(name, verdict) {
  if (!verdict)
    return { name, status: "abstain", detail: "no response (network/auth/rate-limit/timeout)" }
  const v = verdict.trim().split("\n")[0]
  if (/^ALLOW\b/i.test(v)) return { name, status: "allow", detail: v }
  if (/^FLAG\b/i.test(v)) return { name, status: "flag", detail: v }
  if (/^DENY\b/i.test(v)) return { name, status: "flag", detail: v } // DENY → FLAG escalate
  return { name, status: "flag", detail: "unparseable response, escalating: " + v }
}

function classifyStage2(name, verdict) {
  if (!verdict)
    return { name, status: "abstain", detail: "no response (network/auth/rate-limit/timeout)" }
  const v = verdict.trim().split("\n")[0]
  if (/^ALLOW\b/i.test(v)) return { name, status: "allow", detail: v }
  if (/^DENY\b/i.test(v)) return { name, status: "deny", detail: v }
  return { name, status: "deny", detail: "unparseable response: " + v }
}

function makeLRU(max) {
  if (!max || max <= 0) return null
  const m = new Map()
  return {
    get(k) {
      if (!m.has(k)) return undefined
      const v = m.get(k)
      m.delete(k)
      m.set(k, v)
      return v
    },
    set(k, v) {
      if (m.has(k)) m.delete(k)
      m.set(k, v)
      if (m.size > max) m.delete(m.keys().next().value)
    },
    has(k) {
      return m.has(k)
    },
  }
}

export default async ({ worktree, directory }) => {
  const root = worktree || directory || process.cwd()
  const config = loadConfig(root)
  const enabled = config.enabled !== false
  const stage1Models =
    Array.isArray(config.stage1Models) && config.stage1Models.length > 0
      ? config.stage1Models
      : STAGE1_DEFAULT
  const stage2Models =
    Array.isArray(config.stage2Models) && config.stage2Models.length > 0
      ? config.stage2Models
      : STAGE2_DEFAULT
  const timeoutMs = TIMEOUT_ENV || Number(config.timeoutMs) || 12000
  const cacheMax = NOCACHE_ENV ? 0 : Number.isInteger(config.cacheMax) ? config.cacheMax : 256
  const sentry = typeof config.sentryPrompt === "string" ? config.sentryPrompt : DEFAULT_SENTRY
  const extraSafe = (Array.isArray(config.safePatterns) ? config.safePatterns : [])
    .map((p) => {
      try {
        return new RegExp(p)
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const LOG_PATH = path.join(root, ".opencode/logs/verify-bash.log")
  const APPROVAL_FILE = path.join(root, ".opencode/verify-bash-next-approved")
  const APPROVAL_LOG = path.join(root, ".opencode/verify-bash-approvals.log")
  const cache = makeLRU(cacheMax)

  function logDecision(entry) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
      fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n")
    } catch {
      /* never block on logging */
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!enabled || process.env.OPENCODE_VERIFY_BASH === "off") return
      const tool = output?.tool ?? input?.tool ?? ""
      if (tool !== "bash") return
      const cmd = String(input?.args?.command ?? output?.args?.command ?? "")
      if (!cmd) return

      if (ALWAYS_SAFE_RE.test(cmd) || extraSafe.some((re) => re.test(cmd))) {
        logDecision({ verdict: "ALLOW", reason: "safe-pattern", cmd: cmd.slice(0, 200) })
        return
      }

      // Cross-plugin whitelist consultation (set by guard-config-review on approved writes).
      const wl = checkWhitelistedScript(root, cmd)
      if (wl.allowed) {
        logDecision({
          verdict: "ALLOW",
          reason: "whitelisted-script",
          cmd: cmd.slice(0, 200),
          scriptPath: wl.scriptPath,
          approvedAt: wl.approvedAt,
        })
        return
      }
      if (wl.stale) {
        logDecision({
          verdict: "INFO",
          reason: "whitelist-stale",
          cmd: cmd.slice(0, 200),
          scriptPath: wl.scriptPath,
        })
        // fall through to full panel
      }

      if (fs.existsSync(APPROVAL_FILE)) {
        try {
          fs.unlinkSync(APPROVAL_FILE)
          fs.mkdirSync(path.dirname(APPROVAL_LOG), { recursive: true })
          fs.appendFileSync(
            APPROVAL_LOG,
            JSON.stringify({ ts: new Date().toISOString(), cmd, mode: "one-shot-user-approval" }) + "\n",
          )
        } catch {
          /* don't block on logging */
        }
        logDecision({ verdict: "ALLOW", reason: "one-shot-user-approval", cmd: cmd.slice(0, 200) })
        return
      }

      if (cache && cache.has(cmd)) {
        logDecision({ verdict: "ALLOW", reason: "cache-hit", cmd: cmd.slice(0, 200) })
        return
      }

      const auth = loadAuth()
      if (!auth) {
        logDecision({ verdict: "FALLTHROUGH", reason: "no-auth.json", cmd: cmd.slice(0, 200) })
        return
      }

      const t0 = Date.now()

      // -------- Stage 1 — cheap pre-filter --------
      const stage1Body =
        "Pre-filter bash safety review (Stage 1 of 2). Reply ALLOW or FLAG.\n\n" +
        "Proposed command:\n" + cmd

      const stage1Raw = await Promise.all(
        stage1Models.map((m) => callModel(m, auth, sentry, stage1Body, timeoutMs)),
      )
      const stage1Votes = stage1Models.map((m, i) =>
        classifyStage1(`${m.provider}/${m.model}`, stage1Raw[i]),
      )
      const stage1Allows = stage1Votes.filter((v) => v.status === "allow").length
      const stage1Flags = stage1Votes.filter((v) => v.status === "flag")
      const stage1Abstains = stage1Votes.filter((v) => v.status === "abstain").length

      // All cheap models couldn't respond → native ask (don't risk a false
      // negative on insufficient panel coverage).
      if (stage1Abstains === stage1Models.length) {
        logDecision({
          verdict: "FALLTHROUGH",
          reason: "all-abstained-stage1",
          latencyMs: Date.now() - t0,
          cmd: cmd.slice(0, 200),
          stage1: stage1Votes,
        })
        return
      }

      // No flags → cheap-stage unanimous ALLOW. Permit without escalation.
      if (stage1Flags.length === 0) {
        if (cache) cache.set(cmd, true)
        logDecision({
          verdict: "ALLOW",
          reason: "stage1-pass",
          latencyMs: Date.now() - t0,
          cmd: cmd.slice(0, 200),
          stage1Allows,
          stage1Abstains,
        })
        return
      }

      // -------- Stage 2 — frontier, sees the Stage 1 dissent --------
      const dissentNote = stage1Flags
        .map((v) => `[${v.name}] ${v.detail}`)
        .join(" | ")
      const stage2Body =
        "Frontier bash safety review (Stage 2 of 2). Reply ALLOW or DENY.\n\n" +
        "Proposed command:\n" + cmd + "\n\n" +
        "Stage 1 dissent (cheaper models flagged this — review their reasoning and decide " +
        "whether they were right or wrong; you have final say):\n" +
        dissentNote

      const stage2Raw = await Promise.all(
        stage2Models.map((m) => callModel(m, auth, sentry, stage2Body, timeoutMs)),
      )
      const stage2Votes = stage2Models.map((m, i) =>
        classifyStage2(`${m.provider}/${m.model}`, stage2Raw[i]),
      )
      const stage2Allows = stage2Votes.filter((v) => v.status === "allow")
      const stage2Denies = stage2Votes.filter((v) => v.status === "deny")
      const stage2Abstains = stage2Votes.filter((v) => v.status === "abstain")
      const latencyMs = Date.now() - t0

      // All frontier abstained → fallthrough.
      if (stage2Abstains.length === stage2Models.length) {
        logDecision({
          verdict: "FALLTHROUGH",
          reason: "all-abstained-stage2",
          latencyMs,
          cmd: cmd.slice(0, 200),
          stage1: stage1Votes,
          stage2: stage2Votes,
        })
        return
      }

      // ANY frontier DENY → block.
      if (stage2Denies.length > 0) {
        logDecision({
          verdict: "DENY",
          reason: "stage2-deny",
          latencyMs,
          cmd: cmd.slice(0, 200),
          stage1: stage1Votes,
          stage2: stage2Votes,
        })
        const reasons = stage2Denies.map((d) => `[${d.name}] ${d.detail}`).join(" | ")
        throw new Error(
          "\n🚫 verify-bash STAGE-2 DENY — HARD STOP. USER APPROVAL REQUIRED.\n\n" +
            "Command: " + cmd + "\n\n" +
            "Stage 1 dissent (cheap models flagged this): " + dissentNote + "\n\n" +
            "Stage 2 frontier review confirmed: " + reasons + "\n\n" +
            "DO NOT retry, rephrase, or work around this command without explicit user approval.\n" +
            "If the user approves: run `touch .opencode/verify-bash-next-approved` (one-shot bypass) and retry the EXACT same command.\n" +
            "If the user denies or wants a different approach: follow that direction.\n",
        )
      }

      // Need ≥2 frontier ALLOW + 0 DENY + 0 abstain to permit.
      if (stage2Allows.length < 2 || stage2Abstains.length > 0) {
        logDecision({
          verdict: "DENY",
          reason: "stage2-insufficient",
          latencyMs,
          cmd: cmd.slice(0, 200),
          stage1: stage1Votes,
          stage2: stage2Votes,
        })
        throw new Error(
          "\n🚫 verify-bash STAGE-2 INSUFFICIENT CONSENSUS — HARD STOP. USER APPROVAL REQUIRED.\n\n" +
            "Command: " + cmd + "\n\n" +
            "Stage 1 dissent (escalated): " + dissentNote + "\n\n" +
            "Stage 2 verdict: " + stage2Allows.length + " ALLOW, " + stage2Denies.length +
            " DENY, " + stage2Abstains.length + " abstain. Need ≥2 ALLOW + 0 DENY + 0 abstain.\n\n" +
            "DO NOT retry. Surface to user and wait for direction.\n",
        )
      }

      if (cache) cache.set(cmd, true)
      logDecision({
        verdict: "ALLOW",
        reason: "stage2-pass",
        latencyMs,
        cmd: cmd.slice(0, 200),
        stage1Flags: stage1Flags.length,
        stage2Allows: stage2Allows.length,
      })
    },
  }
}
