---
title: Show and settle the build's checks in the Workbench
system: kata
author: SatishKrishna Pilla, product owner
date: 2026-11-16
status: accepted
scope: kata
context: [kata@ac8191b]
---

# Intent: Show and settle the build's checks in the Workbench

## Problem

Starting a build runs every team check on the base first, which takes tens of minutes, and the engineer cannot follow or settle that from the Workbench. On 2026-11-16 a build stopped because checks already failed on the base; the Workbench printed the way out as shell commands (accept a failing check, or check the base again) and offered no way to do either, so the engineer had to leave for a terminal. While checks ran, the Workbench did not say which one was running, so a one-second install step looked like a rerun of a check the engineer had just accepted. Failures showed twice, on the page and in a dialog, packed so tightly they were hard to read, and a failed start stayed on screen after the build had moved on, which led the engineer to believe the build was still failing. The preparing view also spends a whole padded row on its Stop button. The cost: a build that should start in one click took most of an afternoon and several wrong conclusions.

## Proposed outcome

1. The engineer starts the build. The page shows the build being prepared, and the way to stop it takes no more room than the progress itself.
2. While the checks run on the base, the page names the check running at that moment, how many of how many are done, and each finished check's result as it lands. A short preparation step, such as installing packages, is named as itself, so it cannot be mistaken for a check.
3. When every check passes on the base, or the ones that fail are already accepted for this build, the first task starts.
4. When a check fails on the base without saying what failed, the build stops. The page shows once, readably, which checks failed on the base and, on request, each one's output. For each, the engineer can accept it for this build from the Workbench, and the page says plainly what accepting lets through. Starting the build again then reuses the base results and goes on to the first task.
5. When the build finishes and a check fails, the failure is shown the same way: which check, why, its output readable, shown once.
6. The screen always shows where the change stands now. Once the build has moved on, for example because it was started from a Claude Code session, an earlier failure no longer shows.

**Success looks like:** an engineer whose base has a known failing check goes from starting the build to the first task running without opening a terminal, and at any moment during the checks the screen says which check is running.

## Affected users and systems

- **Users:** the engineer running a build in the Workbench, the only person who may accept a failing check; the agent never may. The product owner is not affected.
- **Systems:** the Kata Workbench (the build page and the change page). The hoshin plugin, which runs the checks and keeps the base results and accepted checks, is used as it is, apart from one dependency: it must report each check on the base as it starts and ends, which is a separate hoshin change (D1). The team's checks are unchanged.

## Constraints

- Only the engineer accepts a failing check; the agent never may. The Workbench does it through hoshin and never decides a workflow answer itself.
- Accepting covers one check, for this change, at this base commit; a new base commit means deciding again.
- Only a check that fails on the base without saying what failed needs accepting. One that names its failures needs none: failures already on the base pass, new ones block.
- Accepted checks and base results are kept on this machine only; a teammate continuing the change on another machine decides again.
- Which checks run, and when, stays the team's hoshin setting; this change does not alter it.

## Decisions

| # | Situation | Decision | What should happen |
|---|---|---|---|
| D1 | Naming the running check needs hoshin to report each check on the base, which it does not do today | handle it | A separate hoshin change adds the reporting and ships first; this change covers Kata only. Until hoshin reports them, the page names the step (checking the base) but not the check. |
| D2 | The build is already under way outside the Workbench (for example a Claude Code session in the change's copy) and the engineer starts it from the Workbench | handle it | When hoshin's record shows the build started and not finished, the page says it appears to be running elsewhere and asks before starting a second one. It asks rather than blocks, because a crashed build leaves the same record and must be startable again. |
| D3 | Several checks fail on the base at once | handle it | Each is accepted on its own, by name; there is no way to accept them all at once. The page says plainly how many failed together, so a whole batch failing reads as a sign of a broken setup rather than separate problems. |
| D4 | A check passed on the base but fails at build finish for a reason unrelated to the change, such as a timing check on a busy machine | handle it | The finish failure offers running the checks again from the Workbench. It never offers accepting a new failure at finish, since catching those is what the checks are for. |
| D5 | The engineer accepts a check by mistake | handle it | Accepting asks once more, naming the check and what it lets through (it will not block this build at finish while the base commit stays the same). There is no undo; that would need hoshin to support it. |
| D6 | The base's check results are wrong for a reason outside the code (for example missing packages) and the engineer wants the base checked again | out of scope | The Workbench never offers checking the base again. A new base commit takes fresh results by itself; anything else stays a terminal step. |
| D7 | The change has moved on since the page last read it (a build that failed to start has since started, from the Workbench or elsewhere) | handle it | The change page reads where the change stands on opening, after any action and when the window regains focus, as the home does; a failure the current state no longer holds is cleared. No continuous watching. |
| D8 | The engineer stops the build while the checks run on the base | handle it | Before stopping, the page says how many checks already ran and that the next start runs them all again, since hoshin keeps none until the last one ends. After stopping, it says the copy stays on the base commit until the build starts again and the work is safe on the branch. Nothing is rolled back. |
| D9 | Accepting a check while a run of this change is live; very long check output; builds started before this change; showing whether a finish failure sends the agent back to fix or stops; keyboard and screen-reader use | engineer's call | Confirmed as one batch. |

## Open questions

- The timing check (app-speed) passes or fails with how busy the machine is, so it fails on the base for no code reason; fixing the check itself is a separate fix. Owner: the engineer.
- The hoshin change D1 depends on (reporting each check on the base as it starts and ends) is not yet written. Owner: the engineer, in the hoshin repository.
- The screens are to be prototyped before the spec is written, so the spec can point at them. Owner: the engineer.
