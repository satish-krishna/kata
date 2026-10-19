use crate::git;
use std::path::Path;

fn branch_exists(repo: &Path, name: &str) -> bool {
    git::run(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ],
    )
    .is_ok()
}

/// The base branch for change branches: `main` if it exists, else `master`, else the current branch.
pub fn default_base(master: &Path) -> Option<String> {
    ["main", "master"]
        .into_iter()
        .find(|b| branch_exists(master, b))
        .map(str::to_string)
        .or_else(|| crate::changes::current_branch(master))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    #[test]
    fn prefers_main_then_master_then_current() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        assert_eq!(default_base(&repo).as_deref(), Some("main"));

        git::run(&repo, &["branch", "-m", "main", "master"]).unwrap();
        assert_eq!(default_base(&repo).as_deref(), Some("master"));

        git::run(&repo, &["branch", "-m", "master", "trunk"]).unwrap();
        assert_eq!(default_base(&repo).as_deref(), Some("trunk"));
    }
}
