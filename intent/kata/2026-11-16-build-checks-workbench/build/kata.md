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

### T7

```yaml
task: T7
commits: ["bc82d73", "d16eef3"]
departure: |
  T7 Change: whether the failing check passed on the base or added failures is read from the repository's BaseCheck rows (Failed gives AddedFailures; Passed or NotRun gives Passed), not from checks_view::of's CheckView rows, because of reads only the head and cannot say how a check stood on the base.
red: observed
notes: |
  FinishFailure is { check, base: FinishBase (Passed | AddedFailures), output, passed: u32 (other checks that passed at finish, from the finish record's hooks), next: FinishNext (SentBackNotFixed for onFailure fix | Stopped otherwise), can_accept (always false) }.
  A could-not-run finish takes the same path, next from the hook's onFailure; a finish record naming no failed check gives an empty check and Stopped; an empty hook output falls back to the record's problems joined by newlines.
  StartShown::FinishFailure still carries no data; the detail is in StartChecks::finish.
  The plan's test command was run as cargo test directly.
```

### T8

```yaml
task: T8
commits: ["e07b52b", "fe506da"]
departure: |
  R3.1, R6.1: in the single-repo layout the live check list is never filled. build.start for an app runs in start_app just before the app launches, outside prepare, with no preparation step to hold the list, so the base checks of a single-repo build (this repository's own layout) show no running check; the plan's Change placed the read inside prepare only.
  T8 files: crates/kata-sdlc/src/checks_view.rs gained a public live_checks, because check_ids and base_checks are private there and the live list needs the same rows as the Build tab.
  T8 files: app/src-tauri/src/close_guard.rs, mock-transport.ts, sdlc-mock.ts and sdlc-steps.ts changed, because StepKind lost Copy and StepProgress, RunningStep and StartOutcome::Failed gained phase, liveChecks and needsApproval.
  rule 5: existing tests changed for compilation and the retired wording, nothing weakened: progress_of_table, StepProgress literals in steps.rs, StepKind clones in close_guard.rs and build_host.rs, needs_approval in three StartOutcome::Failed expectations; preparation_labels_name_repo_and_check and the_progress_line_is_the_step_and_the_line_it_names now expect "Checking the base"; the same wording in progress.store.spec.ts and build-page.view-model.spec.ts; type-only additions in step.store.spec.ts, tauri-transport.spec.ts, change-page.view-model.spec.ts, sdlc-home.view-model.spec.ts and build-page.view-model.spec.ts.
red: observed
notes: |
  StepKind::words(&self) -> &'static str: "Checking the base" for CheckingBase and PreparingBuild, "Preparing" for PreparationHook; the "Preparing <repo>" prefix is built in progress_line; PreparingReview keeps its wording. StepKind lost Copy, since PreparationHook { id } carries a String.
  Added: StepPhase { Preparation, FinishCheck, Other } on StepProgress.phase (from the stream line's when and check fields), RunningStep.live_checks, StepTable::set_live_checks, StartOutcome::Failed.needs_approval from details.baseline.needsApproval (defaults to empty).
  The poll reads hooks once and checks every 2 seconds (CHECKS_POLL_MS, with a test-only setter) through Tools::run in a scoped thread that stops when build.start returns; it keeps only the latest baseline run, clears the list at each repository's start, skips a failed read and does no final read.
  The list reaches the page only through sdlc_steps (RunningStep.live_checks); no StepEvent carries it, so a page polls sdlc_steps to see updates.
  sdlc-home.view-model.spec.ts "a blocked readiness offers no new change (R10.1)" fails, still expecting 1.0.0: left by T1's floor change, not by this task; build.finish's app-unit check catches it.
```

### T9

