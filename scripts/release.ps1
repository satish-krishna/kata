#!/usr/bin/env pwsh
# Cut a Kata release end to end: bump the version, commit it on main, build the
# CLI and the Workbench installers, smoke-check the CLI, push main and the tag,
# and create the GitHub release with the artifacts attached. Wraps
# bump-version.ps1 and build-release.ps1; see docs/releasing.md.
#
# The release is created as a draft unless -Publish is given, so the notes can
# be written on GitHub before anyone sees it. Rerunning with the same version
# after a failed build skips the bump that already landed.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Version,
    # Hand-written release notes. Without it, GitHub generates notes from the PRs.
    [string] $NotesFile,
    # Publish the release at once instead of leaving a draft.
    [switch] $Publish,
    # Skip the confirmation before anything is pushed.
    [switch] $Yes
)
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$tag = "v$Version"
$step = 'start'

function Invoke-Checked {
    param([string] $What, [scriptblock] $Block)
    & $Block
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

function Get-WorkspaceVersion {
    if ((Get-Content (Join-Path $repoRoot 'Cargo.toml') -Raw) -notmatch '(?m)^version = "(.+?)"') {
        throw 'no workspace version line in Cargo.toml'
    }
    $Matches[1]
}

Push-Location $repoRoot
try {
    # 1. Pre-flight: a valid, newer version on an up-to-date, clean main, with
    #    the tag still free and gh signed in.
    $step = 'pre-flight'
    $target = $null
    if (-not [System.Management.Automation.SemanticVersion]::TryParse($Version, [ref] $target)) {
        throw "invalid version '$Version'; expected X.Y.Z or X.Y.Z-rc.N"
    }
    if ($NotesFile -and -not (Test-Path $NotesFile)) { throw "notes file not found: $NotesFile" }
    foreach ($tool in @('git', 'gh', 'cargo', 'npm', 'node')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH" }
    }
    Invoke-Checked 'gh auth status' { gh auth status *> $null }

    $branch = git rev-parse --abbrev-ref HEAD
    if ($branch -ne 'main') { throw "on branch '$branch'; releases are cut from main" }
    if (git status --porcelain) { throw 'the working tree is not clean; commit or stash first' }
    $current = [System.Management.Automation.SemanticVersion]::Parse((Get-WorkspaceVersion))
    if ($target -lt $current) { throw "version $Version is lower than the current $current" }
    Invoke-Checked 'git fetch' { git fetch --quiet origin main --tags }
    if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) {
        $ahead = git rev-list --count origin/main..HEAD
        $behind = git rev-list --count HEAD..origin/main
        # Ahead by one, already at the target version, is the bump commit of an
        # earlier attempt that failed before pushing.
        if (-not ($behind -eq '0' -and $ahead -eq '1' -and $target -eq $current)) {
            throw "main is $ahead ahead and $behind behind origin/main; sync it first"
        }
    }
    if (git tag --list $tag) { throw "tag $tag already exists locally" }
    if (git ls-remote --tags origin "refs/tags/$tag") { throw "tag $tag already exists on origin" }

    # 2. Bump and commit, unless an earlier attempt already did.
    $step = 'bump'
    if ($target -eq $current) {
        Write-Host "Version is already $Version; skipping the bump."
    }
    else {
        Invoke-Checked 'bump-version.ps1' { pwsh -NoProfile -File (Join-Path $PSScriptRoot 'bump-version.ps1') $Version }
        Invoke-Checked 'cargo update -w' { cargo update -w }
        $expected = @('Cargo.toml', 'Cargo.lock', 'app/src-tauri/tauri.conf.json', 'app/package.json', 'app/package-lock.json')
        $changed = git diff --name-only
        $unexpected = $changed | Where-Object { $_ -notin $expected }
        if ($unexpected) { throw "the bump touched unexpected files: $($unexpected -join ', ')" }
        Invoke-Checked 'git add' { git add -- $expected }
        Invoke-Checked 'git commit' { git commit --quiet -m "chore: bump version to $Version" }
        Write-Host "Committed: chore: bump version to $Version"
    }

    # 3. Build the CLI and the installers.
    $step = 'build'
    Invoke-Checked 'build-release.ps1' { pwsh -NoProfile -File (Join-Path $PSScriptRoot 'build-release.ps1') }

    # 4. Collect the artifacts and smoke-check the CLI.
    $step = 'smoke'
    $releaseDir = Join-Path $repoRoot 'target/release'
    $cli = Join-Path $releaseDir "kata_${Version}_x64.exe"
    $nsis = Join-Path $releaseDir "bundle/nsis/Kata Workbench_${Version}_x64-setup.exe"
    $msi = Join-Path $releaseDir "bundle/msi/Kata Workbench_${Version}_x64_en-US.msi"
    $isPrerelease = $Version -match '-'
    $assets = @($cli, $nsis)
    if (-not $isPrerelease) { $assets += $msi }
    foreach ($a in $assets) {
        if (-not (Test-Path $a)) { throw "artifact missing: $a" }
    }
    $reported = & $cli --version
    if ($LASTEXITCODE -ne 0 -or $reported -notmatch [regex]::Escape($Version)) {
        throw "the CLI reports '$reported', expected $Version"
    }
    Write-Host "CLI smoke check: $reported"

    # 5. Confirm before anything leaves this machine.
    $step = 'confirm'
    $kind = if ($Publish) { 'published' } else { 'draft' }
    if ($isPrerelease) { $kind += ' pre-release' }
    Write-Host ''
    Write-Host "About to push main and tag $tag to origin, and create a $kind release with:"
    foreach ($a in $assets) { Write-Host "  $a" }
    if (-not $Yes) {
        $answer = Read-Host 'Proceed? [y/N]'
        if ($answer -notmatch '^(y|yes)$') {
            Write-Host 'Stopped before pushing. Rerun the same command to continue.'
            exit 0
        }
    }

    # 6. Push the bump commit, then tag it and push the tag.
    $step = 'push'
    Invoke-Checked 'git push main' { git push --quiet origin main }
    Invoke-Checked 'git tag' { git tag $tag }
    Invoke-Checked 'git push tag' { git push --quiet origin $tag }

    # 7. Create the GitHub release.
    $step = 'release'
    $ghArgs = @('release', 'create', $tag) + $assets + @('--title', $tag, '--verify-tag')
    if ($NotesFile) { $ghArgs += @('--notes-file', $NotesFile) } else { $ghArgs += '--generate-notes' }
    if (-not $Publish) { $ghArgs += '--draft' }
    if ($isPrerelease) { $ghArgs += '--prerelease' }
    $url = gh @ghArgs
    if ($LASTEXITCODE -ne 0) {
        throw "gh release create failed; the tag is pushed, so create the release by hand per docs/releasing.md"
    }
    Write-Host ''
    Write-Host "Released $tag ($kind): $url"
}
catch {
    Write-Error "release failed at step '$step': $_"
    exit 1
}
finally {
    Pop-Location
}
