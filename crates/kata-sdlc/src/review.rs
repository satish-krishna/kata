//! The review document of a change: `build/review.md`, as committed in the master repository.
//!
//! The final review writes its findings to that document, one `## Review <n>` section per review,
//! and the Workbench shows what the document holds. Nothing in Kata parses the document itself:
//! the ai-sdlc plugin's format program reads it, in whatever layout it is written.
use crate::build::{change_dir, program, put, reading, staging_dir, unreadable};
use crate::format::{self, FormatError, ParsedReviewSection, Problem, ReadResult};
use crate::git::{self, GitError};
use crate::store::RunLink;
use kata_core::history::RunRecord;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// What the review document of a change holds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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

/// The change a review belongs to, as run links name it.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ReviewScope {
    pub workspace_id: String,
    pub system: String,
    pub change: String,
}

/// Whether the change's latest review covers its current work, for the build page.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ReviewStanding {
    /// The change has not been reviewed.
    None,
    /// The latest review run did not exit 0.
    Unfinished,
    /// The work changed since it was reviewed.
    Stale,
    /// The review document does not pass its checks.
    Invalid,
    /// With no review document: the latest review run, whose heads are where the repositories stand now.
    CurrentRun { run_id: String },
    /// The review document's latest review covers the change; `review` is its index in `reviews`.
    CurrentDocument { review: usize },
}