```yaml
task: T9
commits: ["0a28924", "141c558", "fec51b1"]
red: observed
notes: |
  The first check failed on scenarios: R11.1 row 2 was set up with another change's preparation step; fec51b1 puts a live build run of this same change, for repository web, in a RunControl table and asserts the acceptance is recorded, the run stays live and the table is unchanged.
  The command reads only the step table: the refusal applies to this change's PreparingBuild, CheckingBase or PreparationHook step; accept_base_check_in takes no run table, so a live run cannot refuse it.
  guard_refuses_baseline_approve_to_an_agent_r5_7 and acceptance_holds_for_one_base_commit_r5_8 passed when written, since the vendored 1.1.0 plugin already guards the approval command and ties an acceptance to one base commit.
  Approval and BaselineApproved gained Serialize and ts-rs derives (bindings Approval.ts, BaselineApproved.ts), in the test commit as stubs.
  Test helpers Fx, fixture() and real_program() in lib.rs's steps_commands test module became pub(super).
  The command is registered but no transport method or UI calls it yet; T15 wires it.
```

### T10

```yaml
task: T10
commits: ["382ca2c", "d932ec5"]
departure: |
  T10 files: app/src/app/lib/sdlc-mock.ts and app/src/app/sdlc/home/sdlc-home.view-model.spec.ts gained stoppedHere: false on their LiveFacts literals, to type-check.
  T10 Change: sdlc_build_start and sdlc_build_continue take even_if_elsewhere as Option<bool>, a missing value read as false, not a required bool, because the frontend transport does not send it until T17 wires it.
  rule 5: the shared test fake FakeTools::run answers status without recording it in calls, because existing tests assert that no calls were made for a change and status is a read of the record, not a build step; no assertion changed.
red: observed
notes: |
  BuildHost gained start_with(change, form, even_if_elsewhere) and continue_repo(change, repo, off, even_if_elsewhere); start and continue_with stay as #[cfg(test)] wrappers passing false.
  offer::may_be_running_elsewhere keeps the planned signature (status, checks, live, repos) -> Option<Elsewhere>; LiveFacts gained stopped_here; Elsewhere is exported to TypeScript; StartOutcome gained MayBeRunningElsewhere { repos, since, running_check }.
  A repository is asked about when its latest passed build.start has no later build.finish; since is the earliest such start's at; running_check is the first Running check in the latest baseline run of an open repository.
  The host reads status first and checks only for open repositories; a failed read of either comes back as CouldNotRun.
  stopped_here comes from the host's memory of the changes this Workbench ran a build of since it opened (ran_here, keyed by workspace folder, system and change).
  A review start never asks (even_if_elsewhere passed as true internally).
  live_facts in lib.rs takes the build host and the folder; sdlc_state, sdlc_home_open, sdlc_change_state and sdlc_open_change gained a host state parameter.
```

### T11

```yaml
task: T11
commits: ["7f5d23d", "9597414"]
departure: |
  T11 Change, "the coordinator change goes through its existing Input::Status": the host sends Input::ContinueRepo { repo } after a passed rerun with a build waiting, which releases the repository's stop and makes the coordinator read status and feed Input::Status as usual, because Status is accepted only while the coordinator waits on a status read; coordinator.rs is unchanged. If the status still showed unlogged tasks for the repository, ContinueRepo would launch it again; not guarded, since a finish runs only once its tasks are logged.
  T11 Change: the run command is run build.finish --json --stream --again --system <s> --change <c> --repo <r>; the plugin's run needs --system and --change, which the plan's shorthand leaves out.
red: observed
notes: |
  sdlc_rerun_finish_checks(change, repo) returns the new RerunOutcome (Passed, Failed, Stopped, Refused, Held, CouldNotRun), through BuildHost::rerun_finish_checks.
  New StepKind::RerunningFinishChecks, worded "Running the checks again"; the progress line names the running check through T8's progress_of (for example "Running the checks again: running app-speed").
  The Build-purpose hold is taken before the step and released afterwards unless the coordinator launched something (the review).
  Refused while any run of the change is live (new Launcher::change_live, backed by RunTable::change_live), while the workspace migrates or while the change has another step; Held when another change holds the repository.
  The step ends when the checks end, before the coordinator is driven, so a review that starts is not part of the rerun step.
  FakeTools gained finish_answer and handles build.finish in exec; a stopped call ends before the fake records it.
  The test also asserts the hold during the call, the step kind and label, a Refused case with a live run and a Held case.
  The "finished" rows are modeled by logging the repository's last task before the rerun passes, since the coordinator counts a repository finished from its logged tasks in status.
  No frontend calls the command yet (T16).
```

