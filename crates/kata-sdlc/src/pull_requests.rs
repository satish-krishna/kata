//! The pull requests a change was declared done with, as the change shows them: the program's record in
//! `change.yml` first, else what Kata saved before the program recorded them.
use crate::ai_sdlc::show::ChangeShow;
use crate::ai_sdlc::status::Status;
use crate::ai_sdlc::{Place, Program};
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

/// Whether this machine's ledger (`status --json`) shows the change's latest `change.done` failed. The plugin
/// records the master's pull request in `change.yml` before its final push of the master, so a failure there
/// leaves it recorded. A clone that never declared has no ledger, and the record alone decides.
///
/// Only a passed or failed run counts: a refused or could-not-run one stopped before it changed anything. Each
/// repository's runs are oldest first, and runs of different repositories are ordered by when they were
/// recorded; on a tie the later one read wins.
pub fn done_failed_here(status: &Status) -> bool {
    status
        .repos
        .iter()
        .flat_map(|r| &r.runs)
        .filter(|run| {
            run.event == "change.done" && matches!(run.outcome.as_str(), "passed" | "failed")
        })
        .max_by(|a, b| a.at.cmp(&b.at))
        .is_some_and(|run| run.outcome == "failed")
}

/// The pull requests as the page shows them, from `show` (read with or without `--refresh`) and the
/// `legacy` entries. `failed_here` is [`done_failed_here`] of this machine's ledger.
pub fn view(show: &ChangeShow, legacy: &[PrEntry], failed_here: bool) -> PullRequestsView {
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
        // An earlier version of Kata recorded the declaration itself. Otherwise the plugin opens the master's
        // pull request last, so its record in `change.yml` says the declaration went all the way, on every
        // clone; only this machine's ledger can say its final push then failed.
        done: match source {
            Some(PullRequestSource::Legacy) => true,
            Some(PullRequestSource::Plugin) => {
                links.iter().any(|l| l.repo == "master") && !failed_here
            }
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

/// The change's pull requests as the page and the home read them: the plugin's record in `change.yml` first,
/// else what an earlier version of Kata saved (only when `workspace_id` is known). With `refresh` the plugin
/// also asks GitHub for each state, which starts `gh` and is slow; pull requests an earlier version of Kata
/// saved are not asked about, since the plugin does not know them. Without it nothing leaves this machine.
pub fn read_view(
    program: &Program,
    place: &Place,
    workspace_id: Option<&str>,
    system: &str,
    change: &str,
    refresh: bool,
) -> Result<PullRequestsView, String> {
    let legacy = workspace_id
        .map(|id| legacy_entries(id, system, change))
        .unwrap_or_default();
    let shown = program
        .change_show(place, change, refresh && legacy.is_empty())
        .map_err(|e| e.to_string())?;
    // A change an earlier version of Kata declared done is done from its record; any other is done once the
    // master's pull request is recorded in `change.yml`, on every clone, unless this machine's ledger shows the
    // latest `change.done` failed (its final push of the master).
    let failed_here = legacy.is_empty()
        && done_failed_here(&program.status(place, change).map_err(|e| e.to_string())?);
    Ok(view(&shown, &legacy, failed_here))
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
    /// is done once the master's pull request is recorded there, whatever machine declared it.
    #[test]
    fn a_new_declaration_reads_only_change_yml() {
        let both = view(
            &show(vec![plugin("app", 7), plugin("master", 8)]),
            &[legacy("old", 3)],
            false,
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

    /// A ledger of `(repo, event, outcome, at)` runs, each repository's runs oldest first as the plugin
    /// appends them.
    fn ledger_of(runs: &[(&str, &str, &str, &str)]) -> Status {
        let mut repos: Vec<(String, Vec<serde_json::Value>)> = Vec::new();
        for (repo, event, outcome, at) in runs {
            let run = serde_json::json!({
                "event": event, "key": "abc", "outcome": outcome, "hooks": [], "problems": [], "failed": null,
                "at": at,
            });
            match repos.iter_mut().find(|(r, _)| r == repo) {
                Some((_, list)) => list.push(run),
                None => repos.push((repo.to_string(), vec![run])),
            }
        }
        serde_json::from_value(serde_json::json!({
            "system": "s",
            "change": "2026-11-01-c",
            "repos": repos.into_iter().map(|(repo, runs)| serde_json::json!({
                "repo": repo, "path": "D:/ws/x", "head": "abc", "runs": runs,
            })).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    /// The master's ledger, its runs recorded one second apart in the order given.
    fn ledger(runs: &[(&str, &str)]) -> Status {
        let times = (0..runs.len())
            .map(|i| format!("2026-11-01T10:00:{i:02}.000Z"))
            .collect::<Vec<_>>();
        ledger_of(
            &runs
                .iter()
                .zip(&times)
                .map(|((event, outcome), at)| ("master", *event, *outcome, at.as_str()))
                .collect::<Vec<_>>(),
        )
    }

    /// The view as this machine shows it, from the recorded pull requests and its ledger, the way
    /// `sdlc_pull_requests_view` reads it.
    fn done_view(recorded: &ChangeShow, legacy: &[PrEntry], status: &Status) -> PullRequestsView {
        view(
            recorded,
            legacy,
            legacy.is_empty() && done_failed_here(status),
        )
    }

    /// R7.1 row 1, R7.1 row 3 and R8.2: done is the master's pull request recorded in `change.yml`, unless
    /// this machine's ledger shows the latest `change.done` failed. The ledger lives only on the clone that
    /// declared, so every other clone reads done from the record alone.
    #[test]
    fn done_is_the_masters_pull_request_unless_the_latest_change_done_failed_here() {
        let recorded = show(vec![plugin("app", 7), plugin("master", 8)]);

        // Recorded, and no ledger on this machine (declared on another clone): done.
        let got = done_view(&recorded, &[], &Status { repos: vec![] });
        assert!(got.done, "a change declared done elsewhere is done here");

        // Recorded, and the latest change.done here passed: done.
        let got = done_view(
            &recorded,
            &[],
            &ledger(&[("change.done", "failed"), ("change.done", "passed")]),
        );
        assert!(got.done);

        // Recorded, and the latest change.done here failed (the final push of the master): not done, and
        // declaring done is offered again to carry on.
        let failed = ledger(&[("build.finish", "passed"), ("change.done", "failed")]);
        assert!(done_failed_here(&failed));
        let got = done_view(&recorded, &[], &failed);
        assert!(!got.done, "a failed final push is not done");
        assert!(got.declare_offered);
        assert_eq!(got.links.len(), 2, "what was opened still shows");
        // An earlier passed declaration does not hide a later failure.
        assert!(done_failed_here(&ledger(&[
            ("change.done", "passed"),
            ("change.done", "failed"),
        ])));

        // The latest is read across repositories by when it was recorded, not by which file came first.
        let across = ledger_of(&[
            (
                "master",
                "change.done",
                "passed",
                "2026-11-01T10:00:05.000Z",
            ),
            ("app", "change.done", "failed", "2026-11-01T10:00:01.000Z"),
        ]);
        assert!(!done_failed_here(&across));
        let across = ledger_of(&[
            ("app", "change.done", "passed", "2026-11-01T10:00:01.000Z"),
            (
                "master",
                "change.done",
                "failed",
                "2026-11-01T10:00:05.000Z",
            ),
        ]);
        assert!(done_failed_here(&across));

        // A refused or could-not-run declaration changed nothing, so the one before it decides.
        assert!(!done_failed_here(&ledger(&[
            ("change.done", "passed"),
            ("change.done", "refused"),
        ])));
        assert!(done_failed_here(&ledger(&[
            ("change.done", "failed"),
            ("change.done", "could-not-run"),
        ])));

        // No pull request recorded for the master: not done, whatever the ledger says.
        let partial = show(vec![plugin("app", 7)]);
        assert!(!done_view(&partial, &[], &Status { repos: vec![] }).done);
        assert!(!done_view(&partial, &[], &ledger(&[("change.done", "passed")])).done);
        assert!(!done_view(&show(vec![]), &[], &Status { repos: vec![] }).done);

        // An earlier declaration (Kata's old record): done, and declaring done is not offered.
        let got = done_view(
            &show(vec![]),
            &[legacy("old", 3)],
            &Status { repos: vec![] },
        );
        assert!(got.done);
        assert!(!got.declare_offered);
    }

    /// R8.1: a change declared done before this change has no `change.done` in the ledger and still shows as done.
    #[test]
    fn an_earlier_declaration_is_done_with_no_change_done_in_the_ledger() {
        let status = Status { repos: vec![] };
        let got = done_view(&show(vec![]), &[legacy("old", 3)], &status);
        assert!(got.done);
        assert!(!got.declare_offered);
    }

    mod read {
        use super::*;
        use crate::testutil;
        use std::path::{Path, PathBuf};

        const SYSTEM: &str = "demo";
        const CHANGE: &str = "2026-11-01-greeting";
        const MARKER: &str = r#"{"version":1,"systems":{"demo":{"repos":["app"]}}}"#;

        fn program() -> Program {
            Program {
                node: "node".into(),
                entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts"),
            }
        }

        struct Fx {
            dir: tempfile::TempDir,
            place: Place,
            copy: PathBuf,
        }

        fn fx() -> Fx {
            let dir = tempfile::tempdir().unwrap();
            let ws = dir.path().to_path_buf();
            let master = testutil::repo(&ws, "ai-sdlc");
            testutil::commit_file(&master, ".ai-sdlc.json", MARKER, "marker");
            testutil::repo(&ws, "app");
            let place = Place {
                master,
                workspace: ws.clone(),
            };
            let started = program()
                .run(
                    &[
                        "change", "start", "--json", "--system", SYSTEM, "--change", CHANGE,
                        "--type", "feat", "--scope", "demo", "--title", "Greeting",
                    ],
                    &place,
                )
                .unwrap();
            assert_eq!(started["outcome"], "passed", "{started}");
            let copy = ws.join(".ai-sdlc").join("copies").join(CHANGE);
            Fx { dir, place, copy }
        }

        impl Fx {
            /// Records pull requests in the change's `change.yml`, as `change.done` would.
            fn record(&self, repos: &[&str]) {
                let file = self
                    .copy
                    .join("intent")
                    .join(SYSTEM)
                    .join(CHANGE)
                    .join("change.yml");
                let mut text = std::fs::read_to_string(&file).unwrap();
                if !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str("pullRequests:\n");
                for (i, repo) in repos.iter().enumerate() {
                    text.push_str(&format!(
                        "  - repo: \"{repo}\"\n    url: \"https://github.com/o/{repo}/pull/{n}\"\n    number: {n}\n    pushed: \"abc1234\"\n",
                        n = i + 1
                    ));
                }
                std::fs::write(file, text).unwrap();
            }

            /// Writes this machine's ledger with one `change.done` run of the given outcome.
            fn ledger(&self, outcome: &str) {
                let common = testutil::run(
                    &self.place.master,
                    &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                )
                .unwrap();
                let folder = Path::new(common.trim())
                    .join("ai-sdlc")
                    .join(SYSTEM)
                    .join(CHANGE);
                std::fs::create_dir_all(&folder).unwrap();
                let ledger = serde_json::json!({
                    "version": 1, "system": SYSTEM, "change": CHANGE, "repo": "master",
                    "path": self.place.master.display().to_string(),
                    "runs": [{
                        "event": "change.done", "repo": "master", "key": "abc", "subject": null,
                        "outcome": outcome, "at": "2026-11-05T10:00:00.000Z",
                        "hooks": [], "problems": [], "failed": null
                    }],
                    "gateBlocks": {}
                });
                std::fs::write(folder.join("master.json"), ledger.to_string()).unwrap();
            }

            fn done(&self) -> bool {
                read_view(&program(), &self.place, None, SYSTEM, CHANGE, false)
                    .unwrap()
                    .done
            }
        }

        #[test]
        fn declared_is_read_from_change_yml_without_github() {
            let fx = fx();
            // A gh that records being started and fails.
            let marker = fx.dir.path().join("gh-started");
            let script = fx.dir.path().join("fake-gh.js");
            std::fs::write(
                &script,
                format!(
                    "require('fs').writeFileSync({:?}, 'x'); process.exit(1);",
                    marker.display().to_string()
                ),
            )
            .unwrap();
            std::env::set_var(
                "AI_SDLC_GH",
                serde_json::json!(["node", script.display().to_string()]).to_string(),
            );

            // No record: not done.
            assert!(!fx.done());
            // The master's pull request recorded: done.
            fx.record(&["app", "master"]);
            assert!(fx.done());
            // The latest change.done failed on this machine: not done.
            fx.ledger("failed");
            assert!(!fx.done());
            // It passed: done again.
            fx.ledger("passed");
            assert!(fx.done());

            assert!(!marker.exists(), "the read started gh");
        }
    }
}
