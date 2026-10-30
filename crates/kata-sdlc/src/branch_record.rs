//! The change's branch record: the one branch name a change uses in every repository it touches.
//!
//! The record lives in `intent/<system>/<change>/branch.md` of the master repository. A change that
//! has none uses `change/<change>`. This module reads and writes the record and checks a proposed
//! name against the branches already on the machine; it never fetches.
use crate::branch::current_branch;
use crate::naming::{self, NamingError};
use crate::plugin::Readiness;
use crate::snapshot::status_entries;
use crate::workspace::{self, ScanError};
use crate::{decide, frontmatter, git};
use std::path::{Path, PathBuf};

/// What `branch.md` holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchRecord {
    pub branch: String,
    pub work_type: Option<String>,
}

/// Whether a record is made for the first time or replaces an earlier one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordVerb {
    Name,
    Rename,
}

#[derive(Debug, thiserror::Error)]
pub enum RecordError {
    #[error("{0}")]
    Invalid(String),
    #[error("cannot read or write the branch record: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Git(String),
}

/// A branch already on the machine that a proposed name clashes with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clash {
    pub repo: String,
    pub existing: String,
}

const FIXED_TEXT: &str = "The branch this change uses in every repository it touches. Kata writes this file; rename the branch through Kata, not by editing it.";

fn record_rel(system: &str, change: &str) -> String {
    format!("intent/{system}/{change}/branch.md")
}

/// The branch the change uses: the recorded one, or `change/<change>` when it has no record.
/// A record that is present but unusable is `Invalid`, so a hand edit can never reach git.
pub fn change_branch(master: &Path, system: &str, change: &str) -> Result<String, RecordError> {
    let rel = record_rel(system, change);
    let text = match std::fs::read_to_string(master.join(&rel)) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(format!("change/{change}"));
        }
        Err(e) => return Err(e.into()),
    };
    let Some(branch) = frontmatter::field(&text, "branch").filter(|b| !b.is_empty()) else {
        return Err(RecordError::Invalid(format!("{rel} has no branch")));
    };
    if branch.starts_with('-') || !git2::Reference::is_valid_name(&format!("refs/heads/{branch}")) {
        return Err(RecordError::Invalid(format!(
            "{rel} names \"{branch}\", which is not a usable branch name"
        )));
    }
    Ok(branch)
}

/// Write `branch.md` and commit only it, with the change's scope and the `Generated-By` trailer.
pub fn write(
    master: &Path,
    system: &str,
    change: &str,
    record: &BranchRecord,
    verb: RecordVerb,
) -> Result<(), RecordError> {
    let rel = record_rel(system, change);
    let path = master.join(&rel);
    let mut text = format!("---\nbranch: {}\n", record.branch);
    if let Some(work_type) = &record.work_type {
        text.push_str(&format!("type: {work_type}\n"));
    }
    text.push_str(&format!("---\n\n{FIXED_TEXT}\n"));
    let before = std::fs::read(&path).ok();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &text)?;
    let verb = match verb {
        RecordVerb::Name => "name",
        RecordVerb::Rename => "rename",
    };
    let scope = decide::change_scope(master, system, change);
    let message = format!("docs({scope}): {verb} branch {change}\n\nGenerated-By: ai-sdlc");
    let committed = git::Repo::open(master).and_then(|repo| repo.commit_only(&rel, &message));
    if let Err(e) = committed {
        // Take back this call's write so a refused commit leaves the file as it was.
        let _ = match before {
            Some(bytes) => std::fs::write(&path, bytes),
            None => std::fs::remove_file(&path),
        };
        return Err(RecordError::Git(e.stderr));
    }
    Ok(())
}

fn folder_of(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    a.strip_prefix(&b).is_some_and(|r| r.starts_with('/'))
        || b.strip_prefix(&a).is_some_and(|r| r.starts_with('/'))
}

/// Whether `existing` clashes with `name`: identical, equal ignoring ASCII case, or one a
/// `/`-folder of the other. The change's own branch (`own`, compared exactly) never clashes.
fn clashes_with(existing: &str, name: &str, own: Option<&str>) -> bool {
    if own == Some(existing) {
        return false;
    }
    existing.eq_ignore_ascii_case(name) || folder_of(existing, name)
}

