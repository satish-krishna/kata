//! What the running-changes strip shows: one entry per change that needs the engineer or works,
//! computed as a pure function of snapshots (live runs, builds, run histories, opened marks) so it
//! needs no Tauri app. The entry a change gets is the first row of the table in `entries` that holds.
use crate::build_host::BuildView;
use crate::build_host::REVIEW;
use crate::history::{Pending, RunHistory};
use crate::runs::{Lane, LiveSummary, RunKind};
use kata_sdlc::holds::ChangeKey;
use kata_sdlc::store::WorkspaceEntry;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// The channel the strip is announced on.
pub const RUNNING_EVENT: &str = "sdlc://running";

/// How many entries the strip shows; `all` lists every one.
pub const SHOWN: usize = 3;

/// A run of a change that waits on the engineer.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RunRef {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub run: u64,
    pub kind: RunKind,
    pub repo: Option<String>,
}

/// A run of a change the engineer can open from the strip.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct OpenRun {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub run: u64,
    pub kind: RunKind,
    pub repo: Option<String>,
    /// Whether the run waits on the engineer: the list offers Answer for it, Watch otherwise.
    pub waiting: bool,
}

/// What picking an entry opens.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Opens {
    /// That run's session, with its question or permission ready.
    Session { run: OpenRun },
    /// A list of the change's runs, each opening in one more step.
    List { runs: Vec<OpenRun> },
    /// The change's page: the change has no live run to open.
    Change,
}

/// What a running change needs or does, in the order of the rows that pick it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum EntryState {
    NeedsAnswer {
        text: String,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        run: u64,
    },
    NeedsPermission {
        action: String,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        run: u64,
    },
    Stopped {
        repo: String,
        reason: String,
    },
    Held {
        holder: ChangeKey,
    },
    ReviewWaiting {
        holder: ChangeKey,
    },
    Working {
        stage: RunKind,
        repo: Option<String>,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        run: u64,
    },
    Finished,
}

/// One running change.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RunningEntry {
    pub change: ChangeKey,
    #[serde(flatten)]
    pub state: EntryState,
    /// Orders entries of one row, oldest first: a unix time in milliseconds, or for a finished
    /// change the order in which its last run ended.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub since: u64,
    /// The runs of this change waiting on the engineer, oldest first.
    pub waiting: Vec<RunRef>,
    /// What picking the entry opens.
    pub opens: Opens,
    /// The id, in the workspace list, of the workspace the change belongs to; none when the list has no such workspace.
    pub workspace_id: Option<String>,
}

/// The strip: the first entries and every entry.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RunningStrip {
    pub shown: Vec<RunningEntry>,
    pub all: Vec<RunningEntry>,
}

/// When the engineer last opened each change and when its last run last ended, in one counter, so
/// "opened after the run ended" is a plain comparison.
#[derive(Default)]
pub struct OpenedMarks {
    inner: Mutex<Marks>,
}

#[derive(Default)]
struct Marks {
    seq: u64,
    opened: HashMap<ChangeKey, u64>,
    ended: HashMap<ChangeKey, u64>,
}

impl OpenedMarks {
    /// The engineer opened `change`.
    pub fn open(&self, change: &ChangeKey) {
        let mut m = self.inner.lock().unwrap();
        m.seq += 1;
        let at = m.seq;
        m.opened.insert(change.clone(), at);
    }

    /// A run of `change` ended.
    pub fn ended(&self, change: &ChangeKey) {
        let mut m = self.inner.lock().unwrap();
        m.seq += 1;
        let at = m.seq;
        m.ended.insert(change.clone(), at);
    }

    /// The changes whose last run ended after the engineer last opened them, with when it ended.
    fn unseen(&self) -> Vec<(ChangeKey, u64)> {
        let m = self.inner.lock().unwrap();
        m.ended
            .iter()
            .filter(|(k, at)| m.opened.get(*k).is_none_or(|o| o < *at))
            .map(|(k, at)| (k.clone(), *at))
            .collect()
    }
}

