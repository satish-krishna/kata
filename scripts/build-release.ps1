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
            throw "$proc.exe is running -- close it (the linker locks the binary)"
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