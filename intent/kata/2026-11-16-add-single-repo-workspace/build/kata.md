---
layout: 2
---

# Build log: kata

### T1

```yaml
task: T1
commits: ["2c7f57e", "80d7786"]
red: observed
notes: |
  `scan` sets `no_repositories` from `repos.is_empty()`, counting only repositories directly inside the folder.
  `change-page.view-model.spec.ts` and `context-page.spec.ts` needed no edit: they spread a real scan and override `master_folder` only.
  No Rust code outside `workspace.rs` builds a `WorkspaceScan`; `snapshot.rs` only reads it and `app/src-tauri` only returns it.
  `no_repositories: true` is set on the two workspace-layout fixtures with an empty `repos`: the legacy-folder scan in `mock-transport.ts` and the scan in the R4.2 triage test of `sdlc-runner.spec.ts`; every other fixture, including the single-repo one in `sdlc-mock.ts`, is false.
```

### T2

```yaml
task: T2
commits: ["8c9c68f", "da8bcce"]
departure: |
  T1 Change: T1 left `no_repositories` false on two no-repository fixtures (the plan says T1 sets the dialog test's fixture to true), so T2's feature commit sets it to true in `says so and offers no Add when the folder has no git repos` (`add-workspace-dialog.spec.ts`) and `explains a folder with no repos instead of running anything` (`sdlc-home.view-model.spec.ts`); no assertion changed.
  T2 files: `app/src/app/sdlc/home/sdlc-home.view-model.spec.ts` is outside the task's file list, changed for the fixture above.
red: observed
notes: |
  In the new test the system and the master repository are both named `kata`, so the `toContain('kata')` assertion also matches the master row; it still fails before the change, because the no-repositories branch hides both.
  `sdlc-home.view-model.ts` keeps two `repos.length` uses (lines 573 and 580) for display text; a single-repo scan shows "0 repos" there, which the spec puts out of scope.
```