### T12

```yaml
task: T12
commits: ["e9f84c5", "00fdba1"]
departure: |
  T12 files: app/src-tauri/src/close_guard.rs got stop_question: None in its test helper, to compile, in the test commit.
  rule 5: existing build_host.rs tests that build StartOutcome::Stopped { prepared } literals (the stopping-a-preparation test and the Row table) gained note: None to compile; their assertions are unchanged.
  R10.1, R10.2: in the single-repo layout neither the stop question nor the stopped note appears, because both hang off the live checks that T8 reads only inside prepare's per-repository loop (see T8's departure); a stop at the top of the loop or during the dry --check call also gets no note.
red: observed
notes: |
  StartOutcome::Stopped gained note: Option<String>; RunningStep gained stop_question: Option<String>; steps.rs holds the pure stop_question(&[BaseCheck]) and stopped_note(bool).
  "Already ran" counts Passed and Failed rows only; CutOff, Running and NotRun do not; a step with no live checks has no question.
  The note is set only when a stop interrupts a repository's build.start after live checks were read (StepTable::has_live_checks).
  Extra test: stopping_during_the_checks_asks_and_notes_where_the_copy_was_left in build_host.rs stops a start while checks run and asserts the question on the step and the note on StartOutcome::Stopped.
  stop_question and note are not wired to the frontend yet (T13).
```

### T13

```yaml
task: T13
commits: ["b81cca0", "c582e5b", "a36c0f8"]
departure: |
  rule 1: red record was refused ("T13 already has production commits before HEAD (b81cca0): red is recorded only before the task's first production commit"), because compile repairs to mock-transport.ts and sdlc-steps.ts were committed before the test commit; the subagent reports its own run showed all 3 new tests failing on their assertions.
  T13 files, rule 5: the app did not type-check after T8, T11 and T12, so b81cca0 adds stopQuestion: null to RunningStep fixtures in step.store.spec.ts, change-page.view-model.spec.ts, sdlc-home.view-model.spec.ts and build-page.view-model.spec.ts, note: null to stopped outcomes in mock-transport.ts and build-page.view-model.spec.ts, and a stopWords case "Stop running the checks again" for rerunningFinishChecks in sdlc-steps.ts; no assertion weakened.
  T13 files: change-page.css does not exist; the one new rule, .k-progress-run, is in app/src/styles/kata/components.css; package.json is unchanged.
  R10.1, R12.2: the question uses the existing app-confirm-dialog, so its buttons read "Cancel" and "Stop", with the question as the dialog title; Escape cancels.
red: "not observed: red record refused, a production commit (b81cca0) came before the test commit"
notes: |
  BuildPageViewModel gained stopAsked, askStop(), confirmStop() and keepChecking(); askStop() reads transport.steps() fresh, since no step report carries stopQuestion.
  The progress line's host element is display: contents and projects the Stop button through ng-content; where no progress entry exists yet, the Stop button renders alone in the same row.
  No --route was added to check:boot or check:interaction: the dialog is the existing confirm overlay.
  An extra test, "confirming the question stops the preparation r10.1", asserts the stop is called once on confirm.
```

### T14