/// What the strip reads of one change before it picks a row.
#[derive(Default)]
struct Facts<'a> {
    /// Live runs of the change, oldest id first, with what each waits on.
    runs: Vec<(&'a LiveSummary, Option<Pending>)>,
    build: Option<&'a BuildView>,
    unseen_end: Option<u64>,
}

fn pending_since(p: &Pending) -> u64 {
    match p {
        Pending::Question { since_ms, .. } | Pending::Permission { since_ms, .. } => *since_ms,
    }
}

/// What picking a change's entry opens (R13.2): the session of its one run that waits on the engineer,
/// else a list of its runs (the waiting ones when two or more wait, every live one when none does), else
/// the change's page when it has no live run.
fn opens_of(f: &Facts) -> Opens {
    let open = |(r, p): &(&LiveSummary, Option<Pending>)| OpenRun {
        run: r.id,
        kind: r.kind,
        repo: r.repo.clone(),
        waiting: p.is_some(),
    };
    let mut waiting: Vec<OpenRun> = f
        .runs
        .iter()
        .filter(|(_, p)| p.is_some())
        .map(open)
        .collect();
    match waiting.len() {
        0 if f.runs.is_empty() => Opens::Change,
        0 => Opens::List {
            runs: f.runs.iter().map(open).collect(),
        },
        1 => Opens::Session {
            run: waiting.remove(0),
        },
        _ => Opens::List { runs: waiting },
    }
}

/// The entry for one change: the first row that holds, or none (rows 7 and 8).
fn entry_of(change: &ChangeKey, f: &Facts) -> Option<RunningEntry> {
    let waiting: Vec<RunRef> = f
        .runs
        .iter()
        .filter(|(_, p)| p.is_some())
        .map(|(r, _)| RunRef {
            run: r.id,
            kind: r.kind,
            repo: r.repo.clone(),
        })
        .collect();
    let oldest = |want_question: bool| {
        f.runs
            .iter()
            .filter_map(|(r, p)| p.as_ref().map(|p| (r.id, p)))
            .filter(|(_, p)| matches!(p, Pending::Question { .. }) == want_question)
            .min_by_key(|(_, p)| pending_since(p))
    };
    let entry = |state: EntryState, since: u64| {
        Some(RunningEntry {
            change: change.clone(),
            state,
            since,
            waiting: waiting.clone(),
            opens: opens_of(f),
            workspace_id: None,
        })
    };
    let build = f.build;
    // Rows 1 and 2.
    if let Some((run, Pending::Question { text, since_ms })) = oldest(true) {
        return entry(
            EntryState::NeedsAnswer {
                text: text.clone(),
                run,
            },
            *since_ms,
        );
    }
    if let Some((run, Pending::Permission { action, since_ms })) = oldest(false) {
        return entry(
            EntryState::NeedsPermission {
                action: action.clone(),
                run,
            },
            *since_ms,
        );
    }
    let changed = build.map_or(0, |b| b.changed_ms);
    // Row 3: a stopped product repository. A held review is also marked stopped under the review's
    // own key; it shows as row 5, so that key is skipped while the review waits for a hold.
    if let Some(b) = build {
        let review_waits = !b.review_waiting.is_empty();
        let stopped = b
            .state
            .iter()
            .flat_map(|s| s.stopped.iter())
            .find(|(repo, _)| !(review_waits && repo.as_str() == REVIEW));
        if let Some((repo, stop)) = stopped {
            return entry(
                EntryState::Stopped {
                    repo: repo.clone(),
                    reason: stop.reason.clone(),
                },
                changed,
            );
        }
        // Row 4.
        if let Some(h) = b.held_start.first() {
            return entry(
                EntryState::Held {
                    holder: h.holder.clone(),
                },
                changed,
            );
        }
        // Row 5.
        if let Some(h) = b.review_waiting.first() {
            return entry(
                EntryState::ReviewWaiting {
                    holder: h.holder.clone(),
                },
                changed,
            );
        }
    }
    // Row 6.
    if let Some((r, _)) = f.runs.first() {
        return entry(
            EntryState::Working {
                stage: r.kind,
                repo: r.repo.clone(),
                run: r.id,
            },
            changed,
        );
    }
    // Rows 7 and 8.
    f.unseen_end.and_then(|at| entry(EntryState::Finished, at))
}

