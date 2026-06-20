---
name: kata-brainstorming
description: Use this to explore intent and design before any implementation inside a Kata run — the print-mode-safe replacement for superpowers:brainstorming. Turns an idea into a crisp problem statement, distinct approaches with trade-offs, and a single recommended direction, conducting every clarifying question and approval through the `ask_user` tool so the operator actually sees it.
user-invocable: true
---

# Kata Brainstorming

Turn an idea into a fully-formed design through collaborative dialogue — *inside a Kata run*. The thinking is the deliverable; do NOT write or modify implementation code here.

This is the Kata-native variant of `superpowers:brainstorming`. The method is the same; the **interaction contract is different**, because a Kata run is not an interactive chat.

## The one rule that changes everything

**`ask_user` is your only mouth. A question you write as prose never reaches the operator.**

A Kata run drives `claude -p` to completion. No human is reading your messages turn by turn. When you end a turn with a question typed as plain text, the run simply *ends* with that question unanswered — exactly the failure this skill exists to prevent. The `ask_user` tool is the only channel that reaches the operator: it pauses the run, shows your question, and blocks until they answer, handing the answer back to you *in the same turn* so you continue seamlessly.

So everywhere the brainstorming method says "ask the user", "ask one question at a time", "present options", "get approval", or "wait for approval" — you carry that out by **calling `ask_user`**, never by emitting prose and stopping.

Do NOT use any built-in question or prompt tool (e.g. `AskUserQuestion`); it is disabled in Kata runs and does not reach the operator. There is no browser/visual companion in a Kata run — keep everything in `ask_user`.

## How to ask

Call `ask_user` with a `questions` array. Each question:

- `kind` — `"confirm"` (yes/no), `"select"` (pick from `options`), or `"text"` (free-form). Choose the one that fits.
- `header` — a short label (a few words).
- `question` — the full, crisp question.
- `options` — for `select`: a list of `{ label, description }`. Lead with your recommended option.
- `multi_select` — `true` if more than one option may be chosen.
- `optional` — `true` if a blank answer is acceptable.
- `placeholder` — a hint for `text` questions.

Prefer one focused question per call so the dialogue stays a dialogue; batch only genuinely-related questions into a single call. Always prefer `select`/`confirm` over open `text` when the choices are knowable — it is faster for the operator and sharper for you. Read each answer before forming the next question.

## The flow

You MUST create a task per step and complete them in order:

1. **Explore context** — read the relevant files, docs, and recent commits before asking anything. Don't spend a question on something the repo already answers. If the request bundles several independent subsystems, surface that first (via `ask_user`) and help decompose before refining details.
2. **Clarify intent** — through `ask_user`, one focused question at a time: purpose, constraints, success criteria, the consequential forks you cannot resolve yourself. Keep going until the ambiguity that matters is gone. Never guess past a real fork.
3. **Explore approaches** — produce 2–4 genuinely distinct approaches with honest trade-offs.
4. **Recommend and confirm** — present your single recommended direction with its rationale as a `select`/`confirm` `ask_user` call (recommended option first). Let the operator pick, redirect, or amend. If they change direction, loop back.
5. **Deliver the thinking — to a file.** Once the direction is confirmed, the deliverable is a design doc: a crisp problem statement; the key constraints, assumptions, and unknowns; the distinct approaches with trade-offs; and the recommended direction with rationale. **Write it to a file by default** — a run's final message is not a durable artifact, and the operator expects to find the spec on disk afterward. Use the path the task specifies, or the repo convention `docs/superpowers/specs/<YYYY-MM-DD>-<topic>-design.md` (match the existing files' format if the dir exists). Then also summarize it in your closing message. Do not commit unless the task asks you to — leave the file for the operator to review.

A design doc IS "the thinking," not implementation code, so a task that says "produce the thinking, not the code" or "do not write code" still wants this file — it forbids *implementation* code, not the spec. Implementation is a *separate* kata. Do not start it here.

## Anti-patterns

- **Asking in prose and stopping.** The run ends; the operator sees nothing. Always `ask_user`.
- **"This is too simple to need a design."** Every project goes through the process; the design can be short, but present it (via `ask_user`) and get approval.
- **Dumping every question at once.** Brainstorming is a dialogue. One focused question (or a tight related batch) per `ask_user` call.
- **Open-ended questions when options are knowable.** Use `select`/`confirm` and lead with your recommendation.
- **Delivering the design only in the closing message.** The run ends and the artifact is gone. Write the design doc to a file (step 5), then summarize.
- **Writing implementation code.** Out of scope — the deliverable is the thinking (a design doc on disk), not production code.

## Key principles

- One focused question at a time, always through `ask_user`.
- Multiple choice preferred; lead with your recommended option and say why.
- YAGNI ruthlessly — cut unnecessary features from every design.
- Always offer 2–4 distinct approaches before settling.
- Incremental validation — confirm the direction before producing the final design.
- Be flexible — loop back when an answer changes the picture.
