// Unit tests for verify-bash v3 — hybrid 3+2 panel.
// Stage 1: haiku + deepseek-v4-flash (anthropic + deepseek API endpoints)
// Stage 2: sonnet + gpt-5.4 + deepseek-v4-pro
//
// Stages differentiated by prompt body containing "Stage 1 of 2" vs "Stage 2 of 2".

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

// Hybrid 3+2 mock: Stage 1 (anthropic-haiku + deepseek-flash) and Stage 2
// (anthropic-opus + anthropic-sonnet + openai-gpt). Distinguish stages by the
// "Stage X of 2" sentinel in the prompt body. Stage 2 makes 2 Anthropic + 1
// OpenAI requests; no DeepSeek call in Stage 2.
function mockPanel({
  s1_anthropic = [],
  s1_deepseek = [],
  s2_anthropic = [],
  s2_openai = [],
  s2_deepseek = [],
} = {}) {
  let a1 = 0, d1 = 0, a2 = 0, o2 = 0, d2 = 0
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    const body = init?.body ? String(init.body) : ""
    const isStage1 = body.includes("Stage 1 of 2")
    if (u.includes("api.anthropic.com")) {
      const t = isStage1 ? s1_anthropic[a1++] : s2_anthropic[a2++]
      if (t == null) return { ok: false }
      return { ok: true, json: async () => ({ content: [{ text: t }] }) }
    }
    if (u.includes("api.deepseek.com")) {
      const t = isStage1 ? s1_deepseek[d1++] : s2_deepseek[d2++]
      if (t == null) return { ok: false }
      return { ok: true, json: async () => ({ choices: [{ message: { content: t } }] }) }
    }
    if (u.includes("api.openai.com")) {
      // OpenAI only used in Stage 2 (gpt-5.4)
      const t = isStage1 ? null : s2_openai[o2++]
      if (t == null) return { ok: false }
      return { ok: true, json: async () => ({ choices: [{ message: { content: t } }] }) }
    }
    return { ok: false }
  })
}

function readLog() {
  const p = path.join(tmpDir, ".opencode/logs/verify-bash.log")
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

// ---------- ALWAYS_SAFE_RE — broad read-only set ----------

describe("ALWAYS_SAFE_RE", () => {
  it("`pwd` bypasses without calling fetch", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "pwd")
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it("`date` bypasses", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "date")
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it("`jq empty <file>` bypasses (the friction case)", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "jq empty opencode.json")
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it("`git diff foo.swift` bypasses", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "git diff foo.swift")
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it("`cat package.json` bypasses", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "cat package.json")
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it("`ls -la Packages/` bypasses", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "ls -la Packages/")
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

// ---------- Stage 1 unanimous ALLOW → no Stage 2 ----------

describe("Stage 1 only", () => {
  it("unanimous ALLOW from cheap models permits without escalation", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "make build")).resolves.toBeUndefined()
    // 2 fetches (Stage 1 only)
    expect(global.fetch.mock.calls.length).toBe(2)
    const log = readLog()
    expect(log[0].reason).toBe("stage1-pass")
  })
})

// ---------- Stage 2 escalation ----------

