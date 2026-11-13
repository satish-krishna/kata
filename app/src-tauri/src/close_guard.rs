//! What closing the Workbench does while runs are live: ask first, naming every running change,
//! then cancel them all on a confirm. Pure, so the table of outcomes is tested without a window;
//! the `CloseRequested` handler and `sdlc_close_answer` in `lib.rs` are thin wrappers.
use crate::runs::{Lane, Launching, LiveSummary, RunKind};
use crate::steps::RunningStep;
use kata_sdlc::holds::ChangeKey;
use serde::Serialize;

/// The channel the question is announced on.
pub const CLOSE_ASKED_EVENT: &str = "sdlc://close-asked";

/// How long the host waits for cancelled runs to leave the table before it closes anyway.
pub const CANCEL_WAIT_SECS: u64 = 10;

/// Where the engineer is in the question.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseAnswer {
    NotAsked,
    Confirm,
    Decline,
}

/// One line of the question: a change and what it does, or a run that belongs to no change.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RunningLine {
    /// The change's name; none for a run outside any change.
    pub change: Option<String>,
    /// What it does, e.g. "building in kata".
    pub what: String,
}

/// What the window does next.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum CloseOutcome {
    /// The window closes.
    Close,
    /// The close is prevented and the question goes to the engineer.
    Ask { running: Vec<RunningLine> },
    /// Cancel these runs, wait for the table to empty, then close.
    CancelThenClose {
        #[cfg_attr(feature = "ts", ts(type = "Array<number>"))]
        ids: Vec<u64>,
        /// The changes whose long step is stopped.
        steps: Vec<ChangeKey>,
    },
    /// Nothing changes.
    Stay,
}

/// What a run does, from its kind and repository.
fn what(kind: RunKind, repo: Option<&str>) -> String {
    match (kind, repo) {
        (RunKind::Build, Some(repo)) => format!("building in {repo}"),
        (RunKind::Build, None) => "building".into(),
        (RunKind::Review, Some(repo)) => format!("reviewing {repo}"),
        (RunKind::Review, None) => "reviewing".into(),
        (RunKind::Intent, _) => "writing its intent".into(),
        (RunKind::Spec, _) => "writing its spec".into(),
        (RunKind::Plan, _) => "writing its plan".into(),
        (RunKind::Triage, _) => "triaging".into(),
        (RunKind::Fix, _) => "writing its fix".into(),
        (RunKind::Setup, _) => "setting up the workspace".into(),
        (RunKind::Context, _) => "building context".into(),
        (RunKind::Solo, _) => "running a task in the Workbench".into(),
    }
}

/// The system and change a line is about; none for a run outside any change.
type Owner = Option<(String, String)>;

/// One line per change, in the order its first run appears, the runs in the table before the launching
/// ones; a run with no change gets its own line, and a change names the same doing once.
fn lines(live: &[LiveSummary], launching: &[Launching], steps: &[RunningStep]) -> Vec<RunningLine> {
    let in_table = live.iter().map(|run| {
        let owner = match &run.lane {
            Lane::Change { key, .. } => Some((key.system.clone(), key.change.clone())),
            Lane::Solo => None,
        };
        (owner, what(run.kind, run.repo.as_deref()))
    });
    let starting = launching.iter().map(|l| {
        (
            Some((l.change.system.clone(), l.change.change.clone())),
            what(l.kind, l.repo.as_deref()),
        )
    });
    let mut out: Vec<(Owner, Vec<String>)> = Vec::new();
    for (owner, text) in in_table.chain(starting) {
        let found = owner
            .as_ref()
            .and_then(|o| out.iter_mut().find(|(k, _)| k.as_ref() == Some(o)));
        match found {
            Some((_, parts)) => {
                if !parts.contains(&text) {
                    parts.push(text);
                }
            }
            None => out.push((owner, vec![text])),
        }
    }
    // A change in a long step cannot have started its runs yet, so the step says what it does.
    for step in steps {
        let owner = Some((step.change.system.clone(), step.change.change.clone()));
        let doing = vec![step.kind.doing()];
        match out.iter_mut().find(|(k, _)| *k == owner) {
            Some((_, parts)) => *parts = doing,
            None => out.push((owner, doing)),
        }
    }
    out.into_iter()
        .map(|(owner, parts)| RunningLine {
            change: owner.map(|(_, change)| change),
            what: parts.join(" and "),
        })
        .collect()
}

