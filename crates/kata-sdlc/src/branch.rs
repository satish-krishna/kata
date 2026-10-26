use crate::changes::is_change_name;
use crate::git::{self, GitError};
use crate::snapshot::status_entries;
use std::collections::BTreeSet;
use std::path::Path;

pub fn branch_exists(repo: &Path, name: &str) -> bool {
    git::Repo::open(repo).is_ok_and(|r| r.branch_exists(name))
}

/// The base branch for change branches: `main` if it exists, else `master`, else the current branch.
pub fn default_base(master: &Path) -> Option<String> {
    let repo = git::Repo::open(master).ok()?;
    ["main", "master"]
        .into_iter()
        .find(|b| repo.branch_exists(b))
        .map(str::to_string)
        .or_else(|| repo.current_branch())
}

/// The checked-out branch; `None` on a detached or unborn HEAD.
pub fn current_branch(master: &Path) -> Option<String> {
    git::Repo::open(master).ok()?.current_branch()
}

#[derive(Debug, thiserror::Error)]
pub enum BranchError {
    #[error("the master repo has uncommitted changes: {}", .0.join(", "))]
    Dirty(Vec<String>),
    #[error("the master repo is on a detached HEAD")]
    Detached,
    #[error(
        "the pending branch has commits but created no change folder; leave it for manual cleanup"
    )]
    PendingHasCommits,
    #[error("invalid branch name: {0}")]
    InvalidName(String),
    #[error(transparent)]
    Git(#[from] GitError),
}

/// A name that cannot be read as a git option and names an existing local branch.
fn require_local_branch(master: &Path, name: &str) -> Result<(), BranchError> {
    if name.is_empty() || name.starts_with('-') || !branch_exists(master, name) {
        return Err(BranchError::InvalidName(name.to_string()));
    }
    Ok(())
}

/// What became of a pending branch once its run finished.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum FinishOutcome {
    Renamed { branch: String, change: String },
    Deleted,
}

/// Seconds since the Unix epoch as `YYYYMMDDThhmmssZ`. Same output as `kata_core::fsutil::utc_stamp`.
fn utc_stamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let sod = unix_secs % 86_400;
    let (h, m, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}{mo:02}{d:02}T{h:02}{m:02}{s:02}Z")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub(crate) fn ensure_clean(master: &Path) -> Result<(), BranchError> {
    let dirty: Vec<String> = status_entries(master)?
        .into_iter()
        .map(|e| e.path)
        .collect();
    if dirty.is_empty() {
        Ok(())
    } else {
        Err(BranchError::Dirty(dirty))
    }
}

/// Create and check out `change/pending-<stamp>` from `base`. Refuses a dirty tree or a detached/unborn HEAD.
pub fn start_pending(master: &Path, base: &str, now_unix: u64) -> Result<String, BranchError> {
    if current_branch(master).is_none() {
        return Err(BranchError::Detached);
    }
    require_local_branch(master, base)?;
    ensure_clean(master)?;
    let name = format!("change/pending-{}", utc_stamp(now_unix));
    git::legacy_cli::run(master, &["checkout", "-q", "-b", &name, base])?;
    Ok(name)
}

/// Change folder names (`intent/<system>/<change>/...`) in a list of repo-relative paths.
fn change_folders<'a>(paths: impl Iterator<Item = &'a str>) -> BTreeSet<String> {
    paths
        .filter_map(|p| {
            let mut parts = p.split('/');
            (parts.next()? == "intent").then_some(())?;
            let system = parts.next()?;
            let change = parts.next()?;
            parts.next()?;
            (!system.is_empty() && is_change_name(change)).then(|| format!("{system}/{change}"))
        })
        .collect()
}

fn existing_on(master: &Path, rev: &str, system_change: &str) -> bool {
    git::legacy_cli::run(
        master,
        &[
            "ls-tree",
            "--name-only",
            rev,
            "--",
            &format!("intent/{system_change}"),
        ],
    )
    .map(|o| !o.is_empty())
    .unwrap_or(false)
}

