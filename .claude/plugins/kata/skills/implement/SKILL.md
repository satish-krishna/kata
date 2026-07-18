---
name: implement
description: Use this to execute a written implementation plan inside a Kata run, step by step, with strict TDD via subagents. Dispatches a Sonnet implementer per step, verifies with a Haiku test-runner, reviews with a Sonnet reviewer, and escalates blockers through `ask_user` instead of guessing. Stays inside the plan's scope.
user-invocable: true
---

# Implement (plan execution)

Work a written plan to completion, one step at a time, keeping the tree green
at every boundary. You are the conductor, not the pianist: subagents write the
code and run the suites; you sequence, judge reports, and handle exceptions.

## Interaction contract

A Kata run is headless: a question typed as prose ends the run unanswered.
When a blocker needs the operator — the plan is wrong, a fork appeared it
does not cover, a gate will not go green for a reason outside scope — ask
through the **`ask_user`** tool (never prose, never the built-in
`AskUserQuestion`). If `ask_user` is unavailable (non-interactive run), stop
at the blocker and write up exactly where and why in your report — a clean
stop beats improvising past the plan.

## Model policy

Route every piece of work to the cheapest mind that can do it well:

- **`kata-implementer`** (Sonnet) — writes the code, one plan step per
  dispatch. Implementation is judgment work.
- **`kata-test-runner`** (Haiku) — runs the verify commands and reports
  verbatim. Watching a test suite scroll by is mechanical; never burn driver
  turns on it.
- **`kata-reviewer`** (Sonnet) — reviews a completed step against its text.
  Skepticism is judgment work.
- **You** (Sonnet) — read the plan, brief the subagents, weigh their reports,
  decide what happens next.

## The flow

1. **Read the plan** the task names, end to end, plus the workspace CLAUDE.md
   (binding: commands, TDD rules, commit rules). Extract the repo's exact
   verify commands. Create a task per plan step.
2. **Per step, in order:**
   - Dispatch `kata-implementer` with the step's full text, the plan path,
     and the verify commands. Full text — the subagent has no memory of this
     conversation and cannot fill gaps you leave.
   - On its report, dispatch `kata-test-runner` to run the repo's gates
     independently. The implementer saying "green" is a claim; this is the
     check.
   - Dispatch `kata-reviewer` with the step text and the implementer's
     report. On **needs-work**, send the findings back to a fresh
     `kata-implementer` dispatch; after two failed rounds on the same step,
     stop and escalate (via `ask_user`, or a written blocker) instead of
     grinding.
   - Mark the step done in the plan file (checkbox or status note) so
     progress survives the run.
3. **Blockers.** A step that is wrong, ambiguous, or blocked stops the line —
   escalate per the interaction contract. Do not reinterpret the plan, skip
   steps, or invent scope; report what you found and what you recommend.
4. **Close.** After the last step, run the full gate suite once more through
   `kata-test-runner` (per CLAUDE.md — e.g. fmt check, clippy, build,
   workspace tests). Then report: steps completed, deviations and blockers,
   final gate results, files touched. Commit only if the task and CLAUDE.md's
   rules say to — and never claim green without the runner's output to show.

## Anti-patterns

- **Doing the work in the driver.** The driver edits no source files; steps go
  through `kata-implementer`, or the model policy is dead.
- **Trusting "it passes".** Every green claim gets an independent
  `kata-test-runner` check before the step closes.
- **Grinding a failing step.** Two needs-work rounds, then escalate. The plan
  may be wrong — that is information, not an obstacle to bulldoze.
- **Scope creep.** "While I'm here" refactors, unrequested features, drive-by
  fixes: no. The plan's scope is the run's scope.
- **Ending with a red tree and a shrug.** Either every boundary is green or
  the report says precisely what is red and why.
