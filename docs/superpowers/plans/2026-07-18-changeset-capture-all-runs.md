# Changeset capture on every run + cost/duration on all terminal events — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Kata run — worktree-isolated or not — emits a `run.diff` describing the file changes, and every terminal event (`run.completed`/`run.error`/`run.cancelled`) carries the run's cost and duration.

**Architecture:** Lift the git-diff logic out of `worktree.rs` into a new `changeset` module that diffs any directory. `run.rs` calls it against the run's working directory unconditionally, emitting `run.diff` (with `worktree`/`branch` now optional) on every run. The termination `match` threads `start.elapsed()` and the best-available cost into the new `run.error`/`run.cancelled` fields.

**Tech Stack:** Rust (Cargo workspace), `serde`/`serde_json`, `git` subprocess, `schemars` (schema feature), `ts-rs` (ts feature). Tests: `#[serial]` integration tests over the `fake-claude` binary.

## Global Constraints

- Rust edition and version are workspace-inherited; crate version bumps to `1.1.0` (this change is additive/minor per `CONTRACTS.md`).
- `KATA_EVENT_PROTOCOL_VERSION` stays `1` — these changes are additive, not breaking.
- US English only in all comments and docs. No hard word-wraps in markdown (one line per paragraph).
- After changing any `KataEvent` type: regenerate the event schema (`KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema schema_artifact_is_fresh`) and the ts bindings (`cargo test -p kata-core --features ts export_bindings`), then `cd app && npm run gen:events`. CI gates drift.
- Gates before any "done" claim: `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, `cargo build --locked`, `cargo test --workspace`.
- Integration tests that set process-global env vars (`KATA_FAKE_MODE`, `KATA_HOME`) MUST stay `#[serial]`.
- Work happens on branch `feat/changeset-capture` (already created).

## File Structure

- Create: `crates/kata-core/src/changeset.rs` — `DiffSummary` type + `diff_at(dir)` + `ChangesetError`. Owns all git-diff logic.
- Modify: `crates/kata-core/src/worktree.rs` — remove `DiffSummary` and `diff`; move their tests to `changeset.rs`. Keep `create`/`create_in`/`Worktree`/`WorktreeError`.
- Modify: `crates/kata-core/src/lib.rs` — declare `pub mod changeset;`.
- Modify: `crates/kata-core/src/event.rs` — `RunDiff.worktree`/`branch` become `Option`; `RunError`/`RunCancelled` gain `cost_usd` + `duration_ms`. Update round-trip tests.
- Modify: `crates/kata-core/src/run.rs` — thread cost/duration into terminal events; replace the worktree-only diff block with an unconditional `changeset::diff_at(&cwd)` emit.
- Modify: `crates/kata-core/tests/run_it.rs` — new coverage for non-worktree `run.diff` and terminal cost/duration.
- Modify: `schema/kata-events.schema.json`, `app/src/bindings/kata-events.ts` (generated — do not hand-edit), `Cargo.toml` version.
- Modify: `docs/consuming-kata.md` — note `run.diff` fires on every run and the end-state-baseline limitation.

---

## Task 1: Extract the `changeset` module

**Files:**
- Create: `crates/kata-core/src/changeset.rs`
- Modify: `crates/kata-core/src/lib.rs:79-84` (module declarations block)
- Modify: `crates/kata-core/src/worktree.rs` (remove `DiffSummary` + `diff` + their tests; keep the rest)

**Interfaces:**
- Consumes: `crate::event::DiffFile` (unchanged, stays in `event.rs`).
- Produces:
  - `pub struct DiffSummary { pub files: Vec<DiffFile>, pub insertions: u32, pub deletions: u32 }`
  - `pub fn diff_at(dir: &std::path::Path) -> Result<DiffSummary, ChangesetError>`
  - `pub enum ChangesetError { GitMissing, Git { cmd: String, status: Option<i32>, stderr: String }, Io(std::io::Error) }` (derives `thiserror::Error`, `Debug`)

- [ ] **Step 1: Create `changeset.rs` with the type, error, and `diff_at`**

