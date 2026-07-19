---
description: Grill the operator into a reviewable PRD (kata:prd skill)
argument-hint: <topic or rough feature description>
model: sonnet
---

Use the `kata:prd` skill to produce a PRD for:

$ARGUMENTS

Follow the skill exactly: recon the repo first (dispatch `kata-scout`, Haiku, for the mechanical reading), then grill one focused question at a time through the `ask_user` tool — never a question as prose, never `AskUserQuestion` — until every requirement is defensible. Write the finished PRD to a file — a path named above wins; otherwise ask the destination through `ask_user` (default `docs/prds/<YYYY-MM-DD>-<topic>-prd.md` first) — and summarize it in your closing message. Requirements only: no design, no plan, no code, no commit unless asked.
