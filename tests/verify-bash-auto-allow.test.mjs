// Unit tests for verify-bash-auto-allow.js — exact-match auto-allowlist that
// writes the verify-bash one-shot bypass sentinel for whitelisted commands.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let tmpDir

async function loadPlugin() {
  const mod = await import(path.resolve("plugins/verify-bash-auto-allow.js") + "?t=" + Date.now())
  return mod.default
}

async function getHooks() {
  const plugin = await loadPlugin()
  return plugin({ worktree: tmpDir, directory: tmpDir })
}

async function callBefore(hooks, tool, args) {
  return hooks["tool.execute.before"]({ tool, args }, {})
}

function writeConfig(map) {
  const p = path.join(tmpDir, ".opencode/verify-bash-auto-allow.config.json")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(map))
}

function sentinelPath() {
  return path.join(tmpDir, ".opencode", "verify-bash-next-approved")
}

function readLog() {
  const p = path.join(tmpDir, ".opencode/logs/verify-bash-auto-allow.log")
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vbaa-test-"))
  fs.mkdirSync(path.join(tmpDir, ".opencode/logs"), { recursive: true })
  delete process.env.OPENCODE_VERIFY_BASH_AUTO_ALLOW
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("verify-bash-auto-allow", () => {
  it("no config file → no sentinel, no log", async () => {
    const hooks = await getHooks()
    await callBefore(hooks, "bash", { command: "any command" })
    expect(fs.existsSync(sentinelPath())).toBe(false)
    expect(readLog().length).toBe(0)
  })

  it("config with empty allowlist → no sentinel", async () => {
    writeConfig({ allowlist: [] })
    const hooks = await getHooks()
    await callBefore(hooks, "bash", { command: "scripts/sim.sh reinstall" })
    expect(fs.existsSync(sentinelPath())).toBe(false)
  })

  it("exact-match command → writes sentinel + logs", async () => {
    writeConfig({ allowlist: ["scripts/sim.sh reinstall"] })
    const hooks = await getHooks()
    await callBefore(hooks, "bash", { command: "scripts/sim.sh reinstall" })
    expect(fs.existsSync(sentinelPath())).toBe(true)
    const log = readLog()
    expect(log.length).toBe(1)
    expect(log[0].command).toBe("scripts/sim.sh reinstall")
  })

  it("whitespace normalization — extra spaces in command match", async () => {
    writeConfig({ allowlist: ["scripts/sim.sh reinstall"] })
    const hooks = await getHooks()
    await callBefore(hooks, "bash", { command: "  scripts/sim.sh   reinstall  " })
    expect(fs.existsSync(sentinelPath())).toBe(true)
  })

  it("non-matching command → no sentinel", async () => {
    writeConfig({ allowlist: ["scripts/sim.sh reinstall"] })
    const hooks = await getHooks()
    await callBefore(hooks, "bash", { command: "scripts/sim.sh reinstall extra-arg" })
    expect(fs.existsSync(sentinelPath())).toBe(false)
  })

  it("non-bash tool → no-op", async () => {
    writeConfig({ allowlist: ["scripts/sim.sh reinstall"] })
    const hooks = await getHooks()
    await callBefore(hooks, "write", { file_path: "foo", content: "bar" })
    expect(fs.existsSync(sentinelPath())).toBe(false)
  })

  it("config.enabled === false → no-op even on a match", async () => {
    writeConfig({ enabled: false, allowlist: ["scripts/sim.sh reinstall"] })
    const hooks = await getHooks()
    await callBefore(hooks, "bash", { command: "scripts/sim.sh reinstall" })
    expect(fs.existsSync(sentinelPath())).toBe(false)
  })

  it("OPENCODE_VERIFY_BASH_AUTO_ALLOW=off → no-op", async () => {
    process.env.OPENCODE_VERIFY_BASH_AUTO_ALLOW = "off"
    writeConfig({ allowlist: ["scripts/sim.sh reinstall"] })
    const hooks = await getHooks()
    await callBefore(hooks, "bash", { command: "scripts/sim.sh reinstall" })
    expect(fs.existsSync(sentinelPath())).toBe(false)
  })

  it("config re-read on every call (no caching)", async () => {
    writeConfig({ allowlist: [] })
    const hooks = await getHooks()
    await callBefore(hooks, "bash", { command: "scripts/sim.sh reinstall" })
    expect(fs.existsSync(sentinelPath())).toBe(false)

    // Add to allowlist mid-session
    writeConfig({ allowlist: ["scripts/sim.sh reinstall"] })
    await callBefore(hooks, "bash", { command: "scripts/sim.sh reinstall" })
    expect(fs.existsSync(sentinelPath())).toBe(true)
  })

  it("multiple allowlist entries — each command matches independently", async () => {
    writeConfig({
      allowlist: [
        "scripts/sim.sh reinstall",
        "scripts/qa/run-scenario.sh rest_timer",
        "npm test",
      ],
    })
    const hooks = await getHooks()
    await callBefore(hooks, "bash", { command: "npm test" })
    expect(fs.existsSync(sentinelPath())).toBe(true)
    const log = readLog()
    expect(log[0].command).toBe("npm test")
  })

  it("missing args.command → no-op (no crash)", async () => {
    writeConfig({ allowlist: ["scripts/sim.sh reinstall"] })
    const hooks = await getHooks()
    await callBefore(hooks, "bash", {})
    expect(fs.existsSync(sentinelPath())).toBe(false)
  })
})
