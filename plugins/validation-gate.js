// validation-gate — on session.idle, run the project's gates and pattern-detect
// across the session's tool history. Writes findings to NEXT-SESSION.md and a
// per-session summary so the next session can self-improve.
//
// Config: `.opencode/validation.config.json`  (optional; sensible defaults)
//   {
//     "enabled": true,
//     "commands": [                       // run on session.idle
//       { "name": "lint",  "cmd": "swiftlint lint --quiet", "timeoutMs": 60000 }
//     ],
//     "minAstGrepRatio": 0.10,           // expected fraction of structural searches via ast-grep
//     "patternDetection": true
//   }
//
// Defaults to: no commands (skips run step), pattern detection ON.
// Always lightweight: errors are swallowed, never blocks session end.
//
// Caveat #5894: session.idle is the parent session's idle, so subagent tool
// calls are NOT visible to pattern detection. We use trace.log + verify-bash.log
// — both write from the file-edit event lane and bash-classify pre-hook, which
// have different coverage windows.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

function loadConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".opencode/validation.config.json"), "utf8"))
  } catch {
    return {}
  }
}

function readJsonLines(p) {
  try {
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function appendToNext(root, lines) {
  try {
    const p = path.join(root, ".opencode/NEXT-SESSION.md")
    fs.appendFileSync(
      p,
      "\n## session ended " + new Date().toISOString() + "\n\n" + lines.join("\n") + "\n"
    )
  } catch {
    /* never block */
  }
}

function writeSessionSummary(root, sessionID, summary) {
  try {
    const dir = path.join(root, ".opencode/logs")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "session-" + (sessionID || "unknown") + ".summary.json"),
      JSON.stringify(summary, null, 2) + "\n"
    )
  } catch {
    /* never block */
  }
}

function runCommand(root, def, results) {
  const r = spawnSync(def.cmd, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    timeout: def.timeoutMs || 60000,
  })
  results.push({
    name: def.name,
    cmd: def.cmd,
    exit: r.status,
    pass: r.status === 0,
    stdoutTail: (r.stdout || "").split("\n").slice(-15).join("\n"),
    stderrTail: (r.stderr || "").split("\n").slice(-15).join("\n"),
  })
}

function detectPatterns(root, sessionID, cfg) {
  const findings = []
  const trace = readJsonLines(path.join(root, ".opencode/logs/trace.log"))
  const vb = readJsonLines(path.join(root, ".opencode/logs/verify-bash.log"))

  // Only look at THIS session for trace, but treat verify-bash log holistically
  // (it has no sessionID column; recent entries dominate).
  const sessTrace = sessionID ? trace.filter((t) => t.sessionID === sessionID) : trace

  const tools = sessTrace.reduce((m, t) => {
    m[t.tool || t.event || "?"] = (m[t.tool || t.event || "?"] || 0) + 1
    return m
  }, {})

  const reads = tools["read"] || 0
  const greps = (tools["grep"] || 0) + (tools["glob"] || 0)
  const structuralSearches = reads + greps
  const astGrep =
    sessTrace.filter((t) => /ast.grep|find_code/i.test(String(t.tool || ""))).length

  if (structuralSearches > 20) {
    const ratio = astGrep / structuralSearches
    const minRatio = typeof cfg.minAstGrepRatio === "number" ? cfg.minAstGrepRatio : 0.1
    if (ratio < minRatio) {
      findings.push(
        "- **ast-grep underused.** " +
          astGrep +
          " ast-grep calls vs " +
          structuralSearches +
          " raw read/grep calls (ratio " +
          ratio.toFixed(2) +
          ", expected ≥ " +
          minRatio +
          "). The prompts mandate ast-grep — agents are still defaulting to read/grep. Consider sharpening the `explore` prompt or restricting `read`/`grep` permission for the explore agent."
      )
    }
  }

  // verify-bash patterns
  const denies = vb.filter((v) => v.verdict === "DENY")
  if (denies.length > 0) {
    const cmdHits = denies.reduce((m, d) => {
      const key = (d.cmd || "").slice(0, 60)
      m[key] = (m[key] || 0) + 1
      return m
    }, {})
    const repeated = Object.entries(cmdHits).filter(([_, n]) => n >= 3)
    if (repeated.length > 0) {
      findings.push(
        "- **verify-bash policy candidates.** Same-shape commands repeatedly DENIED (≥3 times each): " +
          repeated.map(([k, n]) => "`" + k + "` (×" + n + ")").join(", ") +
          ". If these are legitimate workflows, add to `safePatterns` in `verify-bash.config.json` or refine the SENTRY policy."
      )
    }
  }

  const fallthroughs = vb.filter((v) => v.verdict === "FALLTHROUGH").length
  if (fallthroughs > 5) {
    findings.push(
      "- **verify-bash fallthroughs.** " +
        fallthroughs +
        " classifications fell through to opencode native ask (auth missing or all models abstained). Check `verify-bash.log` for `reason` and run `doctor.sh`."
    )
  }

  return { findings, tools, astGrep, structuralSearches, denies: denies.length }
}

export default async ({ worktree, directory }) => {
  const root = worktree || directory || process.cwd()
  const cfg = loadConfig(root)
  if (cfg.enabled === false) return {}

  return {
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return
      const sid = event.properties?.sessionID

      const summary = { sessionID: sid, ts: new Date().toISOString(), gates: [], patterns: null }

      // 1) Run configured gates
      const cmds = Array.isArray(cfg.commands) ? cfg.commands : []
      for (const c of cmds) {
        try {
          runCommand(root, c, summary.gates)
        } catch (e) {
          summary.gates.push({ name: c.name, cmd: c.cmd, exit: -1, pass: false, error: String(e) })
        }
      }

      // 2) Pattern-detect
      if (cfg.patternDetection !== false) {
        try {
          summary.patterns = detectPatterns(root, sid, cfg)
        } catch (e) {
          summary.patterns = { error: String(e) }
        }
      }

      writeSessionSummary(root, sid, summary)

      // 3) Append actionable items to NEXT-SESSION.md
      const failedGates = summary.gates.filter((g) => !g.pass)
      const findings = summary.patterns?.findings || []
      if (failedGates.length === 0 && findings.length === 0) return

      const lines = []
      if (failedGates.length > 0) {
        lines.push("### gates that failed this session")
        for (const g of failedGates) {
          lines.push("- `" + g.name + "` (exit " + g.exit + "): `" + g.cmd + "`")
          if (g.stderrTail) lines.push("  stderr tail:\n  ```\n  " + g.stderrTail.replace(/\n/g, "\n  ") + "\n  ```")
        }
      }
      if (findings.length > 0) {
        lines.push("### pattern findings")
        for (const f of findings) lines.push(f)
      }
      appendToNext(root, lines)
    },
  }
}
