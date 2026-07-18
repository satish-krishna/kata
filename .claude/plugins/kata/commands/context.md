---
description: Build a context pack for a feature area (kata:context skill)
argument-hint: <feature, PRD path, or area to map>
model: sonnet
---

Use the `kata:context` skill to build a context pack for:

$ARGUMENTS

Follow the skill exactly: fan the mechanical reading out to parallel
`kata-scout` subagents (Haiku) — layout, conventions and exact commands,
touched subsystems, tests, prior art — then synthesize the pack yourself with
a `path:line` reference on every claim. Ask through `ask_user` only if the
target is genuinely ambiguous; in a non-interactive run record open questions
instead of stalling. Strictly read-only: the only file you create is the pack
(default `docs/context/<YYYY-MM-DD>-<topic>-context.md`). Do not commit unless
asked.
