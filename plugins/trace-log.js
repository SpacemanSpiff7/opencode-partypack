import path from "node:path"
import fs from "node:fs"

// Observability: append a one-line record per tool call / file edit to
// .opencode/logs/trace.log (gitignored) so an agent run can be audited after
// the fact. Lightweight + best-effort (errors swallowed). Caveat: opencode bug
// #5894 means tool.execute.after misses task-spawned subagent tool calls; the
// file.edited event still captures edits made by subagents.

export default async ({ worktree, directory }) => {
  const root = worktree || directory
  const logDir = path.join(root, ".opencode/logs")
  const logFile = path.join(logDir, "trace.log")

  function append(rec) {
    try {
      fs.mkdirSync(logDir, { recursive: true })
      fs.appendFileSync(
        logFile,
        JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n"
      )
    } catch {
      /* never block the agent loop on logging */
    }
  }

  return {
    "tool.execute.after": async (input, output) => {
      const tool = input?.tool ?? output?.tool ?? ""
      const args = input?.args ?? output?.args ?? {}
      let summary
      if (tool === "bash") summary = String(args.command ?? "").slice(0, 200)
      else if (tool === "edit" || tool === "write") summary = String(args.filePath ?? "")
      append({ tool, summary, agent: input?.agent, sessionID: input?.sessionID })
    },
    event: async ({ event }) => {
      if (event?.type === "file.edited") {
        append({
          event: "file.edited",
          file: event.properties?.file,
          sessionID: event.properties?.sessionID,
        })
      }
    },
  }
}
