# Run-history backend + live Library rail — design

Cycle 2, PR-A (of two). The roadmap's Phase 4 item: "Saved-katas + run-history rail … needs a run-history backend (e.g. `~/.kata/history`) and wired actions." This PR delivers the **run-history** half; saved-kata persistence, the wired actions (re-run / open-in-compose / export), and the task-override "reusable agent" flow are PR-B.

## Problem

The Library screen (Layout C) shipped presentational at `/library` on fixtures (PR #2). Its UX is fully specified in `design/README.md` §2 and `design/prototype/library.{html,jsx}` and is **not** being redesigned. What is missing is the data: the Recent-runs rail and the read-only run-detail view read hand-written fixtures from `app/src/lib/library.ts`, not real runs.

The data already exists on disk. Since PR #13 every run tees its event stream to a transcript at `~/.kata/runs/<slug>-<YYYYMMDDThhmmssZ>.jsonl` (one `KataEvent` per line). This PR turns those transcripts into a live history backend behind the existing UX.

## Goals

- A `kata-core::history` reader that lists past runs and loads one run's full event stream from `~/.kata/runs/`.
- Surface it to the Workbench via two Tauri commands; the Svelte Library route swaps its Recent-runs + run-detail fixtures for live data, keeping the browser fixture fallback.
- Make transcripts self-describing so a leash-killed or cancelled run renders a faithful `exit N` badge and andon colour.
- `RunRecord` is a ts-rs-exported contract type, mirrored to TypeScript like `RunSpec`.

## Non-goals (this PR)

- Saved-kata persistence, "New kata", and the Saved-katas rail section going live — **PR-B**. The Saved-katas section stays on fixtures here.
- The run-detail action row (Re-run / Open in compose / Export bundle) and the task-override flow — **PR-B**. Detail stays read-only (as it already is).
- A `kata history` CLI subcommand. History stays a GUI concern until a consumer (Shokunin/CI) needs it; the reader lives in `kata-core` so adding the subcommand later is trivial.
- Any new write path. Transcripts are already written; this PR only reads them (plus the small terminal-event enrichment below).

## The terminal-event gap, and the fix

A `RunRecord` needs each run's exit code — for the `exit N` badge and, crucially, the andon colour (0 = green "completed"; 122–125/130 = amber "stopped"; other non-zero = red "error"). But the exit code lives only in the `run.completed` event. Leash trips emit `run.error { message }` and cancels emit `run.cancelled` — **neither carries the code today**, so a killed run cannot be rendered faithfully from its transcript.

**Fix (minimal, additive protocol change):** the two terminal error events carry the exit code the engine already knows at emit time.

- `KataEvent::RunError` gains `exit_code: i32`.
- `KataEvent::RunCancelled` changes from a unit variant to `{ exit_code: i32 }` (always `130`).

Emit sites set the code from the value already in scope: the leash branch pairs it in the existing `(exit_code, terminal)` tuple (122/123/124/125); cancel is `130`; the pre-spawn refusals (auth, worktree) are `2` (the code the CLI maps their `Err` to). The `KataEvent` protocol is hand-mirrored in `app/src/lib/events.ts` (not ts-rs); that file gets the new fields by hand.

**Consequence — one shared exit→state mapping.** With the code on every terminal event, `terminalStateFor` in `events.ts` is updated to derive the andon state from the exit code: `0 → success`, `122 | 123 | 124 | 125 | 130 → warning` ("stopped"), any other non-zero → `error`. This is a deliberate, correct behaviour change: a live leash/cancel stop now reads as andon-amber instead of red, matching the fixtures and the design intent — and live runs and history use the *same* derivation, so they never diverge.

## The reader — `kata-core::history`

A new module `crates/kata-core/src/history.rs`.

### `RunRecord` (ts-rs-exported → `app/src/bindings/RunRecord.ts`)

```rust
pub struct RunRecord {
    pub id: String,             // filename stem, e.g. "triage-flaky-test-20260618T142210Z"
    pub kata: String,           // from run.started.spec (authoritative, not the filename slug)
    pub started_at: u64,        // unix seconds, parsed from the filename's YYYYMMDDThhmmssZ stamp
    pub isolation: String,      // from run.started.isolation ("none" | "worktree")
    pub exit: Option<i32>,      // None = transcript has no terminal event (crashed/killed-9)
    pub turns: Option<u32>,     // run.completed.num_turns when present; None for killed runs
    pub cost_usd: Option<f64>,  // run.completed.cost_usd; None when the run never finished
    pub duration_ms: Option<u64>, // run.completed.duration_ms; None for killed runs
    pub result: Option<String>, // run.completed.result | run.error.message | "cancelled"
}
```

`started_at` is returned raw (unix seconds); the frontend keeps owning the relative "today · 14:22" formatting. The andon state is **not** stored — the frontend derives it from `exit` via the shared mapping above, so the record stays minimal and there is one source of truth for the colour.

### Functions

- `list_runs() -> Vec<RunRecord>` — scan `runs_dir()`, parse each `*.jsonl` by reading only its **first line** (`run.started`, for `kata`/`isolation`) and **last non-empty line** (the terminal event, for `exit` + completed-run fields), pair with the timestamp parsed from the filename. Sorted newest-first by `started_at`. A file whose first line is not `run.started`, or that is empty/unreadable, is skipped (best-effort; a malformed transcript never fails the listing). No full-file scan.
- `load_run(id: &str) -> Result<RunDetail, HistoryError>` where `RunDetail { record: RunRecord, events: Vec<KataEvent> }` — validate `id` matches `^[A-Za-z0-9_-]+$`, join `runs_dir()/<id>.jsonl`, confirm the resolved path is inside `runs_dir()` (path-traversal guard), read the full stream, parse each line into a `KataEvent`, and build the same `RunRecord` (here `turns` may be recomputed by counting `turn` events for exactness). Malformed lines are skipped.

`HistoryError` distinguishes `NotFound`, `InvalidId`, and `Io` so the Tauri layer can surface a useful message.

A small helper `parse_stamp(stem: &str) -> Option<u64>` (inverse of `fsutil::utc_stamp`) lives in `history` (or `fsutil` beside `utc_stamp`): take the trailing 16-char `YYYYMMDDThhmmssZ`, return unix seconds. The `kata` field comes from `run.started`, so the slug prefix is only used to locate the stamp, never to recover the name.

`KataEvent` already derives `Serialize`; the Tauri command returns `RunDetail` and the frontend consumes `events` as the same `StreamEvent` union `events.ts` already renders via `EventRow`. `KataEvent` also needs `Deserialize` for the reader to parse transcript lines back — today it is `Serialize`-only, so this PR adds `Deserialize` (and the round-trip is covered by a test).

**Only `RunRecord` is ts-rs-exported.** `RunDetail` wraps `Vec<KataEvent>`, and `KataEvent` is hand-mirrored in `events.ts` (not ts-rs), so `RunDetail` is **not** ts-rs-exported — the frontend hand-types it as `{ record: RunRecord; events: StreamEvent[] }` (in `events.ts` or `library.ts`), reusing the generated `RunRecord` and the existing `StreamEvent` union. The Rust `RunDetail` still derives `Serialize` so the Tauri command can return it as JSON.

## Wiring — Tauri + frontend

### Tauri (`app/src-tauri/src/lib.rs`)

Two new `#[tauri::command]` one-liners over `kata-core::history`, registered in `generate_handler!`:

- `list_runs() -> Result<Vec<RunRecord>, String>`
- `load_run(id: String) -> Result<RunDetail, String>` (maps `HistoryError` to a string message)

These follow the existing in-process-library pattern (`catalog`, `load_spec`), not the sidecar-spawn pattern (`run_spec`): reading transcripts is a cheap pure operation.

### `app/src/lib/api.ts`

Two gated wrappers mirroring the existing ones:

```ts
export const listRuns = () =>
  inTauri() ? invoke<RunRecord[]>("list_runs") : Promise.resolve(historyFixture);

export const loadRun = (id: string) =>
  inTauri() ? invoke<RunDetail>("load_run", { id }) : Promise.resolve(runDetailFixture(id));
```

The current `history` and `runStreams` fixtures in `library.ts` become the browser fallback (reshaped to the `RunRecord` / `RunDetail` types). `SavedKata` and `savedKatas` are untouched (PR-B).

### `/library` route (`app/src/routes/library/+page.svelte`)

Replace direct fixture imports for runs with `listRuns()` on mount and `loadRun(id)` on selection. The Recent-runs rail rows and the run-detail view render exactly as today — only the data source changes. The Saved-katas section continues to import `savedKatas` from `library.ts`. Run-detail stays read-only; the action buttons remain deferred to PR-B (rendered disabled or omitted per the current presentational state — keep current behaviour, do not wire them).

## Testing

**`kata-core::history`** (`crates/kata-core/tests/` or in-module) — seed a temp `KATA_HOME`/`runs_dir` with hand-written `.jsonl` transcripts and assert:
- a completed run → `exit Some(0)`, `turns`/`cost_usd`/`duration_ms` populated, `result` from `run.completed`.
- a leash-killed run (`run.error` with `exit_code: 125`) → `exit Some(125)`, `result` = the message, cost/duration `None`.
- a cancelled run (`run.cancelled` with `exit_code: 130`) → `exit Some(130)`, `result` = "cancelled".
- a no-terminal transcript (only `run.started` + a couple of events) → `exit None` (incomplete).
- a transcript with a malformed line → skipped line, record still built.
- ordering: `list_runs` returns newest-first by `started_at`.
- `load_run`: returns the full `events` vec; rejects `../escape` and absolute ids with `InvalidId`; unknown id → `NotFound`.
These mutate process-global `KATA_HOME`, so they are `#[serial]` (matching the existing convention).

**Protocol change** (`event.rs` / `run.rs`) — `RunError` and `RunCancelled` serialize with `exit_code`; `KataEvent` round-trips through `Deserialize`; update the existing `run_it.rs` match arms that destructure these variants (e.g. `RunError { .. }` patterns are unaffected, but any `RunCancelled` unit-variant match becomes `RunCancelled { .. }`), and assert the emitted `exit_code` for a cancel (130) and a leash trip.

**`fsutil`/`history`** — `parse_stamp` round-trips `utc_stamp` for known epochs and returns `None` for a stem without a valid trailing stamp.

**Frontend** — vitest for the exit→state helper (`0→success`, `125→warning`, `130→warning`, `1→error`, `null→` incomplete handling) and the `api.ts` fixture fallback; `npm run check` clean.

## File structure

- Create: `crates/kata-core/src/history.rs` (reader, `RunRecord`, `RunDetail`, `HistoryError`); register `pub mod history;` in `lib.rs`.
- Modify: `crates/kata-core/src/event.rs` (`exit_code` on `RunError`/`RunCancelled`; `Deserialize` on `KataEvent`), `crates/kata-core/src/run.rs` (emit the codes at terminal sites), `crates/kata-core/src/fsutil.rs` (`parse_stamp`, beside `utc_stamp`).
- Modify: `app/src-tauri/src/lib.rs` (two commands), `app/src/lib/api.ts` (two wrappers), `app/src/lib/events.ts` (mirror fields + exit→state mapping), `app/src/lib/library.ts` (reshape fixtures to the new types; keep saved-kata fixtures), `app/src/routes/library/+page.svelte` (consume the commands).
- Generate: `app/src/bindings/RunRecord.ts` (ts-rs). `RunDetail` is hand-typed on the frontend (it wraps the hand-mirrored `KataEvent` union), not ts-rs-exported.

## Sequencing

PR-A of cycle 2, on `feat/run-history` off `main` (independent of the cost-leash PR in review). TDD per change, clippy clean, `cargo build --locked` green, TS bindings regenerated, `npm run check`/`npm test` green, PR + review before merge. Then PR-B: saved-kata persistence (`~/.kata/katas`) + New kata + the wired actions + the run-time task-override "reusable agent" flow, which builds on this record/reader.
