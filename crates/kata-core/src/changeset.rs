//! Changeset summary for a directory: its working folder against `HEAD` (tracked changes)
//! plus newly-created untracked files, WITHOUT mutating the index. Used for
//! both worktree-isolated runs (diff the worktree) and default runs (diff the
//! workdir). A non-git directory is a benign, common case the caller reports
//! quietly (`ChangesetError::NotARepo`); any other failure is an `Err` the
//! caller degrades to a warning — a diff must never mask a run's outcome.

use crate::event::DiffFile;
use git2::{Delta, DiffOptions, ErrorCode, Patch, Repository};
use std::collections::HashMap;
use std::path::Path;

/// A changeset for a directory, relative to its `HEAD`.
#[derive(Debug, Clone, PartialEq)]
pub struct DiffSummary {
    pub files: Vec<DiffFile>,
    pub insertions: u32,
    pub deletions: u32,
    pub by_type: Vec<crate::event::DiffTypeStat>,
}

#[derive(Debug, thiserror::Error)]
pub enum ChangesetError {
    #[error("not a git repository")]
    NotARepo,
    #[error("git {cmd} failed (status {status:?}): {stderr}")]
    Git {
        cmd: String,
        status: Option<i32>,
        stderr: String,
    },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

fn failed(cmd: &str, e: git2::Error) -> ChangesetError {
    ChangesetError::Git {
        cmd: cmd.into(),
        status: None,
        stderr: e.message().trim().to_string(),
    }
}

/// Summarize `dir`'s changes vs its `HEAD`, including newly-created untracked
/// files, WITHOUT mutating the index. A directory that is not a git work tree
/// surfaces as `Err(ChangesetError::NotARepo)`; any other git failure surfaces
/// as `Err(ChangesetError::Git { .. })`.
pub fn diff_at(dir: &Path) -> Result<DiffSummary, ChangesetError> {
    let repo = match Repository::discover(dir) {
        Ok(repo) => repo,
        Err(e) if e.code() == ErrorCode::NotFound => return Err(ChangesetError::NotARepo),
        Err(e) => return Err(failed("rev-parse --git-dir", e)),
    };
    let root = repo
        .workdir()
        .ok_or(ChangesetError::NotARepo)?
        .to_path_buf();
    let tree = repo
        .head()
        .and_then(|h| h.peel_to_tree())
        .map_err(|e| failed("diff HEAD", e))?;

    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    // Tree against the index and the working folder together, like `git diff HEAD`; nothing is
    // written back to the index.
    let mut diff = repo
        .diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts))
        .map_err(|e| failed("diff HEAD", e))?;
    diff.find_similar(None)
        .map_err(|e| failed("diff HEAD", e))?;

    let mut files = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    let mut insertions = 0u32;
    let mut deletions = 0u32;
    let mut by_ext: HashMap<String, (u32, u32, u32)> = HashMap::new();
    for idx in 0..diff.deltas().len() {
        let Some(delta) = diff.get_delta(idx) else {
            continue;
        };
        let status = match delta.status() {
            Delta::Untracked => {
                if let Some(path) = delta.new_file().path() {
                    untracked.push(path.to_string_lossy().replace('\\', "/"));
                }
                continue;
            }
            Delta::Added => "A",
            Delta::Deleted => "D",
            Delta::Modified => "M",
            Delta::Renamed => "R",
            Delta::Copied => "C",
            Delta::Typechange => "T",
            _ => continue,
        };
        let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) else {
            continue;
        };
        let path = path.to_string_lossy().replace('\\', "/");
        // A rename's line counts stay zero (known oddity, issue #7).
        let (ins, del) = if delta.status() == Delta::Renamed {
            (0, 0)
        } else {
            match Patch::from_diff(&diff, idx) {
                Ok(Some(patch)) => patch
                    .line_stats()
                    .map(|(_, a, d)| (a as u32, d as u32))
                    .unwrap_or((0, 0)),
                _ => (0, 0),
            }
        };
        insertions += ins;
        deletions += del;
        let e = by_ext.entry(ext_of(&path)).or_insert((0, 0, 0));
        e.0 += 1;
        e.1 += ins;
        e.2 += del;
        files.push(DiffFile {
            status: status.into(),
            path,
        });
    }

    // Untracked (newly-created) files come after the tracked ones: status "A",
    // insertions = line count.
    untracked.sort();
    for path in untracked {
        let ins = std::fs::read_to_string(root.join(&path))
            .map(|c| c.lines().count() as u32)
            .unwrap_or(0); // unreadable/binary => 0
        insertions += ins;
        let e = by_ext.entry(ext_of(&path)).or_insert((0, 0, 0));
        e.0 += 1;
        e.1 += ins;
        files.push(DiffFile {
            status: "A".into(),
            path,
        });
    }

    let mut by_type: Vec<crate::event::DiffTypeStat> = by_ext
        .into_iter()
        .map(
            |(file_type, (files, insertions, deletions))| crate::event::DiffTypeStat {
                file_type,
                files,
                insertions,
                deletions,
            },
        )
        .collect();
    by_type.sort_by(|a, b| a.file_type.cmp(&b.file_type));

    Ok(DiffSummary {
        files,
        insertions,
        deletions,
        by_type,
    })
}

/// Lowercased file extension of a path, or "" when there is none. Uses
/// `Path::extension`, so a leading-dot-only name (".gitignore") has no
/// extension.
fn ext_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default()
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
        assert!(matches!(err, ChangesetError::NotARepo), "got {err:?}");
    }

    #[test]
    fn diff_at_groups_by_file_type() {
        let repo = init_repo(); // seeds tracked.txt ("one\ntwo\n")
                                // Modify tracked .txt (+1), add untracked .rs (+2) and a no-ext file (+1).
        std::fs::write(repo.path().join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(repo.path().join("new.rs"), "a\nb\n").unwrap();
        std::fs::write(repo.path().join("Makefile"), "all:\n").unwrap();

        let d = diff_at(repo.path()).unwrap();

        // Sorted by file_type: "" (Makefile), "rs", "txt".
        let types: Vec<&str> = d.by_type.iter().map(|t| t.file_type.as_str()).collect();
        assert_eq!(
            types,
            vec!["", "rs", "txt"],
            "sorted by file_type: {:?}",
            d.by_type
        );

        let get = |t: &str| d.by_type.iter().find(|s| s.file_type == t).unwrap();
        assert_eq!((get("").files, get("").insertions), (1, 1)); // Makefile: +1
        assert_eq!((get("rs").files, get("rs").insertions), (1, 2)); // new.rs: +2
        assert_eq!((get("txt").files, get("txt").insertions), (1, 1)); // tracked.txt: +1

        // by_type is a partition of the totals.
        let sum_ins: u32 = d.by_type.iter().map(|t| t.insertions).sum();
        let sum_del: u32 = d.by_type.iter().map(|t| t.deletions).sum();
        assert_eq!(sum_ins, d.insertions);
        assert_eq!(sum_del, d.deletions);
    }
}