Create `crates/kata-core/src/changeset.rs`. This is the body of the old `worktree::diff`, generalized to take a directory. It runs three git commands, never mutates the index, and reports untracked files as added.

```rust
//! Git changeset summary for a directory: `git diff HEAD` (tracked changes)
//! plus newly-created untracked files, WITHOUT mutating the index. Used for
//! both worktree-isolated runs (diff the worktree) and default runs (diff the
//! workdir). A non-git directory, a missing `git`, or any git failure is an
//! `Err` the caller degrades to a warning — a diff must never mask a run's
//! outcome.

use crate::event::DiffFile;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

/// A changeset for a directory, relative to its `HEAD`.
#[derive(Debug, Clone, PartialEq)]
pub struct DiffSummary {
    pub files: Vec<DiffFile>,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum ChangesetError {
    #[error("`git` was not found on PATH")]
    GitMissing,
    #[error("git {cmd} failed (status {status:?}): {stderr}")]
    Git {
        cmd: String,
        status: Option<i32>,
        stderr: String,
    },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Summarize `dir`'s changes vs its `HEAD`, including newly-created untracked
/// files, WITHOUT mutating the index. A directory that is not a git work tree
/// (or has no `HEAD`) surfaces as `Err(ChangesetError::Git { .. })`.
pub fn diff_at(dir: &Path) -> Result<DiffSummary, ChangesetError> {
    // Per-file insertions/deletions for tracked changes (binary => "-\t-").
    let numstat = git(dir, &["diff", "HEAD", "--numstat"])?;
    if !numstat.status.success() {
        return Err(ChangesetError::Git {
            cmd: "diff HEAD --numstat".into(),
            status: numstat.status.code(),
            stderr: String::from_utf8_lossy(&numstat.stderr).trim().to_string(),
        });
    }
    let mut counts: HashMap<String, (u32, u32)> = HashMap::new();
    for line in String::from_utf8_lossy(&numstat.stdout).lines() {
        let mut it = line.split('\t');
        let ins = it.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let del = it.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let path = it.next_back().unwrap_or("").to_string();
        if !path.is_empty() {
            counts.insert(path, (ins, del));
        }
    }

    // Statuses for tracked changes (A/M/D/R...).
    let name_status = git(dir, &["diff", "HEAD", "--name-status"])?;
    if !name_status.status.success() {
        return Err(ChangesetError::Git {
            cmd: "diff HEAD --name-status".into(),
            status: name_status.status.code(),
            stderr: String::from_utf8_lossy(&name_status.stderr)
                .trim()
                .to_string(),
        });
    }
    let mut files = Vec::new();
    let mut insertions = 0u32;
    let mut deletions = 0u32;
    for line in String::from_utf8_lossy(&name_status.stdout).lines() {
        let mut it = line.split('\t');
        let status = it.next().unwrap_or("");
        let path = it.next_back().unwrap_or("").to_string(); // last field handles renames
        if status.is_empty() || path.is_empty() {
            continue;
        }
        let (ins, del) = counts.get(&path).copied().unwrap_or((0, 0));
        insertions += ins;
        deletions += del;
        files.push(DiffFile {
            status: status.chars().next().unwrap().to_string(),
            path,
        });
    }

    // Untracked (newly-created) files: status "A", insertions = line count.
    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard"])?;
    if !untracked.status.success() {
        return Err(ChangesetError::Git {
            cmd: "ls-files --others --exclude-standard".into(),
            status: untracked.status.code(),
            stderr: String::from_utf8_lossy(&untracked.stderr)
                .trim()
                .to_string(),
        });
    }
    for path in String::from_utf8_lossy(&untracked.stdout).lines() {
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        let ins = std::fs::read_to_string(dir.join(path))
            .map(|c| c.lines().count() as u32)
            .unwrap_or(0); // unreadable/binary => 0
        insertions += ins;
        files.push(DiffFile {
            status: "A".into(),
            path: path.to_string(),
        });
    }

    Ok(DiffSummary {
        files,
        insertions,
        deletions,
    })
}

/// Run `git -C <dir> <args>`, mapping a missing binary to `GitMissing`.
fn git(dir: &Path, args: &[&str]) -> Result<std::process::Output, ChangesetError> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ChangesetError::GitMissing
            } else {
                ChangesetError::Io(e)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Init a git repo with one committed file ("tracked.txt").
    fn init_repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .arg("-C")
                .arg(d.path())
                .args(args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(d.path().join("tracked.txt"), "one\ntwo\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        d
    }

    #[test]
    fn diff_at_reports_modified_tracked_and_new_untracked() {
        let repo = init_repo();
        // Modify a tracked file (+1 line) and create an untracked file (+2 lines).
        std::fs::write(repo.path().join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(repo.path().join("new.txt"), "a\nb\n").unwrap();

        let d = diff_at(repo.path()).unwrap();
        assert!(
            d.files
                .iter()
                .any(|f| f.path == "tracked.txt" && f.status == "M"),
            "files: {:?}",
            d.files
        );
        assert!(
            d.files.iter().any(|f| f.path == "new.txt" && f.status == "A"),
            "files: {:?}",
            d.files
        );
        assert_eq!(d.insertions, 3, "1 added to tracked + 2 in new.txt");
        assert_eq!(d.deletions, 0);

        // The index must NOT have been mutated.
        let staged = Command::new("git")
            .arg("-C")
            .arg(repo.path())
            .args(["diff", "--cached", "--name-only"])
            .output()
            .unwrap();
        assert!(staged.stdout.is_empty(), "diff_at must not stage anything");
    }

    #[test]
    fn diff_at_clean_repo_is_empty() {
        let repo = init_repo();
        let d = diff_at(repo.path()).unwrap();
        assert!(d.files.is_empty(), "a clean repo has no changes: {:?}", d.files);
        assert_eq!(d.insertions, 0);
        assert_eq!(d.deletions, 0);
    }

    #[test]
    fn diff_at_non_repo_errors() {
        let notrepo = tempfile::tempdir().unwrap();
        let err = diff_at(notrepo.path()).unwrap_err();
        assert!(matches!(err, ChangesetError::Git { .. }), "got {err:?}");
    }
}
```

