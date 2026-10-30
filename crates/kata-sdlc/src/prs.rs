//! The pull requests a change was declared done with: what Kata saved, and whether the change
//! shows as done and with which links. Kata keeps no credential here.
use crate::git;
use crate::github::{ApiError, GitHubHosts, PullState};
use crate::publish::{branch_in, open_pull_requests, touched_repos, PrState, PublishRepo};
use crate::store;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A pull request's last-known state.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum PrStateKind {
    Open,
    Merged,
    Closed,
}

/// One repository's pull request, as last seen.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PrEntry {
    pub repo: String,
    pub url: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub number: u64,
    /// The commit the change branch was pushed at.
    pub pushed_head: String,
    pub state: PrStateKind,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub seen_at: u64,
}

/// What `pull-requests.json` keeps for one change.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PrRecord {
    pub workspace_id: String,
    pub system: String,
    pub change: String,
    /// When every touched repository had an entry; none while the set is partial.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub declared_at: Option<u64>,
    pub repos: Vec<PrEntry>,
}

impl PrRecord {
    /// A record with no pull request yet.
    pub fn new(workspace_id: &str, system: &str, change: &str) -> Self {
        PrRecord {
            workspace_id: workspace_id.into(),
            system: system.into(),
            change: change.into(),
            declared_at: None,
            repos: Vec::new(),
        }
    }
}

/// The touched repositories now and where their change branches point.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct BranchFacts {
    pub touched: Vec<String>,
    pub heads: Vec<(String, String)>,
}

/// Where the links of a `DoneView` come from.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum LinksFrom {
    None,
    Saved,
    EarlierDeclaration,
    Opened,
    #[serde(rename = "github")]
    GitHub,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PrLink {
    pub repo: String,
    pub url: String,
    pub state: PrStateKind,
    /// When the state was last seen; none for a state GitHub just gave.
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub seen_at: Option<u64>,
}

/// Whether a change shows as done, with which links, and what the page offers.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct DoneView {
    pub done: bool,
    pub links: Vec<PrLink>,
    pub links_from: LinksFrom,
    /// Declaring done is offered, as for any finished build.
    pub offer_declare: bool,
    pub pr_check_failed: bool,
}

/// Whether a change shows as done and with which links.
pub fn done_view(
    record: Option<&PrRecord>,
    now: &BranchFacts,
    build_finished: bool,
    legacy_open: Option<&[PrState]>,
) -> DoneView {
    let none = |offer_declare: bool, pr_check_failed: bool| DoneView {
        done: false,
        links: Vec::new(),
        links_from: LinksFrom::None,
        offer_declare,
        pr_check_failed,
    };
    let Some(rec) = record.filter(|r| !r.repos.is_empty()) else {
        // No record: today's rule, which asks GitHub only for a finished build.
        if !build_finished {
            return none(false, false);
        }
        return match legacy_open {
            None => none(true, true),
            Some(open) if !open.is_empty() && open.iter().all(|p| p.url.is_some()) => DoneView {
                done: true,
                links: open
                    .iter()
                    .filter_map(|p| {
                        Some(PrLink {
                            repo: p.repo.clone(),
                            url: p.url.clone()?,
                            state: PrStateKind::Open,
                            seen_at: None,
                        })
                    })
                    .collect(),
                links_from: LinksFrom::GitHub,
                offer_declare: false,
                pr_check_failed: false,
            },
            Some(_) => none(true, false),
        };
    };
    let links: Vec<PrLink> = rec
        .repos
        .iter()
        .map(|e| PrLink {
            repo: e.repo.clone(),
            url: e.url.clone(),
            state: e.state,
            seen_at: Some(e.seen_at),
        })
        .collect();
    let view = |done: bool, links_from: LinksFrom, offer_declare: bool| DoneView {
        done,
        links: links.clone(),
        links_from,
        offer_declare,
        pr_check_failed: false,
    };
    if rec.declared_at.is_none() {
        return view(false, LinksFrom::Opened, build_finished);
    }
    if !build_finished {
        return view(false, LinksFrom::EarlierDeclaration, false);
    }
    // Every touched repository has an entry pushed at the branch's present head.
    let same_head = now.touched.iter().all(|t| {
        let head = now.heads.iter().find(|(r, _)| r == t).map(|(_, h)| h);
        rec.repos
            .iter()
            .any(|e| &e.repo == t && Some(&e.pushed_head) == head)
    });
    if same_head {
        view(true, LinksFrom::Saved, false)
    } else {
        view(false, LinksFrom::EarlierDeclaration, true)
    }
}

