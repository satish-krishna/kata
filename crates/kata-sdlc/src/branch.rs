use crate::branch_record::{self, BranchRecord, RecordVerb};
use crate::changes::is_change_name;
use crate::git::{self, GitError};
use crate::naming::{self, NamingError};
use crate::plugin::Readiness;
use crate::snapshot::status_entries;
use std::collections::BTreeSet;
use std::path::Path;

/// The prefix of the temporary branch a change has before it is named. Kata treats any branch
/// starting with it as an unnamed change, so no change may be recorded under it.
pub(crate) const PENDING_PREFIX: &str = "change/pending-";

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
    #[error("{0}")]
    Record(String),
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
    Renamed {
        branch: String,
        change: String,
    },
    Deleted,
    /// The system declares a naming setting: the pending branch stays checked out until the engineer
    /// confirms a name through `confirm_branch`.
    NeedsName {
        pending: String,
        system: String,
        change: String,
    },
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
    let name = format!("{PENDING_PREFIX}{}", utc_stamp(now_unix));
    git::Repo::open(master)?.create_branch(&name, base)?;
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
    let base = default_base(master)?;
    let repo = git::Repo::open(master).ok()?;
    created_folder(master, &repo, &base).ok().flatten()
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
    if !pending.starts_with(PENDING_PREFIX) {
        return Err(BranchError::InvalidName(pending.to_string()));
    }
    require_local_branch(master, pending)?;
    require_local_branch(master, base)?;
    let repo = git::Repo::open(master)?;
    if let Some(sc) = created_folder(master, &repo, base)? {
        let (system, change) = sc.split_once('/').unwrap_or(("", &sc));
        let (system, change) = (system.to_string(), change.to_string());
        if naming::declared(master, &system) {
            return Ok(FinishOutcome::NeedsName {
                pending: pending.to_string(),
                system,
                change,
            });
        }
        let branch = format!("change/{change}");
        repo.rename_branch(pending, &branch)?;
        return Ok(FinishOutcome::Renamed { branch, change });
    }
    if !repo.revs_between(base, pending)?.is_empty() {
        return Err(BranchError::PendingHasCommits);
    }
    ensure_clean(master)?;
    repo.checkout_branch(base)?;
    repo.delete_branch(pending)?;
    Ok(FinishOutcome::Deleted)
}

/// The conventional work types a branch name may be recorded under.
const WORK_TYPES: [&str; 11] = [
    "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
];

/// Name a pending branch after the engineer's confirmed `name`: record it in `branch.md` and rename the
/// pending branch to it. Every check runs before the first write.
#[allow(clippy::too_many_arguments)]
pub fn confirm_branch(
    plugin: &Readiness,
    folder: &Path,
    master_repo: &str,
    system: &str,
    change: &str,
    pending: &str,
    name: &str,
    work_type: &str,
) -> Result<FinishOutcome, BranchError> {
    let master = folder.join(master_repo);
    if !pending.starts_with(PENDING_PREFIX) {
        return Err(BranchError::InvalidName(pending.to_string()));
    }
    require_local_branch(&master, pending)?;
    if current_branch(&master).as_deref() != Some(pending) {
        return Err(BranchError::InvalidName(pending.to_string()));
    }
    if pending_created(&master).as_deref() != Some(&format!("{system}/{change}")) {
        return Err(BranchError::InvalidName(format!(
            "the pending branch `{pending}` did not create the change `{system}/{change}`"
        )));
    }
    if !WORK_TYPES.contains(&work_type) {
        return Err(BranchError::InvalidName(format!(
            "the work type `{work_type}` is not one of {}",
            WORK_TYPES.join(", ")
        )));
    }
    naming::check_branch_name(plugin, name).map_err(|e| match e {
        NamingError::Name(problem) => BranchError::InvalidName(problem),
        other => BranchError::Record(other.to_string()),
    })?;
    let clashes = branch_record::clashes(folder, master_repo, system, name, None)
        .map_err(|e| BranchError::Record(e.to_string()))?;
    if !clashes.is_empty() {
        let text: Vec<String> = clashes
            .iter()
            .map(|c| format!("clashes with `{}` in `{}`", c.existing, c.repo))
            .collect();
        return Err(BranchError::InvalidName(text.join("; ")));
    }
    let record = BranchRecord {
        branch: name.to_string(),
        work_type: Some(work_type.to_string()),
    };
    branch_record::write(&master, system, change, &record, RecordVerb::Name)
        .map_err(|e| BranchError::Record(e.to_string()))?;
    git::Repo::open(&master)?.rename_branch(pending, name)?;
    Ok(FinishOutcome::Renamed {
        branch: name.to_string(),
        change: change.to_string(),
    })
}