/// Decide what closing the window does. The question is asked only while runs are live, a build being
/// started or launched (`launching`) or a long step of a change (`steps`) counting as live; a confirm that arrives after they ended closes at
/// once, as a confirm with nothing to cancel.
pub fn on_close(
    live: &[LiveSummary],
    launching: &[Launching],
    steps: &[RunningStep],
    answer: CloseAnswer,
) -> CloseOutcome {
    let none = live.is_empty() && launching.is_empty() && steps.is_empty();
    match answer {
        CloseAnswer::NotAsked if none => CloseOutcome::Close,
        CloseAnswer::NotAsked => CloseOutcome::Ask {
            running: lines(live, launching, steps),
        },
        CloseAnswer::Confirm if none => CloseOutcome::Close,
        CloseAnswer::Confirm => CloseOutcome::CancelThenClose {
            ids: live.iter().map(|r| r.id).collect(),
            steps: steps.iter().map(|s| s.change.clone()).collect(),
        },
        CloseAnswer::Decline => CloseOutcome::Stay,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runs::{Lane, RunKind};
    use crate::steps::StepKind;
    use kata_sdlc::accept::ChangeDocument;
    use kata_sdlc::holds::RepoKey;
    use std::path::{Path, PathBuf};

    fn run(id: u64, change: &str, kind: RunKind, repo: Option<&str>) -> LiveSummary {
        LiveSummary {
            id,
            workdir: PathBuf::from(format!("D:/ws/{id}")),
            lane: Lane::Change {
                key: ChangeKey {
                    workspace: RepoKey::of(Path::new("D:/ws")),
                    system: "s".into(),
                    change: change.into(),
                },
                build: kind == RunKind::Build,
            },
            kind,
            repo: repo.map(String::from),
        }
    }

    impl LiveSummary {
        fn lane_key(&self) -> ChangeKey {
            match &self.lane {
                Lane::Change { key, .. } => key.clone(),
                Lane::Solo => unreachable!(),
            }
        }
    }

    fn a_and_b() -> Vec<LiveSummary> {
        vec![
            run(1, "A", RunKind::Build, Some("kata")),
            run(2, "B", RunKind::Review, None),
        ]
    }

    fn line(change: &str, what: &str) -> RunningLine {
        RunningLine {
            change: Some(change.into()),
            what: what.into(),
        }
    }

    #[test]
    fn closing_rows() {
        let live = a_and_b();
        let asked = CloseOutcome::Ask {
            running: vec![line("A", "building in kata"), line("B", "reviewing")],
        };
        // R16.1 example 3 and row 1: nothing live, not asked.
        assert_eq!(
            on_close(&[], &[], &[], CloseAnswer::NotAsked),
            CloseOutcome::Close
        );
        // Row 2: live runs, not asked yet.
        assert_eq!(on_close(&live, &[], &[], CloseAnswer::NotAsked), asked);
        // R16.1 example 1 and row 3: confirm cancels every live run, then closes.
        assert_eq!(
            on_close(&live, &[], &[], CloseAnswer::Confirm),
            CloseOutcome::CancelThenClose {
                ids: vec![1, 2],
                steps: vec![]
            }
        );
        // R16.1 example 2 and row 4: decline changes nothing.
        assert_eq!(
            on_close(&live, &[], &[], CloseAnswer::Decline),
            CloseOutcome::Stay
        );
        // Row 5: a confirm after the runs ended closes at once.
        assert_eq!(
            on_close(&[], &[], &[], CloseAnswer::Confirm),
            CloseOutcome::Close
        );
    }

    // R16.1, R16.2: a build the host is starting or launching is live for the close question.
    #[test]
    fn closing_with_only_a_launching_build_asks() {
        let launching = vec![
            Launching {
                change: run(1, "A", RunKind::Build, None).lane_key(),
                kind: RunKind::Build,
                repo: Some("kata".into()),
            },
            Launching {
                change: run(2, "B", RunKind::Build, None).lane_key(),
                kind: RunKind::Build,
                repo: None,
            },
        ];
        assert_eq!(
            on_close(&[], &launching, &[], CloseAnswer::NotAsked),
            CloseOutcome::Ask {
                running: vec![line("A", "building in kata"), line("B", "building")],
            }
        );
        // A confirm stops the host and waits for what it launched; nothing is in the table yet.
        assert_eq!(
            on_close(&[], &launching, &[], CloseAnswer::Confirm),
            CloseOutcome::CancelThenClose {
                ids: vec![],
                steps: vec![]
            }
        );
        // A run already in the table and still listed as launching is named once.
        let live = vec![run(3, "A", RunKind::Build, Some("kata"))];
        assert_eq!(
            on_close(&live, &launching[..1], &[], CloseAnswer::NotAsked),
            CloseOutcome::Ask {
                running: vec![line("A", "building in kata")],
            }
        );
    }

    fn step(change: &str, kind: StepKind) -> RunningStep {
        RunningStep {
            change: run(0, change, RunKind::Build, None).lane_key(),
            kind,
            doing: kind.doing(),
            progress: None,
        }
    }

    fn key(change: &str) -> ChangeKey {
        run(0, change, RunKind::Build, None).lane_key()
    }

    // R9.1: a preparing build, with no run started, is named and said to be preparing.
    #[test]
    fn a_preparing_build_is_named_as_preparing() {
        let steps = vec![step("2026-11-12-heavy-start", StepKind::PreparingBuild)];
        assert_eq!(
            on_close(&[], &[], &steps, CloseAnswer::NotAsked),
            CloseOutcome::Ask {
                running: vec![line("2026-11-12-heavy-start", "preparing")],
            }
        );
    }

    // R9.2: a confirm stops the preparation.
    #[test]
    fn confirming_stops_every_step() {
        let steps = vec![
            step("A", StepKind::PreparingBuild),
            step("B", StepKind::DeclaringDone),
        ];
        assert_eq!(
            on_close(&[], &[], &steps, CloseAnswer::Confirm),
            CloseOutcome::CancelThenClose {
                ids: vec![],
                steps: vec![key("A"), key("B")],
            }
        );
    }

    // R9.3: a decline leaves the steps running.
    #[test]
    fn declining_leaves_steps_running() {
        let steps = vec![step("A", StepKind::PreparingBuild)];
        assert_eq!(
            on_close(&[], &[], &steps, CloseAnswer::Decline),
            CloseOutcome::Stay
        );
    }

    // R18.1: every kind of long step is named in the question's words.
    #[test]
    fn each_step_kind_is_named() {
        let rows: Vec<(StepKind, &str)> = vec![
            (StepKind::PreparingBuild, "preparing"),
            (StepKind::PreparingReview, "preparing the review"),
            (StepKind::Starting, "starting"),
            (StepKind::Renaming, "being renamed"),
            (StepKind::RemovingCopy, "having its copy removed"),
            (
                StepKind::Accepting(ChangeDocument::Intent),
                "accepting its intent",
            ),
            (
                StepKind::Accepting(ChangeDocument::Spec),
                "accepting its spec",
            ),
            (
                StepKind::Accepting(ChangeDocument::Plan),
                "accepting its plan",
            ),
            (
                StepKind::Rejecting(ChangeDocument::Intent),
                "rejecting its intent",
            ),
            (
                StepKind::Rejecting(ChangeDocument::Spec),
                "rejecting its spec",
            ),
            (
                StepKind::Rejecting(ChangeDocument::Plan),
                "rejecting its plan",
            ),
            (StepKind::DeclaringDone, "being declared done"),
        ];
        for (kind, words) in rows {
            let steps = vec![step("A", kind)];
            assert_eq!(
                on_close(&[], &[], &steps, CloseAnswer::NotAsked),
                CloseOutcome::Ask {
                    running: vec![line("A", words)],
                },
                "{kind:?}"
            );
            assert_eq!(
                on_close(&[], &[], &steps, CloseAnswer::Confirm),
                CloseOutcome::CancelThenClose {
                    ids: vec![],
                    steps: vec![key("A")],
                },
                "{kind:?}"
            );
            assert_eq!(
                on_close(&[], &[], &steps, CloseAnswer::Decline),
                CloseOutcome::Stay,
                "{kind:?}"
            );
        }
    }

    // A change with a step and live runs is one line, saying what the step does.
    #[test]
    fn a_change_with_a_step_and_a_run_is_one_line() {
        let live = vec![
            run(1, "A", RunKind::Review, None),
            run(2, "B", RunKind::Spec, None),
        ];
        let steps = vec![step("A", StepKind::PreparingReview)];
        assert_eq!(
            on_close(&live, &[], &steps, CloseAnswer::NotAsked),
            CloseOutcome::Ask {
                running: vec![
                    line("A", "preparing the review"),
                    line("B", "writing its spec")
                ],
            }
        );
        assert_eq!(
            on_close(&live, &[], &steps, CloseAnswer::Confirm),
            CloseOutcome::CancelThenClose {
                ids: vec![1, 2],
                steps: vec![key("A")],
            }
        );
    }

    // The decision table, step columns: runs, launching builds and steps each make the question
    // necessary on their own; with all three empty there is nothing to ask.
    #[test]
    fn each_column_alone_makes_the_question_necessary() {
        let live = [run(1, "A", RunKind::Build, Some("kata"))];
        let launching = [Launching {
            change: key("B"),
            kind: RunKind::Build,
            repo: None,
        }];
        let steps = [step("C", StepKind::Starting)];
        for (l, la, s) in [
            (&live[..], &[][..], &[][..]),
            (&[][..], &launching[..], &[][..]),
            (&[][..], &[][..], &steps[..]),
            (&live[..], &launching[..], &steps[..]),
        ] {
            assert!(matches!(
                on_close(l, la, s, CloseAnswer::NotAsked),
                CloseOutcome::Ask { .. }
            ));
            assert!(matches!(
                on_close(l, la, s, CloseAnswer::Confirm),
                CloseOutcome::CancelThenClose { .. }
            ));
            assert_eq!(on_close(l, la, s, CloseAnswer::Decline), CloseOutcome::Stay);
        }
        assert_eq!(
            on_close(&[], &[], &[], CloseAnswer::NotAsked),
            CloseOutcome::Close
        );
        assert_eq!(
            on_close(&[], &[], &[], CloseAnswer::Confirm),
            CloseOutcome::Close
        );
    }

    #[test]
    fn the_question_names_every_running_change() {
        let live = vec![
            run(1, "A", RunKind::Build, Some("kata")),
            run(2, "B", RunKind::Spec, None),
        ];
        assert_eq!(
            on_close(&live, &[], &[], CloseAnswer::NotAsked),
            CloseOutcome::Ask {
                running: vec![line("A", "building in kata"), line("B", "writing its spec")],
            }
        );
    }

    #[test]
    fn one_change_with_two_runs_is_one_line_and_a_run_with_no_change_has_its_own() {
        let live = vec![
            run(1, "A", RunKind::Build, Some("kata")),
            run(2, "A", RunKind::Build, Some("ai-sdlc")),
            LiveSummary {
                id: 3,
                workdir: PathBuf::from("D:/solo"),
                lane: Lane::Solo,
                kind: RunKind::Solo,
                repo: None,
            },
        ];
        assert_eq!(
            on_close(&live, &[], &[], CloseAnswer::NotAsked),
            CloseOutcome::Ask {
                running: vec![
                    line("A", "building in kata and building in ai-sdlc"),
                    RunningLine {
                        change: None,
                        what: "running a task in the Workbench".into()
                    },
                ],
            }
        );
    }
}
