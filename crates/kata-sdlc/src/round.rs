//! The round offer and the review rows, decided once by the backend.
//!
//! A finished build offers a round that fixes findings of the latest review. This module decides
//! what the round may fix (`offer`), which findings are picked at first (`default_picks`), the
//! requests a set of picks would start (`plan`, used for the dialog's summary and for the start),
//! and the rows the Review group lists (`review_rows`). The frontend sends its picks as form state
//! and shows what comes back.
use crate::format::Concern;
use crate::format::{ParsedFinding, Severity};
use crate::review::ReviewRecord;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// How serious a finding is.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum RoundSeverity {
    Critical,
    High,
    Medium,
    Low,
}

/// One finding of a review as the round and the Review group show it. The id, the severity and the
/// place are optional here: an older review layout may name none of them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ReviewFinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub id: Option<String>,
    pub severity: Option<RoundSeverity>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub concern: Option<Concern>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub rule: Option<String>,
}

/// A finding offered to a round, under its key and the repository its fix goes to (`None` when it
/// names none, or names one outside the build).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RoundFinding {
    pub key: String,
    pub finding: ReviewFinding,
    pub repo: Option<String>,
}

/// The findings of one repository, or of those naming none when `repo` is `None`, as the dialog lists them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RoundGroup {
    pub repo: Option<String>,
    pub findings: Vec<RoundFinding>,
}

/// What a round may fix: the number of the latest review (`None` for none, or for the older layout)
/// and its findings in the order listed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RoundOffer {
    pub review: Option<u32>,
    pub repos: Vec<String>,
    pub findings: Vec<RoundFinding>,
}

/// The engineer's choices in the round dialog, sent as form state.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RoundPicks {
    /// The keys of the picked findings.
    #[serde(default)]
    pub picked: BTreeSet<String>,
    /// The repository chosen for a picked finding that names none, by key.
    #[serde(default)]
    pub assigned: BTreeMap<String, String>,
    /// The engineer's note to a repository, by repository.
    #[serde(default)]
    pub notes: BTreeMap<String, String>,
}

/// One agent a round starts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RoundRequest {
    pub repo: String,
    pub instructions: String,
    pub summary: String,
}

/// The requests a round would start, or the reason it cannot start.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RoundPlan {
    pub blocked: Option<String>,
    pub requests: Vec<RoundRequest>,
}

/// One row of the Review group.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ReviewRow {
    pub key: String,
    pub finding: ReviewFinding,
    pub summary: String,
}

/// How many findings have one severity.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct SeverityCount {
    pub severity: RoundSeverity,
    pub n: u32,
}

/// The rows of one repository (or of the findings naming none), with the low findings set apart.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ReviewRowGroup {
    pub repo: Option<String>,
    pub rows: Vec<ReviewRow>,
    pub low: Vec<ReviewRow>,
}

/// The Review group for the latest review's findings.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ReviewRows {
    pub counts: Vec<SeverityCount>,
    pub total: u32,
    pub groups: Vec<ReviewRowGroup>,
}

impl From<&ParsedFinding> for ReviewFinding {
    fn from(p: &ParsedFinding) -> Self {
        ReviewFinding {
            id: Some(p.id.clone()),
            severity: Some(match p.severity {
                Severity::High => RoundSeverity::High,
                Severity::Medium => RoundSeverity::Medium,
                Severity::Low => RoundSeverity::Low,
            }),
            text: p.text.clone(),
            file: Some(p.file.clone()),
            line: Some(p.line),
            repo: p.repo.clone(),
            concern: p.concern,
            rule: p.rule.clone(),
        }
    }
}

/// The number and findings of the latest review of `record`, in the order listed.
fn latest(record: &ReviewRecord) -> Option<(u32, Vec<ReviewFinding>)> {
    let section = record.reviews.last()?;
    Some((
        section.number,
        section.findings.iter().map(ReviewFinding::from).collect(),
    ))
}

/// A finding's key: its id, else `#<n>` by its place in the review (`index` counts from 0).
pub fn finding_key(finding: &ReviewFinding, index: usize) -> String {
    todo!()
}

