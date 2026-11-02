use crate::base;
use crate::changes::is_change_name;
use crate::git::{self, GitError};
use crate::snapshot::status_entries;
use std::collections::BTreeSet;
use std::path::Path;

/// The prefix of the temporary branch an older Kata gave a change before it was named. The plugin makes a
/// change's branch now, so no new one is made, but a master repository may still stand on one.
pub(crate) const PENDING_PREFIX: &str = "change/pending-";

pub fn branch_exists(repo: &Path, name: &str) -> bool {
    git::Repo::open(repo).is_ok_and(|r| r.branch_exists(name))
}

/// The checked-out branch; `None` on a detached or unborn HEAD.
pub fn current_branch(master: &Path) -> Option<String> {
    git::Repo::open(master).ok()?.current_branch()
}

#[derive(Debug, thiserror::Error)]
pub enum BranchError {
    #[error("the master repo has uncommitted changes: {}", .0.join(", "))]
    Dirty(Vec<String>),
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

fn existing_on(repo: &git::Repo, rev: &str, system_change: &str) -> bool {
    repo.entry_at(rev, &format!("intent/{system_change}"))
        .ok()
        .flatten()
        .is_some()
}

/// The `<system>/<change>` folder the checked-out pending branch created: one changed from `base`
/// (committed or not) that `base` does not hold.
fn created_folder(
    master: &Path,
    repo: &git::Repo,
    base: &str,
) -> Result<Option<String>, BranchError> {
    let mut paths: Vec<String> = status_entries(master)?
        .into_iter()
        .map(|e| e.path)
        .collect();
    if let Ok(changed) = repo.files_changed_from_merge_base(base) {
        paths.extend(changed);
    }
    Ok(change_folders(paths.iter().map(String::as_str))
        .into_iter()
        .find(|sc| !existing_on(repo, base, sc)))
}

/// The `<system>/<change>` folder the pending branch checked out in `master` created, if any.
pub fn pending_created(master: &Path) -> Option<String> {
    let current = current_branch(master)?;
    if !current.starts_with(PENDING_PREFIX) {
        return None;
    }
    let base = base::base_branch(master)?;
    let reference = base::compare_ref(master, &base)?;
    let repo = git::Repo::open(master).ok()?;
    created_folder(master, &repo, &reference).ok().flatten()
}

/// Switch branches. Refuses a dirty working tree.
pub fn checkout(master: &Path, branch: &str) -> Result<(), BranchError> {
    require_local_branch(master, branch)?;
    ensure_clean(master)?;
    git::Repo::open(master)?.checkout_branch(branch)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{base, testutil};

    const MARKER: &str = r#"{"version":1,"systems":{"kata":{"repos":["kata"]}}}"#;
    const CHANGE: &str = "2026-11-02-password-reset";

    /// A workspace folder with the master `ai-sdlc` (marker committed).
    fn workspace(tmp: &Path) -> std::path::PathBuf {
        let master = testutil::repo(tmp, "ai-sdlc");
        testutil::commit_file(&master, ".ai-sdlc.json", MARKER, "marker");
        master
    }

    fn intent(master: &Path) {
        let rel = format!("intent/kata/{CHANGE}/intent.md");
        testutil::commit_file(
            master,
            &rel,
            "---
status: draft
---
x
",
            "intent",
        );
    }

    #[test]
    fn base_branch_is_never_the_current_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        assert_eq!(base::base_branch(&repo).as_deref(), Some("main"));

        git::run(&repo, &["branch", "-m", "main", "master"]).unwrap();
        assert_eq!(base::base_branch(&repo).as_deref(), Some("master"));

        git::run(&repo, &["branch", "-m", "master", "trunk"]).unwrap();
        assert_eq!(base::base_branch(&repo), None);
    }

    #[test]
    fn branch_names_are_validated() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        for bad in ["-b", "--detach", "", "nope"] {
            assert!(
                matches!(checkout(&repo, bad), Err(BranchError::InvalidName(_))),
                "checkout {bad}"
            );
        }
        assert!(branch_exists(&repo, "main"));
    }

    #[test]
    fn post_checkout_failure_keeps_the_switch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        git::run(&repo, &["branch", "other"]).unwrap();
        // The hook leaves a mark and then fails; git ignores that failure for the switch.
        std::fs::write(
            repo.join(".git/hooks/post-checkout"),
            "#!/bin/sh
echo \"$@\" >> .git/hook-ran
exit 1
",
        )
        .unwrap();

        checkout(&repo, "other").unwrap();
        assert_eq!(current_branch(&repo).as_deref(), Some("other"));

        let ran = std::fs::read_to_string(repo.join(".git/hook-ran")).unwrap();
        let lines: Vec<&str> = ran.lines().collect();
        assert_eq!(lines.len(), 1, "{ran}");
        assert!(lines.iter().all(|l| l.ends_with(" 1")), "{ran}");
    }

    #[test]
    fn a_pending_branch_made_by_hand_on_a_master_with_no_base_is_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        let master = workspace(tmp.path());
        git::run(&master, &["branch", "-m", "main", "trunk"]).unwrap();
        testutil::checkout(&master, "change/pending-20261018T000000Z", true);
        intent(&master);
        assert_eq!(pending_created(&master), None);
        assert_eq!(crate::changes::branch_info(&master).default_base, None);
    }

    #[test]
    fn branch_info_names_the_change_a_pending_branch_created() {
        let tmp = tempfile::tempdir().unwrap();
        let master = workspace(tmp.path());
        assert_eq!(crate::changes::branch_info(&master).pending_change, None);
        testutil::checkout(&master, "change/pending-20261018T000000Z", true);
        assert_eq!(crate::changes::branch_info(&master).pending_change, None);
        intent(&master);
        assert_eq!(
            crate::changes::branch_info(&master).pending_change,
            Some(format!("kata/{CHANGE}"))
        );
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
