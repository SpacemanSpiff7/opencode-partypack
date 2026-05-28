// Security hardening tests — exercise the attack vectors surfaced in the
// 2026-05-28 test-coverage audit. Items numbered from the audit:
//
//   1. Obfuscation patterns documented in sentry but never asserted in tests
//   3. Path traversal: file_path: "scripts/../opencode.json" → resolves to sensitive
//   4. Whitelist file tampering — agent edits .opencode/guard-config-review.whitelist.json
//   5. Cache poisoning — pre-populated cache.json with fake ALLOWs
//   7. Malformed auth.json — non-JSON content
//   8. Disk-full / readonly fs — log/cache write failures
//
// All mock-based, no real network, no real fs writes outside tmpDir.

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

async function loadGcr() {
  const mod = await import(path.resolve("plugins/guard-config-review.js") + "?t=" + Date.now())
  return mod.default
}
async function loadVb() {
  const mod = await import(path.resolve("plugins/verify-bash.js") + "?t=" + Date.now())
  return mod.default
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harden-"))
  fs.mkdirSync(path.join(tmpDir, ".opencode/logs"), { recursive: true })
  const realRead = fs.readFileSync
  vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
    if (String(p).endsWith("/auth.json")) return JSON.stringify(FAKE_AUTH)
    return realRead.call(fs, p, enc)
  })
  delete process.env.OPENCODE_GUARD_CONFIG_REVIEW
  delete process.env.OPENCODE_VERIFY_BASH
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function mockGcrPanel({
  s1_anthropic = [],
  s1_deepseek = [],
  s2_anthropic = [],
  s2_openai = [],
} = {}) {
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

function readLog(name) {
  const p = path.join(tmpDir, ".opencode/logs", name)
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

// =========================================================================
// ITEM 1 — Sentry prompt regression: the documented HARD DENY list MUST stay
// in the prompt verbatim. If someone edits the sentry and accidentally drops
// a pattern, models silently start allowing it. This test catches the drop.
// =========================================================================

describe("sentry prompt regression — documented dangerous patterns must stay", () => {
  it("verify-bash sentry contains all documented HARD DENY categories", async () => {
    const src = fs.readFileSync(path.resolve("plugins/verify-bash.js"), "utf8")
    const required = [
      ".env",
      "~/.local/share/opencode",
      "~/.ssh",
      "~/.aws/credentials",
      "sudo",
      "doas",
      "bash -c",
      "sh -c",
      "zsh -c",
      "eval",
      "base64 -d | sh",
      "$(echo .env)",
      "curl ... | sh",
      "rm -rf",
      "rm -fr",
      "find ... -delete",
      "find ... -exec rm",
      "xargs rm",
      "dd",
      "shred",
      "mkfs",
      "chmod -R",
      "chown -R",
      "git push --force",
      "git push -f",
      "git filter-branch",
      "git reset --hard",
      "git branch -D",
      "--no-verify",
      "--dangerously-skip-permissions",
      "defaults write",
      "launchctl load",
      "nohup",
      "disown",
    ]
    for (const pat of required) {
      expect(src.toLowerCase(), `sentry must mention "${pat}"`).toContain(pat.toLowerCase())
    }
  })

  it("guard-config-review sentry covers secrets, weakened deny, supply-chain, capabilities", async () => {
    const src = fs.readFileSync(path.resolve("plugins/guard-config-review.js"), "utf8")
    const required = [
      "WEAKENED SAFETY RULES",
      "MALICIOUS CODE INJECTION",
      "AGENT INJECTION",
      "SUPPLY-CHAIN SMUGGLING",
      "CI / RELEASE SURFACE",
      "egress",
      "process.env",
      "postinstall",
      "preinstall",
      "entitlement",
    ]
    for (const pat of required) {
      expect(src.toLowerCase(), `sentry must mention "${pat}"`).toContain(pat.toLowerCase())
    }
  })
})

// =========================================================================
// ITEM 3 — Path traversal: a write to "scripts/../opencode.json" must be
// recognized as a write to opencode.json (sensitive). The plugin uses
// path.join which normalizes traversal.
// =========================================================================

describe("path traversal resolution", () => {
  it("guard-config-review: scripts/../opencode.json resolves to opencode.json (sensitive)", async () => {
    mockGcrPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
    })
    const gcr = await loadGcr()
    const hooks = await gcr({ worktree: tmpDir, directory: tmpDir })
    // Path with traversal that resolves into a sensitive file
    await hooks["tool.execute.before"](
      { tool: "write", args: { file_path: "scripts/../opencode.json", content: "{}" } },
      {},
    )
    // Panel was called → path was treated as sensitive
    expect(global.fetch.mock.calls.length).toBeGreaterThan(0)
  })

  it("guard-config-review: out-of-repo absolute path bypasses (opencode permission handles it)", async () => {
    global.fetch = vi.fn()
    const gcr = await loadGcr()
    const hooks = await gcr({ worktree: tmpDir, directory: tmpDir })
    // /etc/passwd is not on any sensitive glob (the gate covers REPO-INTERNAL
    // sensitive paths; opencode's permission engine + guard-secrets cover
    // out-of-repo). Confirm the gate doesn't claim authority it doesn't have.
    await hooks["tool.execute.before"](
      { tool: "write", args: { file_path: "/etc/passwd", content: "test" } },
      {},
    )
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

// =========================================================================
// ITEM 4 — Whitelist file tampering: an agent writing
// .opencode/guard-config-review.whitelist.json bypasses content review and
// could insert sha256 hashes for any script. MUST trigger sensitive review.
// =========================================================================

describe("plugin state file tampering", () => {
  it("write to whitelist.json triggers sensitive review (always-frontier)", async () => {
    mockGcrPanel({
      s1_anthropic: ["ALLOW: ok"], // shouldn't matter — always-frontier
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["DENY: tampering with the gate's state file", "DENY: same"],
      s2_openai: ["DENY: same"],
    })
    const gcr = await loadGcr()
    const hooks = await gcr({ worktree: tmpDir, directory: tmpDir })
    await expect(
      hooks["tool.execute.before"](
        {
          tool: "write",
          args: {
            file_path: ".opencode/guard-config-review.whitelist.json",
            content: '{"/some/script.mjs":{"sha256":"deadbeef"}}',
          },
        },
        {},
      ),
    ).rejects.toThrow(/SECURITY DENY/)
  })

  it("write to cache.json triggers sensitive review (always-frontier)", async () => {
    mockGcrPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["DENY: cache tampering", "DENY: cache tampering"],
      s2_openai: ["DENY: same"],
    })
    const gcr = await loadGcr()
    const hooks = await gcr({ worktree: tmpDir, directory: tmpDir })
    await expect(
      hooks["tool.execute.before"](
        {
          tool: "write",
          args: {
            file_path: ".opencode/guard-config-review.cache.json",
            content: '{"poisoned":{"verdict":"ALLOW","ts":0}}',
          },
        },
        {},
      ),
    ).rejects.toThrow(/SECURITY DENY/)
  })

  it("write to security-violations.log triggers sensitive review", async () => {
    mockGcrPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["ALLOW: ok", "ALLOW: ok"],
      s2_openai: ["ALLOW: ok"],
    })
    const gcr = await loadGcr()
    const hooks = await gcr({ worktree: tmpDir, directory: tmpDir })
    await hooks["tool.execute.before"](
      {
        tool: "write",
        args: { file_path: ".opencode/security-violations.log", content: "" },
      },
      {},
    )
    // Panel WAS called → path was recognized as sensitive (Stage 2 ran since
    // the file is on always-frontier list)
    expect(global.fetch.mock.calls.length).toBeGreaterThan(2) // 2 stage1 + ≥1 stage2
  })
})

