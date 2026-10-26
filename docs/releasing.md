# Releasing Kata

Kata releases are built locally on Windows and published by hand. There is no CI release pipeline, no code-signing, and no auto-updater — this is a small, single-maintainer process.

Each release publishes three artifacts:

- `kata_X.Y.Z_x64.exe` — the standalone headless CLI (CI / Shokunin / no-install use).
- `Kata Workbench_X.Y.Z_x64-setup.exe` — the Workbench GUI installer (NSIS); it bundles the `kata` CLI as a sidecar. (These are the local build names; GitHub shows an uploaded asset with the space turned into a dot, `Kata.Workbench_X.Y.Z_x64-setup.exe`.)
- `Kata Workbench_X.Y.Z_x64_en-US.msi` — the Workbench GUI installer (MSI); **stable releases only**.

## Versioning

The version lives in two authoritative places that must always agree, and `build-release.ps1` refuses to build if they differ:

- `Cargo.toml` `[workspace.package] version` (inherited by `kata-core`, `kata-cli` and `kata-sdlc`).
- `app/src-tauri/tauri.conf.json` `version`, which is the version the installers carry.

`scripts/bump-version.ps1` sets both, and keeps the Workbench's npm version in step with them: `app/package.json` `version` and its two copies in `app/package-lock.json`. It does not touch `app/src-tauri/Cargo.toml` `version` (a fixed `0.1.0`; the installer does not read it). `Cargo.lock` records the workspace crates' versions, and CI builds with `--locked`, so a bump also needs `cargo update -w` to refresh the lock.

Tags are `vX.Y.Z` for stable and `vX.Y.Z-rc.N` for pre-releases. Bug fixes bump the patch, features bump the minor, breaking changes to the run-spec or event contract bump the major. A version containing `-` is a pre-release and skips the MSI bundle.

## Cutting a release

1. Merge the feature PR(s) into `main` and pull.
2. Bump the version, review, and commit:
   ```
   pwsh scripts/bump-version.ps1 X.Y.Z
   cargo update -w
   git diff Cargo.toml Cargo.lock app/src-tauri/tauri.conf.json app/package.json app/package-lock.json
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
