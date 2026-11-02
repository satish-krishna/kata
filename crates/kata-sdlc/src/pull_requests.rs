//! The pull requests a change was declared done with, as the change shows them: the program's record in
//! `change.yml` first, else what Kata saved before the program recorded them.
use crate::ai_sdlc::show::ChangeShow;
use crate::ai_sdlc::status::Status;
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

/// Whether the plugin's `change.done` passed for the change, from its ledger (`status --json`).
pub fn declared_done(_status: &Status) -> bool {
    false
}

/// The pull requests as the page shows them, from `show` (read with or without `--refresh`) and the
/// `legacy` entries. `declared` is [`declared_done`] of the change's ledger.
pub fn view(show: &ChangeShow, legacy: &[PrEntry], _declared: bool) -> PullRequestsView {
    let recorded = recorded(show, legacy);
    let source = recorded.first().map(|p| p.source);
    let links = recorded
        .into_iter()
        .enumerate()
        .map(|(i, p)| match p.source {
            // An earlier declaration: the state Kata saved, last seen when it was saved. Only `gh` could ask
            // GitHub, and the plugin does not know these pull requests.
            PullRequestSource::Legacy => PullRequestLink {
                state: Some(legacy[i].state),
                last_seen: true,
                seen_at: Some(legacy[i].seen_at),
                repo: p.repo,
                url: p.url,
                number: p.number,
                source: p.source,
            },
            PullRequestSource::Plugin => {
                let asked = show.states.as_ref().map(|s| s.get(&p.url));
                let state = asked
                    .flatten()
                    .and_then(|s| s.as_deref())
                    .and_then(state_of);
                PullRequestLink {
                    state,
                    // The plugin was asked and gave no state for this one.
                    last_seen: asked.is_some() && state.is_none(),
                    seen_at: None,
                    repo: p.repo,
                    url: p.url,
                    number: p.number,
                    source: p.source,
                }
            }
        })
        .collect::<Vec<_>>();
    PullRequestsView {
        // The plugin records the master's pull request last: until it is there, the declaration stopped part way.
        done: match source {
            Some(PullRequestSource::Plugin) => links.iter().any(|l| l.repo == "master"),
            Some(PullRequestSource::Legacy) => true,
            None => false,
        },
        declare_offered: source != Some(PullRequestSource::Legacy),
        source,
        links,
    }
}

/// `OPEN`, `MERGED` or `CLOSED`, as `change show --refresh` prints them.
fn state_of(state: &str) -> Option<PrStateKind> {
    match state {
        "OPEN" => Some(PrStateKind::Open),
        "MERGED" => Some(PrStateKind::Merged),
        "CLOSED" => Some(PrStateKind::Closed),
        _ => None,
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
        let now = view(&recorded, &[], false);
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
            false,
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
        let got = view(&show(vec![]), &earlier, false);
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
        let again = view(&asked, &earlier, false);
        assert_eq!(again.links[0].state, Some(PrStateKind::Merged));
        assert!(again.links[0].last_seen);
        // A change with no change.yml at all shows the same.
        let mut bare = show(vec![]);
        bare.record = None;
        assert!(view(&bare, &earlier, false).done);
        // Neither record: not done, nothing to show, declaring done is offered.
        let none = view(&bare, &[], false);
        assert!(!none.done && none.links.is_empty() && none.declare_offered);
        assert_eq!(none.source, None);
    }

    /// R8.2: a change with a legacy entry and pull requests in `change.yml` shows only `change.yml`'s; it
    /// is done once the plugin's `change.done` passed, and declaring done stays offered until then.
    #[test]
    fn a_new_declaration_reads_only_change_yml() {
        let both = view(
            &show(vec![plugin("app", 7), plugin("master", 8)]),
            &[legacy("old", 3)],
            true,
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
        let partial = view(&show(vec![plugin("app", 7)]), &[legacy("old", 3)], false);
        assert_eq!(partial.links.len(), 1);
        assert_eq!(partial.links[0].repo, "app");
        assert!(!partial.done);
        assert!(partial.declare_offered);
    }

    fn ledger(runs: &[(&str, &str)]) -> Status {
        serde_json::from_value(serde_json::json!({
            "system": "s",
            "change": "2026-11-01-c",
            "repos": [{
                "repo": "master",
                "path": "D:/ws/ai-sdlc",
                "head": "abc",
                "runs": runs.iter().map(|(event, outcome)| serde_json::json!({
                    "event": event, "key": "abc", "outcome": outcome, "hooks": [], "problems": [], "failed": null,
                })).collect::<Vec<_>>(),
            }],
        }))
        .unwrap()
    }

    /// R7.1 row 3: the plugin records the master's pull request in change.yml before its final push of the
    /// master. When that push fails, `change.done` failed: the change is not done and declaring done again
    /// is offered to carry on.
    #[test]
    fn a_failed_final_push_is_not_done_and_offers_declaring_again() {
        let recorded = show(vec![plugin("app", 7), plugin("master", 8)]);
        let status = ledger(&[("build.finish", "passed"), ("change.done", "failed")]);
        let got = view(&recorded, &[], declared_done(&status));
        assert!(!got.done, "the master's pull request alone is not done");
        assert!(got.declare_offered);
        assert_eq!(got.links.len(), 2, "what was opened still shows");
        // Declared again, it passed: now it is done.
        let status = ledger(&[("change.done", "failed"), ("change.done", "passed")]);
        assert!(declared_done(&status));
        assert!(view(&recorded, &[], declared_done(&status)).done);
        // No ledger at all: not done.
        assert!(!declared_done(&Status { repos: vec![] }));
    }

    /// R8.1: a change declared done before this change has no `change.done` in the ledger and still shows as done.
    #[test]
    fn an_earlier_declaration_is_done_with_no_change_done_in_the_ledger() {
        let status = Status { repos: vec![] };
        let got = view(&show(vec![]), &[legacy("old", 3)], declared_done(&status));
        assert!(got.done);
        assert!(!got.declare_offered);
    }
}
