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
