// Additional tests for verify-bash.js — script whitelist consumption.
// Companion to the existing tests/verify-bash.test.mjs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-wl-"))
  fs.mkdirSync(path.join(tmpDir, ".opencode/logs"), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, "scripts/util"), { recursive: true })
  const realRead = fs.readFileSync
  vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
    if (String(p).endsWith("/auth.json")) return JSON.stringify(FAKE_AUTH)
    return realRead.call(fs, p, enc)
  })
  delete process.env.OPENCODE_VERIFY_BASH
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeScript(rel, content) {
  const abs = path.join(tmpDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

function writeWhitelist(map) {
  const wlPath = path.join(tmpDir, ".opencode/guard-config-review.whitelist.json")
  fs.writeFileSync(wlPath, JSON.stringify(map))
}

function sha(content) {
  return crypto.createHash("sha256").update(content).digest("hex")
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

describe("verify-bash — script whitelist consumption", () => {
  it("ALLOWS `node scripts/util/foo.mjs` when whitelist sha matches", async () => {
    const content = "console.log('hi')\n"
    const abs = writeScript("scripts/util/foo.mjs", content)
    writeWhitelist({ [abs]: { sha256: sha(content), approvedAt: new Date().toISOString(), stage: "stage1-pass" } })

    global.fetch = vi.fn()
    const hooks = await getHooks()
    await expect(callBefore(hooks, "node scripts/util/foo.mjs")).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()

    const log = readLog()
    expect(log[0].verdict).toBe("ALLOW")
    expect(log[0].reason).toBe("whitelisted-script")
    expect(log[0].scriptPath).toBe(abs)
  })

  it("ALLOWS `bash scripts/util/deploy.sh` form", async () => {
    const content = "#!/usr/bin/env bash\necho hi\n"
    const abs = writeScript("scripts/util/deploy.sh", content)
    writeWhitelist({ [abs]: { sha256: sha(content), approvedAt: new Date().toISOString(), stage: "stage2-pass" } })

    global.fetch = vi.fn()
    const hooks = await getHooks()
    await expect(callBefore(hooks, "bash scripts/util/deploy.sh")).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("ALLOWS bare invocation `./scripts/util/run.mjs`", async () => {
    const content = "#!/usr/bin/env node\nconsole.log(1)\n"
    const abs = writeScript("scripts/util/run.mjs", content)
    writeWhitelist({ [abs]: { sha256: sha(content), approvedAt: new Date().toISOString(), stage: "stage1-pass" } })

    global.fetch = vi.fn()
    const hooks = await getHooks()
    await expect(callBefore(hooks, "./scripts/util/run.mjs")).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("logs whitelist-stale + falls through when content modified", async () => {
    const orig = "// original\n"
    const modified = "// MODIFIED — different content\n"
    const abs = writeScript("scripts/util/foo.mjs", modified)
    writeWhitelist({ [abs]: { sha256: sha(orig), approvedAt: new Date().toISOString(), stage: "stage1-pass" } })

    // Mock the consensus panel as unanimous ALLOW so the fall-through completes.
    global.fetch = vi.fn(async (url) => {
      const u = String(url)
      const text = "ALLOW: ok"
      if (u.includes("api.openai.com"))
        return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
      if (u.includes("api.anthropic.com"))
        return { ok: true, json: async () => ({ content: [{ text }] }) }
      if (u.includes("api.deepseek.com"))
        return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
      return { ok: false }
    })

    const hooks = await getHooks()
    await callBefore(hooks, "node scripts/util/foo.mjs")
    // panel was consulted (whitelist stale)
    expect(global.fetch.mock.calls.length).toBeGreaterThan(0)

    const log = readLog()
    expect(log[0].reason).toBe("whitelist-stale")
    expect(log[0].scriptPath).toBe(abs)
    expect(log[log.length - 1].verdict).toBe("ALLOW")
    expect(log[log.length - 1].reason).toBe("consensus-allow")
  })

  it("no whitelist file → normal classification", async () => {
    // No whitelist written. Command unrelated to scripts.
    global.fetch = vi.fn(async (url) => {
      const u = String(url)
      const text = "ALLOW: ok"
      if (u.includes("api.openai.com"))
        return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
      if (u.includes("api.anthropic.com"))
        return { ok: true, json: async () => ({ content: [{ text }] }) }
      if (u.includes("api.deepseek.com"))
        return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
      return { ok: false }
    })
    const hooks = await getHooks()
    await callBefore(hooks, "ls Packages/")
    // Whitelist is absent — panel handles via normal flow (some calls happened).
    expect(global.fetch).toHaveBeenCalled()
  })

  it("command doesn't reference any whitelisted script → no early ALLOW", async () => {
    // Whitelist has an entry, but the proposed command targets something else.
    const content = "// some\n"
    const abs = writeScript("scripts/util/foo.mjs", content)
    writeWhitelist({ [abs]: { sha256: sha(content), approvedAt: new Date().toISOString(), stage: "stage1-pass" } })

    let calls = 0
    global.fetch = vi.fn(async (url) => {
      calls++
      const u = String(url)
      const text = "ALLOW: ok"
      if (u.includes("api.openai.com"))
        return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
      if (u.includes("api.anthropic.com"))
        return { ok: true, json: async () => ({ content: [{ text }] }) }
      if (u.includes("api.deepseek.com"))
        return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
      return { ok: false }
    })
    const hooks = await getHooks()
    await callBefore(hooks, "ls Packages/")
    expect(calls).toBeGreaterThan(0)
  })

  it("whitelist entry for a script that no longer exists → fall through (no crash)", async () => {
    const ghost = path.join(tmpDir, "scripts/util/ghost.mjs")
    writeWhitelist({ [ghost]: { sha256: "deadbeef", approvedAt: new Date().toISOString(), stage: "stage1-pass" } })

    global.fetch = vi.fn(async (url) => {
      const u = String(url)
      const text = "ALLOW: ok"
      if (u.includes("api.openai.com"))
        return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
      if (u.includes("api.anthropic.com"))
        return { ok: true, json: async () => ({ content: [{ text }] }) }
      if (u.includes("api.deepseek.com"))
        return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }
      return { ok: false }
    })
    const hooks = await getHooks()
    // Don't expect an early ALLOW — script doesn't exist, falls through.
    await callBefore(hooks, "node scripts/util/ghost.mjs")
    expect(global.fetch.mock.calls.length).toBeGreaterThan(0) // panel ran
  })
})
