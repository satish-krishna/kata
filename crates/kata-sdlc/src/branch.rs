use crate::build::{self, RepoState};
use crate::changes::{is_change_name, is_safe_system};
use crate::diff;
use crate::frontmatter;
use crate::git::{self, GitError};
use crate::snapshot::status_entries;
use crate::workspace::{self, system_repos};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// The change's record in its master repository, as the program writes it (`change.yml`) or an older
/// Kata wrote it (`branch.md`): the file and the text of its `key` field.
fn recorded_field(
    master: &Path,
    system: &str,
    change: &str,
    key: &str,
) -> Option<(String, String)> {
    let dir = master.join("intent").join(system).join(change);
    if let Ok(text) = std::fs::read_to_string(dir.join("change.yml")) {
        // The program writes every string JSON-quoted, one `key: value` per line.
        let value = text.lines().find_map(|l| {
            let v = l.strip_prefix(key)?.strip_prefix(':')?.trim();
            Some(serde_json::from_str::<String>(v).unwrap_or_else(|_| v.to_string()))
        });
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            return Some(("change.yml".into(), value));
        }
    }
    let text = std::fs::read_to_string(dir.join("branch.md")).ok()?;
    let value = crate::frontmatter::field(&text, key).filter(|v| !v.is_empty())?;
    Some(("branch.md".into(), value))
}

/// The branch the change uses: the one its record names, else `change/<change>`. A record that is present
/// but names an unusable branch is an error, so a hand edit can never reach git.
pub fn change_branch(master: &Path, system: &str, change: &str) -> Result<String, String> {
    let Some((file, branch)) = recorded_field(master, system, change, "branch") else {
        return Ok(format!("change/{change}"));
    };
    if branch.starts_with('-')
        || branch == "HEAD"
        || !git2::Reference::is_valid_name(&format!("refs/heads/{branch}"))
    {
        return Err(format!(
            "intent/{system}/{change}/{file} names \"{branch}\", which is not a usable branch name"
        ));
    }
    Ok(branch)
}

/// A local branch other than the current one that holds a change.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct OtherBranch {
    /// The full branch name.
    pub branch: String,
    /// The change folder name the branch holds.
    pub change: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BranchInfo {
    pub current: Option<String>,
    pub others: Vec<OtherBranch>,
    pub default_base: Option<String>,
}

/// The master's branch, the other local branches that hold a change, and the base branch.
pub fn branch_info(master: &Path) -> BranchInfo {
    BranchInfo {
        current: current_branch(master),
        others: other_change_branches(master),
        default_base: diff::base_branch(master),
    }
}

/// The first change folder (system, then change name, in sorted order) that `tip` holds and `base` does
/// not, with its committed `branch.md`. A branch holding several new folders is listed for the first only.
fn new_folder_at(repo: &git::Repo, base: &str, tip: &str) -> Option<(String, Option<Vec<u8>>)> {
    for system in repo.folder_names_at(tip, "intent") {
        for change in repo.folder_names_at(tip, &format!("intent/{system}")) {
            let folder = format!("intent/{system}/{change}");
            if !is_change_name(&change) || repo.entry_at(base, &folder).ok().flatten().is_some() {
                continue;
            }
            let record = repo
                .bytes_at(tip, &format!("{folder}/branch.md"))
                .ok()
                .flatten();
            return Some((change, record));
        }
    }
    None
}

/// The local branches other than the current one that hold a change, read from their tips without
/// checking anything out. `change/<folder>` names list as that folder; any other name lists when a new
/// change's committed `branch.md` names exactly that branch.
pub fn other_change_branches(master: &Path) -> Vec<OtherBranch> {
    let Ok(repo) = git::Repo::open(master) else {
        return Vec::new();
    };
    let current = repo.current_branch();
    let base = diff::base_branch(master).and_then(|b| diff::compare_ref(master, &b));
    let mut found = Vec::new();
    for name in repo.local_branches() {
        if Some(name.as_str()) == current.as_deref() {
            continue;
        }
        // A `change/pending-*` branch is one an older Kata made before a change was named; it is not a change.
        if let Some(folder) = name
            .strip_prefix("change/")
            .filter(|f| !f.starts_with("pending-"))
        {
            found.push(OtherBranch {
                branch: name.clone(),
                change: folder.to_string(),
            });
            continue;
        }
        let Some(base) = base.as_deref() else {
            continue;
        };
        let Some((change, record)) = new_folder_at(&repo, base, &name) else {
            continue;
        };
        if record
            .and_then(|bytes| frontmatter::field(&String::from_utf8_lossy(&bytes), "branch"))
            .as_deref()
            == Some(name.as_str())
        {
            found.push(OtherBranch {
                branch: name,
                change,
            });
        }
    }
    found
}

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
    #[error("`{branch}` is held by the copy of `{change}`; open that change instead.")]
    HeldByCopy { branch: String, change: String },
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

