# Run-history Backend + Live Library Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/library` Recent-runs rail and run-detail view live, backed by the `~/.kata/runs/*.jsonl` transcripts the engine already writes, instead of fixtures.

**Architecture:** A new `kata-core::history` module reads the runs directory into `RunRecord`s (list) and one run's full event stream (detail). Two Tauri commands expose it; the Svelte Library route swaps its run fixtures for gated `api.ts` calls. A minimal additive protocol change puts `exit_code` on the `run.error`/`run.cancelled` terminal events so a killed/cancelled run renders a faithful badge + andon colour.

**Tech Stack:** Rust (Cargo workspace: `kata-core`), ts-rs binding generation, SvelteKit/TypeScript (Svelte 5) Workbench, Tauri v2.

## Global Constraints

- TDD: write the failing test first, watch it fail, then implement.
- `cargo clippy --all-targets -- -D warnings` clean; `cargo build --locked` green.
- Do not hand-edit `app/src/bindings/`; regenerate with `cargo test -p kata-core --features ts export_bindings`.
- The `KataEvent` protocol is mirrored BY HAND in `app/src/lib/events.ts` (it is NOT ts-rs-exported); protocol changes update that file by hand.
- Engine tests that mutate process-global env (`KATA_HOME`, `KATA_FAKE_MODE`) are `#[serial]`; keep that.
- Exit-code andon mapping (the single source of truth for run colour): `0` → success; `122 | 123 | 124 | 125 | 130` → warning ("stopped"); any other non-zero → error; `null` (no terminal event recorded) → error.
- Andon state is derived from the exit code only (no `is_error` nuance) so live runs and history use the same derivation and never diverge.
- ts-rs maps `u64`/`i64` to TS `bigint`; annotate `u64` fields with `ts(as = "u32"...)` to emit `number` (follow the `Leash.timeout_secs` precedent in `spec.rs`). `i32`/`u32`/`f64` already map to `number`.
- Only `RunRecord` is ts-rs-exported. `RunDetail` wraps the hand-mirrored `KataEvent` union, so it is hand-typed in `events.ts`, not generated.
- Work on branch `feat/run-history` (already created, off `main`). Frequent commits, one per task.
- Scope is PR-A only: saved-kata persistence, the run-detail action buttons (Re-run / Open in compose / Export bundle), and task override are PR-B — do NOT wire them. The Saved-katas rail section stays on `library.ts` fixtures.

---

### Task 1: Protocol — `exit_code` on terminal error/cancel events + `Deserialize`

**Files:**
- Modify: `crates/kata-core/src/event.rs` (`KataEvent` + `DiffFile` derives; `RunError`/`RunCancelled` variants)
- Modify: `crates/kata-core/src/run.rs` (the four terminal emit sites + two pre-spawn emit sites)
- Modify: `crates/kata-core/tests/run_it.rs` (the `RunCancelled` match arm + strengthened assertions)
- Test: `crates/kata-core/src/event.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `KataEvent::RunError { message: String, exit_code: i32 }` and `KataEvent::RunCancelled { exit_code: i32 }`. `KataEvent` and `DiffFile` now also derive `Deserialize`, so `serde_json::from_str::<KataEvent>(line)` round-trips a transcript line. Task 2 relies on both.

- [ ] **Step 1: Write the failing test**

Add to `event.rs` `mod tests`:

```rust
#[test]
fn terminal_events_carry_exit_code_and_round_trip() {
    let cases = [
        KataEvent::RunError { message: "reached max turns (12)".into(), exit_code: 125 },
        KataEvent::RunCancelled { exit_code: 130 },
        KataEvent::RunCompleted { exit_code: 0, is_error: false, num_turns: 2, cost_usd: Some(0.02), duration_ms: 100, result: Some("done".into()) },
    ];
    for ev in cases {
        let json = serde_json::to_string(&ev).unwrap();
        let back: KataEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(ev, back, "round-trip mismatch for {json}");
    }
    let s = serde_json::to_string(&KataEvent::RunCancelled { exit_code: 130 }).unwrap();
    assert!(s.contains(r#""exit_code":130"#), "cancel must serialize its code: {s}");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kata-core event:: 2>&1 | tail -20`
Expected: compile error — `RunError`/`RunCancelled` have no `exit_code` field, and `KataEvent` does not implement `Deserialize`.

- [ ] **Step 3: Add the fields and `Deserialize`**

In `event.rs`, change the `KataEvent` derive line from `#[derive(Debug, Clone, PartialEq, Serialize)]` to:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
```

Change the two terminal variants:

```rust
    #[serde(rename = "run.error")]
    RunError { message: String, exit_code: i32 },
    #[serde(rename = "run.cancelled")]
    RunCancelled { exit_code: i32 },
```

`KataEvent::RunDiff` carries `Vec<DiffFile>`, so `DiffFile` must also deserialize. Change its derive from `#[derive(Debug, Clone, PartialEq, Serialize)]` to:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
```

Ensure `Deserialize` is imported: the file already has `use serde::{Deserialize, Serialize};` (Question uses it) — confirm, and add `Deserialize` to the import if missing.

- [ ] **Step 4: Update the engine emit sites in `run.rs`**

The two pre-spawn refusals (auth at ~line 154, worktree at ~line 214) map to exit 2:

```rust
                emit(KataEvent::RunError { message: message.clone(), exit_code: 2 });
```

(apply to both `emit(KataEvent::RunError { message: message.clone() });` sites.)

The four leash terminal arms (in the `Some(term)` match) gain the code that already pairs them in the tuple:

```rust
                Termination::Cancelled => (130, KataEvent::RunCancelled { exit_code: 130 }),
                Termination::TimedOut => (124, KataEvent::RunError {
                    message: format!("timed out after {timeout_secs}s"), exit_code: 124,
                }),
                Termination::MaxTurns => (125, KataEvent::RunError {
                    message: format!("reached max turns ({})", spec.leash.max_turns), exit_code: 125,
                }),
                Termination::AnswerTimeout => (123, KataEvent::RunError {
                    message: format!(
                        "answer deadline exceeded after {}s",
                        spec.interactive.answer_timeout_secs.unwrap_or(0)
                    ),
                    exit_code: 123,
                }),
```

- [ ] **Step 5: Update `run_it.rs` for the new variant shape**

The cancel test matches the unit variant; change it to the struct form and assert the code. Find:

```rust
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunCancelled)));
```

replace with:

```rust
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunCancelled { exit_code: 130 })));
```

In the max-turns test, strengthen the terminal assertion. Find that test's `matches!(e, KataEvent::RunError { .. })` and replace with:

```rust
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunError { exit_code: 125, .. })));
```

(Leave the other `RunError { .. }` matches as-is — `{ .. }` already covers the new field.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p kata-core 2>&1 | tail -15`
Expected: all pass (event round-trip + the full engine suite incl. `run_it.rs`).

