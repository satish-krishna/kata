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
        let path = it.next_back().unwrap_or("").to_string();
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
        let path = it.next_back().unwrap_or("").to_string(); // last field handles renames
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
