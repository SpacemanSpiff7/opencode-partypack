// guard-secrets (GLOBAL opencode plugin): block any bash command that
// references a .env file or the opencode auth store. This is what makes a broad
// `cat`/`grep`/`cp` auto-allow safe — secrets can't be read out via the shell.
//
// Scope: GLOBAL on purpose — secret-blocking is universal (every project
// benefits). The separate out-of-repo confinement is project-scoped via each
// project's `external_directory` rule, so work projects aren't confined here.
//
// Caveat (opencode #5894): tool.execute.before does NOT fire for task-spawned
// subagents, so this covers the PRIMARY agent only. The permission-rule
// `.env` denies (read tool + bash globs) are the subagent backstop. Command
// parsing can't catch every obfuscation (e.g. `cat $(echo .env)`) — this is a
// strong speed bump, not an airtight gate; keeping real secrets out of the repo
// is the actual boundary.

const SECRET_PATTERNS = [
  // a `.env` / `.env.<suffix>` path component (cat .env, ./.env, path/.env, .env.local, < .env)
  /(^|[\s'"=/(`])\.env(\.[A-Za-z0-9_.-]+)?($|[\s'"`);:|&>])/i,
  // the opencode credential store
  /\.local\/share\/opencode/i,
]

function toolName(input, output) {
  return output?.tool ?? input?.tool ?? ""
}
function toolArgs(input, output) {
  return output?.args ?? input?.args ?? {}
}

export default async () => ({
  "tool.execute.before": async (input, output) => {
    if (toolName(input, output) !== "bash") return
    const cmd = String(toolArgs(input, output).command ?? "")
    for (const re of SECRET_PATTERNS) {
      if (re.test(cmd)) {
        throw new Error(
          "Blocked by guard-secrets: command references a secret (.env or the " +
            "opencode auth store). Secrets are out of bounds for agents — read " +
            "configuration from the app's runtime settings, not from files."
        )
      }
    }
  },
})