/// Switch branches. Refuses a dirty working tree.
pub fn checkout(master: &Path, branch: &str) -> Result<(), BranchError> {
    require_local_branch(master, branch)?;
    ensure_clean(master)?;
    git::Repo::open(master)?.checkout_branch(branch)?;
    Ok(())
}

/// The commit each repository's recorded change branch points at. A repository without that
/// branch (one the build never changed) is left out.
pub fn heads(
    folder: &Path,
    master: &Path,
    master_repo: &str,
    system: &str,
    repos: &[String],
    change: &str,
) -> Result<BTreeMap<String, String>, String> {
    if !is_change_name(change) {
        return Err(format!("invalid change name: {change}"));
    }
    // An empty master or system (a caller that has neither yet) reads no record.
    if (!master_repo.is_empty() && !is_safe_system(master_repo))
        || (!system.is_empty() && !is_safe_system(system))
    {
        return Err(format!(
            "invalid master repository or system name: {master_repo}, {system}"
        ));
    }
    let branch = change_branch(master, system, change)?;
    let mut out = BTreeMap::new();
    for repo in repos {
        if !is_safe_system(repo) {
            return Err(format!("invalid repository name: {repo}"));
        }
        let path = folder.join(repo);
        if !branch_exists(&path, &branch) {
            continue;
        }
        let head = git::Repo::open(&path)
            .and_then(|r| r.resolve(&format!("refs/heads/{branch}")))
            .map_err(|e| e.to_string())?;
        out.insert(repo.clone(), head);
    }
    Ok(out)
}

