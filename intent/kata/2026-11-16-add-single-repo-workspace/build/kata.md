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
