# OpenCode notes

Loaded by every opencode agent on every turn. Keep it tight.

## Skills

Skills are available but OFF by default. Load one only when I EXPLICITLY ask
for that workflow — never infer one from an unrelated task. For config edits,
bug fixes, and questions, load NO skill.

Intent → skill (TODO: fill in your project's mappings):

- "<intent>" → `<skill-name>`

## Concurrent sessions: one worktree per agent

Other agents and the user may also be writing to this repo. You are not
guaranteed to be the only editor.

- Before editing, run `git status`. If you see uncommitted changes you
  didn't make, STOP and surface them — another agent may be mid-edit.
  Silent overwrites are the failure mode.
- Commit your work atomically before pausing or yielding. Never leave
  unstaged edits between context switches.
- If you were told you're working in a dedicated worktree, you are
  isolated; otherwise assume shared state and behave accordingly. The
  operator's worktree pattern: `git worktree add ../<repo>-<task> -b <branch> main`.

If you're unsure who owns an in-flight change, ask. Better one round of
clarification than a lost diff.

## Grounding & anti-hallucination — apply to every claim about code

- **Cite before claiming.** Don't assert what a function does, how a flow
  works, or what tests cover — without first reading the code (or running
  `ast-grep find_code`) and quoting `file:line`. "I think it does X" is not
  an answer; "X, per `path/to/file.swift:42`" is.
- **Prefer the ast-grep MCP over raw `read` / `grep` for structural search.**
  `find_code` matches a pattern across the codebase in one call; reading
  whole files burns context and surfaces noise. Specifically:
    ast_grep find_code  --lang swift  --pattern 'func $NAME(...) async ...'
  beats reading 15 files looking for async functions.
- **Verify your gates before saying "done."** "Tests pass" requires actually
  running them and quoting the result, not asserting from intuition.
- **No invented APIs.** If you reach for a SwiftUI / React / library API you
  haven't seen used in this codebase, look it up (Context7 MCP) or read the
  docs link, then cite it. Don't fabricate.
- **No invented file paths.** Before referencing `Path/To/File.ext`, `glob`
  for it or read the directory.
- **When uncertain about behavior, run a single minimal probe** (a test, a
  log statement, an ast-grep query) rather than guessing.

## Clarification gates — ALWAYS ask before doing any of these

Large decisions stay with the user. STOP and ask — **batched, all questions
in ONE round per phase**, never drip-feed — whenever the task involves:

- Architecture / module structure (new package, layer split, dependency-
  direction change, anything that affects the public surface).
- Public API additions / renames (new public type / method, signature
  change, anything callers depend on).
- Naming (new types, files, or renames affecting more than one caller).
- New dependencies (package manager, MCP server, plugin, model id) —
  always, and surface the alternative considered.
- Scope creep — touching files outside the literal task ("while I'm here…")
  → STOP, ask.
- Deletions with unclear intent — looks dead but might be wired → confirm,
  never assume.
- New abstractions (protocols, generics, base classes, interfaces) — only
  when a SECOND consumer exists TODAY; otherwise ask whether to add now
  or wait.
- Multi-file refactors (>3 files) — present a `/plan` first.
- Tests that ALTER existing assertions (vs adding new tests) — ask why
  the assertion is changing.
- Schema / persistence / migration changes — always ask.
- Two+ valid interpretations of the task — ask once, batched, before
  starting.

Mid-task ambiguity is the same gate: STOP, batch, ask. Don't push through.

## Anti-overengineering — apply to every change

- **Solve only the stated problem.** No adjacent improvements unless I asked.
- **Reuse-first.** Grep this project's go-to reuse locations BEFORE adding
  anything new. (TODO: list them — `src/components/`, `lib/utils/`, etc.)
- **No abstractions for "later."** Add a protocol/generic/base class only
  when a second consumer exists TODAY; otherwise it's dead surface.
- **No dead code.** Nothing with zero callers.
- **No new files when an existing file fits.** Co-locate before splitting.
- **Minimum viable change wins.** A "cleaner" rewrite that wasn't asked
  for is overengineering.
- **No future-proofing.** Anticipating needs you haven't been told about
  is overengineering.

If you're unsure whether something is overengineering, ask the literal
question: "Is this required for the stated task?" If no — drop it or
ask first.
