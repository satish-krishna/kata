# Saved-kata library + actions + task override + context presets — design

Cycle 2, PR-B (the final cycle-2 PR; PR-A shipped the run-history backend). This makes the Library's **Saved-katas** rail live and turns a saved kata into a **reusable agent**: a named run-spec you re-run with a fresh task each time. It also adds a **context-preset** library you drop into a spec.

## Problem

After PR-A, the `/library` Recent-runs rail and run-detail are live, but:
- The **Saved-katas** rail section is still fixtures (`library.ts` `savedKatas`); there is no place saved katas persist.
- The run-detail **action row** (Re-run / Open in compose / Export bundle) is inert.
- There is no per-run task override — the thing that makes a saved spec a *reusable agent* (the same kit/identity/leash, a new task each run).
- Specs save/load only to arbitrary file paths via native dialogs; there is no managed library.
- The roadmap's "named, reusable context presets droppable into specs" does not exist.

This PR delivers all of it. The Library UX is fixed by `design/` (rail rows, the action row, New kata button) and is not redesigned; the task-editor dialog and the presets menu are new, design-system-styled elements.

## Goals

- Persist saved katas as named run-specs in a managed library (`~/.kata/katas`).
- The Saved-katas rail lists the library, joined with run-history aggregates (run count, last outcome).
- Wire the four library actions: **New kata**, **Re-run** (with per-run task override), **Open in compose**, **Export bundle**.
- A context-preset library (`~/.kata/presets`) you drop into a spec's `context` at compose time.
- Keep `kata-core` the shared contract: persistence + the ts-rs `Preset` type live there; the Workbench reaches them via Tauri commands.

## Non-goals

- Deleting katas (not in the fixed UX; add later if needed).
- Reference-style context presets. Presets are **copy-in** (their text is inserted into `context`); the `RunSpec` contract and the engine are unchanged, and specs stay self-contained/bundle-safe.
- Changing the `RunSpec` or `KataEvent` contracts. Katas reuse the existing TOML `spec::save/load`; presets are compose-time text.
- A `kata katas` / `kata presets` CLI surface (GUI-only for now, like history).

## Persistence — `kata-core` (shared contract)

Two small CRUD modules over the existing `spec::save`/`spec::load` (TOML), plus two `fsutil` dirs.

### `fsutil`
- `katas_dir() -> Option<PathBuf>` → `<kata-home>/katas`.
- `presets_dir() -> Option<PathBuf>` → `<kata-home>/presets`.
(Both `None` when no home, like `runs_dir`.)

### `katas` module (`crates/kata-core/src/katas.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum KataError { NotFound, InvalidName, Io(String) }

/// Persist a spec to the library as `<slug(spec.name)>.toml` (overwrites a
/// same-named kata). Errors if the name slugs to nothing or there is no home.
pub fn save_kata(spec: &RunSpec) -> Result<std::path::PathBuf, KataError>;

/// All saved katas, sorted by name. Best-effort: a malformed/unreadable
/// `*.toml` is skipped, never fatal. Empty when there is no home.
pub fn list_katas() -> Vec<RunSpec>;

/// Load one kata by name (slugged). `NotFound` if the file is absent.
pub fn load_kata(name: &str) -> Result<RunSpec, KataError>;
```

`save_kata`/`load_kata` reuse `fsutil::slug` (the same path-segment sanitizer worktrees/transcripts use) so the filename is traversal-safe and stable. `save_kata` validates the spec first (`spec::validate`) — the library never holds an invalid kata.

### `presets` module (`crates/kata-core/src/presets.rs`)

```rust
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Preset { pub name: String, pub body: String }

/// All presets, sorted by name. Best-effort (malformed files skipped).
pub fn list_presets() -> Vec<Preset>;

