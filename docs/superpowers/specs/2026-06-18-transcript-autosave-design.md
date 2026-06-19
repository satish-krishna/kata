# Transcript auto-save — design

Status: draft for review · 2026-06-18 · follow-on to M9 (interactive sessions)

## Context

Kata drives `claude -p` headless and observes it, emitting a normalized `KataEvent` stream — one JSON object per line — as the run unfolds. Today that stream is ephemeral: `kata run` prints each event to stdout (`kata-cli/src/main.rs`), the Workbench relays it to the webview over the `kata://event` channel, and when the process exits the events are gone. There is no record of what a run did once its terminal scrollback or the GUI session is closed.

This design adds **automatic, always-on persistence of the `KataEvent` stream to a file per run**, so every run leaves a durable, replayable transcript without the operator opting in or remembering a flag.

## Goal

Every `kata run` writes its complete `KataEvent` stream to `<kata-home>/runs/<slug>-<utc-stamp>.jsonl` as the run unfolds. The file is the exact JSON-lines stream Kata already emits — Kata's own stable, language-neutral contract — so it can be replayed, diffed, or fed back through any consumer that understands `KataEvent`. A run cut short by the leash, a cancel, or a crash still leaves a complete-up-to-the-cut transcript.

## Non-goals (YAGNI)

- **Retention / cleanup / rotation.** Transcripts accumulate under `~/.kata/runs/` indefinitely, exactly as worktrees accumulate under `~/.kata/worktrees/` today. Pruning is the operator's broom (`rm`), not the engine's job — for now.
- **A GUI transcript browser** or "open previous runs" UI. Out of scope; this design only writes the files and announces their paths.
- **A new event-protocol variant.** The path is surfaced via the existing `Log` event (see below). No `event.rs` variant, no ts-rs regeneration, no `RunSpec` change.
- **Choosing the content.** Decided during brainstorming: the normalized `KataEvent` stream, not claude's raw stream-json and not a pointer to claude's private `~/.claude/projects` transcript.

## Architecture — an engine-level tee

The writing lives in `run()` in `kata-core`, not in the CLI. Kata's creed is that the `kata` binary is the single execution path the GUI, Shokunin, and CI all share; the GUI relays events over a Tauri channel and never touches the CLI's stdout `emit` closure, so CLI-level writing would silently give the GUI no transcript and force a per-frontend reimplementation. Engine-level means every consumer gets identical transcripts for free.

`run()` already threads a single `emit: impl Fn(KataEvent)` through its whole loop. The change wraps that closure once, at the top of the run, into a **tee**:

1. Resolve the transcript path and open the file (best-effort — see Error handling).
2. Build `tee = |event| { write event as a JSON line to the file; flush; call the original emit(event); }`.
3. Pass `tee` everywhere `emit` is used today. No individual call site changes.

Flush-per-line is deliberate: a run reaped by the turn cap or wall-clock timeout, cancelled, or panicking still leaves a complete transcript up to the moment it stopped — which is precisely when a record is most valuable. A `LineWriter` (or an explicit `flush()` after each `writeln!`) gives this.

The serialization is the same `serde_json::to_string(&event)` the CLI uses; the file is byte-identical to what the CLI prints to stdout.

## Path resolution

`<kata-home>/runs/<slug(spec.name)>-<utc-stamp>.jsonl`, where:

- **`<kata-home>`** follows the existing convention in `worktree.rs`: `KATA_HOME` if set, else `HOME`/`USERPROFILE` joined with `.kata`. The env override is what makes the feature testable.
- **Targeted cleanup:** the shared `KATA_HOME → HOME/USERPROFILE/.kata` base resolution is currently inlined in `worktree.rs::worktrees_dir()`. Factor it into one `kata_home()` helper that both `runs_dir()` and `worktrees_dir()` call, rather than copy-pasting the resolution and its `NoHome` error. This is a small improvement to code we are already touching, not unrelated refactoring.
- **`slug(spec.name)`** sanitizes the spec name to a filesystem-safe segment (map anything outside `[A-Za-z0-9_-]` to `-`, trim, fall back to `bundle`). This logic exists today as a private `slug()` in `kata-cli/src/main.rs`; move it to `kata-core::fsutil` so the engine can reuse it. Spec names may legally contain path separators (the bundle code documents this), so sanitizing here is a path-traversal safety requirement, not a nicety.
- **`<utc-stamp>`** is a human-readable compact UTC timestamp, `YYYYMMDDThhmmssZ` (e.g. `20260618T143022Z`). The repo carries no date crate and is deliberately dependency-light, so this is computed with a small zero-dependency `civil_from_unix_secs` helper (the standard epoch→civil-date algorithm) rather than adding `chrono`/`time`. The formatting helper is a pure function of seconds-since-epoch — it is unit-tested against fixed values (`0 → "19700101T000000Z"`) with no clock involved; only the "read the current time" call at the use site is non-deterministic.