/// The touched repositories of `repos` and where `change/<change>` points in each.
pub fn branch_facts(
    master: &str,
    system: &str,
    repos: &[PublishRepo],
    change: &str,
) -> BranchFacts {
    let branch = branch_in(repos, master, system, change).unwrap_or_default();
    let tip = format!("refs/heads/{branch}");
    BranchFacts {
        touched: repos.iter().map(|r| r.repo.clone()).collect(),
        heads: repos
            .iter()
            .filter_map(|r| {
                let head = git::Repo::open(Path::new(&r.path))
                    .and_then(|repo| repo.resolve(&tip))
                    .ok()?;
                Some((r.repo.clone(), head))
            })
            .collect(),
    }
}

/// The change's done view from what is saved and the repositories now. GitHub is asked only when
/// nothing is saved and the build is finished.
pub fn done_view_for(
    hosts: &dyn GitHubHosts,
    folder: &Path,
    master_repo: &str,
    workspace_id: &str,
    system: &str,
    change: &str,
    build_finished: bool,
) -> Result<DoneView, String> {
    let repos = touched_repos(folder, master_repo, system, change).map_err(|e| e.to_string())?;
    let record = saved_record(workspace_id, system, change);
    let asked = record.as_ref().is_some_and(|r| !r.repos.is_empty());
    let legacy = if !asked && build_finished {
        open_pull_requests(hosts, master_repo, system, &repos, change).ok()
    } else {
        None
    };
    Ok(done_view(
        record.as_ref(),
        &branch_facts(master_repo, system, &repos, change),
        build_finished,
        legacy.as_deref(),
    ))
}

/// The state GitHub's answer gives, or none when the request failed or the answer is unknown.
pub fn shown_state(answer: &Result<PullState, ApiError>) -> Option<PrStateKind> {
    let state = answer.as_ref().ok()?;
    match (state.state.as_str(), state.merged) {
        ("open", _) => Some(PrStateKind::Open),
        ("closed", true) => Some(PrStateKind::Merged),
        ("closed", false) => Some(PrStateKind::Closed),
        _ => None,
    }
}

/// Fold an answer into an entry: a state seen updates it and `seen_at`; a failure changes nothing.
pub fn apply_answer(entry: &mut PrEntry, answer: &Result<PullState, ApiError>, now: u64) {
    if let Some(state) = shown_state(answer) {
        entry.state = state;
        entry.seen_at = now;
    }
}

