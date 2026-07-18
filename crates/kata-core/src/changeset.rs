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
            d.files
                .iter()
                .any(|f| f.path == "new.txt" && f.status == "A"),
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
        assert!(
            d.files.is_empty(),
            "a clean repo has no changes: {:?}",
            d.files
        );
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