Second-granularity stamps can in principle collide if the same spec starts twice within one second. This is acceptable: the engine opens the file with create-and-truncate, the resolved path is announced (so a collision is observable), and sub-second uniqueness is not worth a more complex name. (If it ever bites, append a short counter — noted, not built.)

## Error handling — best-effort, never fatal

A transcript is observability, not the work product. If the path cannot be resolved (no home directory) or the file cannot be opened (permission denied, read-only volume), the engine emits a `warn`-level `Log` event explaining the miss and **continues the run with the original `emit`** (no tee). Losing a log file must never kill a real run. This mirrors the spirit of the rest of the leash: the run is about the agent's work, and observability degrades gracefully.

## Surfacing the path

No protocol change. At run start, after the file is opened, the engine emits an `info`-level `Log` event naming the resolved path (so the path is recorded inside the transcript itself, which is harmless and occasionally handy). The CLI additionally prints the path at run end so a terminal operator sees where it went. A richer integration — a `transcript` path field on `run.completed` so the GUI can render an "open transcript" link — is a clean future addition but is intentionally left out of v1 to keep the contract and the bindings unchanged.

## Interaction with worktree isolation

The transcript always lands under `<kata-home>/runs/`, independent of whether the run uses `isolation = "worktree"`. A transcript is run metadata about the observation, not a work artifact, so it belongs with Kata's home state, never inside the (possibly isolated) workdir.

## Testing

- **Engine integration (`run_it.rs`, driving `fake-claude`):** these tests already set `KATA_HOME` for worktree cases. Point it at a temp dir, run a fake-claude job, and assert: (1) exactly one `.jsonl` appears under `<KATA_HOME>/runs/`, (2) every line parses as JSON, (3) the first event is `run.started` and the last is `run.completed`. These mutate global env → keep `#[serial]`, like their neighbours.
- **Best-effort path:** set `KATA_HOME` to an unwritable location (or unset all of `KATA_HOME`/`HOME`/`USERPROFILE`), run, and assert the run still completes with its normal exit code and a `warn` log is emitted — no transcript, no failure.
- **`civil_from_unix_secs` unit tests:** pure-function assertions against known epochs (`0`, a known 2026 instant, a leap-year date) with no clock.
- **`slug` tests** move with the function to `fsutil` (the existing CLI tests for traversal/empty-fallback come along).

## Implementation surface

- `crates/kata-core/src/run.rs` — wrap `emit` into the tee; resolve + open the transcript at run start; best-effort warn-and-continue; `info` log of the path.
- `crates/kata-core/src/fsutil.rs` — receive the moved `slug()`; add `kata_home()` and `runs_dir()`; add `civil_from_unix_secs` + the `YYYYMMDDThhmmssZ` formatter.
- `crates/kata-core/src/worktree.rs` — `worktrees_dir()` calls the shared `kata_home()` instead of its inlined resolution.
- `crates/kata-cli/src/main.rs` — drop the private `slug()` (now in `fsutil`); print the transcript path at run end.
- Tests: `crates/kata-core/tests/run_it.rs` (transcript written / best-effort), `fsutil` unit tests.

## Companion fix shipping on the same branch (not part of this spec's design, recorded for branch context)

The interactive bug that prompted this work — claude calling its built-in `AskUserQuestion` instead of Kata's `ask_user` MCP tool, so the run never routes through the ask bridge and the AskPanel never appears — ships on the same branch as its own first task. Root cause: when `interactive.enabled`, the engine wires the `ask_user` MCP tool and appends a retasking note but never removes claude's built-in `AskUserQuestion`, so with the full default toolset present claude reaches for the salient built-in. Fix: add `--disallowedTools AskUserQuestion` to the invocation whenever `interactive.enabled` (verified flag via `claude --help`), and sharpen the retask note to name the built-in it must not use. Covered by its own engine test asserting the invocation carries the flag under interactive and omits it otherwise. It is a root-caused debugging fix and needs no design of its own; it is noted here only so the branch's scope is legible.
