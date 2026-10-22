//! The review document of a change: `build/review.md`, as committed in the master repository.
//!
//! The final review writes its findings to that document, one `## Review <n>` section per review,
//! and the Workbench shows what the document holds. Nothing in Kata parses the document itself:
//! the ai-sdlc plugin's format program reads it, in whatever layout it is written.
use crate::build::{change_dir, program, put, reading, staging_dir, unreadable};
use crate::format::{self, FormatError, ParsedReviewSection, Problem, ReadResult};
use crate::git::{self, GitError};
use crate::snapshot;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// What the review document of a change holds.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ReviewRecord {
    /// The layout version the document declares.
    pub layout: u32,
    /// Every review in the document, in the order written (oldest first).
    pub reviews: Vec<ParsedReviewSection>,
    /// Everything the format program found wrong in the document.
    pub problems: Vec<Problem>,
    /// The files the master repository committed since the head the latest review records for it,
    /// other than this document; empty when the review is of the master as it stands now. A review
    /// that does not record the master's head does not cover it, so nothing is judged. When the
    /// commits cannot be read, the one entry says so.
    pub master_moved: Vec<String>,
}

/// The change's review document as committed at `HEAD`, read by the format program in `plugin` (the
/// ai-sdlc plugin folder). `None` when the change has no review document: the caller then falls back
/// to the review run's closing words. A document that is present always holds at least one review,
/// or `problems` says why not.
pub fn record(
    plugin: &Path,
    master: &Path,
    system: &str,
    change: &str,
) -> Result<Option<ReviewRecord>, GitError> {
    let rel = format!("{}/build/review.md", change_dir(system, change));
    if git::run(master, &["ls-tree", "--name-only", "HEAD", "--", &rel])?.is_empty() {
        return Ok(None);
    }
    let text = git::run(master, &["show", &format!("HEAD:{rel}")])?;
    let read = {
        let stage = staging_dir(master, system, change);
        let lock = reading(&stage);
        let _one_reader = lock.lock().unwrap_or_else(|e| e.into_inner());
        // Its own folder: the build reader clears the stray files in the folder it stages.
        let file = stage.join("review").join("build").join("review.md");
        put(&file, &text)?;
        format::read(&program(plugin), &file).map_err(unreadable)?
    };
    match read {
        ReadResult::Review {
            layout,
            document,
            problems,
        } => {
            let master_moved = moved_since_latest(master, system, change, &document.reviews);
            Ok(Some(ReviewRecord {
                layout,
                reviews: document.reviews,
                problems,
                master_moved,
            }))
        }
        _ => Err(unreadable(FormatError::BadOutput(
            "build/review.md was not read as a review".into(),
        ))),
    }
}

/// What the master committed since the head the latest review records for it (see
/// `ReviewRecord::master_moved`).
fn moved_since_latest(
    master: &Path,
    system: &str,
    change: &str,
    reviews: &[ParsedReviewSection],
) -> Vec<String> {
    let name = master.file_name().and_then(|n| n.to_str());
    let recorded = name
        .zip(reviews.last())
        .and_then(|(name, latest)| latest.commits.get(name));
    let Some(since) = recorded else {
        return Vec::new();
    };
    match committed_outside(master, system, change, since) {
        Ok(files) => files,
        Err(e) => vec![format!("could not check the master repository: {e}")],
    }
}

/// The files committed in the master since `since` besides the change's `build/review.md`, sorted.
fn committed_outside(
    master: &Path,
    system: &str,
    change: &str,
    since: &str,
) -> Result<Vec<String>, GitError> {
    let range = format!("{since}..HEAD");
    let committed = git::run_bytes(
        master,
        &[
            "log",
            "-z",
            "--name-only",
            "--no-renames",
            "--pretty=format:",
            &range,
        ],
    )?;
    let allowed = format!("{}/build/review.md", change_dir(system, change));
    let files: BTreeSet<String> = nul_split(&committed)
        .filter(|f| *f != allowed)
        .map(str::to_string)
        .collect();
    Ok(files.into_iter().collect())
}