- [ ] **Step 7: Clippy + commit**

```bash
cargo clippy -p kata-core --all-targets -- -D warnings
git add crates/kata-core/src/event.rs crates/kata-core/src/run.rs crates/kata-core/tests/run_it.rs
git commit -m "feat(event): exit_code on run.error/run.cancelled + KataEvent Deserialize"
```

---

### Task 2: `kata-core::history` reader + `fsutil::parse_stamp`

**Files:**
- Create: `crates/kata-core/src/history.rs`
- Modify: `crates/kata-core/src/lib.rs` (add `pub mod history;`)
- Modify: `crates/kata-core/src/fsutil.rs` (add `parse_stamp` + its `days_from_civil` inverse helper)
- Test: in-module `#[cfg(test)]` for both files
- Regenerate: `app/src/bindings/RunRecord.ts`

**Interfaces:**
- Consumes: `KataEvent` (`Deserialize`, Task 1), `fsutil::runs_dir`, `fsutil::utc_stamp`.
- Produces: `RunRecord` (struct below), `RunDetail { record: RunRecord, events: Vec<KataEvent> }`, `HistoryError { NotFound, InvalidId, Io(String) }`, `pub fn list_runs() -> Vec<RunRecord>`, `pub fn load_run(id: &str) -> Result<RunDetail, HistoryError>`, `fsutil::parse_stamp(stem: &str) -> Option<u64>`. Tasks 3–6 rely on these.

- [ ] **Step 1: Write the failing `parse_stamp` test**

Add to `fsutil.rs` `mod tests`:

```rust
#[test]
fn parse_stamp_inverts_utc_stamp() {
    for secs in [0u64, 1_000_000_000, 1_718_900_000, 1_766_096_012] {
        let stem = format!("my-kata-{}", utc_stamp(secs));
        assert_eq!(parse_stamp(&stem), Some(secs), "round-trip failed for {secs}");
    }
    assert_eq!(parse_stamp("no-stamp-here"), None);
    assert_eq!(parse_stamp("short"), None);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kata-core fsutil::tests::parse_stamp 2>&1 | tail -10`
Expected: compile error — `parse_stamp` not found.

- [ ] **Step 3: Implement `parse_stamp` + `days_from_civil`**

Add to `fsutil.rs` (beside `utc_stamp`/`civil_from_days`):

