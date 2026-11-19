#!/usr/bin/env pwsh
# Cut a Kata release end to end: bump the version, capture the README
# screenshots, commit both on main, build the CLI and the Workbench installers,
# smoke-check the CLI, push main and the tag,
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

# The README's gallery against docs/images: every image shown, and every image
# the README shows present. Returns one line per problem.
function Get-ReadmeImageProblems {
    $readme = Get-Content (Join-Path $repoRoot 'README.md') -Raw
    $files = Get-ChildItem (Join-Path $repoRoot 'docs/images') -Filter *.png | ForEach-Object { "docs/images/$($_.Name)" }
    $shown = [regex]::Matches($readme, 'docs/images/[^)\s]+\.png') | ForEach-Object { $_.Value } | Sort-Object -Unique
    @($files | Where-Object { $_ -notin $shown } | ForEach-Object { "not in README.md: $_" }) +
    @($shown | Where-Object { $_ -notin $files } | ForEach-Object { "in README.md but missing: $_" })
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
    $problems = Get-ReadmeImageProblems
    if ($problems) { throw "the README gallery does not match docs/images:`n  $($problems -join "`n  ")" }
    if (git tag --list $tag) { throw "tag $tag already exists locally" }
    if (git ls-remote --tags origin "refs/tags/$tag") { throw "tag $tag already exists on origin" }

    # 2. Bump, unless an earlier attempt already did.
    $step = 'bump'
    $bumped = $false
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
        $bumped = $true
    }

    # 3. Capture the README screenshots. They run after the bump because their
    #    footer shows the version from app/package.json.
    $step = 'screenshots'
    Push-Location (Join-Path $repoRoot 'app')
    try { Invoke-Checked 'npm run screenshots' { npm run screenshots } }
    finally { Pop-Location }
    # Everything not staged by the bump: tracked files changed and new files.
    $touched = @(git diff --name-only) + @(git ls-files --others --exclude-standard)
    $images = @($touched | Where-Object { $_ -like 'docs/images/*' })
    $stray = $touched | Where-Object { $_ -notlike 'docs/images/*' }
    if ($stray) { throw "the screenshots touched files outside docs/images: $($stray -join ', ')" }
    # A view added since the last release has a new image the README lacks.
    # Pre-flight proved the tree clean, so resetting it drops only this run's
    # bump and screenshots, and the rerun starts from a clean main again.
    $problems = Get-ReadmeImageProblems
    if ($problems) {
        git reset --quiet --hard HEAD
        git clean --quiet -f -- docs/images
        throw "the README gallery does not match the new screenshots; add them to README.md, commit, and rerun:`n  $($problems -join "`n  ")"
    }
    if ($images) { Invoke-Checked 'git add images' { git add -- docs/images } }

    # 4. Commit the bump and the screenshots together. On a rerun whose bump is
    #    still unpushed, refreshed screenshots join that commit; once the bump is
    #    on origin they go in a commit of their own.
    $step = 'commit'
    if ($bumped) {
        Invoke-Checked 'git commit' { git commit --quiet -m "chore: bump version to $Version" }
        Write-Host "Committed: chore: bump version to $Version ($($images.Count) screenshot(s) changed)"
    }
    elseif ($images) {
        if ((git rev-list --count origin/main..HEAD) -eq '1') {
            Invoke-Checked 'git commit --amend' { git commit --quiet --amend --no-edit }
            Write-Host "Added $($images.Count) refreshed screenshot(s) to the unpushed bump commit"
        }
        else {
            Invoke-Checked 'git commit' { git commit --quiet -m "docs: refresh screenshots for $Version" }
            Write-Host "Committed: docs: refresh screenshots for $Version"
        }
    }
    else {
        Write-Host 'Screenshots unchanged.'
    }

    # 5. Build the CLI and the installers.
    $step = 'build'
    Invoke-Checked 'build-release.ps1' { pwsh -NoProfile -File (Join-Path $PSScriptRoot 'build-release.ps1') }

    # 6. Collect the artifacts and smoke-check the CLI.
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

    # 7. Confirm before anything leaves this machine.
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

    # 8. Push the bump commit, then tag it and push the tag.
    $step = 'push'
    Invoke-Checked 'git push main' { git push --quiet origin main }
    Invoke-Checked 'git tag' { git tag $tag }
    Invoke-Checked 'git push tag' { git push --quiet origin $tag }

    # 9. Create the GitHub release.
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