/// The product repositories the plan names that lack the change's recorded branch (`change/<change>`
/// when it has no record). No other name is searched for. The Changes view lists only repositories with
/// that branch, so it names these rather than leaving them out without a word. A repository the plan
/// names that is not a valid name, not in the system or not checked out is refused, unless all its tasks
/// are done: then it needs nothing from this workspace and is left out.
pub fn missing_change_branches(
    plugin: &Path,
    folder: &Path,
    master: &Path,
    master_repo: &str,
    system: &str,
    change: &str,
) -> Result<Vec<String>, String> {
    if !is_safe_system(master_repo) || !is_safe_system(system) || !is_change_name(change) {
        return Err(format!(
            "invalid master repository, system or change name: {master_repo}, {system}, {change}"
        ));
    }
    let branch = change_branch(master, system, change)?;
    let status = build::status(plugin, master, system, change).map_err(|e| e.to_string())?;
    let scan = workspace::scan(folder).map_err(|e| e.to_string())?;
    let in_system = system_repos(&scan, system);
    let mut out = Vec::new();
    for planned in status.repos.iter().filter(|r| r.repo != master_repo) {
        let name = planned.repo.as_str();
        let problem = if !is_safe_system(name) {
            Some("which is not a valid repository name".to_string())
        } else if !in_system.iter().any(|r| r == name) {
            Some(format!("which is not in system {system}"))
        } else if !scan.repos.iter().any(|r| r == name) {
            Some("which is not checked out in this workspace".to_string())
        } else {
            None
        };
        match problem {
            Some(_) if planned.state == RepoState::Done => {}
            Some(why) => return Err(format!("the plan names {name}, {why}")),
            None if !branch_exists(&folder.join(name), &branch) => out.push(name.to_string()),
            None => {}
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    const S: &str = "s";
    const C: &str = "2026-10-19-c";
    const OWN: &str = "feat(s): own work\n\nGenerated-By: ai-sdlc";
    const RECORDED: &str = "feat/PROJ-123-password-reset";

    struct Fx {
        _dir: tempfile::TempDir,
        folder: std::path::PathBuf,
        master: std::path::PathBuf,
    }

    impl Fx {
        fn repo(&self, name: &str) -> std::path::PathBuf {
            self.folder.join(name)
        }
    }

    fn plan(tasks: &[(&str, &str)]) -> String {
        let mut out = String::from("---\nstatus: accepted\n---\n\n# Plan: c\n\n## Tasks\n\n");
        for (id, repo) in tasks {
            out.push_str(&format!(
                "### {id}: Do {id} (`{repo}`)\n\n- **Depends on:** none\n- **Change:** x\n\n"
            ));
        }
        out
    }

    /// Master `m` on `change/<C>` holding the marker and an accepted plan; the repos in
    /// `checked_out` exist beside it.
    fn fixture_with(tasks: &[(&str, &str)], marker: &[&str], checked_out: &[&str]) -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_path_buf();
        let master = testutil::repo(&folder, "m");
        let repos = marker
            .iter()
            .map(|r| format!("\"{r}\""))
            .collect::<Vec<_>>()
            .join(",");
        testutil::commit_file(
            &master,
            ".ai-sdlc.json",
            &format!("{{\"version\":1,\"systems\":{{\"{S}\":{{\"repos\":[{repos}]}}}}}}"),
            "marker",
        );
        testutil::checkout(&master, &format!("change/{C}"), true);
        testutil::commit_file(
            &master,
            &format!("intent/{S}/{C}/plan.md"),
            &plan(tasks),
            "plan",
        );
        for r in checked_out {
            testutil::repo(&folder, r);
        }
        Fx {
            _dir: dir,
            folder,
            master,
        }
    }

    fn fixture() -> Fx {
        fixture_with(
            &[("T1", "app"), ("T2", "api"), ("T3", "m")],
            &["app", "api"],
            &["app", "api"],
        )
    }

    fn missing(fx: &Fx) -> Result<Vec<String>, String> {
        missing_change_branches(testutil::plugin_dir(), &fx.folder, &fx.master, "m", S, C)
    }

    /// Commit a `branch.md` naming `branch` on the master and put the master on that branch.
    fn record_on_master(fx: &Fx, branch: &str) {
        testutil::commit_file(
            &fx.master,
            &format!("intent/{S}/{C}/branch.md"),
            &format!("---\nbranch: {branch}\ntype: feat\n---\n\nKata writes this file.\n"),
            "name branch",
        );
        testutil::checkout(&fx.master, branch, true);
    }

    #[test]
    fn missing_change_branches_names_each_product_repo_without_the_change_branch() {
        let fx = fixture();
        testutil::checkout(&fx.repo("app"), &format!("change/{C}"), true);
        // The master is never named: it holds the change's documents whatever branch it is on.
        assert_eq!(missing(&fx).unwrap(), ["api"]);
        testutil::checkout(&fx.repo("api"), &format!("change/{C}"), true);
        assert!(missing(&fx).unwrap().is_empty());
    }

    #[test]
    fn a_finished_repo_that_is_not_checked_out_is_skipped_and_an_unfinished_one_refused_r2_4() {
        let fx = fixture_with(&[("T1", "app"), ("T2", "api")], &["app", "api"], &["app"]);
        let refused = missing(&fx).unwrap_err();
        assert_eq!(
            refused,
            "the plan names api, which is not checked out in this workspace"
        );
        testutil::commit_file(
            &fx.master,
            &format!("intent/{S}/{C}/build/api.md"),
            "# Build log: api\n\n| Task | Commits | Departure |\n|---|---|---|\n| T2 | `abc1234` | none |\n",
            "log",
        );
        assert_eq!(missing(&fx).unwrap(), ["app"]);
    }

    #[test]
    fn heads_reads_each_change_branch() {
        let fx = fixture();
        for r in ["app", "api"] {
            testutil::checkout(&fx.repo(r), &format!("change/{C}"), true);
        }
        testutil::commit_msg(&fx.repo("app"), "a.txt", "a\n", OWN);
        let got = heads(
            &fx.folder,
            &fx.master,
            "m",
            S,
            &["app".into(), "api".into()],
            C,
        )
        .unwrap();
        for r in ["app", "api"] {
            let want = git::run(&fx.repo(r), &["rev-parse", &format!("change/{C}")]).unwrap();
            assert_eq!(got[r], want);
        }
        assert_ne!(got["app"], got["api"]);
        assert!(heads(&fx.folder, &fx.master, "m", S, &["../x".into()], C).is_err());
    }

    #[test]
    fn heads_skips_repos_without_the_branch() {
        let fx = fixture();
        testutil::checkout(&fx.repo("app"), &format!("change/{C}"), true);
        let got = heads(
            &fx.folder,
            &fx.master,
            "m",
            S,
            &["app".into(), "api".into()],
            C,
        )
        .unwrap();
        assert_eq!(got.keys().collect::<Vec<_>>(), ["app"]);
    }

    #[test]
    fn resolver_reads_record_else_change_folder_r8_1() {
        let fx = fixture();
        let want = |c: &str| change_branch(&fx.master, S, c).unwrap();
        assert_eq!(
            want("2026-10-19-photo-upload"),
            "change/2026-10-19-photo-upload"
        );
        testutil::commit_file(
            &fx.master,
            &format!("intent/{S}/2026-11-02-password-reset/branch.md"),
            &format!("---\nbranch: {RECORDED}\n---\n\nKata writes this file.\n"),
            "name branch",
        );
        assert_eq!(want("2026-11-02-password-reset"), RECORDED);
    }

    #[test]
    fn every_consumer_uses_the_recorded_branch_r7_1() {
        let fx = fixture();
        record_on_master(&fx, RECORDED);
        for r in ["app", "api"] {
            // A `change/<C>` branch at the base, the name a wrong consumer would look for.
            git::run(&fx.repo(r), &["branch", &format!("change/{C}"), "main"]).unwrap();
            testutil::checkout(&fx.repo(r), RECORDED, true);
        }
        testutil::commit_msg(&fx.repo("app"), "a.txt", "a\n", OWN);
        let decoy = git::run(&fx.repo("app"), &["rev-parse", &format!("change/{C}")]).unwrap();
        let got = heads(
            &fx.folder,
            &fx.master,
            "m",
            S,
            &["app".into(), "api".into()],
            C,
        )
        .unwrap();
        let want = git::run(&fx.repo("app"), &["rev-parse", RECORDED]).unwrap();
        assert_eq!(got["app"], want);
        assert_ne!(got["app"], decoy);
        assert!(missing(&fx).unwrap().is_empty());
    }

    #[test]
    fn renamed_by_hand_is_reported_missing_not_searched_r8_3() {
        let fx = fixture();
        record_on_master(&fx, RECORDED);
        for r in ["app", "api"] {
            testutil::checkout(&fx.repo(r), RECORDED, true);
        }
        git::run(
            &fx.repo("app"),
            &["branch", "-m", RECORDED, "feat/PROJ-123-other"],
        )
        .unwrap();
        assert_eq!(missing(&fx).unwrap(), ["app"]);
    }

    #[test]
    fn base_branch_is_never_the_current_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        assert_eq!(diff::base_branch(&repo).as_deref(), Some("main"));

        git::run(&repo, &["branch", "-m", "main", "master"]).unwrap();
        assert_eq!(diff::base_branch(&repo).as_deref(), Some("master"));

        git::run(&repo, &["branch", "-m", "master", "trunk"]).unwrap();
        assert_eq!(diff::base_branch(&repo), None);
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
    #[test]
    fn branches() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        for b in ["change/a", "change/b", "change/pending-20261018T000000Z"] {
            git::run(&repo, &["branch", b]).unwrap();
        }
        git::run(&repo, &["checkout", "-q", "change/a"]).unwrap();
        assert_eq!(current_branch(&repo).as_deref(), Some("change/a"));
        assert_eq!(
            other_change_branches(&repo),
            [OtherBranch {
                branch: "change/b".into(),
                change: "b".into(),
            }]
        );
        let info = branch_info(&repo);
        assert_eq!(info.default_base.as_deref(), Some("main"));
    }

    const NAMED_S: &str = r#"{"version":1,"systems":{"s":{"repos":["m"],"naming":{"branch":"{type}/{slug}","pullRequestTitle":"{title}"}},"u":{"repos":["m"]}}}"#;

    /// Create `name` from `main` holding `files`, then return to `main`.
    fn branch_holding(repo: &Path, name: &str, files: &[(&str, &str)]) {
        git::run(repo, &["checkout", "-q", "-b", name, "main"]).unwrap();
        for (rel, text) in files {
            testutil::commit_file(repo, rel, text, "tip");
        }
        git::run(repo, &["checkout", "-q", "main"]).unwrap();
    }

    fn other(branch: &str, change: &str) -> OtherBranch {
        OtherBranch {
            branch: branch.into(),
            change: change.into(),
        }
    }

    #[test]
    fn listing_includes_named_branch_whose_record_names_it_r7_3() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        testutil::commit_file(&repo, ".ai-sdlc.json", NAMED_S, "marker");
        branch_holding(
            &repo,
            "feat/PROJ-123-password-reset",
            &[
                ("intent/s/2026-11-02-password-reset/intent.md", "x\n"),
                (
                    "intent/s/2026-11-02-password-reset/branch.md",
                    "---\nbranch: feat/PROJ-123-password-reset\n---\n",
                ),
            ],
        );
        assert_eq!(current_branch(&repo).as_deref(), Some("main"));
        assert_eq!(
            other_change_branches(&repo),
            [other(
                "feat/PROJ-123-password-reset",
                "2026-11-02-password-reset"
            )]
        );
    }

    #[test]
    fn listing_follows_the_table() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        testutil::commit_file(&repo, ".ai-sdlc.json", NAMED_S, "marker");
        // Row 1: a plain change branch, whatever its tip holds.
        branch_holding(&repo, "change/2026-11-01-a", &[]);
        // Row 2: a pending branch an older Kata made, holding a new change without a record, is not listed.
        branch_holding(
            &repo,
            "change/pending-20261102T000000Z",
            &[("intent/s/2026-11-02-b/intent.md", "x\n")],
        );
        // Row 3: the system declares no naming.
        branch_holding(
            &repo,
            "change/pending-20261102T000001Z",
            &[("intent/u/2026-11-02-u/intent.md", "x\n")],
        );
        // Row 3: the change already has a record.
        branch_holding(
            &repo,
            "change/pending-20261102T000002Z",
            &[
                ("intent/s/2026-11-02-r/intent.md", "x\n"),
                (
                    "intent/s/2026-11-02-r/branch.md",
                    "---\nbranch: feat/r\n---\n",
                ),
            ],
        );
        // Row 3: a pending branch holding nothing.
        branch_holding(&repo, "change/pending-20261102T000003Z", &[]);
        // Row 4: another name whose record names exactly it.
        branch_holding(
            &repo,
            "feat/c",
            &[
                ("intent/s/2026-11-03-c/intent.md", "x\n"),
                (
                    "intent/s/2026-11-03-c/branch.md",
                    "---\nbranch: feat/c\n---\n",
                ),
            ],
        );
        // Row 5: another name whose record names a different branch, and one with no change.
        branch_holding(
            &repo,
            "wip/d",
            &[
                ("intent/s/2026-11-04-d/intent.md", "x\n"),
                (
                    "intent/s/2026-11-04-d/branch.md",
                    "---\nbranch: feat/other\n---\n",
                ),
            ],
        );
        branch_holding(&repo, "wip/e", &[]);
        assert_eq!(
            other_change_branches(&repo),
            [
                other("change/2026-11-01-a", "2026-11-01-a"),
                other("feat/c", "2026-11-03-c"),
            ]
        );
    }

    #[test]
    fn detached_head_has_no_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        git::run(&repo, &["checkout", "-q", "--detach"]).unwrap();
        assert_eq!(current_branch(&repo), None);
    }

    #[test]
    fn unborn_head_has_no_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("u");
        std::fs::create_dir_all(&repo).unwrap();
        git::run(&repo, &["init", "-q", "-b", "main"]).unwrap();
        assert_eq!(current_branch(&repo), None);
        assert_eq!(diff::base_branch(&repo), None);
        assert!(other_change_branches(&repo).is_empty());
    }

    #[test]
    fn the_change_branch_is_the_plugins_record_then_the_older_one_then_the_default() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("intent/kata/2026-11-01-c");
        std::fs::create_dir_all(&dir).unwrap();
        let branch = || change_branch(tmp.path(), "kata", "2026-11-01-c");
        assert_eq!(branch().unwrap(), "change/2026-11-01-c");
        std::fs::write(
            dir.join("branch.md"),
            "---
branch: feat/old
type: fix
---
",
        )
        .unwrap();
        assert_eq!(branch().unwrap(), "feat/old");
        std::fs::write(
            dir.join("change.yml"),
            "version: 1
branch: \"feat/X-1-new\"
type: feat
scope: \"X-1\"
base: \"main\"
",
        )
        .unwrap();
        assert_eq!(branch().unwrap(), "feat/X-1-new");
        std::fs::write(
            dir.join("change.yml"),
            "branch: \"--bad\"
",
        )
        .unwrap();
        assert!(branch().unwrap_err().contains("not a usable branch name"));
    }
}

