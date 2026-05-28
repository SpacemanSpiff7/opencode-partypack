# multiagent-harness-opencode

Universal opencode setup. Plugins install once as global symlinks; new projects
get the matching config + docs with one command.

## One-time install (or on a new machine)

```bash
git clone git@github.com:<you>/multiagent-harness-opencode.git ~/Documents/GitHub/multiagent-harness-opencode
~/Documents/GitHub/multiagent-harness-opencode/setup.sh
```

`setup.sh` symlinks the four universal plugins (`verify-bash`,
`block-inline-scripts`, `trace-log`, `guard-secrets`) into
`~/.config/opencode/plugins/` — opencode picks them up automatically for every
project. After this you never touch plugins per project.

## Scaffolding a new project

```bash
~/Documents/GitHub/multiagent-harness-opencode/init.sh /path/to/new-project --lang swift
```

Without `--lang`, you get the universal base. Available overlays: `swift`,
`ruby`, `ts`.

`init.sh` writes:
- `opencode.json` (base + overlay merged via `jq`)
- `.opencode/INSTRUCTIONS.md` (Clarification gates + Anti-overengineering)
- `.opencode/CHEATSHEET.md` and `.opencode/HARNESS.md` if templates exist
- `.opencode/logs/` (where `trace-log` writes)
- Appends `.opencode/logs/` + verify-bash runtime files to `.gitignore`

Per-project plugins go in `<project>/.opencode/plugins/` (opencode merges those
with the globals). Most projects won't need any.

## Updating

```bash
git -C ~/Documents/GitHub/multiagent-harness-opencode pull
```

Plugins refresh **immediately** in every project (they're symlinks). For
templates (`opencode.json` base, INSTRUCTIONS.md, overlays), re-run:

```bash
~/Documents/GitHub/multiagent-harness-opencode/init.sh /path/to/project --update
```

`--update` refreshes the template files but **never overwrites** `opencode.json`
(your customizations are safe).

## Auth (per machine, not per project)

```bash
opencode auth login
  → Other → provider id: anthropic-personal → personal Anthropic key
  → Other → provider id: openai-api         → OpenAI API key (powers orchestrator-gpt-xtra)
  → Anthropic / OpenAI / Deepseek / OpenCode Zen / OpenCode Go → for built-in providers
```

## What you get

- **Plugins (global)**: `verify-bash` (6-model consensus gate), `guard-secrets`,
  `block-inline-scripts`, `trace-log`.
- **Agents (per project via `init.sh`)**: orchestrator (Opus), orchestrator-gpt
  (GPT-5.4 oauth), orchestrator-gpt-xtra (GPT-5.5-pro API, premium), 5-tier
  build chain (go/fast/sonnet/gpt/opus), explore, sentry, review, review-deep,
  vision.
- **Commands**: `/plan` `/orchestrate` `/quick` `/explore` `/why` `/review`
  `/review-deep` `/escalate` `/clarify` `/scope-check` `/approve` `/commit`
  `/cheatsheet`, plus language overlays (e.g. `/build` `/test` `/lint`
  `/sim-shot` for `--lang swift`).
- **MCPs**: `ast-grep`, `context7`.
- **Permission scaffold**: secure defaults (`.env` denies, sudo deny,
  force-push deny, wrapper-deny, `webfetch` ask, `scripts/**` edit ask, `skill`
  ask, `external_directory` deny).
- **INSTRUCTIONS.md**: Clarification gates + Anti-overengineering rules.

## Layout

```
multiagent-harness-opencode/
├── README.md                   # this file
├── setup.sh                    # one-time: symlink plugins into ~/.config/opencode/plugins/
├── init.sh                     # per project: scaffold config + docs
├── plugins/                    # symlinked into ~/.config/opencode/plugins/
│   ├── verify-bash.js
│   ├── block-inline-scripts.js
│   ├── trace-log.js
│   └── guard-secrets.js
└── templates/
    ├── opencode.base.json
    ├── INSTRUCTIONS.md
    └── overlays/
        ├── swift.json
        ├── ruby.json
        └── ts.json
```
