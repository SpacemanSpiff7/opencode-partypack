# OpenCode Notes

This file is loaded by every opencode agent on every turn. Keep it tight.

## Skills

Skills are available but OFF by default. Only load a skill when I EXPLICITLY ask
for that workflow — never infer one from an unrelated task. For config edits,
bug fixes, and questions, load NO skill.

Intent → skill (TODO: fill in your project's intent mappings here):

- "run the tests" / "build it" → <YOUR-TEST-SKILL>
- "review this" / "do a code review" → <YOUR-REVIEW-SKILL>

## Clarification gates — ALWAYS ask before doing any of these

The user wants large decisions left to them and very few assumptions. STOP and
ask — **batched, all questions in ONE round per phase**, never drip-feed —
whenever the task involves:

- **Architecture / module structure** — new package, layer split, dependency-
  direction change, anything that affects the public surface.
- **Public API** — new public type/method, signature change, renaming anything
  callers depend on.
- **Naming** — new types, files, or renames affecting more than one caller.
- **New dependencies** — package manager, MCP server, plugin, model id — always
  ask, and surface the alternative you considered.
- **Scope creep** — touching files outside the literal task ("while I'm here…")
  → STOP, ask.
- **Deletions with unclear intent** — looks dead but might be wired → confirm,
  never assume.
- **New abstractions** (protocols, generics, base classes, interfaces) — only
  when a SECOND consumer exists TODAY; otherwise ask whether to add now or wait.
- **Multi-file refactors (>3 files)** — present a `/plan` first.
- **Tests that ALTER existing assertions** (vs adding new tests) — ask why the
  assertion is changing.
- **Schema / persistence / migration changes** — always ask.
- **Two+ valid interpretations of the task** — ask once, batched, before
  starting.

Mid-task ambiguity is the same gate: STOP, batch, ask. Don't push through.

## Anti-overengineering — apply to every change

- **Solve only the stated problem.** No adjacent improvements unless I asked.
- **Reuse-first.** Grep the codebase for existing utilities/components/helpers
  BEFORE adding anything new. (TODO: list this project's go-to reuse locations.)
- **No abstractions for "later."** Add a protocol/generic/base class only when a
  second consumer exists TODAY; otherwise it's dead surface.
- **No dead code.** Nothing with zero callers.
- **No new files when an existing file fits.** Co-locate before splitting.
- **Minimum viable change wins.** A "cleaner" rewrite that wasn't asked for is
  overengineering.
- **No future-proofing.** Anticipating needs you haven't been told about is
  overengineering.

If you're unsure whether something is overengineering, ask the literal question:
"Is this required for the stated task?" If no — drop it or ask first.
