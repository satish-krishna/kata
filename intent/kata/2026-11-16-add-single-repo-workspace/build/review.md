---
layout: 2
---

# Review findings

## Review 1

```yaml
review: 1
reviewed_at: 2026-11-16
commits: { kata: da8bcce }
```

### F1

```yaml
id: F1
severity: medium
repo: kata
concern: spec
file: app/src/app/sdlc/home/sdlc-home.view-model.ts
line: 615
```

The spec's Out of scope promises that for a single-repo repository whose marker is not committed "this fix does not change what the Workbench offers for it", and C150 (confirmed by engineer) says a single-repo repository is set up with the plugin's setup skill, not from the Workbench. Before the change every single-repo scan stopped at the `repos.length === 0` branch; now `scan_single_repo` sets `no_repositories: false` whatever `master.committed` is, so a single-repo scan with an uncommitted marker fails `isSetUp` (`app/src/app/lib/sdlc-workspace.ts:37`) and falls through to `runSetup` at line 625, which runs a workspace setup on the picked folder (possibly the repository's parent or a folder inside it). The build log records no departure for it. What decides it: whether the plugin's program places a repository whose `.hoshin.json` is on disk but not committed as `single-repo` (`scan_single_repo` computes `committed`, which suggests it does); if so, the add flow must not run setup when `scan.layout === 'single-repo'`, decided in the backend per D1 rather than by a new frontend check, with a test.

### F2

```yaml
id: F2
severity: low
repo: kata
concern: spec
file: crates/kata-sdlc/src/workspace.rs
line: 170
```

No test asserts that `scan` sets `no_repositories` to true for a folder with no git repository: the only Rust assertions on the field are `false` (lines 465 and 474), and the R1.2 dialog test feeds a hand-written fixture. Replacing line 170 with `let no_repositories = false;` leaves every test green while the real Workbench offers Add workspace for an empty folder, breaking R1.2. The plan said the existing `scan` tests protect it, but no existing test could assert a field that did not exist; T1's test commit (`2c7f57e`) already held the real `scan` computation rather than a stub, so the stricter assertion never failed, and that was not logged as a `rule 1:` departure. What decides it: a `workspace::tests` test that scans an empty folder (or one with only plain subfolders) and asserts `no_repositories` is true.

## Review 2

```yaml
review: 2
reviewed_at: 2026-11-16
commits: { kata: bb6884a }
```
