# Kata M8 — Worktree Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `leash.isolation = "worktree"`, run the agent in an ephemeral git worktree branched off `workdir`'s HEAD (under `~/.kata/worktrees`), persist it on a `kata/<slug>-<id>` branch, and emit a `run.diff` summary — refusing to run when `workdir` isn't a git repo.

**Architecture:** A new `kata-core::worktree` module does the git plumbing (verify repo, `git worktree add`, compute a diff summary). `run.rs` gains one seam: after `assemble`, if isolation is worktree it creates the worktree and redirects the spawn `cwd`; after the run it emits `run.diff` before the terminal event. The worktree is never removed by the engine (persistence is the point); cleanup is the operator's via native git. The `KataEvent` protocol gains an additive `run.diff` variant and two optional `run.started` fields.

**Tech Stack:** Rust (kata-core lib + fake-claude bin), `std::process::Command` driving the system `git`, serde for the event protocol, `tempfile` + `serial_test` for tests, TypeScript/Svelte for the frontend type mirror.

---

## Design reference

Spec: `docs/superpowers/specs/2026-06-16-kata-m8-worktree-isolation-design.md`

## File structure

- **Create** `crates/kata-core/src/worktree.rs` — git plumbing: `Worktree`/`DiffSummary` types, `WorktreeError`, home/slug/id helpers, `create`/`create_in`/`diff`. Single responsibility: turn a workdir into a sandbox worktree and read back its diff.
- **Modify** `crates/kata-core/src/lib.rs` — declare `pub mod worktree;`.
- **Modify** `crates/kata-core/src/event.rs` — add `DiffFile` struct, `RunDiff` variant, and `worktree`/`branch` optional fields on `RunStarted`.
- **Modify** `crates/kata-core/src/run.rs` — `RunError::Worktree`; create worktree + redirect `cwd`; populate `RunStarted`; emit `RunDiff`; restructure the run tail so the child is stopped before the diff is read.
- **Modify** `crates/kata-core/src/bin/fake-claude.rs` — add a `writefile` mode that writes a file into its cwd (so a worktree run produces a real diff).
- **Modify** `crates/kata-core/tests/run_it.rs` — integration tests for the worktree happy path and the non-repo refusal.
- **Modify** `app/src/lib/events.ts` — mirror the protocol change; exclude `run.diff` from `StreamEvent`.
- **Modify** `app/src/lib/run.svelte.ts` — ignore `run.diff` (panel deferred) so the store stays type-safe.
- **Modify** `app/src/lib/events.test.ts` — assert the union accepts the new event/fields.

Note: `DiffFile` is defined once, in `event.rs` (it is serialized as part of the protocol); `worktree.rs` imports it. This keeps the diff shape DRY across the module and the wire format.

---

## Task 1: Event protocol — `DiffFile` + `run.diff` variant

**Files:**
- Modify: `crates/kata-core/src/event.rs` (enum at lines 4-32; tests module from line 160)