// =========================================================================
// ITEM 5 — Cache poisoning: the cache file is now at .opencode/cache.json
// (out of the ephemeral .opencode/logs/ path). An agent attempting to write
// it via the write tool is caught by item 4. Via bash is caught by sentry.
// This test asserts the cache file isn't on the ephemeral bypass.
// =========================================================================

describe("cache file location is NOT ephemeral", () => {
  it("write to .opencode/guard-config-review.cache.json is reviewed (not bypassed)", async () => {
    // Old path was .opencode/logs/* which IS ephemeral. Verify the new path
    // doesn't share that bypass.
    mockGcrPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
      s2_anthropic: ["DENY: cache poisoning attempt", "DENY: same"],
      s2_openai: ["DENY: same"],
    })
    const gcr = await loadGcr()
    const hooks = await gcr({ worktree: tmpDir, directory: tmpDir })
    await expect(
      hooks["tool.execute.before"](
        {
          tool: "write",
          args: {
            file_path: ".opencode/guard-config-review.cache.json",
            content: '{}',
          },
        },
        {},
      ),
    ).rejects.toThrow(/SECURITY DENY/)
  })
})

// =========================================================================
// ITEM 7 — Malformed auth.json: non-JSON content. loadAuth catches and
// returns null. Sensitive write should fail-closed.
// =========================================================================

