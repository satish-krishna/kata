# Kata release process — design

## Problem

Kata has no release infrastructure: no `.github/`, no `scripts/`, no `docs/releasing.md`, and no git tags. Cutting a release today is ad-hoc. This adds a small, local, repeatable release process modelled on the andon project's (a sibling Tauri app): a local PowerShell build script plus a documented maintainer procedure. No CI, no signing, no updater — deliberately minimal.

## Goals

- One command builds every release artifact locally on Windows.
- The two version sources can never silently disagree.
- A maintainer follows one documented procedure to cut and publish a release.
- Faithful to andon's local, single-developer model.

## Non-goals (deliberately out of scope)

- Code-signing / notarization (no Authenticode, no Tauri signing key).
- Tauri auto-updater.
- Automated changelog / release-notes generation (notes are hand-written from a template).
- GitHub Actions / CI release pipeline (local only).
- Cross-platform release builds (Windows-only; the CLI is cross-platform but the release flow is not).
- Screenshot automation (the Workbench has `?demo=run`; andon's Puppeteer pipeline is a possible later follow-up, not part of this).

## Artifacts a release publishes

A single `npm run tauri:build` (run from `app/`) already produces everything: it builds `kata-cli` to `target/release/kata.exe`, stages it as the Workbench sidecar (`externalBin`), builds the SvelteKit frontend, and bundles the installers (`targets: "all"` → NSIS + MSI on Windows). The release publishes three artifacts:

| Artifact | Source | Notes |
|---|---|---|
| `kata_X.Y.Z_x64.exe` | `target/release/kata.exe`, copied + renamed | standalone headless CLI (CI / Shokunin / no-install) |
| `Kata Workbench_X.Y.Z_x64-setup.exe` | `target/release/bundle/nsis/...` | GUI installer (NSIS); bundles the CLI sidecar |
| `Kata Workbench_X.Y.Z_x64_en-US.msi` | `target/release/bundle/msi/...` | GUI installer (MSI); **stable releases only** |

No Workbench *portable* exe is shipped: the standalone CLI already covers the "no install" need, and the GUI without its installer offers little.

## Versioning

The two authoritative version sources, which must always agree:

- `Cargo.toml` `[workspace.package] version` (both `kata-core` and `kata-cli` inherit it via `version.workspace = true`).
- `app/src-tauri/tauri.conf.json` `version`.

`app/package.json` `version` is not release-authoritative (Tauri reads `tauri.conf.json`); the release flow ignores it.

Tag scheme: `vX.Y.Z` for stable, `vX.Y.Z-rc.N` for pre-releases. Bump policy: bug fixes → patch, features → minor (all `0.x` for now).

## Components

### 1. `scripts/bump-version.ps1`

Invoked: `pwsh scripts/bump-version.ps1 <new-version>` (e.g. `0.2.0` or `0.2.0-rc.1`).

- Validates the argument against `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`; aborts on a malformed version.
- Rewrites the `version` line in `Cargo.toml` `[workspace.package]` and the `"version"` field in `app/src-tauri/tauri.conf.json` to the new value.
- Prints `old → new` for each file.
- Edits files only — it does not `git add`/commit/tag. The maintainer reviews the diff and makes the `chore: bump version to X.Y.Z` commit themselves.

### 2. `scripts/build-release.ps1`

Invoked: `pwsh scripts/build-release.ps1` from the repo root. Steps, each named for failure reporting, with a full transcript written to `scripts/build-release.log`:

1. **Version-consistency check** — read the version from `Cargo.toml` `[workspace.package]` (regex) and `app/src-tauri/tauri.conf.json` (JSON parse); abort if they differ.
2. **Pre-release detection** — if the version contains `-`, set pre-release mode: the Workbench build skips MSI (Windows Installer rejects non-numeric pre-release identifiers) by passing `--bundles nsis`.
3. **Pre-flight** — abort if `kata.exe` or `kata-app.exe` is running (linker `Access is denied`); verify `npm`, `cargo`, and the `cargo tauri` subcommand are available.
4. **Build** — run the Workbench/CLI build from `app/` (`npm run tauri:build`, or the equivalent with `--bundles nsis` for pre-releases). This single build yields the CLI, the frontend, and the installer bundles.
5. **Stage artifacts** — copy `target/release/kata.exe` to `target/release/kata_X.Y.Z_x64.exe`; locate the NSIS bundle (and MSI for stable).
6. **Summary** — print a table of the produced artifacts (name, size, modified time, full path).

The script does not bump the version, tag, or publish — that boundary matches andon.

### 3. `docs/releasing.md`

The canonical maintainer procedure, as numbered steps with exact commands:

1. Merge the feature PR(s) to `main`.
2. `pwsh scripts/bump-version.ps1 X.Y.Z`, review the diff, commit as `chore: bump version to X.Y.Z`.
3. `pwsh scripts/build-release.ps1`.
4. Smoke-check: `./target/release/kata_X.Y.Z_x64.exe --version` (and optionally launch the Workbench installer).
5. `git tag vX.Y.Z && git push origin vX.Y.Z`.
6. `gh release create vX.Y.Z <artifacts...> --title ... --notes ...`, using the release-notes template (What's new / Downloads sections, listing the three artifacts).

### 4. Roadmap pointer

Update the "Release / packaging" cross-cutting TODO in `ROADMAP.md` to point at `docs/releasing.md` and note the local-build artifact set, so the roadmap reflects that a release process now exists.

## Verification

These are PowerShell scripts and docs, so verification is by execution, not unit tests (matching andon, which does not unit-test its release scripts):

- `bump-version.ps1`: run it to a throwaway version, confirm both files updated and `build-release.ps1`'s consistency check passes; run it with a malformed version, confirm it aborts; restore the version.
- `build-release.ps1`: run it end-to-end, confirm the three artifacts appear with correct `X.Y.Z` names and the transcript log is written; confirm a deliberately-mismatched version aborts at step 1.
- `docs/releasing.md`: every command in the procedure resolves to a real file/script/flag.

## File structure

- `scripts/bump-version.ps1` — sets both version sources (new).
- `scripts/build-release.ps1` — builds + stages the three artifacts (new).
- `scripts/build-release.log` — transcript, gitignored (new; add to `.gitignore`).
- `docs/releasing.md` — the maintainer procedure (new).
- `ROADMAP.md` — point the Release / packaging TODO at the new doc (modified).