#[cfg(test)]
mod copy_tests {
    use super::*;
    use crate::testutil;

    #[test]
    fn heads_reads_the_branch_recorded_in_the_copy() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_path_buf();
        let master = testutil::repo(&folder, "m");
        let app = testutil::repo(&folder, "app");
        let change = "2026-11-02-c";
        // The decoy a reader of the checkout would look for.
        git::run(&app, &["branch", &format!("change/{change}"), "main"]).unwrap();
        testutil::checkout(&app, "feat/x", true);
        testutil::commit_file(&app, "a.txt", "a\n", "work");
        let copy = folder.join(".ai-sdlc").join("copies").join(change);
        std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
        git::run(
            &master,
            &["worktree", "add", "-b", "feat/x", &copy.to_string_lossy()],
        )
        .unwrap();
        testutil::commit_file(
            &copy,
            &format!("intent/s/{change}/change.yml"),
            "branch: \"feat/x\"\n",
            "record",
        );
        let got = heads(&folder, &copy, "m", "s", &["app".into()], change).unwrap();
        let want = git::run(&app, &["rev-parse", "feat/x"]).unwrap();
        assert_eq!(got["app"], want);
    }

    /// A master with `change/a` checked out in a copy under `<ws>/.ai-sdlc/copies/a` and `change/b` only a branch.
    fn master_with_copy() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let master = testutil::repo(tmp.path(), "m");
        git::run(&master, &["branch", "change/b"]).unwrap();
        let copies = tmp.path().join(".ai-sdlc").join("copies");
        std::fs::create_dir_all(&copies).unwrap();
        let copy = copies.join("a");
        git::run(
            &master,
            &["worktree", "add", "-b", "change/a", &copy.to_string_lossy()],
        )
        .unwrap();
        (tmp, master)
    }

    #[test]
    fn other_change_branches_leave_out_branches_held_by_a_copy() {
        let (_tmp, master) = master_with_copy();
        assert_eq!(
            other_change_branches(&master),
            [OtherBranch {
                branch: "change/b".into(),
                change: "b".into(),
            }]
        );
    }

    #[test]
    fn checkout_refuses_a_branch_held_by_a_copy() {
        let (_tmp, master) = master_with_copy();
        let err = checkout(&master, "change/a").unwrap_err();
        assert!(
            matches!(&err, BranchError::HeldByCopy { branch, change } if branch == "change/a" && change == "a"),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "`change/a` is held by the copy of `a`; open that change instead."
        );
        assert_eq!(current_branch(&master).as_deref(), Some("main"));
    }

    #[test]
    fn checkout_switches_to_a_branch_no_copy_holds() {
        let (_tmp, master) = master_with_copy();
        checkout(&master, "change/b").unwrap();
        assert_eq!(current_branch(&master).as_deref(), Some("change/b"));
    }
}
