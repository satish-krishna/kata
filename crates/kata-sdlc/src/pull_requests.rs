//! The pull requests a change was declared done with, as the change shows them: the program's record in
//! `change.yml` first, else what Kata saved before the program recorded them.
use crate::ai_sdlc::show::ChangeShow;
use crate::prs::PrEntry;
use serde::Serialize;

/// Whose record a pull request comes from.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum PullRequestSource {
    /// `change.yml`, written by the program.
    Plugin,
    /// `pull-requests.json`, saved by Kata before the program recorded pull requests.
    Legacy,
}

/// A pull request the change recorded.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RecordedPullRequest {
    pub repo: String,
    pub url: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub number: u64,
    pub source: PullRequestSource,
}

/// The change's pull requests: those in `change.yml` when there are any, else the `legacy` entries of
/// Kata's earlier record, else none.
pub fn recorded(show: &ChangeShow, legacy: &[PrEntry]) -> Vec<RecordedPullRequest> {
    let _ = (show, legacy);
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_sdlc::show::{ChangeRecord, RecordedByPlugin};
    use crate::prs::PrStateKind;

    fn show(pull_requests: Vec<RecordedByPlugin>) -> ChangeShow {
        ChangeShow {
            change: "2026-11-01-c".into(),
            system: "s".into(),
            branch: "change/2026-11-01-c".into(),
            record: Some(ChangeRecord {
                branch: "change/2026-11-01-c".into(),
                work_type: "feat".into(),
                scope: "s".into(),
                base: "main".into(),
                pull_requests,
            }),
            repos: Default::default(),
            states: None,
        }
    }

    fn legacy(repo: &str, number: u64) -> PrEntry {
        PrEntry {
            repo: repo.into(),
            url: format!("https://github.com/o/{repo}/pull/{number}"),
            number,
            branch: "change/2026-11-01-c".into(),
            pushed_head: "abc1234".into(),
            state: PrStateKind::Merged,
            seen_at: 1,
        }
    }

    fn plugin(repo: &str, number: u64) -> RecordedByPlugin {
        RecordedByPlugin {
            repo: repo.into(),
            url: format!("https://github.com/o/{repo}/pull/{number}"),
            number,
            pushed: "3f2a9c1".into(),
        }
    }

    #[test]
    fn recorded_prefers_change_yml_then_legacy() {
        // change.yml has pull requests: they win, and the legacy entries are not mixed in.
        let got = recorded(&show(vec![plugin("app", 7)]), &[legacy("old", 3)]);
        assert_eq!(
            got,
            [RecordedPullRequest {
                repo: "app".into(),
                url: "https://github.com/o/app/pull/7".into(),
                number: 7,
                source: PullRequestSource::Plugin,
            }]
        );
        // change.yml has none: Kata's earlier record is read, in its own order.
        let got = recorded(&show(vec![]), &[legacy("old", 3), legacy("older", 4)]);
        assert_eq!(
            got.iter()
                .map(|p| (p.repo.as_str(), p.number, p.source))
                .collect::<Vec<_>>(),
            [
                ("old", 3, PullRequestSource::Legacy),
                ("older", 4, PullRequestSource::Legacy)
            ]
        );
        // A change with no change.yml reads the earlier record the same way.
        let mut bare = show(vec![]);
        bare.record = None;
        assert_eq!(recorded(&bare, &[legacy("old", 3)]).len(), 1);
        // Neither: none.
        assert!(recorded(&bare, &[]).is_empty());
    }
}