- [ ] **Step 2: Declare the module in `lib.rs`**

In `crates/kata-core/src/lib.rs`, add `changeset` to the "portable operations" block (keep it alphabetical-ish with the existing public modules):

```rust
// ---- portable operations the GUI and CLI also build on ----
pub mod bundle;
pub mod changeset;
pub mod history;
pub mod katas;
pub mod presets;
pub mod worktree;
```

- [ ] **Step 3: Remove `DiffSummary` + `diff` + their test from `worktree.rs`**

In `crates/kata-core/src/worktree.rs`:
1. Delete the `DiffSummary` struct (lines ~21-27, the `/// A diff summary...` block).
2. Delete the entire `pub fn diff(...)` function (lines ~89-175).
3. Delete the `diff_reports_modified_tracked_and_new_untracked` test in the `tests` module (it moved to `changeset.rs`, rewritten to not need a worktree).
4. Remove the now-unused `use crate::event::DiffFile;` and `use std::collections::HashMap;` at the top if nothing else in the file uses them (the remaining `create`/`create_in` code does not).

Leave `Worktree`, `WorktreeError`, `create`, `create_in`, `worktrees_dir`, `slug`, `unique_id`, `git`, and the create-related tests intact.

- [ ] **Step 4: Run the changeset tests to verify they pass and worktree still builds**

Run: `cargo test -p kata-core changeset`
Expected: PASS — `diff_at_reports_modified_tracked_and_new_untracked`, `diff_at_clean_repo_is_empty`, `diff_at_non_repo_errors`.

Run: `cargo test -p kata-core worktree`
Expected: PASS — the remaining worktree tests (`create_in_*`, `slug_*`, `unique_id_*`, `worktrees_dir_*`) still pass; no reference to the removed `diff`.

- [ ] **Step 5: Format, clippy, commit**

Run: `cargo fmt --all && cargo clippy -p kata-core --all-targets -- -D warnings`
Expected: clean.

