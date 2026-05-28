// Tests for the deny→present→approve→record loop in guard-config-review.js.
//
// Loop:
//   1. Sensitive write → reviewers DENY
//   2. Plugin throws with full reasons + override instructions
//   3. Violation logged to .opencode/security-violations.log (persistent)
//   4. User runs /approve-config "<rationale>" → creates
//      .opencode/guard-config-review-next-approved with rationale text
//   5. Agent retries SAME write → plugin consumes the bypass file, logs to
//      .opencode/guard-config-review-approvals.log, lets the write through
//   6. Bypass is ONE-SHOT — next sensitive write re-runs the full review

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gcr-deny-"))
  fs.mkdirSync(path.join(tmpDir, ".opencode/logs"), { recursive: true })
  const realRead = fs.readFileSync
  vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
    if (String(p).endsWith("/auth.json")) return JSON.stringify(FAKE_AUTH)
    return realRead.call(fs, p, enc)
  })
  delete process.env.OPENCODE_GUARD_CONFIG_REVIEW
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function mockPanel({ s1_anthropic = [], s1_deepseek = [], s2_anthropic = [], s2_openai = [] } = {}) {
  let a1 = 0, d1 = 0, a2 = 0, o2 = 0
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
      const t = isStage1 ? s1_deepseek[d1++] : null
      if (t == null) return { ok: false }
      return { ok: true, json: async () => ({ choices: [{ message: { content: t } }] }) }
    }
    if (u.includes("api.openai.com")) {
      const t = isStage1 ? null : s2_openai[o2++]
      if (t == null) return { ok: false }
      return { ok: true, json: async () => ({ choices: [{ message: { content: t } }] }) }
    }
    return { ok: false }
  })
}

function readJsonLines(p) {
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
}

const violationsPath = () => path.join(tmpDir, ".opencode/security-violations.log")
const approvalsPath = () => path.join(tmpDir, ".opencode/guard-config-review-approvals.log")
const bypassPath = () => path.join(tmpDir, ".opencode/guard-config-review-next-approved")

describe("deny → violation log", () => {
  it("Stage 2 DENY writes a violation entry", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: looks bad"],
      s1_deepseek: ["FLAG: looks bad"],
      s2_anthropic: ["DENY: removes sudo deny", "DENY: confirms"],
      s2_openai: ["DENY: confirms"],
    })
    const hooks = await getHooks()
    await expect(
      callBefore(hooks, "write", {
        file_path: path.join(tmpDir, "opencode.json"),
        content: '{"permission":{"bash":{"sudo *":"allow"}}}',
      }),
    ).rejects.toThrow(/SECURITY DENY/)

    const violations = readJsonLines(violationsPath())
    expect(violations.length).toBe(1)
    expect(violations[0].reason).toBe("stage2-deny")
    expect(violations[0].path).toContain("opencode.json")
    expect(violations[0].dissenters.length).toBeGreaterThan(0)
    expect(violations[0].diffSha).toBeDefined()
  })

  it("error message includes /approve-config override instructions", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: bad"],
      s1_deepseek: ["FLAG: bad"],
      s2_anthropic: ["DENY: nope", "DENY: nope"],
      s2_openai: ["DENY: nope"],
    })
    const hooks = await getHooks()
    try {
      await callBefore(hooks, "write", {
        file_path: path.join(tmpDir, "opencode.json"),
        content: '{}',
      })
      expect.fail("should have thrown")
    } catch (e) {
      expect(e.message).toMatch(/USER DECISION REQUIRED/)
      expect(e.message).toMatch(/\/approve-config/)
      expect(e.message).toMatch(/security-violations\.log/)
      expect(e.message).toMatch(/DO NOT retry/)
    }
  })

  it("insufficient consensus also logs a violation", async () => {
    mockPanel({
      s1_anthropic: ["FLAG: bad"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["ALLOW: ok", null], // 1 allow + 1 abstain
      s2_openai: [null], // 1 abstain → insufficient
    })
    const hooks = await getHooks()
    await expect(
      callBefore(hooks, "write", {
        file_path: path.join(tmpDir, "scripts/util/foo.mjs"),
        content: "// some",
      }),
    ).rejects.toThrow(/SECURITY DENY/)
    const violations = readJsonLines(violationsPath())
    expect(violations[0].reason).toBe("stage2-insufficient")
  })

  it("no-auth fail-closed also logs a violation", async () => {
    // Mock readFileSync so auth.json fails
    fs.readFileSync.mockRestore()
    const realRead = fs.readFileSync
    vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
      if (String(p).endsWith("/auth.json")) throw new Error("ENOENT")
      // Use the real implementation for everything else (tests need it)
      return realRead.call(fs, p, enc)
    })
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await expect(
      callBefore(hooks, "write", {
        file_path: path.join(tmpDir, "opencode.json"),
        content: "{}",
      }),
    ).rejects.toThrow(/SECURITY DENY/)
    const violations = readJsonLines(violationsPath())
    expect(violations[0].reason).toBe("no-auth")
  })
})

