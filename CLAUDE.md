# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Kata is

Kata is a launcher for single, headless coding-agent runs. You compose a *run-spec* (one precise, reproducible form for a job) and Kata runs it by driving `claude -p` to completion and observing it. Kata never owns the agent loop — it rents it via `claude -p` and controls the edges: the empty room (`--bare`, default-on but switchable per run), retasking (an appended/replacing system prompt), a curated kit (a disposable `--plugin-dir`), and the leash (turn cap, wall-clock timeout, optional worktree isolation, exit code).

The `kata` binary is the single execution path the GUI, the Shokunin orchestrator, and CI all share. `README.md` and `ROADMAP.md` carry the product vision and milestone status; design specs and plans live in `docs/superpowers/`.

## Layout

A Cargo workspace plus a Tauri app. Three crates in `[workspace].members`:

- `crates/kata-core` — the engine library (`kata_core`). Also builds the `fake-claude` test binary. Modules: `spec` (the `RunSpec` contract: TOML/JSON load/save + pure `validate`), `catalog` (`discover` skills/plugins from user+project scopes), `command` (`build_invocation` pins the exact claude flag set), `assemble` (build the disposable `--plugin-dir` with RAII temp cleanup), `run` (orchestrate the child, stream `KataEvent`s, enforce the leash, clean up), `event` (the normalized `KataEvent` protocol + `parse_stream_line` translating claude `stream-json`), `fsutil`.
- `crates/kata-cli` — the `kata` binary. Thin CLI over `kata-core` with three subcommands: `validate`, `catalog`, `run`.
- `app/src-tauri` — the Workbench desktop backend (`kata-app`). See "The Workbench" below.

## Two contracts that cross language boundaries

These are the stable, language-neutral interfaces; `kata-core` is the reference implementation but the contract is not Rust-specific (Shokunin is .NET and consumes both).

- **The run-spec** (`spec::RunSpec`) — what to run. Serialized to TOML/JSON.
- **The event protocol** (`event::KataEvent`) — `run.started` / `assistant.text` / `tool.use` / `tool.result` / `turn` / `log` / `run.completed` / `run.error` / `run.cancelled` / `ask.requested` / `ask.answered`, one JSON object per line on the engine's stdout. `ask.requested` carries the question list and a correlation `id`; `ask.answered` carries the same `id` and the `answers: string[][]`. Only emitted when `[interactive] enabled = true` in the spec.

`RunSpec` and the catalog/enum types are mirrored to TypeScript in `app/src/bindings/` by **ts-rs**, gated behind the `ts` Cargo feature. After changing any of these types, regenerate: `cargo test -p kata-core --features ts export_bindings`. Do not hand-edit `app/src/bindings/`.

## Exit-code semantics (the leash)

The engine maps run outcomes to process exit codes, and the CLI surfaces them: turn cap → **125**, wall-clock timeout → **124**, answer deadline exceeded → **123**, budget ceiling reached → **122**, cancel → **130**. The CLI itself uses **1** for validation failure and **2** for load/parse error. Preserve these — they are part of the CI/orchestrator contract. Exit 123 is only reachable when `[interactive] enabled = true` and `answer_timeout_secs` is set; it is distinct from 124 so CI logs can tell "work ran too long" from "nobody answered." Exit 122 is reached only when `leash.max_budget_usd` is set and claude stops on its native `--max-budget-usd` (a post-turn check, so the actual spend can overshoot the ceiling by up to one turn); the engine detects the `error_max_budget_usd` result subtype and overrides claude's generic exit 1. Exit 125 is only reachable when `leash.max_turns` is set; an unset cap means unlimited turns, bounded only by the wall-clock timeout (exit 124).

## The Workbench (`app/`)

A Tauri v2 desktop app: SvelteKit SPA frontend (`app/src/`, static-adapter SPA, TypeScript, Svelte 5) over a Rust backend (`app/src-tauri/`). Layout A: compose the run-spec on the left, observe the run on the right.

The backend splits its relationship with the engine deliberately (see `app/src-tauri/src/lib.rs`):

- It **links `kata-core` in-process** for the cheap, pure operations — `catalog`, `load_spec`, `save_spec`, `validate_spec` are `#[tauri::command]` one-liners over the library.
- It **spawns the `kata` sidecar binary** for the one impure operation, `run_spec`: serialize the spec to a temp file, spawn `kata run` in the spec's workdir, and relay its JSON-line `KataEvent`s to the webview over the `kata://event` channel. `cancel_run` writes a `cancel` line to the engine's stdin (the engine traps it, kills claude, cleans up, emits `run.cancelled`), falling back to a hard kill. This keeps the GUI on the engine's single execution path.

The frontend stays **presentational**. `app/src/lib/api.ts` gates every backend call on `inTauri()`: under Tauri it `invoke`s/`listen`s; in a plain browser it falls back to fixtures and a scripted run timeline from `app/src/lib/mock.ts`. The run store is `app/src/lib/run.svelte.ts`.

**Design rules are non-negotiable and live in `app/CLAUDE.md`** (the dark "sumi-ink" system, single Hanada-azure accent, IBM Plex type, andon status palette). Read it before touching anything visual. Style only against CSS custom properties — never hard-code a hex value. The full system + per-component specs are in `design/README.md`; pixel references in `design/prototype/` are HTML/React — recreate in Svelte, never copy.

## Commands

Rust (run from repo root):

- Build: `cargo build --locked`
- Test the workspace: `cargo test --workspace`
- A single test: `cargo test -p kata-core <name>` or `cargo test -p kata-cli --test cli_it <name>`
- Lint (must be clean): `cargo clippy --all-targets -- -D warnings`
- Regenerate TS bindings after type changes: `cargo test -p kata-core --features ts export_bindings`

App (run from `app/`):

- Browser dev (fixtures, no native backend): `npm run dev` → `http://localhost:1420`. `http://localhost:1420/?demo=run` auto-starts the scripted Observe-pane run for screenshots.
- Real desktop app with the live engine: `npm run tauri:dev` — this first stages the `kata` sidecar (`scripts/stage-sidecar.mjs` builds `kata-cli` and copies it to `src-tauri/binaries/kata-<target-triple>`), then launches Tauri. A real run needs an authenticated `claude` on PATH.
- Type-check Svelte: `npm run check`
- Frontend tests: `npm test` (Vitest)

## Testing notes

- The engine's integration tests drive the offline `fake-claude` binary via the `KATA_FAKE_MODE` env var (`crates/kata-core/tests/run_it.rs`). These tests mutate process-global env and are marked `#[serial]`; don't remove that.
- The opt-in real-claude smoke test asserts a genuinely successful run, so it needs an authenticated `claude` on PATH. It runs only when `KATA_SMOKE_REAL` is set; unset it skips.
- Per the roadmap workflow: TDD, clippy clean, `cargo build --locked` green, frequent commits on a `feat/<milestone>` branch.
