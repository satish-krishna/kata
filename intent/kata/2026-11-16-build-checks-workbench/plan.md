---
layout: 2
source_spec: 2026-11-16-build-checks-workbench/spec.md
source_spec_commit: bb8c7b2c724b313511cdf7d31329f09233e2d8ec
system: kata
date: 2026-11-18
author: SatishKrishna Pilla
status: draft
---

# Plan: Show and settle the build's checks in the Workbench

## Approach

The backend goes first: the plugin floor and the vendored hoshin tools move to 1.1.0, then `kata-sdlc` gains typed reads of hoshin's `checks`, `baseline show` and `baseline approve`, and the decisions of the Build tab (`checks_view::start_checks`, the finish failure, running elsewhere) are computed there and in the Workbench backend (`build_host`, `steps`, `running`). The frontend follows, one screen area per task, each reading those decisions as data and only folding and formatting them. The two small top-bar fixes (D10, D11) come right after the floor, because they touch nothing else in the change. The live check list lives on the preparation step (`StepGuard` in `steps.rs`), not in `BuildState`, because no `Build` entry exists while a first start is being prepared (`build_host.rs`, the insert after `prepare`); the spec only requires that it survives the page.

## Engineer direction

- Backend first: the Rust reads, decisions and commands, each with its own tests, then the frontend → T5, T6, T7, T8, T9, T10, T11, T12 before T13 to T18, Approach
- The frontend split one screen area per task → T13, T14, T15, T16, T17, T18
- D10 and D11 as their own small tasks, early → T2, T3, T4
- Raising the minimum hoshin version to 1.1.0 and refreshing the vendored tools as the very first task → T1
- At the outline: the outline confirmed as shown; the plan splits its T2 into a Rust task (T2) and a label task (T3), since each needs its own failing test → T2, T3

## Scenario coverage

Every scenario in the spec's Gherkin block appears here with at least one test.

| Scenario | Test | Task |
|---|---|---|
| R1.1 | `change-page.build-strip.spec.ts` "stop sits on the progress line r1.1" | T13 |
| R2.1 | `build-checks-list.spec.ts` "names the running check with a count r2.1" | T14 |
| R2.2 | `build-checks-list.spec.ts` "names a preparation step apart from the checks r2.2" | T14 |
| R2.4 | `build-checks-list.spec.ts` "shows a cut off check r2.4" | T14 |
| R2.5 | `build-checks-list.spec.ts` "shows checks running in another session as last read r2.5" | T14 |
| R3.1 | `build_host::tests::base_checks_decide_the_first_task_r3_1` | T8 |
| R4.1 | `build-failure-panel.spec.ts` "shows one base failure once on the page r4.1" | T15 |
| R4.2 | `build-failure-panel.spec.ts` "shows a check's output on request r4.2" | T15 |
| R4.3 | `build-failure-panel.spec.ts` "says how many failed together r4.3" | T15 |
| R4.5 | `build-failure-panel.spec.ts` "shows another start failure once without accept r4.5" | T15 |
| R5.1 | `build-failure-panel.spec.ts` "asks once more naming what accepting lets through r5.1" | T15 |
| R5.2 | `build-failure-panel.spec.ts` "confirming records the acceptance and marks it r5.2" | T15 |
| R5.3 | `build-failure-panel.spec.ts` "cancelling records nothing r5.3" | T15 |
| R5.4 | `build-failure-panel.spec.ts` "each check has its own accept action r5.4" | T15 |
| R5.5 | `checks_view::tests::only_unnamed_failures_can_be_accepted_r5_5` | T6 |
| R5.6 | `build-failure-panel.spec.ts` "shows the workflow's refusal as it is r5.6" | T15 |
| R5.7 | `hoshin::tests::guard_refuses_baseline_approve_to_an_agent_r5_7` | T9 |
| R5.8 | `hoshin::tests::acceptance_holds_for_one_base_commit_r5_8` | T9 |
| R6.1 | `build_host::tests::second_start_reuses_the_base_results_r6_1` | T8 |
| R6.2 | `build-failure-panel.spec.ts` "start is held back until every failing check is settled r6.2" | T15 |
| R7.1 | `build-finish-panel.spec.ts` "shows a finish failure once with what happens next r7.1" | T16 |
| R7.2 | `build_host::tests::rerun_finish_checks_counts_as_the_finish_r7_2` | T11 |
| R7.3 | `build-finish-panel.spec.ts` "folds the checks that passed at finish r7.3" | T16 |
| R8.1 | `checks_view::tests::start_checks_shows_the_record_r8_1` | T6 |
| R8.2 | `change-page.view-model.spec.ts` "a failure the change no longer holds is cleared on focus r8.2" | T18 |
| R8.3 | `change-page.view-model.spec.ts` "reads on opening and after actions, not on its own r8.3" | T18 |
| R9.1 | `build_host::tests::start_asks_when_the_build_may_run_elsewhere_r9_1` | T10 |
| R9.2 | `build-elsewhere-dialog.spec.ts` "confirm starts and decline starts nothing r9.2" | T17 |
| R10.1 | `steps::tests::stop_question_counts_the_checks_that_ran_r10_1` | T12 |
| R10.2 | `steps::tests::stopped_note_says_where_the_copy_was_left_r10_2` | T12 |
| R10.3 | `change-page.build-strip.spec.ts` "declining the stop keeps the checks running r10.3" | T13 |
| R11.1 | `lib.rs` tests `accept_base_check_while_work_is_live_r11_1` | T9 |
| R11.2 | `checks_view::tests::older_build_shows_its_reason_once_r11_2` | T6 |
| R12.1 | `build-checks-list.spec.ts` "announces the running check only when it changes r12.1" | T14 |
| R12.2 | `build-failure-panel.spec.ts` "every action is reachable and named r12.2" | T15 |
| R13.1 | `running-strip.spec.ts` "the label names what the list holds r13.1" | T3 |
| R13.2 | `running-strip.spec.ts` "no label for an empty list r13.2" | T3 |
| R14.1 | `change-page.view-model.spec.ts` "a run that ends on its page counts as seen when focused r14.1" | T4 |
| R14.2 | `running::tests::later_run_brings_the_change_back_r14_2` | T2 |

