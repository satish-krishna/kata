//! The review document of a change: `build/review.md`, as committed in the master repository.
//!
//! The final review writes its findings to that document, one `## Review <n>` section per review,
//! and the Workbench shows what the document holds. Nothing in Kata parses the document itself:
//! the ai-sdlc plugin's format program reads it, in whatever layout it is written.
use crate::build::{change_dir, program, put, reading, staging_dir, unreadable};
use crate::format::{self, FormatError, ParsedReviewSection, Problem, ReadResult};
use crate::git::{self, GitError};
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
    let Some(bytes) = git::Repo::open(master)?.committed_bytes(&rel)? else {
        return Ok(None);
    };
    let text = git::trimmed_text(&bytes);
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
    // A rename commits the change's record (`change.yml` from the plugin, `branch.md` from an older Kata)
    // and changes nothing the review looked at, so only this currency check lets it through; `verify_run`
    // does not.
    let dir = change_dir(system, change);
    let allowed = [
        format!("{dir}/build/review.md"),
        format!("{dir}/branch.md"),
        format!("{dir}/change.yml"),
    ];
    match committed_outside(master, &allowed, since) {
        Ok(files) => files,
        Err(e) => vec![format!("could not check the master repository: {e}")],
    }
}

/// The files committed in the master since `since` other than the `allowed` ones, sorted.
fn committed_outside(
    master: &Path,
    allowed: &[String],
    since: &str,
) -> Result<Vec<String>, GitError> {
    let committed = git::Repo::open(master)?.files_changed_since(since)?;
    let files: BTreeSet<String> = committed
        .into_iter()
        .filter(|f| !allowed.contains(f))
        .collect();
    Ok(files.into_iter().collect())
}

/// Whether the latest review still covers the change (see `currency`).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ReviewCurrency {
    /// There is no review to judge.
    None,
    /// The document has problems, so nothing in it can be trusted.
    Invalid,
    /// The master or a product repository moved since the latest review.
    Stale,
    /// The latest review covers the change as it stands; `review` is its index in `reviews`.
    Current { review: usize },
}

/// The currency of the review record against where the product repositories stand now. `heads` holds
/// the product repositories only; the master's own movement is `record.master_moved`.
pub fn currency(record: &ReviewRecord, heads: &BTreeMap<String, String>) -> ReviewCurrency {
    // A finding that failed its schema is dropped from the list, so "nothing found" would be a guess.
    if !record.problems.is_empty() {
        return ReviewCurrency::Invalid;
    }
    let Some(latest) = record.reviews.last() else {
        return ReviewCurrency::None;
    };
    let moved = heads
        .iter()
        .any(|(repo, head)| match latest.commits.get(repo) {
            Some(sha) => sha.len() < 4 || !head.starts_with(sha.as_str()),
            None => true,
        });
    if moved || !record.master_moved.is_empty() {
        ReviewCurrency::Stale
    } else {
        ReviewCurrency::Current {
            review: record.reviews.len() - 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(commits: &[(&str, &str)]) -> ParsedReviewSection {
        ParsedReviewSection {
            number: 1,
            reviewed_at: "2026-11-01".into(),
            commits: commits
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            findings: Vec::new(),
        }
    }

    fn record_of(
        reviews: Vec<ParsedReviewSection>,
        problems: usize,
        moved: &[&str],
    ) -> ReviewRecord {
        ReviewRecord {
            layout: 2,
            reviews,
            problems: (0..problems)
                .map(|_| Problem {
                    file: "review.md".into(),
                    line: 1,
                    message: "bad".into(),
                })
                .collect(),
            master_moved: moved.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn heads(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn currency_rows() {
        let h = heads(&[("kata", "abcdef123"), ("ai-sdlc", "99887766")]);
        let good = section(&[("kata", "abcdef1"), ("ai-sdlc", "9988")]);
        // 1: problems
        let r = record_of(vec![good.clone()], 1, &[]);
        assert_eq!(currency(&r, &h), ReviewCurrency::Invalid);
        // 2: no review
        let r = record_of(vec![], 0, &[]);
        assert_eq!(currency(&r, &h), ReviewCurrency::None);
        // 3: a head does not match (differs, missing, or a recorded commit under four characters), or
        // the master moved
        for bad in [
            section(&[("kata", "ffffff"), ("ai-sdlc", "9988")]),
            section(&[("ai-sdlc", "9988")]),
            section(&[("kata", "abc"), ("ai-sdlc", "9988")]),
        ] {
            let r = record_of(vec![bad], 0, &[]);
            assert_eq!(currency(&r, &h), ReviewCurrency::Stale);
        }
        let r = record_of(vec![good.clone()], 0, &["notes.md"]);
        assert_eq!(currency(&r, &h), ReviewCurrency::Stale);
        // 4: all match, the master did not move; the latest review is judged
        let r = record_of(vec![section(&[("kata", "zzzz")]), good], 0, &[]);
        assert_eq!(currency(&r, &h), ReviewCurrency::Current { review: 1 });
    }
}
