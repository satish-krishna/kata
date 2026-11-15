//! Where each repository of a build stands and what each of its tasks shows, from the build log's status and the
//! build host's live state. The build page's tasks area reads this; it decides nothing about the rows itself.
use crate::build::{BuildStatus, RepoState, RepoStatus, TaskStatus};
use crate::coordinator::{AppTurn, Stop};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// Where a repository of the build stands.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Situation {
    /// Its agent runs; `task` is the task the log says is next, null when the log has none for it.
    Working { task: Option<String> },
    /// Its next task waits on a task of another repository.
    Waiting {
        task: String,
        on_task: String,
        on_repo: String,
    },
    /// Its run stopped on `task`.
    Stopped {
        task: String,
        reason: Option<String>,
    },
    /// A task of it is next, and another app of this change has the turn; `stopped` says that app stopped and
    /// has to be continued first. Never a hold: no other change is involved.
    WaitingForApp {
        task: Option<String>,
        app: String,
        stopped: bool,
    },
    /// It has a task to do and no run.
    NotStarted { task: String },
    /// Every task of it is in the build log.
    Finished,
    /// The build log names no task of it and no run is live.
    Idle,
}

/// What one task's row shows.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum TaskState {
    Done { departure: Option<String> },
    Running,
    Waiting { on_task: String, on_repo: String },
    Stopped { reason: Option<String> },
    NotStarted,
}

/// One task of a repository with what its row shows.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct TaskBoard {
    pub id: String,
    pub state: TaskState,
}

/// One repository of the tasks area: where it stands and its tasks, in plan order.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RepoBoard {
    pub repo: String,
    pub situation: Situation,
    pub tasks: Vec<TaskBoard>,
}

/// Where a repository stands: a live run first, then a stop the host recorded, then the build log.
pub fn situation(
    repo: &str,
    now: Option<&RepoStatus>,
    going: &BTreeSet<String>,
    stopped: &BTreeMap<String, Stop>,
    app_turn: Option<&AppTurn>,
) -> Situation {
    if going.contains(repo) {
        let task = match now.map(|n| &n.state) {
            Some(RepoState::Ready { task }) => Some(task.clone()),
            _ => None,
        };
        return Situation::Working { task };
    }
    if let Some(stop) = stopped.get(repo) {
        return Situation::Stopped {
            task: stop.task.clone(),
            reason: Some(stop.reason.clone()),
        };
    }
    // Another app of a single-repo change has the turn: this one waits for it, unless a task dependency already says so.
    let other_app = app_turn.filter(|t| t.app != repo);
    match now.map(|n| &n.state) {
        Some(RepoState::Done) => Situation::Finished,
        Some(RepoState::Ready { task }) if other_app.is_some() => {
            let turn = other_app.expect("checked above");
            Situation::WaitingForApp {
                task: Some(task.clone()),
                app: turn.app.clone(),
                stopped: turn.stopped,
            }
        }
        None => Situation::Idle,
        Some(RepoState::Waiting {
            task,
            on_task,
            on_repo,
        }) => Situation::Waiting {
            task: task.clone(),
            on_task: on_task.clone(),
            on_repo: on_repo.clone(),
        },
        Some(RepoState::Ready { task }) => Situation::NotStarted { task: task.clone() },
    }
}

/// What a task's row shows, given where its repository stands. A task in the build log is done whatever else holds.
pub fn task_state(task: &TaskStatus, situation: &Situation) -> TaskState {
    if let Some(row) = &task.row {
        return TaskState::Done {
            departure: row.departure.clone(),
        };
    }
    match situation {
        Situation::Working { task: Some(on) } if *on == task.id => TaskState::Running,
        Situation::Waiting {
            task: on,
            on_task,
            on_repo,
        } if *on == task.id => TaskState::Waiting {
            on_task: on_task.clone(),
            on_repo: on_repo.clone(),
        },
        Situation::Stopped { task: on, reason } if *on == task.id => TaskState::Stopped {
            reason: reason.clone(),
        },
        _ => TaskState::NotStarted,
    }
}

