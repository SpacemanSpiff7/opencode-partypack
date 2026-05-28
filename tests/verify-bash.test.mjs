// Unit tests for verify-bash decision logic. Mocks the 5-model panel via global.fetch.
//
// Panel: gpt-5.4 / gpt-5.4-mini (openai-api)
//        sonnet-4.6 / haiku-4.5 (anthropic-personal)
//        deepseek-v4-pro (deepseek)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let tmpDir
const FAKE_AUTH = {
  "anthropic-personal": { key: "ANT_FAKE" },
  "openai-api": { key: "OAI_FAKE" },
  deepseek: { key: "DSK_FAKE" },
}

async function loadPlugin() {
  const mod = await import(path.resolve("plugins/verify-bash.js") + "?t=" + Date.now())
  return mod.default
}

async function getHooks() {
  const plugin = await loadPlugin()
  return plugin({ worktree: tmpDir, directory: tmpDir })
}

async function callBefore(hooks, cmd) {
  return hooks["tool.execute.before"]({ tool: "bash", args: { command: cmd } }, {})
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-test-"))
  fs.mkdirSync(path.join(tmpDir, ".opencode/logs"), { recursive: true })
  const realRead = fs.readFileSync
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

// 5-model panel: 2 OpenAI + 2 Anthropic + 1 DeepSeek (OpenAI-compatible endpoint).
function mockPanel({ openai = [], anthropic = [], deepseek = [] } = {}) {
  let oCall = 0,
    aCall = 0,
    dCall = 0
  global.fetch = vi.fn(async (url) => {
    const u = String(url)
    if (u.includes("api.openai.com")) {
      const text = openai[oCall++] ?? null
      if (text === null) return { ok: false }
      return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
    }
    if (u.includes("api.anthropic.com")) {
      const text = anthropic[aCall++] ?? null
      if (text === null) return { ok: false }
      return { ok: true, json: async () => ({ content: [{ text }] }) }
    }
    if (u.includes("api.deepseek.com")) {
      const text = deepseek[dCall++] ?? null
      if (text === null) return { ok: false }
      return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
    }
    return { ok: false }
  })
}

describe("ALWAYS_SAFE_RE", () => {
  it("lets pwd through without calling fetch", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await expect(callBefore(hooks, "pwd")).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it("lets `date` through without calling fetch", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await expect(callBefore(hooks, "date")).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe("consensus (5-model)", () => {
  it("ALLOWS when ≥3 ALLOW and 0 DENY", async () => {
    mockPanel({
      openai: ["ALLOW: ok", "ALLOW: ok"],
      anthropic: ["ALLOW: yes", "ALLOW: routine"],
      deepseek: ["ALLOW: scoped"],
    })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "ls Packages/")).resolves.toBeUndefined()
  })

  it("BLOCKS when any model DENIES", async () => {
    mockPanel({
      openai: ["ALLOW: ok", "ALLOW: ok"],
      anthropic: ["ALLOW: ok", "ALLOW: ok"],
      deepseek: ["DENY: scope unclear"],
    })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "rm scripts/x")).rejects.toThrow(/CONSENSUS DENY/)
  })

  it("BLOCKS on insufficient consensus (<3 ALLOW)", async () => {
    mockPanel({
      openai: ["ALLOW: ok", null],
      anthropic: ["ALLOW: ok", null],
      deepseek: [null],
    })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "scripts/cleanup.sh")).rejects.toThrow(/INSUFFICIENT CONSENSUS/)
  })

  it("treats unparseable response as DENY", async () => {
    mockPanel({
      openai: ["ALLOW: ok", "ALLOW: ok"],
      anthropic: ["ALLOW: ok", "I think this is fine"], // unparseable counts as DENY
      deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "make")).rejects.toThrow(/CONSENSUS DENY/)
  })

  it("falls through to native ask when all 5 abstain", async () => {
    mockPanel({ openai: [null, null], anthropic: [null, null], deepseek: [null] })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "weird-command")).resolves.toBeUndefined()
  })
})

describe("LRU cache", () => {
  it("hits cache on repeated identical command (same hooks instance)", async () => {
    mockPanel({
      openai: ["ALLOW: ok", "ALLOW: ok"],
      anthropic: ["ALLOW: ok", "ALLOW: ok"],
      deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await callBefore(hooks, "ls Packages/")
    const firstCalls = global.fetch.mock.calls.length
    await callBefore(hooks, "ls Packages/") // should hit cache
    expect(global.fetch.mock.calls.length).toBe(firstCalls)
  })
})

describe("classification log", () => {
  it("writes a JSON line per decision", async () => {
    mockPanel({
      openai: ["ALLOW: ok", "ALLOW: ok"],
      anthropic: ["ALLOW: ok", "ALLOW: ok"],
      deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await callBefore(hooks, "ls Packages/")
    const log = fs.readFileSync(path.join(tmpDir, ".opencode/logs/verify-bash.log"), "utf8")
    const lines = log.trim().split("\n").map((l) => JSON.parse(l))
    expect(lines[0].verdict).toBe("ALLOW")
    expect(lines[0].reason).toBe("consensus-allow")
    expect(lines[0].cmd).toBe("ls Packages/")
  })
})

describe("OPENCODE_VERIFY_BASH=off (runtime env check)", () => {
  it("skips entirely", async () => {
    process.env.OPENCODE_VERIFY_BASH = "off"
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await expect(callBefore(hooks, "rm -rf /")).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
