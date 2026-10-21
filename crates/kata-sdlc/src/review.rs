//! The review document of a change: `build/review.md`, as committed in the master repository.
//!
//! The final review writes its findings to that document, one `## Review <n>` section per review,
//! and the Workbench shows what the document holds. Nothing in Kata parses the document itself:
//! the ai-sdlc plugin's format program reads it, in whatever layout it is written.
use crate::build::{change_dir, program, put, staging_dir, unreadable, READING};
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
        let _one_reader = READING.lock().unwrap_or_else(|e| e.into_inner());
        // Its own folder: the build reader clears the stray files in the folder it stages.
        let file = staging_dir(master, system, change)
            .join("review")
            .join("build")
            .join("review.md");
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