/// What a round may fix, from a review's number and findings.
pub fn offer_of(review: Option<(Option<u32>, &[ReviewFinding])>, repos: &[String]) -> RoundOffer {
    todo!()
}

/// What a round may fix: every finding of the latest review, none when there is no review.
pub fn offer(record: Option<&ReviewRecord>, repos: &[String]) -> RoundOffer {
    todo!()
}

/// Critical, high and medium findings picked; a finding with no severity is not.
pub fn default_picks(offer: &RoundOffer) -> RoundPicks {
    todo!()
}

fn concern_name(concern: Concern) -> &'static str {
    match concern {
        Concern::Spec => "spec",
        Concern::Bug => "bug",
        Concern::Convention => "convention",
    }
}

fn severity_name(severity: RoundSeverity) -> &'static str {
    match severity {
        RoundSeverity::Critical => "critical",
        RoundSeverity::High => "high",
        RoundSeverity::Medium => "medium",
        RoundSeverity::Low => "low",
    }
}

fn block(f: &RoundFinding) -> String {
    let finding = &f.finding;
    let mut head = vec![finding.severity.map_or("no severity", severity_name)];
    head.extend(finding.concern.map(concern_name));
    let mut at = String::new();
    if let Some(file) = &finding.file {
        at = format!(" {file}");
        if let Some(line) = finding.line {
            at.push_str(&format!(":{line}"));
        }
    }
    let body: Vec<String> = finding.text.split('\n').map(|l| format!("  {l}")).collect();
    format!("- {} ({}){at}\n{}", f.key, head.join(", "), body.join("\n"))
}

/// One request per repository with a picked finding or a note, or the reason the round cannot start.
pub fn plan(offer: &RoundOffer, picks: &RoundPicks) -> RoundPlan {
    todo!()
}

/// The first sentence of a finding's text (up to the first full stop and space, or line break), the whole text when it has none.
pub fn summary_of(text: &str) -> String {
    todo!()
}

const SEVERITIES: [RoundSeverity; 4] = [
    RoundSeverity::Critical,
    RoundSeverity::High,
    RoundSeverity::Medium,
    RoundSeverity::Low,
];

fn rank(severity: Option<RoundSeverity>) -> usize {
    severity.map_or(SEVERITIES.len(), |s| {
        SEVERITIES.iter().position(|x| *x == s).unwrap_or(0)
    })
}

/// The rows of the Review group. Repositories come in `repos` order, then any repository a finding
/// names that `repos` lacks in first-seen order; the findings naming none go last, and are the only
/// group when no finding names one. Within a group the rows run critical, high, medium, then no
/// severity, in the order listed within a severity, and the low findings are set apart.
pub fn rows_of(findings: &[ReviewFinding], repos: &[String]) -> ReviewRows {
    todo!()
}

/// The rows of the Review group for the latest review of `record`, repositories in the order of
/// the record's commit map (by name). A record with no review has no rows.
pub fn review_rows(record: &ReviewRecord) -> ReviewRows {
    todo!()
}

/// The same rows with the repositories in the order of `repos` (the build's order).
pub fn review_rows_in(record: &ReviewRecord, repos: &[String]) -> ReviewRows {
    todo!()
}