/// Checks what a review run left in the master repository: the commits made since `since` (the head
/// the run started from) may touch only the change's `build/review.md`, and the working tree may hold
/// no other change than the ones it already held when the run started. The run may edit nothing
/// else, but a deny rule cannot stop a shell write, so this is the check that catches one (it also
/// covers `plugin/`, which holds the program Kata executes).
///
/// `before` is the master's dirty files (path to content hash, as `snapshot::take` reads them) when
/// the run started: a file dirty then with the same content is not the run's. A file the run changed
/// again, or left dirty itself, is flagged.
///
/// `Err` lists the other files, sorted, or says why the check could not run.
pub fn verify_run(
    master: &Path,
    system: &str,
    change: &str,
    since: &str,
    before: &BTreeMap<String, String>,
) -> Result<(), Vec<String>> {
    let could_not = |e: GitError| vec![format!("could not check the master repository: {e}")];
    let mut touched: BTreeSet<String> = committed_outside(master, system, change, since)
        .map_err(could_not)?
        .into_iter()
        .collect();
    let allowed = format!("{}/build/review.md", change_dir(system, change));
    let status =
        git::run_bytes(master, &["status", "--porcelain", "-z", "-uall"]).map_err(could_not)?;
    let mut dirty = BTreeSet::new();
    let mut entries = nul_split(&status);
    while let Some(entry) = entries.next() {
        let Some((code, path)) = entry.split_at_checked(3) else {
            continue;
        };
        dirty.insert(path.to_string());
        // A rename or copy lists its source as a separate entry.
        if code.starts_with(['R', 'C']) {
            if let Some(from) = entries.next() {
                dirty.insert(from.to_string());
            }
        }
    }
    for path in dirty {
        let hash = snapshot::hash_of(master, &path).map_err(could_not)?;
        if before.get(&path) != Some(&hash) {
            touched.insert(path);
        }
    }
    touched.remove(&allowed);
    if touched.is_empty() {
        Ok(())
    } else {
        Err(touched.into_iter().collect())
    }
}

