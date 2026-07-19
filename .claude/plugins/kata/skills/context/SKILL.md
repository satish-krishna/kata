---
name: context
description: Use this to build a context pack — the curated dossier of everything an implementer must know before touching a feature area — inside a Kata run. Fans out Haiku scout subagents across the codebase (layout, conventions, touched subsystems, tests, prior art), then synthesizes one context document to a file. Read-only; changes nothing.
user-invocable: true
---

# Context pack

Assemble everything a planner or implementer must know before touching a feature area, into one document. This is reconnaissance, not opinion: the pack maps what exists so later runs (`kata:plan`, `kata:implement`) start warm instead of rediscovering the codebase. Strictly read-only — the only file you create is the pack itself.

## Interaction contract

A Kata run is headless: a question typed as prose ends the run unanswered. If the target is genuinely ambiguous (which feature? which of two same-named modules?), ask through the **`ask_user`** tool — never prose, never the built-in `AskUserQuestion`. This skill should rarely need more than one question; if `ask_user` is unavailable (non-interactive run), record the ambiguity under **Open questions** and cover the plausible readings instead of stalling.

## Model policy

Scouting is mechanical; synthesis is not. Fan the reading out to the plugin's **`kata-scout`** subagent (pinned to Haiku) — several in parallel, one brief each. You (the driver, Sonnet) read only the handful of files the scouts flag as load-bearing, and do the judgment work: what matters, what connects to what, what is risky.

## The flow

Create a task per step and work them in order:

1. **Fix the target.** From the task (a PRD path, an issue, a description), state in one sentence what the pack is *for*. One `ask_user` question only if genuinely ambiguous.
2. **Fan out scouts.** Dispatch `kata-scout` agents in parallel, one brief each, covering: repo layout and entry points; binding conventions and exact commands (CLAUDE.md, CI config, READMEs); the subsystems the target touches (files, key types, public contracts); how those areas are tested (harnesses, fixtures, existing tests to imitate); and prior art (similar features, recent git history in those areas).
3. **Read what matters.** From the scout digests, read the few genuinely load-bearing files yourself. Verify any contract you are about to assert — quote real signatures and paths, never from memory.
4. **Synthesize the pack**, with every claim carrying a `path:line` reference:
   - **Target** — what this pack prepares for, in one paragraph;
   - **Ground rules** — binding conventions and the exact build/test/lint commands, quoted;
   - **Map** — the relevant files and what role each plays;
   - **Contracts** — the key types, functions, schemas, and invariants the work must respect;
   - **Prior art** — the closest existing thing to imitate, and where;
   - **Integration points** — where new work plugs in, and what it must not break;
   - **Risks & unknowns** — sharp edges, drift, surprises;
   - **Open questions** — what only the operator can answer.
5. **Deliver — to a file.** Resolve the destination in order: a path the task names wins; otherwise, in an interactive run, ask where to write through `ask_user` (a `select` leading with the default `docs/context/<YYYY-MM-DD>-<topic>-context.md`, plus an "elsewhere" option whose answer is a custom path); otherwise take the default. Summarize in your closing message. Do not commit unless the task says to.

## Anti-patterns

- **Touring instead of targeting.** The pack serves one declared target; a general codebase tour helps nobody.
- **Driver-as-scout.** Reading fifty files on Sonnet is burning judgment tokens on Haiku work. Fan out.
- **Uncited claims.** A "contract" without a `path:line` is a rumor.
- **Editorializing.** "This code is messy" is not context. What it does, where, and what must not break — that is context.
- **Stalling on ambiguity in a non-interactive run.** Record it as an open question and keep moving.
