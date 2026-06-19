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

**Status:** merged to `main` (#1) — 42 tests, clippy clean, reproducible build.

### Engine polish backlog (small, optional)
- [ ] Unify the per-line handling shared by `event::pump` and the `run` loop into one `handle_line` to remove the documented duplication.
- [ ] Correlate `tool.result` back to its `tool.use` via `tool_use_id` so `ToolResult.name` is populated (currently empty; see TODO in `event.rs`).
- [ ] Harden `catalog::dirs_home` (it silently falls back to `.` when `HOME`/`USERPROFILE` are both unset).
- [ ] Dedup catalog entries when the same skill/plugin name exists in both user and project scopes.
- [ ] Fix `worktree::diff` rename line-counts (best-effort `0/0` today; the `--numstat` `old => new` path form doesn't correlate with `--name-status`). See [#7](https://github.com/satish-krishna/kata/issues/7).

---

## Phase 2 - GUI (the Workbench)

A Tauri v2 desktop app (SvelteKit SPA + TypeScript). Layout A: compose the run-spec on the left, observe the run on the right. The backend links `kata-core` only for the spec types and SPAWNS the `kata` binary to run, so the GUI shares the engine's single execution path. The Workbench is styled with the Kata "sumi-ink" design system (see `design/README.md`, `app/CLAUDE.md`).

- [x] **M5 - Workbench left pane (compose).** Tauri v2 app under `app/` (SvelteKit SPA frontend + `src-tauri` backend). The backend links `kata-core` in-process for catalog discovery, spec load/save, and validation (only `kata run` spawns the binary, in M6). Spec/catalog types are generated to TypeScript via `ts-rs`. Compose form (task, context, workdir picker, identity, model, leash) with a workdir-scoped Kit checklist (skill/plugin tags, plugin `provides` + MCP env-passthrough names), live validation, and New/Open/Save/Save As round-tripping a run-spec to disk.
  - [x] Scaffold the Tauri v2 app under `app/` (SvelteKit SPA frontend `src/`, Rust backend `src-tauri/`).
  - [x] Spec editor: task, context, workdir picker, identity (system prompt + append/replace), model, leash (max-turns, timeout, isolation).
  - [x] Kit checklist populated by `kata-core` catalog discovery scoped to the workdir; tag entries skill/plugin; show a plugin's `provides` and, for MCP, the env-passthrough names.
  - [x] New / Open / Save / spec-name; round-trip a run-spec file to/from disk. (PR #2 restyle: toolbar is New / Open / Save / Export, with Save handling save-as.)
- [x] **M6 - Workbench right pane (observe).** Observe pane shipped and styled in PR #2; the real engine path landed in PR #4 — the Tauri backend stages `kata` as a sidecar, spawns `kata run` in the spec's workdir, and relays its live JSON-line `KataEvent` stream over the `kata://event` channel.
  - [x] Spawn `kata run`, relay the JSON-line `KataEvent` stream into the UI. (PR #4: sidecar spawn + stdout/stderr relay; each run isolated by run id.)
  - [x] Live event view (text, tool calls, tool results, turns, logs) + status line (state, model, isolation badge).
  - [x] Cancel button (kill the `kata` process; engine traps it and cleans up). (PR #4: `cancel_run` writes a `cancel` line to the engine's stdin, with a hard-kill fallback.)
  - [x] Summary card on completion: exit code, turns, cost, duration, result.

---

## Phase 3 - Portability and containment

- [x] **M7 - `kata bundle`.** Vendor the resolved skills/plugins for a spec into a self-contained folder (spec + copied `SKILL.md`s/plugins) so CI needs nothing pre-installed. Day-to-day specs stay reference-by-name. *(bundle produce + hermetic consume: `kata bundle <spec>` writes a `.claude`-shaped tree + `kata-bundle.toml` marker/manifest; `kata run <dir>` detects the marker and discovers the kit only from the bundle. Reuses the assemble resolution path. Workdir portability stayed out of scope as a general concern.)* **Status:** merged to `main` (#5) — incl. review hardening: symlink-safe `copy_dir`, sanitized default output name, `--force` replaces the vendored kit cleanly, and scope-accurate plugin provenance.
- [x] **M8 - Worktree isolation.** When `leash.isolation = "worktree"`, the engine branches off `workdir`'s HEAD into a persistent worktree under `~/.kata/worktrees/<slug>-<id>` (branch `kata/<slug>-<id>`), runs the agent there, and emits a `run.diff` summary before the terminal event; `run.started` now carries the worktree path + branch. A non-git `workdir` is refused (exit 2) rather than silently downgraded. Worktrees persist for review; cleanup is the operator's via native `git worktree remove`/`prune`. Engine + protocol scope — the Workbench diff panel is a fast-follow. **Status:** merged to `main` (#6); rename line-counts tracked as [#7](https://github.com/satish-krishna/kata/issues/7).

---

## Engine hardening (merged, post-M8)

Two engine improvements that grew out of a live debugging session ("why is my run stuck on `Running`?"), each its own TDD'd cycle with per-task and final review before merge.

- [x] **Optional `--bare` + referenced auth token.** `RunSpec` gains an `auth { bare, token_env }` block: `--bare` (the empty room) is now a per-spec toggle — default on, so prior behaviour is unchanged — rather than hardcoded, and a bare run can name a host environment variable whose value the engine forwards to claude as `ANTHROPIC_API_KEY`. The secret never enters the spec (only the variable name does), so it stays out of git, logs, events, and M7 bundles; a bare run that references an unresolved variable is refused before spawn (exit 2). The Workbench compose pane gained an Environment section (bare/full toggle + a conditional token-env field). **Status:** merged to `main` (#9).
- [x] **Never leave a run silently stuck on `Running`.** The run loop now surfaces the child's stderr as `warn` log events (previously discarded via `Stdio::null()`), gives claude a non-interactive (null) stdin so an unauthenticated child fast-fails instead of blocking on an interactive login prompt, enforces a default 30-minute wall-clock cap when `leash.timeout_secs` is unset (a hung run is always reaped and the default is announced), and keeps leashing a child that closes its stdio but keeps running (the deadline still applies, instead of an unbounded `child.wait()` — a Copilot review catch). **Status:** merged to `main` (#8).

---

## Phase 4 - Backlog / later (from the spec's open questions and Layout C)

- [x] **Cost-ceiling leash.** Per-spec `leash.max_budget_usd`, enforced by claude's native `--max-budget-usd`; the engine maps the `error_max_budget_usd` result subtype to a distinct exit code (**122**) in the leash family. The cap is approximate (post-turn check, overshoots by up to one turn). Workbench leash field included. **Status:** merged to `main` (#14).
- [x] **Saved-katas + run-history rail.** Run-history backend (`kata-core::history` reads `~/.kata/runs/*.jsonl` transcripts into ts-rs `RunRecord`s; `list_runs`/`load_run` Tauri commands; `exit_code` added to the terminal `run.error`/`run.cancelled` events so killed/cancelled runs render a faithful badge; one shared `statusForExit` andon mapping for live + history) made the `/library` Recent-runs rail + read-only detail live (#15). Saved katas persist in `~/.kata/katas` (compose Save → library by name); the Saved-katas rail joins them with run-history aggregates; the four actions are wired — New, **Re-run via a prefilled task editor** (the reusable-agent flow: same kit/identity/leash, a fresh task each run), Open-in-compose, Export bundle (#16).
- [x] **Named, reusable context presets.** Copy-in preset library (`~/.kata/presets`); a menu in the compose Task section drops a preset's text into the spec's `context` — no `RunSpec` contract change, so specs stay self-contained and bundle-safe (#16).
- [x] **Workbench polish — design-system dialogs.** Replaced the remaining browser-native `alert`/`prompt`/`confirm` with on-brand UI: andon-error toasts (a `Toaster` in the root layout) and `.k-dialog` modals (`PromptDialog` for preset naming, `ConfirmDialog` for the discard guard) (#17).
- [ ] First-class `PreToolUse` guard-hook field + UI (programmatic enforcement, the heir to the permission-theater argument). Plugin-borne hooks already run today; this makes a guard first-class.
- [ ] MCP configuration surface (per-server config, secret references to a vault/dotenv) beyond the current env-name passthrough.

---

## Phase 5 - Observe + ask (human-in-the-loop)

Deferred from the MVP, which is observe-only by design: the engine drives `claude -p` headless with `--dangerously-skip-permissions`, so a run takes no mid-flight intervention — you watch it and hold the leash. Once the Workbench MVP (M5 compose + M6 observe/run) ships, this is the first post-MVP track: turn the one-way observe pane into a two-way session. It builds directly on the cancel-only stdin channel M6 introduces (a `cancel` line to the `kata` process) — the same seam carries answers.

- [x] **M9 - Observe + ask.** Opt-in per spec (`[interactive] enabled = true`): when the spec is interactive, the engine stands up a Kata-hosted `ask_user` MCP tool (a `kata mcp-ask` stdio subprocess bridged to the engine over a localhost TCP line-protocol) and appends a retasking note so claude knows to call it at consequential forks. claude calls the tool and blocks; the engine emits `ask.requested`, pauses the work-clock, waits for the operator's `answer <id> <json>` on stdin, returns the answer as the tool result, emits `ask.answered`, and resumes — one unbroken `claude -p` session. The Workbench surfaces the AskPanel inline, with an Interactive section in Compose. **Not** interception of the built-in `AskUserQuestion` (which terminates headless) — see the feasibility findings in `docs/superpowers/specs/2026-06-18-interactive-sessions-design.md`. Exit code 123 = answer deadline exceeded (distinct from 124 work timeout). **Status:** merged to `main` (#12).
- [ ] **Observe + steer (follow-on).** Operator-initiated mid-run guidance (injecting unsolicited context). Shares this same back-channel; deferred.
- [ ] **Observe + approve (optional sibling).** Pause on tool calls and require operator approval before proceeding (the interactive heir to `--dangerously-skip-permissions`). Shares the same back-channel; ship only if a need appears.

---

## Cross-cutting tracks

- [ ] **CI (GitHub Actions):** `cargo test --workspace`, `cargo clippy --all-targets -D warnings`, `cargo build --locked`. Keep the real-claude smoke test opt-in (it needs an authenticated `claude`); optionally run it on a secret-gated, logged-in runner.
- [~] **Release / packaging:** local Windows release process in place — `scripts/bump-version.ps1` + `scripts/build-release.ps1` build the standalone `kata` CLI and the Workbench NSIS/MSI installers; tag `vX.Y.Z` and `gh release create` by hand (see `docs/releasing.md`). Still open: crates.io publish vs. tagged binaries, macOS/Linux artifacts, code-signing/CI. MIT.
- [ ] **Shokunin integration:** Shokunin (.NET) emits a run-spec file and shells out to `kata run`, consuming the `KataEvent` stream. Document the run-spec format + event protocol as the stable cross-language contract (it is the reference implementation in `kata-core`, but the contract is language-neutral).
- [ ] **Docs:** a `README` usage section with a worked example (compose a spec, `kata run` it, read the events) once the GUI lands.

---

## Known environment note

The opt-in real-claude smoke test asserts a genuinely successful run (`is_error == false`, exit 0), so it requires an authenticated `claude` on PATH (run `claude` interactively once to log in). Without login it correctly fails when enabled; by default (`KATA_SMOKE_REAL` unset) it skips.
