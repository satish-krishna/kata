//! What the running-changes strip shows: one entry per change that needs the engineer or works,
//! computed as a pure function of snapshots (live runs, builds, run histories, opened marks) so it
//! needs no Tauri app. The entry a change gets is the first row of the table in `entries` that holds.
// The Tauri commands and the emit hooks that read this module arrive in the green commit.
#![allow(dead_code)]

use crate::build_host::BuildView;
use crate::history::RunHistory;
use crate::runs::{Lane, LiveSummary, RunKind};
use kata_sdlc::holds::ChangeKey;
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
pub struct RunRef {
    pub run: u64,
    pub kind: RunKind,
    pub repo: Option<String>,
}

/// What a running change needs or does, in the order of the rows that pick it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EntryState {
    NeedsAnswer {
        text: String,
        run: u64,
    },
    NeedsPermission {
        action: String,
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
        run: u64,
    },
    Finished,
}

/// One running change.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunningEntry {
    pub change: ChangeKey,
    #[serde(flatten)]
    pub state: EntryState,
    /// Orders entries of one row, oldest first: a unix time in milliseconds, or for a finished
    /// change the order in which its last run ended.
    pub since: u64,
    /// The runs of this change waiting on the engineer, oldest first.
    pub waiting: Vec<RunRef>,
}

/// The strip: the first entries and every entry.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
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
    pub fn open(&self, _change: &ChangeKey) {
        todo!("not implemented")
    }

    /// A run of `change` ended.
    pub fn ended(&self, _change: &ChangeKey) {
        todo!("not implemented")
    }
}

/// The running changes. See the table in the plan's T18.
pub fn entries(
    _live: &[LiveSummary],
    _builds: &[BuildView],
    _history: &RunHistory,
    _marks: &OpenedMarks,
) -> RunningStrip {
    RunningStrip::default()
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
        s.stopped.insert("review".into(), stop("change B holds app"));
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
