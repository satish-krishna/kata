//! The pull requests a change was declared done with, as the change shows them: the program's record in
//! `change.yml` first, else what Kata saved before the program recorded them.
use crate::ai_sdlc::show::ChangeShow;
use crate::prs::{PrEntry, PrStateKind};
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
    let plugin = show
        .record
        .iter()
        .flat_map(|r| &r.pull_requests)
        .map(|p| RecordedPullRequest {
            repo: p.repo.clone(),
            url: p.url.clone(),
            number: p.number,
            source: PullRequestSource::Plugin,
        })
        .collect::<Vec<_>>();
    if !plugin.is_empty() {
        return plugin;
    }
    legacy
        .iter()
        .map(|e| RecordedPullRequest {
            repo: e.repo.clone(),
            url: e.url.clone(),
            number: e.number,
            source: PullRequestSource::Legacy,
        })
        .collect()
}

/// A pull request as the change page shows it: the link, and what GitHub said about it when the plugin last read it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PullRequestLink {
    pub repo: String,
    pub url: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub number: u64,
    pub source: PullRequestSource,
    /// None until the plugin has read it, and when it could not.
    pub state: Option<PrStateKind>,
    /// The state, if any, is not from the read just made: it was saved earlier, or the plugin could not read it now.
    pub last_seen: bool,
    /// When a saved state was seen, in seconds; only for an earlier declaration.
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub seen_at: Option<u64>,
}

/// What the change page shows of a change's pull requests.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PullRequestsView {
    /// The change was declared done: it shows as done and has no actions left.
    pub done: bool,
    /// Whose record the links come from; none when there are no links.
    pub source: Option<PullRequestSource>,
    pub links: Vec<PullRequestLink>,
    /// Declaring done may be offered; false for a change an earlier version of Kata declared done.
    pub declare_offered: bool,
}

/// The pull requests as the page shows them, from `show` (read with or without `--refresh`) and the
/// `legacy` entries.
pub fn view(show: &ChangeShow, legacy: &[PrEntry]) -> PullRequestsView {
    let _ = (show, legacy);
    PullRequestsView {
        done: false,
        source: None,
        links: Vec::new(),
        declare_offered: true,
    }
}

/// What Kata saved in `pull-requests.json` for the change, before the plugin recorded pull requests.
pub fn legacy_entries(workspace_id: &str, system: &str, change: &str) -> Vec<PrEntry> {
    crate::store::load_pr_records()
        .into_iter()
        .find(|r| r.workspace_id == workspace_id && r.system == system && r.change == change)
        .map(|r| r.repos)
        .unwrap_or_default()
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

    fn with_states(mut s: ChangeShow, states: &[(&str, Option<&str>)]) -> ChangeShow {
        s.states = Some(
            states
                .iter()
                .map(|(url, state)| (url.to_string(), state.map(String::from)))
                .collect(),
        );
        s
    }

    fn url(repo: &str, number: u64) -> String {
        format!("https://github.com/o/{repo}/pull/{number}")
    }

    /// R7.4: the links show at once from the record, with no state; each state fills in when the plugin has
    /// read it, and a pull request it could not read keeps no state of its own and is marked last seen.
    #[test]
    fn links_show_at_once_and_states_fill_in() {
        let recorded = show(vec![
            plugin("app", 7),
            plugin("lib", 8),
            plugin("web", 9),
            plugin("old", 10),
            plugin("master", 11),
        ]);
        // At once: every link, the master's last, none with a state and none marked last seen.
        let now = view(&recorded, &[]);
        assert_eq!(now.source, Some(PullRequestSource::Plugin));
        assert_eq!(
            now.links
                .iter()
                .map(|l| l.repo.as_str())
                .collect::<Vec<_>>(),
            ["app", "lib", "web", "old", "master"]
        );
        assert!(now.links.iter().all(|l| l.state.is_none() && !l.last_seen));
        // Filled in, one row each: OPEN, MERGED, CLOSED, and null (gh could not read it).
        let filled = view(
            &with_states(
                recorded,
                &[
                    (&url("app", 7), Some("OPEN")),
                    (&url("lib", 8), Some("MERGED")),
                    (&url("web", 9), Some("CLOSED")),
                    (&url("old", 10), None),
                    (&url("master", 11), Some("OPEN")),
                ],
            ),
            &[],
        );
        let got: Vec<(&str, Option<PrStateKind>, bool)> = filled
            .links
            .iter()
            .map(|l| (l.repo.as_str(), l.state, l.last_seen))
            .collect();
        assert_eq!(
            got,
            [
                ("app", Some(PrStateKind::Open), false),
                ("lib", Some(PrStateKind::Merged), false),
                ("web", Some(PrStateKind::Closed), false),
                ("old", None, true),
                ("master", Some(PrStateKind::Open), false),
            ]
        );
        // The same links and the same order as at once.
        assert_eq!(
            filled.links.iter().map(|l| &l.url).collect::<Vec<_>>(),
            now.links.iter().map(|l| &l.url).collect::<Vec<_>>()
        );
    }

    /// R8.1: a change an earlier version of Kata declared done shows as done with its links, shows the
    /// state it saved as last seen whatever GitHub is asked, and is not offered declaring done.
    #[test]
    fn an_earlier_declaration_still_shows_as_done() {
        let earlier = [legacy("old", 3), legacy("older", 4)];
        let got = view(&show(vec![]), &earlier);
        assert!(got.done);
        assert!(!got.declare_offered);
        assert_eq!(got.source, Some(PullRequestSource::Legacy));
        assert_eq!(
            got.links
                .iter()
                .map(|l| (l.repo.as_str(), l.number, l.state, l.last_seen, l.seen_at))
                .collect::<Vec<_>>(),
            [
                ("old", 3, Some(PrStateKind::Merged), true, Some(1)),
                ("older", 4, Some(PrStateKind::Merged), true, Some(1)),
            ]
        );
        // The plugin does not know these pull requests, so a refresh does not touch them.
        let asked = with_states(show(vec![]), &[(&url("old", 3), Some("OPEN"))]);
        let again = view(&asked, &earlier);
        assert_eq!(again.links[0].state, Some(PrStateKind::Merged));
        assert!(again.links[0].last_seen);
        // A change with no change.yml at all shows the same.
        let mut bare = show(vec![]);
        bare.record = None;
        assert!(view(&bare, &earlier).done);
        // Neither record: not done, nothing to show, declaring done is offered.
        let none = view(&bare, &[]);
        assert!(!none.done && none.links.is_empty() && none.declare_offered);
        assert_eq!(none.source, None);
    }

    /// R8.2: a change with a legacy entry and pull requests in `change.yml` shows only `change.yml`'s; it
    /// is done once the plugin recorded the master's, and declaring done stays offered while that is missing.
    #[test]
    fn a_new_declaration_reads_only_change_yml() {
        let both = view(
            &show(vec![plugin("app", 7), plugin("master", 8)]),
            &[legacy("old", 3)],
        );
        assert_eq!(both.source, Some(PullRequestSource::Plugin));
        assert_eq!(
            both.links
                .iter()
                .map(|l| l.repo.as_str())
                .collect::<Vec<_>>(),
            ["app", "master"]
        );
        assert!(both.done);
        assert!(both.declare_offered);
        // The plugin writes the master's last: without it the declaration stopped part way.
        let partial = view(&show(vec![plugin("app", 7)]), &[legacy("old", 3)]);
        assert_eq!(partial.links.len(), 1);
        assert_eq!(partial.links[0].repo, "app");
        assert!(!partial.done);
        assert!(partial.declare_offered);
    }
}