/// Settle a pending branch: rename it to `change/<folder>` if the run created a change folder,
/// otherwise return to `base` and delete it (only when it carries no commits).
///
/// The delete path refuses a dirty tree with `BranchError::Dirty` and leaves the pending branch
/// checked out and untouched. The caller resolves the leftovers (discard or keep) and calls
/// `finish_pending` again.
pub fn finish_pending(
    master: &Path,
    pending: &str,
    base: &str,
) -> Result<FinishOutcome, BranchError> {
    if !pending.starts_with("change/pending-") {
        return Err(BranchError::InvalidName(pending.to_string()));
    }
    require_local_branch(master, pending)?;
    require_local_branch(master, base)?;
    let mut paths: Vec<String> = status_entries(master)?
        .into_iter()
        .map(|e| e.path)
        .collect();
    if let Ok(diff) =
        git::legacy_cli::run(master, &["diff", "--name-only", &format!("{base}...HEAD")])
    {
        paths.extend(diff.lines().map(str::to_string));
    }
    let created = change_folders(paths.iter().map(String::as_str))
        .into_iter()
        .find(|sc| !existing_on(master, base, sc));
    if let Some(sc) = created {
        let change = sc.rsplit('/').next().unwrap_or(&sc).to_string();
        let branch = format!("change/{change}");
        git::legacy_cli::run(master, &["branch", "-m", pending, &branch])?;
        return Ok(FinishOutcome::Renamed { branch, change });
    }
    let ahead = git::legacy_cli::run(
        master,
        &["rev-list", "--count", &format!("{base}..{pending}")],
    )?;
    if ahead.trim() != "0" {
        return Err(BranchError::PendingHasCommits);
    }
    ensure_clean(master)?;
    git::legacy_cli::run(master, &["checkout", "-q", base])?;
    git::legacy_cli::run(master, &["branch", "-D", pending])?;
    Ok(FinishOutcome::Deleted)
}

/// Switch branches. Refuses a dirty working tree.
pub fn checkout(master: &Path, branch: &str) -> Result<(), BranchError> {
    require_local_branch(master, branch)?;
    ensure_clean(master)?;
    git::legacy_cli::run(master, &["checkout", "-q", branch, "--"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    #[test]
    fn default_base_prefers_main_then_master() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        assert_eq!(default_base(&repo).as_deref(), Some("main"));

        git::run(&repo, &["branch", "-m", "main", "master"]).unwrap();
        assert_eq!(default_base(&repo).as_deref(), Some("master"));

        git::run(&repo, &["branch", "-m", "master", "trunk"]).unwrap();
        assert_eq!(default_base(&repo).as_deref(), Some("trunk"));
    }

    #[test]
    fn branch_names_are_validated() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        for bad in ["-b", "--detach", "", "nope"] {
            assert!(
                matches!(
                    start_pending(&repo, bad, 0),
                    Err(BranchError::InvalidName(_))
                ),
                "start {bad}"
            );
            assert!(
                matches!(checkout(&repo, bad), Err(BranchError::InvalidName(_))),
                "checkout {bad}"
            );
        }
        // Only a pending branch may be settled; a real branch is never deleted or renamed.
        for bad in ["main", "-D", "change/2026-10-18-x"] {
            assert!(
                matches!(
                    finish_pending(&repo, bad, "main"),
                    Err(BranchError::InvalidName(_))
                ),
                "finish {bad}"
            );
        }
        let pending = start_pending(&repo, "main", 1_792_368_000).unwrap();
        assert!(matches!(
            finish_pending(&repo, &pending, "--force"),
            Err(BranchError::InvalidName(_))
        ));
        assert!(branch_exists(&repo, "main"));
        assert!(branch_exists(&repo, &pending));
    }

    #[test]
    fn start_pending_names_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let name = start_pending(&repo, "main", 1_792_368_000).unwrap();
        assert_eq!(name, "change/pending-20261019T000000Z");
        assert_eq!(current_branch(&repo).as_deref(), Some(name.as_str()));
    }

    #[test]
    fn start_refuses_dirty_and_detached() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        std::fs::write(repo.join("scratch.txt"), "x").unwrap();
        let err = start_pending(&repo, "main", 0).unwrap_err();
        assert!(matches!(&err, BranchError::Dirty(p) if p == &["scratch.txt"]));
        assert_eq!(
            err.to_string(),
            "the master repo has uncommitted changes: scratch.txt"
        );
        std::fs::remove_file(repo.join("scratch.txt")).unwrap();

        git::run(&repo, &["checkout", "-q", "--detach"]).unwrap();
        let err = start_pending(&repo, "main", 0).unwrap_err();
        assert!(matches!(err, BranchError::Detached));
        assert_eq!(err.to_string(), "the master repo is on a detached HEAD");
    }

    #[test]
    fn start_refuses_unborn_head() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("fresh");
        std::fs::create_dir_all(&repo).unwrap();
        git::run(&repo, &["init", "-q", "-b", "main"]).unwrap();
        assert!(matches!(
            start_pending(&repo, "main", 0),
            Err(BranchError::Detached)
        ));
    }

    #[test]
    fn finish_renames_when_folder_created() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let pending = start_pending(&repo, "main", 1_792_368_000).unwrap();
        testutil::commit_file(
            &repo,
            "intent/claims/2026-10-18-new-thing/intent.md",
            "x
",
            "add",
        );
        let out = finish_pending(&repo, &pending, "main").unwrap();
        assert_eq!(
            out,
            FinishOutcome::Renamed {
                branch: "change/2026-10-18-new-thing".into(),
                change: "2026-10-18-new-thing".into()
            }
        );
        assert_eq!(
            current_branch(&repo).as_deref(),
            Some("change/2026-10-18-new-thing")
        );
    }

    #[test]
    fn finish_renames_for_uncommitted_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let pending = start_pending(&repo, "main", 1_792_368_000).unwrap();
        let dir = repo.join("intent/claims/2026-10-18-new-thing");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("intent.md"),
            "x
