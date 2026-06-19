# Transcript auto-save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-save every `kata run`'s `KataEvent` stream to a per-run `.jsonl` under `<kata-home>/runs/`, and fix interactive runs so claude routes questions through Kata's `ask_user` tool instead of its built-in `AskUserQuestion`.

**Architecture:** An engine-level tee inside `run()` wraps the existing `emit` closure, writing each `KataEvent` as a JSON line to a file (flush-per-line) before forwarding it to the original consumer — so the CLI, the GUI, and CI all get identical transcripts for free. Path resolution reuses the `KATA_HOME → HOME/USERPROFILE/.kata` convention already used for worktrees, factored into a shared `fsutil::kata_home()`. The interactive fix adds `--disallowedTools AskUserQuestion` to the claude invocation whenever `interactive.enabled`.

**Tech Stack:** Rust (Cargo workspace), `serde_json`, `tempfile` (dev), `serial_test` (dev). No new runtime dependencies — the UTC timestamp is computed with a zero-dependency epoch→civil helper.

## Global Constraints

- No new runtime dependencies. The timestamp is formatted with a hand-written `civil_from_days` helper — do NOT add `chrono`/`time`/`jiff`.
- `cargo clippy --all-targets -- -D warnings` must stay clean.
- `cargo build --locked` must stay green; `cargo test --workspace` must pass.
- Tests that mutate process-global env (`KATA_HOME`, `KATA_FAKE_MODE`, `KATA_CLAUDE_BIN`) MUST be marked `#[serial]` (from `serial_test`).
- No event-protocol or `RunSpec` change in this plan: do NOT regenerate ts-rs bindings. The transcript path is surfaced via the existing `KataEvent::Log` variant only.
- Exit-code semantics are unchanged and must be preserved (124 timeout, 125 max-turns, 123 answer-deadline, 130 cancel; CLI 1 validation, 2 load/parse).
- Markdown prose is never hard-wrapped: one line per paragraph/bullet.
- Commit after each task on branch `feat/transcript-autosave`.

## File Structure

- `crates/kata-core/src/fsutil.rs` — gains `slug()` (moved from the CLI), `kata_home()`, `runs_dir()`, and the UTC timestamp pair (`utc_stamp` + private `civil_from_days`). The home/path/format plumbing lives here so both `run.rs` and `worktree.rs` consume one source.
- `crates/kata-core/src/worktree.rs` — `worktrees_dir()` is rewritten to call `fsutil::kata_home()` instead of inlining the env resolution.
- `crates/kata-core/src/command.rs` — `build_invocation` adds `--disallowedTools AskUserQuestion` under `interactive.enabled`.
- `crates/kata-core/src/run.rs` — sharpened `INTERACTIVE_RETASK`; a private `Transcript` writer + `open_transcript`; the `emit` tee; the path info-log; `RunOutcome.transcript_path`. Gains a `#[cfg(test)] mod tests` for the retask-note assertion.
- `crates/kata-cli/src/main.rs` — drops its private `slug()` (now in `fsutil`), repoints the bundle call, and prints the transcript path to stderr at run end.
- `crates/kata-core/tests/run_it.rs` — harness points `KATA_HOME` at an OS-temp dir; two new transcript integration tests.

---

### Task 1: Force interactive runs through `ask_user`

The bug: with `interactive.enabled` and a full default toolset (e.g. `bare = false`), claude reaches for its built-in `AskUserQuestion` instead of Kata's `ask_user` MCP tool, so the question never crosses the ask bridge and the AskPanel never appears. Root cause: the engine wires `ask_user` and appends a retask note but never removes the built-in. Fix: disallow the built-in, and name it in the retask note.

**Files:**
- Modify: `crates/kata-core/src/command.rs` (`build_invocation` + its `tests` module)
- Modify: `crates/kata-core/src/run.rs` (`INTERACTIVE_RETASK` const; add a `tests` module)

