# Kata Roadmap

Kata is a launcher for single, headless coding-agent runs: compose a portable run-spec, drive `claude -p` to completion, observe it, check the exit code. The engine never owns the agent loop; it rents it and controls the edges (the empty room, retasking, the curated kit, the leash). The `kata` binary is the single execution path the GUI, Shokunin, and CI all share.

- Design spec: `docs/superpowers/specs/2026-06-12-kata-launcher-design.md`
- Engine plan (M0-M4): `docs/superpowers/plans/2026-06-12-kata-engine.md`

## How to execute a milestone

Each milestone is its own cycle, the same one that produced M0-M4:

1. Brainstorm the milestone into a short design (superpowers:brainstorming) if it has open questions; otherwise reuse the design spec.
2. Write an implementation plan (superpowers:writing-plans) into `docs/superpowers/plans/`.
3. Execute it task-by-task (superpowers:subagent-driven-development): implement, then spec + code-quality review per task, then a final review before merge.
4. Every task: TDD, `cargo clippy --all-targets` clean, `cargo build --locked` green, frequent commits on a `feat/<milestone>` branch.

Status legend: `[x]` done, `[~]` in progress, `[ ]` not started.

---

## Phase 1 - Engine (DONE)

The self-contained core. Headless and CI-usable today; Shokunin can integrate against it now.

- [x] **M0 - Workspace scaffold + flag confirmation.** Cargo workspace (`kata-core` lib + `fake-claude` bin, `kata-cli` bin), MIT license. Confirmed real `claude` 2.1.176 flags and captured stream-json fixtures.
- [x] **M1 - Run-spec contract.** `RunSpec` types, TOML/JSON `load`, pure `validate`. `plugins` is a table keyed by name; `schema` defaults to 1.
- [x] **M2 - Catalog discovery.** `discover` skills + plugins (name, description, source, provides, mcp_servers); `kata catalog` emits it as JSON.
- [x] **M3 - Command construction + assembly.** Pure `build_invocation` pins the flag set (`--bare -p ... --output-format stream-json --verbose --dangerously-skip-permissions`, no `--max-turns`); `assemble` builds the disposable `--plugin-dir` with RAII temp cleanup.
- [x] **M4 - Run orchestration.** `kata run` spawns claude, streams the normalized `KataEvent` protocol, enforces the leash (engine-side turn cap = exit 125, wall-clock timeout = 124, cancel = 130), cleans up. Offline `fake-claude` harness + opt-in real-claude smoke test.

**Status:** implemented and reviewed on branch `engine-m0-m4` (42 tests, clippy clean, reproducible build). Not yet merged to `main`.

### Engine polish backlog (small, optional)
- [ ] Unify the per-line handling shared by `event::pump` and the `run` loop into one `handle_line` to remove the documented duplication.
- [ ] Correlate `tool.result` back to its `tool.use` via `tool_use_id` so `ToolResult.name` is populated (currently empty; see TODO in `event.rs`).
- [ ] Harden `catalog::dirs_home` (it silently falls back to `.` when `HOME`/`USERPROFILE` are both unset).
- [ ] Dedup catalog entries when the same skill/plugin name exists in both user and project scopes.

---

## Phase 2 - GUI (the Workbench)

A Tauri v2 desktop app (TypeScript + Vite + Svelte). Layout A: compose the run-spec on the left, observe the run on the right. The backend links `kata-core` only for the spec types and SPAWNS the `kata` binary to run, so the GUI shares the engine's single execution path.

- [ ] **M5 - Workbench left pane (compose).**
  - [ ] Scaffold the Tauri v2 app under `app/` (frontend `src/`, Rust backend `src-tauri/`).
  - [ ] Spec editor: task, context, workdir picker, identity (system prompt + append/replace), model, leash (max-turns, timeout, isolation).
  - [ ] Kit checklist populated by calling `kata catalog`; tag entries skill/plugin; show a plugin's `provides` and, for MCP, the env-passthrough names.
  - [ ] New / Open / Save / spec-name; round-trip a run-spec file to/from disk.
- [ ] **M6 - Workbench right pane (observe).**
  - [ ] Spawn `kata run`, relay the JSON-line `KataEvent` stream into the UI.
  - [ ] Live event view (text, tool calls, tool results, turns, logs) + status line (state, model, isolation badge).
  - [ ] Cancel button (kill the `kata` process; engine traps it and cleans up).
  - [ ] Summary card on completion: exit code, turns, cost, duration, result.

---

## Phase 3 - Portability and containment

- [ ] **M7 - `kata bundle`.** Vendor the resolved skills/plugins for a spec into a self-contained folder (spec + copied `SKILL.md`s/plugins) so CI needs nothing pre-installed. Day-to-day specs stay reference-by-name.
- [ ] **M8 - Worktree isolation.** When `leash.isolation = "worktree"`, create an ephemeral git worktree off `workdir`, run there, and surface the result as a reviewable diff. (Today the engine labels isolation but still runs in `workdir`.)

---

## Phase 4 - Backlog / later (from the spec's open questions and Layout C)

- [ ] Saved-katas + run-history rail in the Workbench (Layout C as an addition to Layout A).
- [ ] First-class `PreToolUse` guard-hook field + UI (programmatic enforcement, the heir to the permission-theater argument). Plugin-borne hooks already run today; this makes a guard first-class.
- [ ] MCP configuration surface (per-server config, secret references to a vault/dotenv) beyond the current env-name passthrough.
- [ ] Named, reusable context presets droppable into specs.
- [ ] Cost-ceiling leash (kill on `cost_usd` budget) once cost is reliably present in stream-json.
- [ ] Optional HITL modes deferred from v1: observe + approve (pause on tool calls), observe + steer (inject mid-run). Each is a real engine + protocol change; only if a need appears.

---

## Cross-cutting tracks

- [ ] **CI (GitHub Actions):** `cargo test --workspace`, `cargo clippy --all-targets -D warnings`, `cargo build --locked`. Keep the real-claude smoke test opt-in (it needs an authenticated `claude`); optionally run it on a secret-gated, logged-in runner.
- [ ] **Release / packaging:** decide crates.io publish vs. tagged binary releases for `kata`; ship the Tauri app artifacts for macOS/Windows. MIT.
- [ ] **Shokunin integration:** Shokunin (.NET) emits a run-spec file and shells out to `kata run`, consuming the `KataEvent` stream. Document the run-spec format + event protocol as the stable cross-language contract (it is the reference implementation in `kata-core`, but the contract is language-neutral).
- [ ] **Docs:** a `README` usage section with a worked example (compose a spec, `kata run` it, read the events) once the GUI lands.

---

## Known environment note

The opt-in real-claude smoke test asserts a genuinely successful run (`is_error == false`, exit 0), so it requires an authenticated `claude` on PATH (run `claude` interactively once to log in). Without login it correctly fails when enabled; by default (`KATA_SMOKE_REAL` unset) it skips.