```rust
/// Inverse of [`utc_stamp`]: parse the trailing `YYYYMMDDThhmmssZ` of a filename
/// stem into seconds since the Unix epoch. `None` when the stem has no valid stamp.
pub fn parse_stamp(stem: &str) -> Option<u64> {
    let start = stem.len().checked_sub(16)?;
    let s = stem.get(start..)?;
    let b = s.as_bytes();
    if b.len() != 16 || b[8] != b'T' || b[15] != b'Z' { return None; }
    let n = |range: std::ops::Range<usize>| s.get(range).and_then(|x| x.parse::<i64>().ok());
    let (y, mo, d) = (n(0..4)?, n(4..6)? as u32, n(6..8)? as u32);
    let (h, mi, se) = (n(9..11)?, n(11..13)?, n(13..15)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) { return None; }
    let days = days_from_civil(y, mo, d);
    u64::try_from(days * 86_400 + h * 3600 + mi * 60 + se).ok()
}

/// Howard Hinnant's `days_from_civil`: (year, month, day) → days since 1970-01-01.
/// Inverse of [`civil_from_days`]. Public-domain algorithm.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = (y - era * 400) as i64; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p kata-core fsutil::tests::parse_stamp 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Write the failing `history` tests**

Create `crates/kata-core/src/history.rs` with only the test module first (so it compiles to a failing reference), or write tests and types together — either way, these are the behaviours to satisfy. Add at the bottom of `history.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::io::Write;

    // Each test seeds its own runs dir and points KATA_HOME at it.
    fn seed(files: &[(&str, &str)]) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("KATA_HOME", home.path());
        let runs = crate::fsutil::runs_dir().unwrap();
        std::fs::create_dir_all(&runs).unwrap();
        for (name, body) in files {
            let mut f = std::fs::File::create(runs.join(name)).unwrap();
            f.write_all(body.as_bytes()).unwrap();
        }
        home
    }

    const COMPLETED: &str = concat!(
        r#"{"type":"run.started","spec":"triage","model":null,"workdir":"/w","isolation":"none"}"#, "\n",
        r#"{"type":"turn","n":1}"#, "\n",
        r#"{"type":"run.completed","exit_code":0,"is_error":false,"num_turns":4,"cost_usd":0.041,"duration_ms":48120,"result":"isolated the flake"}"#, "\n",
    );
    const KILLED: &str = concat!(
        r#"{"type":"run.started","spec":"audit","model":null,"workdir":"/w","isolation":"worktree"}"#, "\n",
        r#"{"type":"run.error","message":"reached max turns (12)","exit_code":125}"#, "\n",
    );
    const CANCELLED: &str = concat!(
        r#"{"type":"run.started","spec":"perf","model":null,"workdir":"/w","isolation":"none"}"#, "\n",
        r#"{"type":"run.cancelled","exit_code":130}"#, "\n",
    );
    const INCOMPLETE: &str = concat!(
        r#"{"type":"run.started","spec":"doc","model":null,"workdir":"/w","isolation":"none"}"#, "\n",
        r#"{"type":"log","level":"info","message":"working"}"#, "\n",
    );

    #[test]
    #[serial]
    fn lists_records_newest_first_with_derived_fields() {
        let _h = seed(&[
            ("triage-20260618T100000Z.jsonl", COMPLETED),
            ("audit-20260618T120000Z.jsonl", &format!("{KILLED}garbage not json\n")),
            ("perf-20260617T080000Z.jsonl", CANCELLED),
        ]);
        let runs = list_runs();
        assert_eq!(runs.len(), 3);
        // newest first by started_at
        assert_eq!(runs[0].id, "audit-20260618T120000Z");
        assert_eq!(runs[2].id, "perf-20260617T080000Z");

        let completed = runs.iter().find(|r| r.kata == "triage").unwrap();
        assert_eq!(completed.exit, Some(0));
        assert_eq!(completed.turns, Some(4));
        assert_eq!(completed.cost_usd, Some(0.041));
        assert_eq!(completed.duration_ms, Some(48120));
        assert_eq!(completed.result.as_deref(), Some("isolated the flake"));

        let killed = runs.iter().find(|r| r.kata == "audit").unwrap();
        assert_eq!(killed.exit, Some(125));
        assert_eq!(killed.isolation, "worktree");
        assert_eq!(killed.turns, None); // unknown for killed runs
        assert_eq!(killed.cost_usd, None);
        assert_eq!(killed.result.as_deref(), Some("reached max turns (12)"));

        let cancelled = runs.iter().find(|r| r.kata == "perf").unwrap();
        assert_eq!(cancelled.exit, Some(130));
        assert_eq!(cancelled.result.as_deref(), Some("cancelled"));
    }

    #[test]
    #[serial]
    fn incomplete_transcript_has_no_exit() {
        let _h = seed(&[("doc-20260618T090000Z.jsonl", INCOMPLETE)]);
        let runs = list_runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].exit, None);
        assert_eq!(runs[0].result, None);
    }

    #[test]
    #[serial]
    fn load_run_returns_full_events_and_guards_id() {
        let _h = seed(&[("triage-20260618T100000Z.jsonl", COMPLETED)]);
        let detail = load_run("triage-20260618T100000Z").unwrap();
        assert_eq!(detail.record.exit, Some(0));
        assert!(detail.events.iter().any(|e| matches!(e, KataEvent::Turn { .. })));
        assert!(matches!(load_run("../escape"), Err(HistoryError::InvalidId)));
        assert!(matches!(load_run("nope-20260101T000000Z"), Err(HistoryError::NotFound)));
    }
}
```

- [ ] **Step 6: Run to verify they fail**

Run: `cargo test -p kata-core history:: 2>&1 | tail -20`
Expected: compile error — `RunRecord`, `list_runs`, etc. not defined.

- [ ] **Step 7: Implement the module**

Put this above the test module in `history.rs`:

```rust
//! Read past-run transcripts (`~/.kata/runs/*.jsonl`) into history records.
//! Each transcript is a stream of `KataEvent` lines; the first `run.started`
//! and the last terminal event determine a `RunRecord`.
use crate::event::KataEvent;
use crate::fsutil;
use serde::Serialize;
use std::path::Path;

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunRecord {
    pub id: String,
    pub kata: String,
    #[cfg_attr(feature = "ts", ts(as = "u32"))]
    pub started_at: u64,
    pub isolation: String,
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub exit: Option<i32>,
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub turns: Option<u32>,
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub cost_usd: Option<f64>,
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<u32>"))]
    pub duration_ms: Option<u64>,
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunDetail {
    pub record: RunRecord,
    pub events: Vec<KataEvent>,
}

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("run not found")]
    NotFound,
    #[error("invalid run id")]
    InvalidId,
    #[error("reading run: {0}")]
    Io(String),
}