/// The tasks area for `repos`, in the order given.
pub fn board(
    repos: &[String],
    status: &BuildStatus,
    going: &BTreeSet<String>,
    stopped: &BTreeMap<String, Stop>,
    app_turn: Option<&AppTurn>,
) -> Vec<RepoBoard> {
    repos
        .iter()
        .map(|repo| {
            let now = status.repos.iter().find(|r| &r.repo == repo);
            let situation = situation(repo, now, going, stopped, app_turn);
            let tasks = status
                .tasks
                .iter()
                .filter(|t| &t.repo == repo)
                .map(|t| TaskBoard {
                    id: t.id.clone(),
                    state: task_state(t, &situation),
                })
                .collect();
            RepoBoard {
                repo: repo.clone(),
                situation,
                tasks,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::BuildRow;

    fn repo_status(repo: &str, state: RepoState) -> RepoStatus {
        RepoStatus {
            repo: repo.into(),
            first_unfinished: None,
            state,
            tasks: 2,
            finished: 0,
        }
    }

    fn ready(task: &str) -> RepoState {
        RepoState::Ready { task: task.into() }
    }

    fn waits(task: &str, on_task: &str, on_repo: &str) -> RepoState {
        RepoState::Waiting {
            task: task.into(),
            on_task: on_task.into(),
            on_repo: on_repo.into(),
        }
    }

    fn going(repos: &[&str]) -> BTreeSet<String> {
        repos.iter().map(|r| r.to_string()).collect()
    }

    fn stop(task: &str, reason: &str) -> Stop {
        Stop {
            task: task.into(),
            reason: reason.into(),
            held: false,
        }
    }

    fn stopped(pairs: &[(&str, Stop)]) -> BTreeMap<String, Stop> {
        pairs
            .iter()
            .map(|(r, s)| (r.to_string(), s.clone()))
            .collect()
    }

    fn task(id: &str, repo: &str, departure: Option<Option<&str>>) -> TaskStatus {
        TaskStatus {
            id: id.into(),
            name: format!("task {id}"),
            repo: repo.into(),
            depends_on: vec![],
            text: String::new(),
            red: None,
            red_stands_out: false,
            red_record_wanted: false,
            row: departure.map(|d| BuildRow {
                task: id.into(),
                repo: repo.into(),
                commits: vec![],
                departure: d.map(String::from),
                red: None,
            }),
        }
    }

    /// Every row of the situation table, as the build page's `situationOf` had it.
    #[test]
    fn situation_rows() {
        let none = BTreeMap::new();
        let at_t1 = repo_status("a", ready("T1"));
        let waiting = repo_status("a", waits("T2", "T1", "b"));
        let done = repo_status("a", RepoState::Done);
        // A live run: working on the task the log says is next, or on no known task.
        assert_eq!(
            situation("a", Some(&at_t1), &going(&["a"]), &none, None),
            Situation::Working {
                task: Some("T1".into())
            }
        );
        assert_eq!(
            situation("a", Some(&waiting), &going(&["a"]), &none, None),
            Situation::Working { task: None }
        );
        assert_eq!(
            situation("a", Some(&done), &going(&["a"]), &none, None),
            Situation::Working { task: None }
        );
        assert_eq!(
            situation("a", None, &going(&["a"]), &none, None),
            Situation::Working { task: None }
        );
        // A live run wins over a stop the host still has.
        assert_eq!(
            situation(
                "a",
                Some(&at_t1),
                &going(&["a"]),
                &stopped(&[("a", stop("T1", "cancelled"))]),
                None
            ),
            Situation::Working {
                task: Some("T1".into())
            }
        );
        // A stop: on its task with its reason, whatever the log says.
        let stops = stopped(&[("a", stop("T2", "the agent failed"))]);
        for now in [Some(&at_t1), Some(&done), None] {
            assert_eq!(
                situation("a", now, &going(&["b"]), &stops, None),
                Situation::Stopped {
                    task: "T2".into(),
                    reason: Some("the agent failed".into())
                }
            );
        }
        // No run and no stop: the build log decides.
        assert_eq!(
            situation("a", None, &going(&[]), &none, None),
            Situation::Idle
        );
        assert_eq!(
            situation("a", Some(&done), &going(&[]), &none, None),
            Situation::Finished
        );
        assert_eq!(
            situation("a", Some(&waiting), &going(&[]), &none, None),
            Situation::Waiting {
                task: "T2".into(),
                on_task: "T1".into(),
                on_repo: "b".into()
            }
        );
        assert_eq!(
            situation("a", Some(&at_t1), &going(&[]), &none, None),
            Situation::NotStarted { task: "T1".into() }
        );
        // Another repository's run or stop says nothing about this one.
        assert_eq!(
            situation(
                "a",
                Some(&at_t1),
                &going(&["b"]),
                &stopped(&[("b", stop("T9", "x"))]),
                None
            ),
            Situation::NotStarted { task: "T1".into() }
        );
    }

    fn turn(app: &str, stopped: bool) -> AppTurn {
        AppTurn {
            app: app.into(),
            stopped,
        }
    }

    fn waiting_for(task: &str, app: &str, stopped: bool) -> Situation {
        Situation::WaitingForApp {
            task: Some(task.into()),
            app: app.into(),
            stopped,
        }
    }

    /// The decision table of an app that waits for another app of its change, one case per row (R4.3 to R4.5).
    #[test]
    fn waiting_for_an_app_rows() {
        let none = BTreeMap::new();
        let at_t1 = repo_status("workbench", ready("T1"));
        let on_engine = repo_status("workbench", waits("T1", "T5", "engine"));
        let engine_stop = stopped(&[("engine", stop("T5", "ran out of time"))]);
        let own_stop = stopped(&[("workbench", stop("T1", "cancelled"))]);
        let engine_going = turn("engine", false);
        // Row 1: its own run is live, so it works, whatever else holds (R4.3: finished engine, workbench launched).
        assert_eq!(
            situation(
                "workbench",
                Some(&at_t1),
                &going(&["workbench"]),
                &none,
                None
            ),
            Situation::Working {
                task: Some("T1".into())
            }
        );
        assert_eq!(
            situation(
                "workbench",
                Some(&at_t1),
                &going(&["workbench"]),
                &own_stop,
                Some(&turn("workbench", false))
            ),
            Situation::Working {
                task: Some("T1".into())
            }
        );
        // Row 2: its own stop is recorded, so it reads stopped even with another app's turn.
        assert_eq!(
            situation(
                "workbench",
                Some(&at_t1),
                &going(&[]),
                &own_stop,
                Some(&engine_going)
            ),
            Situation::Stopped {
                task: "T1".into(),
                reason: Some("cancelled".into())
            }
        );
        // Row 3: the next task waits on a task of another app, so it reads as waiting on that task (R4.5).
        assert_eq!(
            situation(
                "workbench",
                Some(&on_engine),
                &going(&[]),
                &none,
                Some(&engine_going)
            ),
            Situation::Waiting {
                task: "T1".into(),
                on_task: "T5".into(),
                on_repo: "engine".into()
            }
        );
        // Row 4: another app is going (R4.3: engine working; engine sent back by checks).
        assert_eq!(
            situation(
                "workbench",
                Some(&at_t1),
                &going(&["engine"]),
                &none,
                Some(&engine_going)
            ),
            waiting_for("T1", "engine", false)
        );
        // Row 5: another app stopped (R4.3: engine stopped out of time); its stop is not this app's.
        assert_eq!(
            situation(
                "workbench",
                Some(&at_t1),
                &going(&[]),
                &engine_stop,
                Some(&turn("engine", true))
            ),
            waiting_for("T1", "engine", true)
        );
        // Row 6: no app's turn, so today's rows (R4.3: engine finished and checks passed; workspace layout).
        assert_eq!(
            situation("workbench", Some(&at_t1), &going(&[]), &none, None),
            Situation::NotStarted { task: "T1".into() }
        );
        assert_eq!(
            situation("workbench", None, &going(&[]), &none, None),
            Situation::Idle
        );
        // An app with every task in the log has nothing to wait for.
        assert_eq!(
            situation(
                "workbench",
                Some(&repo_status("workbench", RepoState::Done)),
                &going(&[]),
                &none,
                Some(&engine_going)
            ),
            Situation::Finished
        );
        // A turn that names the app itself is no other app's turn.
        assert_eq!(
            situation(
                "workbench",
                Some(&at_t1),
                &going(&[]),
                &none,
                Some(&turn("workbench", false))
            ),
            Situation::NotStarted { task: "T1".into() }
        );
        // A waiting app's tasks read not started, never as a hold.
        let t1 = task("T1", "workbench", None);
        assert_eq!(
            task_state(&t1, &waiting_for("T1", "engine", false)),
            TaskState::NotStarted
        );
    }

    /// Every row of the task table, as the build page's `taskStateOf` had it.
    #[test]
    fn task_state_rows() {
        let t1 = task("T1", "a", None);
        let working_t1 = Situation::Working {
            task: Some("T1".into()),
        };
        let waiting_t1 = Situation::Waiting {
            task: "T1".into(),
            on_task: "T7".into(),
            on_repo: "b".into(),
        };
        let stopped_t1 = Situation::Stopped {
            task: "T1".into(),
            reason: Some("cancelled".into()),
        };
        // A task in the build log is done, with its departure, whatever its repository does.
        for s in [
            working_t1.clone(),
            stopped_t1.clone(),
            Situation::Finished,
            Situation::Idle,
        ] {
            assert_eq!(
                task_state(&task("T1", "a", Some(Some("kept the name"))), &s),
                TaskState::Done {
                    departure: Some("kept the name".into())
                }
            );
            assert_eq!(
                task_state(&task("T1", "a", Some(None)), &s),
                TaskState::Done { departure: None }
            );
        }
        // The task the repository is on shows what the repository does.
        assert_eq!(task_state(&t1, &working_t1), TaskState::Running);
        assert_eq!(
            task_state(&t1, &waiting_t1),
            TaskState::Waiting {
                on_task: "T7".into(),
                on_repo: "b".into()
            }
        );
        assert_eq!(
            task_state(&t1, &stopped_t1),
            TaskState::Stopped {
                reason: Some("cancelled".into())
            }
        );
        // Every other task, and every task of a repository not started, finished or idle, is not started.
        let t2 = task("T2", "a", None);
        for s in [
            working_t1,
            Situation::Working { task: None },
            waiting_t1,
            stopped_t1,
            Situation::NotStarted { task: "T1".into() },
            Situation::Finished,
            Situation::Idle,
        ] {
            assert_eq!(task_state(&t2, &s), TaskState::NotStarted, "{s:?}");
        }
        assert_eq!(
            task_state(&t1, &Situation::NotStarted { task: "T1".into() }),
            TaskState::NotStarted
        );
    }

    /// R4.3: the app whose turn it is reaches the board, so an app waiting for it reads as waiting.
    #[test]
    fn the_board_carries_whose_turn_it_is() {
        let status = BuildStatus {
            tasks: vec![task("T1", "engine", None), task("T2", "workbench", None)],
            repos: vec![
                repo_status("engine", ready("T1")),
                repo_status("workbench", ready("T2")),
            ],
            departures: vec![],
            has_tasks: true,
            problems: vec![],
            log_layouts: vec![],
            red_shown: false,
        };
        let repos: Vec<String> = ["engine", "workbench"].map(String::from).to_vec();
        let turn = turn("engine", false);
        let got = board(
            &repos,
            &status,
            &going(&["engine"]),
            &BTreeMap::new(),
            Some(&turn),
        );
        assert_eq!(got[1].situation, waiting_for("T2", "engine", false));
    }

    /// The tasks area: one entry per repository asked for, in that order, each with its own tasks in plan order.
    #[test]
    fn the_board_covers_every_repository_asked_for() {
        let status = BuildStatus {
            tasks: vec![
                task("T1", "a", Some(None)),
                task("T2", "b", None),
                task("T3", "a", None),
            ],
            repos: vec![
                repo_status("a", ready("T3")),
                repo_status("b", waits("T2", "T3", "a")),
            ],
            departures: vec![],
            has_tasks: true,
            problems: vec![],
            log_layouts: vec![],
            red_shown: false,
        };
        let repos: Vec<String> = ["b", "a", "master"].map(String::from).to_vec();
        let got = board(&repos, &status, &going(&["a"]), &BTreeMap::new(), None);
        assert_eq!(
            got,
            vec![
                RepoBoard {
                    repo: "b".into(),
                    situation: Situation::Waiting {
                        task: "T2".into(),
                        on_task: "T3".into(),
                        on_repo: "a".into()
                    },
                    tasks: vec![TaskBoard {
                        id: "T2".into(),
                        state: TaskState::Waiting {
                            on_task: "T3".into(),
                            on_repo: "a".into()
                        }
                    }],
                },
                RepoBoard {
                    repo: "a".into(),
                    situation: Situation::Working {
                        task: Some("T3".into())
                    },
                    tasks: vec![
                        TaskBoard {
                            id: "T1".into(),
                            state: TaskState::Done { departure: None }
                        },
                        TaskBoard {
                            id: "T3".into(),
                            state: TaskState::Running
                        },
                    ],
                },
                RepoBoard {
                    repo: "master".into(),
                    situation: Situation::Idle,
                    tasks: vec![],
                },
            ]
        );
    }
}
