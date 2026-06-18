# Kata release process — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local, Windows-only release process — `bump-version.ps1`, `build-release.ps1`, and `docs/releasing.md` — that builds the standalone `kata` CLI plus the Workbench NSIS/MSI installers in one command.

**Architecture:** Two PowerShell scripts under `scripts/` plus a maintainer doc, modelled on the andon project. `bump-version.ps1` sets the two authoritative version sources; `build-release.ps1` checks they agree, builds everything via the existing `npm run tauri:build`, and stages the three artifacts. No CI, signing, updater, or changelog automation.

**Tech Stack:** PowerShell (5.1-compatible, invokable via `pwsh` or `powershell`), the existing Tauri v2 + Cargo build (`app/` `npm run tauri:build`), `gh` for publishing.

## Global Constraints

- Verification is by execution, not unit tests (the project has no PowerShell test harness; this matches andon). Each script task runs the script and checks concrete output.
- Scripts must be PowerShell 5.1-compatible (no `??`/ternary/`&&`); write files as UTF-8 **without BOM** via `[System.IO.File]::WriteAllText(path, text, (New-Object System.Text.UTF8Encoding $false))`.
- The two authoritative version sources, which must always agree: `Cargo.toml` `[workspace.package] version` (a column-0 `version = "..."` line) and `app/src-tauri/tauri.conf.json` `version`. `app/package.json` is NOT release-authoritative.
- Tag scheme: `vX.Y.Z` (stable), `vX.Y.Z-rc.N` (pre-release). A version containing `-` is a pre-release: skip MSI (Windows Installer rejects non-numeric pre-release ids).
- Three release artifacts: `kata_X.Y.Z_x64.exe` (standalone CLI, copied from `target/release/kata.exe`), `Kata Workbench_X.Y.Z_x64-setup.exe` (NSIS), `Kata Workbench_X.Y.Z_x64_en-US.msi` (MSI, stable only).
- Scripts neither bump-then-build in one go nor tag/publish — those are separate, documented maintainer steps.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work on branch `feat/release-process` (already created).
- Run scripts in the harness with `powershell -ExecutionPolicy Bypass -File scripts/<name>.ps1 <args>` (works in the 5.1 harness; `pwsh -File ...` is equivalent where installed).

---

### Task 1: `scripts/bump-version.ps1`

**Files:**
- Create: `scripts/bump-version.ps1`

**Interfaces:**
- Produces: a script invoked `pwsh scripts/bump-version.ps1 <version>` that rewrites the version in `Cargo.toml` (`[workspace.package]`) and `app/src-tauri/tauri.conf.json`, prints `old -> new` per file, and makes no git changes.

- [ ] **Step 1: Write the script**

Create `scripts/bump-version.ps1` with exactly this content:

```powershell
#!/usr/bin/env pwsh
# Set the release version in Kata's two authoritative sources: the Cargo
# workspace package version (inherited by kata-core and kata-cli) and the Tauri
# app config. Edits files only — review the diff and commit as
# `chore: bump version to X.Y.Z`. Does not git add/commit/tag.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Version
)
$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
    Write-Error "Invalid version '$Version'. Expected X.Y.Z or X.Y.Z-prerelease (e.g. 0.2.0 or 0.2.0-rc.1)."
    exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$cargoPath = Join-Path $repoRoot 'Cargo.toml'
$tauriPath = Join-Path $repoRoot 'app/src-tauri/tauri.conf.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

# Cargo workspace version: the column-0 `version = "..."` line under [workspace.package].
$cargo = Get-Content $cargoPath -Raw
if ($cargo -notmatch '(?m)^version = "(.+?)"') {
    Write-Error "Could not find a workspace version line in $cargoPath"
    exit 1
}
$cargoOld = $Matches[1]
$cargo = $cargo -replace '(?m)^version = ".+?"', "version = `"$Version`""
[System.IO.File]::WriteAllText($cargoPath, $cargo, $utf8NoBom)
Write-Host "Cargo.toml:      $cargoOld -> $Version"

# Tauri app version: replace the exact current value to preserve JSON formatting.
$tauriRaw = Get-Content $tauriPath -Raw
$tauriOld = (ConvertFrom-Json $tauriRaw).version
$tauriRaw = $tauriRaw -replace ('"version": "' + [regex]::Escape($tauriOld) + '"'), "`"version`": `"$Version`""
[System.IO.File]::WriteAllText($tauriPath, $tauriRaw, $utf8NoBom)
Write-Host "tauri.conf.json: $tauriOld -> $Version"