/// All runs in `~/.kata/runs`, newest first. Best-effort: an unreadable or
/// malformed transcript is skipped, never fatal. Empty when there is no home.
pub fn list_runs() -> Vec<RunRecord> {
    let Some(dir) = fsutil::runs_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if let Ok(events) = read_events(&path) {
            if let Some(rec) = build_record(stem, &events) {
                out.push(rec);
            }
        }
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out
}

/// One run's record plus its full event stream (for the detail view).
pub fn load_run(id: &str) -> Result<RunDetail, HistoryError> {
    if !is_valid_id(id) { return Err(HistoryError::InvalidId); }
    let dir = fsutil::runs_dir().ok_or(HistoryError::NotFound)?;
    let path = dir.join(format!("{id}.jsonl"));
    // Path-traversal guard: the resolved file must sit directly under runs_dir.
    if path.parent() != Some(dir.as_path()) { return Err(HistoryError::InvalidId); }
    if !path.exists() { return Err(HistoryError::NotFound); }
    let events = read_events(&path).map_err(|e| HistoryError::Io(e.to_string()))?;
    let record = build_record(id, &events).ok_or(HistoryError::NotFound)?;
    Ok(RunDetail { record, events })
}

fn is_valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Read a transcript into events, skipping blank and malformed lines.
fn read_events(path: &Path) -> std::io::Result<Vec<KataEvent>> {
    use std::io::BufRead;
    let file = std::fs::File::open(path)?;
    let mut events = Vec::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() { continue; }
        if let Ok(ev) = serde_json::from_str::<KataEvent>(&line) {
            events.push(ev);
        }
    }
    Ok(events)
}

/// Derive a record from a transcript's events: the first `run.started` carries
/// kata + isolation; the last terminal event carries exit + summary fields.
/// `None` when the stem has no parseable stamp or there is no `run.started`.
fn build_record(stem: &str, events: &[KataEvent]) -> Option<RunRecord> {
    let started_at = fsutil::parse_stamp(stem)?;
    let (kata, isolation) = events.iter().find_map(|e| match e {
        KataEvent::RunStarted { spec, isolation, .. } => Some((spec.clone(), isolation.clone())),
        _ => None,
    })?;
    let terminal = events.iter().rev().find(|e| matches!(
        e,
        KataEvent::RunCompleted { .. } | KataEvent::RunError { .. } | KataEvent::RunCancelled { .. }
    ));
    let (exit, turns, cost_usd, duration_ms, result) = match terminal {
        Some(KataEvent::RunCompleted { exit_code, num_turns, cost_usd, duration_ms, result, .. }) =>
            (Some(*exit_code), Some(*num_turns), *cost_usd, Some(*duration_ms), result.clone()),
        Some(KataEvent::RunError { exit_code, message }) =>
            (Some(*exit_code), None, None, None, Some(message.clone())),
        Some(KataEvent::RunCancelled { exit_code }) =>
            (Some(*exit_code), None, None, None, Some("cancelled".to_string())),
        _ => (None, None, None, None, None),
    };
    Some(RunRecord {
        id: stem.to_string(), kata, started_at, isolation,
        exit, turns, cost_usd, duration_ms, result,
    })
}
```

Register the module: add `pub mod history;` to `crates/kata-core/src/lib.rs` (next to `pub mod event;`/`pub mod fsutil;`).

- [ ] **Step 8: Run the history tests + whole crate**

Run: `cargo test -p kata-core history:: 2>&1 | tail -20`
Expected: PASS (3 history tests).
Run: `cargo test -p kata-core 2>&1 | tail -8`
Expected: whole crate still green.

- [ ] **Step 9: Regenerate the TS binding + verify**

Run: `cargo test -p kata-core --features ts export_bindings`
Then confirm `app/src/bindings/RunRecord.ts` exists and every numeric field is `number` (NOT `bigint`) — e.g. `started_at: number`, `duration_ms?: number | null`.

- [ ] **Step 10: Clippy + commit**

```bash
cargo clippy -p kata-core --all-targets -- -D warnings
git add crates/kata-core/src/history.rs crates/kata-core/src/lib.rs crates/kata-core/src/fsutil.rs app/src/bindings/RunRecord.ts
git commit -m "feat(history): read ~/.kata/runs into RunRecord/RunDetail; parse_stamp"
```

---

### Task 3: Tauri commands — `list_runs` / `load_run`

**Files:**
- Modify: `app/src-tauri/src/lib.rs` (two `#[tauri::command]` fns + register in `generate_handler!`)

