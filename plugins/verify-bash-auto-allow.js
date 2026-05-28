// verify-bash-auto-allow — per-project exact-match auto-allow for verify-bash.
//
// Reads `.opencode/verify-bash-auto-allow.config.json` and consults its
// `allowlist` array on every bash tool call. If the proposed command (after
// whitespace normalization) is an EXACT match for any allowlist entry, the
// plugin writes the verify-bash one-shot bypass sentinel
// (`.opencode/verify-bash-next-approved`) so the verify-bash plugin lets that
// exact command through without invoking the consensus panel.
//
// This is the user-controlled escape hatch for the (small, audited) set of
// commands you run constantly and have already decided are safe — e.g. a
// project's smoke-test runner, sim reinstall script, etc. It's belt-and-
// suspenders with the cross-plugin script whitelist (which covers reviewed
// script CONTENT) — this covers exact COMMAND STRINGS, which is appropriate
// for argless / fixed-arg invocations where you don't want to re-pay the
// review cost.
//
// CONFIG FILE: .opencode/verify-bash-auto-allow.config.json
//   {
//     "allowlist": [
//       "scripts/sim.sh reinstall",
//       "scripts/qa/run-scenario.sh rest_timer",
//       "npm test"
//     ],
//     "enabled": true     // optional; false = no-op
//   }
//
// Default: empty allowlist. No commands auto-allow without explicit opt-in.
// You curate this list yourself; use the `/auto-allow "<command>"` slash
// command to append entries.
//
// PRECEDENCE: this plugin must fire BEFORE verify-bash for the same bash call
// (so the sentinel is in place when verify-bash checks). opencode runs plugins
// in alphabetical order, so `verify-bash-auto-allow` comes before `verify-bash`
// — wired correctly by virtue of the filename.
//
// SAFETY:
//   • Reads the config fresh on every call (no caching) so the allowlist
//     reflects the current file state without requiring opencode restart.
//   • Strict equality after whitespace normalization. No wildcards, no globs,
//     no regex — if you want pattern matching, add an extra `safePatterns`
//     entry to verify-bash.config.json instead.
//   • No shelling out, no network, no recursion.
//   • Every auto-allow event is logged to `.opencode/logs/verify-bash-auto-allow.log`
//     as one JSON line, so you can audit which commands fired.
//
// ENV: OPENCODE_VERIFY_BASH_AUTO_ALLOW=off to disable for the current session.

import fs from "node:fs"
import path from "node:path"

function normalize(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
}

function loadConfig(root) {
  const p = path.join(root, ".opencode/verify-bash-auto-allow.config.json")
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return {}
  }
}

function logEvent(root, entry) {
  const logPath = path.join(root, ".opencode/logs/verify-bash-auto-allow.log")
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n")
  } catch {
    /* never block on logging */
  }
}

export default async ({ worktree, directory }) => {
  const root = worktree || directory || process.cwd()
  const sentinel = path.join(root, ".opencode", "verify-bash-next-approved")

  return {
    "tool.execute.before": async (input, output) => {
      if (process.env.OPENCODE_VERIFY_BASH_AUTO_ALLOW === "off") return

      const tool = output?.tool ?? input?.tool ?? ""
      if (tool !== "bash") return

      // Re-read config every call so edits take effect without restart.
      const config = loadConfig(root)
      if (config.enabled === false) return

      const allowlist = Array.isArray(config.allowlist) ? config.allowlist.map(normalize) : []
      if (allowlist.length === 0) return

      const command = normalize(input?.args?.command ?? output?.args?.command ?? "")
      if (!command) return
      if (!allowlist.includes(command)) return

      // Write the one-shot bypass sentinel — verify-bash will consume it on this
      // same call and let the command through without the panel.
      try {
        fs.mkdirSync(path.dirname(sentinel), { recursive: true })
        fs.writeFileSync(sentinel, "auto-allow: " + command, { encoding: "utf8" })
      } catch {
        // Logged but not blocked — verify-bash will fall to panel review and the
        // user can /approve manually.
      }
      logEvent(root, { command, source: "verify-bash-auto-allow" })
    },
  }
}