/// Persist a preset as `<slug(name)>.toml` (overwrites same-named).
pub fn save_preset(preset: &Preset) -> Result<std::path::PathBuf, PresetError>;
```

A preset persists as a tiny TOML doc (`name = "..."`, `body = "..."`) at `presets_dir/<slug>.toml`, consistent with how katas store specs. `Preset` is ts-rs-exported to `app/src/bindings/Preset.ts`.

Both modules register in `lib.rs` (`pub mod katas; pub mod presets;`).

## Tauri commands (`app/src-tauri/src/lib.rs`)

In-process one-liners (the `load_spec` pattern), registered in `generate_handler!`:

- `save_kata(spec: RunSpec) -> Result<(), String>`
- `list_katas() -> Result<Vec<RunSpec>, String>`
- `load_kata(name: String) -> Result<RunSpec, String>`
- `list_presets() -> Result<Vec<Preset>, String>`
- `save_preset(name: String, body: String) -> Result<(), String>`
- `export_bundle(spec: RunSpec, out_dir: String) -> Result<(), String>` — discover the catalog from `spec.workdir` (`DiscoveryRoots::defaults`), then `bundle::bundle(&spec, &catalog, out_dir, /* force */ false)`, mapping errors to strings.

`api.ts` gains gated wrappers for each (`inTauri() ? invoke(...) : <fixture>`), with browser fixtures: `list_katas`/`list_presets` resolve to the existing `library.ts` fixtures (reshaped) / a small presets fixture; the mutating commands resolve to no-ops in the browser.

## Saved-katas rail goes live (`/library`)

The rail's Saved-katas section currently maps the `savedKatas` fixture (`{ name, description, isolation, skills, plugins, lastState, lastExit, runs }`). PR-B builds that view live:

- `listKatas()` returns the persisted `RunSpec[]`. The frontend derives each row's static fields: `description = spec.description ?? ""`, `isolation = spec.leash.isolation`, `skills = spec.skills.length`, `plugins = Object.keys(spec.plugins).length`.
- `listRuns()` (PR-A) supplies the dynamic fields, grouped by `kata` name: `runs = count`, and `lastState`/`lastExit` from the newest run for that name (state via `statusForExit`). A kata with no runs shows `0 runs` and a neutral/idle dot.

The join is done in the frontend (presentational); `kata-core` stays pure CRUD + the existing history reader. The `savedKatas` fixture is reshaped to seed the browser fallback.

## The actions

All four are on the fixed UX. The three run-detail actions operate on the kata named by the **selected run** (`run.kata`); each resolves the kata via `loadKata(run.kata)` and is **disabled when that kata is not in the library** (e.g. a historical run whose kata was never saved or has since been renamed).

- **New kata** (rail button, `Ctrl+N`): navigate to compose (`/`) with a blank spec. (The compose route already opens blank in Tauri.)
- **Re-run** (run-detail, primary): open the **task-editor dialog** prefilled with the kata's saved `task`; on confirm, hand the kata to compose with `task` overridden and **auto-run**. This is the reusable-agent flow — same kit/identity/leash, a fresh task.
- **Open in compose** (run-detail, secondary): hand the kata to compose for full editing; no auto-run.
- **Export bundle** (run-detail, ghost): pick a destination folder (native dialog) → `exportBundle(kata, dir)`.

### Task-editor dialog (new component)

A small modal `TaskEditor.svelte` (design-system: floating card with shadow, one azure primary action, mono where appropriate): a `task` textarea prefilled from the kata, a confirm ("Run") and cancel. It is the only new UI surface; it reuses existing tokens and the `.k-*` classes. No new colours.

### Compose handoff + auto-run

A tiny shared store `app/src/lib/launch.svelte.ts`:

```ts
export const launch = $state<{ spec: RunSpec; autorun: boolean } | null>(null);
```

A library action sets `launch = { spec, autorun }` then `goto('/')`. The compose route, on mount, consumes it: if present, load the spec (`spec = draftFrom(launch.spec)`), clear `launch`, and if `autorun` is true and the spec is valid, start the run (`startRun(normalize(spec))`) so the Observe pane shows it immediately. This is the one cross-route channel; it replaces no existing behavior.

## Compose Save / Open / Export semantics

- **Save** → library by name. `onSave` calls `saveKata(spec)` (no file dialog); it overwrites the same-named kata. Save still requires a valid spec (name/task/workdir), which validation already enforces. The dirty/`saved`-snapshot tracking is unchanged.
- **Open** → unchanged (native file dialog importing any spec file). Opening a *library* kata is the rail's "Open in compose".
- **Export** → wire the existing (currently unset) `onExport` toolbar prop to: pick a folder → `exportBundle(spec, dir)`.

## Context presets UX (compose Task section)

In `ComposePane.svelte`'s Task section, near the `context` textarea:
- A **presets menu** (existing select/menu primitive) listing `listPresets()` by name; choosing one **appends** its `body` to `spec.context` (separated by a blank line if context is non-empty). Copy-in — no contract change.
- A **"Save as preset"** affordance: prompt for a name, `savePreset({ name, body: spec.context })`. Disabled when `context` is empty.

Presets are a compose-time convenience; the resulting `context` is plain spec text that travels with the spec (and into M7 bundles) unchanged.

## Testing

**`kata-core::katas`** (in-module `#[serial]`, temp `KATA_HOME`): `save_kata` → `list_katas` → `load_kata` round-trip; `load_kata` unknown → `NotFound`; a spec whose name slugs to nothing → `InvalidName`; `save_kata` rejects an invalid spec; a malformed `*.toml` is skipped by `list_katas`; sorted by name.