/// The standing of the change's latest review. With a review document, its latest review decides: the commits it
/// records against where the product repositories stand now (`heads` without `master`), whatever the review run's
/// exit code was. Without one, the review run does, as its run link records it: none when it was never run,
/// unfinished when it did not exit 0, stale when a repository moved since it started, otherwise current.
pub fn standing(
    links: &[RunLink],
    records: &[RunRecord],
    heads: &BTreeMap<String, String>,
    scope: &ReviewScope,
    document: Option<&ReviewRecord>,
    master: Option<&str>,
) -> ReviewStanding {
    if let Some(document) = document {
        // The master's head moves when the review is recorded, so its own movement is the record's master_moved, not its head.
        let product: BTreeMap<String, String> = heads
            .iter()
            .filter(|(repo, _)| Some(repo.as_str()) != master)
            .map(|(repo, head)| (repo.clone(), head.clone()))
            .collect();
        return match currency(document, &product) {
            ReviewCurrency::None => ReviewStanding::None,
            ReviewCurrency::Invalid => ReviewStanding::Invalid,
            ReviewCurrency::Stale => ReviewStanding::Stale,
            ReviewCurrency::Current { review } => ReviewStanding::CurrentDocument { review },
        };
    }
    let mut latest: Option<&RunLink> = None;
    for l in links {
        if l.stage != "review"
            || l.workspace_id != scope.workspace_id
            || l.system != scope.system
            || l.change != scope.change
        {
            continue;
        }
        if latest.is_none_or(|was| l.started_at >= was.started_at) {
            latest = Some(l);
        }
    }
    let Some(latest) = latest else {
        return ReviewStanding::None;
    };
    let exit = records
        .iter()
        .find(|r| r.id == latest.run_id)
        .and_then(|r| r.exit);
    if exit != Some(0) {
        return ReviewStanding::Unfinished;
    }
    // Every repository standing now must be where it stood when the review run started.
    let same = latest.heads.as_ref().is_some_and(|then| {
        heads
            .iter()
            .all(|(repo, head)| then.get(repo) == Some(head))
    });
    if !same {
        return ReviewStanding::Stale;
    }
    ReviewStanding::CurrentRun {
        run_id: latest.run_id.clone(),
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

    // --- the standing of the latest review: every row the build page's `reviewState` had

    fn scope() -> ReviewScope {
        ReviewScope {
            workspace_id: "w1".into(),
            system: "commerce".into(),
            change: "c1".into(),
        }
    }

    fn link(run_id: &str, started_at: u64, heads_at: Option<&[(&str, &str)]>) -> RunLink {
        RunLink {
            workspace_id: "w1".into(),
            system: "commerce".into(),
            change: "c1".into(),
            stage: "review".into(),
            run_id: run_id.into(),
            started_at,
            heads: heads_at.map(heads),
        }
    }

    fn run(id: &str, exit: Option<i32>) -> RunRecord {
        RunRecord {
            id: id.into(),
            kata: "k".into(),
            started_at: 100,
            isolation: "none".into(),
            exit,
            turns: None,
            cost_usd: None,
            duration_ms: None,
            result: None,
            steered: false,
            ending: kata_core::history::RunEnding::from_exit(exit, false),
        }
    }

    const A1: &[(&str, &str)] = &[("a", "1111111")];

    #[test]
    fn standing_is_none_when_the_change_has_no_review_link() {
        let h = heads(A1);
        assert_eq!(
            standing(&[], &[], &h, &scope(), None, None),
            ReviewStanding::None
        );
        let mut build = link("r1", 100, Some(A1));
        build.stage = "build:a".into();
        let mut other_change = link("r1", 100, Some(A1));
        other_change.change = "other".into();
        let mut other_workspace = link("r1", 100, Some(A1));
        other_workspace.workspace_id = "w2".into();
        let mut other_system = link("r1", 100, Some(A1));
        other_system.system = "bob".into();
        assert_eq!(
            standing(
                &[build, other_change, other_workspace, other_system],
                &[run("r1", Some(0))],
                &h,
                &scope(),
                None,
                None
            ),
            ReviewStanding::None
        );
    }

    #[test]
    fn standing_is_unfinished_when_the_review_run_did_not_exit_0() {
        let h = heads(A1);
        let l = [link("r1", 100, Some(A1))];
        for records in [vec![run("r1", Some(1))], vec![run("r1", None)], vec![]] {
            assert_eq!(
                standing(&l, &records, &h, &scope(), None, None),
                ReviewStanding::Unfinished
            );
        }
    }

    #[test]
    fn standing_is_stale_when_the_heads_differ_from_the_heads_at_review_time() {
        let ok = [run("r1", Some(0))];
        assert_eq!(
            standing(
                &[link("r1", 100, Some(A1))],
                &ok,
                &heads(&[("a", "2222222")]),
                &scope(),
                None,
                None
            ),
            ReviewStanding::Stale
        );
        assert_eq!(
            standing(
                &[link("r1", 100, None)],
                &ok,
                &heads(A1),
                &scope(),
                None,
                None
            ),
            ReviewStanding::Stale
        );
        // A repository the review run did not record counts as moved.
        assert_eq!(
            standing(
                &[link("r1", 100, Some(A1))],
                &ok,
                &heads(&[("a", "1111111"), ("b", "3333333")]),
                &scope(),
                None,
                None
            ),
            ReviewStanding::Stale
        );
    }

    #[test]
    fn standing_is_current_for_the_latest_review_whose_heads_match() {
        let older = link("r0", 50, Some(&[("a", "0000000")]));
        let got = standing(
            &[link("r1", 100, Some(A1)), older],
            &[run("r1", Some(0)), run("r0", Some(0))],
            &heads(A1),
            &scope(),
            None,
            None,
        );
        assert_eq!(
            got,
            ReviewStanding::CurrentRun {
                run_id: "r1".into()
            }
        );
    }

    #[test]
    fn standing_judges_only_the_latest_review() {
        let older = link("r0", 50, Some(A1));
        let newer = link("r2", 200, Some(A1));
        assert_eq!(
            standing(
                &[older, newer],
                &[run("r0", Some(0)), run("r2", Some(1))],
                &heads(A1),
                &scope(),
                None,
                None
            ),
            ReviewStanding::Unfinished
        );
        // Of two links started at the same second, the later one in the list is the latest.
        let first = link("r0", 100, Some(A1));
        let second = link("r2", 100, Some(A1));
        assert_eq!(
            standing(
                &[first, second],
                &[run("r0", Some(0)), run("r2", Some(1))],
                &heads(A1),
                &scope(),
                None,
                None
            ),
            ReviewStanding::Unfinished
        );
    }

    #[test]
    fn standing_with_a_document_that_passes_is_current() {
        let doc = record_of(vec![section(&[("a", "1111111")])], 0, &[]);
        assert_eq!(
            standing(&[], &[], &heads(A1), &scope(), Some(&doc), Some("m")),
            ReviewStanding::CurrentDocument { review: 0 }
        );
    }

    /// F6: a review document with problems is not a current review, so done stays blocked.
    #[test]
    fn standing_with_a_document_with_problems_is_invalid() {
        let doc = record_of(vec![section(&[("a", "1111111")])], 1, &[]);
        assert_eq!(
            standing(&[], &[], &heads(A1), &scope(), Some(&doc), Some("m")),
            ReviewStanding::Invalid
        );
        assert_eq!(
            standing(
                &[link("r1", 100, Some(A1))],
                &[run("r1", Some(0))],
                &heads(A1),
                &scope(),
                Some(&doc),
                Some("m")
            ),
            ReviewStanding::Invalid
        );
    }

    const FULL: &[(&str, &str)] = &[
        ("a", "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ("master", "9999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ];

    #[test]
    fn standing_reads_the_latest_review_commits_against_the_heads_and_not_the_run_exit_code() {
        let doc = record_of(
            vec![section(&[("a", "0000000")]), section(&[("a", "1111111")])],
            0,
            &[],
        );
        assert_eq!(
            standing(
                &[link("r1", 100, Some(A1))],
                &[run("r1", Some(1))],
                &heads(FULL),
                &scope(),
                Some(&doc),
                Some("master")
            ),
            ReviewStanding::CurrentDocument { review: 1 }
        );
    }

    #[test]
    fn standing_is_stale_when_a_reviewed_repository_moved_since_the_review() {
        let doc = record_of(vec![section(&[("a", "1111111")])], 0, &[]);
        assert_eq!(
            standing(
                &[],
                &[],
                &heads(&[("a", "2222222cccccccccccccccccccccccccccccccc")]),
                &scope(),
                Some(&doc),
                Some("master")
            ),
            ReviewStanding::Stale
        );
    }

    #[test]
    fn standing_does_not_judge_the_master_by_its_head() {
        let doc = record_of(
            vec![section(&[("a", "1111111"), ("master", "0123456")])],
            0,
            &[],
        );
        assert_eq!(
            standing(&[], &[], &heads(FULL), &scope(), Some(&doc), Some("master")),
            ReviewStanding::CurrentDocument { review: 0 }
        );
    }

    #[test]
    fn standing_is_none_when_the_document_holds_no_review() {
        let doc = record_of(vec![], 0, &[]);
        assert_eq!(
            standing(
                &[link("r1", 100, Some(A1))],
                &[run("r1", Some(0))],
                &heads(FULL),
                &scope(),
                Some(&doc),
                Some("master")
            ),
            ReviewStanding::None
        );
    }

    /// F17: the master is judged by what it committed since the review, not by its head.
    #[test]
    fn standing_judges_the_master_by_what_it_committed_since_the_review() {
        let reviewed = || vec![section(&[("a", "1111111"), ("master", "0123456")])];
        let product = record_of(reviewed(), 0, &["plugin/tools/ai-sdlc.ts"]);
        assert_eq!(
            standing(
                &[],
                &[],
                &heads(FULL),
                &scope(),
                Some(&product),
                Some("master")
            ),
            ReviewStanding::Stale
        );
        let only_review = record_of(reviewed(), 0, &[]);
        assert_eq!(
            standing(
                &[],
                &[],
                &heads(FULL),
                &scope(),
                Some(&only_review),
                Some("master")
            ),
            ReviewStanding::CurrentDocument { review: 0 }
        );
    }
}