/// The groups of the round dialog: the Review group's, in its order.
pub fn round_groups(offer: &RoundOffer, rows: &ReviewRows) -> Vec<RoundGroup> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::ParsedReviewSection;

    fn f(id: &str, severity: Option<RoundSeverity>, repo: Option<&str>) -> ReviewFinding {
        ReviewFinding {
            id: Some(id.into()),
            severity,
            text: format!("Text of {id}."),
            file: None,
            line: None,
            repo: repo.map(Into::into),
            concern: None,
            rule: None,
        }
    }

    /// A finding for the rows tests, whose text is `Finding <id>.`.
    fn g(id: &str, severity: Option<RoundSeverity>, repo: Option<&str>) -> ReviewFinding {
        ReviewFinding {
            text: format!("Finding {id}."),
            ..f(id, severity, repo)
        }
    }

    fn with(
        mut finding: ReviewFinding,
        file: Option<&str>,
        line: Option<u32>,
        concern: Option<Concern>,
        text: &str,
    ) -> ReviewFinding {
        finding.file = file.map(Into::into);
        finding.line = line;
        finding.concern = concern;
        finding.text = text.into();
        finding
    }

    /// An id-less finding.
    fn bare(severity: Option<RoundSeverity>, text: &str, repo: Option<&str>) -> ReviewFinding {
        ReviewFinding {
            id: None,
            severity,
            text: text.into(),
            file: None,
            line: None,
            repo: repo.map(Into::into),
            concern: None,
            rule: None,
        }
    }

    use RoundSeverity::{Critical, High, Low, Medium};

    fn review() -> Vec<ReviewFinding> {
        vec![
            with(
                f("F1", Some(High), Some("catalog-api")),
                Some("src/Upload.cs"),
                Some(12),
                Some(Concern::Bug),
                "Upload ignores the size limit.\nIt accepts 20 MB.",
            ),
            with(
                f("F2", Some(Medium), Some("catalog-api")),
                Some("src/List.cs"),
                Some(40),
                None,
                "Listing is not paged.",
            ),
            with(
                f("F3", Some(Medium), Some("catalog-api")),
                Some("src/Price.cs"),
                None,
                Some(Concern::Convention),
                "Price uses a float.",
            ),
            with(
                f("F4", Some(Low), Some("catalog-api")),
                Some("src/Name.cs"),
                Some(3),
                None,
                "Name is misspelled.",
            ),
            with(
                f("F5", Some(High), Some("storefront-web")),
                Some("web/cart.ts"),
                Some(7),
                Some(Concern::Spec),
                "Cart loses items on reload.",
            ),
            with(
                f("F6", Some(Medium), Some("storefront-web")),
                Some("web/page.ts"),
                Some(9),
                None,
                "Page title is empty.",
            ),
            with(
                f("F7", Some(Low), Some("storefront-web")),
                Some("web/css.ts"),
                Some(1),
                None,
                "Color is off by one shade.",
            ),
            with(
                f("F8", Some(Medium), None),
                None,
                None,
                None,
                "Logging is missing.",
            ),
        ]
    }

    fn repos() -> Vec<String> {
        ["ai-sdlc", "catalog-api", "storefront-web"]
            .map(String::from)
            .to_vec()
    }

    fn offer_review() -> RoundOffer {
        offer_of(Some((Some(2), &review())), &repos())
    }

    fn picks(keys: &[&str]) -> RoundPicks {
        RoundPicks {
            picked: keys.iter().map(|k| k.to_string()).collect(),
            ..RoundPicks::default()
        }
    }

    fn note(mut p: RoundPicks, repo: &str, text: &str) -> RoundPicks {
        p.notes.insert(repo.into(), text.into());
        p
    }

    fn assign(mut p: RoundPicks, key: &str, repo: &str) -> RoundPicks {
        p.assigned.insert(key.into(), repo.into());
        p
    }

    fn picked_keys(p: &RoundPicks) -> Vec<&str> {
        p.picked.iter().map(String::as_str).collect()
    }

    // build-round.spec.ts

    #[test]
    fn lists_no_findings_without_a_review_r5_6() {
        let o = offer_of(None, &repos());
        assert!(o.findings.is_empty());
        assert_eq!(o.review, None);
        assert_eq!(o.repos, repos());
    }

    #[test]
    fn keys_a_finding_without_an_id_by_its_place_in_the_list() {
        let list = [
            bare(Some(Low), "a", None),
            ReviewFinding {
                id: Some("X".into()),
                ..bare(Some(High), "b", None)
            },
        ];
        let o = offer_of(Some((None, &list)), &repos());
        let keys: Vec<_> = o.findings.iter().map(|x| x.key.as_str()).collect();
        assert_eq!(keys, ["#1", "X"]);
        assert_eq!(o.findings[0].repo, None);
    }

    #[test]
    fn picks_high_and_medium_by_default_r5_1() {
        assert_eq!(
            picked_keys(&default_picks(&offer_review())),
            ["F1", "F2", "F3", "F5", "F6", "F8"]
        );
    }

    #[test]
    fn picks_critical_and_leaves_a_finding_without_severity_unpicked() {
        let list = [
            ReviewFinding {
                id: Some("C".into()),
                ..bare(Some(Critical), "a", None)
            },
            ReviewFinding {
                id: Some("N".into()),
                ..bare(None, "b", None)
            },
        ];
        let o = offer_of(Some((Some(1), &list)), &repos());
        assert_eq!(picked_keys(&default_picks(&o)), ["C"]);
    }

    #[test]
    fn sends_the_changed_picks_to_the_repository_r5_2() {
        let p = plan(&offer_review(), &picks(&["F1", "F3", "F4"]));
        assert_eq!(p.blocked, None);
        assert_eq!(p.requests.len(), 1);
        assert_eq!(p.requests[0].repo, "catalog-api");
        assert_eq!(
            p.requests[0].instructions,
            [
                "Fix these findings from review 2 of this change in this repository.",
                "- F1 (high, bug) src/Upload.cs:12",
                "  Upload ignores the size limit.",
                "  It accepts 20 MB.",
                "- F3 (medium, convention) src/Price.cs",
                "  Price uses a float.",
                "- F4 (low) src/Name.cs:3",
                "  Name is misspelled.",
            ]
            .join("\n")
        );
    }

    #[test]
    fn blocks_on_a_picked_finding_with_no_repository_until_one_is_chosen_r5_3() {
        let blocked = plan(&offer_review(), &picks(&["F1", "F8"]));
        assert_eq!(
            blocked.blocked.as_deref(),
            Some("Choose a repository for F8.")
        );
        assert!(blocked.requests.is_empty());
        let ok = plan(
            &offer_review(),
            &assign(picks(&["F1", "F8"]), "F8", "storefront-web"),
        );
        assert_eq!(ok.blocked, None);
        let repos: Vec<_> = ok.requests.iter().map(|r| r.repo.as_str()).collect();
        assert_eq!(repos, ["catalog-api", "storefront-web"]);
        assert_eq!(
            ok.requests[1].instructions,
            [
                "Fix these findings from review 2 of this change in this repository.",
                "- F8 (medium)",
                "  Logging is missing.",
            ]
            .join("\n")
        );
    }

    #[test]
    fn names_every_picked_finding_without_a_repository_in_list_order() {
        let list = [
            ReviewFinding {
                id: Some("F8".into()),
                ..bare(Some(High), "a", None)
            },
            ReviewFinding {
                id: Some("F9".into()),
                ..bare(Some(High), "b", None)
            },
        ];
        let o = offer_of(Some((Some(1), &list)), &repos());
        assert_eq!(
            plan(&o, &picks(&["F9", "F8"])).blocked.as_deref(),
            Some("Choose a repository for F8, F9.")
        );
    }

    #[test]
    fn says_exactly_which_agents_start_and_what_each_fixes_r5_4() {
        let p = plan(&offer_review(), &picks(&["F1", "F3", "F5", "F6"]));
        let summaries: Vec<_> = p.requests.iter().map(|r| r.summary.as_str()).collect();
        assert_eq!(
            summaries,
            ["catalog-api · F1, F3", "storefront-web · F5, F6"]
        );
    }

    #[test]
    fn cannot_start_with_nothing_picked_and_no_note_r5_5() {
        let p = plan(&offer_review(), &note(picks(&[]), "catalog-api", "   "));
        assert_eq!(
            p.blocked.as_deref(),
            Some("Pick a finding or write a note.")
        );
        assert!(p.requests.is_empty());
    }

    #[test]
    fn starts_an_agent_for_a_note_alone_r6_1() {
        let p = plan(
            &offer_review(),
            &note(
                picks(&[]),
                "storefront-web",
                "  Rename the upload button to Add photos  ",
            ),
        );
        assert_eq!(p.blocked, None);
        assert_eq!(
            p.requests,
            [RoundRequest {
                repo: "storefront-web".into(),
                instructions: "Also from the engineer:\nRename the upload button to Add photos"
                    .into(),
                summary: "storefront-web · with a note".into(),
            }]
        );
    }

    #[test]
    fn puts_the_note_after_the_findings_r6_2() {
        let p = plan(
            &offer_review(),
            &note(picks(&["F1"]), "catalog-api", "Keep the 8 MB limit"),
        );
        assert_eq!(
            p.requests[0].instructions,
            [
                "Fix these findings from review 2 of this change in this repository.",
                "- F1 (high, bug) src/Upload.cs:12",
                "  Upload ignores the size limit.",
                "  It accepts 20 MB.",
                "",
                "Also from the engineer:",
                "Keep the 8 MB limit",
            ]
            .join("\n")
        );
        assert_eq!(p.requests[0].summary, "catalog-api · F1 · with a note");
    }

    #[test]
    fn names_the_latest_review_when_the_offer_has_no_number() {
        let list = [ReviewFinding {
            id: Some("F1".into()),
            ..bare(Some(High), "Broken.", Some("catalog-api"))
        }];
        let o = offer_of(Some((None, &list)), &repos());
        assert_eq!(
            plan(&o, &picks(&["F1"])).requests[0].instructions,
            [
                "Fix these findings from the latest review of this change in this repository.",
                "- F1 (high)",
                "  Broken.",
            ]
            .join("\n")
        );
    }

    #[test]
    fn keeps_the_master_repository_first_in_offer_order_r5_7() {
        let list = [ReviewFinding {
            id: Some("F1".into()),
            ..bare(Some(High), "x", Some("ai-sdlc"))
        }];
        let o = offer_of(Some((Some(1), &list)), &repos());
        let p = plan(&o, &note(picks(&["F1"]), "catalog-api", "n"));
        let repos: Vec<_> = p.requests.iter().map(|r| r.repo.as_str()).collect();
        assert_eq!(repos, ["ai-sdlc", "catalog-api"]);
    }

    #[test]
    fn tells_a_repository_nothing_about_other_repositories_findings_r7_2() {
        let p = plan(&offer_review(), &picks(&["F1", "F3", "F5"]));
        let text = &p.requests[0].instructions;
        assert!(text.contains("Upload ignores the size limit.\n  It accepts 20 MB."));
        assert!(text.contains("Price uses a float."));
        assert!(!text.contains("F5"));
        assert!(!text.contains("Cart loses items on reload."));
    }

    #[test]
    fn leaves_an_unpicked_finding_out_of_every_request_r9_1() {
        let p = plan(
            &offer_review(),
            &note(picks(&["F1", "F5"]), "catalog-api", "n"),
        );
        assert_eq!(p.blocked, None);
        let catalog = p.requests.iter().find(|r| r.repo == "catalog-api").unwrap();
        let storefront = p
            .requests
            .iter()
            .find(|r| r.repo == "storefront-web")
            .unwrap();
        assert!(catalog
            .instructions
            .contains("- F1 (high, bug) src/Upload.cs:12"));
        assert!(storefront
            .instructions
            .contains("- F5 (high, spec) web/cart.ts:7"));
        let all: Vec<_> = p.requests.iter().map(|r| r.instructions.as_str()).collect();
        let all = all.join("\n");
        assert!(!all.contains("F4"));
        assert!(!all.contains("Name is misspelled."));
        let summaries: Vec<_> = p.requests.iter().map(|r| r.summary.as_str()).collect();
        let summaries = summaries.join("\n");
        assert_eq!(
            summaries,
            "catalog-api · F1 · with a note\nstorefront-web · F5"
        );
        assert!(!summaries.contains("F4"));
    }

    fn outside_offer() -> RoundOffer {
        let outside = ReviewFinding {
            text: "Legacy call is unchecked.".into(),
            ..f("F9", Some(High), Some("legacy-api"))
        };
        offer_of(
            Some((Some(3), &[outside])),
            &["ai-sdlc".to_string(), "catalog-api".to_string()],
        )
    }

    #[test]
    fn is_offered_with_no_repository_like_a_finding_that_names_none_and_picked_by_default() {
        let o = outside_offer();
        let repos: Vec<_> = o.findings.iter().map(|x| x.repo.clone()).collect();
        assert_eq!(repos, [None]);
        assert_eq!(picked_keys(&default_picks(&o)), ["F9"]);
    }

    #[test]
    fn blocks_the_round_until_a_repository_is_chosen() {
        let p = plan(&outside_offer(), &picks(&["F9"]));
        assert_eq!(p.blocked.as_deref(), Some("Choose a repository for F9."));
        assert!(p.requests.is_empty());
    }

    #[test]
    fn is_sent_to_the_repository_chosen_for_it() {
        let p = plan(
            &outside_offer(),
            &assign(picks(&["F9"]), "F9", "catalog-api"),
        );
        assert_eq!(p.blocked, None);
        assert_eq!(
            p.requests,
            [RoundRequest {
                repo: "catalog-api".into(),
                instructions: "Fix these findings from review 3 of this change in this repository.\n- F9 (high)\n  Legacy call is unchecked.".into(),
                summary: "catalog-api · F9".into(),
            }]
        );
    }

    // build-task-list.spec.ts: reviewRows

    fn rows_review() -> Vec<ReviewFinding> {
        vec![
            g("F1", Some(High), Some("catalog-api")),
            g("F5", Some(High), Some("storefront-web")),
            g("F2", Some(Medium), Some("catalog-api")),
            g("F3", Some(Medium), Some("catalog-api")),
            g("F6", Some(Medium), Some("storefront-web")),
            g("F8", Some(Medium), None),
            g("F4", Some(Low), Some("catalog-api")),
            g("F7", Some(Low), Some("storefront-web")),
        ]
    }

    fn two() -> Vec<String> {
        vec!["catalog-api".into(), "storefront-web".into()]
    }

    fn keys(rows: &[ReviewRow]) -> Vec<&str> {
        rows.iter().map(|r| r.key.as_str()).collect()
    }

    fn count(severity: RoundSeverity, n: u32) -> SeverityCount {
        SeverityCount { severity, n }
    }

    #[test]
    fn counts_the_severities_present_most_serious_first_and_the_total_r4_1() {
        let v = rows_of(&rows_review(), &two());
        assert_eq!(v.counts, [count(High, 2), count(Medium, 4), count(Low, 2)]);
        assert_eq!(v.total, 8);
    }

    #[test]
    fn keeps_the_group_order_with_the_findings_naming_no_repository_last_r4_5() {
        let v = rows_of(&rows_review(), &two());
        let repos: Vec<_> = v.groups.iter().map(|g| g.repo.as_deref()).collect();
        assert_eq!(repos, [Some("catalog-api"), Some("storefront-web"), None]);
        assert_eq!(keys(&v.groups[2].rows), ["F8"]);
    }

    #[test]
    fn lists_a_group_high_first_then_medium_and_sets_the_low_findings_apart_r4_1_r4_2() {
        let v = rows_of(&rows_review(), &two());
        assert_eq!(keys(&v.groups[0].rows), ["F1", "F2", "F3"]);
        assert_eq!(keys(&v.groups[0].low), ["F4"]);
    }

    #[test]
    fn sorts_critical_first_and_a_finding_with_no_severity_after_the_medium_ones_stable_within_a_severity(
    ) {
        let list = [
            g("A", None, Some("r")),
            g("B", Some(Medium), Some("r")),
            g("C", Some(Critical), Some("r")),
            g("D", Some(Medium), Some("r")),
            g("E", Some(High), Some("r")),
        ];
        let v = rows_of(&list, &["r".to_string()]);
        assert_eq!(keys(&v.groups[0].rows), ["C", "E", "B", "D", "A"]);
        assert_eq!(
            v.counts,
            [count(Critical, 1), count(High, 1), count(Medium, 2)]
        );
        assert_eq!(v.total, 5);
    }

    #[test]
    fn summarizes_with_the_first_sentence_or_the_whole_text_when_there_is_none() {
        let list = [
            ReviewFinding {
                id: Some("A".into()),
                ..bare(
                    Some(High),
                    "The limit is wrong. It also loops forever.",
                    None,
                )
            },
            ReviewFinding {
                id: Some("B".into()),
                ..bare(Some(High), "No full stop here", None)
            },
            ReviewFinding {
                id: Some("C".into()),
                ..bare(Some(High), "First line\nsecond line", None)
            },
        ];
        let v = rows_of(&list, &[]);
        let summaries: Vec<_> = v.groups[0]
            .rows
            .iter()
            .map(|r| r.summary.as_str())
            .collect();
        assert_eq!(
            summaries,
            ["The limit is wrong.", "No full stop here", "First line"]
        );
    }

    #[test]
    fn keys_a_finding_by_its_id_else_by_its_place_in_the_review_as_hash_n() {
        let list = [
            bare(Some(Low), "one", Some("b")),
            bare(Some(High), "two", Some("a")),
            ReviewFinding {
                id: Some("F9".into()),
                ..bare(Some(High), "three", Some("a"))
            },
        ];
        let v = rows_of(&list, &["a".to_string(), "b".to_string()]);
        assert_eq!(keys(&v.groups[0].rows), ["#2", "F9"]);
        assert_eq!(keys(&v.groups[1].low), ["#1"]);
    }

    #[test]
    fn an_empty_review_has_no_counts_and_no_rows() {
        let v = rows_of(&[], &[]);
        assert_eq!(
            v,
            ReviewRows {
                counts: vec![],
                total: 0,
                groups: vec![]
            }
        );
    }

    // New for this change.

    fn parsed(id: &str, severity: Severity, repo: &str) -> ParsedFinding {
        ParsedFinding {
            id: id.into(),
            severity,
            file: "src/a.rs".into(),
            line: 4,
            text: format!("Problem {id}. More."),
            repo: Some(repo.into()),
            concern: Some(Concern::Bug),
            rule: None,
        }
    }

    fn record() -> ReviewRecord {
        ReviewRecord {
            layout: 2,
            reviews: vec![
                ParsedReviewSection {
                    number: 1,
                    reviewed_at: "2026-10-30".into(),
                    commits: BTreeMap::new(),
                    findings: vec![parsed("F1", Severity::High, "kata")],
                },
                ParsedReviewSection {
                    number: 2,
                    reviewed_at: "2026-10-31".into(),
                    commits: BTreeMap::new(),
                    findings: vec![
                        parsed("F1", Severity::Low, "kata"),
                        parsed("F2", Severity::High, "bob"),
                        parsed("F3", Severity::Medium, "kata"),
                        parsed("F4", Severity::Low, "bob"),
                    ],
                },
            ],
            problems: vec![],
            master_moved: vec![],
        }
    }

    #[test]
    fn review_rows_are_the_same_for_the_same_review() {
        let (a, b) = (review_rows(&record()), review_rows(&record()));
        assert_eq!(a, b);
        assert_eq!(a.total, 4);
        assert_eq!(a.counts, [count(High, 1), count(Medium, 1), count(Low, 2)]);
        assert_eq!(keys(&a.groups[0].low), ["F1"]);
        assert_eq!(keys(&a.groups[1].low), ["F4"]);
    }

    #[test]
    fn the_round_offer_and_default_picks_are_the_same_on_every_read() {
        let repos = vec!["kata".to_string(), "bob".to_string()];
        let (a, b) = (
            offer(Some(&record()), &repos),
            offer(Some(&record()), &repos),
        );
        assert_eq!(a, b);
        assert_eq!(a.review, Some(2));
        assert_eq!(default_picks(&a), default_picks(&b));
        assert_eq!(picked_keys(&default_picks(&a)), ["F2", "F3"]);
        assert_eq!(offer(None, &repos).review, None);
    }
}