**`kata-core::presets`** (`#[serial]`, temp `KATA_HOME`): `save_preset` → `list_presets` round-trip; slug handling (two names slugging equal overwrite); malformed skipped; sorted by name. ts-rs `Preset.ts` regenerated.

**Tauri commands**: compile-verified (`cargo build -p kata-app --locked`); the logic is tested in `kata-core`.

**Frontend** (vitest + svelte-check + build):
- The rail join: given `katas` + `runs` fixtures, the derived `SavedKata` rows have correct kit counts and per-kata run aggregates (count, last outcome).
- The task-editor: prefills from the kata's task; confirm yields the spec with `task` overridden, cancel yields nothing.
- The preset append: choosing a preset appends its body to a non-empty / empty context correctly.
- The launch handoff: consuming `launch` loads the spec and clears the store; `autorun` triggers a start only when valid.

## File structure

- Create: `crates/kata-core/src/katas.rs`, `crates/kata-core/src/presets.rs`; register both in `lib.rs`.
- Modify: `crates/kata-core/src/fsutil.rs` (`katas_dir`, `presets_dir`).
- Modify: `app/src-tauri/src/lib.rs` (six commands + registration).
- Modify: `app/src/lib/api.ts` (six gated wrappers).
- Create: `app/src/lib/launch.svelte.ts` (handoff store); `app/src/lib/components/TaskEditor.svelte` (dialog).
- Modify: `app/src/routes/library/+page.svelte` (live Saved-katas rail + wire the three actions + New kata), `app/src/routes/+page.svelte` (consume `launch`; Save → `saveKata`; wire `onExport`), `app/src/lib/components/ComposePane.svelte` (presets menu + save-as-preset), `app/src/lib/library.ts` (reshape `savedKatas` fixture for the fallback; add a presets fixture).
- Generate: `app/src/bindings/Preset.ts` (ts-rs).

## Sequencing

PR-B of cycle 2, on `feat/saved-kata-library` off `main` — built **after** PR #14 (cost-leash) and PR #15 (run-history) merge to `main`, since the rail join consumes PR-A's `list_runs`/`RunRecord` and `statusForExit`. Single PR by request; the module boundaries (`katas`, `presets`, the handoff store, the dialog, the presets menu) keep the implementation plan cleanly task-decomposable. TDD per change, clippy clean, `cargo build --locked` green, bindings regenerated, `npm run check`/`npm test` green, review before merge. This closes Phase 4 cycle 2; cycle 3 is guard-hooks, cycle 4 MCP config.
