# M7 — `kata bundle` design

A self-contained bundle vendors the skills/plugins a spec needs into one portable folder, so a destination (CI, another machine, Shokunin) can run the spec with **nothing pre-installed**. Day-to-day specs stay reference-by-name; bundling is the explicit hand-off form.

- Roadmap: `ROADMAP.md` → Phase 3 → M7.
- Origin: the launcher design spec already seeds this (`docs/superpowers/specs/2026-06-12-kata-launcher-design.md:121-123`, and "bundle/vendor output" as a test target at `:187`).

## Goal and non-goals

**Goal:** `kata bundle <spec>` produces a portable folder containing the spec plus a vendored copy of every resolved skill/plugin; `kata run <bundle>` executes it hermetically, discovering the kit only from the bundle.

**Non-goals (M7):**
- **No workdir portability.** `workdir` stays `spec.workdir`, untouched. A stale absolute path in a foreign CI checkout is a general spec-portability concern (it affects any shipped spec, bundle or not), not a kit-vendoring concern. A `--workdir` override, if ever wanted, is a separate `kata run` convenience — out of scope here.
- **No re-resolution at run time.** The vendored `.claude` tree is the source of truth for what runs; the manifest is descriptive only.
- **No merging with the destination's own `.claude`.** A bundled run is deliberately hermetic (see "Why hermetic").

## Why hermetic (the key insight)

Every run is launched `--bare` with `--plugin-dir <assembled-temp-dir>` and `cwd = spec.workdir` (`crates/kata-core/src/command.rs:17,37,63`). Two facts follow:

1. **`--bare` is an empty room.** claude does not auto-load `~/.claude` or `<cwd>/.claude`. The only skills/plugins in the room are those Kata copied into the assembled `--plugin-dir`. A repo's local `.claude` never silently joins a run — it joins only if selected in the spec and copied in by `assemble`.
2. **Kit source and cwd are independent axes.** The kit comes from discovery → assembly; cwd is the repo being edited. They are decoupled in the code.

So a bundled run discovers its kit *only* from the bundle's vendored `.claude` and never touches the destination repo's `.claude`. This avoids clobbering a repo's existing `.claude/`, and it preserves reproducibility: the result does not depend on whatever happens to live in the target repo. "Want hermetic → bundle; want the repo's local skills → don't bundle" is the clean separation.