/// Seconds since the Unix epoch.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The number at the end of a pull request URL.
pub fn pull_number(url: &str) -> u64 {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

fn saved_record(workspace_id: &str, system: &str, change: &str) -> Option<PrRecord> {
    store::load_pr_records()
        .into_iter()
        .find(|r| r.workspace_id == workspace_id && r.system == system && r.change == change)
}

/// Where a pull request URL lives: host, owner and repository.
fn parse_pull_url(url: &str) -> Option<(String, String, String)> {
    let rest = url.split_once("://")?.1;
    let mut parts = rest.split('/');
    let host = parts.next()?.to_ascii_lowercase();
    let (owner, name) = (parts.next()?, parts.next()?);
    (!host.is_empty() && !owner.is_empty() && !name.is_empty())
        .then(|| (host, owner.to_string(), name.to_string()))
}

/// Ask GitHub for the state of every saved pull request, save what it said, and give the new
/// done view. A pull request GitHub cannot be asked about keeps its saved state and `seen_at`.
pub fn refresh_states(
    hosts: &dyn GitHubHosts,
    folder: &Path,
    master_repo: &str,
    workspace_id: &str,
    system: &str,
    change: &str,
    build_finished: bool,
) -> Result<DoneView, String> {
    if let Some(mut rec) = saved_record(workspace_id, system, change) {
        let now = now_secs();
        for entry in &mut rec.repos {
            let answer = match parse_pull_url(&entry.url) {
                Some((host, owner, name)) => match hosts.github(&host) {
                    Some(gh) => gh.pull_state(&owner, &name, entry.number),
                    None => Err(ApiError::Unreachable(format!("not signed in to {host}"))),
                },
                None => Err(ApiError::Unreachable("unreadable pull request link".into())),
            };
            apply_answer(entry, &answer, now);
        }
        store::save_pr_record(&rec).map_err(|e| e.to_string())?;
    }
    done_view_for(
        hosts,
        folder,
        master_repo,
        workspace_id,
        system,
        change,
        build_finished,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git;
    use crate::github::FakeGitHub;
    use crate::publish::tests::{all, fixture, on_github};
    use crate::publish::{publish, PrOutcome, Recorder};
    use crate::store;
    use serial_test::serial;

    struct HomeGuard {
        temp: tempfile::TempDir,
        prev: Option<std::ffi::OsString>,
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var("KATA_HOME", v),
                None => std::env::remove_var("KATA_HOME"),
            }
        }
    }

    fn with_home() -> HomeGuard {
        let temp = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("KATA_HOME");
        std::env::set_var("KATA_HOME", temp.path());
        HomeGuard { temp, prev }
    }

    fn entry(repo: &str, state: PrStateKind, seen_at: u64) -> PrEntry {
        PrEntry {
            repo: repo.into(),
            url: format!("https://github.com/o/{repo}/pull/1"),
            number: 1,
            pushed_head: format!("head-{repo}"),
            state,
            seen_at,
        }
    }

    fn facts() -> BranchFacts {
        BranchFacts {
            touched: vec!["app".into(), "m".into()],
            heads: vec![
                ("app".into(), "head-app".into()),
                ("m".into(), "head-m".into()),
            ],
        }
    }

    fn moved() -> BranchFacts {
        let mut f = facts();
        f.heads[0].1 = "newer".into();
        f
    }

    fn record(entries: &[PrEntry], declared: bool) -> PrRecord {
        PrRecord {
            workspace_id: "w1".into(),
            system: "s".into(),
            change: "c".into(),
            declared_at: declared.then_some(50),
            repos: entries.to_vec(),
        }
    }

    fn both(state: PrStateKind) -> Vec<PrEntry> {
        vec![entry("app", state, 7), entry("m", state, 7)]
    }

    fn links(entries: &[PrEntry]) -> Vec<PrLink> {
        entries
            .iter()
            .map(|e| PrLink {
                repo: e.repo.clone(),
                url: e.url.clone(),
                state: e.state,
                seen_at: Some(e.seen_at),
            })
            .collect()
    }

    fn view(done: bool, l: Vec<PrLink>, from: LinksFrom, offer: bool, failed: bool) -> DoneView {
        DoneView {
            done,
            links: l,
            links_from: from,
            offer_declare: offer,
            pr_check_failed: failed,
        }
    }

    fn open_state(repo: &str, open: bool) -> PrState {
        PrState {
            repo: repo.into(),
            url: open.then(|| format!("https://github.com/o/{repo}/pull/1")),
        }
    }

    #[test]
    fn done_view_table() {
        let saved = both(PrStateKind::Merged);
        let complete = record(&saved, true);
        let partial = record(&saved[..1], false);
        let partial_links = links(&saved[..1]);

        // 1: complete, branch unchanged, build finished: done with the saved links and states.
        assert_eq!(
            done_view(Some(&complete), &facts(), true, None),
            view(true, links(&saved), LinksFrom::Saved, false, false),
            "row 1"
        );
        // 2: complete, a branch moved, build finished: not done, declaring offered.
        assert_eq!(
            done_view(Some(&complete), &moved(), true, None),
            view(
                false,
                links(&saved),
                LinksFrom::EarlierDeclaration,
                true,
                false
            ),
            "row 2"
        );
        // 2b: a touched repository with no entry is the same as a moved branch.
        let mut more = facts();
        more.touched.push("api".into());
        more.heads.push(("api".into(), "h".into()));
        assert_eq!(
            done_view(Some(&complete), &more, true, None),
            view(
                false,
                links(&saved),
                LinksFrom::EarlierDeclaration,
                true,
                false
            ),
            "row 2b"
        );
        // 3: complete, build not finished: the stage's own actions, whatever the branches did.
        for f in [facts(), moved()] {
            assert_eq!(
                done_view(Some(&complete), &f, false, None),
                view(
                    false,
                    links(&saved),
                    LinksFrom::EarlierDeclaration,
                    false,
                    false
                ),
                "row 3"
            );
        }
        // 4: partial, build finished: the opened links, declaring offered.
        for f in [facts(), moved()] {
            assert_eq!(
                done_view(Some(&partial), &f, true, None),
                view(false, partial_links.clone(), LinksFrom::Opened, true, false),
                "row 4"
            );
        }
        // 5: partial, build not finished.
        assert_eq!(
            done_view(Some(&partial), &facts(), false, None),
            view(
                false,
                partial_links.clone(),
                LinksFrom::Opened,
                false,
                false
            ),
            "row 5"
        );
        // 6: no record, build finished, GitHub says every touched repository has an open pull request.
        let all_open = [open_state("app", true), open_state("m", true)];
        let from_github = vec![
            PrLink {
                repo: "app".into(),
                url: "https://github.com/o/app/pull/1".into(),
                state: PrStateKind::Open,
                seen_at: None,
            },
            PrLink {
                repo: "m".into(),
                url: "https://github.com/o/m/pull/1".into(),
                state: PrStateKind::Open,
                seen_at: None,
            },
        ];
        assert_eq!(
            done_view(None, &facts(), true, Some(&all_open)),
            view(true, from_github, LinksFrom::GitHub, false, false),
            "row 6"
        );
        // 7: some repository has no open pull request.
        let some = [open_state("app", true), open_state("m", false)];
        assert_eq!(
            done_view(None, &facts(), true, Some(&some)),
            view(false, vec![], LinksFrom::None, true, false),
            "row 7"
        );
        // 8: GitHub could not be asked.
        assert_eq!(
            done_view(None, &facts(), true, None),
            view(false, vec![], LinksFrom::None, true, true),
            "row 8"
        );
        // 9: no record, build not finished: nothing asked, no links.
        assert_eq!(
            done_view(None, &facts(), false, None),
            view(false, vec![], LinksFrom::None, false, false),
            "row 9"
        );
        // A record with no entries behaves as no record.
        let empty = record(&[], false);
        assert_eq!(
            done_view(Some(&empty), &facts(), false, None),
            view(false, vec![], LinksFrom::None, false, false),
            "empty record"
        );
    }

    fn answer(state: &str, merged: bool) -> Result<PullState, ApiError> {
        Ok(PullState {
            state: state.into(),
            merged,
        })
    }

    #[test]
    fn shown_state_per_github_answer() {
        use PrStateKind::*;
        let down: Result<PullState, ApiError> = Err(ApiError::Unreachable("offline".into()));
        let open = || answer("open", false);
        let merged = || answer("closed", true);
        let closed = || answer("closed", false);
        // The spec's five rows: every answer for (app, api, m), then the states shown.
        type Row = (
            &'static str,
            [Result<PullState, ApiError>; 3],
            [PrStateKind; 3],
        );
        let rows: Vec<Row> = vec![
            ("all open", [open(), open(), open()], [Open, Open, Open]),
            (
                "one merged",
                [merged(), open(), open()],
                [Merged, Open, Open],
            ),
            (
                "all merged",
                [merged(), merged(), merged()],
                [Merged, Merged, Merged],
            ),
            (
                "one closed without merging",
                [open(), closed(), open()],
                [Open, Closed, Open],
            ),
            (
                "cannot be asked",
                [down.clone(), down.clone(), down],
                [Open, Open, Open],
            ),
        ];
        for (name, answers, shown) in rows {
            let mut entries: Vec<PrEntry> = ["app", "api", "m"]
                .iter()
                .map(|r| entry(r, Open, 100))
                .collect();
            for (e, a) in entries.iter_mut().zip(&answers) {
                apply_answer(e, a, 500);
            }
            let got: Vec<PrStateKind> = entries.iter().map(|e| e.state).collect();
            assert_eq!(got, shown, "{name}");
            let seen: Vec<u64> = entries.iter().map(|e| e.seen_at).collect();
            let want_seen = if name == "cannot be asked" { 100 } else { 500 };
            assert_eq!(seen, [want_seen; 3], "{name}: seen_at");
            // The change stays done in every row.
            let f = BranchFacts {
                touched: vec!["app".into(), "api".into(), "m".into()],
                heads: ["app", "api", "m"]
                    .iter()
                    .map(|r| (r.to_string(), format!("head-{r}")))
                    .collect(),
            };
            let rec = record(&entries, true);
            let v = done_view(Some(&rec), &f, true, None);
            assert!(v.done, "{name}");
            let states: Vec<PrStateKind> = v.links.iter().map(|l| l.state).collect();
            assert_eq!(states, shown, "{name}: links");
        }
        // A closed pull request that was merged, and an answer that is not a state.
        assert_eq!(shown_state(&merged()), Some(Merged));
        assert_eq!(shown_state(&answer("draft?", false)), None);
        let mut e = entry("app", Merged, 9);
        apply_answer(&mut e, &open(), 10);
        assert_eq!((e.state, e.seen_at), (Open, 10));
    }

    const CHANGE: &str = "2026-10-19-c";

    fn saved() -> PrRecord {
        store::load_pr_records()
            .into_iter()
            .find(|r| r.workspace_id == "w1" && r.system == "s" && r.change == CHANGE)
            .expect("a saved record")
    }

    #[test]
    #[serial]
    fn partial_publish_is_kept_and_retry_opens_only_the_missing() {
        let home = with_home();
        let fx = fixture(true);
        on_github(&fx);
        let repos = all(&fx);
        let head = |name: &str| {
            git::run(
                &fx.path(name),
                &["rev-parse", &format!("refs/heads/change/{CHANGE}")],
            )
            .unwrap()
        };

        // The pull request in api fails; app and m open.
        let gh = FakeGitHub::default().create_fails(
            "api",
            ApiError::Status {
                status: 403,
                message: "forbidden".into(),
            },
        );
        let results = publish(
            &gh,
            "m",
            "s",
            CHANGE,
            &repos,
            &mut Recorder::stored("w1", "s", CHANGE),
            &mut |_| {},
        );
        assert!(matches!(results[1].outcome, PrOutcome::Failed { .. }));
        let rec = saved();
        let names: Vec<&str> = rec.repos.iter().map(|e| e.repo.as_str()).collect();
        assert_eq!(names, ["app", "m"]);
        assert_eq!(rec.declared_at, None);
        assert_eq!(rec.repos[0].url, "https://github.com/o/app/pull/1");
        assert_eq!(rec.repos[0].number, 1);
        assert_eq!(rec.repos[0].state, PrStateKind::Open);
        assert_eq!(rec.repos[0].pushed_head, head("app"));
        assert_eq!(rec.repos[1].pushed_head, head("m"));

        // After a restart the opened links show and the change is not done.
        let view = done_view_for(&gh, fx.dir.path(), "m", "w1", "s", CHANGE, true).unwrap();
        assert!(!view.done);
        assert_eq!(view.links_from, LinksFrom::Opened);
        assert!(view.offer_declare);
        let shown: Vec<&str> = view.links.iter().map(|l| l.repo.as_str()).collect();
        assert_eq!(shown, ["app", "m"]);

        // The retry creates only the missing pull request and completes the record.
        let gh = FakeGitHub::default().open_pull("app", 1).open_pull("m", 2);
        publish(
            &gh,
            "m",
            "s",
            CHANGE,
            &repos,
            &mut Recorder::stored("w1", "s", CHANGE),
            &mut |_| {},
        );
        assert_eq!(gh.creates(), ["api"]);
        let rec = saved();
        let names: Vec<&str> = rec.repos.iter().map(|e| e.repo.as_str()).collect();
        assert_eq!(names, ["app", "m", "api"]);
        assert!(rec.declared_at.is_some());
        let view = done_view_for(&gh, fx.dir.path(), "m", "w1", "s", CHANGE, true).unwrap();
        assert!(view.done);
        assert_eq!(view.links_from, LinksFrom::Saved);
        assert_eq!(view.links.len(), 3);

        // Asking GitHub for the states saves what it said.
        let mut rec = saved();
        rec.repos[0].state = PrStateKind::Merged;
        rec.repos[0].seen_at = 1;
        store::save_pr_record(&rec).unwrap();
        let view = refresh_states(&gh, fx.dir.path(), "m", "w1", "s", CHANGE, true).unwrap();
        assert!(view.done);
        assert_eq!(saved().repos[0].state, PrStateKind::Open);
        assert!(saved().repos[0].seen_at > 1);

        // The file holds no credential.
        let text = std::fs::read_to_string(
            home.temp
                .path()
                .join("workbench")
                .join("pull-requests.json"),
        )
        .unwrap();
        let lower = text.to_lowercase();
        for needle in ["token", "password", "ghp_", "authorization"] {
            assert!(!lower.contains(needle), "{needle} in {text}");
        }
    }
}