**Interfaces:**
- Consumes: `RunSpec.interactive.enabled: bool` (already exists, `spec.rs`).
- Produces: nothing new for later tasks — this task is self-contained.

- [ ] **Step 1: Write the failing tests (command.rs)**

Add to the `tests` module in `crates/kata-core/src/command.rs`:

```rust
#[test]
fn interactive_disallows_the_builtin_ask_tool() {
    let mut s = spec();
    s.interactive.enabled = true;
    let inv = build_invocation(&s, &assembled_with(None, None));
    assert!(
        inv.args.windows(2).any(|w| w[0] == "--disallowedTools" && w[1] == "AskUserQuestion"),
        "interactive runs must disallow the built-in AskUserQuestion; got {:?}",
        inv.args
    );
}

#[test]
fn non_interactive_keeps_the_builtin_tools() {
    let inv = build_invocation(&spec(), &assembled_with(None, None));
    assert!(!inv.args.iter().any(|a| a == "--disallowedTools"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kata-core --lib command::tests::interactive_disallows_the_builtin_ask_tool`
Expected: FAIL — the arg is not present yet.

- [ ] **Step 3: Add the flag in `build_invocation`**

In `crates/kata-core/src/command.rs`, immediately after the `--dangerously-skip-permissions` push (the line `args.push("--dangerously-skip-permissions".into());`) and before the `// NOTE: claude 2.1.x has NO --max-turns flag` comment, insert:

```rust
    // Interactive runs surface questions through Kata's `ask_user` MCP tool (wired
    // in run.rs), which crosses the ask bridge to the Workbench. Claude's built-in
    // AskUserQuestion would bypass that bridge entirely, so take it away — otherwise
    // claude prefers the salient built-in and the AskPanel never appears.
    if spec.interactive.enabled {
        args.push("--disallowedTools".into());
        args.push("AskUserQuestion".into());
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kata-core --lib command::tests`
Expected: PASS (both new tests and the existing command tests).

- [ ] **Step 5: Sharpen the retask note and assert it (run.rs)**

In `crates/kata-core/src/run.rs`, replace the `INTERACTIVE_RETASK` const body so it explicitly forbids the built-in:

```rust
const INTERACTIVE_RETASK: &str = "You have an `ask_user` tool. When you hit a consequential fork you cannot resolve from the task and context — ambiguous requirements, a decision with real trade-offs, a destructive action you are unsure about — call `ask_user` with a crisp question (choose the `kind` that fits: confirm / select / text) instead of guessing. Do not use it for trivia you can decide yourself. Do NOT use any built-in question or prompt tool such as `AskUserQuestion`; only `ask_user` reaches the operator.";
```

Then add a test module at the very end of `crates/kata-core/src/run.rs` (the file currently has no `tests` module):

```rust
#[cfg(test)]
mod tests {
    use super::INTERACTIVE_RETASK;

    #[test]
    fn retask_note_steers_to_ask_user_and_bans_the_builtin() {
        assert!(INTERACTIVE_RETASK.contains("ask_user"));
        assert!(INTERACTIVE_RETASK.contains("AskUserQuestion"));
    }
}
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `cargo test -p kata-core --lib run::tests::retask_note_steers_to_ask_user_and_bans_the_builtin`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/kata-core/src/command.rs crates/kata-core/src/run.rs
git commit -m "fix(interactive): disallow built-in AskUserQuestion so asks route through ask_user"
```

---

### Task 2: UTC timestamp formatter in `fsutil`

A zero-dependency `utc_stamp(unix_secs) -> String` producing `YYYYMMDDThhmmssZ`. Pure function of its input, so it is exhaustively unit-testable with no clock.

**Files:**
- Modify: `crates/kata-core/src/fsutil.rs` (new functions + tests)

**Interfaces:**
- Produces: `pub fn utc_stamp(unix_secs: u64) -> String` — consumed by Task 5's `open_transcript`.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/kata-core/src/fsutil.rs`:

```rust
#[test]
fn utc_stamp_formats_known_epochs() {
    assert_eq!(super::utc_stamp(0), "19700101T000000Z");
    // 2001-09-09 01:46:40 UTC — the classic 1e9 instant.
    assert_eq!(super::utc_stamp(1_000_000_000), "20010909T014640Z");
    // 2020-02-29 00:00:00 UTC — exercises the leap day.
    assert_eq!(super::utc_stamp(1_582_934_400), "20200229T000000Z");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kata-core --lib fsutil::tests::utc_stamp_formats_known_epochs`
Expected: FAIL with "cannot find function `utc_stamp`".

- [ ] **Step 3: Implement the formatter**

Add to `crates/kata-core/src/fsutil.rs` (top-level, above the `tests` module). Add `use std::path::PathBuf;` to the existing `use std::path::Path;` import line — change it to `use std::path::{Path, PathBuf};` (PathBuf is needed by Task 3 in the same file):

```rust
/// Format seconds-since-the-Unix-epoch (UTC) as a compact stamp `YYYYMMDDThhmmssZ`.
/// Pure function of the input — no system clock — so it is deterministically testable.
pub fn utc_stamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let sod = unix_secs % 86_400;
    let (h, m, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}{mo:02}{d:02}T{h:02}{m:02}{s:02}Z")
}

/// Howard Hinnant's `civil_from_days`: convert days since 1970-01-01 to
/// (year, month, day). Public-domain algorithm, valid for the full range we care
/// about. See https://howardhinnant.github.io/date_algorithms.html#civil_from_days
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kata-core --lib fsutil::tests::utc_stamp_formats_known_epochs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kata-core/src/fsutil.rs
git commit -m "feat(fsutil): zero-dep utc_stamp formatter"
```

---

### Task 3: Shared `kata_home()` + `runs_dir()`; refactor worktree resolution

Factor the `KATA_HOME → HOME/USERPROFILE/.kata` resolution into one helper both consumers share, and rewrite `worktrees_dir()` on top of it.

**Files:**
- Modify: `crates/kata-core/src/fsutil.rs` (new functions + tests)
- Modify: `crates/kata-core/src/worktree.rs` (`worktrees_dir()` body)

**Interfaces:**
- Produces: `pub fn kata_home() -> Option<PathBuf>` and `pub fn runs_dir() -> Option<PathBuf>`. `runs_dir` is consumed by Task 5.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/kata-core/src/fsutil.rs`, and add `use serial_test::serial;` to that module's `use super::*;` neighborhood:

```rust
#[test]
#[serial]
fn kata_home_resolution_order() {
    let saved: Vec<(&str, Option<String>)> = ["KATA_HOME", "HOME", "USERPROFILE"]
        .iter().map(|k| (*k, std::env::var(k).ok())).collect();
    let restore = || for (k, v) in &saved {
        match v { Some(val) => std::env::set_var(k, val), None => std::env::remove_var(k) }
    };

    // 1. KATA_HOME wins, taken verbatim (not joined with .kata).
    std::env::set_var("KATA_HOME", "/tmp/khome");
    assert_eq!(super::kata_home(), Some(std::path::PathBuf::from("/tmp/khome")));
    assert_eq!(super::runs_dir(), Some(std::path::PathBuf::from("/tmp/khome").join("runs")));

    // 2. Falls back to <HOME>/.kata.
    std::env::remove_var("KATA_HOME");
    std::env::remove_var("USERPROFILE");
    std::env::set_var("HOME", "/tmp/h");
    assert_eq!(super::kata_home(), Some(std::path::PathBuf::from("/tmp/h").join(".kata")));

    // 3. Nothing set => None.
    std::env::remove_var("HOME");
    std::env::remove_var("USERPROFILE");
    std::env::remove_var("KATA_HOME");
    assert_eq!(super::kata_home(), None);

    restore();
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kata-core --lib fsutil::tests::kata_home_resolution_order`
Expected: FAIL with "cannot find function `kata_home`".

- [ ] **Step 3: Implement the helpers**

Add to `crates/kata-core/src/fsutil.rs` (top-level):

```rust
/// Resolve Kata's home directory: `KATA_HOME` if set and non-empty (taken
/// verbatim), else `<HOME or USERPROFILE>/.kata`. `None` when no home variable is
/// set — callers decide whether that is fatal (worktrees) or best-effort (transcripts).
pub fn kata_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("KATA_HOME") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    let base = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(base).join(".kata"))
}