**Interfaces:**
- Consumes: `kata_core::history::{list_runs, load_run, RunRecord, RunDetail, HistoryError}` (Task 2).
- Produces: Tauri commands `list_runs() -> Result<Vec<RunRecord>, String>` and `load_run(id: String) -> Result<RunDetail, String>`, invokable from the webview. Task 5's `api.ts` calls them by these exact names.

- [ ] **Step 1: Add the commands**

In `app/src-tauri/src/lib.rs`, next to the other `#[tauri::command]` one-liners (e.g. `load_spec`), add:

```rust
#[tauri::command]
fn list_runs() -> Result<Vec<kata_core::history::RunRecord>, String> {
    Ok(kata_core::history::list_runs())
}

#[tauri::command]
fn load_run(id: String) -> Result<kata_core::history::RunDetail, String> {
    kata_core::history::load_run(&id).map_err(|e| e.to_string())
}
```

(If the file imports specific `kata_core` items at the top rather than fully-qualifying, match that style.)

- [ ] **Step 2: Register them**

In the `tauri::generate_handler![ ... ]` list, add `list_runs,` and `load_run,`:

```rust
        .invoke_handler(tauri::generate_handler![
            catalog,
            load_spec,
            save_spec,
            validate_spec,
            run_spec,
            cancel_run,
            submit_answer,
            list_runs,
            load_run
        ])
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p kata-app --locked 2>&1 | tail -8`
Expected: builds clean (Tauri commands compile; `RunRecord`/`RunDetail` implement `Serialize`).

- [ ] **Step 4: Clippy + commit**

```bash
cargo clippy -p kata-app --all-targets -- -D warnings
git add app/src-tauri/src/lib.rs
git commit -m "feat(app): list_runs / load_run Tauri commands over kata-core::history"
```

---

### Task 4: Frontend protocol mirror + `statusForExit` + `RunDetail` type

**Files:**
- Modify: `app/src/lib/events.ts`
- Test: `app/src/lib/events.test.ts`

**Interfaces:**
- Consumes: the generated `app/src/bindings/RunRecord.ts` (Task 2).
- Produces: `run.error`/`run.cancelled` union members gain `exit_code: number`; `statusForExit(exit: number | null): RunState`; `isStreamEvent(ev): ev is StreamEvent`; re-exported `RunRecord` and a new `RunDetail = { record: RunRecord; events: KataEvent[] }`. Tasks 5–6 import these.

- [ ] **Step 1: Write the failing test**

Add to `app/src/lib/events.test.ts` (create the file if absent, following the existing vitest style):

```ts
import { describe, it, expect } from "vitest";
import { statusForExit, isStreamEvent, terminalStateFor } from "./events";

describe("statusForExit", () => {
  it("maps exit codes to andon states", () => {
    expect(statusForExit(0)).toBe("success");
    expect(statusForExit(122)).toBe("warning");
    expect(statusForExit(125)).toBe("warning");
    expect(statusForExit(130)).toBe("warning");
    expect(statusForExit(1)).toBe("error");
    expect(statusForExit(2)).toBe("error");
    expect(statusForExit(null)).toBe("error");
  });
});

describe("terminalStateFor", () => {
  it("derives from exit_code for terminal events, null for rows", () => {
    expect(terminalStateFor({ type: "run.completed", exit_code: 0, is_error: false, num_turns: 1, cost_usd: null, duration_ms: 1, result: null })).toBe("success");
    expect(terminalStateFor({ type: "run.error", message: "x", exit_code: 125 })).toBe("warning");
    expect(terminalStateFor({ type: "run.cancelled", exit_code: 130 })).toBe("warning");
    expect(terminalStateFor({ type: "turn", n: 1 })).toBeNull();
  });
});

describe("isStreamEvent", () => {
  it("accepts stream rows, rejects meta/terminal events", () => {
    expect(isStreamEvent({ type: "turn", n: 1 })).toBe(true);
    expect(isStreamEvent({ type: "log", message: "x" })).toBe(true);
    expect(isStreamEvent({ type: "run.started", spec: "s", model: null, workdir: "/w", isolation: "none" })).toBe(false);
    expect(isStreamEvent({ type: "run.completed", exit_code: 0, is_error: false, num_turns: 1, cost_usd: null, duration_ms: 1, result: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix app test -- events.test 2>&1 | tail -20`
Expected: FAIL — `statusForExit` / `isStreamEvent` not exported (and the `exit_code` literals type-error until Step 3).

- [ ] **Step 3: Update `events.ts`**

Add `exit_code` to the two terminal union members:

```ts
  | { type: "run.error"; message: string; exit_code: number }
  | { type: "run.cancelled"; exit_code: number };
```

Replace `terminalStateFor` and add the helpers + types. Replace the existing `terminalStateFor` function with:

```ts
/** Andon state from a final exit code. 0 = success; the leash family
 *  (122-125) and cancel (130) are "stopped" (amber); any other non-zero is
 *  error; null (no terminal event recorded) is treated as error. Exit code is
 *  the authoritative signal — used identically for live runs and history. */
export function statusForExit(exit: number | null): RunState {
  if (exit === null) return "error";
  if (exit === 0) return "success";
  if (exit === 122 || exit === 123 || exit === 124 || exit === 125 || exit === 130) return "warning";
  return "error";
}

/** Terminal run state for an event, or null if the event is a streaming row. */
export function terminalStateFor(ev: KataEvent): RunState | null {
  switch (ev.type) {
    case "run.completed": return statusForExit(ev.exit_code);
    case "run.error": return statusForExit(ev.exit_code);
    case "run.cancelled": return statusForExit(ev.exit_code);
    default: return null;
  }
}
```

Add, after the `StreamEvent` type definition:

```ts
const NON_ROW_TYPES = new Set([
  "run.started", "run.completed", "run.error", "run.cancelled", "run.diff", "ask.requested", "ask.answered",
]);
/** Narrow a KataEvent to the row-renderable subset (for the event log). */
export function isStreamEvent(ev: KataEvent): ev is StreamEvent {
  return !NON_ROW_TYPES.has(ev.type);
}
```

At the top of the file (after the existing imports/types), re-export the record type and define the detail type:

```ts
import type { RunRecord } from "../bindings/RunRecord";
export type { RunRecord };
/** One past run: its record plus its full event stream (hand-typed because it
 *  wraps the hand-mirrored KataEvent union; not ts-rs-generated). */
export type RunDetail = { record: RunRecord; events: KataEvent[] };
```

- [ ] **Step 4: Run the test + type-check**

Run: `npm --prefix app test -- events.test 2>&1 | tail -20`
Expected: PASS.
Run: `npm --prefix app run check 2>&1 | tail -15`
Expected: no NEW errors. (`run.svelte.ts` calls `terminalStateFor` on live events — those now include `exit_code`, which the engine emits; the signature is unchanged so it still type-checks. The 2 pre-existing AskPanel warnings are unrelated.)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/events.ts app/src/lib/events.test.ts
git commit -m "feat(web): statusForExit + isStreamEvent + RunDetail; mirror exit_code"
```

---

### Task 5: Frontend wiring — `api.ts` + fixtures + the `/library` route

This is one task because the three files change together: reshaping `library.ts` to the live `RunRecord` shape breaks the route's old `r.when`/`r.cost`/`runStreams` bindings, so the route MUST move in the same task or `npm run check` cannot be green. Do all steps, then run the gate once at the end.

**Files:**
- Modify: `app/src/lib/api.ts` (two gated wrappers)
- Modify: `app/src/lib/library.ts` (reshape `history` to `RunRecord[]`; add `runDetailFixture`; keep `savedKatas`)
- Modify: `app/src/routes/library/+page.svelte` (consume the live data)
- Test: `app/src/lib/library.test.ts` (create)

**Interfaces:**
- Consumes: `inTauri()` from `$lib/mock`; `statusForExit`/`isStreamEvent`/`RunRecord`/`RunDetail` from `$lib/events` (Task 4); the `list_runs`/`load_run` Tauri commands (Task 3); `savedKatas` (unchanged fixture).
- Produces: `listRuns(): Promise<RunRecord[]>` and `loadRun(id: string): Promise<RunDetail>` in `api.ts`; the `/library` route rendering live history. End of the frontend chain.

- [ ] **Step 1: Reshape the run fixtures in `library.ts`**

Replace the `RunRecord` interface and the `history` array (and the `RunRecord`/`SavedKata` imports stay) with records matching the generated `RunRecord` shape. Replace the existing `export interface RunRecord { ... }` and `export const history: RunRecord[]` block with:

```ts
import type { RunRecord, RunDetail } from "./events";

export const history: RunRecord[] = [
  { id: "triage-flaky-test-20260618T142200Z", kata: "triage-flaky-test", started_at: 1750256520, isolation: "worktree", exit: 0, turns: 4, cost_usd: 0.041, duration_ms: 48120, result: "Isolated the flake to a clock-skew race in TokenValidator.IsExpired (mixed Now/UtcNow). Deterministic repro: pin clock to 23:59:59.6 local. No production code changed." },
  { id: "release-notes-20260618T110500Z", kata: "release-notes", started_at: 1750244700, isolation: "none", exit: 0, turns: 3, cost_usd: 0.028, duration_ms: 31540, result: "Drafted release notes for v2.4.0 from 18 merged PRs since v2.3.0; grouped by Added / Fixed / Changed." },
  { id: "audit-deps-20260617T174800Z", kata: "audit-deps", started_at: 1750182480, isolation: "none", exit: 125, turns: null, cost_usd: null, duration_ms: null, result: "reached max turns (12)" },
  { id: "triage-flaky-test-20260617T091400Z", kata: "triage-flaky-test", started_at: 1750151640, isolation: "worktree", exit: 0, turns: 5, cost_usd: 0.052, duration_ms: 61900, result: "Could not reproduce in 30 iterations on this commit; flake likely fixed by #1182. Recommend closing." },
  { id: "perf-sweep-20260616T160200Z", kata: "perf-sweep", started_at: 1750089720, isolation: "worktree", exit: 130, turns: null, cost_usd: null, duration_ms: null, result: "cancelled" },
  { id: "doc-refresh-20260616T103900Z", kata: "doc-refresh", started_at: 1750069140, isolation: "none", exit: 0, turns: 6, cost_usd: 0.061, duration_ms: 72400, result: "Updated README + 4 module docs for the renamed Auth API surface; 0 code changes." },
];

