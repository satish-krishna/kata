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