```bash
git add crates/kata-core/src/changeset.rs crates/kata-core/src/lib.rs crates/kata-core/src/worktree.rs
git commit -m "refactor: extract git-diff into a changeset module

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add cost/duration to `run.error`/`run.cancelled`, make `run.diff` fields optional

**Files:**
- Modify: `crates/kata-core/src/event.rs:39-70` (the `RunCompleted`/`RunDiff`/`RunError`/`RunCancelled` variants) and the round-trip / serialization tests.

**Interfaces:**
- Consumes: nothing new.
- Produces (the new event shapes `run.rs` will construct in Task 3):
  - `RunDiff { worktree: Option<String>, branch: Option<String>, files: Vec<DiffFile>, insertions: u32, deletions: u32 }`
  - `RunError { message: String, exit_code: i32, cost_usd: Option<f64>, duration_ms: u64 }`
  - `RunCancelled { exit_code: i32, cost_usd: Option<f64>, duration_ms: u64 }`

- [ ] **Step 1: Write the failing round-trip test**

In `crates/kata-core/src/event.rs`, replace the body of the existing `terminal_events_carry_exit_code_and_round_trip` test so it constructs the new fields, and add assertions for `run.diff` field-omission. Add this alongside the existing tests (replace the old `terminal_events_carry_exit_code_and_round_trip` and `run_diff_serializes_with_tag_and_files`):

```rust
#[test]
fn terminal_events_carry_cost_duration_and_round_trip() {
    let cases = [
        KataEvent::RunError {
            message: "reached max turns (12)".into(),
            exit_code: 125,
            cost_usd: None,
            duration_ms: 4200,
        },
        KataEvent::RunCancelled {
            exit_code: 130,
            cost_usd: None,
            duration_ms: 300,
        },
        KataEvent::RunCompleted {
            exit_code: 0,
            is_error: false,
            num_turns: 2,
            cost_usd: Some(0.02),
            duration_ms: 100,
            result: Some("done".into()),
        },
    ];
    for ev in cases {
        let json = serde_json::to_string(&ev).unwrap();
        let back: KataEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(ev, back, "round-trip mismatch for {json}");
    }
    // The budget-exhaustion path is the one run.error that carries a real cost.
    let s = serde_json::to_string(&KataEvent::RunError {
        message: "budget ceiling $0.01 reached; spent $0.13".into(),
        exit_code: 122,
        cost_usd: Some(0.13),
        duration_ms: 900,
    })
    .unwrap();
    assert!(s.contains(r#""cost_usd":0.13"#), "budget error carries cost: {s}");
    assert!(s.contains(r#""duration_ms":900"#));
    // A killed run's cancel serializes duration and a null cost.
    let c = serde_json::to_string(&KataEvent::RunCancelled {
        exit_code: 130,
        cost_usd: None,
        duration_ms: 300,
    })
    .unwrap();
    assert!(c.contains(r#""exit_code":130"#), "cancel must serialize its code: {c}");
    assert!(c.contains(r#""cost_usd":null"#), "cancel serializes null cost: {c}");
    assert!(c.contains(r#""duration_ms":300"#));
}

#[test]
fn run_diff_omits_worktree_and_branch_when_none() {
    // Non-worktree run: no worktree/branch, still a full changeset.
    let e = KataEvent::RunDiff {
        worktree: None,
        branch: None,
        files: vec![DiffFile {
            status: "M".into(),
            path: "src/run.rs".into(),
        }],
        insertions: 3,
        deletions: 1,
    };
    let s = serde_json::to_string(&e).unwrap();
    assert!(s.contains(r#""type":"run.diff""#));
    assert!(!s.contains("worktree"), "absent worktree must not serialize: {s}");
    assert!(!s.contains("branch"), "absent branch must not serialize: {s}");
    assert!(s.contains(r#""status":"M""#));
    assert!(s.contains(r#""insertions":3"#));
    assert!(s.contains(r#""deletions":1"#));

    // Worktree run: both present.
    let w = KataEvent::RunDiff {
        worktree: Some("/home/u/.kata/worktrees/spec-abc".into()),
        branch: Some("kata/spec-abc".into()),
        files: vec![],
        insertions: 0,
        deletions: 0,
    };
    let ws = serde_json::to_string(&w).unwrap();
    assert!(ws.contains(r#""branch":"kata/spec-abc""#), "worktree run keeps branch: {ws}");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kata-core terminal_events_carry_cost_duration_and_round_trip run_diff_omits_worktree_and_branch_when_none`
Expected: FAIL to compile — `RunError`/`RunCancelled` have no `cost_usd`/`duration_ms` fields; `RunDiff.worktree` expects `String`, not `Option`.

- [ ] **Step 3: Update the event variants**

In `crates/kata-core/src/event.rs`, edit the enum. `RunCompleted` is unchanged. `RunDiff`, `RunError`, `RunCancelled` become:

```rust
    #[serde(rename = "run.diff")]
    RunDiff {
        /// Absolute worktree path — present only for a worktree-isolated run.
        #[serde(skip_serializing_if = "Option::is_none")]
        worktree: Option<String>,
        /// Isolation branch (`kata/<slug>-<id>`) — present only when isolated.
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        files: Vec<DiffFile>,
        insertions: u32,
        deletions: u32,
    },
    #[serde(rename = "ask.requested")]
    AskRequested {
        id: String,
        questions: Vec<Question>,
    },
    #[serde(rename = "ask.answered")]
    AskAnswered {
        id: String,
        answers: Vec<Vec<String>>,
    },
    #[serde(rename = "run.error")]
    RunError {
        message: String,
        exit_code: i32,
        /// Total cost claude reported, if a `result` line arrived. `None` when
        /// the leash killed the child before it could report (timeout, cancel,
        /// turn cap); present on the budget path (exit 122).
        cost_usd: Option<f64>,
        /// Wall-clock run duration in milliseconds.
        duration_ms: u64,
    },
    #[serde(rename = "run.cancelled")]
    RunCancelled {
        exit_code: i32,
        /// Almost always `None`: a cancelled child is killed before it reports
        /// a cost. Kept for symmetry with the other terminal events.
        cost_usd: Option<f64>,
        /// Wall-clock run duration in milliseconds.
        duration_ms: u64,
    },
```

Note: editing these doc comments and shapes drifts the schema — Task 4 regenerates it.

Also fix the now-stale `DiffFile` doc comment (currently at `event.rs:73`), which names the removed `crate::worktree::diff` and calls the changeset worktree-only:

```rust
/// One changed file in a run's changeset. Part of the `run.diff` event
/// payload; produced by `crate::changeset::diff_at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DiffFile {
```

(The `status`/`path` field doc comments below it are unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kata-core terminal_events_carry_cost_duration_and_round_trip run_diff_omits_worktree_and_branch_when_none`
Expected: PASS.

Run: `cargo test -p kata-core --lib event`
Expected: PASS — but the `schema_artifact_is_fresh` test (if run with `--features schema`) will now fail; that is expected and fixed in Task 4. Without the `schema` feature it is not compiled.

- [ ] **Step 5: Commit (schema regen deferred to Task 4)**

Run: `cargo fmt --all`

```bash
git add crates/kata-core/src/event.rs
git commit -m "feat: cost_usd + duration_ms on run.error/run.cancelled; optional run.diff worktree/branch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire cost/duration and the unconditional changeset into the run loop

**Files:**
- Modify: `crates/kata-core/src/run.rs` — the termination `match` (~lines 506-576) and the worktree-only diff block (~lines 578-594). Add `use std::path::Path;` if not already imported.
- Test: `crates/kata-core/tests/run_it.rs` (new tests in Task 5 exercise this end-to-end; the unit-level change is covered by compilation + existing integration tests here).

**Interfaces:**
- Consumes: `crate::changeset::diff_at` (Task 1); the new `RunError`/`RunCancelled`/`RunDiff` shapes (Task 2).
- Produces: no new public API; `run()` now emits `run.diff` on every run and fills cost/duration on all terminal events.

- [ ] **Step 1: Thread duration + cost into the leashed-termination arms**

In `crates/kata-core/src/run.rs`, the `Some(term)` arm of the terminal `match` builds `RunError`/`RunCancelled` with only codes/messages. Compute duration and cost once at the top of the arm and pass them in. Replace the `Some(term) => { ... }` arm with:

```rust
        Some(term) => {
            let _ = child.kill();
            let _ = child.wait();
            let duration_ms = start.elapsed().as_millis() as u64;
            // A killed child never emitted its final `result` line, so cost is
            // usually absent here; forward whatever we have.
            let cost_usd = result.as_ref().and_then(|r| r.cost_usd);
            match term {
                Termination::Cancelled => (
                    130,
                    KataEvent::RunCancelled {
                        exit_code: 130,
                        cost_usd,
                        duration_ms,
                    },
                ),
                Termination::TimedOut => (
                    124,
                    KataEvent::RunError {
                        message: format!("timed out after {timeout_secs}s"),
                        exit_code: 124,
                        cost_usd,
                        duration_ms,
                    },
                ),
                Termination::MaxTurns(cap) => (
                    125,
                    KataEvent::RunError {
                        message: format!("reached max turns ({cap})"),
                        exit_code: 125,
                        cost_usd,
                        duration_ms,
                    },
                ),
                Termination::AnswerTimeout => (
                    123,
                    KataEvent::RunError {
                        message: format!(
                            "answer deadline exceeded after {}s",
                            spec.interactive.answer_timeout_secs.unwrap_or(0)
                        ),
                        exit_code: 123,
                        cost_usd,
                        duration_ms,
                    },
                ),
            }
        }
```

- [ ] **Step 2: Thread duration + cost into the budget-exhaustion `run.error`**

In the `None => { ... }` arm, the budget-exhaustion branch builds a `RunError`. Add cost/duration to it (the budget path DOES have a real cost). Replace the `if payload.is_budget_exhausted() ...` block with:

```rust
            if payload.is_budget_exhausted() && spec.leash.max_budget_usd.is_some() {
                let ceiling = spec.leash.max_budget_usd.unwrap_or(0.0);
                let spent = payload.cost_usd.unwrap_or(0.0);
                (
                    122,
                    KataEvent::RunError {
                        message: format!("budget ceiling ${ceiling:.2} reached; spent ${spent:.2}"),
                        exit_code: 122,
                        cost_usd: payload.cost_usd,
                        duration_ms: start.elapsed().as_millis() as u64,
                    },
                )
            } else {
                (
                    code,
                    KataEvent::RunCompleted {
                        exit_code: code,
                        is_error: payload.is_error,
                        num_turns: payload.num_turns,
                        cost_usd: payload.cost_usd,
                        duration_ms: start.elapsed().as_millis() as u64,
                        result: payload.result,
                    },
                )
            }
```

- [ ] **Step 3: Replace the worktree-only diff block with an unconditional changeset**

In `run.rs`, the block guarded by `if let Some(wt) = &worktree { match crate::worktree::diff(wt) ... }` (just before `emit(terminal);`) becomes an unconditional diff against `cwd`. Replace it with:

```rust
    // The child has exited; surface the changeset before the terminal event.
    // Runs against `cwd` — the worktree path when isolated, the workdir
    // otherwise. A diff failure (non-git dir, missing git) degrades to a
    // warning; it never masks the run outcome. worktree/branch are set only
    // for an isolated run.
    match crate::changeset::diff_at(Path::new(&cwd)) {
        Ok(d) => emit(KataEvent::RunDiff {
            worktree: worktree.as_ref().map(|wt| wt.path.clone()),
            branch: worktree.as_ref().map(|wt| wt.branch.clone()),
            files: d.files,
            insertions: d.insertions,
            deletions: d.deletions,
        }),
        Err(e) => emit(KataEvent::Log {
            level: "warn".into(),
            message: format!("changeset diff failed: {e}"),
        }),
    }
    emit(terminal);
```

Add `use std::path::Path;` to the imports at the top of `run.rs` if it is not already present.

- [ ] **Step 4: Build and run the existing engine tests**

Run: `cargo test -p kata-core --test run_it`
Expected: PASS — including `worktree_isolation_runs_in_worktree_and_emits_diff` (the worktree `run.diff` still names the file and still precedes `run.completed`). The existing tests that match `RunError { .. }` / `RunCancelled { .. }` with `..` are unaffected by the new fields.

Run: `cargo build --locked`
Expected: green.

- [ ] **Step 5: Format, clippy, commit**

Run: `cargo fmt --all && cargo clippy -p kata-core --all-targets -- -D warnings`
Expected: clean.

```bash
git add crates/kata-core/src/run.rs
git commit -m "feat: emit run.diff on every run; fill cost/duration on all terminal events

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Regenerate the event schema and TS bindings

**Files:**
- Modify (generated): `schema/kata-events.schema.json`
- Modify (generated): `app/src/bindings/kata-events.ts`
- Modify: `Cargo.toml` (workspace version → `1.1.0`)

**Interfaces:** none — this task only regenerates machine mirrors and bumps the version.

- [ ] **Step 1: Regenerate the event JSON schema**

Run: `KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema schema_artifact_is_fresh`
Expected: PASS (it rewrites `schema/kata-events.schema.json`).

- [ ] **Step 2: Verify the schema freshness gate now passes without blessing**

Run: `cargo test -p kata-core --features schema schema_artifact_is_fresh`
Expected: PASS — the committed schema matches the generated one. `protocolVersion` in the file is still `1`.

- [ ] **Step 3: Regenerate the schema-derived TS event types**

Run: `cd app && npm run gen:events && cd ..`
Expected: `app/src/bindings/kata-events.ts` updates — `RunDiff.worktree`/`branch` become optional, `RunError`/`RunCancelled` gain `cost_usd`/`duration_ms`.

Run: `cd app && npm run check && cd ..`
Expected: Svelte type-check passes (`app/src/lib/events.ts` still compiles — it only reads fields it already used; the new optional fields need no change).

- [ ] **Step 4: Bump the workspace version to 1.1.0**

In the root `Cargo.toml`, find `[workspace.package]` `version = "1.0.0"` and change it to `version = "1.1.0"`.

Run: `cargo build --locked`
Expected: green (updates `Cargo.lock` version entries).

- [ ] **Step 5: Commit**

```bash
git add schema/kata-events.schema.json app/src/bindings/kata-events.ts Cargo.toml Cargo.lock
git commit -m "chore: regenerate event schema + TS bindings; bump to 1.1.0

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: End-to-end integration tests for non-worktree changeset + terminal cost/duration

**Files:**
- Modify: `crates/kata-core/tests/run_it.rs` — add tests using the existing `init_git_repo()` helper (line ~506) and `with_fake("writefile")` mode.

**Interfaces:**
- Consumes: `run()`, `KataEvent`, the `writefile`/`sleep` fake modes, `init_git_repo()`.
- Produces: nothing — verification only.

- [ ] **Step 1: Write the failing test — non-worktree run in a git workdir emits run.diff**

Add to `crates/kata-core/tests/run_it.rs`:

```rust
#[test]
#[serial]
fn default_run_in_git_workdir_emits_changeset() {
    // No worktree isolation: the agent writes into the live workdir, and a
    // run.diff naming that file is emitted before run.completed, with no
    // worktree/branch (they are None for a non-isolated run).
    with_fake("writefile");
    let repo = init_git_repo();
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(
        &base_spec(&repo.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);

    let diff_idx = events
        .iter()
        .position(|e| matches!(e,
            KataEvent::RunDiff { worktree: None, branch: None, files, .. }
                if files.iter().any(|f| f.path == "agent-made.txt")))
        .expect("a run.diff naming the file, with no worktree/branch");
    let done_idx = events
        .iter()
        .position(|e| matches!(e, KataEvent::RunCompleted { .. }))
        .unwrap();
    assert!(diff_idx < done_idx, "run.diff must precede run.completed");
}
```

- [ ] **Step 2: Run it to verify it passes** (the feature is already implemented in Task 3)

Run: `cargo test -p kata-core --test run_it default_run_in_git_workdir_emits_changeset`
Expected: PASS.

- [ ] **Step 3: Write the test — non-git workdir emits no run.diff but warns**

```rust
#[test]
#[serial]
fn default_run_in_non_git_workdir_warns_and_emits_no_changeset() {
    // A plain (non-git) workdir has no HEAD to diff: no run.diff, but a warn
    // log explains why. The run still completes normally.
    with_fake("writefile");
    let work = tempfile::tempdir().unwrap(); // NOT a git repo
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(
        &base_spec(&work.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);

    assert!(
        !events.iter().any(|e| matches!(e, KataEvent::RunDiff { .. })),
        "a non-git workdir must emit no run.diff"
    );
    assert!(
        events.iter().any(|e| matches!(e,
            KataEvent::Log { level, message }
                if level == "warn" && message.contains("changeset diff failed"))),
        "a warn log must explain the missing changeset, got {events:?}"
    );
}
```

- [ ] **Step 4: Run it**

Run: `cargo test -p kata-core --test run_it default_run_in_non_git_workdir_warns_and_emits_no_changeset`
Expected: PASS.

- [ ] **Step 5: Write the test — a cancelled run carries duration_ms**

```rust
#[test]
#[serial]
fn cancelled_run_reports_duration() {
    // run.cancelled now carries duration_ms (cost is None — the killed child
    // never reported one).
    with_fake("sleep");
    let work = tempfile::tempdir().unwrap();
    let spec = base_spec(&work.path().to_string_lossy());
    let cancel = CancelToken::new();
    let flag = cancel.flag();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        flag.store(true, Ordering::SeqCst);
    });
    let mut events = Vec::new();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 130);
    assert!(
        events.iter().any(|e| matches!(e,
            KataEvent::RunCancelled { exit_code: 130, cost_usd: None, duration_ms }
                if *duration_ms > 0)),
        "run.cancelled must carry a positive duration_ms, got {events:?}"
    );
}
```

- [ ] **Step 6: Run it**

Run: `cargo test -p kata-core --test run_it cancelled_run_reports_duration`
Expected: PASS.

- [ ] **Step 7: Full workspace test + gates, then commit**

Run: `cargo test --workspace`
Expected: PASS.

Run: `cargo fmt --all --check && cargo clippy --all-targets -- -D warnings`
Expected: clean.

```bash
git add crates/kata-core/tests/run_it.rs
git commit -m "test: non-worktree changeset emission and terminal duration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Document the new behavior

**Files:**
- Modify: `docs/consuming-kata.md` — the `run.diff` and terminal-event sections.

**Interfaces:** none — docs only.

- [ ] **Step 1: Check the current wording**

Run: `grep -n "run.diff\|run.completed\|run.error\|run.cancelled\|worktree" docs/consuming-kata.md`
Expected: locate the event-protocol section describing these events.

- [ ] **Step 2: Update the `run.diff` description**

Edit `docs/consuming-kata.md` so the `run.diff` description states (one line per paragraph, US English, no hard wraps):

- `run.diff` is emitted on **every** run, immediately before the terminal event, carrying the changed files with insertions/deletions.
- `worktree` and `branch` are present only for a worktree-isolated run.
- For a default (non-worktree) run the changeset is the working tree versus `HEAD` at the run's end, so **files left uncommitted before the run are attributed to the run**. Use `isolation = "worktree"` for clean per-run attribution.
- A non-git workdir (or missing `git`) emits no `run.diff`, only a `warn` log.

- [ ] **Step 3: Update the terminal-event descriptions**

State that `run.error` and `run.cancelled` now carry `cost_usd` and `duration_ms` (matching `run.completed`). Note that `cost_usd` is `null` when the leash kills the child before claude reports a final cost (timeout/cancel/turn cap), and present on the budget path (exit 122); `duration_ms` is always present.

- [ ] **Step 4: Commit**

```bash
git add docs/consuming-kata.md
git commit -m "docs: run.diff on every run + cost/duration on all terminal events

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `cargo fmt --all --check` — clean.
- [ ] `cargo clippy --all-targets -- -D warnings` — clean.
- [ ] `cargo build --locked` — green.
- [ ] `cargo test --workspace` — green.
- [ ] `cargo test -p kata-core --features schema schema_artifact_is_fresh` — green (no drift).
- [ ] `cargo test -p kata-core --features ts export_bindings` — green (bindings fresh).
- [ ] `cd app && npm run check` — green.
- [ ] Confirm on branch `feat/changeset-capture`, `main` untouched.