/** Browser-fallback detail: the fixture record + its scripted stream as KataEvents. */
export function runDetailFixture(id: string): RunDetail {
  const record = history.find((r) => r.id === id) ?? history[0];
  return { record, events: (runStreams[record.id] ?? []) as RunDetail["events"] };
}
```

Update the `runStreams` keys to match the new ids (`"triage-flaky-test-20260618T142200Z"`, `"audit-deps-20260617T174800Z"`, `"perf-sweep-20260616T160200Z"`) — rename the three existing keys from `r-2041`/`r-2035`/`r-2026` accordingly; their `StreamEvent[]` values are unchanged. Remove the now-unused `RunState` import if it is no longer referenced. `SavedKata` and `savedKatas` are unchanged.

- [ ] **Step 2: Add the gated wrappers in `api.ts`**

Add near the existing `catalog`/`loadSpec` wrappers:

```ts
import { history as historyFixture, runDetailFixture } from "$lib/library";
import type { RunRecord, RunDetail } from "$lib/events";

export const listRuns = (): Promise<RunRecord[]> =>
  inTauri() ? invoke<RunRecord[]>("list_runs") : Promise.resolve(historyFixture);

export const loadRun = (id: string): Promise<RunDetail> =>
  inTauri() ? invoke<RunDetail>("load_run", { id }) : Promise.resolve(runDetailFixture(id));
```

(Match the existing import grouping; `invoke` and `inTauri` are already imported in `api.ts`.)

- [ ] **Step 3: Write a fallback test**

Add `app/src/lib/library.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { history, runDetailFixture } from "./library";

describe("library fixtures match the RunRecord shape", () => {
  it("records carry the live field names", () => {
    const r = history[0];
    expect(typeof r.started_at).toBe("number");
    expect("cost_usd" in r).toBe(true);
    expect("when" in r).toBe(false); // old fixture shape is gone
  });
  it("runDetailFixture wraps record + events", () => {
    const d = runDetailFixture(history[0].id);
    expect(d.record.id).toBe(history[0].id);
    expect(Array.isArray(d.events)).toBe(true);
  });
});
```

(Do not commit or run the full gate yet — the route still references the old fixture field names and will fail `npm run check` until the next steps land. Continue.)

- [ ] **Step 4: Replace the route `<script>` data layer**

In `app/src/routes/library/+page.svelte`, replace the import of `history`/`runStreams` and the state/derivation block (current lines ~2–39) with:

```ts
  import { savedKatas } from "$lib/library";
  import { listRuns, loadRun } from "$lib/api";
  import { statusForExit, isStreamEvent, type RunState, type RunRecord } from "$lib/events";
```

(keep the existing component + icon imports), and replace the state/handlers (the `let selRun … selectKata …` block) with:

```ts
  let runs = $state<RunRecord[]>([]);
  let detail = $state<Awaited<ReturnType<typeof loadRun>> | null>(null);
  let selRun = $state<string | null>(null);
  let selKata = $state<string | null>(null);

  $effect(() => {
    listRuns().then((rs) => {
      runs = rs;
      if (selRun === null && rs.length > 0) selectRun(rs[0].id);
    });
  });

  let run = $derived(detail?.record ?? null);
  let stream = $derived(detail ? detail.events.filter(isStreamEvent) : null);

  const stateOf = (r: RunRecord): RunState => statusForExit(r.exit ?? null);
  const tone = (s: RunState) => (s === "success" ? "success" : s === "warning" ? "warning" : "error");
  const statTone = (s: RunState) => (s === "success" ? "success" : s === "error" ? "error" : undefined);
  const fmtMs = (ms: number | null | undefined) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  const fmtCost = (c: number | null | undefined) => (c == null ? "—" : `$${c.toFixed(3)}`);
  const fmtTurns = (t: number | null | undefined) => (t == null ? "—" : `${t}`);
  const fmtWhen = (secs: number) => {
    const d = new Date(secs * 1000);
    const hh = `${d.getHours()}`.padStart(2, "0");
    const mm = `${d.getMinutes()}`.padStart(2, "0");
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
    const day = days === 0 ? "today" : days === 1 ? "yesterday"
      : days < 7 ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]
      : d.toLocaleDateString();
    return `${day} · ${hh}:${mm}`;
  };

  async function selectRun(id: string) {
    selRun = id;
    const r = runs.find((x) => x.id === id);
    if (r) selKata = r.kata;
    detail = await loadRun(id);
  }
  function selectKata(name: string) {
    selKata = name;
    const latest = runs.find((r) => r.kata === name);
    if (latest) selectRun(latest.id);
    else { selRun = null; detail = null; }
  }
  const onKey = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
  };
