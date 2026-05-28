// Unit tests for verify-bash decision logic. Mocks the LLM panel via global.fetch.
// Run with:  npm test

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Helper: write a fake auth.json before each test so loadAuth() succeeds.
let tmpDir
let origAuth
const FAKE_AUTH = {
  "anthropic-personal": { key: "ANT_FAKE" },
  "openai-api": { key: "OAI_FAKE" },
}

async function loadPlugin() {
  // Re-import to ensure module-level vars pick up env changes
  const mod = await import(
    path.resolve("plugins/verify-bash.js") + "?t=" + Date.now()
  )
  return mod.default
}

async function callBefore(plugin, cmd, opts = {}) {
  const hooks = await plugin({ worktree: tmpDir, directory: tmpDir })
  return hooks["tool.execute.before"](
    { tool: "bash", args: { command: cmd }, ...opts },
    {}
  )
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-test-"))
  fs.mkdirSync(path.join(tmpDir, ".opencode/logs"), { recursive: true })
  // Point AUTH_PATH at our tmp by stubbing fs.readFileSync for auth.json only.
  const realRead = fs.readFileSync
  origAuth = realRead
  vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
    if (String(p).endsWith("/auth.json")) return JSON.stringify(FAKE_AUTH)
    return realRead.call(fs, p, enc)
  })
  delete process.env.OPENCODE_VERIFY_BASH_NOCACHE
  delete process.env.OPENCODE_VERIFY_BASH
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function mockPanel({ openai = [], anthropic = [] } = {}) {
  let oCall = 0, aCall = 0
  global.fetch = vi.fn(async (url) => {
    const u = String(url)
    if (u.includes("openai.com")) {
      const text = openai[oCall++] ?? null
      if (text === null) return { ok: false }
      return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
    }
    if (u.includes("anthropic.com")) {
      const text = anthropic[aCall++] ?? null
      if (text === null) return { ok: false }
      return { ok: true, json: async () => ({ content: [{ text }] }) }
    }
    return { ok: false }
  })
}

describe("ALWAYS_SAFE_RE", () => {
  it("lets pwd through without calling fetch", async () => {
    global.fetch = vi.fn()
    const plugin = await loadPlugin()
    await expect(callBefore(plugin, "pwd")).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it("lets `date` through without calling fetch", async () => {
    global.fetch = vi.fn()
    const plugin = await loadPlugin()
    await expect(callBefore(plugin, "date")).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe("consensus", () => {
  it("ALLOWS when ≥3 ALLOW and 0 DENY", async () => {
    mockPanel({
      openai: ["ALLOW: looks fine", "ALLOW: ok", "ALLOW: routine"],
      anthropic: ["ALLOW: yes", "ALLOW: ok", "ALLOW: routine"],
    })
    const plugin = await loadPlugin()
    await expect(callBefore(plugin, "ls Packages/")).resolves.toBeUndefined()
  })

  it("BLOCKS when any model DENIES", async () => {
    mockPanel({
      openai: ["ALLOW: ok", "ALLOW: ok", "DENY: smells off"],
      anthropic: ["ALLOW: ok", "ALLOW: ok", "ALLOW: ok"],
    })
    const plugin = await loadPlugin()
    await expect(callBefore(plugin, "rm scripts/x")).rejects.toThrow(/CONSENSUS DENY/)
  })

  it("BLOCKS on insufficient consensus (<3 ALLOW)", async () => {
    mockPanel({
      openai: ["ALLOW: ok", null, null], // first ALLOW, two abstain
      anthropic: ["ALLOW: ok", null, null], // first ALLOW, two abstain
    })
    const plugin = await loadPlugin()
    await expect(callBefore(plugin, "scripts/cleanup.sh")).rejects.toThrow(/INSUFFICIENT CONSENSUS/)
  })

  it("treats unparseable response as DENY", async () => {
    mockPanel({
      openai: ["ALLOW: ok", "ALLOW: ok", "I think this is fine"],
      anthropic: ["ALLOW: ok", "ALLOW: ok", "ALLOW: ok"],
    })
    const plugin = await loadPlugin()
    await expect(callBefore(plugin, "make")).rejects.toThrow(/CONSENSUS DENY/)
  })

  it("falls through to native ask when all abstain", async () => {
    mockPanel({ openai: [null, null, null], anthropic: [null, null, null] })
    const plugin = await loadPlugin()
    await expect(callBefore(plugin, "weird-command")).resolves.toBeUndefined()
  })
})

describe("LRU cache", () => {
  it("hits cache on repeated identical command", async () => {
    mockPanel({
      openai: ["ALLOW: ok", "ALLOW: ok", "ALLOW: ok"],
      anthropic: ["ALLOW: ok", "ALLOW: ok", "ALLOW: ok"],
    })
    const plugin = await loadPlugin()
    await callBefore(plugin, "ls Packages/")
    const firstCalls = global.fetch.mock.calls.length
    await callBefore(plugin, "ls Packages/") // should hit cache
    expect(global.fetch.mock.calls.length).toBe(firstCalls)
  })
})

describe("classification log", () => {
  it("writes a JSON line per decision", async () => {
    mockPanel({
      openai: ["ALLOW: ok", "ALLOW: ok", "ALLOW: ok"],
      anthropic: ["ALLOW: ok", "ALLOW: ok", "ALLOW: ok"],
    })
    const plugin = await loadPlugin()
    await callBefore(plugin, "ls Packages/")
    const log = fs.readFileSync(path.join(tmpDir, ".opencode/logs/verify-bash.log"), "utf8")
    const lines = log.trim().split("\n").map((l) => JSON.parse(l))
    expect(lines[0].verdict).toBe("ALLOW")
    expect(lines[0].reason).toBe("consensus-allow")
    expect(lines[0].cmd).toBe("ls Packages/")
  })
})

describe("OPENCODE_VERIFY_BASH=off", () => {
  it("skips entirely", async () => {
    process.env.OPENCODE_VERIFY_BASH = "off"
    global.fetch = vi.fn()
    const plugin = await loadPlugin()
    await expect(callBefore(plugin, "rm -rf /")).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
