//! The review document of a change: `build/review.md`, as committed in the master repository.
//!
//! The final review writes its findings to that document, one `## Review <n>` section per review,
//! and the Workbench shows what the document holds. Nothing in Kata parses the document itself:
//! the ai-sdlc plugin's format program reads it, in whatever layout it is written.
use crate::build::{change_dir, program, put, reading, staging_dir, unreadable};
use crate::format::{self, FormatError, ParsedReviewSection, Problem, ReadResult};
use crate::git::{self, GitError};
use serde::Serialize;
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
        } => Ok(Some(ReviewRecord {
            layout,
            reviews: document.reviews,
            problems,
        })),
        _ => Err(unreadable(FormatError::BadOutput(
            "build/review.md was not read as a review".into(),
        ))),
    }
}

/// Checks what a review run left in the master repository. Stub: the check is not written yet.
pub fn verify_run(
    _master: &Path,
    _system: &str,
    _change: &str,
    _since: &str,
) -> Result<(), Vec<String>> {
    Ok(())
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
        assert_eq!(verify_run(&master, S, C, &since), Ok(()));
    }

    #[test]
    fn a_run_that_changed_nothing_passes() {
        let (_dir, master, since) = started();
        assert_eq!(verify_run(&master, S, C, &since), Ok(()));
    }

    #[test]
    fn a_review_document_not_yet_committed_passes() {
        let (_dir, master, since) = started();
        testutil::write(&master, REVIEW, "# Review\n");
        assert_eq!(verify_run(&master, S, C, &since), Ok(()));
    }

    #[test]
    fn a_run_that_also_committed_under_plugin_is_flagged_with_that_file() {
        let (_dir, master, since) = started();
        testutil::commit_file(&master, REVIEW, "# Review\n", "review");
        testutil::commit_file(&master, "plugin/format/check.mjs", "// changed\n", "oops");
        assert_eq!(
            verify_run(&master, S, C, &since),
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
            verify_run(&master, S, C, &since),
            Err(vec!["plugin/x.md".to_string()])
        );
    }

    #[test]
    fn uncommitted_edits_elsewhere_are_flagged() {
        let (_dir, master, since) = started();
        testutil::write(&master, "plugin/format/check.mjs", "// edited\n");
        testutil::write(&master, "notes/new.md", "n\n");
        assert_eq!(
            verify_run(&master, S, C, &since),
            Err(vec![
                "notes/new.md".to_string(),
                "plugin/format/check.mjs".to_string()
            ])
        );
    }
}