fn row(state: &EntryState) -> u8 {
    match state {
        EntryState::NeedsAnswer { .. } => 1,
        EntryState::NeedsPermission { .. } => 2,
        EntryState::Stopped { .. } => 3,
        EntryState::Held { .. } => 4,
        EntryState::ReviewWaiting { .. } => 5,
        EntryState::Working { .. } => 6,
        EntryState::Finished => 7,
    }
}

/// The running changes. See the table in the plan's T18.
pub fn entries(
    live: &[LiveSummary],
    builds: &[BuildView],
    history: &RunHistory,
    marks: &OpenedMarks,
) -> RunningStrip {
    let mut facts: HashMap<ChangeKey, Facts> = HashMap::new();
    for run in live {
        if let Lane::Change { key, .. } = &run.lane {
            facts
                .entry(key.clone())
                .or_default()
                .runs
                .push((run, history.pending(run.id)));
        }
    }
    for build in builds {
        facts.entry(build.change.clone()).or_default().build = Some(build);
    }
    for (change, at) in marks.unseen() {
        facts.entry(change).or_default().unseen_end = Some(at);
    }
    let mut all: Vec<RunningEntry> = facts
        .iter()
        .filter_map(|(change, f)| entry_of(change, f))
        .collect();
    all.sort_by(|a, b| {
        (row(&a.state), a.since, &a.change.system, &a.change.change).cmp(&(
            row(&b.state),
            b.since,
            &b.change.system,
            &b.change.change,
        ))
    });
    let shown = all.iter().take(SHOWN).cloned().collect();
    RunningStrip { shown, all }
}

