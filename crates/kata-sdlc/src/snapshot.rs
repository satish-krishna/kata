//! Run snapshot: what the master repo looked like before an agent run, and what the run left behind.
use crate::git::{self, GitError, Repo};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The master repo's state before a run. The frontend holds it between calls.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Snapshot {
    /// `HEAD` commit, `None` on an unborn branch.
    pub head: Option<String>,
    /// Dirty path to the SHA-1 of its working-tree content (empty for a deleted file).
    pub dirty: BTreeMap<String, String>,
}

/// What a run left behind, relative to its `Snapshot`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Leftovers {
    /// Subjects of commits made during the run, newest first.
    pub new_commits: Vec<String>,
    /// Paths that became dirty during the run and may be discarded.
    pub discardable: Vec<String>,
    /// Paths that were already dirty before the run and changed again during it.
    pub touched_dirty: Vec<String>,
    /// Build log rows the run wrote that were not unsaved before it. A row belongs to the repository it records, so this is never filled here: the Workbench fills it from the build's participants. Never discarded.
    pub created: Vec<String>,
    /// Folder names of product repos with uncommitted changes.
    pub product_repos_changed: Vec<String>,
    /// Folder names of product repos whose status could not be read.
    pub product_repos_unchecked: Vec<String>,
}

/// The change a build is for. Only a build log row of this system and change is build log data
/// to a run's leftovers; a run outside a build has no scope, so no path is a build log row.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildScope {
    pub system: String,
    pub change: String,
}

#[derive(Debug, thiserror::Error)]
pub enum DiscardError {
    #[error("not discardable: {0}")]
    NotDiscardable(String),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// One `git status` entry: the two-letter code and the repo-relative path.
pub(crate) struct Entry {
    pub(crate) xy: String,
    pub(crate) path: String,
}

/// Parse `git status --porcelain=v1 -uall -z`. A rename or copy yields its new path
/// (code kept) and its origin (reported as a deletion).
pub(crate) fn status_entries(dir: &Path) -> Result<Vec<Entry>, GitError> {
    let mut entries = Vec::new();
    for e in Repo::open(dir)?.status("")? {
        entries.push(Entry {
            xy: format!("{}{}", e.index, e.worktree),
            path: e.path,
        });
        if let Some(from) = e.from {
            entries.push(Entry {
                xy: " D".to_string(),
                path: from,
            });
        }
    }
    Ok(entries)
}

/// The repo-relative paths `git status` lists as uncommitted in `dir`.
pub(crate) fn dirty_files(dir: &Path) -> Result<Vec<String>, GitError> {
    Ok(status_entries(dir)?.into_iter().map(|e| e.path).collect())
}

/// The repository that owns a build log row (`intent/<system>/<change>/build/<repo>.md`) of this
/// change, or `None` for any other path. Rows are R6.6 data of the build they belong to: nothing
/// here may delete them, and no working tree's leftovers include one. `participants` reports a row
/// under the repository it names. Another change's row is an ordinary file of the master.
pub(crate) fn build_log_owner<'a>(path: &'a str, system: &str, change: &str) -> Option<&'a str> {
    let parts: Vec<&str> = path.split(['/', '\\']).collect();
    match parts.as_slice() {
        ["intent", s, c, "build", file] if *s == system && *c == change => {
            file.strip_suffix(".md").filter(|repo| !repo.is_empty())
        }
        _ => None,
    }
}

fn is_build_log(path: &str, build: Option<&BuildScope>) -> bool {
    build.is_some_and(|b| build_log_owner(path, &b.system, &b.change).is_some())
}

fn current_head(master: &Path) -> Option<String> {
    Repo::open(master).ok()?.head_sha().ok()
}

pub fn hash_of(master: &Path, path: &str) -> Result<String, GitError> {
    if master.join(path).is_file() {
        Repo::open(master)?.hash_file(path)
    } else {
        Ok(String::new())
    }
}

fn dirty_map(master: &Path) -> Result<BTreeMap<String, String>, GitError> {
    let mut dirty = BTreeMap::new();
    for e in status_entries(master)? {
        let hash = hash_of(master, &e.path)?;
        dirty.insert(e.path, hash);
    }
    Ok(dirty)
}

pub fn take(master: &Path) -> Result<Snapshot, GitError> {
    Ok(Snapshot {
        head: current_head(master),
        dirty: dirty_map(master)?,
    })
}

