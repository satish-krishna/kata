//! Git worktree isolation: branch off `workdir`'s HEAD into a persistent
//! worktree under `~/.kata/worktrees`, run the agent there, and read back a
//! diff summary. The worktree is NOT removed on drop — it persists for review;
//! cleanup is the operator's via `git worktree remove` / `git worktree prune`.

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

#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    #[error("not a git repository (or no HEAD): {0}")]
    NotAGitRepo(String),
    #[error("`git` was not found on PATH")]
    GitMissing,
    #[error("could not resolve a home directory for ~/.kata (HOME/USERPROFILE unset)")]
    NoHome,
    #[error("git {cmd} failed (status {status:?}): {stderr}")]
    Git {
        cmd: String,
        status: Option<i32>,
        stderr: String,
    },
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
    if !git(wd, &["rev-parse", "--verify", "HEAD"])?
        .status
        .success()
    {
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
    Ok(Worktree {
        path: path_str,
        branch,
    })
}

/// Resolve `<kata-home>/worktrees`. Returns `NoHome` rather than falling back to
/// "." — we must never scatter worktrees into the cwd.
fn worktrees_dir() -> Result<PathBuf, WorktreeError> {
    crate::fsutil::kata_home()
        .map(|h| h.join("worktrees"))
        .ok_or(WorktreeError::NoHome)
}

/// Sanitize a spec name into a filesystem/branch-safe segment: map anything
/// outside `[A-Za-z0-9_-]` to '-', trim '-', fall back to "kata".
fn slug(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = mapped.trim_matches('-');
    if trimmed.is_empty() {
        "kata".to_string()
    } else {
        trimmed.to_string()
    }
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
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                WorktreeError::GitMissing
            } else {
                WorktreeError::Io(e)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

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
        assert!(
            wt.branch.starts_with("kata/my-spec-"),
            "branch was {}",
            wt.branch
        );
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
    #[serial]
    fn worktrees_dir_resolution_order() {
        let saved: Vec<(&str, Option<String>)> = ["KATA_HOME", "HOME", "USERPROFILE"]
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();
        let restore = || {
            for (k, v) in &saved {
                match v {
                    Some(val) => std::env::set_var(k, val),
                    None => std::env::remove_var(k),
                }
            }
        };

        // 1. KATA_HOME wins.
        std::env::set_var("KATA_HOME", "/tmp/khome");
        assert_eq!(
            worktrees_dir().unwrap(),
            PathBuf::from("/tmp/khome").join("worktrees")
        );

        // 2. Falls back to HOME/.kata.
        std::env::remove_var("KATA_HOME");
        std::env::remove_var("USERPROFILE");
        std::env::set_var("HOME", "/tmp/h");
        assert_eq!(
            worktrees_dir().unwrap(),
            PathBuf::from("/tmp/h").join(".kata").join("worktrees")
        );

        // 3. Neither => NoHome.
        std::env::remove_var("HOME");
        std::env::remove_var("USERPROFILE");
        std::env::remove_var("KATA_HOME");
        assert!(matches!(
            worktrees_dir().unwrap_err(),
            WorktreeError::NoHome
        ));

        restore();
    }
}
