// verify-bash — N-model CONSENSUS gate for bash commands (Architecture B).
//
// v2 — generic + configurable + observable + cached + timeout-bounded.
//
// CONFIG (per project, optional): `.opencode/verify-bash.config.json`
//   {
//     "enabled": true,                       // false = no-op
//     "minAllow": 3,                         // minimum ALLOW votes required
//     "timeoutMs": 12000,                    // per-call fetch deadline
//     "cacheMax": 256,                       // LRU size; 0 = no cache
//     "safePatterns": ["^make help$", ...],  // extra regex patterns to skip
//     "sentryPrompt": "...optional override...",
//     "models": [                            // override default panel
//       { "provider": "openai-api",         "model": "gpt-5.5" },
//       { "provider": "openai-api",         "model": "gpt-5.4" },
//       { "provider": "openai-api",         "model": "gpt-5.4-mini" },
//       { "provider": "anthropic-personal", "model": "claude-opus-4-6" },
//       { "provider": "anthropic-personal", "model": "claude-sonnet-4-6" },
//       { "provider": "anthropic-personal", "model": "claude-haiku-4-5" }
//     ]
//   }
//
// If a configured provider has no credential in auth.json, that model abstains
// (the consensus degrades gracefully — never crashes).
//
// STRICT CONSENSUS:
//   • ANY DENY → block (cite all dissenters).
//   • ≥minAllow ALLOW AND 0 DENY → allow.
//   • Fewer than minAllow ALLOW → block (insufficient consensus).
//   • Unparseable response → counted as DENY.
//   • All models abstain → fall through to opencode native ask.
//
// LRU CACHE (in-memory, session-scoped, ALLOWs only):
//   First time you see `git status` → full panel runs. Rest of the session it's
//   a cache hit at ~0ms. DENYs are never cached (policy may evolve).
//
// CLASSIFICATION LOG: every decision is appended to
//   `.opencode/logs/verify-bash.log` as one JSON line. Auditable trail.
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

const AUTH_PATH = path.join(os.homedir(), ".local/share/opencode/auth.json")
const NOCACHE_ENV = process.env.OPENCODE_VERIFY_BASH_NOCACHE === "1"
const TIMEOUT_ENV = Number(process.env.OPENCODE_VERIFY_BASH_TIMEOUT || 0) || null

// Always-safe — exact, zero-argument, zero-side-effect.
const ALWAYS_SAFE_RE = /^\s*(pwd|whoami|hostname|date)\s*$/