/// The branches on this machine that `name` clashes with, in the master and in every repository of
/// the system checked out in `folder`: local branches and remote-tracking branches already fetched.
/// Never fetches. `own` is the change's current branch, `None` at first naming.
pub fn clashes(
    folder: &Path,
    master_repo: &str,
    system: &str,
    name: &str,
    own: Option<&str>,
) -> Result<Vec<Clash>, ScanError> {
    let scan = workspace::scan(folder)?;
    let mut repos = vec![master_repo.to_string()];
    for repo in workspace::system_repos(&scan, system) {
        if !repos.contains(&repo) {
            repos.push(repo);
        }
    }
    let mut found = Vec::new();
    for repo in repos {
        let dir = folder.join(&repo);
        if !dir.join(".git").exists() {
            continue;
        }
        let Ok(opened) = git::Repo::open(&dir) else {
            continue;
        };
        let mut seen: Vec<String> = Vec::new();
        for existing in opened
            .local_branches()
            .into_iter()
            .chain(opened.remote_tracking_branches())
        {
            if clashes_with(&existing, name, own) && !seen.contains(&existing) {
                seen.push(existing.clone());
                found.push(Clash {
                    repo: repo.clone(),
                    existing,
                });
            }
        }
    }
    Ok(found)
}

/// What a rename did: the old and new names and the product repositories that had the branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameOutcome {
    pub old: String,
    pub new: String,
    pub repos: Vec<String>,
}

/// Why a rename was refused or failed. Every refusal happens before the first write.
#[derive(Debug, thiserror::Error)]
pub enum RenameError {
    #[error("the change already uses that branch name")]
    Same,
    #[error("invalid branch name: {0}")]
    InvalidName(String),
    #[error("the name clashes with a branch: {}", .0.iter().map(|c| format!("`{}` in `{}`", c.existing, c.repo)).collect::<Vec<_>>().join(", "))]
    Clashes(Vec<Clash>),
    #[error("`{repo}` has uncommitted changes: {}", .files.join(", "))]
    Dirty { repo: String, files: Vec<String> },
    #[error("{0}")]
    Record(String),
    #[error("{0}")]
    Git(String),
}

/// Make the local branch `name` again at `tip` without switching to it.
fn restore_branch(dir: &Path, name: &str, tip: &str) -> Result<(), git2::Error> {
    let repo = git2::Repository::open(dir)?;
    let commit = repo.find_commit(git2::Oid::from_str(tip)?)?;
    repo.branch(name, &commit, false).map(|_| ())
}