pub fn leftovers(
    master: &Path,
    before: &Snapshot,
    product_repos: &[PathBuf],
    build: Option<&BuildScope>,
) -> Result<Leftovers, GitError> {
    let subjects = |revs: &[String]| -> Result<Vec<String>, GitError> {
        Ok(Repo::open(master)?
            .log_messages(revs)?
            .iter()
            .map(|e| e.subject())
            .collect())
    };
    let new_commits = match (&before.head, current_head(master)) {
        (_, None) => Vec::new(),
        (Some(head), Some(_)) => subjects(&[format!("{head}..HEAD")])?,
        (None, Some(_)) => subjects(&["HEAD".to_string()])?,
    };

    let mut discardable = Vec::new();
    let mut touched_dirty = Vec::new();
    let now = dirty_map(master)?;
    for (path, hash) in &now {
        if is_build_log(path, build) {
            continue;
        }
        match before.dirty.get(path) {
            None => discardable.push(path.clone()),
            Some(old) if old != hash => touched_dirty.push(path.clone()),
            Some(_) => {}
        }
    }
    // A pre-dirty file that dropped out of the status list (reverted or recreated clean)
    // is still touched when its content differs from the snapshot.
    for (path, old) in &before.dirty {
        if !is_build_log(path, build)
            && !now.contains_key(path.as_str())
            && hash_of(master, path)? != *old
        {
            touched_dirty.push(path.clone());
        }
    }
    touched_dirty.sort();

    // One unreadable product repo must not hide the master leftovers.
    let mut product_repos_changed = Vec::new();
    let mut product_repos_unchecked = Vec::new();
    for repo in product_repos {
        let name = repo
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| repo.to_string_lossy().into_owned());
        match Repo::open(repo).and_then(|r| r.status("")) {
            Ok(out) if !out.is_empty() => product_repos_changed.push(name),
            Ok(_) => {}
            Err(_) => product_repos_unchecked.push(name),
        }
    }

    Ok(Leftovers {
        new_commits,
        discardable,
        touched_dirty,
        created: Vec::new(),
        product_repos_changed,
        product_repos_unchecked,
    })
}

