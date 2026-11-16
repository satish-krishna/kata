---
layout: 2
source_spec: 2026-11-16-add-single-repo-workspace/spec.md
source_spec_commit: pending acceptance
system: kata
date: 2026-11-16
author: SatishKrishna Pilla
status: draft
---

# Plan: Add a single-repo repository from the Add workspace dialog

## Approach

First the backend scan says whether a folder holds no git repository, then the add flow and the dialog read that answer instead of counting sibling repositories.

## Scenario coverage

| Scenario | Test | Task |
|---|---|---|
| R1.1 | `AddWorkspaceDialog offers Add workspace for a single-repo repository, which lists no sibling repos` | T2 |
| R1.2 | `AddWorkspaceDialog says so and offers no Add when the folder has no git repos` | T2 |

## Tasks

### T1: The workspace scan says whether a folder holds no git repository

```yaml
id: T1
repo: kata
depends_on: []
uses: []
files: [crates/kata-sdlc/src/workspace.rs, app/src/bindings/WorkspaceScan.ts, app/src/app/core/sdlc/sdlc-runner.spec.ts, app/src/app/core/transport/mock-transport.ts, app/src/app/lib/sdlc-mock.ts, app/src/app/lib/sdlc-workspace.spec.ts, app/src/app/lib/sdlc.spec.ts, app/src/app/sdlc/change/change-page.view-model.spec.ts, app/src/app/sdlc/context/context-page.spec.ts, app/src/app/sdlc/home/sdlc-home.spec.ts, app/src/app/sdlc/home/sdlc-home.view-model.spec.ts, app/src/app/ui/add-workspace-dialog.spec.ts]
covers: []
supports: [R1.1, R1.2]
test: [cargo, test, -p, kata-sdlc, --lib, workspace::tests::a_single_repo_scan_is_never_without_repositories, --, --exact]
compile: [cargo, test, -p, kata-sdlc, --lib, --no-run]
```

#### Change

`WorkspaceScan` gains `no_repositories: bool`, documented as: true when the folder holds no git repository at all. `scan` sets it to whether it found no repository directly inside the folder; `scan_single_repo` sets it to false, since the repository is itself a repository though `repos` lists no siblings. Every other place that builds a `WorkspaceScan` in Rust sets it the same way. Regenerate the binding with `cargo test -p kata-sdlc --features ts export_bindings` (root `CLAUDE.md`, never hand-edit `app/src/bindings/`), then add the field to every TypeScript fixture that builds a `WorkspaceScan` (the listed spec files, `sdlc-mock.ts` and `mock-transport.ts`): `true` where the fixture has an empty `repos` in the workspace layout, `false` everywhere else, including every single-repo fixture.

#### Tests

New failing test `workspace::tests::a_single_repo_scan_is_never_without_repositories` in `crates/kata-sdlc/src/workspace.rs`: builds a single-repo repository with `crate::testutil::single_repo` and asserts that `scan_single_repo` gives `no_repositories` false while `repos` is empty. The test commit carries the field with `scan_single_repo` stubbed to true, so the test fails on its assertion. The existing scan tests (`scan_finds_immediate_repos_only` and the rest of `workspace::tests`) pass before and after and protect `scan`; assert in `scan_finds_immediate_repos_only` that `no_repositories` is false, which adds no new behavior.

#### Done when

`cargo test -p kata-sdlc workspace` passes, and the regenerated `app/src/bindings/WorkspaceScan.ts` matches what `cargo test -p kata-sdlc --features ts export_bindings` writes.

### T2: The add flow and the dialog let a single-repo repository be added

```yaml
id: T2
repo: kata
depends_on: [T1]
uses: []
files: [app/src/app/ui/add-workspace-dialog.ts, app/src/app/ui/add-workspace-dialog.html, app/src/app/ui/add-workspace-dialog.spec.ts, app/src/app/sdlc/home/sdlc-home.view-model.ts]
covers: [R1.1, R1.2]
supports: []
test: [node, -e, "process.chdir('app');process.argv.splice(1,0,'ng');import(require('url').pathToFileURL(require('path').resolve('node_modules/@angular/cli/bin/ng.js')))", test, --watch=false, --include, src/app/ui/add-workspace-dialog.spec.ts, --filter, "offers Add workspace for a single-repo repository, which lists no sibling repos"]
```

#### Change

The dialog's `canAdd` and the first branch of its template test `scan.no_repositories` in place of `scan.repos.length === 0` and `scan.repos.length > 0`. In `addWorkspace` of `sdlc-home.view-model.ts`, the branch that shows the dialog as nothing to add tests `scan.no_repositories` in place of `scan.repos.length === 0`, so a single-repo scan goes on to read its contexts and is offered like any set-up workspace. This removes the root cause named in the intent.

#### Tests

New failing test `offers Add workspace for a single-repo repository, which lists no sibling repos` in `app/src/app/ui/add-workspace-dialog.spec.ts`: renders the dialog with a candidate whose scan has `layout: 'single-repo'`, `repos: []`, `no_repositories: false`, one committed master and a marker with one system, and asserts that the text shows the system, does not contain "No git repositories found", and that the Add workspace button is present. It fails before the change because `canAdd` requires a non-empty `repos`. The existing test `says so and offers no Add when the folder has no git repos` (its fixture set to `no_repositories: true` in T1) passes before and after and covers R1.2. The `SdlcHomeViewModel` tests in `sdlc-home.view-model.spec.ts` protect the add flow for workspaces.

#### Done when

The `test` command passes, and `npm test -- --watch=false --include src/app/ui/add-workspace-dialog.spec.ts --include src/app/sdlc/home/sdlc-home.view-model.spec.ts` passes in `app/`.

## Risks

- **What could break:** adding a workspace folder, or refusing an empty one, if a fixture or the scan sets the new field wrongly; the existing dialog tests and the `SdlcHomeViewModel` add tests protect both.
