---
description: Execute a written plan step by step with TDD subagents (kata:implement skill)
argument-hint: <path to the plan file>
model: sonnet
---

Use the `kata:implement` skill to execute the implementation plan at:

$ARGUMENTS

Follow the skill exactly: you are the conductor and edit no source files yourself. Per step, dispatch `kata-implementer` (Sonnet) with the step's full text, verify independently with `kata-test-runner` (Haiku), and review with `kata-reviewer` (Sonnet); after two needs-work rounds on one step, escalate instead of grinding. Blockers go through `ask_user` in an interactive run — in a non-interactive one, stop cleanly and write up where and why. Keep the tree green at every step boundary, stay inside the plan's scope, mark steps done in the plan file, and close with the full gate suite plus an honest report. Commit only if the task and CLAUDE.md's rules say to.