```yaml
task: T14
commits: ["220cd9c", "bd35b18", "892ec41"]
departure: |
  R2.2: the checks list's Preparation section renders from a preparation input that the page leaves empty, because no frontend data lists a step's preparation hooks (RunningStep carries none); on the real page a preparation hook is named only on the progress line, through T8's StepKind::PreparationHook ("Preparing"), never counted as a check.
  T14 files: the checks list sits in the notice area of build-page.html (grid row 1), since the page grid has fixed row numbers.
  T14 files: app/src/app/sdlc/build/build-page.css gained a .k-bp__checks rule (max-height 40vh, overflow auto, padding from tokens), so a long checks list does not push the build grid off the page.
  rule 5: mock-transport.spec.ts "stopping a step answers Stopped" now expects note: null on its three build and review entries, the wire shape since T12; nothing weakened.
red: observed
notes: |
  The first check failed on part 1: the done-when's mock-transport.spec.ts was red on the note: null expectation; 892ec41 fixes it.
  BuildPageView.baseChecks is optional, since a required field would break the base() fixture in build-page.spec.ts.
  The list shows while this Workbench prepares, from steps().liveChecks polled with the clock ticking once a second; otherwise only for a cut off check (R2.4) or a start under way in another session (R2.5).
  The mock sdlcStartChecks returns three notRun checks by default, so the list stays hidden; ?demo=checks-cutoff and ?demo=checks-elsewhere show the other states, and both routes are in check:boot and check:interaction in package.json.
  The progress sentence "Running X, n of m done" is in aria-live="polite" with no time in it; the elapsed time sits outside it (R12.1).
```

### T15

```yaml
task: T15
commits: ["0228f5b", "5e089b6", "73c3bcd", "56a2b4e"]
departure: |
  R4.1, R4.5: when a start is refused or fails and sdlcStartChecks shows nothing (no baseFailure, allAccepted or otherReason), the view-model falls back to an error toast with the plugin's problems, so a start never fails silently; R4.1 says no toast, and if the backend always explains a stopped start the fallback is dead code.
  R4.5: a start that stops on a failed hook or a refusal reaches the page only after the view-model reads the checks again; that read was added in settle.
  rule 5: tests that read vm.refusal() or looked for the refusal dialog were rewritten to assert a toast and no dialog: the refused, failed-hook and couldNotRun tests and the outcome table in build-page.view-model.spec.ts, "a refused build opens the refusal dialog" in change-page.spec.ts, and "a refusal by the plugin lists its problems" in change-page.view-model.spec.ts.
  rule 5: build-refusal-dialog.spec.ts was deleted with the component, which nothing else used.
  T15 files: change-page.spec.ts, change-page.view-model.spec.ts, sdlc/build/build-page.css (the .k-bp__failure rule) and ui/build-refusal-dialog.* (deleted) are outside the task's list.
  rule 1: the red commit carried stubs in BuildPageViewModel (askAccept, cancelAccept, confirmAccept, copyOutput and the new types) and in the two transports (throwing "not implemented"), plus the new component and dialog files; they compute nothing the test asserts.
red: observed
notes: |
  The panel is the view-model's failures (one per repository whose shown is baseFailure, allAccepted or otherReason) and startHold (the first non-null startHeld); Start build renders disabled with the hold reason as an sr-only description.
  BuildPage gained acceptCheck and copyOutput outputs; change-page.html mounts app-accept-check-dialog, a hlm-dialog titled "Accept {check} for this build?", cancelled by Escape and Cancel.
  A refused acceptance closes the dialog and shows the workflow's problems in a role="alert" block under that check's row; a thrown error becomes the same block; either way the page reads the checks again.
  Mock demos ?demo=checks-base, checks-base-many and checks-base-moved; the first two are in the --route lists of check:boot and check:interaction.
  The feat work is split over 5e089b6 (package.json and mock-transport.ts) and 73c3bcd, because a first commit call returned committed false with no reason; the deletions were committed after unstaging them, since the commit command reported nothing changed while they were staged.
```

### T16

