//! Which branch a repository's change is compared with, where the change forked from it, and
//! how many commits the change carries. Never fetches: it reads only refs already present.

use crate::git::{self, GitError};
use std::path::Path;

/// The base a change is compared with.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BaseInfo {
    /// The base branch name, such as `main`.
    pub base: String,
    /// The ref the comparison uses: `origin/<base>` when it exists, else `<base>`.
    pub reference: String,
    /// The commit where HEAD forked from `reference`.
    pub merge_base: String,
}

#[derive(Debug, thiserror::Error)]
pub enum BaseError {
    #[error("{0} has no base branch: no origin/HEAD, main or master")]
    Unresolved(String),
    #[error(transparent)]
    Git(#[from] GitError),
}

/// `origin/HEAD`'s target, else `main`, else `master`, each accepted when it exists locally or
/// on `origin`.
pub fn base_branch(repo: &Path) -> Option<String> {
    let from_origin = git::run(
        repo,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .and_then(|t| t.strip_prefix("refs/remotes/origin/").map(String::from));
    from_origin
        .into_iter()
        .chain(["main", "master"].map(String::from))
        .find(|b| branch_exists(repo, b))
}

fn ref_exists(repo: &Path, name: &str) -> bool {
    git::run(repo, &["rev-parse", "--verify", "--quiet", name]).is_ok()
}

fn branch_exists(repo: &Path, b: &str) -> bool {
    ref_exists(repo, &format!("refs/heads/{b}"))
        || ref_exists(repo, &format!("refs/remotes/origin/{b}"))
}

/// The base branch, the ref to compare with (`origin/<base>` when it exists, else `<base>`), and
/// the merge base of HEAD and that ref.
pub fn base_info(repo: &Path) -> Result<BaseInfo, BaseError> {
    base_info_for(repo, "HEAD")
}

/// Like `base_info`, with the merge base taken for `rev` instead of HEAD.
pub fn base_info_for(repo: &Path, rev: &str) -> Result<BaseInfo, BaseError> {
    let base = base_branch(repo).ok_or_else(|| {
        BaseError::Unresolved(
            repo.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| repo.display().to_string()),
        )
    })?;
    let remote = format!("origin/{base}");
    let reference = if ref_exists(repo, &format!("refs/remotes/{remote}")) {
        remote
    } else {
        base.clone()
    };
    let merge_base = git::run(repo, &["merge-base", rev, &reference])?;
    Ok(BaseInfo {
        base,
        reference,
        merge_base,
    })
}

/// Commits HEAD has past the merge base: what a pull request would carry.
pub fn commits_ahead(repo: &Path) -> Result<u32, BaseError> {
    let info = base_info(repo)?;
    let count = git::run(
        repo,
        &["rev-list", "--count", &format!("{}..HEAD", info.merge_base)],
    )?;
    Ok(count.trim().parse().unwrap_or(0))
}

/// Commits `rev` has that neither the local base branch nor `origin/<base>` has: the work done
/// on a change branch, not base commits the engineer has yet to push and not base commits others
/// pushed that a rebase carried in. The Changes view still compares against the merge base with
/// the remote (R7.7); only the decision whether a repository was changed at all, and whose
/// commits are judged, use this (R10.1).
pub fn commits_ahead_of_local_base(repo: &Path, rev: &str) -> Result<u32, BaseError> {
    let revs = build_work_revs(repo, rev)?;
    let mut args = vec!["rev-list".to_string(), "--count".to_string()];
    args.extend(revs);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let count = git::run(repo, &args)?;
    Ok(count.trim().parse().unwrap_or(0))
}

/// The revision arguments naming the work on a change branch: `rev ^<local base> ^origin/<base>`.
/// Each exclusion is present only when that ref exists, so a repository with no remote uses the
/// local base alone and one with no local base uses `origin/<base>` alone. Every "what did the
/// build add" computation (`rev-list`, `log`) starts here.
pub fn build_work_revs(repo: &Path, rev: &str) -> Result<Vec<String>, BaseError> {
    let info = base_info_for(repo, rev)?;
    let mut revs = vec![rev.to_string()];
    if ref_exists(repo, &format!("refs/heads/{}", info.base)) {
        revs.push(format!("^{}", info.base));
    }
    if ref_exists(repo, &format!("refs/remotes/origin/{}", info.base)) {
        revs.push(format!("^origin/{}", info.base));
    }
    Ok(revs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{bare_origin, checkout, commit_file, repo};

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn origin_head_wins_over_everything_else() {
        let d = tmp();
        let r = repo(d.path(), "app");
        bare_origin(&r, Some("trunk"));
        checkout(&r, "develop", true);
        git::run(&r, &["update-ref", "refs/remotes/origin/develop", "HEAD"]).unwrap();
        git::run(
            &r,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/develop",
            ],
        )
        .unwrap();
        assert_eq!(base_branch(&r).as_deref(), Some("develop"));
    }

    #[test]
    fn a_local_bare_origin_without_origin_head_falls_through_to_local_main() {
        let d = tmp();
        let r = repo(d.path(), "app");
        bare_origin(&r, None);
        assert_eq!(base_branch(&r).as_deref(), Some("main"));
    }

    #[test]
    fn without_a_remote_local_main_is_the_default() {
        let d = tmp();
        let r = repo(d.path(), "app");
        assert_eq!(base_branch(&r).as_deref(), Some("main"));
    }

    #[test]
    fn without_main_local_master_is_the_default() {
        let d = tmp();
        let r = repo(d.path(), "app");
        git::run(&r, &["branch", "-m", "main", "master"]).unwrap();
        assert_eq!(base_branch(&r).as_deref(), Some("master"));
    }

    #[test]
    fn with_no_candidate_the_base_is_unresolved() {
        let d = tmp();
        let r = repo(d.path(), "app");
        git::run(&r, &["branch", "-m", "main", "trunk"]).unwrap();
        assert_eq!(base_branch(&r), None);
    }

    #[test]
    fn counts_commits_on_a_feature_branch_since_the_merge_base() {
        let d = tmp();
        let r = repo(d.path(), "app");
        checkout(&r, "feature", true);
        commit_file(&r, "a.txt", "a\n", "one");
        commit_file(&r, "b.txt", "b\n", "two");
        assert_eq!(commits_ahead(&r).unwrap(), 2);
    }

    #[test]
    fn the_base_branch_itself_is_zero_ahead() {
        let d = tmp();
        let r = repo(d.path(), "app");
        assert_eq!(commits_ahead(&r).unwrap(), 0);
    }

    #[test]
    fn commits_on_base_after_branching_are_not_counted() {
        let d = tmp();
        let r = repo(d.path(), "app");
        checkout(&r, "feature", true);
        commit_file(&r, "a.txt", "a\n", "on feature");
        checkout(&r, "main", false);
        commit_file(&r, "m.txt", "m\n", "on main");
        checkout(&r, "feature", false);
        assert_eq!(commits_ahead(&r).unwrap(), 1);
    }

    #[test]
    fn an_unresolvable_base_is_base_branch_unresolved() {
        let d = tmp();
        let r = repo(d.path(), "app");
        git::run(&r, &["branch", "-m", "main", "trunk"]).unwrap();
        let err = commits_ahead(&r).unwrap_err();
        assert!(matches!(err, BaseError::Unresolved(_)), "got: {err}");
        assert_eq!(
            err.to_string(),
            "app has no base branch: no origin/HEAD, main or master"
        );
    }

    #[test]
    fn a_change_rebased_onto_a_newer_origin_base_does_not_count_others_commits_r10_1() {
        let d = tmp();
        let r = repo(d.path(), "app");
        bare_origin(&r, None);
        checkout(&r, "change/x", true);
        commit_file(
            &r,
            "c.txt",
            "c
",
            "the change",
        );
        crate::testutil::advance_origin_only(&r, "main", "others.txt", "someone else's work");
        git::run(&r, &["rebase", "-q", "origin/main"]).unwrap();
        assert_eq!(commits_ahead_of_local_base(&r, "HEAD").unwrap(), 1);
    }

    #[test]
    fn unpushed_local_base_commits_do_not_count_as_change_work_r10_1() {
        let d = tmp();
        let r = repo(d.path(), "app");
        bare_origin(&r, None);
        commit_file(
            &r,
            "unpushed.txt",
            "u
",
            "never pushed",
        );
        checkout(&r, "change/x", true);
        assert_eq!(commits_ahead_of_local_base(&r, "HEAD").unwrap(), 0);
    }

    #[test]
    fn local_base_commits_not_on_origin_are_in_the_change_r7_7() {
        let d = tmp();
        let r = repo(d.path(), "app");
        bare_origin(&r, None);
        commit_file(&r, "unpushed.txt", "u\n", "never pushed");
        checkout(&r, "change/x", true);
        commit_file(&r, "c.txt", "c\n", "the change");
        let info = base_info(&r).unwrap();
        assert_eq!(info.reference, "origin/main");
        assert_eq!(commits_ahead(&r).unwrap(), 2);
    }
}