fn nul_split(bytes: &[u8]) -> impl Iterator<Item = &str> {
    bytes
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| std::str::from_utf8(s).unwrap_or("(unreadable file name)"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    const S: &str = "s";
    const C: &str = "2026-10-21-c";
    const REVIEW: &str = "intent/s/2026-10-21-c/build/review.md";

    /// A master repository and the commit a review run starts from.
    fn started() -> (tempfile::TempDir, std::path::PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let master = testutil::repo(dir.path(), "m");
        testutil::commit_file(&master, "plugin/format/check.mjs", "// program\n", "plugin");
        let since = git::run(&master, &["rev-parse", "HEAD"]).unwrap();
        (dir, master, since)
    }

    #[test]
    fn a_run_that_committed_only_the_review_document_passes() {
        let (_dir, master, since) = started();
        testutil::commit_file(&master, REVIEW, "# Review\n", "review");
        assert_eq!(verify_run(&master, S, C, &since, &BTreeMap::new()), Ok(()));
    }

    #[test]
    fn a_run_that_changed_nothing_passes() {
        let (_dir, master, since) = started();
        assert_eq!(verify_run(&master, S, C, &since, &BTreeMap::new()), Ok(()));
    }

    #[test]
    fn a_review_document_not_yet_committed_passes() {
        let (_dir, master, since) = started();
        testutil::write(&master, REVIEW, "# Review\n");
        assert_eq!(verify_run(&master, S, C, &since, &BTreeMap::new()), Ok(()));
    }

    #[test]
    fn a_run_that_also_committed_under_plugin_is_flagged_with_that_file() {
        let (_dir, master, since) = started();
        testutil::commit_file(&master, REVIEW, "# Review\n", "review");
        testutil::commit_file(&master, "plugin/format/check.mjs", "// changed\n", "oops");
        assert_eq!(
            verify_run(&master, S, C, &since, &BTreeMap::new()),
            Err(vec!["plugin/format/check.mjs".to_string()])
        );
    }

    #[test]
    fn a_file_committed_and_then_reverted_is_still_flagged() {
        let (_dir, master, since) = started();
        testutil::commit_file(&master, "plugin/x.md", "x\n", "add");
        git::run(&master, &["rm", "-q", "plugin/x.md"]).unwrap();
        git::run(&master, &["commit", "-q", "-m", "remove"]).unwrap();
        assert_eq!(
            verify_run(&master, S, C, &since, &BTreeMap::new()),
            Err(vec!["plugin/x.md".to_string()])
        );
    }

    #[test]
    fn uncommitted_edits_elsewhere_are_flagged() {
        let (_dir, master, since) = started();
        testutil::write(&master, "plugin/format/check.mjs", "// edited\n");
        testutil::write(&master, "notes/new.md", "n\n");
        assert_eq!(
            verify_run(&master, S, C, &since, &BTreeMap::new()),
            Err(vec![
                "notes/new.md".to_string(),
                "plugin/format/check.mjs".to_string()
            ])
        );
    }

    fn dirty_now(master: &Path) -> BTreeMap<String, String> {
        snapshot::take(master).unwrap().dirty
    }

    #[test]
    fn a_file_dirty_before_the_run_with_the_same_content_is_not_the_runs() {
        let (_dir, master, since) = started();
        testutil::write(
            &master,
            "notes/stray.md",
            "left by the build
",
        );
        let before = dirty_now(&master);
        testutil::commit_file(
            &master,
            REVIEW,
            "# Review
",
            "review",
        );
        assert_eq!(verify_run(&master, S, C, &since, &before), Ok(()));
    }

    #[test]
    fn a_file_the_run_left_is_flagged_beside_one_dirty_before() {
        let (_dir, master, since) = started();
        testutil::write(
            &master,
            "notes/stray.md",
            "left by the build
",
        );
        let before = dirty_now(&master);
        testutil::write(
            &master,
            "plugin/format/check.mjs",
            "// edited
",
        );
        assert_eq!(
            verify_run(&master, S, C, &since, &before),
            Err(vec!["plugin/format/check.mjs".to_string()])
        );
    }

    #[test]
    fn a_file_dirty_before_that_the_run_changed_again_is_flagged() {
        let (_dir, master, since) = started();
        testutil::write(
            &master,
            "notes/stray.md",
            "left by the build
",
        );
        let before = dirty_now(&master);
        testutil::write(
            &master,
            "notes/stray.md",
            "the run rewrote it
",
        );
        assert_eq!(
            verify_run(&master, S, C, &since, &before),
            Err(vec!["notes/stray.md".to_string()])
        );
    }

    #[test]
    fn a_held_file_the_run_restored_with_git_checkout_is_flagged() {
        let (_dir, master, since) = started();
        testutil::write(
            &master,
            "plugin/format/check.mjs",
            "// held work
",
        );
        testutil::write(
            &master,
            "notes/stray.md",
            "left by the build
",
        );
        let before = dirty_now(&master);
        git::run(&master, &["checkout", "--", "plugin/format/check.mjs"]).unwrap();
        assert_eq!(
            verify_run(&master, S, C, &since, &before),
            Err(vec!["plugin/format/check.mjs".to_string()])
        );
    }

    #[test]
    fn a_held_file_the_run_did_not_touch_is_not_flagged_beside_a_restored_one() {
        let (_dir, master, since) = started();
        testutil::write(
            &master,
            "plugin/format/check.mjs",
            "// held work
",
        );
        testutil::write(
            &master,
            "notes/stray.md",
            "left by the build
",
        );
        let before = dirty_now(&master);
        git::run(&master, &["checkout", "--", "plugin/format/check.mjs"]).unwrap();
        let got = verify_run(&master, S, C, &since, &before).unwrap_err();
        assert!(!got.contains(&"notes/stray.md".to_string()));
    }
}
