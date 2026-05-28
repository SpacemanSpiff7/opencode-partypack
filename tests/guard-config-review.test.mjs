// Unit tests for guard-config-review.js. Mocks the panel via global.fetch.
//
// Stage 1 panel: haiku-4.5 (anthropic-personal) + deepseek-v4-flash (deepseek).
// Stage 2 panel: opus-4.7 + sonnet-4.6 (anthropic-personal) + gpt-5.5-pro (openai-api).

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
  const mod = await import(path.resolve("plugins/guard-config-review.js") + "?t=" + Date.now())
  return mod.default
}

async function getHooks() {
  const plugin = await loadPlugin()
  return plugin({ worktree: tmpDir, directory: tmpDir })
}

function callBefore(hooks, tool, args) {
  return hooks["tool.execute.before"]({ tool, args }, {})
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gcr-test-"))
  fs.mkdirSync(path.join(tmpDir, ".opencode/logs"), { recursive: true })
  const realRead = fs.readFileSync
  vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
    if (String(p).endsWith("/auth.json")) return JSON.stringify(FAKE_AUTH)
    return realRead.call(fs, p, enc)
  })
  delete process.env.OPENCODE_GUARD_CONFIG_REVIEW
  delete process.env.OPENCODE_GUARD_CONFIG_REVIEW_NOCACHE
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// Mock the hybrid 3+2 panel. Pass per-stage responses; `null` = abstain.
function mockPanel({
  s1_anthropic = [],
  s1_deepseek = [],
  s2_anthropic = [],
  s2_openai = [],
} = {}) {
  let s1aCall = 0,
    s1dCall = 0,
    s2aCall = 0,
    s2oCall = 0
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    const body = init?.body ? String(init.body) : ""
    const isStage1 = body.includes("Stage 1 of 2")
    if (u.includes("api.anthropic.com")) {
      const text = isStage1 ? s1_anthropic[s1aCall++] : s2_anthropic[s2aCall++]
      if (text == null) return { ok: false }
      return { ok: true, json: async () => ({ content: [{ text }] }) }
    }
    if (u.includes("api.deepseek.com")) {
      const text = isStage1 ? s1_deepseek[s1dCall++] : null
      if (text == null) return { ok: false }
      return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
    }
    if (u.includes("api.openai.com")) {
      const text = isStage1 ? null : s2_openai[s2oCall++]
      if (text == null) return { ok: false }
      return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
    }
    return { ok: false }
  })
}

function readLog() {
  const p = path.join(tmpDir, ".opencode/logs/guard-config-review.log")
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

// ---------- path classification ----------

describe("non-sensitive path", () => {
  it("passes through without calling the panel", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "src/Foo.swift"),
      content: "// some swift",
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe("ephemeral paths", () => {
  it("/tmp/ → bypass", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "write", { file_path: "/tmp/scratch.mjs", content: "console.log(1)" })
    expect(global.fetch).not.toHaveBeenCalled()
    const log = readLog()
    expect(log[0].reason).toBe("ephemeral-bypass")
  })

  it(".scratch/ → bypass", async () => {
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, ".scratch/throwaway.js"),
      content: "x",
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("ephemeral wins even on a path inside scripts/", async () => {
    // scripts/util/_*.json is in the ephemeral list (transient util outputs).
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "scripts/util/_cache.json"),
      content: "{}",
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

// ---------- Stage 1 only ----------

describe("Stage 1 — unanimous ALLOW + small diff", () => {
  it("permits with no Stage 2", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: small focused change"],
      s1_deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "scripts/util/foo.mjs"),
      content: "export const x = 1\n",
    })
    // 2 fetches (Stage 1 only), no Stage 2
    expect(global.fetch.mock.calls.length).toBe(2)
    const log = readLog()
    expect(log[0].verdict).toBe("ALLOW")
    expect(log[0].reason).toBe("stage1-pass")
  })
})

// ---------- escalation triggers ----------

describe("Stage 2 escalation", () => {
  it("Stage 1 FLAG → Stage 2 ALLOW", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: looks fishy"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["ALLOW: actually benign", "ALLOW: benign"],
      s2_openai: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "package.json"),
      content: '{"name":"x","version":"1.0.0"}',
    })
    expect(global.fetch.mock.calls.length).toBe(5) // 2 stage1 + 3 stage2
    const log = readLog()
    expect(log[0].verdict).toBe("ALLOW")
    expect(log[0].reason).toBe("stage2-pass")
  })

  it("Stage 1 FLAG → Stage 2 DENY → throws", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: weakened deny rule"],
      s1_deepseek: ["FLAG: same"],
      s2_anthropic: ["DENY: removed sudo deny", "DENY: removed sudo deny"],
      s2_openai: ["DENY: confirms"],
    })
    const hooks = await getHooks()
    await expect(
      callBefore(hooks, "write", {
        file_path: path.join(tmpDir, "opencode.json"),
        content: '{"permission":{"bash":{"sudo *":"allow"}}}',
      }),
    ).rejects.toThrow(/SECURITY DENY/)
    const log = readLog()
    expect(log[0].verdict).toBe("DENY")
    expect(log[0].reason).toBe("stage2-deny")
    expect(log[0].dissenters.length).toBeGreaterThan(0)
  })

  it("Stage 2 insufficient (1 ALLOW + 2 abstain) → DENY", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: escalate"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["ALLOW: ok", null], // 1 allow + 1 abstain
      s2_openai: [null], // 1 abstain
    })
    const hooks = await getHooks()
    await expect(
      callBefore(hooks, "write", {
        file_path: path.join(tmpDir, "scripts/util/foo.mjs"),
        content: "// some\n".repeat(10),
      }),
    ).rejects.toThrow(/SECURITY DENY/)
    const log = readLog()
    expect(log[0].verdict).toBe("DENY")
    expect(log[0].reason).toBe("stage2-insufficient")
  })
})