describe("malformed auth.json", () => {
  it("non-JSON auth.json → fail-closed on sensitive write", async () => {
    fs.readFileSync.mockRestore()
    const realRead = fs.readFileSync
    vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
      if (String(p).endsWith("/auth.json")) return "{ this is not valid json"
      return realRead.call(fs, p, enc)
    })
    global.fetch = vi.fn()
    const gcr = await loadGcr()
    const hooks = await gcr({ worktree: tmpDir, directory: tmpDir })
    await expect(
      hooks["tool.execute.before"](
        { tool: "write", args: { file_path: "opencode.json", content: "{}" } },
        {},
      ),
    ).rejects.toThrow(/SECURITY DENY/)
    // No fetch attempted — failed before the panel call
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("empty auth.json → fail-closed on sensitive write", async () => {
    fs.readFileSync.mockRestore()
    const realRead = fs.readFileSync
    vi.spyOn(fs, "readFileSync").mockImplementation((p, enc) => {
      if (String(p).endsWith("/auth.json")) return ""
      return realRead.call(fs, p, enc)
    })
    global.fetch = vi.fn()
    const gcr = await loadGcr()
    const hooks = await gcr({ worktree: tmpDir, directory: tmpDir })
    await expect(
      hooks["tool.execute.before"](
        { tool: "write", args: { file_path: "opencode.json", content: "{}" } },
        {},
      ),
    ).rejects.toThrow(/SECURITY DENY/)
  })
})

// =========================================================================
// ITEM 8 — Disk-full / readonly fs: all the plugin's own log + cache writes
// MUST be wrapped in try/catch so a disk-full state doesn't propagate an
// exception up and make the agent appear stuck.
// =========================================================================

describe("logging robustness — fs write failures don't propagate", () => {
  it("guard-config-review still completes when log write throws", async () => {
    mockGcrPanel({
      s1_anthropic: ["ALLOW: ok"],
      s1_deepseek: ["ALLOW: ok"],
    })
    // Make appendFileSync throw to simulate disk full
    const realAppend = fs.appendFileSync
    vi.spyOn(fs, "appendFileSync").mockImplementation((p, ...rest) => {
      if (String(p).includes(".opencode/")) throw new Error("ENOSPC")
      return realAppend(p, ...rest)
    })
    const gcr = await loadGcr()
    const hooks = await gcr({ worktree: tmpDir, directory: tmpDir })
    // Should complete normally despite log failure
    await expect(
      hooks["tool.execute.before"](
        {
          tool: "write",
          args: { file_path: path.join(tmpDir, "scripts/util/x.mjs"), content: "ok" },
        },
        {},
      ),
    ).resolves.toBeUndefined()
  })

  it("verify-bash still completes when log write throws", async () => {
    // verify-bash's safe-pattern returns immediately after logging.
    // If logDecision propagated, this would throw.
    const realAppend = fs.appendFileSync
    vi.spyOn(fs, "appendFileSync").mockImplementation((p, ...rest) => {
      if (String(p).includes(".opencode/")) throw new Error("ENOSPC")
      return realAppend(p, ...rest)
    })
    global.fetch = vi.fn()
    const vb = await loadVb()
    const hooks = await vb({ worktree: tmpDir, directory: tmpDir })
    await expect(
      hooks["tool.execute.before"]({ tool: "bash", args: { command: "pwd" } }, {}),
    ).resolves.toBeUndefined()
  })
})
