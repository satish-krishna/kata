---
name: plan
description: Use this to turn a PRD, spec, or context pack into a written, reviewable TDD implementation plan inside a Kata run. Produces ordered bite-sized steps — each naming its failing test first, the files it touches, and its done-criteria — gets the operator's approval through `ask_user`, and writes the plan to a file. No implementation in this run.
user-invocable: true
---

# Plan (TDD)

Turn a spec into a plan a fresh session could execute without you: ordered, bite-sized steps, each one test-first and independently verifiable. The plan file is the deliverable — do NOT implement anything in this run.

## The one rule that changes everything

**`ask_user` is your only mouth. A question you write as prose never reaches the operator.** A Kata run drives `claude -p` headlessly; end a turn with a plain-text question and the run ends, unanswered. Everywhere this skill says "ask" or "get approval", call the `ask_user` tool. Never use the built-in `AskUserQuestion`; it is disabled in Kata runs. Prefer `select`/`confirm` with your recommendation first; one focused question per call. If `ask_user` is unavailable (non-interactive run), take the conservative fork, record it in the plan under **Assumptions**, and skip the approval gate rather than stall.

## Model policy

You (the driver) run on Sonnet and do the sequencing and design judgment. Dispatch mechanical verification to the plugin's **`kata-scout`** subagent (pinned to Haiku): confirming every file, symbol, and command the plan will name actually exists as you believe. A plan that references phantom files dies on step one.

## The flow

Create a task per step and work them in order:

1. **Ingest.** Read the inputs the task names — PRD (`kata:prd` output), context pack (`kata:context` output), or a raw description — plus the workspace CLAUDE.md, which is binding (its TDD rules, commands, and conventions shape every step).
2. **Verify the ground.** Dispatch `kata-scout` to confirm the files, symbols, and commands the plan will reference exist and say what you think they say. Fix your mental model before writing steps on top of it.
3. **Resolve forks.** Where the spec leaves a consequential choice open, ask through `ask_user` — recommendation first. Never guess past a real fork; never bother the operator with one the spec already settles.
4. **Write the steps.** Each step carries:
   - **Goal** — the one behavior it adds, in a sentence;
   - **Test first** — the failing test to write: file, name, and what it asserts (per the repo's TDD rule, this leads every step);
   - **Touches** — the files changed, with a phrase on how;
   - **Sketch** — the minimal implementation shape (not code);
   - **Verify** — the exact commands that must pass;
   - **Done when** — observable criteria, no judgment calls.

   Steps are bite-sized (one sitting each), ordered by dependency, and leave the tree green at every boundary. Then a closing section: **Risks, dependencies & open questions**.
5. **Approval gate.** Present the step list and key choices through `ask_user` (`select`: approve / amend, approve first). On amend, revise and re-present. Unless the task already names the plan's path, ask the destination in the same call — a `select` leading with the repo's plan convention if one exists (e.g. `docs/superpowers/plans/` here), then the default `docs/plans/<YYYY-MM-DD>-<topic>-plan.md`, then an "elsewhere" option whose answer is a custom path.
6. **Deliver — to a file.** Write the plan to the resolved destination (task-named path first; in a non-interactive run, the repo convention or the default). Summarize in your closing message. Do not commit unless the task says to.

## Anti-patterns

- **Implementing "just the easy step".** The deliverable is the plan. Zero implementation code in this run.
- **Steps that only make sense to you.** The executor is a fresh session with no memory of this conversation. Every step self-contained.
- **Test-after steps.** "Implement X, then add tests" violates the contract. The failing test is named first, in every step.
- **Phantom references.** Naming a file or helper you never verified exists. That is what `kata-scout` is for.
- **Skipping the approval gate in an interactive run.** An unapproved plan is a draft; get the operator's yes through `ask_user`.