describe("always-frontier paths skip Stage 1 decision", () => {
  it("Stage 2 runs even with Stage 1 unanimous ALLOW", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["ALLOW: ok", "ALLOW: ok"],
      s2_openai: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, ".opencode/plugins/my-plugin.js"),
      content: "export default async () => ({})",
    })
    // Stage 1 (2) + Stage 2 (3) — plugin code is on always-frontier list
    expect(global.fetch.mock.calls.length).toBe(5)
    const log = readLog()
    expect(log[0].reason).toBe("stage2-pass")
  })
})

describe("big-diff escalation", () => {
  it(">200 lines escalates even with Stage 1 ALLOW", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["ALLOW: ok", "ALLOW: ok"],
      s2_openai: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    const bigContent = "// line\n".repeat(250)
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "scripts/big.mjs"),
      content: bigContent,
    })
    expect(global.fetch.mock.calls.length).toBe(5) // escalated
    const log = readLog()
    expect(log[0].reason).toBe("stage2-pass")
  })
})

// ---------- cache ----------

describe("cache", () => {
  it("identical re-proposal hits cache (no fetch)", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    const args = {
      file_path: path.join(tmpDir, "scripts/util/foo.mjs"),
      content: "export const x = 1\n",
    }
    await callBefore(hooks, "write", args)
    const firstCalls = global.fetch.mock.calls.length

    // Same plugin instance, same diff
    await callBefore(hooks, "write", args)
    expect(global.fetch.mock.calls.length).toBe(firstCalls) // cache hit, no new fetch

    const log = readLog()
    expect(log[1].reason).toBe("cache-hit")
    expect(log[1].verdict).toBe("ALLOW")
  })

  it("cached DENY throws on re-proposal", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: bad"],
      s1_deepseek: ["FLAG: same"],
      s2_anthropic: ["DENY: nope", "DENY: nope"],
      s2_openai: ["DENY: nope"],
    })
    const hooks = await getHooks()
    const args = {
      file_path: path.join(tmpDir, "opencode.json"),
      content: '{"permission":{"bash":{"sudo *":"allow"}}}',
    }
    await expect(callBefore(hooks, "write", args)).rejects.toThrow(/SECURITY DENY/)
    const firstCalls = global.fetch.mock.calls.length
    await expect(callBefore(hooks, "write", args)).rejects.toThrow(/SECURITY DENY/)
    expect(global.fetch.mock.calls.length).toBe(firstCalls) // cache hit
    const log = readLog()
    expect(log[1].reason).toBe("cache-hit")
    expect(log[1].verdict).toBe("DENY")
  })
})

// ---------- kill switch ----------

describe("OPENCODE_GUARD_CONFIG_REVIEW=off", () => {
  it("skips entirely", async () => {
    process.env.OPENCODE_GUARD_CONFIG_REVIEW = "off"
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "opencode.json"),
      content: '{"permission":{"bash":{"*":"allow"}}}',
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

// ---------- fail-closed on missing auth ----------

describe("no auth.json", () => {
  it("DENIES sensitive writes (fail-closed)", async () => {
    // Override readFileSync to fail for auth.json
    fs.readFileSync.mockRestore()
    vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
      if (String(p).endsWith("/auth.json")) throw new Error("ENOENT")
      return fs.readFileSync.mock.results[0]?.value ?? ""
    })
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await expect(
      callBefore(hooks, "write", {
        file_path: path.join(tmpDir, "opencode.json"),
        content: "{}",
      }),
    ).rejects.toThrow(/SECURITY DENY/)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

// ---------- tool variants ----------

describe("edit tool", () => {
  it("parses old_string/new_string args", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await callBefore(hooks, "edit", {
      file_path: path.join(tmpDir, "scripts/util/foo.mjs"),
      old_string: "export const x = 1",
      new_string: "export const x = 2",
    })
    expect(global.fetch.mock.calls.length).toBe(2)
    const log = readLog()
    expect(log[0].kind).toBe("edit")
  })
})

describe("multiedit tool", () => {
  it("parses edits[] array", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    await callBefore(hooks, "multiedit", {
      file_path: path.join(tmpDir, "scripts/util/foo.mjs"),
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    })
    expect(global.fetch.mock.calls.length).toBe(2)
    const log = readLog()
    expect(log[0].kind).toBe("multiedit")
  })
})

describe("patch tool", () => {
  it("extracts target path from unified diff body", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    const body =
      "--- a/scripts/util/foo.mjs\n+++ b/scripts/util/foo.mjs\n@@ -1 +1 @@\n-x\n+y\n"
    await callBefore(hooks, "patch", { input: body })
    expect(global.fetch.mock.calls.length).toBe(2)
    const log = readLog()
    expect(log[0].kind).toBe("patch")
    expect(log[0].path).toContain("scripts/util/foo.mjs")
  })
})