## Shared decisions

Every question more than one task must answer the same way, and the one task that owns the answer.

```yaml
- question: What hoshin's checks and baseline answers hold
  owner: T5
  function: "kata_sdlc::hoshin::{ChecksAnswer, CheckRun, CheckEvent, CheckState, BaselineShow, BaselineHook, BaselineApproved} returned by Program::checks(change, repo) -> Result<ChecksAnswer>, Program::baseline_show(change, repo) -> Result<BaselineShow>, Program::baseline_approve(change, repo, hook) -> Result<BaselineApproved>"
- question: What the Build tab shows for a repository's start and its checks on the base
  owner: T6
  function: "kata_sdlc::checks_view::start_checks(program: &Program, change: &ChangeRef, repos: &[String]) -> Result<Vec<StartChecks>>, with StartChecks { repo, shown: StartShown, base, checks: Vec<BaseCheck>, passed: u32, setup_hint: bool, start_held: Option<String>, finish: Option<FinishFailure> } and BaseCheck { check, state: BaseCheckState, exit_code, output, line_count, can_accept, accepted, started_at, ended_at }"
- question: Which words name each preparation step and the checks on the base
  owner: T8
  function: "steps::StepKind::words(&self) -> &'static str, with StepKind::PreparationHook { id } and StepKind::CheckingBase worded \"Checking the base\""
- question: Which kind an entry of the running strip counts as
  owner: T2
  function: "running::kind_of(state: &EntryState) -> EntryKind, EntryKind { Running, NeedsYou, Waiting, Finished }, summed into RunningStrip.counts: StripCounts { running, needs_you, waiting, finished }"
- question: Whether a start of the build may be running elsewhere
  owner: T10
  function: "kata_sdlc::offer::may_be_running_elsewhere(status: &Status, checks: &[ChecksAnswer], live: &LiveFacts, repos: &[String]) -> Option<Elsewhere>, Elsewhere { repos: Vec<String>, since: String, running_check: Option<String> }"
```

A task lists a question under `uses` by its exact `question` text, and names its owner in `depends_on`.

## Tasks

### T1: Raise the hoshin plugin floor to 1.1.0

```yaml
id: T1
repo: kata
depends_on: []
uses: []
files: [crates/kata-sdlc/src/plugin.rs, crates/kata-sdlc/src/hoshin.rs, crates/kata-sdlc/tests/hoshin-tools/, crates/kata-sdlc/tests/format_conformance.rs, CLAUDE.md, app/src/app/lib/sdlc-mock.ts, app/src/app/sdlc/change/change-page.view-model.ts, app/src/app/sdlc/new-change-dialog.ts, app/src/app/sdlc/change/change-page.view-model.spec.ts]
covers: []
supports: [R2.1, R2.4, R2.5, R4.2, R5.2]
test: [cargo, test, -p, kata-sdlc, --lib, plugin::tests::plugin_1_0_0_is_below_the_floor, --, --exact]
```

#### Change

`plugin::MIN_VERSION` becomes `1.1.0`, and the floor message names it. Refresh the vendored tools in `crates/kata-sdlc/tests/hoshin-tools/` from the hoshin checkout at its v1.1.0 tag with `node scripts/vendor-hoshin-tools.mjs`, setting `KATA_HOSHIN_PLUGIN` to that checkout (on this machine `D:\workspaces\hoshin`; the copy has no sibling `../hoshin`). Add `baseline` and `checks` to `PLACED` in `hoshin.rs`, so `with_place` passes `--master` and `--workspace` to them as it does to every other placed command. Update every test and string that names the floor: `plugin_version_reads_plugin_json_r2_5`, `readiness_rows`, `format_conformance.rs` (the two version assertions), the frontend's "1.0.0" in `sdlc-mock.ts`, `change-page.view-model.ts`, `new-change-dialog.ts` and their specs, and the floor sentence in `CLAUDE.md` (the `kata-sdlc` paragraph).

#### Tests

`plugin::tests::plugin_1_0_0_is_below_the_floor` writes a plugin folder whose `plugin.json` says 1.0.0 and asserts the readiness row blocks the mode with the floor message naming 1.1.0. It fails before the change because 1.0.0 meets today's floor. A second test, `hoshin::tests::placed_commands_include_baseline_and_checks`, asserts `with_place` adds `--master` for `checks` and `baseline`.

#### Done when

`cargo test -p kata-sdlc` passes (the vendored 1.1.0 tools under every existing test), `cargo clippy -p kata-sdlc --all-targets -- -D warnings` is clean, and `npm test -- --watch=false --include src/app/sdlc/change/change-page.view-model.spec.ts` passes from `app/`.

### T2: Count the running strip's entries by kind

```yaml
id: T2
repo: kata
depends_on: [T1]
uses: []
files: [app/src-tauri/src/running.rs, app/src/bindings/]
covers: [R14.2]
supports: [R13.1, R13.2]
test: [node, intent/kata/hooks/cargo-staged.mjs, test, -p, kata-app, --lib, running::tests::strip_counts_by_kind_r13_1, --, --exact]
```

#### Change

Add `EntryKind` and `kind_of` (shared decision "Which kind an entry of the running strip counts as") and `RunningStrip.counts: StripCounts { running, needs_you, waiting, finished }`, summed over the strip's entries in `entries`. The table, one row per `EntryState` variant:

| `EntryState` | kind |
|---|---|
| `Working` | running |
| `NeedsAnswer` | needs you |
| `NeedsPermission` | needs you |
| `Stopped` | needs you |
| `Held` | waiting |
| `ReviewWaiting` | waiting |
| `Finished` | finished |

`OpenedMarks` is unchanged. Regenerate the bindings with `cargo test -p kata-app --features ts export_bindings`.

#### Tests