Write-Host ""
Write-Host "Version set to $Version. Review the diff, then commit: chore: bump version to $Version"
```

- [ ] **Step 2: Run it on a throwaway version and verify both files change**

Run: `powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 9.9.9-test`
Expected output contains:
```
Cargo.toml:      0.1.0 -> 9.9.9-test
tauri.conf.json: 0.1.0 -> 9.9.9-test
```
Then confirm both files now hold the new version:
Run: `git diff --stat Cargo.toml app/src-tauri/tauri.conf.json`
Expected: both files listed as changed (1 line each).

- [ ] **Step 3: Verify a malformed version aborts**

Run: `powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 not-a-version`
Expected: a non-zero exit and an error containing `Invalid version 'not-a-version'`. No files changed beyond Step 2.

- [ ] **Step 4: Restore the real version and confirm a clean tree**

Run: `git checkout -- Cargo.toml app/src-tauri/tauri.conf.json`
Then: `git status --porcelain Cargo.toml app/src-tauri/tauri.conf.json`
Expected: empty output (both restored to `0.1.0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/bump-version.ps1
git commit -m "$(printf 'feat(release): add bump-version.ps1\n\nSets the version in the two authoritative sources (Cargo workspace package +\ntauri.conf.json); edits files only, no git side effects.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `scripts/build-release.ps1` + gitignore the log

**Files:**
- Create: `scripts/build-release.ps1`
- Modify: `.gitignore` (append `scripts/build-release.log`)

**Interfaces:**
- Consumes: the version sources kept in sync by `bump-version.ps1` (Task 1).
- Produces: a script invoked `pwsh scripts/build-release.ps1` (no args) that aborts on a version mismatch, builds the CLI + Workbench, and writes `target/release/kata_X.Y.Z_x64.exe` plus the NSIS (and, for stable, MSI) bundles, logging a transcript to `scripts/build-release.log`.

- [ ] **Step 1: Write the script**

Create `scripts/build-release.ps1` with exactly this content:

```powershell
#!/usr/bin/env pwsh
# Build all Kata release artifacts locally on Windows: the standalone `kata` CLI
# and the Workbench installers (NSIS + MSI for stable; NSIS only for pre-releases,
# since Windows Installer rejects non-numeric pre-release identifiers). Does NOT
# bump the version, tag, or publish. Run from the repo root.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $PSScriptRoot 'build-release.log'
Start-Transcript -Path $logPath -Force | Out-Null
$step = 'start'
try {
    # 1. Version consistency
    $step = 'version-consistency'
    $cargoPath = Join-Path $repoRoot 'Cargo.toml'
    $tauriPath = Join-Path $repoRoot 'app/src-tauri/tauri.conf.json'
    if ((Get-Content $cargoPath -Raw) -notmatch '(?m)^version = "(.+?)"') {
        throw "no workspace version line in $cargoPath"
    }
    $cargoVer = $Matches[1]
    $tauriVer = (Get-Content $tauriPath -Raw | ConvertFrom-Json).version
    if ($cargoVer -ne $tauriVer) {
        throw "version mismatch: Cargo.toml=$cargoVer tauri.conf.json=$tauriVer (run bump-version.ps1)"
    }
    $version = $cargoVer
    $isPrerelease = $version -match '-'
    $modeNote = ''
    if ($isPrerelease) { $modeNote = ' (pre-release: NSIS only, no MSI)' }
    Write-Host "Building Kata $version$modeNote"

    # 2. Pre-flight
    $step = 'pre-flight'
    foreach ($proc in @('kata', 'kata-app')) {
        if (Get-Process -Name $proc -ErrorAction SilentlyContinue) {
            throw "$proc.exe is running — close it (the linker locks the binary)"
        }
    }
    foreach ($tool in @('npm', 'cargo')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH" }
    }
    cargo tauri --version *> $null
    if ($LASTEXITCODE -ne 0) { throw "the 'cargo tauri' subcommand is unavailable (cargo install tauri-cli)" }

    # 3. Build: CLI + frontend + installer bundles
    $step = 'build'
    Push-Location (Join-Path $repoRoot 'app')
    try {
        if ($isPrerelease) {
            # `npm run tauri:build` = stage-sidecar --release && tauri build. Replicate
            # it but pass --bundles nsis (tauri runs beforeBuildCommand=npm run build itself).
            node scripts/stage-sidecar.mjs --release
            if ($LASTEXITCODE -ne 0) { throw "stage-sidecar failed" }
            npx tauri build --bundles nsis
            if ($LASTEXITCODE -ne 0) { throw "tauri build (nsis) failed" }
        }
        else {
            npm run tauri:build
            if ($LASTEXITCODE -ne 0) { throw "npm run tauri:build failed" }
        }
    }
    finally {
        Pop-Location
    }

    # 4. Stage the standalone CLI and locate the bundles
    $step = 'stage'
    $releaseDir = Join-Path $repoRoot 'target/release'
    $cliSrc = Join-Path $releaseDir 'kata.exe'
    if (-not (Test-Path $cliSrc)) { throw "CLI binary not found at $cliSrc" }
    $cliOut = Join-Path $releaseDir "kata_${version}_x64.exe"
    Copy-Item $cliSrc $cliOut -Force

    $nsis = Get-ChildItem (Join-Path $releaseDir 'bundle/nsis') -Filter '*-setup.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    $msi = Get-ChildItem (Join-Path $releaseDir 'bundle/msi') -Filter '*.msi' -ErrorAction SilentlyContinue | Select-Object -First 1

    # 5. Summary
    $step = 'summary'
    $artifacts = @($cliOut)
    if ($nsis) { $artifacts += $nsis.FullName }
    if ($msi) { $artifacts += $msi.FullName }
    Write-Host ""
    Write-Host "=== Kata $version artifacts ==="
    foreach ($a in $artifacts) {
        $f = Get-Item $a
        Write-Host ('{0,9:N0} KB  {1:yyyy-MM-dd HH:mm}  {2}' -f ($f.Length / 1KB), $f.LastWriteTime, $f.FullName)
    }
    if (-not $isPrerelease -and -not $msi) { Write-Warning "no MSI bundle found (expected for a stable release)" }
    Write-Host ""
    Write-Host "Done. Next: tag and 'gh release create' per docs/releasing.md"
}
catch {
    Write-Error "build-release failed at step '$step': $_"
    exit 1
}
finally {
    Stop-Transcript | Out-Null
}
```