This task is additive only (a new struct + a new enum variant). It does not touch `RunStarted`, so `run.rs` keeps compiling untouched.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/kata-core/src/event.rs`:

```rust
    #[test]
    fn run_diff_serializes_with_tag_and_files() {
        let e = KataEvent::RunDiff {
            worktree: "/home/u/.kata/worktrees/spec-abc".into(),
            branch: "kata/spec-abc".into(),
            files: vec![DiffFile { status: "M".into(), path: "src/run.rs".into() }],
            insertions: 3,
            deletions: 1,
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""type":"run.diff""#));
        assert!(s.contains(r#""branch":"kata/spec-abc""#));
        assert!(s.contains(r#""status":"M""#));
        assert!(s.contains(r#""insertions":3"#));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kata-core run_diff_serializes_with_tag_and_files`
Expected: FAIL to compile — `no variant named RunDiff` / `cannot find struct DiffFile`.

- [ ] **Step 3: Add the struct and variant**

In `crates/kata-core/src/event.rs`, add the `DiffFile` struct just below the `KataEvent` enum (after the closing `}` at what is currently line 32):

```rust
/// One changed file in a worktree-isolation diff summary. Part of the
/// `run.diff` event payload; also produced by `crate::worktree::diff`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiffFile {
    /// Git short status for the change: "A" | "M" | "D" | "R" | ...
    pub status: String,
    /// Path relative to the worktree root.
    pub path: String,
}
```

Add the new variant inside the `KataEvent` enum, just before the `#[serde(rename = "run.error")]` line:

```rust
    #[serde(rename = "run.diff")]
    RunDiff {
        worktree: String,
        branch: String,
        files: Vec<DiffFile>,
        insertions: u32,
        deletions: u32,
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p kata-core run_diff_serializes_with_tag_and_files`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kata-core/src/event.rs
git commit -m "feat(M8): add run.diff event + DiffFile to the protocol"
```

---

## Task 2: `worktree` module — create + diff

**Files:**
- Create: `crates/kata-core/src/worktree.rs`
- Modify: `crates/kata-core/src/lib.rs:1-8`

- [ ] **Step 1: Register the module**

In `crates/kata-core/src/lib.rs`, add the declaration in alphabetical position (after `pub mod spec;`):

```rust
pub mod worktree;
```

(The file does not exist yet, so the crate will not compile until Step 3. That is expected.)

- [ ] **Step 2: Write the failing tests**

Create `crates/kata-core/src/worktree.rs` with ONLY the tests first (the implementation comes in Step 3). Paste the whole file:

```rust
//! Git worktree isolation: branch off `workdir`'s HEAD into a persistent
//! worktree under `~/.kata/worktrees`, run the agent there, and read back a
//! diff summary. The worktree is NOT removed on drop — it persists for review;
//! cleanup is the operator's via `git worktree remove` / `git worktree prune`.

use crate::event::DiffFile;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

/// A created worktree. Plain data — dropping it does NOT remove the worktree.
#[derive(Debug, Clone, PartialEq)]
pub struct Worktree {
    /// Absolute path to the worktree directory.
    pub path: String,
    /// The branch the worktree is checked out on (`kata/<slug>-<id>`).
    pub branch: String,
}

/// A diff summary for a worktree, relative to the branch point (HEAD).
#[derive(Debug, Clone, PartialEq)]
pub struct DiffSummary {
    pub files: Vec<DiffFile>,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    #[error("not a git repository (or no HEAD): {0}")]
    NotAGitRepo(String),
    #[error("`git` was not found on PATH")]
    GitMissing,
    #[error("could not resolve a home directory for ~/.kata (HOME/USERPROFILE unset)")]
    NoHome,
    #[error("git {cmd} failed (status {status:?}): {stderr}")]
    Git { cmd: String, status: Option<i32>, stderr: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    /// Init a git repo with one committed file ("tracked.txt").
    fn init_repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let ok = Command::new("git").arg("-C").arg(d.path()).args(args).status().unwrap().success();
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
    fn slug_sanitizes_and_falls_back() {
        assert_eq!(slug("my spec!"), "my-spec");
        assert_eq!(slug("a/b"), "a-b");
        assert_eq!(slug("triage-flaky_1"), "triage-flaky_1");
        assert_eq!(slug("型"), "kata");
        assert_eq!(slug("..."), "kata");
    }

    #[test]
    fn unique_id_differs_across_calls() {
        assert_ne!(unique_id(), unique_id());
    }

    #[test]
    fn create_in_makes_worktree_off_head() {
        let repo = init_repo();
        let root = tempfile::tempdir().unwrap();
        let wt = create_in(&repo.path().to_string_lossy(), "my spec!", root.path()).unwrap();
        assert!(wt.branch.starts_with("kata/my-spec-"), "branch was {}", wt.branch);
        assert!(Path::new(&wt.path).join("tracked.txt").exists());
    }

    #[test]
    fn create_in_non_repo_errors() {
        let notrepo = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let err = create_in(&notrepo.path().to_string_lossy(), "x", root.path()).unwrap_err();
        assert!(matches!(err, WorktreeError::NotAGitRepo(_)));
    }

    #[test]
    fn create_in_generates_unique_branches() {
        let repo = init_repo();
        let root = tempfile::tempdir().unwrap();
        let a = create_in(&repo.path().to_string_lossy(), "spec", root.path()).unwrap();
        let b = create_in(&repo.path().to_string_lossy(), "spec", root.path()).unwrap();
        assert_ne!(a.branch, b.branch);
    }

    #[test]
    fn diff_reports_modified_tracked_and_new_untracked() {
        let repo = init_repo();
        let root = tempfile::tempdir().unwrap();
        let wt = create_in(&repo.path().to_string_lossy(), "spec", root.path()).unwrap();
        // Modify a tracked file (+1 line) and create an untracked file (+2 lines).
        std::fs::write(Path::new(&wt.path).join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(Path::new(&wt.path).join("new.txt"), "a\nb\n").unwrap();

        let d = diff(&wt).unwrap();
        assert!(d.files.iter().any(|f| f.path == "tracked.txt" && f.status == "M"), "files: {:?}", d.files);
        assert!(d.files.iter().any(|f| f.path == "new.txt" && f.status == "A"), "files: {:?}", d.files);
        assert_eq!(d.insertions, 3, "1 added to tracked + 2 in new.txt");
        assert_eq!(d.deletions, 0);

        // The index must NOT have been mutated (operator's later diff is unsurprised).
        let staged = Command::new("git").arg("-C").arg(&wt.path)
            .args(["diff", "--cached", "--name-only"]).output().unwrap();
        assert!(staged.stdout.is_empty(), "diff() must not stage anything");
    }

    #[test]
    #[serial]
    fn worktrees_dir_resolution_order() {
        let saved: Vec<(&str, Option<String>)> = ["KATA_HOME", "HOME", "USERPROFILE"]
            .iter().map(|k| (*k, std::env::var(k).ok())).collect();
        let restore = || for (k, v) in &saved {
            match v { Some(val) => std::env::set_var(k, val), None => std::env::remove_var(k) }
        };

        // 1. KATA_HOME wins.
        std::env::set_var("KATA_HOME", "/tmp/khome");
        assert_eq!(worktrees_dir().unwrap(), PathBuf::from("/tmp/khome").join("worktrees"));

        // 2. Falls back to HOME/.kata.
        std::env::remove_var("KATA_HOME");
        std::env::remove_var("USERPROFILE");
        std::env::set_var("HOME", "/tmp/h");
        assert_eq!(worktrees_dir().unwrap(), PathBuf::from("/tmp/h").join(".kata").join("worktrees"));

        // 3. Neither => NoHome.
        std::env::remove_var("HOME");
        std::env::remove_var("USERPROFILE");
        std::env::remove_var("KATA_HOME");
        assert!(matches!(worktrees_dir().unwrap_err(), WorktreeError::NoHome));

        restore();
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p kata-core --lib worktree::`
Expected: FAIL to compile — `cannot find function slug` / `create_in` / `diff` / `worktrees_dir` / `unique_id`.

- [ ] **Step 4: Write the implementation**

Insert the implementation into `crates/kata-core/src/worktree.rs` between the `WorktreeError` enum and the `#[cfg(test)] mod tests` block:

```rust
/// Public entry: create a worktree under the resolved `~/.kata/worktrees`.
pub fn create(workdir: &str, name: &str) -> Result<Worktree, WorktreeError> {
    let root = worktrees_dir()?;
    create_in(workdir, name, &root)
}

/// Create a worktree under an explicit `root` directory (testable seam).
pub fn create_in(workdir: &str, name: &str, root: &Path) -> Result<Worktree, WorktreeError> {
    let wd = Path::new(workdir);

    // Verify it is a git repo with a resolvable HEAD; otherwise refuse.
    if !git(wd, &["rev-parse", "--git-dir"])?.status.success() {
        return Err(WorktreeError::NotAGitRepo(workdir.to_string()));
    }
    if !git(wd, &["rev-parse", "--verify", "HEAD"])?.status.success() {
        return Err(WorktreeError::NotAGitRepo(workdir.to_string()));
    }

    let id = unique_id();
    let s = slug(name);
    let branch = format!("kata/{s}-{id}");
    let wt_dir = root.join(format!("{s}-{id}"));
    std::fs::create_dir_all(root)?;

    let path_str = wt_dir.to_string_lossy().into_owned();
    let out = git(wd, &["worktree", "add", "-b", &branch, &path_str, "HEAD"])?;
    if !out.status.success() {
        return Err(WorktreeError::Git {
            cmd: format!("worktree add {branch}"),
            status: out.status.code(),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(Worktree { path: path_str, branch })
}

/// Summarize the worktree's changes vs HEAD, including newly-created untracked
/// files, WITHOUT mutating the index.
pub fn diff(wt: &Worktree) -> Result<DiffSummary, WorktreeError> {
    let dir = Path::new(&wt.path);

    // Per-file insertions/deletions for tracked changes (binary => "-\t-").
    let numstat = git(dir, &["diff", "HEAD", "--numstat"])?;
    if !numstat.status.success() {
        return Err(WorktreeError::Git {
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
        let path = it.last().unwrap_or("").to_string();
        if !path.is_empty() {
            counts.insert(path, (ins, del));
        }
    }

    // Statuses for tracked changes (A/M/D/R...).
    let name_status = git(dir, &["diff", "HEAD", "--name-status"])?;
    let mut files = Vec::new();
    let mut insertions = 0u32;
    let mut deletions = 0u32;
    for line in String::from_utf8_lossy(&name_status.stdout).lines() {
        let mut it = line.split('\t');
        let status = it.next().unwrap_or("");
        let path = it.last().unwrap_or("").to_string(); // last field handles renames
        if status.is_empty() || path.is_empty() {
            continue;
        }
        let (ins, del) = counts.get(&path).copied().unwrap_or((0, 0));
        insertions += ins;
        deletions += del;
        files.push(DiffFile { status: status.chars().next().unwrap().to_string(), path });
    }

    // Untracked (newly-created) files: status "A", insertions = line count.
    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard"])?;
    for path in String::from_utf8_lossy(&untracked.stdout).lines() {
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        let ins = std::fs::read_to_string(dir.join(path))
            .map(|c| c.lines().count() as u32)
            .unwrap_or(0); // unreadable/binary => 0
        insertions += ins;
        files.push(DiffFile { status: "A".into(), path: path.to_string() });
    }

    Ok(DiffSummary { files, insertions, deletions })
}

/// Resolve `<kata-home>/worktrees`. `KATA_HOME` overrides; else `<HOME or
/// USERPROFILE>/.kata`. Returns NoHome rather than falling back to "." — we
/// must never scatter worktrees into the cwd.
fn worktrees_dir() -> Result<PathBuf, WorktreeError> {
    if let Ok(h) = std::env::var("KATA_HOME") {
        if !h.trim().is_empty() {
            return Ok(PathBuf::from(h).join("worktrees"));
        }
    }
    let base = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or(WorktreeError::NoHome)?;
    Ok(PathBuf::from(base).join(".kata").join("worktrees"))
}

/// Sanitize a spec name into a filesystem/branch-safe segment: map anything
/// outside `[A-Za-z0-9_-]` to '-', trim '-', fall back to "kata".
fn slug(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = mapped.trim_matches('-');
    if trimmed.is_empty() { "kata".to_string() } else { trimmed.to_string() }
}

/// A short, process-unique suffix so repeated runs never collide on a branch.
fn unique_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{millis:x}-{n}")
}

/// Run `git -C <dir> <args>`, mapping a missing binary to `GitMissing`.
fn git(dir: &Path, args: &[&str]) -> Result<std::process::Output, WorktreeError> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { WorktreeError::GitMissing } else { WorktreeError::Io(e) })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p kata-core --lib worktree::`
Expected: PASS (all 6 worktree tests). Requires `git` on PATH.

- [ ] **Step 6: Commit**

```bash
git add crates/kata-core/src/worktree.rs crates/kata-core/src/lib.rs
git commit -m "feat(M8): worktree module — create + diff summary"
```

---

## Task 3: Add `worktree`/`branch` fields to `RunStarted`

**Files:**
- Modify: `crates/kata-core/src/event.rs` (`RunStarted` variant, currently line 8)
- Modify: `crates/kata-core/src/run.rs:57-62` (the only `RunStarted` constructor)

This is a mechanical, behavior-preserving change: add the fields (skipped when `None`) and wire the existing construction site to pass `None`/`None`. Task 4 populates them.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/kata-core/src/event.rs`:

```rust
    #[test]
    fn run_started_omits_worktree_fields_when_none() {
        let e = KataEvent::RunStarted {
            spec: "s".into(), model: None, workdir: "/w".into(),
            isolation: "none".into(), worktree: None, branch: None,
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(!s.contains("worktree"), "absent worktree must not serialize: {s}");
        assert!(!s.contains("branch"), "absent branch must not serialize: {s}");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kata-core run_started_omits_worktree_fields_when_none`
Expected: FAIL to compile — `RunStarted` has no fields `worktree`/`branch`.

- [ ] **Step 3: Add the fields and update the constructor**

In `crates/kata-core/src/event.rs`, replace the `RunStarted` variant (currently line 8) with:

```rust
    #[serde(rename = "run.started")]
    RunStarted {
        spec: String,
        model: Option<String>,
        workdir: String,
        isolation: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        worktree: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
```

In `crates/kata-core/src/run.rs`, update the `RunStarted` construction (currently lines 57-62) to pass the new fields:

```rust
    emit(KataEvent::RunStarted {
        spec: spec.name.clone(),
        model: spec.model.id.clone(),
        workdir: spec.workdir.clone(),
        isolation: isolation.to_string(),
        worktree: None,
        branch: None,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kata-core run_started_omits_worktree_fields_when_none && cargo test -p kata-core --test run_it`
Expected: PASS — the new serde test passes and the existing integration tests (which match `RunStarted { .. }`) are unaffected.

- [ ] **Step 5: Commit**

```bash
git add crates/kata-core/src/event.rs crates/kata-core/src/run.rs
git commit -m "feat(M8): RunStarted carries optional worktree/branch"
```

---

## Task 4: `fake-claude` — `writefile` mode

**Files:**
- Modify: `crates/kata-core/src/bin/fake-claude.rs:1-4` (doc comment) and the `match` arms

A test fixture (no test of its own; exercised by Task 5's integration test). It writes a file into its cwd so a worktree-isolated run yields a non-empty diff.

- [ ] **Step 1: Add the mode**

In `crates/kata-core/src/bin/fake-claude.rs`, update the doc comment line listing modes:

```rust
//! KATA_FAKE_MODE = "ok" (default) | "sleep" | "fail" | "manyturns" | "writefile"
```

Add a new arm to the `match mode.as_str()` block, just before the `_ =>` default arm:

```rust
        "writefile" => {
            // Write a file into cwd so a worktree-isolated run produces a real diff.
            let _ = std::fs::write("agent-made.txt", "line1\nline2\n");
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"wrote a file"}}]}}}}"#);
            let _ = writeln!(out, r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#);
            let _ = out.flush();
        }
```

- [ ] **Step 2: Verify it builds**

Run: `cargo build -p kata-core --bin fake-claude`
Expected: builds cleanly.

- [ ] **Step 3: Commit**

```bash
git add crates/kata-core/src/bin/fake-claude.rs
git commit -m "test(M8): fake-claude writefile mode for worktree diffs"
```

---

## Task 5: Wire worktree isolation into `run.rs`

**Files:**
- Modify: `crates/kata-core/src/run.rs` (`RunError` enum lines 19-27; the isolation/`RunStarted` block lines 53-67; the spawn `current_dir` line 71; the run-tail `match termination` block lines 134-170)
- Modify: `crates/kata-core/tests/run_it.rs` (add a git-repo helper + two tests)

- [ ] **Step 1: Add the `RunError::Worktree` variant**

In `crates/kata-core/src/run.rs`, add to the `RunError` enum (after the `Spawn` variant):

```rust
    #[error("worktree isolation: {0}")]
    Worktree(String),
```

- [ ] **Step 2: Write the failing integration tests**

In `crates/kata-core/tests/run_it.rs`, add a git-repo helper after the `with_fake` function:

```rust
fn init_git_repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git").arg("-C").arg(d.path()).args(args).status().unwrap().success();
        assert!(ok, "git {args:?} failed");
    };
    git(&["init", "-q"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(d.path().join("seed.txt"), "seed\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "init"]);
    d
}
```

Add the two tests at the end of the file:

```rust
#[test]
#[serial]
fn worktree_isolation_runs_in_worktree_and_emits_diff() {
    with_fake("writefile");
    let repo = init_git_repo();
    let khome = tempfile::tempdir().unwrap();
    std::env::set_var("KATA_HOME", khome.path());

    let mut spec = base_spec(&repo.path().to_string_lossy());
    spec.leash.isolation = kata_core::spec::Isolation::Worktree;
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();
    assert_eq!(outcome.exit_code, 0);

    // run.started carried the worktree path + branch.
    let wt_path = match events.first().unwrap() {
        KataEvent::RunStarted { worktree: Some(p), branch: Some(b), isolation, .. } => {
            assert_eq!(isolation, "worktree");
            assert!(b.starts_with("kata/"), "branch was {b}");
            p.clone()
        }
        other => panic!("expected RunStarted with worktree, got {other:?}"),
    };

    // The agent's file landed in the worktree, NOT the live workdir.
    assert!(std::path::Path::new(&wt_path).join("agent-made.txt").exists());
    assert!(!repo.path().join("agent-made.txt").exists());

    // A run.diff naming the new file was emitted before run.completed.
    let diff_idx = events.iter().position(|e| matches!(e,
        KataEvent::RunDiff { files, .. } if files.iter().any(|f| f.path == "agent-made.txt"))).expect("a run.diff naming the file");
    let done_idx = events.iter().position(|e| matches!(e, KataEvent::RunCompleted { .. })).unwrap();
    assert!(diff_idx < done_idx, "run.diff must precede run.completed");

    std::env::remove_var("KATA_HOME");
    // Best-effort: remove the worktree we created so the test leaves nothing behind.
    let _ = std::process::Command::new("git").arg("-C").arg(repo.path())
        .args(["worktree", "remove", "--force", &wt_path]).status();
}

#[test]
#[serial]
fn worktree_isolation_refuses_non_repo() {
    with_fake("writefile");
    let work = tempfile::tempdir().unwrap(); // NOT a git repo
    let khome = tempfile::tempdir().unwrap();
    std::env::set_var("KATA_HOME", khome.path());

    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.isolation = kata_core::spec::Isolation::Worktree;
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let err = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap_err();

    assert!(matches!(err, RunError::Worktree(_)));
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunError { .. })));
    assert!(!work.path().join("agent-made.txt").exists(), "must not run in the live workdir");

    std::env::remove_var("KATA_HOME");
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p kata-core --test run_it worktree_isolation`
Expected: FAIL. Without wiring, isolation=worktree still runs in `workdir`: `RunStarted.worktree` is `None` (happy-path test panics at the match), and the non-repo test does not return `RunError::Worktree`.

- [ ] **Step 4: Implement the worktree wiring**

In `crates/kata-core/src/run.rs`, replace the isolation/`RunStarted` block (currently lines 53-67) with:

```rust
    let isolation = match spec.leash.isolation {
        Isolation::None => "none",
        Isolation::Worktree => "worktree",
    };

    // Worktree isolation: branch off HEAD into ~/.kata/worktrees and run there.
    // Refuse (before spawning claude) if workdir is not a git repo.
    let mut cwd = inv.cwd.clone();
    let mut worktree: Option<crate::worktree::Worktree> = None;
    if spec.leash.isolation == Isolation::Worktree {
        match crate::worktree::create(&spec.workdir, &spec.name) {
            Ok(wt) => {
                cwd = wt.path.clone();
                worktree = Some(wt);
            }
            Err(e) => {
                let message = format!("worktree isolation requires a git repository at {} ({e})", spec.workdir);
                emit(KataEvent::RunError { message: message.clone() });
                return Err(RunError::Worktree(message));
            }
        }
    }

    let (wt_path, wt_branch) = match &worktree {
        Some(wt) => (Some(wt.path.clone()), Some(wt.branch.clone())),
        None => (None, None),
    };
    emit(KataEvent::RunStarted {
        spec: spec.name.clone(),
        model: spec.model.id.clone(),
        workdir: spec.workdir.clone(),
        isolation: isolation.to_string(),
        worktree: wt_path,
        branch: wt_branch,
    });
    emit(KataEvent::Log {
        level: "info".into(),
        message: format!("assembled kit: {} skill(s), {} plugin(s)", spec.skills.len(), spec.plugins.len()),
    });
```

In the spawn setup, change `current_dir` (currently line 71) from `inv.cwd` to the (possibly redirected) `cwd`:

```rust
    cmd.args(&inv.args)
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
```

Replace the run-tail `let exit_code = match termination { ... }` block (currently lines 134-170) with this version, which stops the child first, then emits the diff before the terminal event:

```rust
    // Stop the child for any leashed termination, and decide the terminal event.
    let (exit_code, terminal) = match termination {
        Some(term) => {
            let _ = child.kill();
            let _ = child.wait();
            match term {
                Termination::Cancelled => (130, KataEvent::RunCancelled),
                Termination::TimedOut => (124, KataEvent::RunError {
                    message: format!("timed out after {}s", spec.leash.timeout_secs.unwrap_or(0)),
                }),
                Termination::MaxTurns => (125, KataEvent::RunError {
                    message: format!("reached max turns ({})", spec.leash.max_turns),
                }),
            }
        }
        None => {
            let status = child.wait().map_err(|e| RunError::Spawn(e.to_string()))?;
            let code = status.code().unwrap_or(1);
            let payload = result.unwrap_or(crate::event::ResultPayload {
                num_turns: turns, cost_usd: None, is_error: code != 0, result: None,
            });
            (code, KataEvent::RunCompleted {
                exit_code: code,
                is_error: payload.is_error,
                num_turns: payload.num_turns,
                cost_usd: payload.cost_usd,
                duration_ms: start.elapsed().as_millis() as u64,
                result: payload.result,
            })
        }
    };

    // The child has exited; surface the worktree diff before the terminal event.
    // A diff failure degrades to a warning — it never masks the run outcome.
    if let Some(wt) = &worktree {
        match crate::worktree::diff(wt) {
            Ok(d) => emit(KataEvent::RunDiff {
                worktree: wt.path.clone(),
                branch: wt.branch.clone(),
                files: d.files,
                insertions: d.insertions,
                deletions: d.deletions,
            }),
            Err(e) => emit(KataEvent::Log {
                level: "warn".into(),
                message: format!("worktree diff failed: {e}"),
            }),
        }
    }
    emit(terminal);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p kata-core --test run_it`
Expected: PASS — both new worktree tests and all existing run_it tests (non-worktree runs still emit `RunCompleted` last; no `RunDiff` is emitted for them).

- [ ] **Step 6: Commit**

```bash
git add crates/kata-core/src/run.rs crates/kata-core/tests/run_it.rs
git commit -m "feat(M8): run in an isolated worktree and emit run.diff"
```

---

## Task 6: Mirror the protocol in the frontend

**Files:**
- Modify: `app/src/lib/events.ts:6-31`
- Modify: `app/src/lib/run.svelte.ts:24-39` (the `handle` switch)
- Modify: `app/src/lib/events.test.ts`

The Workbench diff *panel* is deferred; this task only keeps the types honest and `npm run check` green.

- [ ] **Step 1: Write the failing test**

Add to `app/src/lib/events.test.ts` (import `KataEvent` if not already imported at the top of the file):

```ts
import type { KataEvent } from "./events";

test("KataEvent union accepts run.diff and run.started worktree fields", () => {
  const started: KataEvent = {
    type: "run.started", spec: "s", model: null, workdir: "/w",
    isolation: "worktree", worktree: "/home/u/.kata/worktrees/s-abc", branch: "kata/s-abc",
  };
  const diff: KataEvent = {
    type: "run.diff", worktree: "/home/u/.kata/worktrees/s-abc", branch: "kata/s-abc",
    files: [{ status: "A", path: "new.txt" }], insertions: 2, deletions: 0,
  };
  expect(started.type).toBe("run.started");
  expect(diff.type).toBe("run.diff");
});
```

- [ ] **Step 2: Run the test/type-check to verify it fails**

Run (from `app/`): `npm run check`
Expected: FAIL — `worktree`/`branch` are not on `run.started`, and `run.diff` is not a member of the union.

- [ ] **Step 3: Update the union**

In `app/src/lib/events.ts`, replace the `run.started` member of the `KataEvent` union (currently line 7) with:

```ts
  | { type: "run.started"; spec: string; model: string | null; workdir: string; isolation: string; worktree?: string | null; branch?: string | null }
```

Add a new member to the union, just before the `run.error` member (currently line 22):

```ts
  | { type: "run.diff"; worktree: string; branch: string; files: { status: string; path: string }[]; insertions: number; deletions: number }
```

Update `StreamEvent` (currently lines 28-31) to also exclude `run.diff` (it is a meta event, not a stream row):

```ts
export type StreamEvent = Exclude<
  KataEvent,
  { type: "run.started" | "run.completed" | "run.error" | "run.cancelled" | "run.diff" }
>;
```

- [ ] **Step 4: Keep the run store type-safe**

In `app/src/lib/run.svelte.ts`, add a `run.diff` case to the `handle` switch (currently lines 24-39), just before the `default` arm. Without this, `run.diff` would fall into `default` and fail to push onto a `StreamEvent[]`:

```ts
    case "run.diff":
      return; // meta only; the diff panel is a fast-follow
```

- [ ] **Step 5: Run check + tests to verify they pass**

Run (from `app/`): `npm run check && npm test`
Expected: PASS — type-check clean, all Vitest tests including the new one pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/events.ts app/src/lib/run.svelte.ts app/src/lib/events.test.ts
git commit -m "feat(M8): mirror run.diff + run.started worktree fields in the frontend"
```

---

## Task 7: Finalize — full verification + roadmap

**Files:**
- Modify: `ROADMAP.md:61`

- [ ] **Step 1: Regenerate TS bindings (confirm no-op)**

Run: `cargo test -p kata-core --features ts export_bindings`
Then: `git status --short app/src/bindings/`
Expected: PASS and NO changes — `KataEvent` is hand-mirrored (not ts-rs), and no `RunSpec`-side type changed, so the generated bindings are identical. If anything changed, stop and investigate.

- [ ] **Step 2: Full workspace verification**

Run each and confirm green:

```bash
cargo test --workspace
cargo clippy --all-targets -- -D warnings
cargo build --locked
```

Expected: all tests pass, clippy clean (no warnings), build succeeds with the lockfile honored.

- [ ] **Step 3: Mark the milestone done in the roadmap**

In `ROADMAP.md`, replace the M8 line (currently line 61):

```markdown
- [ ] **M8 - Worktree isolation.** When `leash.isolation = "worktree"`, create an ephemeral git worktree off `workdir`, run there, and surface the result as a reviewable diff. (Today the engine labels isolation but still runs in `workdir`.)
```

with:

```markdown
- [x] **M8 - Worktree isolation.** When `leash.isolation = "worktree"`, the engine branches off `workdir`'s HEAD into a persistent worktree under `~/.kata/worktrees/<slug>-<id>` (branch `kata/<slug>-<id>`), runs the agent there, and emits a `run.diff` summary before the terminal event; `run.started` now carries the worktree path + branch. A non-git `workdir` is refused (exit 2) rather than silently downgraded. Worktrees persist for review; cleanup is the operator's via native `git worktree remove`/`prune`. Engine + protocol scope — the Workbench diff panel is a fast-follow. **Status:** on `feat/m8-worktree-isolation`.
```

- [ ] **Step 4: Commit**

```bash
git add ROADMAP.md
git commit -m "docs(roadmap): reflect M8 worktree isolation"
```

---

## Self-review notes (verification of this plan against the spec)

- **Spec coverage:** persist+diff (Tasks 2, 5), central `~/.kata` + native cleanup (Task 2 `worktrees_dir`, no subcommand), hard-refuse non-repo (Task 5), `run.started` worktree/branch (Tasks 3, 5), `run.diff` protocol + frontend tolerance (Tasks 1, 6), exit-code preservation (Task 5 tail keeps 124/125/130 and `RunError`→CLI exit 2), branch-off-HEAD + index-untouched diff + untracked inclusion (Task 2 `diff`/tests). All covered.
- **Type consistency:** `DiffFile { status, path }` defined once in `event.rs`, imported by `worktree.rs` and mirrored in `events.ts`; `Worktree { path, branch }`, `DiffSummary { files, insertions, deletions }`, `RunError::Worktree(String)`, and `KataEvent::RunDiff { worktree, branch, files, insertions, deletions }` are used identically everywhere they appear.
- **No placeholders:** every code step shows complete code; every run step states the exact command and expected result.
- **Green at every commit:** Task 1 (additive), Task 2 (standalone module), Task 3 (mechanical field add + constructor), Task 4 (fixture builds), Task 5 (TDD wiring), Task 6 (frontend), Task 7 (verify). No task leaves the workspace uncompilable.
