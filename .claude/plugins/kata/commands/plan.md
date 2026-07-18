---
description: Write a reviewable TDD implementation plan (kata:plan skill)
argument-hint: <PRD/context-pack path, or the feature to plan>
model: sonnet
---

Use the `kata:plan` skill to produce a written, reviewable TDD implementation plan for:

$ARGUMENTS

Follow the skill exactly: ingest the inputs and the binding CLAUDE.md, verify every file and symbol the plan will reference via `kata-scout` (Haiku), resolve consequential forks through `ask_user` (never prose questions, never `AskUserQuestion`), and write bite-sized steps that each lead with the failing test, name their touched files, and carry exact verify commands and done-criteria. Get the operator's approval through `ask_user` in an interactive run, then write the plan to a file (follow the repo's plan convention, default `docs/plans/<YYYY-MM-DD>-<topic>-plan.md`). Do NOT implement anything in this run; do not commit unless asked.