`running::tests::strip_counts_by_kind_r13_1` builds a strip for each `Examples` row of R13.1 and asserts its counts, row by row, and a strip with every `EntryState` variant asserts the table above. It fails before the change because `RunningStrip` has no `counts`. `running::tests::later_run_brings_the_change_back_r14_2` marks a change opened after its run ended, ends a later run, and asserts the change is listed as finished again (covers R14.2; it passes on today's `OpenedMarks` once written, and stays as the guard for T4).

#### Done when

`node intent/kata/hooks/cargo-staged.mjs test -p kata-app --lib running::` passes and the regenerated `RunningStrip` binding carries `counts`.

### T3: Word the list of active changes by kind

```yaml
id: T3
repo: kata
depends_on: [T2]
uses: [Which kind an entry of the running strip counts as]
files: [app/src/app/sdlc/running-strip.view-model.ts, app/src/app/ui/running-strip.html, app/src/app/ui/running-strip.ts, app/src/app/ui/running-strip.spec.ts, app/src/app/core/transport/mock-transport.ts]
covers: [R13.1, R13.2]
supports: []
test: [node, -e, "process.chdir('app');process.argv.splice(1,0,'ng');require(require('path').resolve('node_modules/@angular/cli/bin/ng.js'))", test, --watch=false, --include, src/app/ui/running-strip.spec.ts, --filter, "the label names what the list holds r13.1"]
```

#### Change

`RunningStripViewModel.allLabel` words `strip.counts` and no longer counts `all.length`: each kind with a count above zero, as "<n> running", "<n> needs you", "<n> waiting", "<n> finished", in that order, joined with " · ". The button and the popover title show the same label; the list's accessible name becomes "Changes with activity" (`running-strip.html`, today "All running changes"). When every count is zero the strip is not shown, as today. The mock strip in `mock-transport.ts` carries `counts`.

#### Tests

"the label names what the list holds r13.1" asserts the label and the popover title for each `Examples` row of R13.1, row by row, from strips whose `counts` match the row. It fails before the change because the label reads "All running (n)". "no label for an empty list r13.2" asserts no button renders for an empty strip.

#### Done when

`npm test -- --watch=false --include src/app/ui/running-strip.spec.ts` passes from `app/` and `npx eslint src/app/sdlc/running-strip.view-model.ts src/app/ui/running-strip.ts` is clean.

### T4: Count a run that ends on its change's page as seen

```yaml
id: T4
repo: kata
depends_on: [T2]
uses: []
files: [app/src/app/sdlc/change/change-page.view-model.ts, app/src/app/sdlc/change/change-page.ts, app/src/app/sdlc/change/change-page.view-model.spec.ts]
covers: [R14.1]
supports: [R14.2]
test: [node, -e, "process.chdir('app');process.argv.splice(1,0,'ng');require(require('path').resolve('node_modules/@angular/cli/bin/ng.js'))", test, --watch=false, --include, src/app/sdlc/change/change-page.view-model.spec.ts, --filter, "a run that ends on its page counts as seen when focused r14.1"]
```

#### Change

The decision table is R14.1's `Examples`. The rule stays in `OpenedMarks`; the change page reports each moment the engineer is looking. `tellOpened` loses its `openedKey` one-call-per-visit guard. The page calls `sdlcMarkOpened` on opening (as today), when a run of its change ends while `document.hasFocus()` is true (the existing run-end handling near the build-end reload), and on every window focus while the page is shown, through a `host: { '(window:focus)': ... }` binding on the component, the way `sdlc-home.ts` does it (never `@HostListener`). Read `document.hasFocus()` through a small injectable seam so the spec can set it. The other-page rows of the table need nothing: the page is not shown, so it calls nothing.

#### Tests

"a run that ends on its page counts as seen when focused r14.1" asserts, for each `Examples` row on the change's page, whether `sdlcMarkOpened` is called when the run ends, and for the unfocused row that it is called once focus returns. It fails before the change because the page calls it once per visit only.

#### Done when

`npm test -- --watch=false --include src/app/sdlc/change/change-page.view-model.spec.ts` passes from `app/`.

### T5: Read hoshin's checks, baseline show and baseline approve

```yaml
id: T5
repo: kata
depends_on: [T1]
uses: []
files: [crates/kata-sdlc/src/hoshin.rs]
covers: []
supports: [R2.1, R2.4, R2.5, R4.2, R5.2, R5.6]
test: [cargo, test, -p, kata-sdlc, --lib, hoshin::tests::checks_answer_reads_a_base_run, --, --exact]
```

#### Change

Add the shared decision "What hoshin's checks and baseline answers hold": `Program::checks` runs `checks --json --change <c> --repo <r>` and parses `{system, change, runs:[{run, event, repo, phase, checks:[{check, state, startedAt, endedAt, timeout, outcome, ids, blocks}]}], problems}`; `Program::baseline_show` runs `baseline show --json --change <c> --repo <r>` and parses `base`, `hooks:[{id, outcome, exitCode, ids, output}]`, `needsApproval` and `approved`; `Program::baseline_approve` runs `baseline approve --json --change <c> --repo <r> --hook <id>` and parses `{approved:{hook, base}|null, problems}`. All three go through `run` (hidden, time-limited, placed by `with_place`). `CheckState` is `Running | Ended | Abandoned`, exactly as hoshin reports it; Kata never decides a check abandoned itself. A non-empty `problems` on `checks` or `baseline show` is an error; on `baseline approve` it is the answer (R5.6 shows it as it is).

#### Tests

`hoshin::tests::checks_answer_reads_a_base_run` runs a `scripted()` program printing a `checks` answer with one running, one ended and one abandoned check and asserts the typed answer. It fails before the change because `Program::checks` does not exist (the test commit carries a stub returning an empty answer). Further tests: `baseline_show_reads_each_hook_output` and `baseline_approve_returns_problems_as_the_answer`, each against `scripted()`.

#### Done when

`cargo test -p kata-sdlc --lib hoshin::` passes and `cargo clippy -p kata-sdlc --all-targets -- -D warnings` is clean.

### T6: Decide what the Build tab shows for a start

```yaml
id: T6
repo: kata
depends_on: [T5]
uses: [What hoshin's checks and baseline answers hold]
files: [crates/kata-sdlc/src/checks_view.rs, app/src-tauri/src/lib.rs, app/src/bindings/]
covers: [R5.5, R8.1, R11.2]
supports: [R2.4, R2.5, R4.1, R4.3, R4.5, R5.2, R6.2]
test: [cargo, test, -p, kata-sdlc, --lib, checks_view::tests::start_checks_shows_the_record_r8_1, --, --exact]
```

#### Change

Add the shared decision "What the Build tab shows for a repository's start and its checks on the base": `checks_view::start_checks`, per repository in plan order, from `Program::status` (the latest `build.start` and `build.finish` records), `Program::baseline_show`, `Program::checks` and `Program::hooks`. `StartShown`'s value is the decision table of R8.1: its `Examples` are the table, the `shown` column naming the variant (`Startable`, `BaseFailure`, `AllAccepted`, `BaseMoved`, `OtherReason`, `UnderWay`, `Finished`, `FinishFailure`). Each `BaseCheck` takes `can_accept` true only when the check is in `needsApproval` (R5.5), `accepted` from `approved`, exit code and output from `baseline show`, `line_count` from the output, and its state from the latest `baseline` run of `checks` (`Running`, `Passed`, `Failed`, `CutOff` for hoshin's `abandoned`, `NotRun` for a check of the hook list with no event in that run). `setup_hint` is true at three or more failing checks that can be accepted (R4.3's `Examples` are its table). `start_held` is the reason Start is off (R6.2) when a failing check is not accepted. A build start record with no `details.baseline` (a build started before hoshin recorded base results) is `OtherReason` with hoshin's reason and no accept action (R11.2). `finish` stays `None` here; T7 fills it. Add the Tauri command `sdlc_start_checks(change) -> Vec<StartChecks>` in `lib.rs`, registered in `generate_handler!`, and regenerate the `kata-sdlc` and `kata-app` bindings. `refusalOf` in `build-page.view-model.ts` stays until T15 replaces its use.

#### Tests

`checks_view::tests::start_checks_shows_the_record_r8_1` asserts every `Examples` row of R8.1, row by row, from `scripted()` answers of `status`, `baseline show`, `checks` and `hooks`. It fails before the change because `start_checks` does not exist (stubbed in the test commit). Also `only_unnamed_failures_can_be_accepted_r5_5` (a check that names its failures has `can_accept` false and does not stop the build), `older_build_shows_its_reason_once_r11_2`, `setup_hint_at_three_or_more_r4_3` (each `Examples` row of R4.3) and `cut_off_and_elsewhere_rows_r2_4_r2_5`.

#### Done when

`cargo test -p kata-sdlc --lib checks_view::` passes and `cargo clippy -p kata-sdlc --all-targets -- -D warnings` is clean.

### T7: Decide what a finish failure shows

```yaml
id: T7
repo: kata
depends_on: [T6]
uses: [What the Build tab shows for a repository's start and its checks on the base]
files: [crates/kata-sdlc/src/checks_view.rs, app/src/bindings/]
covers: []
supports: [R7.1, R7.3]
test: [cargo, test, -p, kata-sdlc, --lib, checks_view::tests::finish_failure_says_what_happens_next_r7_1, --, --exact]
```

#### Change

Fill `StartChecks.finish: Option<FinishFailure>` from the latest `build.finish` record: the failing check, whether it passed on the base or added failures there (from the existing `CheckView` rows of `checks_view::of`), its output, the count that passed (R7.3), and `next` from the hook's `onFailure` (`fix`: the agent was sent back and did not get it to pass; `stop`: the build stopped here). The outcome for each row of R7.1's `Examples` is the row's `next` column. `can_accept` is always false for a finish failure (D4). Regenerate the bindings.

#### Tests

`checks_view::tests::finish_failure_says_what_happens_next_r7_1` asserts every `Examples` row of R7.1, row by row, and the passed count. It fails before the change because `finish` is always `None`.

#### Done when

`cargo test -p kata-sdlc --lib checks_view::` passes.

### T8: Keep the live check list on the preparation step

```yaml
id: T8
repo: kata
depends_on: [T5, T6]
uses: [What hoshin's checks and baseline answers hold, What the Build tab shows for a repository's start and its checks on the base]
files: [app/src-tauri/src/build_host.rs, app/src-tauri/src/steps.rs, crates/kata-sdlc/src/hoshin.rs, app/src/app/lib/progress-steps.ts, app/src/bindings/]
covers: [R3.1, R6.1]
supports: [R1.1, R2.1, R2.2, R12.1]
test: [node, intent/kata/hooks/cargo-staged.mjs, test, -p, kata-app, --lib, build_host::tests::base_checks_decide_the_first_task_r3_1, --, --exact]
```

#### Change

`progress_of` in `hoshin.rs` reads each stream line's phase: a `build.start` hook line is a preparation step, a `build.finish` line with `"check": true` is a finish check; `StepProgress` carries the phase. Add the shared decision "Which words name each preparation step and the checks on the base": `StepKind::PreparationHook { id }` and `StepKind::CheckingBase`, worded "Checking the base" in `StepKind::words`, which becomes the one owner of the wording ("Checking every repository before building" and the frontend's "Checking the base before building" in `progress-steps.ts` go). While this Workbench's own `build.start` for a repository is live inside `prepare`, the build host reads `Program::checks` for that repository every two seconds and keeps the latest `baseline` run as `live_checks: Vec<BaseCheck>` on the preparation step's entry (the `StepGuard`'s step, which exists from the click on, unlike `BuildState`), so the page reads it with the step; the read stops when the event ends, on every path (pass, failure, stop). The timer is the only timed read in the change. A check row's state on the step:

| hoshin `state` | `outcome` | shown |
|---|---|---|
| `running` | any | running, with its start time |
| `ended` | passed | passed, with its duration |
| `ended` | failed | failed, with its duration |
| `abandoned` | any | cut off |
| no event yet | not applicable | waiting |

The first task starts as today when `build.start` passes; R3.1's `Examples` are the table, and each row maps to the `build.start` outcome hoshin reports (passed for the first three rows, failed with `details.baseline.needsApproval` for the last).

#### Tests

`build_host::tests::base_checks_decide_the_first_task_r3_1` scripts `FakeTools` with a `build.start` outcome for each `Examples` row of R3.1 and asserts, row by row, whether the first task launches or the start fails with the failing checks. It fails before the change because the start outcome carries no base checks. Also `second_start_reuses_the_base_results_r6_1` (a `build.start` that passes with the base results reused launches the first task and the live list shows no running check), `live_checks_follow_the_checks_answer` (the table above, row by row, from scripted `checks` answers) and `checks_poll_stops_when_the_event_ends`. `steps::tests::words_name_preparation_and_checks` asserts the wording.

#### Done when

`node intent/kata/hooks/cargo-staged.mjs test -p kata-app --lib build_host::` and `... --lib steps::` pass, and `cargo test -p kata-sdlc --lib hoshin::` passes.

### T9: Accept one failing check from the Workbench

```yaml
id: T9
repo: kata
depends_on: [T5, T6]
uses: [What hoshin's checks and baseline answers hold]
files: [app/src-tauri/src/lib.rs, crates/kata-sdlc/src/hoshin.rs, app/src/bindings/]
covers: [R5.7, R5.8, R11.1]
supports: [R5.2, R5.4, R5.6]
test: [node, intent/kata/hooks/cargo-staged.mjs, test, -p, kata-app, --lib, tests::accept_base_check_while_work_is_live_r11_1, --, --exact]
```

#### Change

Add the Tauri command `sdlc_accept_base_check(change, repo, check) -> BaselineApproved`, registered in `generate_handler!`: one check per call (R5.4), through `Program::baseline_approve`, returning hoshin's `approved` or its `problems` as they are (R5.6). It is refused while this change's build is being prepared (R11.1), with "The build is being prepared"; another repository's live run of the same change does not refuse it. Regenerate the bindings.

#### Tests

`accept_base_check_while_work_is_live_r11_1` (in `lib.rs`'s tests) asserts every `Examples` row of R11.1, row by row. It fails before the change because the command does not exist (stubbed in the test commit). `hoshin::tests::guard_refuses_baseline_approve_to_an_agent_r5_7` runs the vendored program's `guard` with a Bash tool call of `baseline approve` and asserts it is refused, so the protection Kata relies on is in the floor version. `hoshin::tests::acceptance_holds_for_one_base_commit_r5_8` approves a check through the vendored program in a fixture workspace, moves the base commit and asserts `baseline_show` no longer lists it as approved.

#### Done when

`node intent/kata/hooks/cargo-staged.mjs test -p kata-app --lib tests::accept_base_check` and `cargo test -p kata-sdlc --lib hoshin::` pass.

### T10: Ask before starting a build that may be running elsewhere

```yaml
id: T10
repo: kata
depends_on: [T5, T8]
uses: [What hoshin's checks and baseline answers hold]
files: [crates/kata-sdlc/src/offer.rs, app/src-tauri/src/build_host.rs, app/src-tauri/src/lib.rs, app/src/bindings/]
covers: [R9.1]
supports: [R9.2]
test: [node, intent/kata/hooks/cargo-staged.mjs, test, -p, kata-app, --lib, build_host::tests::start_asks_when_the_build_may_run_elsewhere_r9_1, --, --exact]
```

#### Change

Add the shared decision "Whether a start of the build may be running elsewhere": `offer::may_be_running_elsewhere`, from `status` (a `build.start` that passed with no later `build.finish` for a repository the next start needs), `checks` (a `baseline` check reported `running` for it names the check and makes the answer "running now") and the live facts (the build host has neither a live run nor a run it stopped for this change since the Workbench opened). `LiveFacts` gains `stopped_here: bool`; `live_facts_of` in `lib.rs` fills it from the build host, where `build_stopped` is always false today. R9.1's `Examples` are the table. The start and continue commands take `even_if_elsewhere: bool`; without it such a start returns the new `StartOutcome::MayBeRunningElsewhere { repos, since, running_check }` before anything starts, so the question and the start are one Rust call. Regenerate the bindings.

#### Tests

`build_host::tests::start_asks_when_the_build_may_run_elsewhere_r9_1` asserts every `Examples` row of R9.1, row by row, through the start command with `even_if_elsewhere` false, and that with it true the first row starts. It fails before the change because no start asks. `offer::tests::may_be_running_elsewhere_rows` asserts the same rows on the pure function.

#### Done when

`node intent/kata/hooks/cargo-staged.mjs test -p kata-app --lib build_host::` and `cargo test -p kata-sdlc --lib offer::` pass.

### T11: Run the checks again at finish

```yaml
id: T11
repo: kata
depends_on: [T7, T8]
uses: []
files: [app/src-tauri/src/build_host.rs, app/src-tauri/src/lib.rs, app/src-tauri/src/steps.rs, crates/kata-sdlc/src/coordinator.rs, app/src/bindings/]
covers: [R7.2]
supports: [R7.1]
test: [node, intent/kata/hooks/cargo-staged.mjs, test, -p, kata-app, --lib, build_host::tests::rerun_finish_checks_counts_as_the_finish_r7_2, --, --exact]
```

#### Change

Add the Tauri command `sdlc_rerun_finish_checks(change, repo)`, registered in `generate_handler!`. It runs `run build.finish --json --stream --again --repo <repo>` as a stoppable workflow step with its progress line (C148), naming the running check through T8's `progress_of` phases. It takes the repository's hold like a build run (C114) and is refused while any run of the change is live. The base results are not touched. What happens when it ends:

| a `Build` of the change is live | rerun outcome | last unfinished repository | what happens |
|---|---|---|---|
| yes | passed | yes | the coordinator reads status, counts the repository finished, and starts the review (C42) |
| yes | passed | no | the coordinator reads status and counts the repository finished |
| yes | failed | any | nothing changes; the finish failure shows the new result |
| yes | stopped | any | nothing changes; the hold is released |
| no | passed | any | nothing starts; the next Start or Continue reads status, where the repository is finished |
| no | failed or stopped | any | nothing changes |

The rerun is refused while a run of the change is live, so "a `Build` of the change is live" means one waiting between runs. The coordinator change, if any, goes through its existing `Input::Status` so C39, C56 and C114 keep their tests.

#### Tests

`build_host::tests::rerun_finish_checks_counts_as_the_finish_r7_2` asserts every row of the table above with `FakeTools`. It fails before the change because the command does not exist (stubbed in the test commit). The existing coordinator tests for C39, C56 and C114 run unchanged in "done when".

#### Done when

`node intent/kata/hooks/cargo-staged.mjs test -p kata-app --lib build_host::` and `cargo test -p kata-sdlc --lib coordinator::` pass.

### T12: Word the stop question and the stopped note

```yaml
id: T12
repo: kata
depends_on: [T8]
uses: [Which words name each preparation step and the checks on the base]
files: [app/src-tauri/src/steps.rs, app/src-tauri/src/build_host.rs, app/src/bindings/]
covers: [R10.1, R10.2]
supports: [R10.3]
test: [node, intent/kata/hooks/cargo-staged.mjs, test, -p, kata-app, --lib, steps::tests::stop_question_counts_the_checks_that_ran_r10_1, --, --exact]
```

#### Change

The preparation step's entry carries `stop_question: Option<String>` while the checks on the base run: "<n> of <m> checks already ran. Stopping now runs every check on the base again at the next start, because none is kept until the last one ends." (n from `live_checks` ended rows). `StartOutcome::Stopped`'s note, when the stop came during the checks, adds: "The copy may stay on the base commit until the build starts again; the work is safe on the change's branch, and the next start puts it back first." Nothing is rolled back. Regenerate the bindings.

#### Tests

`steps::tests::stop_question_counts_the_checks_that_ran_r10_1` asserts the question for 0, 3 and 9 ended checks. It fails before the change because the step has no question. `stopped_note_says_where_the_copy_was_left_r10_2` asserts the note.

#### Done when

`node intent/kata/hooks/cargo-staged.mjs test -p kata-app --lib steps::` passes.

### T13: Put Stop on the build strip's progress line

```yaml
id: T13
repo: kata
depends_on: [T8, T12]
uses: [Which words name each preparation step and the checks on the base]
files: [app/src/app/sdlc/change/change-page.html, app/src/app/sdlc/change/change-page.css, app/src/app/sdlc/build/build-page.view-model.ts, app/src/app/ui/progress-line.ts, app/src/app/ui/progress-line.html, app/src/app/sdlc/change/change-page.build-strip.spec.ts, app/package.json]
covers: [R1.1, R10.3]
supports: [R10.1, R12.2]
test: [node, -e, "process.chdir('app');process.argv.splice(1,0,'ng');require(require('path').resolve('node_modules/@angular/cli/bin/ng.js'))", test, --watch=false, --include, src/app/sdlc/change/change-page.build-strip.spec.ts, --filter, "stop sits on the progress line r1.1"]
```

#### Change

Replace the padded Stop row in `change-page.html` (the `build.preparing()` block below `build-progress`) with a ghost `hlmBtn` Stop on the progress line itself, named "Stop preparing the build", as the prototype's Checking the base screen shows. Stop opens a confirm `hlm-dialog` showing the step's `stop_question` when present (stop now with no question otherwise, as today); declining keeps the checks running and changes nothing (R10.3). Layout is a flex run, tokens only. Add the new screen state to the `--route` lists of `check:boot` and `check:interaction` in `package.json` if the dialog is a new overlay.

#### Tests

"stop sits on the progress line r1.1" renders the strip with a preparation entry and asserts the Stop button is inside the progress line's element and no separate row renders. It fails before the change because Stop sits in its own row. "declining the stop keeps the checks running r10.3" asserts cancel calls no stop.

#### Done when

`npm test -- --watch=false --include src/app/sdlc/change/change-page.build-strip.spec.ts` passes from `app/`, and `npx eslint` and `npx stylelint` on the changed files are clean.

### T14: Show the checks list while the base is checked

```yaml
id: T14
repo: kata
depends_on: [T6, T8, T13]
uses: [What the Build tab shows for a repository's start and its checks on the base, Which words name each preparation step and the checks on the base]
files: [app/src/app/ui/build-checks-list.ts, app/src/app/ui/build-checks-list.html, app/src/app/ui/build-checks-list.css, app/src/app/ui/build-checks-list.spec.ts, app/src/app/sdlc/build/build-page.html, app/src/app/sdlc/build/build-page.ts, app/src/app/sdlc/build/build-page.view-model.ts, app/src/app/core/transport/kata-transport.ts, app/src/app/core/transport/tauri-transport.ts, app/src/app/core/transport/mock-transport.ts, app/src/app/core/transport/tauri-transport.spec.ts, app/src/app/core/transport/mock-transport.spec.ts, app/package.json]
covers: [R2.1, R2.2, R2.4, R2.5, R12.1]
supports: [R12.2]
test: [node, -e, "process.chdir('app');process.argv.splice(1,0,'ng');require(require('path').resolve('node_modules/@angular/cli/bin/ng.js'))", test, --watch=false, --include, src/app/ui/build-checks-list.spec.ts, --filter, "names the running check with a count r2.1"]
```

#### Change

A new presentational `BuildChecksList` component renders two grid lists on the Build tab, as the prototype's Checking the base, A check cut off and Moved on since screens show: Preparation (the step's preparation hooks) and Checks on the base (base commit, "n of m done", each check's name in mono, its result and time as it ends, the running one highlighted with its elapsed time, the rest waiting). The live list comes from the preparation step's `live_checks` while this Workbench prepares; otherwise from `sdlcStartChecks` (R2.4 cut off with its warning note, R2.5 "running in another session" in place of Stop). Add `sdlcStartChecks(change)` to `KataTransport`, `TauriTransport` and `MockTransport`, each with a spec. The progress text sits in a polite live region whose text changes only when a check starts or ends; the elapsed time is outside it (R12.1). The elapsed tick is formatting from the step's start time. Add the new screen states to the `--route` lists of `check:boot` and `check:interaction` in `package.json`.

#### Tests

"names the running check with a count r2.1" asserts the running check's name, its elapsed time, "n of m done", finished results and waiting rows. It fails before the change because the component does not exist (stubbed in the test commit). Also "names a preparation step apart from the checks r2.2", "shows a cut off check r2.4", "shows checks running in another session as last read r2.5" and "announces the running check only when it changes r12.1".

#### Done when

`npm test -- --watch=false --include src/app/ui/build-checks-list.spec.ts --include src/app/core/transport/mock-transport.spec.ts --include src/app/core/transport/tauri-transport.spec.ts` passes from `app/`, and `npx eslint` and `npx stylelint` on the changed files are clean.

### T15: Show a base failure once, on the page, with accept

```yaml
id: T15
repo: kata
depends_on: [T6, T9, T14]
uses: [What the Build tab shows for a repository's start and its checks on the base]
files: [app/src/app/ui/build-failure-panel.ts, app/src/app/ui/build-failure-panel.html, app/src/app/ui/build-failure-panel.css, app/src/app/ui/build-failure-panel.spec.ts, app/src/app/ui/accept-check-dialog.ts, app/src/app/ui/accept-check-dialog.html, app/src/app/sdlc/build/build-page.html, app/src/app/sdlc/build/build-page.ts, app/src/app/sdlc/build/build-page.view-model.ts, app/src/app/sdlc/build/build-page.view-model.spec.ts, app/src/app/sdlc/change/change-page.html, app/src/app/sdlc/change/change-page.ts, app/src/app/core/transport/kata-transport.ts, app/src/app/core/transport/tauri-transport.ts, app/src/app/core/transport/mock-transport.ts, app/src/app/core/transport/tauri-transport.spec.ts, app/src/app/core/transport/mock-transport.spec.ts, app/package.json]
covers: [R4.1, R4.2, R4.3, R4.5, R5.1, R5.2, R5.3, R5.4, R5.6, R6.2, R12.2]
supports: [R5.5]
test: [node, -e, "process.chdir('app');process.argv.splice(1,0,'ng');require(require('path').resolve('node_modules/@angular/cli/bin/ng.js'))", test, --watch=false, --include, src/app/ui/build-failure-panel.spec.ts, --filter, "shows one base failure once on the page r4.1"]
```

#### Change

A new `BuildFailurePanel` shows `StartChecks` with `shown` `BaseFailure`, `AllAccepted` or `OtherReason` once, on the Build tab, as the prototype's Failed on the base and Nine failed at once screens show: the status pill, the title with the count, the one-line reason, the setup hint when `setup_hint`, one row per check (name, badge, exit code and base commit, Show output, Accept for this build… only when `can_accept`), the folded passed count, and for `AllAccepted` that nothing is left to settle and the next start reuses the base results. Show output expands a scrolling mono block with its line count, "the last 200 are kept" and a copy action; the output is interpolated text, never HTML. Accept opens `AcceptCheckDialog` (a titled `hlm-dialog`, Escape cancels) naming the check and base commit and what accepting lets through (R5.1); confirming calls `sdlcAcceptBaseCheck` and the page reads `sdlcStartChecks` again; a refusal shows hoshin's problems as they are (R5.6); cancel records nothing. Start build stays visible and off with `start_held` as its reason (R6.2). The `build-refusal-dialog` stops being used for a build start: remove its use from `change-page.html` and the build start path, and remove `refusalOf` and `refusal` from `build-page.view-model.ts`; delete the dialog component if nothing else uses it. Add `sdlcAcceptBaseCheck(change, repo, check)` to the three transports, each with a spec. Add the new overlay to the `--route` lists of `check:boot` and `check:interaction`.

#### Tests

"shows one base failure once on the page r4.1" asserts the panel's title, reason, row, folded count, and that no dialog opens on a failed start. It fails before the change because the panel does not exist (stubbed in the test commit). Also the R4.2, R4.3 (every `Examples` row), R4.5, R5.1, R5.2, R5.3, R5.4, R5.6, R6.2 and R12.2 tests named in Scenario coverage.

#### Done when

`npm test -- --watch=false --include src/app/ui/build-failure-panel.spec.ts --include src/app/sdlc/build/build-page.view-model.spec.ts --include src/app/core/transport/mock-transport.spec.ts --include src/app/core/transport/tauri-transport.spec.ts` passes from `app/`, and `npx eslint` and `npx stylelint` on the changed files are clean.

### T16: Show a finish failure once, with run again

```yaml
id: T16
repo: kata
depends_on: [T6, T11, T15]
uses: [What the Build tab shows for a repository's start and its checks on the base]
files: [app/src/app/ui/build-finish-panel.ts, app/src/app/ui/build-finish-panel.html, app/src/app/ui/build-finish-panel.spec.ts, app/src/app/sdlc/build/build-page.html, app/src/app/sdlc/build/build-page.ts, app/src/app/sdlc/build/build-page.view-model.ts, app/src/app/core/transport/kata-transport.ts, app/src/app/core/transport/tauri-transport.ts, app/src/app/core/transport/mock-transport.ts, app/src/app/core/transport/tauri-transport.spec.ts, app/src/app/core/transport/mock-transport.spec.ts]
covers: [R7.1, R7.3]
supports: [R7.2, R12.2]
test: [node, -e, "process.chdir('app');process.argv.splice(1,0,'ng');require(require('path').resolve('node_modules/@angular/cli/bin/ng.js'))", test, --watch=false, --include, src/app/ui/build-finish-panel.spec.ts, --filter, "shows a finish failure once with what happens next r7.1"]
```

#### Change

A `BuildFinishPanel`, the same shape as the failure panel and reusing its output block, shows `StartChecks.finish` once, as the prototype's Failed at finish screen shows: the check, why it blocks, its output on request, `next` worded from the backend, the folded passed count, and one action, Run checks again, which calls `sdlcRerunFinishChecks` (added to the three transports with specs) and shows the rerun's progress line with its Stop. No accept action.

#### Tests

"shows a finish failure once with what happens next r7.1" asserts every `Examples` row of R7.1, row by row, and that no accept action renders. It fails before the change because the panel does not exist (stubbed in the test commit). "folds the checks that passed at finish r7.3" asserts the count.

#### Done when

`npm test -- --watch=false --include src/app/ui/build-finish-panel.spec.ts --include src/app/core/transport/mock-transport.spec.ts --include src/app/core/transport/tauri-transport.spec.ts` passes from `app/`, and `npx eslint` on the changed files is clean.

### T17: Ask before starting a build running elsewhere

```yaml
id: T17
repo: kata
depends_on: [T10, T13]
uses: [Whether a start of the build may be running elsewhere]
files: [app/src/app/ui/build-elsewhere-dialog.ts, app/src/app/ui/build-elsewhere-dialog.html, app/src/app/ui/build-elsewhere-dialog.spec.ts, app/src/app/sdlc/build/build-page.view-model.ts, app/src/app/sdlc/change/change-page.html, app/src/app/sdlc/change/change-page.ts, app/src/app/core/transport/kata-transport.ts, app/src/app/core/transport/tauri-transport.ts, app/src/app/core/transport/mock-transport.ts, app/src/app/core/transport/tauri-transport.spec.ts, app/src/app/core/transport/mock-transport.spec.ts, app/package.json]
covers: [R9.2]
supports: [R9.1, R12.2]
test: [node, -e, "process.chdir('app');process.argv.splice(1,0,'ng');require(require('path').resolve('node_modules/@angular/cli/bin/ng.js'))", test, --watch=false, --include, src/app/ui/build-elsewhere-dialog.spec.ts, --filter, "confirm starts and decline starts nothing r9.2"]
```

#### Change

When a start or continue returns `StartOutcome::MayBeRunningElsewhere`, the page opens `BuildElsewhereDialog` (titled `hlm-dialog`, Escape cancels), as the prototype's Already running elsewhere screen shows, worded from the outcome: "may be running in another session; starting is safe if that session crashed or was closed", or, with `running_check`, "running in another session now, on <check>". Start anyway calls the same start with `evenIfElsewhere: true`; Cancel starts nothing. The transports' start and continue methods take the flag, with specs. Add the dialog to the `--route` lists of `check:boot` and `check:interaction`.

#### Tests

"confirm starts and decline starts nothing r9.2" asserts confirm calls the start with the flag and cancel calls nothing. It fails before the change because the dialog does not exist (stubbed in the test commit).

#### Done when

`npm test -- --watch=false --include src/app/ui/build-elsewhere-dialog.spec.ts --include src/app/core/transport/mock-transport.spec.ts --include src/app/core/transport/tauri-transport.spec.ts` passes from `app/`.

### T18: Read where the change stands again on focus

```yaml
id: T18
repo: kata
depends_on: [T4, T15]
uses: []
files: [app/src/app/sdlc/change/change-page.view-model.ts, app/src/app/sdlc/change/change-page.view-model.spec.ts, app/src/app/sdlc/build/build-page.view-model.ts]
covers: [R8.2, R8.3]
supports: [R8.1]
test: [node, -e, "process.chdir('app');process.argv.splice(1,0,'ng');require(require('path').resolve('node_modules/@angular/cli/bin/ng.js'))", test, --watch=false, --include, src/app/sdlc/change/change-page.view-model.spec.ts, --filter, "a failure the change no longer holds is cleared on focus r8.2"]
```

#### Change

The change page reads the change state and `sdlcStartChecks` on opening, after any action ends, and on window focus (the focus binding T4 added), as the home does (C136). The failure is no longer a signal kept in memory: the panels always show the latest read, so a failure the record no longer holds is gone at the next read. Nothing reads on a timer.

#### Tests

"a failure the change no longer holds is cleared on focus r8.2" loads a page showing a base failure, changes the mock's answer to a build under way, fires window focus and asserts the failure is gone and the build shows under way. It fails before the change because the page does not read on focus. "reads on opening and after actions, not on its own r8.3" asserts the read count with fake timers.

#### Done when

`npm test -- --watch=false --include src/app/sdlc/change/change-page.view-model.spec.ts` passes from `app/`.

## Order and dependencies

T1 comes first: every later Rust test runs the vendored tools, which must be 1.1.0, and `checks` and `baseline` must be placed before anything calls them. T2 to T4 need only T1 and touch nothing else in the change. T5 gives the typed answers that T6, T8, T9 and T10 read; T6's `StartChecks` is the shape T7 to T9 and the panels use. T8 owns the step wording and the live list, which T10 to T14 build on. The frontend tasks come last, each after the backend task whose data it shows: T13 after T12, T14 after T8, T15 after T9, T16 after T11, T17 after T10, and T18 after T15, whose panels it reloads. There is one app, so the tasks are built one after another.

## Risks

- **Riskiest step:** T8, a timed read every two seconds across a preparation that can run 40 minutes, held on a step guard rather than a build. It is protected by `checks_poll_stops_when_the_event_ends`, which asserts the read stops on pass, failure and stop, and by keeping the timer inside `prepare` so it cannot outlive the event. T11 is next: a new way into the coordinator; it goes through the existing `Input::Status` only, and the C39, C56 and C114 coordinator tests run in its "done when".
- **What could break:** the existing start and stop flows (the refusal dialog's removal in T15, Stop moving in T13). The existing `build_host` and `change-page` specs run in each task's "done when", and the `build.finish` checks `app-build-page`, `app-interaction`, `app-boot`, `app-wiring` and `app-responsive` cover the build page as a whole. The build page's parity views change visibly (spec concern 6); `check:parity` is local only and its re-bless needs the owner's sign-off, so it is done by the engineer after the build, not by a task.
- **The installed plugin:** after T1, the Workbench on this machine blocks the AI-SDLC mode until the installed hoshin plugin is 1.1.0 (spec concern 1). The build itself runs hoshin from the plugin the session loads, which must already be 1.1.0.

## Rejected alternatives

- The live list in `BuildState`, as the spec's Design first said: no `Build` exists while a first start is being prepared, so it would have to be created early and every reader of `BuildState` would see a build with no runs. The step guard already exists from the click on and is what the page reads for the progress line.
- Reading `checks.jsonl` directly instead of the `checks` command: hoshin's `CLIENTS.md` keeps the file private, and C85 says Kata reads the plugin only through its program.
- The strip label computed in Rust as a finished string: the counts are the rule; the wording is formatting, which the architecture leaves to the ViewModel.