describe("Stage 1 FLAG → Stage 2 ALLOW", () => {
  it("escalates and frontier reverses cheap dissent", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: looks fishy"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["ALLOW: standard idiom", "ALLOW: benign"], // opus + sonnet
      s2_openai: ["ALLOW: ok"], // gpt-5.4
    })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "make build foo")).resolves.toBeUndefined()
    expect(global.fetch.mock.calls.length).toBe(5) // 2 stage1 + 3 stage2
    const log = readLog()
    expect(log[0].reason).toBe("stage2-pass")
  })

  it("Stage 2 prompt includes the Stage 1 dissent reasoning", async () => {
    let stage2Body
    global.fetch = vi.fn(async (url, init) => {
      const u = String(url)
      const body = init?.body ? String(init.body) : ""
      const isStage1 = body.includes("Stage 1 of 2")
      if (!isStage1) stage2Body = JSON.parse(body)
      if (u.includes("api.anthropic.com")) {
        const text = isStage1 ? "FLAG: jq empty unclear" : "ALLOW: standard validation idiom"
        return { ok: true, json: async () => ({ content: [{ text }] }) }
      }
      if (u.includes("api.deepseek.com")) {
        const text = isStage1 ? "ALLOW: ok" : "ALLOW: ok"
        return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
      }
      if (u.includes("api.openai.com")) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ALLOW: ok" } }] }) }
      }
      return { ok: false }
    })
    const hooks = await getHooks()
    await callBefore(hooks, "make foo bar")
    // Stage 2 body should contain the Stage 1 dissent
    const stage2Content =
      stage2Body?.messages?.[stage2Body.messages.length - 1]?.content ||
      stage2Body?.system ||
      ""
    expect(stage2Content).toMatch(/Stage 1 dissent/)
    expect(stage2Content).toMatch(/jq empty unclear/)
  })
})

describe("Stage 2 DENY → block", () => {
  it("any frontier DENY hardstops with full dissent quoted", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: bad"],
      s1_deepseek: ["FLAG: same"],
      s2_anthropic: ["DENY: confirms — destructive", "DENY: agree"], // opus + sonnet
      s2_openai: ["DENY: confirms"], // gpt-5.4
    })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "rm -rf /tmp/foo")).rejects.toThrow(/STAGE-2 DENY/)
    const log = readLog()
    expect(log[0].reason).toBe("stage2-deny")
  })

  it("single frontier DENY is enough to block (any-DENY policy)", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: bad"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["ALLOW: ok", "ALLOW: ok"], // opus + sonnet both allow
      s2_openai: ["DENY: subtle issue"], // gpt-5.4 dissents
    })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "make weird")).rejects.toThrow(/STAGE-2 DENY/)
  })
})

describe("Stage 2 insufficient consensus → block", () => {
  it("<2 frontier ALLOW = block", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: escalate"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["ALLOW: ok", null], // opus allows + sonnet abstains
      s2_openai: [null], // gpt abstains
    })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "scripts/cleanup.sh")).rejects.toThrow(/INSUFFICIENT CONSENSUS/)
    const log = readLog()
    expect(log[0].reason).toBe("stage2-insufficient")
  })
})

// ---------- All abstain → fallthrough ----------

describe("all-abstain fallthrough", () => {
  it("Stage 1 all-abstain → opencode native ask", async () => {
    mockPanel({ s1_anthropic: [null], s1_deepseek: [null] })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "weird-command")).resolves.toBeUndefined()
    const log = readLog()
    expect(log[0].reason).toBe("all-abstained-stage1")
  })

  it("Stage 2 all-abstain → fallthrough", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: escalate"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: [null, null], // opus + sonnet abstain
      s2_openai: [null], // gpt abstains
    })
    const hooks = await getHooks()
    await expect(callBefore(hooks, "weird-command")).resolves.toBeUndefined()
    const log = readLog()
    expect(log[0].reason).toBe("all-abstained-stage2")
  })
})

// ---------- LRU cache ----------

describe("LRU cache", () => {
  it("identical command hits cache (no fetch)", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await callBefore(hooks, "make build")
    const firstCalls = global.fetch.mock.calls.length
    await callBefore(hooks, "make build")
    expect(global.fetch.mock.calls.length).toBe(firstCalls)
  })
})

// ---------- Classification log ----------

describe("classification log", () => {
  it("emits one JSON line per decision", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await callBefore(hooks, "make build")
    const log = readLog()
    expect(log.length).toBe(1)
    expect(log[0].verdict).toBe("ALLOW")
    expect(log[0].cmd).toBe("make build")
  })
})

// ---------- Kill switch ----------

describe("OPENCODE_VERIFY_BASH=off", () => {
  it("skips entirely", async () => {
    process.env.OPENCODE_VERIFY_BASH = "off"
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "rm -rf /tmp/foo")
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