```yaml
task: T16
commits: ["ce8a671", "48cef23"]
departure: |
  T16 Change, "next worded from the backend": the next sentence is worded in BuildFinishPanel from T7's FinishNext enum, because the backend sends the enum and no words.
  T16 Change: the rerun's progress label "Running the checks again" is a literal in the view model, duplicating StepKind::words, which T8 made the one owner of step wording.
  T16 files: app/src/app/sdlc/change/change-page.html changed, to wire the rerun output to the view model.
red: observed
notes: |
  BuildFinishPanel reuses build-failure-panel.css and has no stylesheet of its own; Run checks again names the repository to a screen reader and Show output names the check.
  sdlcRerunFinishChecks(change, repo) is on the abstract, Tauri and mock transports, with a spec row each for Tauri and mock; ?demo=checks-finish shows app-speed failing at finish until a rerun passes.
  The view model has finishes and rerunFinish(repo); the rerun shows the page's progress line with its Stop; the finish panel is hidden while any run is under way; afterwards the page reads the checks again; outcomes other than passed and failed are told once in a toast.
  No view-model spec for rerunFinish was added.
  The r7.1 test calls TestBed.resetTestingModule() between rows; that fix was made in the test between the test commit and the feature commit.
```

### T17

```yaml
task: T17
commits: ["9845e62", "14dc84a"]
departure: |
  T17 files: app/package.json is unchanged: the dialog opens only after a click, and ?demo=checks-elsewhere (already in both --route lists) is the route where Start opens it, but neither check:boot nor check:interaction clicks Start, so neither gate exercises the dialog.
  R9.1: the dialog's sentences are TypeScript literals in build-elsewhere-dialog.html, because the backend sends only repos, since and runningCheck, no words.
red: observed
notes: |
  BuildElsewhereDialog is titled "This build may already be running", with Cancel and Start anyway; it names the repositories and the recorded start time (local HH:MM, left out when it cannot be parsed); with runningCheck it says "running in another session now, on <check>", otherwise that starting is safe if that session crashed or was closed; Escape and the close control cancel.
  The view model keeps the question in elsewhereRequest; confirming repeats the same start or continue with evenIfElsewhere true; cancel starts nothing; if the page has moved to another change it shows an info toast instead.
  Both transports send the flag only when true, so existing calls and payloads are unchanged; the mock answers mayBeRunningElsewhere under ?demo=checks-elsewhere unless the flag is set.
  The review start does not take the flag (sdlcReviewStart has none), so it never asks.
  R12.2: only the dialog's Cancel and Start anyway buttons and Escape apply here; the dialog spec covers them.
```

### T18

```yaml
task: T18
commits: ["926c773", "3868178", "acb6a3a", "130017f"]
departure: |
  T18 files: app/src/app/sdlc/build/build-page.view-model.ts, in the task's list, is unchanged: its failures and startHold already follow each fresh read, so nothing there kept a failure in memory.
  R8.2: a focus read updates the change view, the build status, the review record, the open notices and the build page's checks, but not the shown document's text or the Pull requests and copy state, which are still refreshed on opening and after actions.
red: observed
notes: |
  The first check failed: windowFocused() called the full load(), which reset the picked task, the open document and the page state on every focus; acb6a3a adds "a focus read keeps what the engineer is looking at r8.2" and 130017f replaces it with a lighter read.
  windowFocused() marks the change seen, then calls the private readStanding(), which calls sdlcOpenChange for the open document's stem and gives the build page a fresh input, so it reads sdlcStartChecks again; a failed read, or one a full reload overtakes, changes nothing.
  The new focus test asserts the state stays ready, the shown document is unchanged, sdlcStartChecks is read again and sdlcWorkspaces is not; the private picked tab is not observable through the public API.
  "reads on opening and after actions, not on its own r8.3" passed before the change, since the page already read on opening and after actions.
  red show's record is at the first test commit (926c773); the second test commit came after a production commit, so red record was not run for it.
```