const DEFAULT_MODELS = [
  { provider: "openai-api", model: "gpt-5.4" },
  { provider: "openai-api", model: "gpt-5.4-mini" },
  { provider: "anthropic-personal", model: "claude-sonnet-4-6" },
  { provider: "anthropic-personal", model: "claude-haiku-4-5" },
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
  "UNREADABLE / OBFUSCATED COMMANDS:",
  "  • Anything you cannot understand at a glance — DENY.",
  "",
  "------- ALLOW (only when CLEARLY fitting) -------",
  "  • Read-only repo inspection: `ls`, `cat`, `head`, `tail`, `wc`, `grep`/`rg`/`sed -n` over repo paths.",
  "  • Read-only git: status / log / diff / show / ls-tree / check-ignore.",
  "  • Git mutations with concrete arguments: add / commit -m / switch / checkout <branch> (NOT --force) /",
  "    stash / mv / fetch / pull / push (NOT --force).",
  "  • Read-only gh: pr/issue/release view/list/diff/checks/status; gh api read-only endpoints.",
  "  • Build/test toolchain (whatever the project uses) with project-shape arguments.",
  "  • In-repo path creation: `mkdir -p <repo-path>`, `touch <repo-path>`.",
  "",
  "------- DECISION RULE -------",
  "If on the ALLOW list AND arguments clearly scoped to the repo AND nothing in",
  "HARD DENY matches — ALLOW. Otherwise — DENY.",
  "",
  "Be CONSERVATIVE. A false-DENY costs the user one re-run. A false-ALLOW can leak",
  "secrets, delete files, or push bad code. Always prefer DENY.",
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
      timeoutMs
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
      timeoutMs
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

function classify(name, verdict) {
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
  const models = Array.isArray(config.models) && config.models.length > 0 ? config.models : DEFAULT_MODELS
  const minAllow = Number.isInteger(config.minAllow) ? config.minAllow : 3
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

      if (fs.existsSync(APPROVAL_FILE)) {
        try {
          fs.unlinkSync(APPROVAL_FILE)
          fs.mkdirSync(path.dirname(APPROVAL_LOG), { recursive: true })
          fs.appendFileSync(
            APPROVAL_LOG,
            JSON.stringify({ ts: new Date().toISOString(), cmd, mode: "one-shot-user-approval" }) + "\n"
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

      const body =
        "Proposed bash command (classify per policy):\n" +
        cmd +
        "\n\nReply EXACTLY one line: ALLOW: <reason> or DENY: <reason>."

      const t0 = Date.now()
      const panel = await Promise.all(models.map((m) => callModel(m, auth, sentry, body, timeoutMs)))
      const latencyMs = Date.now() - t0

      const votes = models.map((m, i) => classify(`${m.provider}/${m.model}`, panel[i]))
      const denies = votes.filter((v) => v.status === "deny")
      const allows = votes.filter((v) => v.status === "allow")
      const abstains = votes.filter((v) => v.status === "abstain")

      if (abstains.length === models.length) {
        logDecision({
          verdict: "FALLTHROUGH",
          reason: "all-abstained",
          latencyMs,
          cmd: cmd.slice(0, 200),
          votes,
        })
        return
      }

      if (denies.length > 0) {
        logDecision({
          verdict: "DENY",
          reason: "consensus-deny",
          latencyMs,
          cmd: cmd.slice(0, 200),
          allows: allows.length,
          denies: denies.length,
          abstains: abstains.length,
          votes,
        })
        const reasons = denies.map((d) => `[${d.name}] ${d.detail}`).join(" | ")
        throw new Error(
          "\n🚫 verify-bash CONSENSUS DENY — HARD STOP. USER APPROVAL REQUIRED.\n\n" +
            "Command: " +
            cmd +
            "\n\n" +
            "Dissenters: " +
            reasons +
            "\n\n" +
            "DO NOT retry, rephrase, or work around this command without explicit user approval.\n" +
            "If the user approves: run `touch .opencode/verify-bash-next-approved` (one-shot bypass) and retry the EXACT same command.\n" +
            "If the user denies or wants a different approach: follow that direction.\n"
        )
      }

      if (allows.length < minAllow) {
        const abstainNames = abstains.map((a) => a.name).join(", ")
        logDecision({
          verdict: "DENY",
          reason: "insufficient-consensus",
          latencyMs,
          cmd: cmd.slice(0, 200),
          allows: allows.length,
          minAllow,
          abstains: abstains.length,
          votes,
        })
        throw new Error(
          "\n🚫 verify-bash INSUFFICIENT CONSENSUS — HARD STOP. USER APPROVAL REQUIRED.\n\n" +
            "Command: " +
            cmd +
            "\n\n" +
            "Only " +
            allows.length +
            " responder(s) said ALLOW; " +
            abstains.length +
            " abstained (" +
            abstainNames +
            "). Need ≥" +
            minAllow +
            " ALLOW votes.\n\n" +
            "DO NOT retry the command. Surface this to the user verbatim and wait for direction.\n" +
            "If the user approves: run `touch .opencode/verify-bash-next-approved` and retry.\n"
        )
      }

      if (cache) cache.set(cmd, true)
      logDecision({
        verdict: "ALLOW",
        reason: "consensus-allow",
        latencyMs,
        cmd: cmd.slice(0, 200),
        allows: allows.length,
        abstains: abstains.length,
      })
    },
  }
}
