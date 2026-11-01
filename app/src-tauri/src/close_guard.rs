//! What closing the Workbench does while runs are live: ask first, naming every running change,
//! then cancel them all on a confirm. Pure, so the table of outcomes is tested without a window;
//! the `CloseRequested` handler and `sdlc_close_answer` in `lib.rs` are thin wrappers.
// Stub for the failing tests; the implementation follows.
#![allow(dead_code)]

use crate::runs::LiveSummary;
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
pub struct RunningLine {
    /// The change's name; none for a run outside any change.
    pub change: Option<String>,
    /// What it does, e.g. "building in kata".
    pub what: String,
}

/// What the window does next.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CloseOutcome {
    /// The window closes.
    Close,
    /// The close is prevented and the question goes to the engineer.
    Ask { running: Vec<RunningLine> },
    /// Cancel these runs, wait for the table to empty, then close.
    CancelThenClose { ids: Vec<u64> },
    /// Nothing changes.
    Stay,
}

pub fn on_close(_live: &[LiveSummary], _answer: CloseAnswer) -> CloseOutcome {
    CloseOutcome::Close
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runs::{Lane, RunKind};
    use kata_sdlc::holds::{ChangeKey, RepoKey};
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
        assert_eq!(on_close(&[], CloseAnswer::NotAsked), CloseOutcome::Close);
        // Row 2: live runs, not asked yet.
        assert_eq!(on_close(&live, CloseAnswer::NotAsked), asked);
        // R16.1 example 1 and row 3: confirm cancels every live run, then closes.
        assert_eq!(
            on_close(&live, CloseAnswer::Confirm),
            CloseOutcome::CancelThenClose { ids: vec![1, 2] }
        );
        // R16.1 example 2 and row 4: decline changes nothing.
        assert_eq!(on_close(&live, CloseAnswer::Decline), CloseOutcome::Stay);
        // Row 5: a confirm after the runs ended closes at once.
        assert_eq!(on_close(&[], CloseAnswer::Confirm), CloseOutcome::Close);
    }

    #[test]
    fn the_question_names_every_running_change() {
        let live = vec![
            run(1, "A", RunKind::Build, Some("kata")),
            run(2, "B", RunKind::Spec, None),
        ];
        assert_eq!(
            on_close(&live, CloseAnswer::NotAsked),
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
            on_close(&live, CloseAnswer::NotAsked),
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
