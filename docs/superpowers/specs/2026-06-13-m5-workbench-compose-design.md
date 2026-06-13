# M5 — Workbench left pane (compose) — design

Status: approved design, pre-implementation
Date: 2026-06-13
Milestone: M5 (Phase 2 — GUI / the Workbench)

Parent design: `docs/superpowers/specs/2026-06-12-kata-launcher-design.md`
Roadmap: `ROADMAP.md`

## What this is

M5 scaffolds the Tauri v2 Workbench app and builds its **left pane**: composing,
validating, and round-tripping a run-spec to disk, with a Kit checklist populated
from `kata-core`'s catalog discovery. The right pane (run + observe) is M6; this
milestone ends with a working compose pane.

The left pane is "the spec serialized": its state is a `RunSpec`, and saving it
writes the same TOML/JSON the engine and CI consume.

## Decisions settled in brainstorming

1. **Backend seam — link `kata-core` in-process for non-run operations.** Catalog
   discovery, spec load, spec save, and validation call `kata-core` directly from
   the Tauri backend. Only `kata run` (M6) spawns the `kata` binary. Consequence:
   M5 needs **no** binary-path resolution; that is deferred to M6.
2. **Type sync — codegen from Rust via ts-rs.** The TypeScript `RunSpec`/catalog
   types are generated from the Rust definitions, so the form and the engine
   cannot disagree about the schema. Generated bindings live in `app/src/bindings/`.
3. **Kit scope — re-discover against the spec's workdir.** Catalog roots are
   `~/.claude` (user) + `<workdir>/.claude` (project). The Kit re-fetches
   (debounced) whenever `workdir` changes; an empty or non-existent workdir falls
   back to user scope only.

## Architecture

```
app/
  src/                      # Svelte 5 (runes) + TypeScript + Vite, plain (no SvelteKit)
    bindings/               # ts-rs-generated types (RunSpec, CatalogEntry, ...) — checked in
    lib/                    # presentational components + pure TS helpers
    App.svelte              # two-pane shell; right pane is an M6 placeholder
  src-tauri/                # Tauri v2 backend
    Cargo.toml              # depends on kata-core (path), tauri, tauri-plugin-dialog
    src/lib.rs              # #[tauri::command] wrappers over kata-core
```

The backend links `kata-core` (path dependency) for the spec **types** and for the
**discovery / load / save / validate** functions. It does not embed a run loop.

### Tech

- Tauri v2; frontend TypeScript + Vite + **Svelte 5 (runes)**, plain (no SvelteKit
  SSR — this is a desktop webview, not a server-rendered site).
- File/directory pickers via `@tauri-apps/plugin-dialog`, called from the frontend
  directly, so the Rust backend stays limited to the four data commands.
- Spec files canonical TOML; JSON accepted (same shape), per the parent design.

## kata-core additions

`kata-core` currently exposes `spec::load` but no save. M5 adds:

- `spec::to_toml(&RunSpec) -> Result<String, SpecError>` — canonical TOML serialization.
- `spec::save(path: &Path, spec: &RunSpec) -> Result<(), SpecError>` — writes TOML,
  or JSON when the path ends in `.json` (mirroring `load`'s extension rule).
- A `ts` Cargo feature gating `#[derive(ts_rs::TS)]` on `RunSpec`, `Identity`,
  `IdentityMode`, `PluginConfig`, `Model`, `Leash`, `Isolation`, and `CatalogEntry`
  / `EntryKind`. CLI and engine builds do not enable `ts`, so the binary stays lean.

TOML comments are not preserved across a load→edit→save cycle; this is acceptable
(the canonical artifact is the structured spec, not formatting).

This is the only engine logic M5 introduces; everything else is GUI.

## Backend commands (`src-tauri`)

Thin `#[tauri::command]` wrappers; all logic lives in `kata-core`.

| Command | Calls | Notes |
|---|---|---|
| `catalog(workdir: Option<String>)` | `catalog::discover` | roots = `~/.claude` + `<workdir>/.claude`; `None` or non-existent workdir → user scope only |
| `load_spec(path: String)` | `spec::load` | returns `RunSpec` |
| `save_spec(path: String, spec: RunSpec)` | `spec::save` | TOML/JSON chosen by extension |
| `validate_spec(spec: RunSpec)` | `spec::validate` | returns `Vec<String>` of error strings for live display |

Open-spec, save-as, and workdir pickers use the dialog plugin from the frontend;
they are not backend commands.

## Frontend — compose pane

- State is a single reactive `RunSpec` (`$state`), typed by the generated bindings.
- Field order (per parent design): **Name / Description → Task → Context → Workdir
  (with directory picker) → Identity (`system_prompt` + append/replace `mode`) →
  Kit → Model (`id`) → Leash (`max_turns`, `timeout_secs`, `isolation`
  none/worktree)**.
- **Kit**: searchable checklist sourced from `catalog`, each entry tagged `skill`
  or `plugin`.
  - Ticking a skill adds its name to `skills[]`.
  - Ticking a plugin adds a `plugins{}` entry (empty `PluginConfig` by default).
  - Expanding a ticked plugin reveals its `provides` line and, for MCP plugins, an
    editable list of env-passthrough **names** (`env[]`, never values) and an `mcp`
    toggle.
  - Re-fetches (debounced) when `workdir` changes.
- **Validation**: live `validate_spec` → inline banner listing the error strings.
  Saving is always allowed (drafts are welcome). The **Run** button is present but
  **disabled in M5** (wired in M6).
- **Toolbar**: New / Open / Save / Save As / spec name field. Dirty-state tracking
  drives a confirm-discard prompt on New/Open when there are unsaved edits. The
  **Export bundle** button is present but disabled (M7).

## Testing

- **kata-core (TDD):** `save`/`to_toml` round-trip — `load(save(spec)) == spec` for
  both TOML and JSON paths.
- **src-tauri:** command-layer integration tests against fixture dirs — `catalog`
  over a temp `.claude` tree (user + project scopes), and a `load → validate →
  save → reload` equality test. A ts-rs `export_bindings` test guarantees the
  TypeScript bindings stay generated and in sync.
- **Frontend:** pure TS helpers (kit grouping, spec↔form mapping, error rendering)
  unit-tested with Vitest; Svelte components stay presentational/untested. The app
  must build (`vite build` + `tsc`) in CI.

## Out of scope for M5 (deferred)

- Right-pane event view, `kata run` spawn, binary-path resolution, Cancel button,
  Summary card — **M6**.
- Export bundle — **M7**.
- Worktree isolation behavior — **M8**.

M5's terminal state: a left pane that composes a run-spec, discovers and selects a
kit scoped to the workdir, validates live, and round-trips the spec to/from disk.
