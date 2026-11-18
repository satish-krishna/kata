---
layout: 2
---

# Build log: kata

### T1

```yaml
task: T1
commits: ["b6e4547", "18d981a"]
departure: |
  T1 files: six frontend specs outside the task's list (app.spec.ts, doc-notice.spec.ts, change-page.fix.spec.ts, change-page.notice.spec.ts, change-page.spec.ts, sdlc-home.view-model.spec.ts) had their hard-coded floor sentence changed from 1.0.0 to 1.1.0, so they do not go stale; not run in the task, left to build.finish's app-unit check.
  rule 5: existing assertions in plugin_version_reads_plugin_json_r2_5 and readiness_rows changed as the task asks: the versions standing for "meets the floor" moved from 1.0.0 to 1.1.0 and the rc1 fixture became 1.1.0-rc1; nothing weakened, skipped or deleted.
red: observed
notes: |
  new-change-dialog.ts is at app/src/app/ui/new-change-dialog.ts, not under sdlc/; only a doc comment there named 1.0.0.
  format_conformance.rs needed no edit: both its version assertions use MIN_VERSION, which the vendored VERSION file (now 1.1.0) satisfies.
  The vendored tools came from D:\workspaces\hoshin at tag v1.1.0.
```

### T2

```yaml
task: T2
commits: ["9317284", "b92ad5d"]
red: observed
notes: |
  StripCounts fields are u32 (number in the binding); EntryKind derives no Serialize or TS, since only StripCounts crosses to the frontend.
  strip_counts_by_kind_r13_1 also covers an empty strip (zero counts) and one kind_of assertion per EntryState variant.
  later_run_brings_the_change_back_r14_2 passed once written, as the plan says.
```

### T3

```yaml
task: T3
commits: ["196530d", "1239feb", "b6f9e01"]
departure: |
  rule 1: the red commit carries zero-valued counts stubs in running-strip.view-model.ts and mock-transport.ts beyond tests, because T2 made counts required on RunningStrip and nothing compiled without it; they compute nothing the test asserts.
  T3 files: app/src/app/core/transport/tauri-transport.spec.ts got counts on its fixture (compile fix only).
  rule 5: app/src/app/sdlc/running-changes.spec.ts (outside the task's files) got counts on its strip helper, and its "All running lists every entry" test now looks for "4 running · 1 needs you" instead of "All running (5)", since the old label no longer exists.
  T3 files: app/scripts/check-change-toolbar.mjs now expects the list button to read "1 needs you" (its fixture asks a question), so check:responsive does not fail on the old label; the gate was not run in the task.
red: observed
notes: |
  The label is computed in RunningStripViewModel, as the plan's Change says; the R13 tests mount the real view-model with a fake transport and pass its label into the component.
  With every count zero the label is '' and no button renders, through the template's existing all().length guard.
  The mock strip in mock-transport.ts computes counts from entry states with the same table as T2.
  The outer group's aria-label="Running changes" is unchanged; only the list was renamed.
```

### T4

```yaml
task: T4
commits: ["124d95a", "2e54d00"]
red: observed
notes: |
  R14.1's two "on another page" rows have no test on the change page, as the plan's Change and Tests say: the page is not shown there and calls nothing; the backend's OpenedMarks rule is guarded by T2's later_run_brings_the_change_back_r14_2.
  WindowFocus (root-provided, wraps document.hasFocus()) is declared in change-page.view-model.ts; windowFocused() is bound through host '(window:focus)' in change-page.ts.
  "A run ends" means this change's own ChangeRunStore session finishing, or the backend build ending; for the build the page reads the change again before marking it seen.
  The unfocused row asserts "not called" right after the run ends without waiting, so it would not catch a late asynchronous call.
```

### T5

```yaml
task: T5
commits: ["f8b2142", "d7e61e9"]
departure: |
  Shared decision "What hoshin's checks and baseline answers hold": Program::checks, baseline_show and baseline_approve take place: &Place first (checks(&self, place, change, repo)), like Program::status, because run needs the place; the plan's signatures leave it out.
red: observed
notes: |
  Approval { hook, base } is the inner value of BaselineApproved.approved: Option<Approval>.
  ChecksAnswer and BaselineShow carry no problems field: a non-empty problems on either becomes ProgramError::CouldNotRun with the problems joined by "; "; on approve, BaselineApproved.problems is the answer itself, and a refused approve (exit 1) comes back as JSON.
  Extra tests: checks_with_problems_is_an_error and baseline_show_with_problems_is_an_error.
  The types derive Deserialize, Clone, Debug, PartialEq and Eq, and Default on the answers.
```

### T6

```yaml
task: T6
commits: ["1953383", "b522d0e"]
departure: |
  Shared decision "What the Build tab shows for a repository's start": start_checks is start_checks(program: &Program, place: &Place, system: &str, change: &str, repos: &[String]), not (program, change: &ChangeRef, repos), because ChangeRef lives in kata-app, which kata-sdlc cannot depend on, and Program needs a Place; it matches checks_view::for_change.
  T6 Change: FinishFailure is a placeholder { check, output } and finish is always None, since T7 owns its shape.
red: observed
notes: |
  StartShown::OtherReason carries { reason, step: Option<String>, output }; every other variant carries no data, and the finish detail is in StartChecks::finish.
  A start that did not pass is "stopped on the base" only when details.baseline.failing is non-empty; anything else (no details.baseline for R11.2, refused, could-not-run, step failed) is OtherReason. baseline show is read only in the stopped-on-base case.
  BaseMoved is detected when the recorded details.baseline.base differs from baseline show's current base, and returns an empty checks list.
  checks lists every blocking before hook of build.finish for the repository in hook-list order; a check's state comes from the latest baseline-phase run in checks, else its baseline show result, else NotRun; could-not-run counts as Failed.
  A build.finish record that is not after the latest build.start is ignored; a refused finish reads as UnderWay.
  setup_hint is true only for BaseFailure and counts checks that are can_accept or accepted, so the hint stays steady while the engineer accepts them one by one.
  sdlc_start_checks(change: ChangeRef) takes the repository list from state.tasks keys, as sdlc_checks_view does. Generated bindings: BaseCheck, BaseCheckState, FinishFailure, StartChecks, StartShown.
```
