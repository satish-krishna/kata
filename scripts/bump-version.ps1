#!/usr/bin/env pwsh
# Set the release version in Kata's two authoritative sources: the Cargo
# workspace package version (inherited by kata-core and kata-cli) and the Tauri
# app config. Edits files only -- review the diff and commit as
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
