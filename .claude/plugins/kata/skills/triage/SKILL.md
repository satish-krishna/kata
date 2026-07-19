---
name: triage
description: Use this to triage a bug report or issue inside a Kata run — reproduce it, localize the root cause to file:line, size the blast radius, classify severity, and write a triage report that a fix run can start from. Haiku subagents do the mechanical reproduction and evidence-digging; the diagnosis is yours. Diagnosis only — fixes happen in a later run unless the task explicitly says otherwise.
user-invocable: true
---

# Triage

Turn a raw bug report into a diagnosis someone can act on: reproduced (or provably not), localized to code, sized, and classified. The triage report is the deliverable. Do NOT fix the bug in this run unless the task explicitly asks — a good report makes the fix a mechanical follow-up (`kata:plan` → `kata:implement`).

## Interaction contract

A Kata run is headless: a question typed as prose ends the run unanswered. When the report is missing something you genuinely cannot recover from the repo — the observed-vs-expected behavior, the environment, the triggering input — ask through the **`ask_user`** tool (never prose, never the built-in `AskUserQuestion`). Prefer `select`/`confirm` with your best guess first; one focused question per call. If `ask_user` is unavailable (non-interactive run), proceed on the most plausible reading, and mark the report's confidence accordingly.

## Model policy

Evidence-gathering is mechanical; diagnosis is not.

- **`kata-test-runner`** (Haiku) — runs reproduction attempts and existing test suites, reports output verbatim.
- **`kata-scout`** (Haiku) — digs evidence: recent git history in the suspect areas, related code paths, similar past fixes, where the failing symbol lives.
- **You** (Sonnet) — read what they surface, form and test hypotheses, and commit to a root cause with a mechanism, not a vibe.

## The flow

Create a task per step and work them in order:

1. **Restate the report.** Expected behavior, actual behavior, impact — in your own words, from the task and anything it links. Ask (per the contract) only for what you cannot recover yourself.
2. **Reproduce.** Derive the tightest reproduction you can — a failing test invocation, a CLI command, a minimal input — and dispatch `kata-test-runner` to run it. Not reproducible? That is a finding: report exactly what was tried, on what, and stop short of inventing a diagnosis for a ghost.
3. **Dig evidence.** Dispatch `kata-scout` (parallel briefs where useful): recent changes to the implicated areas (`git log`), the code paths the failure crosses, prior fixes that look similar, and any related tests that pass (they bound where the bug can hide).
4. **Localize.** Read the flagged code yourself and pin the root cause to `path:line` with a mechanism: *why* the code does the wrong thing, not just where it seems to. Distinguish root cause from symptom — the crash site is rarely the bug. If evidence supports two candidates, say so explicitly with the discriminating experiment that would decide.
5. **Size and classify.** Blast radius (what else crosses this code), severity (correctness / data loss / crash / cosmetic), regression or latent (which commit, if the evidence names one). Recommend the next action — fix now, plan first, needs-more-info — and confirm it through `ask_user` in an interactive run.
6. **Deliver — to a file.** Resolve the destination in order: a path the task names wins; otherwise, in an interactive run, ask it alongside the next-action confirmation (a `select` leading with the default `docs/triage/<YYYY-MM-DD>-<slug>-triage.md`, plus an "elsewhere" option whose answer is a custom path); otherwise take the default. The report carries: Summary; Reproduction (exact commands + observed output); Root cause (`path:line` + mechanism); Blast radius; Severity & classification; Recommended fix sketch — including **the failing test a fix should start from** (per TDD, the repro distilled into a test is the fix's first step); Open questions. Summarize in your closing message. Do not commit unless the task says to.

## Anti-patterns

- **Diagnosing without reproducing.** Reproduce first, or state plainly that you could not and what that means for confidence.
- **Stopping at the symptom.** The stack trace's top frame is where it died, not why. Follow the mechanism to the cause.
- **Fixing "while you're in there".** Diagnosis run. The fix is a separate kata unless the task explicitly says otherwise.
- **Burning driver turns on log-scrolling.** Reproduction runs and history digs go to the Haiku subagents; you spend Sonnet on the thinking.
- **A report without a next step.** Always end with the failing test a fix should start from, or the discriminating experiment if the cause is still ambiguous.
