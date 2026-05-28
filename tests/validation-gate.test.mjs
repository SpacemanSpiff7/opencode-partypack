// Unit tests for validation-gate pattern detection + gate execution + outputs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let tmpDir

async function loadPlugin() {
  const mod = await import(path.resolve("plugins/validation-gate.js") + "?t=" + Date.now())
  return mod.default
}

function writeTrace(sessionID, entries) {
  const dir = path.join(tmpDir, ".opencode/logs")
  fs.mkdirSync(dir, { recursive: true })
  const lines = entries.map((e) => JSON.stringify({ sessionID, ...e }))
  fs.writeFileSync(path.join(dir, "trace.log"), lines.join("\n") + "\n")
}

function writeVerifyBashLog(entries) {
  const dir = path.join(tmpDir, ".opencode/logs")
  fs.mkdirSync(dir, { recursive: true })
  const lines = entries.map((e) => JSON.stringify(e))
  fs.writeFileSync(path.join(dir, "verify-bash.log"), lines.join("\n") + "\n")
}

function writeConfig(cfg) {
  fs.mkdirSync(path.join(tmpDir, ".opencode"), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, ".opencode/validation.config.json"),
    JSON.stringify(cfg)
  )
}

async function fireIdle(sessionID = "ses-test") {
  const plugin = await loadPlugin()
  const hooks = await plugin({ worktree: tmpDir, directory: tmpDir })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vg-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("pattern detection — ast-grep underuse", () => {
  it("flags when ast-grep ratio is below threshold (default 0.10)", async () => {
    const trace = []
    for (let i = 0; i < 50; i++) trace.push({ tool: "read" })
    for (let i = 0; i < 10; i++) trace.push({ tool: "grep" })
    // zero ast-grep
    writeTrace("ses-test", trace)
    await fireIdle("ses-test")
    const next = fs.readFileSync(path.join(tmpDir, ".opencode/NEXT-SESSION.md"), "utf8")
    expect(next).toMatch(/ast-grep underused/)
    expect(next).toMatch(/0 ast-grep calls vs 60/)
  })

  it("does NOT flag when ratio is above threshold", async () => {
    const trace = []
    for (let i = 0; i < 50; i++) trace.push({ tool: "read" })
    for (let i = 0; i < 20; i++) trace.push({ tool: "ast_grep_find_code" })
    writeTrace("ses-test", trace)
    await fireIdle("ses-test")
    const next = path.join(tmpDir, ".opencode/NEXT-SESSION.md")
    if (fs.existsSync(next)) {
      expect(fs.readFileSync(next, "utf8")).not.toMatch(/ast-grep underused/)
    }
  })

  it("respects custom minAstGrepRatio threshold", async () => {
    writeConfig({ minAstGrepRatio: 0.5 })
    const trace = []
    for (let i = 0; i < 50; i++) trace.push({ tool: "read" })
    for (let i = 0; i < 20; i++) trace.push({ tool: "ast_grep_find_code" }) // ratio = 20/70 = 0.29
    writeTrace("ses-test", trace)
    await fireIdle("ses-test")
    const next = fs.readFileSync(path.join(tmpDir, ".opencode/NEXT-SESSION.md"), "utf8")
    expect(next).toMatch(/ast-grep underused/)
  })

  it("skips ast-grep check when sample size is too small (<20 searches)", async () => {
    const trace = []
    for (let i = 0; i < 10; i++) trace.push({ tool: "read" })
    writeTrace("ses-test", trace)
    await fireIdle("ses-test")
    const next = path.join(tmpDir, ".opencode/NEXT-SESSION.md")
    if (fs.existsSync(next)) {
      expect(fs.readFileSync(next, "utf8")).not.toMatch(/ast-grep underused/)
    }
  })
})

describe("pattern detection — verify-bash policy candidates", () => {
  it("flags commands DENIED 3+ times as policy candidates", async () => {
    writeVerifyBashLog([
      { verdict: "DENY", cmd: "scripts/cleanup.sh --all" },
      { verdict: "DENY", cmd: "scripts/cleanup.sh --all" },
      { verdict: "DENY", cmd: "scripts/cleanup.sh --all" },
      { verdict: "ALLOW", cmd: "ls" },
    ])
    writeTrace("ses-test", [{ tool: "read" }])
    await fireIdle("ses-test")
    const next = fs.readFileSync(path.join(tmpDir, ".opencode/NEXT-SESSION.md"), "utf8")
    expect(next).toMatch(/policy candidates/)
    expect(next).toMatch(/scripts\/cleanup\.sh --all.*×3/)
  })

  it("does NOT flag commands denied only 1-2 times", async () => {
    writeVerifyBashLog([
      { verdict: "DENY", cmd: "weird-cmd" },
      { verdict: "DENY", cmd: "weird-cmd" },
    ])
    writeTrace("ses-test", [{ tool: "read" }])
    await fireIdle("ses-test")
    const next = path.join(tmpDir, ".opencode/NEXT-SESSION.md")
    if (fs.existsSync(next)) {
      expect(fs.readFileSync(next, "utf8")).not.toMatch(/policy candidates/)
    }
  })
})

describe("pattern detection — fallthrough warnings", () => {
  it("warns when more than 5 fallthroughs occurred (suggests auth/network issue)", async () => {
    const fallthroughs = []
    for (let i = 0; i < 6; i++) {
      fallthroughs.push({ verdict: "FALLTHROUGH", reason: "all-abstained", cmd: `cmd-${i}` })
    }
    writeVerifyBashLog(fallthroughs)
    writeTrace("ses-test", [{ tool: "read" }])
    await fireIdle("ses-test")
    const next = fs.readFileSync(path.join(tmpDir, ".opencode/NEXT-SESSION.md"), "utf8")
    expect(next).toMatch(/fallthroughs/)
    expect(next).toMatch(/doctor\.sh/)
  })
})

describe("gate execution", () => {
  it("runs configured commands and captures pass/fail", async () => {
    writeConfig({
      commands: [
        { name: "echo-pass", cmd: "true" },
        { name: "echo-fail", cmd: "false" },
      ],
    })
    writeTrace("ses-test", [{ tool: "read" }])
    await fireIdle("ses-test")
    const summary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".opencode/logs/session-ses-test.summary.json"), "utf8")
    )
    expect(summary.gates).toHaveLength(2)
    expect(summary.gates[0]).toMatchObject({ name: "echo-pass", pass: true })
    expect(summary.gates[1]).toMatchObject({ name: "echo-fail", pass: false })
  })

  it("appends failed gates to NEXT-SESSION.md", async () => {
    writeConfig({
      commands: [{ name: "lint", cmd: "false" }],
    })
    writeTrace("ses-test", [{ tool: "read" }])
    await fireIdle("ses-test")
    const next = fs.readFileSync(path.join(tmpDir, ".opencode/NEXT-SESSION.md"), "utf8")
    expect(next).toMatch(/gates that failed/)
    expect(next).toMatch(/`lint`/)
  })
})

describe("disabled mode", () => {
  it("does nothing when config.enabled = false", async () => {
    writeConfig({ enabled: false, commands: [{ name: "x", cmd: "true" }] })
    writeTrace("ses-test", [{ tool: "read" }])
    await fireIdle("ses-test")
    expect(fs.existsSync(path.join(tmpDir, ".opencode/logs/session-ses-test.summary.json"))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, ".opencode/NEXT-SESSION.md"))).toBe(false)
  })
})

describe("session.idle for other event types", () => {
  it("ignores non-idle events", async () => {
    
    const plugin = await loadPlugin()
    const hooks = await plugin({ worktree: tmpDir, directory: tmpDir })
    await hooks.event({ event: { type: "file.edited", properties: {} } })
    expect(fs.existsSync(path.join(tmpDir, ".opencode/logs"))).toBe(false)
  })
})