",
        )
        .unwrap();
        let out = finish_pending(&repo, &pending, "main").unwrap();
        assert!(matches!(out, FinishOutcome::Renamed { .. }));
    }

    #[test]
    fn finish_deletes_empty_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let pending = start_pending(&repo, "main", 1_792_368_000).unwrap();
        assert_eq!(
            finish_pending(&repo, &pending, "main").unwrap(),
            FinishOutcome::Deleted
        );
        assert_eq!(current_branch(&repo).as_deref(), Some("main"));
        assert!(!branch_exists(&repo, &pending));
    }

    #[test]
    fn finish_keeps_pending_with_commits_but_no_change_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let pending = start_pending(&repo, "main", 1_792_368_000).unwrap();
        testutil::commit_file(
            &repo,
            "notes.txt",
            "x
",
            "stray",
        );
        assert!(matches!(
            finish_pending(&repo, &pending, "main"),
            Err(BranchError::PendingHasCommits)
        ));
        assert!(branch_exists(&repo, &pending));
    }

    #[test]
    fn finish_refuses_to_leave_dirty_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let pending = start_pending(&repo, "main", 1_792_368_000).unwrap();
        std::fs::write(
            repo.join("README.md"),
            "edited
",
        )
        .unwrap();
        let err = finish_pending(&repo, &pending, "main").unwrap_err();
        assert!(matches!(&err, BranchError::Dirty(p) if p == &["README.md"]));
        assert_eq!(current_branch(&repo).as_deref(), Some(pending.as_str()));
        assert!(branch_exists(&repo, &pending));
    }

    #[test]
    fn post_checkout_failure_keeps_the_switch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        git::run(&repo, &["branch", "other"]).unwrap();
        // The hook leaves a mark and then fails; git ignores that failure for the switch.
        std::fs::write(
            repo.join(".git/hooks/post-checkout"),
            "#!/bin/sh\necho \"$@\" >> .git/hook-ran\nexit 1\n",
        )
        .unwrap();

        let pending = start_pending(&repo, "main", 1_792_368_000).unwrap();
        assert_eq!(current_branch(&repo).as_deref(), Some(pending.as_str()));
        checkout(&repo, "other").unwrap();
        assert_eq!(current_branch(&repo).as_deref(), Some("other"));

        let ran = std::fs::read_to_string(repo.join(".git/hook-ran")).unwrap();
        let lines: Vec<&str> = ran.lines().collect();
        assert_eq!(lines.len(), 2, "{ran}");
        assert!(lines.iter().all(|l| l.ends_with(" 1")), "{ran}");
    }

    #[test]
    fn checkout_refuses_dirty() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        git::run(&repo, &["branch", "other"]).unwrap();
        checkout(&repo, "other").unwrap();
        assert_eq!(current_branch(&repo).as_deref(), Some("other"));
        std::fs::write(repo.join("scratch.txt"), "x").unwrap();
        let err = checkout(&repo, "main").unwrap_err();
        assert!(matches!(&err, BranchError::Dirty(p) if p == &["scratch.txt"]));
        assert_eq!(current_branch(&repo).as_deref(), Some("other"));
    }
}
