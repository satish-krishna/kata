---
description: Triage a bug to root cause and a written report (kata:triage skill)
argument-hint: <bug report, issue text, or path to it>
model: sonnet
---

Use the `kata:triage` skill to triage:

$ARGUMENTS

Follow the skill exactly: restate expected vs actual, reproduce through `kata-test-runner` (Haiku), dig evidence through `kata-scout` (Haiku), then localize the root cause yourself to `path:line` with a mechanism — the crash site is rarely the bug. Ask through `ask_user` only for what the repo cannot tell you. Write the triage report to a file (default `docs/triage/<YYYY-MM-DD>-<slug>-triage.md`) ending with the failing test a fix should start from. Diagnosis only — no fixing in this run unless the task explicitly says otherwise; do not commit unless asked.