/// `<kata-home>/runs`, where per-run transcripts are written. `None` when no home.
pub fn runs_dir() -> Option<PathBuf> {
    kata_home().map(|h| h.join("runs"))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p kata-core --lib fsutil::tests::kata_home_resolution_order`
Expected: PASS.

- [ ] **Step 5: Rewrite `worktrees_dir()` on the shared helper**

In `crates/kata-core/src/worktree.rs`, replace the whole `worktrees_dir` function (the one resolving `KATA_HOME`/`HOME`/`USERPROFILE`) with:

```rust
/// Resolve `<kata-home>/worktrees`. Returns `NoHome` rather than falling back to
/// "." — we must never scatter worktrees into the cwd.
fn worktrees_dir() -> Result<PathBuf, WorktreeError> {
    crate::fsutil::kata_home()
        .map(|h| h.join("worktrees"))
        .ok_or(WorktreeError::NoHome)
}
```

- [ ] **Step 6: Run worktree's resolution test to verify the refactor is behavior-preserving**

Run: `cargo test -p kata-core --lib worktree::tests::worktrees_dir_resolution_order`
Expected: PASS (the existing test is unchanged and still green).

- [ ] **Step 7: Commit**

```bash
git add crates/kata-core/src/fsutil.rs crates/kata-core/src/worktree.rs
git commit -m "refactor(fsutil): shared kata_home()/runs_dir(); worktree reuses it"
```

---

### Task 4: Move `slug()` into `fsutil`

The filesystem-safe spec-name sanitizer currently lives privately in the CLI. The engine needs it to name transcripts, so move it to `fsutil` (a path-traversal safety requirement: spec names may contain separators).

**Files:**
- Modify: `crates/kata-core/src/fsutil.rs` (add `slug` + its tests)
- Modify: `crates/kata-cli/src/main.rs` (delete the private `slug` + its two tests; call `kata_core::fsutil::slug`)

**Interfaces:**
- Produces: `pub fn slug(name: &str) -> String` — consumed by Task 5 and by the CLI bundle command.

- [ ] **Step 1: Add `slug` and its tests to `fsutil`**

Add to `crates/kata-core/src/fsutil.rs` (top-level):

```rust
/// Sanitize a spec name into a single filesystem-safe path segment: map anything
/// outside `[A-Za-z0-9_-]` to '-', trim leading/trailing '-', fall back to "bundle"
/// when nothing remains. Spec names may legally contain path separators, so this is
/// a path-traversal guard, not a cosmetic nicety.
pub fn slug(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = mapped.trim_matches('-');
    if trimmed.is_empty() { "bundle".to_string() } else { trimmed.to_string() }
}
```

Add to the `tests` module in `crates/kata-core/src/fsutil.rs`:

```rust
#[test]
fn slug_strips_path_separators_and_falls_back() {
    assert_eq!(super::slug("../x"), "x");
    assert_eq!(super::slug("a/b"), "a-b");
    assert_eq!(super::slug("a\\b"), "a-b");
    assert_eq!(super::slug("triage-flaky_1"), "triage-flaky_1");
    assert_eq!(super::slug("型"), "bundle");
    assert_eq!(super::slug("..."), "bundle");
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cargo test -p kata-core --lib fsutil::tests::slug_strips_path_separators_and_falls_back`
Expected: PASS.

- [ ] **Step 3: Repoint the CLI and delete its private `slug`**

In `crates/kata-cli/src/main.rs`:

1. Delete the entire private `fn slug(name: &str) -> String { ... }` (the doc-commented function near the top of the file).
2. In `cmd_bundle`, change the default-output line from `format!("{}-bundle", slug(&spec.name))` to `format!("{}-bundle", kata_core::fsutil::slug(&spec.name))`.
3. In the `#[cfg(test)] mod tests`, change `use super::{slug, parse_stdin_line, StdinCmd};` to `use super::{parse_stdin_line, StdinCmd};`, and delete the two tests `slug_strips_path_separators_and_traversal` and `slug_preserves_safe_chars_and_falls_back_when_empty` (their coverage moved to `fsutil` in Step 1).

- [ ] **Step 4: Build and test the CLI crate**

Run: `cargo test -p kata-cli`
Expected: PASS — `parses_cancel_and_answer_lines` still runs; the slug tests are gone; the bundle command compiles against `fsutil::slug`.

- [ ] **Step 5: Commit**

```bash
git add crates/kata-core/src/fsutil.rs crates/kata-cli/src/main.rs
git commit -m "refactor: move slug() into kata-core fsutil for engine reuse"
```

---

### Task 5: Engine-level transcript tee

Wrap `emit` so every `KataEvent` is written (flush-per-line) to `<kata-home>/runs/<slug>-<utc>.jsonl`, best-effort, and surface the path on `RunOutcome` and via a `Log` event. Point the test harness's `KATA_HOME` at OS-temp so the suite never writes into the developer's real home.

**Files:**
- Modify: `crates/kata-core/src/run.rs` (`RunOutcome`; imports; `Transcript`/`open_transcript`; the tee; the path log)
- Modify: `crates/kata-cli/src/main.rs` (print the path at run end)
- Modify: `crates/kata-core/tests/run_it.rs` (harness `KATA_HOME`; two new tests)

**Interfaces:**
- Consumes: `fsutil::runs_dir()`, `fsutil::slug()`, `fsutil::utc_stamp()` (Tasks 2-4).
- Produces: `RunOutcome.transcript_path: Option<String>` — read by the CLI.

- [ ] **Step 1: Point the test harness at an OS-temp KATA_HOME**

In `crates/kata-core/tests/run_it.rs`, extend `with_fake` so always-on transcripts never touch the real home:

```rust
fn with_fake(mode: &str) {
    std::env::set_var("KATA_CLAUDE_BIN", env!("CARGO_BIN_EXE_fake-claude"));
    std::env::set_var("KATA_FAKE_MODE", mode);
    // Always-on transcripts would otherwise write into the developer's real
    // ~/.kata/runs during the suite. Point KATA_HOME at an OS-temp dir. Tests that
    // assert transcript contents override KATA_HOME with their own tempdir after
    // calling with_fake.
    std::env::set_var("KATA_HOME", std::env::temp_dir().join("kata-test-home"));
}
```

- [ ] **Step 2: Write the failing transcript tests**

Add to `crates/kata-core/tests/run_it.rs`:

```rust
#[test]
#[serial]
fn run_writes_transcript_of_the_event_stream() {
    with_fake("ok");
    let khome = tempfile::tempdir().unwrap();
    std::env::set_var("KATA_HOME", khome.path());
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(&base_spec(&work.path().to_string_lossy()), &[] as &[CatalogEntry], &cancel, &kata_core::run::AnswerRx::default(), |e| events.push(e)).unwrap();
    assert_eq!(outcome.exit_code, 0);

    let runs = khome.path().join("runs");
    let files: Vec<_> = std::fs::read_dir(&runs).unwrap().map(|e| e.unwrap().path()).collect();
    assert_eq!(files.len(), 1, "exactly one transcript expected, got {files:?}");

    let body = std::fs::read_to_string(&files[0]).unwrap();
    let lines: Vec<&str> = body.lines().collect();
    assert!(lines.iter().all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok()),
        "every transcript line must be valid JSON: {body}");
    let first: serde_json::Value = serde_json::from_str(lines.first().unwrap()).unwrap();
    let last: serde_json::Value = serde_json::from_str(lines.last().unwrap()).unwrap();
    assert_eq!(first["type"], "run.started");
    assert_eq!(last["type"], "run.completed");

    assert_eq!(outcome.transcript_path.as_deref(), Some(files[0].to_string_lossy().as_ref()));

    std::env::remove_var("KATA_HOME");
}

#[test]
#[serial]
fn run_survives_when_transcript_cannot_be_written() {
    with_fake("ok");
    // A regular file where a directory is needed makes create_dir_all fail — portably.
    let blocker = tempfile::NamedTempFile::new().unwrap();
    std::env::set_var("KATA_HOME", blocker.path());
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(&base_spec(&work.path().to_string_lossy()), &[] as &[CatalogEntry], &cancel, &kata_core::run::AnswerRx::default(), |e| events.push(e)).unwrap();

    assert_eq!(outcome.exit_code, 0, "a missing transcript must never fail the run");
    assert!(outcome.transcript_path.is_none());
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::Log { level, message } if level == "warn" && message.contains("transcript"))),
        "a warn log must explain the missing transcript");

    std::env::remove_var("KATA_HOME");
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p kata-core --test run_it run_writes_transcript_of_the_event_stream run_survives_when_transcript_cannot_be_written`
Expected: FAIL — `RunOutcome` has no `transcript_path` field (compile error), and no `runs` dir is produced.

- [ ] **Step 4: Add the `transcript_path` field and the writer**

In `crates/kata-core/src/run.rs`:

1. Change the `std::io::BufReader` import line to also bring in `Write`:

```rust
use std::io::{BufReader, Write};
```

2. Extend `RunOutcome`:

```rust
#[derive(Debug)]
pub struct RunOutcome {
    pub exit_code: i32,
    /// Absolute path of the per-run transcript, or `None` if it could not be written.
    pub transcript_path: Option<String>,
}
```

3. Add the writer + opener near the top of the file (just below the `INTERACTIVE_RETASK` const is a good home):

```rust
/// Per-run transcript writer: each `KataEvent` is one JSON line, flushed
/// immediately so a run killed by the leash, a cancel, or a panic still leaves a
/// complete-up-to-the-cut record.
struct Transcript {
    out: std::io::BufWriter<std::fs::File>,
}

impl Transcript {
    fn write(&mut self, event: &KataEvent) {
        if let Ok(line) = serde_json::to_string(event) {
            let _ = writeln!(self.out, "{line}");
            let _ = self.out.flush();
        }
    }
}

/// Best-effort: open `<kata-home>/runs/<slug>-<utc>.jsonl`. `Err` (no home,
/// unwritable) means the caller logs a warning and runs without a transcript.
fn open_transcript(spec_name: &str) -> Result<(Transcript, std::path::PathBuf), String> {
    let dir = crate::fsutil::runs_dir().ok_or_else(|| "no home directory for ~/.kata".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = format!("{}-{}.jsonl", crate::fsutil::slug(spec_name), crate::fsutil::utc_stamp(now));
    let path = dir.join(name);
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    Ok((Transcript { out: std::io::BufWriter::new(file) }, path))
}
```

- [ ] **Step 5: Install the tee in `run()`**

In `crates/kata-core/src/run.rs`, immediately after `let mut inv = build_invocation(spec, &assembled);` (the line ending the setup before the bare-auth fail-fast), insert:

```rust
    // Tee the event stream to a per-run transcript. Best-effort: a missing
    // transcript must never fail a real run. Set up before the auth fail-fast so a
    // refused run still leaves a record of why.
    let (mut transcript, transcript_path) = match open_transcript(&spec.name) {
        Ok((t, p)) => (Some(t), Some(p)),
        Err(e) => {
            emit(KataEvent::Log { level: "warn".into(), message: format!("transcript unavailable: {e}") });
            (None, None)
        }
    };
    let mut emit = |event: KataEvent| {
        if let Some(t) = transcript.as_mut() {
            t.write(&event);
        }
        emit(event);
    };
```

Then, immediately after the existing `emit(KataEvent::Log { ... "assembled kit: ..." });` block (the one right after `emit(KataEvent::RunStarted { ... })`), add the path announcement so it lands just after `run.started`:

```rust
    if let Some(p) = &transcript_path {
        emit(KataEvent::Log { level: "info".into(), message: format!("transcript: {}", p.display()) });
    }
```

Finally, change the function's return at the end of `run()` from `Ok(RunOutcome { exit_code })` to:

```rust
    Ok(RunOutcome {
        exit_code,
        transcript_path: transcript_path.map(|p| p.display().to_string()),
    })
```

- [ ] **Step 6: Run the transcript tests to verify they pass**

Run: `cargo test -p kata-core --test run_it run_writes_transcript_of_the_event_stream run_survives_when_transcript_cannot_be_written`
Expected: PASS.

- [ ] **Step 7: Print the transcript path from the CLI**

In `crates/kata-cli/src/main.rs`, in `cmd_run`, change the `Ok(outcome)` arm so it announces the path on stderr (never stdout — stdout carries the JSON event stream):

```rust
        Ok(outcome) => {
            if let Some(p) = &outcome.transcript_path {
                eprintln!("transcript: {p}");
            }
            match u8::try_from(outcome.exit_code) {
                Ok(c) => ExitCode::from(c),
                Err(_) => ExitCode::FAILURE,
            }
        }
```

- [ ] **Step 8: Full workspace verification**

Run: `cargo test --workspace`
Expected: PASS (all engine, CLI, and integration tests).

Run: `cargo clippy --all-targets -- -D warnings`
Expected: clean, no warnings.

Run: `cargo build --locked`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add crates/kata-core/src/run.rs crates/kata-cli/src/main.rs crates/kata-core/tests/run_it.rs
git commit -m "feat(engine): auto-save per-run transcript of the KataEvent stream"
```

---

## Self-Review

**Spec coverage:**
- Normalized `KataEvent` stream content → Task 5 (serializes each `KataEvent`, byte-identical to the CLI's stdout). ✓
- Always-on, `<kata-home>/runs/<slug>-<utc>.jsonl` → Task 5 `open_transcript`. ✓
- Engine-level tee → Task 5 wraps `emit`. ✓
- Flush-per-line → Task 5 `Transcript::write` flushes each line. ✓
- `kata_home()`/`runs_dir()` sharing + worktree refactor → Task 3. ✓
- `slug()` moved to `fsutil` → Task 4. ✓
- Human-readable UTC stamp, zero-dep → Task 2. ✓
- Best-effort, warn-and-continue → Task 5 (`open_transcript` Err arm + `run_survives_*` test). ✓
- Path surfaced via `Log` event + CLI prints it → Task 5 Steps 5 and 7. ✓
- No protocol/spec/binding change → confirmed; only `Log` reused, `RunOutcome` is a Rust return type (not ts-rs mirrored). ✓
- Interactive bug fix (`--disallowedTools AskUserQuestion` + retask note) → Task 1. ✓
- Out of scope (retention, GUI browser, `run.completed` field) → not implemented, as intended. ✓

**Placeholder scan:** No TBD/TODO/"handle errors"/"similar to" — every code step shows complete code. ✓

**Type consistency:** `utc_stamp(u64) -> String`, `kata_home() -> Option<PathBuf>`, `runs_dir() -> Option<PathBuf>`, `slug(&str) -> String`, `open_transcript(&str) -> Result<(Transcript, PathBuf), String>`, `RunOutcome { exit_code, transcript_path: Option<String> }` — names and signatures match across Tasks 2-5 and their consumers. ✓