/// The branch name the system's pattern gives `change` as work of type `work_type`.
pub fn suggest_branch(
    plugin: &Readiness,
    master: &Path,
    system: &str,
    change: &str,
    work_type: &str,
) -> Result<String, NamingError> {
    naming::names(plugin, master, system, change, work_type)?
        .map(|n| n.branch)
        .ok_or_else(|| NamingError::Unreadable("the system declares no naming setting".into()))
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
        testutil::commit_file(&repo, ".ai-sdlc.json", CLAIMS_MARKER, "marker");
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
        testutil::commit_file(&repo, ".ai-sdlc.json", CLAIMS_MARKER, "marker");
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

    const CLAIMS_MARKER: &str = r#"{"version":1,"systems":{"claims":{"repos":["m"]}}}"#;
    const NAMED: &str = r#"{"version":1,"systems":{"kata":{"repos":["kata"],"naming":{"branch":"{type}/{scope}-{slug}","pullRequestTitle":"{type}({scope}): {title}"}}}}"#;
    const UNNAMED: &str = r#"{"version":1,"systems":{"kata":{"repos":["kata"]}}}"#;
    const CHANGE: &str = "2026-11-02-password-reset";

    fn ready() -> Readiness {
        Readiness::Ready {
            dir: testutil::plugin_dir().to_path_buf(),
            version: crate::plugin::NAMING_VERSION.to_string(),
            layouts: crate::format::ACCEPTED_LAYOUTS.to_vec(),
            light_track: true,
            naming: crate::plugin::naming(crate::plugin::NAMING_VERSION),
        }
    }

    /// A workspace folder with the master `ai-sdlc` (marker committed) and the product repo `kata`.
    fn workspace(tmp: &Path, marker: &str) -> std::path::PathBuf {
        let master = testutil::repo(tmp, "ai-sdlc");
        testutil::commit_file(&master, ".ai-sdlc.json", marker, "marker");
        testutil::repo(tmp, "kata");
        master
    }

    fn intent(master: &Path, committed: bool) {
        let rel = format!("intent/kata/{CHANGE}/intent.md");
        let body =
            "---\nstatus: draft\nscope: PROJ-123\ntitle: Customer can reset password\n---\nx\n";
        if committed {
            testutil::commit_file(master, &rel, body, "intent");
        } else {
            testutil::write(master, &rel, body);
        }
    }

    #[test]
    fn finish_follows_the_table() {
        let needs = |pending: &str| FinishOutcome::NeedsName {
            pending: pending.to_string(),
            system: "kata".into(),
            change: CHANGE.into(),
        };
        let renamed = FinishOutcome::Renamed {
            branch: format!("change/{CHANGE}"),
            change: CHANGE.into(),
        };
        // Rows 1 and 2: a folder was created, with and without commits on the pending branch.
        for committed in [false, true] {
            for (row, marker) in [(1, UNNAMED), (2, NAMED)] {
                let tmp = tempfile::tempdir().unwrap();
                let master = workspace(tmp.path(), marker);
                let pending = start_pending(&master, "main", 1_792_368_000).unwrap();
                intent(&master, committed);
                let out = finish_pending(&master, &pending, "main").unwrap();
                if row == 1 {
                    assert_eq!(out, renamed, "row 1 committed={committed}");
                    assert_eq!(
                        current_branch(&master).as_deref(),
                        Some(format!("change/{CHANGE}").as_str())
                    );
                } else {
                    assert_eq!(out, needs(&pending), "row 2 committed={committed}");
                    assert_eq!(current_branch(&master).as_deref(), Some(pending.as_str()));
                    assert!(branch_exists(&master, &pending));
                }
            }
        }
        // Rows 3 and 4: no folder created, whether or not the system declares a setting.
        for marker in [UNNAMED, NAMED] {
            let tmp = tempfile::tempdir().unwrap();
            let master = workspace(tmp.path(), marker);
            let pending = start_pending(&master, "main", 1_792_368_000).unwrap();
            testutil::commit_file(&master, "notes.txt", "x\n", "stray");
            assert!(
                matches!(
                    finish_pending(&master, &pending, "main"),
                    Err(BranchError::PendingHasCommits)
                ),
                "row 3"
            );
            let tmp = tempfile::tempdir().unwrap();
            let master = workspace(tmp.path(), marker);
            let pending = start_pending(&master, "main", 1_792_368_000).unwrap();
            assert_eq!(
                finish_pending(&master, &pending, "main").unwrap(),
                FinishOutcome::Deleted,
                "row 4"
            );
            assert!(!branch_exists(&master, &pending));
            assert_eq!(current_branch(&master).as_deref(), Some("main"));
        }
    }

    #[test]
    fn finish_without_setting_renames_to_change_folder_r2_1() {
        let tmp = tempfile::tempdir().unwrap();
        let master = workspace(tmp.path(), UNNAMED);
        let pending = start_pending(&master, "main", 1_792_368_000).unwrap();
        intent(&master, true);
        assert_eq!(
            finish_pending(&master, &pending, "main").unwrap(),
            FinishOutcome::Renamed {
                branch: "change/2026-11-02-password-reset".into(),
                change: CHANGE.into()
            }
        );
        assert!(branch_exists(&master, "change/2026-11-02-password-reset"));
    }

    fn pending_with_intent(tmp: &Path) -> (std::path::PathBuf, String) {
        let master = workspace(tmp, NAMED);
        let pending = start_pending(&master, "main", 1_792_368_000).unwrap();
        intent(&master, true);
        (master, pending)
    }

    #[test]
    fn confirm_names_and_commits_the_record() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, pending) = pending_with_intent(tmp.path());
        let out = confirm_branch(
            &ready(),
            tmp.path(),
            "ai-sdlc",
            "kata",
            CHANGE,
            &pending,
            "feat/PROJ-123-password-reset",
            "feat",
        )
        .unwrap();
        assert_eq!(
            out,
            FinishOutcome::Renamed {
                branch: "feat/PROJ-123-password-reset".into(),
                change: CHANGE.into()
            }
        );
        assert_eq!(
            current_branch(&master).as_deref(),
            Some("feat/PROJ-123-password-reset")
        );
        assert!(!branch_exists(&master, &pending));
        let files = git::run(&master, &["show", "--name-only", "--format=", "HEAD"]).unwrap();
        assert_eq!(files, format!("intent/kata/{CHANGE}/branch.md"));
        assert_eq!(
            crate::branch_record::change_branch(&master, "kata", CHANGE).unwrap(),
            "feat/PROJ-123-password-reset"
        );
    }

    #[test]
    fn confirm_refuses_a_change_the_pending_branch_did_not_create() {
        let tmp = tempfile::tempdir().unwrap();
        let master = workspace(tmp.path(), NAMED);
        let on_base = "2026-10-01-on-base";
        testutil::commit_file(
            &master,
            &format!("intent/kata/{on_base}/intent.md"),
            "---\nstatus: draft\n---\nx\n",
            "older change",
        );
        let pending = start_pending(&master, "main", 1_792_368_000).unwrap();
        intent(&master, true);
        let head = git::run(&master, &["rev-parse", "HEAD"]).unwrap();
        for other in [on_base, "2026-11-03-never-existed"] {
            let err = confirm_branch(
                &ready(),
                tmp.path(),
                "ai-sdlc",
                "kata",
                other,
                &pending,
                "feat/PROJ-123-other",
                "feat",
            )
            .unwrap_err();
            assert!(err.to_string().contains("did not create"), "{err}");
            assert!(!master
                .join(format!("intent/kata/{other}/branch.md"))
                .exists());
        }
        assert_eq!(current_branch(&master).as_deref(), Some(pending.as_str()));
        assert!(!branch_exists(&master, "feat/PROJ-123-other"));
        assert_eq!(git::run(&master, &["rev-parse", "HEAD"]).unwrap(), head);
    }

    #[test]
    fn branch_info_names_the_change_a_pending_branch_created() {
        let tmp = tempfile::tempdir().unwrap();
        let master = workspace(tmp.path(), NAMED);
        assert_eq!(crate::changes::branch_info(&master).pending_change, None);
        start_pending(&master, "main", 1_792_368_000).unwrap();
        assert_eq!(crate::changes::branch_info(&master).pending_change, None);
        intent(&master, true);
        assert_eq!(
            crate::changes::branch_info(&master).pending_change,
            Some(format!("kata/{CHANGE}"))
        );
    }

    #[test]
    fn confirm_refuses_a_name_with_a_space_r6_5() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, pending) = pending_with_intent(tmp.path());
        let head = git::run(&master, &["rev-parse", "HEAD"]).unwrap();
        let err = confirm_branch(
            &ready(),
            tmp.path(),
            "ai-sdlc",
            "kata",
            CHANGE,
            &pending,
            "feat/PROJ 123",
            "feat",
        )
        .unwrap_err();
        assert!(
            err.to_string()
                .contains("a branch name cannot contain a space"),
            "{err}"
        );
        assert_eq!(current_branch(&master).as_deref(), Some(pending.as_str()));
        assert_eq!(git::run(&master, &["rev-parse", "HEAD"]).unwrap(), head);
        assert!(!master
            .join(format!("intent/kata/{CHANGE}/branch.md"))
            .exists());
    }

    #[test]
    fn confirm_refuses_unsafe_names_before_any_git_call_r12_1() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, pending) = pending_with_intent(tmp.path());
        let snapshot = || {
            (
                git::run(&master, &["for-each-ref"]).unwrap(),
                std::fs::read(master.join(".git/logs/HEAD")).unwrap(),
                std::fs::read(master.join(".git/HEAD")).unwrap(),
            )
        };
        let before = snapshot();
        for bad in ["-D", "feat/../main", "feat/@{1}"] {
            let err = confirm_branch(
                &ready(),
                tmp.path(),
                "ai-sdlc",
                "kata",
                CHANGE,
                &pending,
                bad,
                "feat",
            );
            assert!(err.is_err(), "{bad}");
            assert!(snapshot() == before, "{bad} changed the repository");
        }
    }

    #[test]
    fn confirm_refuses_a_clash_a_non_pending_branch_and_a_bad_type() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, pending) = pending_with_intent(tmp.path());
        git::run(&tmp.path().join("kata"), &["branch", "feat/taken"]).unwrap();
        let go = |pending: &str, name: &str, work_type: &str| {
            confirm_branch(
                &ready(),
                tmp.path(),
                "ai-sdlc",
                "kata",
                CHANGE,
                pending,
                name,
                work_type,
            )
        };
        let err = go(&pending, "feat/taken", "feat").unwrap_err();
        assert!(
            err.to_string()
                .contains("clashes with `feat/taken` in `kata`"),
            "{err}"
        );
        assert!(go(&pending, "feat/ok", "feature").is_err());
        assert!(go("main", "feat/ok", "feat").is_err());
        assert_eq!(current_branch(&master).as_deref(), Some(pending.as_str()));
        assert!(!master
            .join(format!("intent/kata/{CHANGE}/branch.md"))
            .exists());
    }

    #[test]
    fn suggest_gives_the_pattern_name() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, _pending) = pending_with_intent(tmp.path());
        assert_eq!(
            suggest_branch(&ready(), &master, "kata", CHANGE, "feat").unwrap(),
            "feat/PROJ-123-password-reset"
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