```

- [ ] **Step 5: Update the Recent-runs rail markup**

Replace the Recent-runs section's `{#each history as r (r.id)}` with `{#each runs as r (r.id)}`, the count `{history.length}` with `{runs.length}`, and inside the row replace the dot/when/badge bindings:

```svelte
              <span class="wb-hist__dot dot-{stateOf(r)}"></span>
              <div class="wb-hist__body">
                <span class="wb-hist__kata">{r.kata}</span>
                <span class="wb-hist__when">{fmtWhen(r.started_at)} · {fmtTurns(r.turns)} turns · {fmtCost(r.cost_usd)}</span>
              </div>
              <span class="k-badge k-badge--{tone(stateOf(r))}">exit {r.exit ?? "—"}</span>
```

- [ ] **Step 6: Update the run-detail markup**

In the detail block, replace the field bindings (the action-row buttons stay exactly as they are — inert, deferred to PR-B):

```svelte
          <div class="wb-detail__title">
            <h2>{run.kata}</h2>
            <span class="wb-detail__id">{run.id}</span>
            <div style="margin-left:auto">
              <span class="k-status k-status--{stateOf(run)}"><span class="k-status__dot"></span>exit {run.exit ?? "—"}</span>
            </div>
          </div>
          <div class="wb-detail__sub">
            <span><Clock />{fmtWhen(run.started_at)}</span>
            <span><Hash />{fmtTurns(run.turns)} turns</span>
            <span><Coins />{fmtCost(run.cost_usd)}</span>
            <span><Cpu />{fmtMs(run.duration_ms)}</span>
          </div>
```

and the stats grid + result:

```svelte
          <div class="wb-detail__stats">
            <SummaryStat label="EXIT" value={run.exit ?? "—"} tone={statTone(stateOf(run))} />
            <SummaryStat label="TURNS" value={fmtTurns(run.turns)} />
            <SummaryStat label="COST" value={fmtCost(run.cost_usd)} />
            <SummaryStat label="DURATION" value={fmtMs(run.duration_ms)} />
          </div>
          <div class="wb-detail__result">{run.result ?? ""}</div>
```

and the event-log header that referenced `run.kata` stays; the `{#if stream}` block is unchanged (it already iterates `stream`).

- [ ] **Step 7: Fix the footer path**

The footer currently reads `~/.kata/history`; the real directory is `~/.kata/runs`. Update that label:

```svelte
        <span class="wb-statusbar__item"><Folder size={13} /> ~/.kata/runs</span>
```

Also update the footer count `{history.length} runs` → `{runs.length} runs` (the `{savedKatas.length} saved katas` part is unchanged).

- [ ] **Step 8: Type-check + test + browser smoke (the single gate for this task)**

Run: `npm --prefix app test 2>&1 | tail -15`
Expected: PASS (events + library suites).
Run: `npm --prefix app run check 2>&1 | tail -15`
Expected: no new errors (the 2 pre-existing AskPanel warnings remain).
Run (browser fallback renders from fixtures): `npm --prefix app run build 2>&1 | tail -5`
Expected: build succeeds. (A full visual check is `npm run dev` → `/library`, optional.)

- [ ] **Step 9: Commit the whole frontend wiring**

```bash
git add app/src/lib/api.ts app/src/lib/library.ts app/src/lib/library.test.ts app/src/routes/library/+page.svelte
git commit -m "feat(web): /library consumes live run-history (api + fixtures + route)"
```

---

### Final verification (before PR)

- [ ] `cargo test --workspace 2>&1 | tail -15` — all green.
- [ ] `cargo clippy --all-targets -- -D warnings` — clean.
- [ ] `cargo build --locked` — green.
- [ ] `npm --prefix app run check` (no new errors) and `npm --prefix app test` — green.
- [ ] `git diff --stat main` — only the files named across Tasks 1–5 changed.
- [ ] Invoke superpowers:requesting-code-review, then superpowers:finishing-a-development-branch to open the PR.

## Notes for the implementer

- **Saved katas, the detail action buttons, and task override are out of scope (PR-B).** Leave the Saved-katas rail section on `savedKatas` fixtures and the Re-run / Open-in-compose / Export buttons inert. Do not add persistence or wire actions.
- **Why exit code drives andon, not `is_error`:** the exit code is the authoritative leash signal and is present on every terminal event after Task 1; using it uniformly keeps live runs and history consistent. A clean exit 0 is success.
- **`turns`/`cost_usd`/`duration_ms` are best-effort:** present for completed runs (from `run.completed`), `null` for leash-killed/cancelled runs (claude never emits a cost without finishing). The UI renders `—` for `null`.
- **`list_runs` reads each whole (small) transcript** and reuses the same `build_record` path as `load_run` — one DRY derivation rather than a separate head+tail parser. Transcripts are tens of lines; this is fine.