/// Rename the change's branch to `new_name` in the master and in every product repository of the
/// system that has it, and record the new name. Every check runs before the first write; a failed
/// step puts the renames already made back.
pub fn rename(
    plugin: &Readiness,
    folder: &Path,
    master_repo: &str,
    system: &str,
    change: &str,
    new_name: &str,
) -> Result<RenameOutcome, RenameError> {
    let master = folder.join(master_repo);
    let current =
        change_branch(&master, system, change).map_err(|e| RenameError::Record(e.to_string()))?;
    if new_name == current {
        return Err(RenameError::Same);
    }
    naming::check_branch_name(plugin, new_name).map_err(|e| match e {
        NamingError::Name(problem) => RenameError::InvalidName(problem),
        other => RenameError::Record(other.to_string()),
    })?;
    let found = clashes(folder, master_repo, system, new_name, Some(&current))
        .map_err(|e| RenameError::Record(e.to_string()))?;
    if !found.is_empty() {
        return Err(RenameError::Clashes(found));
    }

    let git_fail = |e: git::GitError| RenameError::Git(e.stderr);
    let master_git = git::Repo::open(&master).map_err(git_fail)?;
    if !master_git.branch_exists(&current) {
        return Err(RenameError::Record(format!(
            "the master repository `{master_repo}` has no branch `{current}` to rename"
        )));
    }
    let dirty = |repo: &str, dir: &Path| {
        let files: Vec<String> = status_entries(dir)
            .map_err(|e| RenameError::Git(e.to_string()))?
            .into_iter()
            .map(|e| e.path)
            .collect();
        if files.is_empty() {
            Ok(())
        } else {
            Err(RenameError::Dirty {
                repo: repo.to_string(),
                files,
            })
        }
    };
    dirty(master_repo, &master)?;
    let scan = workspace::scan(folder).map_err(|e| RenameError::Record(e.to_string()))?;
    let mut products: Vec<String> = Vec::new();
    for repo in workspace::system_repos(&scan, system) {
        let dir = folder.join(&repo);
        if repo == master_repo || products.contains(&repo) || !dir.join(".git").exists() {
            continue;
        }
        let Ok(opened) = git::Repo::open(&dir) else {
            continue;
        };
        if !opened.branch_exists(&current) {
            continue;
        }
        if current_branch(&dir).as_deref() == Some(current.as_str()) {
            dirty(&repo, &dir)?;
        }
        products.push(repo);
    }

    // Every check passed: the writes start here, and a failure puts the renames back.
    let original = current_branch(&master);
    // Each repository whose rename was tried, with the commit the old branch pointed at.
    let mut tried: Vec<(PathBuf, String)> = Vec::new();
    let mut checked_out = false;
    let old_ref = format!("refs/heads/{current}");
    let undo = |tried: &[(PathBuf, String)], checked_out: bool| {
        if checked_out {
            if let Some(original) = &original {
                let _ = git::Repo::open(&master).and_then(|r| r.checkout_branch(original));
            }
        }
        for (dir, tip) in tried.iter().rev() {
            let Ok(repo) = git::Repo::open(dir) else {
                continue;
            };
            if repo.branch_exists(new_name) {
                let _ = repo.rename_branch(new_name, &current);
            } else if !repo.branch_exists(&current) {
                // libgit2 drops the old ref before it writes the new one, so a rename that failed
                // in between leaves neither: make the old branch again where it was.
                let _ = restore_branch(dir, &current, tip);
            }
        }
    };
    let step = (|| -> Result<(), RenameError> {
        for repo in &products {
            let dir = folder.join(repo);
            let repo = git::Repo::open(&dir).map_err(git_fail)?;
            tried.push((dir, repo.resolve(&old_ref).map_err(git_fail)?));
            repo.rename_branch(&current, new_name).map_err(git_fail)?;
        }
        tried.push((
            master.clone(),
            master_git.resolve(&old_ref).map_err(git_fail)?,
        ));
        master_git
            .rename_branch(&current, new_name)
            .map_err(git_fail)?;
        if original.as_deref() != Some(new_name) && original.as_deref() != Some(current.as_str()) {
            master_git.checkout_branch(new_name).map_err(git_fail)?;
            checked_out = true;
        }
        // A change with no record gets one with no type.
        let work_type = std::fs::read_to_string(master.join(record_rel(system, change)))
            .ok()
            .and_then(|t| frontmatter::field(&t, "type"))
            .filter(|t| !t.is_empty());
        let record = BranchRecord {
            branch: new_name.to_string(),
            work_type,
        };
        write(&master, system, change, &record, RecordVerb::Rename).map_err(|e| match e {
            RecordError::Git(m) => RenameError::Git(m),
            other => RenameError::Record(other.to_string()),
        })
    })();
    if let Err(e) = step {
        undo(&tried, checked_out);
        return Err(e);
    }
    Ok(RenameOutcome {
        old: current,
        new: new_name.to_string(),
        repos: products,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{git, testutil};
    use std::path::PathBuf;

    const SYSTEM: &str = "kata";
    const CHANGE: &str = "2026-11-02-password-reset";

    /// A workspace folder with the master `ai-sdlc` and the product repository `kata`.
    fn workspace(tmp: &Path) -> (PathBuf, PathBuf) {
        let master = testutil::repo(tmp, "ai-sdlc");
        testutil::commit_file(
            &master,
            ".ai-sdlc.json",
            r#"{"version":1,"systems":{"kata":{"repos":["kata"]}}}"#,
            "marker",
        );
        let kata = testutil::repo(tmp, "kata");
        (master, kata)
    }

    fn local(repo: &Path, name: &str) {
        git::run(repo, &["branch", name]).unwrap();
    }

    fn remote(repo: &Path, name: &str) {
        let has_origin = git::run(repo, &["remote"]).unwrap().contains("origin");
        if !has_origin {
            git::run(repo, &["remote", "add", "origin", "/nowhere/origin.git"]).unwrap();
        }
        git::run(
            repo,
            &["update-ref", &format!("refs/remotes/origin/{name}"), "HEAD"],
        )
        .unwrap();
    }

    fn clash(repo: &str, existing: &str) -> Clash {
        Clash {
            repo: repo.to_string(),
            existing: existing.to_string(),
        }
    }

    /// One row of the table: the repository, whether the ref is remote-tracking, the existing name,
    /// the proposed name, the change's own branch, and the clash expected.
    type Case = (
        &'static str,
        &'static str,
        bool,
        &'static str,
        &'static str,
        Option<&'static str>,
        Option<(&'static str, &'static str)>,
    );

    #[test]
    fn clashes_follow_the_table_r6_3() {
        let cases: [Case; 17] = [
            // Row 1: the change's own branch, local or pushed, never a clash.
            (
                "1 local",
                "kata",
                false,
                "feat/a",
                "feat/a",
                Some("feat/a"),
                None,
            ),
            (
                "1 remote",
                "kata",
                true,
                "feat/a",
                "feat/a",
                Some("feat/a"),
                None,
            ),
            (
                "1 beats 3",
                "kata",
                false,
                "feat/a",
                "feat/A",
                Some("feat/a"),
                None,
            ),
            (
                "1 beats 7",
                "kata",
                true,
                "feat/a",
                "feat/a/b",
                Some("feat/a"),
                None,
            ),
            // Rows 2 to 4: local branches.
            (
                "2",
                "kata",
                false,
                "feat/a",
                "feat/a",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "3",
                "kata",
                false,
                "feat/a",
                "feat/A",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "4 existing is folder",
                "kata",
                false,
                "feat/a",
                "feat/a/b",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "4 name is folder",
                "kata",
                false,
                "feat/a/b",
                "feat/a",
                None,
                Some(("kata", "feat/a/b")),
            ),
            (
                "4 ignoring case",
                "kata",
                false,
                "feat/A",
                "feat/a/b",
                None,
                Some(("kata", "feat/A")),
            ),
            // Rows 5 to 7: remote-tracking branches, reported with the remote name stripped.
            (
                "5",
                "kata",
                true,
                "feat/a",
                "feat/a",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "6",
                "kata",
                true,
                "feat/a",
                "feat/A",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "7 existing is folder",
                "kata",
                true,
                "feat/a",
                "feat/a/b",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "7 name is folder",
                "kata",
                true,
                "feat/a/b",
                "feat/a",
                None,
                Some(("kata", "feat/a/b")),
            ),
            // Row 8: unrelated, including a shared prefix that is not a folder.
            ("8 unrelated", "kata", false, "feat/b", "feat/a", None, None),
            (
                "8 prefix only",
                "kata",
                true,
                "feat/a",
                "feat/ab",
                None,
                None,
            ),
            // The master is looked at too.
            (
                "master",
                "ai-sdlc",
                false,
                "feat/a",
                "feat/a",
                None,
                Some(("ai-sdlc", "feat/a")),
            ),
            // Row 1 compares exactly: a different case is not the change's own branch.
            (
                "own differs by case",
                "kata",
                false,
                "feat/A",
                "feat/a",
                Some("feat/a"),
                Some(("kata", "feat/A")),
            ),
        ];
        for (row, repo, is_remote, existing, name, own, expected) in cases {
            let tmp = tempfile::tempdir().unwrap();
            workspace(tmp.path());
            let path = tmp.path().join(repo);
            if is_remote {
                remote(&path, existing);
            } else {
                local(&path, existing);
            }
            let got = clashes(tmp.path(), "ai-sdlc", SYSTEM, name, own).unwrap();
            let want: Vec<Clash> = expected.map(|(r, e)| clash(r, e)).into_iter().collect();
            assert_eq!(got, want, "row {row}");
        }
    }

    #[test]
    fn clashes_cover_the_six_examples_of_r6_3() {
        // (repo, existing as created, remote-tracking, name, existing as reported)
        let examples = [
            (
                "ai-sdlc",
                "feat/PROJ-123-reset",
                false,
                "feat/PROJ-123-reset",
                "feat/PROJ-123-reset",
            ),
            (
                "kata",
                "feat/PROJ-123-reset",
                false,
                "feat/PROJ-123-reset",
                "feat/PROJ-123-reset",
            ),
            (
                "kata",
                "feat/proj-123-reset",
                false,
                "feat/PROJ-123-reset",
                "feat/proj-123-reset",
            ),
            (
                "kata",
                "feat/PROJ-123",
                false,
                "feat/PROJ-123/reset",
                "feat/PROJ-123",
            ),
            (
                "kata",
                "feat/PROJ-123/reset",
                false,
                "feat/PROJ-123",
                "feat/PROJ-123/reset",
            ),
            (
                "kata",
                "feat/PROJ-123-reset",
                true,
                "feat/PROJ-123-reset",
                "feat/PROJ-123-reset",
            ),
        ];
        for (repo, existing, is_remote, name, reported) in examples {
            let tmp = tempfile::tempdir().unwrap();
            workspace(tmp.path());
            let path = tmp.path().join(repo);
            if is_remote {
                remote(&path, existing);
            } else {
                local(&path, existing);
            }
            let got = clashes(tmp.path(), "ai-sdlc", SYSTEM, name, None).unwrap();
            assert_eq!(got, vec![clash(repo, reported)], "{repo} {existing} {name}");
        }
    }

    #[test]
    fn a_symbolic_remote_head_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, kata) = workspace(tmp.path());
        remote(&kata, "main");
        git::run(
            &kata,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .unwrap();
        let got = clashes(tmp.path(), "ai-sdlc", SYSTEM, "HEAD", None).unwrap();
        assert_eq!(got, vec![]);
    }

    #[test]
    fn clash_check_never_fetches_r6_4() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, kata) = workspace(tmp.path());
        testutil::bare_origin(&kata, None);
        // A teammate pushed after this clone last fetched: origin has it, the clone does not know.
        local(&kata, "feat/PROJ-123-reset");
        git::run(&kata, &["push", "-q", "origin", "feat/PROJ-123-reset"]).unwrap();
        git::run(&kata, &["branch", "-D", "feat/PROJ-123-reset"]).unwrap();
        git::run(
            &kata,
            &[
                "update-ref",
                "-d",
                "refs/remotes/origin/feat/PROJ-123-reset",
            ],
        )
        .unwrap();
        let refs = || git::run(&kata, &["for-each-ref", "refs/remotes"]).unwrap();
        let before = refs();
        let got = clashes(tmp.path(), "ai-sdlc", SYSTEM, "feat/PROJ-123-reset", None).unwrap();
        assert_eq!(got, vec![]);
        assert_eq!(refs(), before);
    }

    const OLD: &str = "feat/PROJ-123-reset";
    const NEW: &str = "feat/PROJ-123-password-reset";

    fn ready() -> Readiness {
        Readiness::Ready {
            dir: testutil::plugin_dir().to_path_buf(),
            version: crate::plugin::NAMING_VERSION.to_string(),
            layouts: crate::format::ACCEPTED_LAYOUTS.to_vec(),
            light_track: true,
            naming: crate::plugin::naming(crate::plugin::NAMING_VERSION),
        }
    }

    /// Master `ai-sdlc` and `kata` on `OLD` with the record committed; `api` has no change branch.
    fn renamable(tmp: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let master = testutil::repo(tmp, "ai-sdlc");
        testutil::commit_file(
            &master,
            ".ai-sdlc.json",
            r#"{"version":1,"systems":{"kata":{"repos":["kata","api"]}}}"#,
            "marker",
        );
        testutil::commit_file(
            &master,
            &format!("intent/{SYSTEM}/{CHANGE}/intent.md"),
            "---\nstatus: accepted\nscope: PROJ-123\n---\nbody\n",
            "intent",
        );
        testutil::checkout(&master, OLD, true);
        let record = BranchRecord {
            branch: OLD.to_string(),
            work_type: Some("feat".to_string()),
        };
        write(&master, SYSTEM, CHANGE, &record, RecordVerb::Name).unwrap();
        let kata = testutil::repo(tmp, "kata");
        testutil::checkout(&kata, OLD, true);
        let api = testutil::repo(tmp, "api");
        (master, kata, api)
    }

    fn refs(repos: &[&Path]) -> Vec<String> {
        repos
            .iter()
            .map(|r| git::run(r, &["for-each-ref", "--format=%(refname) %(objectname)"]).unwrap())
            .collect()
    }

    fn branch_of(repo: &Path) -> String {
        git::run(repo, &["branch", "--show-current"]).unwrap()
    }

    #[test]
    fn rename_moves_every_repo_and_the_record_r9_2() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, kata, api) = renamable(tmp.path());
        let api_refs = refs(&[&api]);
        let out = rename(&ready(), tmp.path(), "ai-sdlc", SYSTEM, CHANGE, NEW).unwrap();
        assert_eq!(
            out,
            RenameOutcome {
                old: OLD.into(),
                new: NEW.into(),
                repos: vec!["kata".into()],
            }
        );
        assert_eq!(branch_of(&master), NEW);
        assert_eq!(branch_of(&kata), NEW);
        for repo in [&master, &kata] {
            assert!(!git::Repo::open(repo).unwrap().branch_exists(OLD));
        }
        assert_eq!(refs(&[&api]), api_refs);
        let subject = git::run(&master, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(subject, format!("docs(PROJ-123): rename branch {CHANGE}"));
        assert_eq!(change_branch(&master, SYSTEM, CHANGE).unwrap(), NEW);
        let text =
            std::fs::read_to_string(master.join(format!("intent/{SYSTEM}/{CHANGE}/branch.md")))
                .unwrap();
        assert!(text.contains("type: feat\n"), "{text}");
    }

    #[test]
    fn rename_checks_out_the_new_name_in_a_master_that_was_elsewhere() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, _, _) = renamable(tmp.path());
        // The record is read from the working tree, so the other branch must carry it too.
        testutil::checkout(&master, "elsewhere", true);
        rename(&ready(), tmp.path(), "ai-sdlc", SYSTEM, CHANGE, NEW).unwrap();
        assert_eq!(branch_of(&master), NEW);
        assert_eq!(change_branch(&master, SYSTEM, CHANGE).unwrap(), NEW);
    }

    #[test]
    fn rename_refuses_before_touching_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, kata, api) = renamable(tmp.path());
        let all = [master.as_path(), kata.as_path(), api.as_path()];
        let before = refs(&all);
        let head = git::run(&master, &["rev-parse", "HEAD"]).unwrap();
        let go = |name: &str| rename(&ready(), tmp.path(), "ai-sdlc", SYSTEM, CHANGE, name);

        assert!(matches!(go(OLD), Err(RenameError::Same)));
        assert!(matches!(go("feat/a b"), Err(RenameError::InvalidName(_))));

        local(&api, NEW);
        let with_clash = refs(&all);
        assert!(matches!(go(NEW), Err(RenameError::Clashes(c)) if c == vec![clash("api", NEW)]));
        assert_eq!(refs(&all), with_clash);
        git::run(&api, &["branch", "-D", NEW]).unwrap();

        testutil::write(&master, "README.md", "edited\n");
        assert!(matches!(go(NEW), Err(RenameError::Dirty { repo, .. }) if repo == "ai-sdlc"));
        testutil::write(&master, "README.md", "init\n");

        testutil::write(&kata, "README.md", "edited\n");
        assert!(matches!(go(NEW), Err(RenameError::Dirty { repo, .. }) if repo == "kata"));
        testutil::write(&kata, "README.md", "init\n");

        assert_eq!(refs(&all), before);
        assert_eq!(git::run(&master, &["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(change_branch(&master, SYSTEM, CHANGE).unwrap(), OLD);
    }

    #[test]
    fn a_dirty_product_repo_not_on_the_branch_does_not_refuse() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, kata, _) = renamable(tmp.path());
        testutil::checkout(&kata, "main", false);
        testutil::write(&kata, "README.md", "edited\n");
        let out = rename(&ready(), tmp.path(), "ai-sdlc", SYSTEM, CHANGE, NEW).unwrap();
        assert_eq!(out.repos, vec!["kata".to_string()]);
        assert_eq!(branch_of(&kata), "main");
    }

    #[test]
    fn rename_rolls_back_on_a_failed_step() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, kata, _) = renamable(tmp.path());
        // A leftover lock on the new ref makes the master's rename fail after kata's succeeded.
        let lock = master.join(format!(".git/refs/heads/{NEW}.lock"));
        std::fs::write(&lock, "").unwrap();
        let before = refs(&[&master, &kata]);
        let err = rename(&ready(), tmp.path(), "ai-sdlc", SYSTEM, CHANGE, NEW).unwrap_err();
        assert!(matches!(err, RenameError::Git(_)), "{err}");
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(refs(&[&master, &kata]), before);
        assert_eq!(branch_of(&kata), OLD);
        assert_eq!(branch_of(&master), OLD);
        assert_eq!(change_branch(&master, SYSTEM, CHANGE).unwrap(), OLD);
    }

    #[test]
    fn absent_record_gives_the_default_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, _) = workspace(tmp.path());
        assert_eq!(
            change_branch(&master, SYSTEM, CHANGE).unwrap(),
            format!("change/{CHANGE}")
        );
    }

    #[test]
    fn record_round_trips_and_commits_with_the_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, _) = workspace(tmp.path());
        testutil::commit_file(
            &master,
            &format!("intent/{SYSTEM}/{CHANGE}/intent.md"),
            "---\nstatus: accepted\nscope: PROJ-123\n---\nbody\n",
            "intent",
        );
        // Another staged file must stay out of the commit.
        testutil::write(&master, "other.txt", "x\n");
        testutil::stage(&master, "other.txt");
        let record = BranchRecord {
            branch: "feat/PROJ-123-password-reset".to_string(),
            work_type: Some("feat".to_string()),
        };
        write(&master, SYSTEM, CHANGE, &record, RecordVerb::Name).unwrap();
        assert_eq!(
            change_branch(&master, SYSTEM, CHANGE).unwrap(),
            "feat/PROJ-123-password-reset"
        );
        let text =
            std::fs::read_to_string(master.join(format!("intent/{SYSTEM}/{CHANGE}/branch.md")))
                .unwrap();
        assert!(text.starts_with(
            "---\nbranch: feat/PROJ-123-password-reset\ntype: feat\n---\n\nThe branch this change uses in every repository it touches. Kata writes this file; rename the branch through Kata, not by editing it.\n"
        ), "{text}");
        let message = git::run(&master, &["log", "-1", "--format=%B"]).unwrap();
        let message = message.trim_end();
        assert_eq!(
            message,
            format!("docs(PROJ-123): name branch {CHANGE}\n\nGenerated-By: ai-sdlc")
        );
        let files = git::run(&master, &["show", "--name-only", "--format=", "HEAD"]).unwrap();
        assert_eq!(files, format!("intent/{SYSTEM}/{CHANGE}/branch.md"));

        let renamed = BranchRecord {
            branch: "feat/PROJ-123-reset".to_string(),
            work_type: None,
        };
        write(&master, SYSTEM, CHANGE, &renamed, RecordVerb::Rename).unwrap();
        let subject = git::run(&master, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(subject, format!("docs(PROJ-123): rename branch {CHANGE}"));
        assert_eq!(
            change_branch(&master, SYSTEM, CHANGE).unwrap(),
            "feat/PROJ-123-reset"
        );
    }

    #[test]
    fn invalid_record_is_refused() {
        let rel = format!("intent/{SYSTEM}/{CHANGE}/branch.md");
        let bodies = [
            "---\nbranch: -D\n---\n\ntext\n",
            "---\ntype: feat\n---\n\ntext\n",
            "---\nbranch: feat/a..b\n---\n\ntext\n",
            "---\nbranch: \"\"\n---\n\ntext\n",
        ];
        for body in bodies {
            let tmp = tempfile::tempdir().unwrap();
            let (master, _) = workspace(tmp.path());
            testutil::write(&master, &rel, body);
            match change_branch(&master, SYSTEM, CHANGE) {
                Err(RecordError::Invalid(msg)) => assert!(msg.contains("branch.md"), "{msg}"),
                other => panic!("{body:?} gave {other:?}"),
            }
        }
    }
}