describe("/approve-config bypass — consume + record", () => {
  it("bypass file lets the next sensitive write through with rationale recorded", async () => {
    // First time: full review (panel runs, ALLOW for simplicity)
    mockPanel({ s1_anthropic: ["ALLOW: ok"], s1_deepseek: ["ALLOW: ok"] })
    const hooks = await getHooks()

    // User writes a bypass file with rationale
    fs.writeFileSync(bypassPath(), "I reviewed the diff and this is the deploy script we need")

    // Replace fetch with a vi.fn() that fails — to assert the panel was NOT called
    global.fetch = vi.fn()

    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "opencode.json"),
      content: '{"agent":{}}',
    })

    // Panel was bypassed
    expect(global.fetch).not.toHaveBeenCalled()
    // Bypass file consumed
    expect(fs.existsSync(bypassPath())).toBe(false)
    // Approval logged with rationale
    const approvals = readJsonLines(approvalsPath())
    expect(approvals.length).toBe(1)
    expect(approvals[0].rationale).toContain("deploy script")
    expect(approvals[0].path).toContain("opencode.json")
  })

  it("empty bypass file → records '(no rationale provided)'", async () => {
    fs.writeFileSync(bypassPath(), "")
    global.fetch = vi.fn()
    const hooks = await getHooks()
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "opencode.json"),
      content: '{}',
    })
    const approvals = readJsonLines(approvalsPath())
    expect(approvals[0].rationale).toBe("(no rationale provided)")
  })

  it("bypass is one-shot — second sensitive write re-runs the panel", async () => {
    mockPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
    })
    const hooks = await getHooks()
    fs.writeFileSync(bypassPath(), "rationale 1")

    // First write — bypass consumes
    let fetchCount0 = 0
    global.fetch = vi.fn(async (url, init) => {
      fetchCount0++
      const body = init?.body ? String(init.body) : ""
      const isStage1 = body.includes("Stage 1 of 2")
      if (String(url).includes("api.anthropic.com")) {
        return { ok: true, json: async () => ({ content: [{ text: "ALLOW: ok" }] }) }
      }
      if (String(url).includes("api.deepseek.com")) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ALLOW: ok" } }] }) }
      }
      return { ok: false }
    })

    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "opencode.json"),
      content: '{"a":1}',
    })
    expect(fetchCount0).toBe(0) // bypass consumed, no panel

    // Second write — bypass is gone, panel should run
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "opencode.json"),
      content: '{"b":2}',
    })
    expect(fetchCount0).toBeGreaterThan(0) // panel ran
  })

  it("original violation survives override (independent logs)", async () => {
    // Step 1: DENY happens, violation logged
    mockPanel({
      s1_anthropic: ["FLAG: bad"],
      s1_deepseek: ["FLAG: bad"],
      s2_anthropic: ["DENY: removes deny rule", "DENY: removes deny rule"],
      s2_openai: ["DENY: confirms"],
    })
    let hooks = await getHooks()
    await expect(
      callBefore(hooks, "write", {
        file_path: path.join(tmpDir, "opencode.json"),
        content: '{"permission":{"bash":{"sudo *":"allow"}}}',
      }),
    ).rejects.toThrow(/SECURITY DENY/)
    expect(readJsonLines(violationsPath()).length).toBe(1)

    // Step 2: User overrides. Same path, different content (or same) — either way,
    // we expect the bypass to consume regardless. New plugin instance (fresh session).
    fs.writeFileSync(bypassPath(), "I know this weakens sudo deny, I'm doing it for a test")
    global.fetch = vi.fn()
    hooks = await getHooks()
    await callBefore(hooks, "write", {
      file_path: path.join(tmpDir, "opencode.json"),
      content: '{"permission":{"bash":{"sudo *":"allow"}}}',
    })

    // Violation entry STILL there (didn't get unwritten)
    const violations = readJsonLines(violationsPath())
    expect(violations.length).toBe(1)
    expect(violations[0].reason).toBe("stage2-deny")

    // Approval entry added
    const approvals = readJsonLines(approvalsPath())
    expect(approvals.length).toBe(1)
    expect(approvals[0].rationale).toContain("test")
  })
})