/// Name each entry's workspace by its id in the workspace list, so the webview compares equal strings
/// instead of normalizing folder paths itself. Stub: the rule is not written yet.
pub fn with_workspace_ids(strip: RunningStrip, _workspaces: &[WorkspaceEntry]) -> RunningStrip {
    strip
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_host::HeldRepo;
    use kata_sdlc::coordinator::{BuildPhase, BuildState, Stop};
    use kata_sdlc::holds::RepoKey;
    use serde_json::json;
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::{Path, PathBuf};

    fn key(name: &str) -> ChangeKey {
        ChangeKey {
            workspace: RepoKey::of(Path::new("D:/ws")),
            system: "kata".into(),
            change: name.into(),
        }
    }

    fn run(id: u64, change: &str, kind: RunKind, repo: Option<&str>) -> LiveSummary {
        LiveSummary {
            id,
            workdir: PathBuf::from(format!("D:/c/{change}")),
            lane: Lane::Change {
                key: key(change),
                build: true,
            },
            kind,
            repo: repo.map(String::from),
        }
    }

    fn state(phase: BuildPhase) -> BuildState {
        BuildState {
            phase,
            going: BTreeSet::new(),
            stopped: BTreeMap::new(),
            rounds: BTreeMap::new(),
            waiting: Vec::new(),
            report: None,
        }
    }

    fn view(change: &str, state: Option<BuildState>) -> BuildView {
        BuildView {
            change: key(change),
            state,
            review_waiting: Vec::new(),
            held_start: Vec::new(),
            changed_ms: 0,
        }
    }

    fn stop(reason: &str) -> Stop {
        Stop {
            task: "T1".into(),
            reason: reason.into(),
            held: false,
        }
    }

    fn held(repo: &str, holder: &str) -> Vec<HeldRepo> {
        vec![HeldRepo {
            repo: repo.into(),
            holder: key(holder),
        }]
    }

    fn ask(history: &RunHistory, run: u64, text: &str) {
        history.push(
            run,
            &json!({"type": "ask.requested", "id": format!("q{run}"), "questions": [{"question": text}]}),
        );
    }

    fn permission(history: &RunHistory, run: u64, summary: &str) {
        history.push(
            run,
            &json!({"type": "permission.requested", "id": format!("p{run}"), "tool": "Bash", "input_summary": summary}),
        );
    }

    fn strip(live: &[LiveSummary], builds: &[BuildView], history: &RunHistory) -> RunningStrip {
        entries(live, builds, history, &OpenedMarks::default())
    }

    fn only(strip: RunningStrip) -> RunningEntry {
        assert_eq!(strip.all.len(), 1, "{:?}", strip.all);
        strip.all.into_iter().next().unwrap()
    }

    #[test]
    fn each_run_state_shows_as_its_entry() {
        // kata and bob: working, naming the stage and the repository.
        for system in ["kata", "bob"] {
            let mut r = run(1, "A", RunKind::Build, Some("app"));
            if let Lane::Change { key, .. } = &mut r.lane {
                key.system = system.into();
            }
            let e = only(strip(&[r], &[], &RunHistory::default()));
            assert_eq!(
                e.state,
                EntryState::Working {
                    stage: RunKind::Build,
                    repo: Some("app".into()),
                    run: 1
                }
            );
            assert_eq!(e.change.system, system);
        }
        // Waiting on a question: needs an answer, with the question's text.
        let h = RunHistory::default();
        ask(&h, 1, "Which branch?");
        let e = only(strip(&[run(1, "A", RunKind::Build, Some("app"))], &[], &h));
        assert_eq!(
            e.state,
            EntryState::NeedsAnswer {
                text: "Which branch?".into(),
                run: 1
            }
        );
        // Waiting on a permission: needs a permission, with the action asked for.
        let h = RunHistory::default();
        permission(&h, 1, "rm -rf build");
        let e = only(strip(&[run(1, "A", RunKind::Build, Some("app"))], &[], &h));
        assert_eq!(
            e.state,
            EntryState::NeedsPermission {
                action: "Bash: rm -rf build".into(),
                run: 1
            }
        );
        // Stopped in a repository: the repository and the reason.
        let mut s = state(BuildPhase::Stopped);
        s.stopped.insert("app".into(), stop("tests fail"));
        let e = only(strip(&[], &[view("A", Some(s))], &RunHistory::default()));
        assert_eq!(
            e.state,
            EntryState::Stopped {
                repo: "app".into(),
                reason: "tests fail".into()
            }
        );
        // A build held by another change: names the change that holds its repository.
        let mut v = view("A", None);
        v.held_start = held("app", "B");
        let e = only(strip(&[], &[v], &RunHistory::default()));
        assert_eq!(e.state, EntryState::Held { holder: key("B") });
        // A review waiting for a held repository: names the holder, not a stop.
        let mut s = state(BuildPhase::Stopped);
        s.stopped
            .insert("review".into(), stop("change B holds app"));
        let mut v = view("A", Some(s));
        v.review_waiting = held("app", "B");
        let e = only(strip(&[], &[v], &RunHistory::default()));
        assert_eq!(e.state, EntryState::ReviewWaiting { holder: key("B") });
    }

    #[test]
    fn five_running_changes_show_three_and_list_all() {
        let h = RunHistory::default();
        let names = ["A", "B", "C", "D", "E"];
        let live: Vec<LiveSummary> = names
            .iter()
            .enumerate()
            .map(|(i, n)| run(i as u64 + 1, n, RunKind::Build, Some("app")))
            .collect();
        // D and E need the engineer; they come first.
        ask(&h, 4, "q?");
        permission(&h, 5, "ls");
        let s = strip(&live, &[], &h);
        assert_eq!(s.all.len(), 5);
        assert_eq!(s.shown.len(), 3);
        let shown: Vec<&str> = s.shown.iter().map(|e| e.change.change.as_str()).collect();
        assert_eq!(shown, ["D", "E", "A"]);
        assert_eq!(s.shown, s.all[..3].to_vec());
    }

    #[test]
    fn a_finished_change_leaves_once_opened() {
        let marks = OpenedMarks::default();
        let h = RunHistory::default();
        marks.ended(&key("A"));
        let s = entries(&[], &[], &h, &marks);
        assert_eq!(only(s).state, EntryState::Finished);
        marks.open(&key("A"));
        assert!(entries(&[], &[], &h, &marks).all.is_empty());
        // A later run that ends brings it back.
        marks.ended(&key("A"));
        assert_eq!(entries(&[], &[], &h, &marks).all.len(), 1);
    }

    #[test]
    fn entries_rows() {
        let h = RunHistory::default();
        ask(&h, 1, "which?");
        permission(&h, 2, "ls");
        let mut stopped = state(BuildPhase::Stopped);
        stopped.stopped.insert("app".into(), stop("boom"));
        let mut review_stopped = state(BuildPhase::Stopped);
        review_stopped.stopped.insert("review".into(), stop("held"));
        let marks = OpenedMarks::default();
        marks.ended(&key("A"));
        // Each of R1 to R6 has a live working run, so a row that holds beats row 6.
        let live = vec![
            run(1, "R1", RunKind::Build, None),
            run(2, "R2", RunKind::Build, None),
            run(3, "R3", RunKind::Build, Some("app")),
            run(4, "R4", RunKind::Build, Some("app")),
            run(5, "R5", RunKind::Build, Some("app")),
            run(6, "R6", RunKind::Build, Some("app")),
        ];
        let mut r5 = view("R5", None);
        r5.held_start = held("app", "X");
        // R4's review was held: the coordinator marks it stopped and the host sets review_waiting.
        let mut r4 = view("R4", Some(review_stopped));
        r4.review_waiting = held("app", "X");
        let builds = vec![view("R3", Some(stopped)), r4, r5];
        let s = entries(&live, &builds, &h, &marks).all;
        let rows: Vec<(String, &'static str)> = s
            .iter()
            .map(|e| {
                let row = match e.state {
                    EntryState::NeedsAnswer { .. } => "1",
                    EntryState::NeedsPermission { .. } => "2",
                    EntryState::Stopped { .. } => "3",
                    EntryState::Held { .. } => "4",
                    EntryState::ReviewWaiting { .. } => "5",
                    EntryState::Working { .. } => "6",
                    EntryState::Finished => "7",
                };
                (e.change.change.clone(), row)
            })
            .collect();
        assert_eq!(
            rows,
            [
                ("R1".to_string(), "1"),
                ("R2".to_string(), "2"),
                ("R3".to_string(), "3"),
                ("R5".to_string(), "4"),
                ("R4".to_string(), "5"),
                ("R6".to_string(), "6"),
                ("A".to_string(), "7"),
            ]
        );
        // Row 8: opened after its last run ended, or never ran, is not listed.
        marks.open(&key("A"));
        let s = entries(&[], &[view("N", None)], &h, &marks);
        assert!(s.all.is_empty());
    }

    fn open_run(run: u64, kind: RunKind, repo: Option<&str>, waiting: bool) -> OpenRun {
        OpenRun {
            run,
            kind,
            repo: repo.map(String::from),
            waiting,
        }
    }

    #[test]
    fn picking_an_entry_with_one_waiting_run_opens_that_session() {
        // R13.2 row 1: exactly one session waiting on the engineer, even beside a working one.
        let h = RunHistory::default();
        ask(&h, 2, "Which branch?");
        let live = vec![
            run(1, "A", RunKind::Build, Some("api")),
            run(2, "A", RunKind::Build, Some("app")),
        ];
        let e = only(strip(&live, &[], &h));
        assert_eq!(
            e.opens,
            Opens::Session {
                run: open_run(2, RunKind::Build, Some("app"), true)
            }
        );
        // A permission counts as waiting the same way.
        let h = RunHistory::default();
        permission(&h, 1, "ls");
        let e = only(strip(&[run(1, "A", RunKind::Review, None)], &[], &h));
        assert_eq!(
            e.opens,
            Opens::Session {
                run: open_run(1, RunKind::Review, None, true)
            }
        );
    }

    #[test]
    fn picking_an_entry_with_two_waiting_runs_opens_a_list_of_them() {
        // R13.2 row 2: two sessions waiting; the list holds the change's runs, waiting ones marked.
        let h = RunHistory::default();
        ask(&h, 1, "which?");
        permission(&h, 3, "ls");
        let live = vec![
            run(1, "A", RunKind::Build, Some("app")),
            run(2, "A", RunKind::Build, Some("api")),
            run(3, "A", RunKind::Review, None),
        ];
        let e = only(strip(&live, &[], &h));
        assert_eq!(
            e.opens,
            Opens::List {
                runs: vec![
                    open_run(1, RunKind::Build, Some("app"), true),
                    open_run(3, RunKind::Review, None, true),
                ]
            }
        );
    }

    #[test]
    fn picking_an_entry_with_only_working_runs_opens_a_list_of_them() {
        // R13.2 row 3: none waiting, one or more working. One run still gets a list, not a session.
        let h = RunHistory::default();
        let e = only(strip(&[run(1, "A", RunKind::Build, Some("app"))], &[], &h));
        assert_eq!(
            e.opens,
            Opens::List {
                runs: vec![open_run(1, RunKind::Build, Some("app"), false)]
            }
        );
        let live = vec![
            run(1, "A", RunKind::Build, Some("app")),
            run(2, "A", RunKind::Build, Some("api")),
        ];
        let e = only(strip(&live, &[], &h));
        assert_eq!(
            e.opens,
            Opens::List {
                runs: vec![
                    open_run(1, RunKind::Build, Some("app"), false),
                    open_run(2, RunKind::Build, Some("api"), false),
                ]
            }
        );
    }

    #[test]
    fn picking_an_entry_with_no_live_run_opens_the_change() {
        let mut v = view("A", None);
        v.held_start = held("app", "B");
        let e = only(strip(&[], &[v], &RunHistory::default()));
        assert_eq!(e.opens, Opens::Change);
        let marks = OpenedMarks::default();
        marks.ended(&key("A"));
        let e = only(entries(&[], &[], &RunHistory::default(), &marks));
        assert_eq!(e.opens, Opens::Change);
    }

    fn workspace(id: &str, folder: &str) -> WorkspaceEntry {
        WorkspaceEntry {
            id: id.into(),
            name: id.into(),
            folder: folder.into(),
            last_opened: 1,
        }
    }

    #[test]
    fn an_entry_names_its_workspace_by_the_id_in_the_workspace_list() {
        let live = vec![run(1, "A", RunKind::Build, Some("app"))];
        let h = RunHistory::default();
        // The key is lexical (separators, case, trailing slash), so the list's spelling may differ.
        for folder in ["D:/ws", r"D:\ws\", "d:/WS/"] {
            let list = vec![
                workspace("other", "D:/elsewhere"),
                workspace("mine", folder),
            ];
            let s = with_workspace_ids(strip(&live, &[], &h), &list);
            let e = only(s);
            assert_eq!(e.workspace_id.as_deref(), Some("mine"), "{folder}");
        }
        // The same ids on the shown and the all lists.
        let list = vec![workspace("mine", "D:/ws")];
        let s = with_workspace_ids(strip(&live, &[], &h), &list);
        assert_eq!(s.shown, s.all);
        assert_eq!(s.shown[0].workspace_id.as_deref(), Some("mine"));
        // A workspace the list does not have: none, not a guess.
        let none = with_workspace_ids(strip(&live, &[], &h), &[workspace("x", "D:/nope")]);
        assert_eq!(only(none).workspace_id, None);
    }

    #[test]
    fn waiting_lists_every_run_waiting_on_the_engineer() {
        let h = RunHistory::default();
        ask(&h, 1, "which?");
        permission(&h, 2, "ls");
        let live = vec![
            run(1, "A", RunKind::Build, Some("app")),
            run(2, "A", RunKind::Review, None),
            run(3, "A", RunKind::Build, Some("api")),
        ];
        let e = only(strip(&live, &[], &h));
        assert!(matches!(e.state, EntryState::NeedsAnswer { run: 1, .. }));
        assert_eq!(
            e.waiting,
            [
                RunRef {
                    run: 1,
                    kind: RunKind::Build,
                    repo: Some("app".into())
                },
                RunRef {
                    run: 2,
                    kind: RunKind::Review,
                    repo: None
                },
            ]
        );
    }
}