- [ ] **Step 2: Gitignore the transcript log**

Append a line to `.gitignore` (create the file if it does not exist):

```
scripts/build-release.log
```

- [ ] **Step 3: Verify the version-mismatch guard aborts (fast)**

Temporarily desync the versions, run, expect abort, then restore:

Run:
```bash
powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 9.9.9 >/dev/null
# revert ONLY tauri.conf.json so the two disagree (Cargo.toml stays 9.9.9)
git checkout -- app/src-tauri/tauri.conf.json
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1; echo "exit=$?"
git checkout -- Cargo.toml
```
Expected: the build aborts before building with an error containing `version mismatch: Cargo.toml=9.9.9 tauri.conf.json=0.1.0`, and `exit=1`. Tree restored to `0.1.0`.

- [ ] **Step 4: Verify a full build produces the three artifacts (slow, ~3-6 min)**

Run: `powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1`
Expected: completes with an artifact table listing three files under `target/release/`:
- `kata_0.1.0_x64.exe`
- `Kata Workbench_0.1.0_x64-setup.exe` (under `bundle/nsis/`)
- `Kata Workbench_0.1.0_x64_en-US.msi` (under `bundle/msi/`)

Then confirm the CLI artifact runs:
Run: `./target/release/kata_0.1.0_x64.exe --version`
Expected: `kata 0.1.0`
And confirm the log was written:
Run: `test -f scripts/build-release.log && echo "log ok"`
Expected: `log ok`

- [ ] **Step 5: Commit**

```bash
git add scripts/build-release.ps1 .gitignore
git commit -m "$(printf 'feat(release): add build-release.ps1\n\nVersion-consistency check, pre-release MSI skip, pre-flight checks, one-shot\nbuild via npm run tauri:build, and staging of the standalone kata CLI +\nNSIS/MSI bundles with a transcript log. Does not bump/tag/publish.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: `docs/releasing.md` + roadmap pointer

**Files:**
- Create: `docs/releasing.md`
- Modify: `ROADMAP.md` (the "Release / packaging" cross-cutting bullet)

**Interfaces:**
- Consumes: `scripts/bump-version.ps1` and `scripts/build-release.ps1` (Tasks 1-2) by name.

- [ ] **Step 1: Write the releasing doc**

Create `docs/releasing.md` with exactly this content:

```markdown
# Releasing Kata

Kata releases are built locally on Windows and published by hand. There is no CI release pipeline, no code-signing, and no auto-updater — this is a small, single-maintainer process.

Each release publishes three artifacts:

- `kata_X.Y.Z_x64.exe` — the standalone headless CLI (CI / Shokunin / no-install use).
- `Kata Workbench_X.Y.Z_x64-setup.exe` — the Workbench GUI installer (NSIS); it bundles the `kata` CLI as a sidecar.
- `Kata Workbench_X.Y.Z_x64_en-US.msi` — the Workbench GUI installer (MSI); **stable releases only**.

## Versioning

The version lives in two authoritative places that must always agree:

- `Cargo.toml` `[workspace.package] version` (inherited by `kata-core` and `kata-cli`).
- `app/src-tauri/tauri.conf.json` `version`.

`scripts/bump-version.ps1` sets both. Tags are `vX.Y.Z` for stable and `vX.Y.Z-rc.N` for pre-releases. Bug fixes bump the patch, features bump the minor (everything is `0.x` for now). A version containing `-` is a pre-release and skips the MSI bundle.

## Cutting a release

1. Merge the feature PR(s) into `main` and pull.
2. Bump the version, review, and commit:
   ```
   pwsh scripts/bump-version.ps1 X.Y.Z
   git diff Cargo.toml app/src-tauri/tauri.conf.json
   git commit -am "chore: bump version to X.Y.Z"
   ```
3. Build the artifacts (takes a few minutes; close any running `kata.exe`/`kata-app.exe` first):
   ```
   pwsh scripts/build-release.ps1
   ```
   The artifact table at the end prints the exact paths under `target/release/`. The full transcript is in `scripts/build-release.log`.
4. Smoke-check the CLI, and optionally install the Workbench:
   ```
   ./target/release/kata_X.Y.Z_x64.exe --version
   ```
5. Tag and push:
   ```
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
6. Create the GitHub release with the artifacts and hand-written notes:
   ```
   gh release create vX.Y.Z \
     "target/release/kata_X.Y.Z_x64.exe" \
     "target/release/bundle/nsis/Kata Workbench_X.Y.Z_x64-setup.exe" \
     "target/release/bundle/msi/Kata Workbench_X.Y.Z_x64_en-US.msi" \
     --title "vX.Y.Z" --notes-file notes.md
   ```
   For a pre-release, omit the `.msi` and add `--prerelease`.

## Release-notes template

```markdown
## What's new

### <Section>
- ...

### Downloads
- **kata_X.Y.Z_x64.exe** — standalone headless CLI (no install)
- **Kata Workbench_X.Y.Z_x64-setup.exe** — Workbench installer (NSIS, recommended)
- **Kata Workbench_X.Y.Z_x64_en-US.msi** — Workbench installer (MSI; stable only)
```
```

- [ ] **Step 2: Point the roadmap's Release / packaging item at the doc**

In `ROADMAP.md`, replace this line:

```
- [ ] **Release / packaging:** decide crates.io publish vs. tagged binary releases for `kata`; ship the Tauri app artifacts for macOS/Windows. MIT.
```

with:

```
- [~] **Release / packaging:** local Windows release process in place — `scripts/bump-version.ps1` + `scripts/build-release.ps1` build the standalone `kata` CLI and the Workbench NSIS/MSI installers; tag `vX.Y.Z` and `gh release create` by hand (see `docs/releasing.md`). Still open: crates.io publish vs. tagged binaries, macOS/Linux artifacts, code-signing/CI. MIT.
```

- [ ] **Step 3: Verify the doc references resolve**

Run:
```bash
test -f scripts/bump-version.ps1 && test -f scripts/build-release.ps1 && echo "scripts present"
grep -q "docs/releasing.md" ROADMAP.md && echo "roadmap points at doc"
```
Expected: `scripts present` and `roadmap points at doc`.

- [ ] **Step 4: Commit**

```bash
git add docs/releasing.md ROADMAP.md
git commit -m "$(printf 'docs(release): add releasing.md and point the roadmap at it\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- Local PowerShell, Windows-only, andon-modelled → all three tasks. ✅
- Three artifacts (CLI + NSIS + MSI stable-only) → Task 2 stage/summary + Task 3 doc. ✅
- `bump-version.ps1` sets both sources, edits-only, validates format → Task 1. ✅
- `build-release.ps1`: consistency check, pre-release MSI skip, pre-flight, build, stage, summary, transcript log → Task 2. ✅
- Version sources = Cargo workspace + tauri.conf.json; `app/package.json` ignored → Global Constraints + Task 1 (only the two files touched). ✅
- `docs/releasing.md` 6-step procedure + notes template → Task 3. ✅
- Roadmap pointer → Task 3 Step 2. ✅
- Gitignore the log → Task 2 Step 2. ✅
- Out of scope (signing/updater/changelog/CI/cross-platform/screenshots) → nothing in the plan adds them. ✅

**Placeholder scan:** No TBD/TODO; every script and doc is given in full. ✅

**Type consistency:** `kata_${version}_x64.exe` naming, the `(?m)^version = "(.+?)"` Cargo regex, and the `version`/`isPrerelease` variables are used identically across Task 1, Task 2, and the Task 3 doc. The bundle paths (`bundle/nsis/*-setup.exe`, `bundle/msi/*.msi`) match the `gh release create` paths in `docs/releasing.md`. ✅