| | Kit source (what's in the room) | cwd (what gets edited) |
|---|---|---|
| `kata run spec.toml` | discover `~/.claude` + `<workdir>/.claude` → select → assemble | `spec.workdir` |
| `kata run bundle/` | discover `<bundle>/.claude` **only** → assemble | `spec.workdir` |

## Bundle layout

A `.claude`-shaped vendored tree, chosen so the consume side reuses the existing pipeline with only a different discovery root.

```
<spec-name>-bundle/
  kata-bundle.toml        # marker + provenance manifest
  spec.toml               # the run-spec, copied verbatim
  .claude/
    skills/<name>/...      # each vendored skill dir
    plugins/<name>/...     # each vendored plugin dir (its own skills/.mcp.json travel with it)
```

A plugin's bundled skills (`provides`) and `.mcp.json` ride along inside the copied plugin dir automatically — no special handling.

## The `bundle` command (produce)

`kata bundle <spec> [-o <dir>] [--force]`

1. Load + validate the spec (same load/validate as `run`; reuse exit-code semantics: load/parse error → 2, validation failure → 1).
2. Discover the catalog exactly as `run` does today (`DiscoveryRoots::defaults(cwd)` → `discover`).
3. **Resolve** each named skill/plugin against the catalog. This is the resolution step factored out of `assemble` (see "Refactor" below); a missing name is the same `NotFound` failure `assemble` raises today.
4. Copy each resolved entry dir into `<out>/.claude/skills/<name>/` or `<out>/.claude/plugins/<name>/` via `fsutil::copy_dir`.
5. Copy the spec verbatim to `<out>/spec.toml`.
6. Write `<out>/kata-bundle.toml` (marker + manifest).

- **Default output dir:** `./<spec-name>-bundle/` (spec `name`, slugified if needed).
- **Overwrite:** error if `<out>` exists and is non-empty, unless `--force`. Never silently clobber.

## The manifest (`kata-bundle.toml`)

Does double duty: the auto-detect marker **and** a provenance record. Descriptive, not authoritative — `run` needs only its existence to recognize a bundle; the actual kit is discovered from the `.claude` tree.

```toml
# kata-bundle.toml
tool_version = "<kata-cli version>"

[[entry]]
kind = "skill"        # "skill" | "plugin"
name = "triage-flaky-test"
source = "user"        # original scope: "user" | "project"
path = "/Users/.../.claude/skills/triage-flaky-test"   # original absolute path

[[entry]]
kind = "plugin"
name = "github-tools"
source = "project"     # scope is recorded for plugins too, not a constant "plugin"
path = "/repo/.claude/plugins/github-tools"
```

## Running a bundle (consume)

`kata run <path>` gains bundle-awareness with no new run path:

- If `<path>` is a directory containing `kata-bundle.toml`, it is a bundle: load `<path>/spec.toml`, build `DiscoveryRoots { user_dir: <path>/.claude, project_dir: <nonexistent> }`, then proceed through the **identical** `discover → assemble → build_invocation → run` pipeline.
- Otherwise `<path>` is treated as a spec file exactly as today.

The marker file is the sole disambiguator — a directory with `kata-bundle.toml` is a bundle; anything else is a spec path. No heuristics.

## Refactor: one resolver, two destinations

Today `assemble` (`crates/kata-core/src/assemble.rs`) both **resolves** (spec names → catalog entries, with `NotFound`) and **copies** into a throwaway temp `plugindir`. Factor the resolution into a reusable step:

- A `resolve(spec, catalog) -> Result<Vec<ResolvedEntry>, AssembleError>` that maps each skill/plugin name to its `CatalogEntry` (or `NotFound`), where `ResolvedEntry` carries `kind`, `name`, and source `path`.
- `assemble` consumes the resolved list and copies into the temp `plugindir` (unchanged behavior, RAII cleanup).
- `bundle` consumes the same resolved list and copies into the persistent `<out>/.claude` tree, and uses the resolved metadata to write the manifest.

This keeps a single resolution path (same selection, same error) feeding both the disposable kit and the durable bundle.

## CLI surface

- `kata bundle <spec> [-o <dir>] [--force]` — new subcommand.
- `kata run <path>` — `path` may now be a spec file (as today) or a bundle directory.

Exit codes preserved: load/parse → 2, validation → 1, bundle write/io error → 2; `run` leash codes unchanged (125/124/130).

## Testing

Engine (`kata-core`, TDD):
- `resolve`: returns the right entries for selected names; `NotFound` for a missing name (shared by `assemble` and `bundle`).
- `bundle`: given a spec + fixture catalog, the output tree has `spec.toml`, `kata-bundle.toml`, and `.claude/skills/<name>/SKILL.md` / `.claude/plugins/<name>/plugin.json` for each selection; the manifest lists each entry with correct `kind`/`name`/`source`/`path`.
- `bundle` overwrite: errors on a non-empty existing dir; succeeds with `--force`.
- bundle-aware discovery: pointing `DiscoveryRoots` at a bundle's `.claude` yields exactly the vendored entries (no user/project leakage).

CLI (`kata-cli`, against `fake-claude`):
- `kata bundle <spec>` produces the folder and exits 0; missing skill exits non-zero with a clear message.
- `kata run <bundle-dir>` recognizes the marker, runs from the vendored kit, and streams the normalized `KataEvent` events to completion — offline, deterministic.
- `kata run <spec-file>` unchanged.

## Out of scope / later

- `--workdir` override for `kata run` (general spec portability).
- Bundle compression / single-file archive (`.tar`/`.zip`); M7 ships a plain folder.
- Manifest hashes / integrity verification of vendored copies.