/// Discard run leftovers. Every path must be dirty now and absent from `before.dirty`;
/// anything else refuses the whole call before touching the disk.
pub fn discard(
    master: &Path,
    before: &Snapshot,
    paths: &[String],
    build: Option<&BuildScope>,
) -> Result<(), DiscardError> {
    let entries = status_entries(master)?;
    let mut plan = Vec::new();
    for path in paths {
        if is_build_log(path, build) {
            return Err(DiscardError::NotDiscardable(path.clone()));
        }
        let entry = entries
            .iter()
            .find(|e| &e.path == path && !before.dirty.contains_key(&e.path))
            .ok_or_else(|| DiscardError::NotDiscardable(path.clone()))?;
        plan.push(entry);
    }
    for e in plan {
        if e.xy == "??" {
            std::fs::remove_file(master.join(&e.path))?;
        } else if e.xy.starts_with('A') || e.xy.starts_with('R') || e.xy.starts_with('C') {
            // Not in HEAD, so restore has nothing to restore from.
            git::legacy_cli::run(master, &["rm", "-f", "-q", "--", &e.path])?;
        } else {
            git::legacy_cli::run(
                master,
                &["restore", "--staged", "--worktree", "--", &e.path],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{commit_file, repo};

    #[test]
    fn leftovers_classify() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        std::fs::write(m.join("notes.md"), "n1").unwrap();
        std::fs::write(m.join("intent.md"), "i1").unwrap();
        let before = take(&m).unwrap();
        assert!(before.head.is_some());
        assert_eq!(before.dirty.len(), 2);

        std::fs::write(m.join("intent.md"), "i2").unwrap();
        std::fs::write(m.join("new.md"), "x").unwrap();
        commit_file(&m, "c.md", "c", "docs(claims): x");

        let l = leftovers(&m, &before, &[], None).unwrap();
        assert_eq!(l.discardable, vec!["new.md"]);
        assert_eq!(l.touched_dirty, vec!["intent.md"]);
        assert_eq!(l.new_commits, vec!["docs(claims): x"]);
        assert!(l.product_repos_changed.is_empty());
    }

    #[test]
    fn reverted_pre_dirty_file_is_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        commit_file(&m, "a.md", "orig", "add a");
        std::fs::write(m.join("a.md"), "mine").unwrap();
        let before = take(&m).unwrap();
        git::run(&m, &["checkout", "--", "a.md"]).unwrap();
        let l = leftovers(&m, &before, &[], None).unwrap();
        assert_eq!(l.touched_dirty, vec!["a.md"]);
        assert!(l.discardable.is_empty());
    }

    #[test]
    fn recreated_pre_dirty_deleted_file_is_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        commit_file(&m, "a.md", "orig", "add a");
        std::fs::remove_file(m.join("a.md")).unwrap();
        let before = take(&m).unwrap();
        assert_eq!(before.dirty["a.md"], "");
        std::fs::write(m.join("a.md"), "orig").unwrap();
        let l = leftovers(&m, &before, &[], None).unwrap();
        assert_eq!(l.touched_dirty, vec!["a.md"]);
    }

    #[test]
    fn product_repo_change_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        let svc = repo(tmp.path(), "svc");
        let other = repo(tmp.path(), "web");
        let before = take(&m).unwrap();
        std::fs::write(svc.join("dirty.txt"), "x").unwrap();
        let l = leftovers(&m, &before, &[svc, other], None).unwrap();
        assert_eq!(l.product_repos_changed, vec!["svc"]);
    }

    #[test]
    fn unreadable_product_repo_is_unchecked_not_fatal() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        let svc = repo(tmp.path(), "svc");
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let before = take(&m).unwrap();
        std::fs::write(m.join("new.md"), "x").unwrap();
        std::fs::write(svc.join("dirty.txt"), "x").unwrap();
        let l = leftovers(&m, &before, &[plain, svc], None).unwrap();
        assert_eq!(l.discardable, vec!["new.md"]);
        assert_eq!(l.product_repos_changed, vec!["svc"]);
        assert_eq!(l.product_repos_unchecked, vec!["plain"]);
    }

    #[test]
    fn unborn_head_snapshot_has_no_head_and_sees_all_commits() {
        let tmp = tempfile::tempdir().unwrap();
        let m = tmp.path().join("m");
        std::fs::create_dir_all(&m).unwrap();
        git::run(&m, &["init", "-q", "-b", "main"]).unwrap();
        git::run(&m, &["config", "user.name", "T"]).unwrap();
        git::run(&m, &["config", "user.email", "t@e.com"]).unwrap();
        git::run(&m, &["config", "commit.gpgsign", "false"]).unwrap();
        let before = take(&m).unwrap();
        assert_eq!(before.head, None);
        assert!(leftovers(&m, &before, &[], None)
            .unwrap()
            .new_commits
            .is_empty());
        commit_file(&m, "a.md", "a", "first");
        assert_eq!(
            leftovers(&m, &before, &[], None).unwrap().new_commits,
            vec!["first"]
        );
    }

    const OWN_ROW: &str = "intent/s/c/build/master.md";
    const OTHER_ROW: &str = "intent/s/c/build/api.md";
    const OTHER_CHANGE_ROW: &str = "intent/s/other-change/build/api.md";
    const OTHER_SYSTEM_ROW: &str = "intent/other-system/c/build/api.md";

    fn scope() -> BuildScope {
        BuildScope {
            system: "s".into(),
            change: "c".into(),
        }
    }

    fn write_rows(m: &Path) {
        for row in [OWN_ROW, OTHER_ROW, OTHER_CHANGE_ROW, OTHER_SYSTEM_ROW] {
            let path = m.join(row);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "row").unwrap();
        }
        std::fs::write(m.join("scratch.txt"), "x").unwrap();
    }

    #[test]
    fn leftovers_never_offer_this_change_s_build_log_row_for_discard() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        let before = take(&m).unwrap();
        write_rows(&m);
        let l = leftovers(&m, &before, &[], Some(&scope())).unwrap();
        // This change's rows are owned by their repository and reported through the build's
        // participants, never as the leftover of whichever working tree happens to hold the file.
        for row in [OWN_ROW, OTHER_ROW] {
            assert!(
                !l.discardable.iter().any(|p| p == row),
                "{:?}",
                l.discardable
            );
        }
        assert!(l.touched_dirty.is_empty(), "{:?}", l.touched_dirty);
    }

    #[test]
    fn leftovers_list_another_change_s_build_log_row_as_an_ordinary_file() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        let before = take(&m).unwrap();
        write_rows(&m);
        let l = leftovers(&m, &before, &[], Some(&scope())).unwrap();
        assert_eq!(
            l.discardable,
            vec![OTHER_SYSTEM_ROW, OTHER_CHANGE_ROW, "scratch.txt"]
        );
    }

    #[test]
    fn leftovers_see_no_build_log_row_outside_a_build() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        let before = take(&m).unwrap();
        write_rows(&m);
        let l = leftovers(&m, &before, &[], None).unwrap();
        assert_eq!(l.discardable.len(), 5, "{:?}", l.discardable);
    }

    #[test]
    fn discard_refuses_this_change_s_build_log_row_even_when_it_is_new_and_dirty() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        let before = take(&m).unwrap();
        write_rows(&m);
        for row in [OWN_ROW, OTHER_ROW] {
            let err = discard(
                &m,
                &before,
                &["scratch.txt".into(), row.into()],
                Some(&scope()),
            )
            .unwrap_err();
            assert!(matches!(err, DiscardError::NotDiscardable(p) if p == row));
            assert!(m.join(row).exists());
            assert!(m.join("scratch.txt").exists(), "nothing acted on");
        }
    }

    #[test]
    fn discard_treats_another_change_s_build_log_row_like_any_other_file() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        let before = take(&m).unwrap();
        write_rows(&m);
        discard(
            &m,
            &before,
            &[OTHER_CHANGE_ROW.into(), OTHER_SYSTEM_ROW.into()],
            Some(&scope()),
        )
        .unwrap();
        assert!(!m.join(OTHER_CHANGE_ROW).exists());
        assert!(!m.join(OTHER_SYSTEM_ROW).exists());
        assert!(m.join(OWN_ROW).exists() && m.join(OTHER_ROW).exists());
    }

    #[test]
    fn status_handles_spaces_unicode_and_renames() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        commit_file(&m, "old name.md", "o", "add");
        git::run(&m, &["mv", "old name.md", "new \u{e9}.md"]).unwrap();
        std::fs::write(m.join("sp ace.md"), "x").unwrap();
        let s = take(&m).unwrap();
        assert!(s.dirty.contains_key("new \u{e9}.md"), "{:?}", s.dirty);
        assert_eq!(s.dirty["old name.md"], "");
        assert!(s.dirty.contains_key("sp ace.md"));
        assert_eq!(s.dirty.len(), 3);
    }

    #[test]
    fn discard_restores_and_deletes() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        commit_file(&m, "a.md", "orig", "add a");
        let before = take(&m).unwrap();
        std::fs::write(m.join("a.md"), "changed").unwrap();
        std::fs::write(m.join("new.md"), "x").unwrap();
        std::fs::write(m.join("staged.md"), "s").unwrap();
        git::run(&m, &["add", "staged.md"]).unwrap();

        discard(
            &m,
            &before,
            &["new.md".into(), "a.md".into(), "staged.md".into()],
            None,
        )
        .unwrap();
        assert!(!m.join("new.md").exists());
        assert!(!m.join("staged.md").exists());
        assert_eq!(std::fs::read_to_string(m.join("a.md")).unwrap(), "orig");
        assert_eq!(git::run(&m, &["status", "--porcelain"]).unwrap(), "");
    }

    #[test]
    fn discard_refuses_pre_dirty_path() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        std::fs::write(m.join("notes.md"), "mine").unwrap();
        let before = take(&m).unwrap();
        let err = discard(&m, &before, &["notes.md".into()], None).unwrap_err();
        assert!(matches!(err, DiscardError::NotDiscardable(p) if p == "notes.md"));
        assert_eq!(std::fs::read_to_string(m.join("notes.md")).unwrap(), "mine");
    }

    #[test]
    fn discard_refuses_paths_outside_the_dirty_set_and_acts_on_none() {
        let tmp = tempfile::tempdir().unwrap();
        let m = repo(tmp.path(), "master");
        let before = take(&m).unwrap();
        std::fs::write(m.join("new.md"), "x").unwrap();
        for bad in ["README.md", "../outside.md", "missing.md", "/etc/passwd"] {
            let err = discard(&m, &before, &["new.md".into(), bad.into()], None).unwrap_err();
            assert!(matches!(err, DiscardError::NotDiscardable(p) if p == bad));
            assert!(m.join("new.md").exists(), "nothing acted on for {bad}");
        }
        std::fs::write(tmp.path().join("outside.md"), "keep").unwrap();
        assert!(discard(&m, &before, &["../outside.md".into()], None).is_err());
        assert!(tmp.path().join("outside.md").exists());
    }
}
