//! A pure build coordinator: the build driver's rules as a state machine with no I/O.
//!
//! The host feeds it `Input`s and carries out the `Command`s it returns: reading the build status
//! or the repositories' heads, launching a run, cancelling one. Whatever the host reads comes back
//! as the next input. The coordinator decides which repositories run, when a repository stops, when
//! a round is done and when the review starts; the host only does what it is told.
use crate::ai_sdlc::state::ChangeState;
use crate::format::ParsedPlan;
use crate::review::ReviewCurrency;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// What the engineer chose for the build's runs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildChoices {
    pub timeout_secs: u64,
    pub instructions: Option<String>,
    pub continue_on_leftovers: bool,
}

/// Where one repository of the build stands.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Readiness {
    /// Its next task can start.
    Ready,
    /// Its next task depends on these unlogged tasks of other repositories.
    Waiting { on: Vec<String> },
    /// Every task of it is logged.
    Done,
}

/// One product repository of the build and where it stands.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RepoReadiness {
    pub repo: String,
    pub state: Readiness,
}

/// One task of the plan and whether the build log has its row.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct TaskFact {
    pub id: String,
    pub repo: String,
    pub logged: bool,
}

/// What the plugin says about the build: the plan's tasks and where each product repository stands.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildFacts {
    /// The plugin reported the plan's tasks, and there is at least one.
    pub has_tasks: bool,
    /// The product repositories in plan order.
    pub repos: Vec<RepoReadiness>,
    /// Every task of the plan, in document order.
    pub tasks: Vec<TaskFact>,
}

/// Where the build stands as a whole.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum BuildPhase {
    Building,
    Reviewing,
    Stopped,
    Finished,
    Cancelled,
}

/// A repository whose next task waits for a task of another repository.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct WaitingRepo {
    pub repo: String,
    pub task: String,
    pub on_task: String,
    pub on_repo: String,
}

/// The tasks of one repository that have no row.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct UnfinishedRepo {
    pub repo: String,
    pub tasks: Vec<String>,
}

/// What a build that stopped by itself leaves to read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct StopReport {
    pub unfinished: Vec<UnfinishedRepo>,
    pub waiting: Vec<WaitingRepo>,
}

/// Why a repository (or the review) does not run by itself.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Stop {
    pub task: String,
    pub reason: String,
    /// The status could not be read when the run ended, so the task the repository is on is unknown.
    pub held: bool,
}

/// What the screens read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildState {
    pub phase: BuildPhase,
    pub going: BTreeSet<String>,
    pub stopped: BTreeMap<String, Stop>,
    /// The pending rounds: repository to instructions.
    pub rounds: BTreeMap<String, String>,
    pub waiting: Vec<WaitingRepo>,
    pub report: Option<StopReport>,
}

/// Which product repositories of the build are ready, waiting or done. `master_name` is the master
/// repository's folder name; the master is never a build repository. A repository is done when every
/// task of it in `change.tasks` is logged, waiting when its first unlogged task (in plan order) depends
/// on an unlogged task of another repository, and ready otherwise.
pub fn readiness(plan: &ParsedPlan, change: &ChangeState, master_name: &str) -> Vec<RepoReadiness> {
    let _ = (plan, change, master_name);
    Vec::new()
}

impl BuildFacts {
    /// The facts from the parsed plan and where the change stands.
    pub fn read(plan: &ParsedPlan, change: &ChangeState, master_name: &str) -> BuildFacts {
        let _ = (plan, change, master_name);
        BuildFacts {
            has_tasks: false,
            repos: Vec::new(),
            tasks: Vec::new(),
        }
    }
}

/// A round the engineer asked for in one repository.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundRequest {
    pub repo: String,
    pub instructions: String,
}

/// What happens to the coordinator.
#[derive(Clone, Debug)]
pub enum Input {
    Begin {
        timeout_secs: u64,
        rounds: Vec<RoundRequest>,
        choices: BuildChoices,
    },
    ContinueRepo {
        repo: String,
    },
    ContinueAll,
    Cancel {
        key: String,
    },
    CancelAll,
    Status(BuildFacts),
    StatusFailed,
    Heads(BTreeMap<String, String>),
    RunEnded {
        key: String,
        instance: u64,
        exit: Option<i32>,
        error: Option<String>,
        /// The run never started because its repository is not checked out.
        refused: bool,
    },
    SetChoices(BuildChoices),
}

/// What the host does.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Command {
    ReadStatus,
    ReadHeads,
    /// Start a run. `key` is the repository's name or `review`; `instance` comes back with the run's end.
    Launch {
        key: String,
        instance: u64,
        task: String,
        instructions: Option<String>,
        timeout_secs: u64,
        choices: BuildChoices,
    },
    CancelRun {
        key: String,
        instance: u64,
    },
}

/// Whether the launch was a task or a round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FactKind {
    Task,
    Round,
}

/// Where a repository stands once its run is over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateAfter {
    Ready,
    Waiting,
    Done,
    /// The status could not be read.
    Unknown,
}

/// What a finished run of one repository tells the coordinator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Facts {
    pub kind: FactKind,
    pub cancelled: bool,
    /// Nonzero exit or an error.
    pub failed: bool,
    /// The launched task has a committed row, or there was no launched task.
    pub recorded: bool,
    pub state_after: StateAfter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The repository does not run again by itself; `held` when its current task is unknown.
    Stop {
        held: bool,
    },
    Finished,
    Continue,
}

/// A combination of facts that cannot happen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Impossible(pub Facts);

/// What to do with a repository once its run is over, for every combination of the facts.
///
/// A round is cleared only on `Finished`: every other outcome keeps it pending, so the next launch
/// of the repository carries its instructions.
pub fn run_outcome(facts: &Facts) -> Result<Outcome, Impossible> {
    let _ = facts;
    todo!("run_outcome")
}

/// The text of a repository's stop. The cancelled fact decides first, and a cancelled stop carries
/// no error text; the exit code, and for exit 0 whether the task was recorded, tell the others apart.
pub fn stop_message(
    exit: Option<i32>,
    error: Option<&str>,
    cancelled: bool,
    recorded: bool,
) -> String {
    let _ = (exit, error, cancelled, recorded);
    todo!("stop_message")
}

const REVIEW: &str = "review";

/// One launched run. Its instance id is never reused, so a cancel aimed at it cannot reach the
/// repository's next run.
struct Run {
    key: String,
    task: String,
    is_round: bool,
    cancelled: bool,
}

struct RunEnd {
    exit: Option<i32>,
    error: Option<String>,
    refused: bool,
}

/// Work waiting its turn: the coordinator does one job at a time, so a run that ends while the
/// status is being read is judged after the job in hand.
enum Job {
    Look { need_heads: bool },
    Ended { instance: u64, end: RunEnd },
}

/// What the coordinator is waiting for the host to answer.
enum Busy {
    HeadsForBegin,
    StatusForLook { from_end: bool },
    HeadsForReview,
    StatusForJudge { run: Run, end: RunEnd },
    HeadsForReviewEnd,
}

/// The build's rules, with no I/O: one run per repository at a time, every repository whose turn it
/// is started at once, a repository that has to wait left waiting, and one review of the whole
/// change when every task has a row.
pub struct Coordinator {
    state: BuildState,
    timeout_secs: u64,
    choices: BuildChoices,
    /// The repositories whose pending round has been launched and has not ended.
    rounds_started: BTreeSet<String>,
    reviewing: bool,
    cancelled_all: bool,
    /// The heads the last review (or the committed current review) covers.
    compare: Option<BTreeMap<String, String>>,
    /// The live run of each repository (or the review), by key.
    instances: BTreeMap<String, u64>,
    live: BTreeMap<u64, Run>,
    seq: u64,
    queue: VecDeque<Job>,
    busy: Option<Busy>,
}

impl Coordinator {
    /// A new session. With a current committed review the compared heads are the heads now, so the
    /// review does not run again by itself.
    pub fn new(currency: ReviewCurrency, heads: BTreeMap<String, String>) -> Self {
        let compare = matches!(currency, ReviewCurrency::Current { .. }).then_some(heads);
        Coordinator {
            state: BuildState {
                phase: BuildPhase::Building,
                going: BTreeSet::new(),
                stopped: BTreeMap::new(),
                rounds: BTreeMap::new(),
                waiting: Vec::new(),
                report: None,
            },
            timeout_secs: 0,
            choices: BuildChoices {
                timeout_secs: 0,
                instructions: None,
                continue_on_leftovers: false,
            },
            rounds_started: BTreeSet::new(),
            reviewing: false,
            cancelled_all: false,
            compare,
            instances: BTreeMap::new(),
            live: BTreeMap::new(),
            seq: 0,
            queue: VecDeque::new(),
            busy: None,
        }
    }

    pub fn state(&self) -> &BuildState {
        &self.state
    }

    pub fn step(&mut self, input: Input) -> Vec<Command> {
        let _ = input;
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_sdlc::state::RepoTasks;
    use crate::format::ParsedTask;
    use crate::permissions::fixtures::change_state;

    fn none_choices() -> BuildChoices {
        BuildChoices {
            timeout_secs: 3600,
            instructions: None,
            continue_on_leftovers: false,
        }
    }

    fn github_off() -> BuildChoices {
        BuildChoices {
            timeout_secs: 3600,
            instructions: Some("github off".into()),
            continue_on_leftovers: true,
        }
    }

    struct Pt {
        id: &'static str,
        repo: &'static str,
        deps: Vec<&'static str>,
    }

    fn t(id: &'static str, repo: &'static str) -> Pt {
        Pt {
            id,
            repo,
            deps: vec![],
        }
    }

    fn td(id: &'static str, repo: &'static str, deps: &[&'static str]) -> Pt {
        Pt {
            id,
            repo,
            deps: deps.to_vec(),
        }
    }

    fn parsed(p: &Pt) -> ParsedTask {
        ParsedTask {
            id: p.id.into(),
            name: p.id.into(),
            repo: p.repo.into(),
            depends_on: p.deps.iter().map(|d| d.to_string()).collect(),
            uses: Vec::new(),
            files: Vec::new(),
            covers: Vec::new(),
            supports: Vec::new(),
            sections: Vec::new(),
            text: format!("### {}", p.id),
            line: 1,
        }
    }

    /// The plan the format program would parse and the state the plugin would report for it, with the
    /// tasks in `rows` logged.
    fn plan_and_change(plan: &[Pt], rows: &BTreeSet<String>) -> (ParsedPlan, ChangeState) {
        let parsed = ParsedPlan {
            tasks: plan.iter().map(parsed).collect(),
            shared_decisions: Vec::new(),
        };
        let mut change = change_state("c", "/ws/master", false);
        let mut tasks: BTreeMap<String, RepoTasks> = BTreeMap::new();
        for p in plan {
            let entry = tasks
                .entry(p.repo.to_string())
                .or_insert_with(|| RepoTasks {
                    all: Vec::new(),
                    logged: Vec::new(),
                    unlogged: Vec::new(),
                    commits: None,
                    untasked: None,
                    uncommitted: None,
                });
            entry.all.push(p.id.to_string());
            if rows.contains(p.id) {
                entry.logged.push(p.id.to_string());
            } else {
                entry.unlogged.push(p.id.to_string());
            }
        }
        change.tasks = Some(tasks);
        (parsed, change)
    }

    struct Started {
        key: String,
        instance: u64,
        timeout_secs: u64,
        instructions: Option<String>,
        choices: BuildChoices,
        aborted: bool,
    }

    /// A scripted master repository: the plan's tasks, the rows committed so far, and a host that
    /// carries out the coordinator's commands.
    struct World {
        plan: Vec<Pt>,
        rows: BTreeSet<String>,
        heads: BTreeMap<String, String>,
        started: Vec<Started>,
        log: Vec<String>,
        status_failures: u32,
        co: Coordinator,
    }

    fn world(plan: Vec<Pt>, rows: &[&str]) -> World {
        world_with(plan, rows, ReviewCurrency::None, BTreeMap::new())
    }

    fn world_with(
        plan: Vec<Pt>,
        rows: &[&str],
        currency: ReviewCurrency,
        heads: BTreeMap<String, String>,
    ) -> World {
        World {
            plan,
            rows: rows.iter().map(|r| r.to_string()).collect(),
            heads: heads.clone(),
            started: Vec::new(),
            log: Vec::new(),
            status_failures: 0,
            co: Coordinator::new(currency, heads),
        }
    }

    impl World {
        fn status(&self) -> BuildFacts {
            let (plan, change) = plan_and_change(&self.plan, &self.rows);
            BuildFacts::read(&plan, &change, "master")
        }

        fn feed(&mut self, input: Input) {
            let mut cmds: VecDeque<Command> = self.co.step(input).into();
            while let Some(c) = cmds.pop_front() {
                let more = match c {
                    Command::ReadStatus => {
                        if self.status_failures > 0 {
                            self.status_failures -= 1;
                            self.co.step(Input::StatusFailed)
                        } else {
                            let s = self.status();
                            self.co.step(Input::Status(s))
                        }
                    }
                    Command::ReadHeads => self.co.step(Input::Heads(self.heads.clone())),
                    Command::Launch {
                        key,
                        instance,
                        task: _,
                        instructions,
                        timeout_secs,
                        choices,
                    } => {
                        self.log.push(key.clone());
                        self.started.push(Started {
                            key,
                            instance,
                            timeout_secs,
                            instructions,
                            choices,
                            aborted: false,
                        });
                        vec![]
                    }
                    Command::CancelRun { key, instance } => {
                        for s in &mut self.started {
                            if s.key == key && s.instance == instance {
                                s.aborted = true;
                            }
                        }
                        vec![]
                    }
                };
                cmds.extend(more);
            }
        }

        fn begin(&mut self, timeout_secs: u64) {
            self.begin_with(timeout_secs, &[], none_choices());
        }

        fn begin_rounds(&mut self, timeout_secs: u64, rounds: &[(&str, &str)]) {
            self.begin_with(timeout_secs, rounds, none_choices());
        }

        fn begin_with(
            &mut self,
            timeout_secs: u64,
            rounds: &[(&str, &str)],
            choices: BuildChoices,
        ) {
            self.feed(Input::Begin {
                timeout_secs,
                rounds: rounds
                    .iter()
                    .map(|(r, i)| RoundRequest {
                        repo: r.to_string(),
                        instructions: i.to_string(),
                    })
                    .collect(),
                choices,
            });
        }

        fn continue_repo(&mut self, repo: &str) {
            self.feed(Input::ContinueRepo { repo: repo.into() });
        }

        fn continue_all(&mut self) {
            self.feed(Input::ContinueAll);
        }

        fn cancel(&mut self, key: &str) {
            self.feed(Input::Cancel { key: key.into() });
        }

        fn cancel_all(&mut self) {
            self.feed(Input::CancelAll);
        }

        fn set_head(&mut self, repo: &str, sha: &str) {
            self.heads.insert(repo.into(), sha.into());
        }

        /// Indexes into `started` of the runs of one repository.
        fn of(&self, repo: &str) -> Vec<usize> {
            (0..self.started.len())
                .filter(|&i| self.started[i].key == repo)
                .collect()
        }

        /// The run at `idx` ends: `rows` are committed first, as the agent would have.
        fn end(&mut self, idx: usize, rows: &[&str], exit: Option<i32>, error: Option<&str>) {
            for r in rows {
                self.rows.insert(r.to_string());
            }
            let s = &self.started[idx];
            let input = Input::RunEnded {
                key: s.key.clone(),
                instance: s.instance,
                exit,
                error: error.map(str::to_string),
                refused: false,
            };
            self.feed(input);
        }

        fn end_ok(&mut self, idx: usize, rows: &[&str]) {
            self.end(idx, rows, Some(0), None);
        }

        fn going(&self) -> Vec<String> {
            self.co.state().going.iter().cloned().collect()
        }

        fn stopped(&self, repo: &str) -> Option<&Stop> {
            self.co.state().stopped.get(repo)
        }

        fn phase(&self) -> BuildPhase {
            self.co.state().phase
        }

        fn waiting_repos(&self) -> Vec<String> {
            self.co
                .state()
                .waiting
                .iter()
                .map(|w| w.repo.clone())
                .collect()
        }

        fn pending(&self) -> Vec<String> {
            self.co.state().rounds.keys().cloned().collect()
        }
    }

    fn sm(exit: Option<i32>, error: Option<&str>) -> String {
        stop_message(exit, error, false, true)
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn reviews(log: &[String]) -> usize {
        log.iter().filter(|l| *l == "review").count()
    }

    // ---- BuildDriver ----

    #[test]
    fn independent_repositories_start_together_r19_1() {
        let mut w = world(vec![t("T1", "app"), t("T2", "api")], &[]);
        w.begin(3600);
        assert_eq!(w.log, strs(&["app", "api"]));
        assert_eq!(w.going(), strs(&["api", "app"]));
    }

    #[test]
    fn a_waiting_repository_is_shown_as_waiting_and_starts_once_its_dependency_has_a_row_r19_2() {
        let mut w = world(vec![t("T1", "api"), td("T2", "app", &["T1"])], &[]);
        w.begin(3600);
        assert_eq!(w.log, strs(&["api"]));
        assert!(w.stopped("app").is_none());
        assert_eq!(
            w.co.state().waiting,
            vec![WaitingRepo {
                repo: "app".into(),
                task: "T2".into(),
                on_task: "T1".into(),
                on_repo: "api".into()
            }]
        );
        let i = w.of("api")[0];
        w.end_ok(i, &["T1"]);
        assert_eq!(w.log, strs(&["api", "app"]));
        assert!(w.co.state().waiting.is_empty());
        assert!(w.co.state().stopped.is_empty());
    }

    #[test]
    fn a_repository_waiting_on_an_unrecorded_task_does_not_start_r14_2() {
        let mut w = world(vec![t("T1", "api"), td("T2", "app", &["T1"])], &[]);
        w.begin(3600);
        let i = w.of("api")[0];
        w.end(i, &[], Some(0), None);
        assert_eq!(
            w.stopped("api"),
            Some(&Stop {
                task: "T1".into(),
                reason: stop_message(Some(0), None, false, false),
                held: false
            })
        );
        assert_eq!(w.log, strs(&["api"]));
        assert_eq!(w.waiting_repos(), strs(&["app"]));
        assert!(w.stopped("app").is_none());
    }

    #[test]
    fn alternating_tasks_take_several_runs_all_started_by_the_driver_r18_6() {
        let mut w = world(
            vec![
                t("T1", "app"),
                td("T2", "api", &["T1"]),
                td("T3", "app", &["T2"]),
            ],
            &[],
        );
        w.begin(3600);
        assert_eq!(w.log, strs(&["app"]));
        let i = w.of("app")[0];
        w.end_ok(i, &["T1"]);
        assert_eq!(w.log, strs(&["app", "api"]));
        let i = w.of("api")[0];
        w.end_ok(i, &["T2"]);
        assert_eq!(w.log, strs(&["app", "api", "app"]));
        assert_eq!(w.of("app").len(), 2);
    }

    #[test]
    fn a_repository_never_has_two_runs_at_once_r19_5() {
        let mut w = world(vec![t("T1", "app"), t("T2", "app")], &[]);
        w.begin(3600);
        assert_eq!(w.log, strs(&["app"]));
        w.continue_all();
        assert_eq!(w.log, strs(&["app"]));
        let i = w.of("app")[0];
        w.end_ok(i, &["T1"]);
        assert_eq!(w.log, strs(&["app", "app"]));
    }

    #[test]
    fn a_stopped_repository_does_not_stop_the_others_r6_7() {
        let mut w = world(
            vec![t("T1", "app"), t("T2", "api"), td("T3", "docs", &["T1"])],
            &[],
        );
        w.begin(3600);
        let i = w.of("app")[0];
        w.end(i, &[], Some(124), None);
        assert_eq!(w.stopped("app").unwrap().reason, sm(Some(124), None));
        assert_eq!(w.going(), strs(&["api"]));
        assert_eq!(w.waiting_repos(), strs(&["docs"]));
        assert_eq!(w.phase(), BuildPhase::Building);
    }

    #[test]
    fn continue_restarts_only_the_stopped_repository_r6_2() {
        let mut w = world(
            vec![
                t("T1", "app"),
                t("T2", "app"),
                t("T3", "app"),
                t("T4", "api"),
            ],
            &["T1", "T2"],
        );
        w.begin(3600);
        let i = w.of("app")[0];
        w.end(i, &[], Some(124), None);
        assert!(w.stopped("app").is_some());
        assert_eq!(w.log, strs(&["app", "api"]));
        w.continue_repo("app");
        assert_eq!(w.log, strs(&["app", "api", "app"]));
        assert_eq!(w.of("api").len(), 1);
        assert!(w.co.state().stopped.is_empty());
        assert_eq!(w.phase(), BuildPhase::Building);
    }

    #[test]
    fn a_run_that_stops_on_its_second_task_stays_stopped_and_is_not_relaunched_r6_1_exit() {
        for (exit, error) in [(124, None), (123, None), (1, Some("the agent crashed"))] {
            let mut w = world(
                vec![
                    t("T1", "app"),
                    t("T2", "app"),
                    t("T3", "app"),
                    t("T4", "app"),
                ],
                &[],
            );
            w.begin(3600);
            let i = w.of("app")[0];
            w.end(i, &["T1", "T2"], Some(exit), error);
            assert_eq!(
                w.stopped("app"),
                Some(&Stop {
                    task: "T3".into(),
                    reason: sm(Some(exit), error),
                    held: false
                }),
                "exit {exit}"
            );
            assert_eq!(w.log, strs(&["app"]));
            assert!(w.co.state().going.is_empty());
            assert_eq!(w.phase(), BuildPhase::Stopped);
            w.continue_repo("app");
            assert_eq!(w.log, strs(&["app", "app"]));
        }
    }

    #[test]
    fn the_build_stops_with_the_unfinished_tasks_by_repository_when_nothing_can_run_r19_6() {
        let mut w = world(
            vec![t("T1", "api"), t("T2", "api"), td("T3", "app", &["T2"])],
            &[],
        );
        w.begin(3600);
        let i = w.of("api")[0];
        w.end_ok(i, &["T1"]);
        let i = w.of("api")[1];
        w.end(i, &[], Some(125), None);
        assert_eq!(w.phase(), BuildPhase::Stopped);
        assert_eq!(
            w.co.state().report,
            Some(StopReport {
                unfinished: vec![
                    UnfinishedRepo {
                        repo: "api".into(),
                        tasks: strs(&["T2"])
                    },
                    UnfinishedRepo {
                        repo: "app".into(),
                        tasks: strs(&["T3"])
                    },
                ],
                waiting: vec![WaitingRepo {
                    repo: "app".into(),
                    task: "T3".into(),
                    on_task: "T2".into(),
                    on_repo: "api".into()
                }],
            })
        );
        assert!(!w.log.contains(&"review".to_string()));
    }

    #[test]
    fn the_driver_gives_every_run_the_time_limit_the_engineer_set_r2_6() {
        let mut w = world(vec![t("T1", "app"), t("T2", "api"), t("T3", "app")], &[]);
        w.begin(14400);
        let i = w.of("app")[0];
        w.end_ok(i, &["T1"]);
        let limits: Vec<u64> = w.started.iter().map(|s| s.timeout_secs).collect();
        assert_eq!(limits, vec![14400, 14400, 14400]);
    }

    #[test]
    fn the_review_starts_once_every_task_has_a_row_and_nothing_is_going() {
        let mut w = world(vec![t("T1", "app"), t("T2", "api")], &[]);
        w.set_head("app", "a1");
        w.begin(3600);
        w.end_ok(0, &["T1"]);
        assert_eq!(w.log, strs(&["app", "api"]));
        w.end_ok(1, &["T2"]);
        assert_eq!(w.log, strs(&["app", "api", "review"]));
        assert_eq!(w.phase(), BuildPhase::Reviewing);
        w.end_ok(2, &[]);
        assert_eq!(reviews(&w.log), 1);
        assert_eq!(w.phase(), BuildPhase::Finished);
    }

    #[test]
    fn the_review_s_own_commit_in_the_master_does_not_start_another_review() {
        let mut w = world(vec![t("T1", "api")], &["T1"]);
        w.set_head("master", "m1");
        w.set_head("api", "h1");
        w.begin(3600);
        assert_eq!(w.log, strs(&["review"]));
        // The review records its findings: a docs commit in the master.
        w.set_head("master", "m2");
        w.end_ok(0, &[]);
        assert_eq!(w.log, strs(&["review"]));
        assert_eq!(w.phase(), BuildPhase::Finished);
        // A later round that commits nothing is still not reviewed again: the review's commit is the new baseline.
        w.begin_rounds(3600, &[("api", "look around")]);
        w.end_ok(1, &[]);
        assert_eq!(w.log, strs(&["review", "api"]));
        assert_eq!(w.phase(), BuildPhase::Finished);
    }

    #[test]
    fn a_round_with_new_commits_starts_a_new_review() {
        let mut w = world(vec![t("T1", "api")], &["T1"]);
        w.set_head("api", "h1");
        w.begin(3600);
        assert_eq!(w.log, strs(&["review"]));
        w.end_ok(0, &[]);
        assert_eq!(w.phase(), BuildPhase::Finished);
        w.begin_rounds(3600, &[("api", "rename the status field to state")]);
        assert_eq!(w.log, strs(&["review", "api"]));
        w.set_head("api", "h2");
        w.end_ok(1, &[]);
        assert_eq!(w.log, strs(&["review", "api", "review"]));
        w.end_ok(2, &[]);
        assert_eq!(w.phase(), BuildPhase::Finished);
    }

    #[test]
    fn a_round_without_new_commits_does_not_review_again() {
        let mut w = world(vec![t("T1", "api")], &["T1"]);
        w.set_head("api", "h1");
        w.begin(3600);
        w.end_ok(0, &[]);
        w.begin_rounds(3600, &[("api", "look around")]);
        w.end_ok(1, &[]);
        assert_eq!(w.log, strs(&["review", "api"]));
        assert_eq!(w.phase(), BuildPhase::Finished);
    }

    #[test]
    fn a_round_on_a_finished_repository_starts_it() {
        let mut w = world(vec![t("T1", "api"), t("T2", "app")], &["T1", "T2"]);
        w.begin_rounds(7200, &[("api", "rename the status field to state")]);
        assert_eq!(w.log, strs(&["api"]));
        assert_eq!(
            w.started[0].instructions.as_deref(),
            Some("rename the status field to state")
        );
        assert_eq!(w.started[0].timeout_secs, 7200);
        assert!(w.co.state().rounds.contains_key("api"));
    }

    #[test]
    fn a_round_for_a_repository_the_plan_does_not_name_still_runs_r8_1() {
        let mut w = world(vec![t("T1", "api")], &["T1"]);
        w.begin_rounds(3600, &[("master", "tidy the notes")]);
        assert_eq!(w.log, strs(&["master"]));
        assert_eq!(w.started[0].instructions.as_deref(), Some("tidy the notes"));
        assert_eq!(w.phase(), BuildPhase::Building);
    }

    #[test]
    fn a_round_for_the_master_that_fails_stops_the_build_instead_of_finishing_it_and_continue_runs_it_again_r6_1_r8_1(
    ) {
        let mut w = world(vec![t("T1", "api")], &["T1"]);
        w.begin_rounds(3600, &[("master", "tidy the notes")]);
        w.end(0, &[], Some(124), None);
        assert_eq!(
            w.stopped("master"),
            Some(&Stop {
                task: "".into(),
                reason: sm(Some(124), None),
                held: false
            })
        );
        assert_eq!(w.phase(), BuildPhase::Stopped);
        assert_eq!(w.log, strs(&["master"]));
        w.continue_repo("master");
        assert_eq!(w.log, strs(&["master", "master"]));
        assert_eq!(w.started[1].instructions.as_deref(), Some("tidy the notes"));
        w.end_ok(1, &[]);
        assert!(w.co.state().stopped.is_empty());
        assert!(w.co.state().rounds.is_empty());
        assert_eq!(w.phase(), BuildPhase::Finished);
    }

    #[test]
    fn a_round_on_a_finished_repository_that_fails_stops_the_build_and_continue_runs_it_again_r6_1_r8_1(
    ) {
        let mut w = world(vec![t("T1", "api"), t("T2", "app")], &["T1", "T2"]);
        w.begin_rounds(3600, &[("api", "rename it")]);
        w.end(0, &[], Some(124), None);
        assert_eq!(w.phase(), BuildPhase::Stopped);
        assert_eq!(w.stopped("api").unwrap().reason, sm(Some(124), None));
        w.continue_repo("api");
        assert_eq!(w.of("api").len(), 2);
        let i = w.of("api")[1];
        assert_eq!(w.started[i].instructions.as_deref(), Some("rename it"));
    }

    #[test]
    fn a_committing_round_for_the_master_is_reviewed_again_r8_4() {
        let mut w = world(vec![t("T1", "api")], &["T1"]);
        w.set_head("master", "m1");
        w.begin_rounds(3600, &[("master", "tidy the notes")]);
        w.set_head("master", "m2");
        w.end_ok(0, &[]);
        assert_eq!(w.log, strs(&["master", "review"]));
    }

    #[test]
    fn a_round_for_a_waiting_repository_is_not_dropped_silently_r8_3() {
        let mut w = world(vec![t("T1", "app"), td("T2", "api", &["T1"])], &[]);
        w.begin_rounds(3600, &[("api", "rename it")]);
        w.end(0, &[], Some(1), None);
        assert_eq!(w.phase(), BuildPhase::Stopped);
        assert!(w.co.state().rounds.contains_key("api"));
        w.continue_repo("app");
        w.end_ok(1, &["T1"]);
        let i = w.of("api")[0];
        assert_eq!(w.started[i].instructions.as_deref(), Some("rename it"));
    }

    #[test]
    fn a_failed_status_read_while_other_runs_go_does_not_stop_the_build_r6_7_r10_1() {
        let mut w = world(vec![t("T1", "app"), t("T2", "api")], &[]);
        w.begin(3600);
        w.status_failures = 1;
        let i = w.of("app")[0];
        w.end_ok(i, &["T1"]);
        assert!(w.co.state().going.contains("api"));
        assert_eq!(w.phase(), BuildPhase::Building);
    }

    #[test]
    fn a_failed_status_read_with_nothing_else_going_stops_the_build() {
        let mut w = world(vec![t("T1", "app")], &[]);
        w.begin(3600);
        w.status_failures = 1;
        let i = w.of("app")[0];
        w.end_ok(i, &["T1"]);
        assert_eq!(w.phase(), BuildPhase::Stopped);
    }

    #[test]
    fn a_run_whose_status_read_fails_is_marked_stopped_and_is_not_relaunched_when_another_run_ends_r6_1(
    ) {
        let mut w = world(
            vec![
                t("T1", "app"),
                t("T2", "app"),
                t("T3", "app"),
                t("T4", "app"),
                t("T5", "api"),
            ],
            &[],
        );
        w.begin(3600);
        w.rows.insert("T1".into());
        w.rows.insert("T2".into());
        w.status_failures = 1;
        let i = w.of("app")[0];
        w.end(i, &[], Some(124), None);
        assert!(w
            .stopped("app")
            .unwrap()
            .reason
            .contains("could not read build status"));
        let i = w.of("api")[0];
        w.end_ok(i, &["T5"]);
        assert_eq!(w.of("app").len(), 1);
        assert!(!w.co.state().going.contains("app"));
        assert_eq!(w.phase(), BuildPhase::Stopped);
    }

    #[test]
    fn cancel_all_starts_nothing_new() {
        let mut w = world(vec![t("T1", "app"), t("T2", "api"), t("T3", "app")], &[]);
        w.begin(3600);
        w.cancel_all();
        assert!(w.started.iter().all(|s| s.aborted));
        let i = w.of("app")[0];
        w.end(i, &["T1"], Some(130), None);
        let i = w.of("api")[0];
        w.end(i, &[], Some(130), None);
        assert_eq!(w.log, strs(&["app", "api"]));
        assert_eq!(w.phase(), BuildPhase::Cancelled);
        assert!(w.co.state().going.is_empty());
    }

    #[test]
    fn cancel_stops_one_repository_and_leaves_it_stopped() {
        let mut w = world(vec![t("T1", "app"), t("T2", "api")], &[]);
        w.begin(3600);
        w.cancel("app");
        let (a, b) = (w.of("app")[0], w.of("api")[0]);
        assert!(w.started[a].aborted);
        assert!(!w.started[b].aborted);
        w.end(a, &[], Some(130), None);
        assert_eq!(w.stopped("app").unwrap().reason, sm(Some(130), None));
        assert_eq!(w.going(), strs(&["api"]));
    }

    #[test]
    fn a_repository_the_engineer_cancelled_says_stopped_cancelled_whatever_the_engine_exited_with_exit(
    ) {
        for (exit, error) in [
            (Some(0), None),
            (Some(1), Some("boom")),
            (Some(124), None),
            (None, None),
        ] {
            let mut w = world(vec![t("T1", "app"), t("T2", "api")], &[]);
            w.begin(3600);
            w.cancel("app");
            let i = w.of("app")[0];
            w.end(i, &[], exit, error);
            assert_eq!(
                w.stopped("app").unwrap().reason,
                "Stopped: cancelled",
                "exit {exit:?}"
            );
        }
    }

    #[test]
    fn a_run_nobody_cancelled_that_exits_1_still_says_the_agent_failed() {
        let mut w = world(vec![t("T1", "app")], &[]);
        w.begin(3600);
        let i = w.of("app")[0];
        w.end(i, &[], Some(1), None);
        assert_eq!(
            w.stopped("app").unwrap().reason,
            "Stopped: the agent failed"
        );
    }

    #[test]
    fn a_task_run_that_exits_0_without_recording_its_ready_task_stops_with_ended_without_its_task_being_recorded(
    ) {
        let mut w = world(vec![t("T1", "app")], &[]);
        w.begin(3600);
        let i = w.of("app")[0];
        w.end(i, &[], Some(0), None);
        assert_eq!(
            w.stopped("app").unwrap().reason,
            "Stopped: ended without its task being recorded"
        );
    }

    #[test]
    fn a_cancelled_repository_that_is_now_waiting_is_not_relaunched_when_its_dependency_gets_a_row_r6_1(
    ) {
        let mut w = world(
            vec![t("T1", "app"), td("T2", "app", &["T3"]), t("T3", "api")],
            &[],
        );
        w.begin(3600);
        assert_eq!(w.log, strs(&["app", "api"]));
        w.cancel("app");
        let i = w.of("app")[0];
        w.end(i, &["T1"], Some(130), None);
        assert_eq!(
            w.stopped("app"),
            Some(&Stop {
                task: "T2".into(),
                reason: sm(Some(130), None),
                held: false
            })
        );
        let i = w.of("api")[0];
        w.end_ok(i, &["T3"]);
        assert_eq!(w.log, strs(&["app", "api"]));
        assert!(!w.co.state().going.contains("app"));
    }

    #[test]
    fn a_run_that_recorded_every_task_for_its_repository_is_finished_whatever_its_exit_code_exit() {
        for (exit, error) in [(124, None), (123, None), (1, Some("the agent crashed"))] {
            let mut w = world(vec![t("T1", "app"), t("T2", "app")], &[]);
            w.set_head("app", "a1");
            w.begin(3600);
            let i = w.of("app")[0];
            w.end(i, &["T1", "T2"], Some(exit), error);
            assert!(w.co.state().stopped.is_empty(), "exit {exit}");
            assert_eq!(w.phase(), BuildPhase::Reviewing);
            assert_eq!(w.log, strs(&["app", "review"]));
        }
    }

    #[test]
    fn a_round_that_recorded_every_task_but_failed_stays_stopped_r6_1_r8_1() {
        let mut w = world(vec![t("T1", "app"), t("T2", "app")], &[]);
        w.begin_rounds(3600, &[("app", "finish it")]);
        let i = w.of("app")[0];
        w.end(i, &["T1", "T2"], Some(124), None);
        assert!(w.stopped("app").is_some());
        assert_eq!(w.phase(), BuildPhase::Stopped);
    }

    #[test]
    fn a_round_that_ends_cleanly_with_no_row_for_its_launch_task_stops_is_not_relaunched_by_itself_and_continue_reruns_it_with_its_instructions_r8_1(
    ) {
        let mut w = world(vec![t("T1", "app")], &[]);
        w.begin_rounds(3600, &[("app", "finish it")]);
        assert_eq!(w.of("app").len(), 1);
        assert_eq!(w.started[0].instructions.as_deref(), Some("finish it"));
        w.end(0, &[], Some(0), None);
        assert_eq!(w.of("app").len(), 1);
        assert!(!w.co.state().going.contains("app"));
        assert_eq!(
            w.stopped("app"),
            Some(&Stop {
                task: "T1".into(),
                reason: stop_message(Some(0), None, false, false),
                held: false
            })
        );
        assert_eq!(w.phase(), BuildPhase::Stopped);
        assert_eq!(w.co.state().rounds.len(), 1);
        w.continue_repo("app");
        assert_eq!(w.of("app").len(), 2);
        assert_eq!(w.started[1].instructions.as_deref(), Some("finish it"));
    }

    // ---- runOutcome ----

    const STOP: Option<Outcome> = Some(Outcome::Stop { held: false });
    const HELD: Option<Outcome> = Some(Outcome::Stop { held: true });
    const FINISHED: Option<Outcome> = Some(Outcome::Finished);
    const CARRY_ON: Option<Outcome> = Some(Outcome::Continue);
    /// `None` is an impossible combination.
    const IMPOSSIBLE: Option<Outcome> = None;

    use FactKind::{Round, Task};
    use StateAfter::{Done, Ready, Unknown, Waiting};

    /// Every combination, with its outcome written out by hand: nothing here is derived from the code.
    #[rustfmt::skip]
    const CASES: [(FactKind, bool, bool, bool, StateAfter, Option<Outcome>); 64] = [
        (Task, false, false, true, Ready, CARRY_ON),
        (Task, false, false, true, Waiting, CARRY_ON),
        (Task, false, false, true, Done, FINISHED),
        (Task, false, false, true, Unknown, IMPOSSIBLE),
        (Task, false, false, false, Ready, STOP),
        (Task, false, false, false, Waiting, CARRY_ON),
        (Task, false, false, false, Done, IMPOSSIBLE),
        (Task, false, false, false, Unknown, HELD),
        (Task, false, true, true, Ready, STOP),
        (Task, false, true, true, Waiting, STOP),
        (Task, false, true, true, Done, FINISHED),
        (Task, false, true, true, Unknown, IMPOSSIBLE),
        (Task, false, true, false, Ready, STOP),
        (Task, false, true, false, Waiting, STOP),
        (Task, false, true, false, Done, IMPOSSIBLE),
        (Task, false, true, false, Unknown, HELD),
        (Task, true, false, true, Ready, STOP),
        (Task, true, false, true, Waiting, STOP),
        (Task, true, false, true, Done, FINISHED),
        (Task, true, false, true, Unknown, IMPOSSIBLE),
        (Task, true, false, false, Ready, STOP),
        (Task, true, false, false, Waiting, STOP),
        (Task, true, false, false, Done, IMPOSSIBLE),
        (Task, true, false, false, Unknown, HELD),
        (Task, true, true, true, Ready, STOP),
        (Task, true, true, true, Waiting, STOP),
        (Task, true, true, true, Done, FINISHED),
        (Task, true, true, true, Unknown, IMPOSSIBLE),
        (Task, true, true, false, Ready, STOP),
        (Task, true, true, false, Waiting, STOP),
        (Task, true, true, false, Done, IMPOSSIBLE),
        (Task, true, true, false, Unknown, HELD),
        (Round, false, false, true, Ready, CARRY_ON),
        (Round, false, false, true, Waiting, CARRY_ON),
        (Round, false, false, true, Done, FINISHED),
        (Round, false, false, true, Unknown, HELD),
        (Round, false, false, false, Ready, STOP),
        (Round, false, false, false, Waiting, STOP),
        (Round, false, false, false, Done, IMPOSSIBLE),
        (Round, false, false, false, Unknown, HELD),
        (Round, false, true, true, Ready, STOP),
        (Round, false, true, true, Waiting, STOP),
        (Round, false, true, true, Done, STOP),
        (Round, false, true, true, Unknown, HELD),
        (Round, false, true, false, Ready, STOP),
        (Round, false, true, false, Waiting, STOP),
        (Round, false, true, false, Done, IMPOSSIBLE),
        (Round, false, true, false, Unknown, HELD),
        (Round, true, false, true, Ready, STOP),
        (Round, true, false, true, Waiting, STOP),
        (Round, true, false, true, Done, STOP),
        (Round, true, false, true, Unknown, HELD),
        (Round, true, false, false, Ready, STOP),
        (Round, true, false, false, Waiting, STOP),
        (Round, true, false, false, Done, IMPOSSIBLE),
        (Round, true, false, false, Unknown, HELD),
        (Round, true, true, true, Ready, STOP),
        (Round, true, true, true, Waiting, STOP),
        (Round, true, true, true, Done, STOP),
        (Round, true, true, true, Unknown, HELD),
        (Round, true, true, false, Ready, STOP),
        (Round, true, true, false, Waiting, STOP),
        (Round, true, true, false, Done, IMPOSSIBLE),
        (Round, true, true, false, Unknown, HELD),
    ];

    #[test]
    fn the_table_has_one_row_for_every_combination_of_the_facts() {
        assert_eq!(CASES.len(), 64);
        let keys: BTreeSet<String> = CASES
            .iter()
            .map(|c| format!("{:?}|{}|{}|{}|{:?}", c.0, c.1, c.2, c.3, c.4))
            .collect();
        assert_eq!(keys.len(), 64);
    }

    #[test]
    fn outcome_rows() {
        for (kind, cancelled, failed, recorded, state_after, want) in CASES {
            let facts = Facts {
                kind,
                cancelled,
                failed,
                recorded,
                state_after,
            };
            let got = run_outcome(&facts);
            match want {
                None => assert_eq!(got, Err(Impossible(facts)), "{facts:?}"),
                Some(o) => assert_eq!(got, Ok(o), "{facts:?}"),
            }
        }
    }

    // ---- BuildDriver outcomes ----

    #[test]
    fn cancelling_a_round_on_a_finished_repository_stops_it_with_continue_never_finishing_or_reviewing_b1(
    ) {
        let mut w = world(vec![t("T1", "api"), t("T2", "app")], &["T1", "T2"]);
        w.begin_rounds(3600, &[("app", "rename it")]);
        w.cancel("app");
        w.end(0, &[], Some(130), None);
        assert_eq!(w.stopped("app").unwrap().reason, sm(Some(130), None));
        assert_eq!(w.phase(), BuildPhase::Stopped);
        assert_eq!(w.log, strs(&["app"]));
        assert_eq!(w.co.state().rounds.len(), 1);
        w.continue_repo("app");
        assert_eq!(w.of("app").len(), 2);
        let i = w.of("app")[1];
        assert_eq!(w.started[i].instructions.as_deref(), Some("rename it"));
    }

    #[test]
    fn a_cancel_that_reaches_a_repository_with_no_run_going_does_not_mark_its_next_run_cancelled_b7(
    ) {
        let mut w = world(
            vec![t("T1", "app"), td("T2", "api", &["T1"]), t("T3", "api")],
            &[],
        );
        w.begin(3600);
        assert_eq!(w.log, strs(&["app"]));
        w.cancel("api");
        let i = w.of("app")[0];
        w.end_ok(i, &["T1"]);
        assert_eq!(w.log, strs(&["app", "api"]));
        let a = w.of("api")[0];
        assert!(!w.started[a].aborted);
        w.end_ok(a, &["T2"]);
        assert!(w.co.state().stopped.is_empty());
        assert_eq!(w.log, strs(&["app", "api", "api"]));
    }

    #[test]
    fn a_round_that_blocks_on_another_repository_keeps_its_instructions_for_the_relaunch_r6_2() {
        let mut w = world(
            vec![t("T1", "app"), t("T2", "api"), td("T3", "app", &["T2"])],
            &[],
        );
        w.begin_rounds(3600, &[("app", "another round")]);
        let a = w.of("app")[0];
        assert_eq!(w.started[a].instructions.as_deref(), Some("another round"));
        w.end_ok(a, &["T1"]);
        assert_eq!(w.waiting_repos(), strs(&["app"]));
        assert_eq!(w.co.state().rounds.len(), 1);
        assert_eq!(w.of("app").len(), 1);
        let i = w.of("api")[0];
        w.end_ok(i, &["T2"]);
        assert_eq!(w.of("app").len(), 2);
        let a = w.of("app")[1];
        assert_eq!(w.started[a].instructions.as_deref(), Some("another round"));
    }

    // ---- the build's choices ----

    #[test]
    fn runs_the_build_starts_by_itself_get_the_build_s_choices_and_no_preview_the_review_included_r11_1(
    ) {
        let mut w = world(vec![t("T1", "app"), td("T2", "api", &["T1"])], &[]);
        let choices = github_off();
        w.begin_with(3600, &[], choices.clone());
        let i = w.of("app")[0];
        w.end_ok(i, &["T1"]);
        let i = w.of("api")[0];
        w.end_ok(i, &["T2"]);
        assert_eq!(w.log, strs(&["app", "api", "review"]));
        assert_eq!(w.started.len(), 3);
        for s in &w.started {
            assert_eq!(s.choices, choices);
        }
    }

    #[test]
    fn new_choices_given_for_a_continued_repository_reach_its_next_run_and_the_review_after_it_r12_1(
    ) {
        let mut w = world(vec![t("T1", "app"), t("T2", "api")], &[]);
        let first = github_off();
        w.begin_with(3600, &[], first.clone());
        w.end(0, &[], Some(1), None);
        assert!(w.stopped("app").is_some());
        let second = none_choices();
        w.feed(Input::SetChoices(second.clone()));
        w.continue_repo("app");
        let a1 = w.of("app")[1];
        assert_eq!(w.started[a1].choices, second);
        w.end_ok(a1, &["T1"]);
        let api = w.of("api")[0];
        w.end_ok(api, &["T2"]);
        let last = w.started.last().unwrap();
        assert_eq!(last.key, "review");
        assert_eq!(last.choices, second);
        // A run that was already going keeps the choices it started with.
        assert_eq!(w.started[api].choices, first);
    }

    #[test]
    fn without_choices_a_run_is_given_the_empty_set() {
        let mut w = world(vec![t("T1", "app")], &[]);
        w.begin(3600);
        let i = w.of("app")[0];
        assert_eq!(w.started[i].choices, none_choices());
    }

    // ---- rounds, one pending per repository ----

    const API: &str = "catalog-api";
    const WEB: &str = "storefront-web";

    #[derive(Clone, Copy)]
    enum How {
        Finished,
        Failed,
        Cancelled,
    }

    /// Two finished repositories and a round for each, started and both agents going.
    fn two_rounds() -> World {
        let mut w = world(vec![t("T1", API), t("T2", WEB)], &["T1", "T2"]);
        w.set_head(API, "h1");
        w.set_head(WEB, "w1");
        w.begin_rounds(3600, &[(API, "fix F1"), (WEB, "fix F5")]);
        w
    }

    fn end_both(w: &mut World, api: How, web: How, moved: bool) {
        if moved {
            w.set_head(API, "h2");
        }
        for (repo, how) in [(API, api), (WEB, web)] {
            if matches!(how, How::Cancelled) {
                w.cancel(repo);
            }
            let exit = match how {
                How::Finished => Some(0),
                How::Failed => Some(1),
                How::Cancelled => Some(130),
            };
            let i = w.of(repo)[0];
            w.end(i, &[], exit, None);
        }
    }

    #[test]
    fn r7_1_both_agents_start_before_either_ends_each_with_its_own_instructions() {
        let w = two_rounds();
        assert_eq!(w.log, strs(&[API, WEB]));
        assert_eq!(w.started.len(), 2);
        assert_eq!(
            w.started[w.of(API)[0]].instructions.as_deref(),
            Some("fix F1")
        );
        assert_eq!(
            w.started[w.of(WEB)[0]].instructions.as_deref(),
            Some("fix F5")
        );
        assert_eq!(w.going(), strs(&[API, WEB]));
    }

    #[test]
    fn r7_3_a_repository_with_t7_unfinished_launches_once_on_t7_carrying_the_instructions() {
        let mut w = world(vec![t("T7", API)], &[]);
        w.begin_rounds(3600, &[(API, "fix F1")]);
        assert_eq!(w.of(API).len(), 1);
        assert_eq!(
            w.started[w.of(API)[0]].instructions.as_deref(),
            Some("fix F1")
        );
        assert_eq!(w.pending(), strs(&[API]));
    }

    #[test]
    fn r8_1_row_1_finished_finished_moved_one_review_after_both_no_round_pending() {
        let mut w = two_rounds();
        end_both(&mut w, How::Finished, How::Finished, true);
        assert_eq!(w.log, strs(&[API, WEB, "review"]));
        assert_eq!(reviews(&w.log), 1);
        assert_eq!(w.phase(), BuildPhase::Reviewing);
        assert!(w.pending().is_empty());
    }

    #[test]
    fn r8_1_row_2_finished_finished_did_not_move_no_review_phase_finished_no_round_pending() {
        let mut w = two_rounds();
        end_both(&mut w, How::Finished, How::Finished, false);
        assert_eq!(reviews(&w.log), 0);
        assert_eq!(w.phase(), BuildPhase::Finished);
        assert!(w.pending().is_empty());
    }

    #[test]
    fn r8_1_row_3_finished_failed_moved_no_review_stopped_the_storefront_web_round_pending() {
        let mut w = two_rounds();
        end_both(&mut w, How::Finished, How::Failed, true);
        assert_eq!(reviews(&w.log), 0);
        assert_eq!(w.phase(), BuildPhase::Stopped);
        assert_eq!(w.pending(), strs(&[WEB]));
    }

    #[test]
    fn r8_1_row_4_finished_cancelled_moved_no_review_stopped_the_storefront_web_round_pending() {
        let mut w = two_rounds();
        end_both(&mut w, How::Finished, How::Cancelled, true);
        assert_eq!(reviews(&w.log), 0);
        assert_eq!(w.phase(), BuildPhase::Stopped);
        assert_eq!(w.pending(), strs(&[WEB]));
    }

    #[test]
    fn r8_1_row_5_failed_failed_did_not_move_no_review_both_rounds_pending() {
        let mut w = two_rounds();
        end_both(&mut w, How::Failed, How::Failed, false);
        assert_eq!(reviews(&w.log), 0);
        assert_eq!(w.phase(), BuildPhase::Stopped);
        assert_eq!(w.pending(), strs(&[API, WEB]));
    }

    #[test]
    fn r8_1_row_6_cancelled_cancelled_did_not_move_no_review_both_rounds_pending() {
        let mut w = two_rounds();
        end_both(&mut w, How::Cancelled, How::Cancelled, false);
        assert_eq!(reviews(&w.log), 0);
        assert_eq!(w.phase(), BuildPhase::Stopped);
        assert_eq!(w.pending(), strs(&[API, WEB]));
    }

    #[test]
    fn r8_2_the_review_waits_for_the_slower_agent_then_starts_once() {
        let mut w = two_rounds();
        w.set_head(API, "h2");
        let i = w.of(API)[0];
        w.end_ok(i, &[]);
        assert_eq!(reviews(&w.log), 0);
        assert_eq!(w.phase(), BuildPhase::Building);
        assert_eq!(w.pending(), strs(&[WEB]));
        let i = w.of(WEB)[0];
        w.end_ok(i, &[]);
        assert_eq!(reviews(&w.log), 1);
        assert_eq!(w.log, strs(&[API, WEB, "review"]));
    }

    #[test]
    fn r8_3_continuing_the_failed_repository_runs_its_round_again_with_the_same_instructions() {
        let mut w = two_rounds();
        let i = w.of(API)[0];
        w.end_ok(i, &[]);
        let i = w.of(WEB)[0];
        w.end(i, &[], Some(1), None);
        assert_eq!(w.of(WEB).len(), 1);
        w.continue_repo(WEB);
        assert_eq!(w.of(WEB).len(), 2);
        assert_eq!(
            w.started[w.of(WEB)[1]].instructions.as_deref(),
            Some("fix F5")
        );
        assert_eq!(w.of(API).len(), 1);
    }

    #[test]
    fn table_a_repository_with_no_pending_round_is_untouched_when_its_run_ends() {
        let mut w = world(vec![t("T1", "app"), t("T2", API)], &["T2"]);
        w.begin_rounds(3600, &[(API, "fix F1")]);
        let i = w.of("app")[0];
        w.end_ok(i, &["T1"]);
        assert_eq!(w.pending(), strs(&[API]));
        assert_eq!(w.of(API).len(), 1);
    }

    #[test]
    fn table_finished_removes_the_round_and_the_repository_does_not_launch_again() {
        let mut w = world(vec![t("T1", API)], &["T1"]);
        w.begin_rounds(3600, &[(API, "fix F1")]);
        let i = w.of(API)[0];
        w.end_ok(i, &[]);
        assert!(w.pending().is_empty());
        assert_eq!(w.of(API).len(), 1);
    }

    #[test]
    fn table_continue_keeps_the_round_and_launches_the_repository_again_with_the_same_instructions()
    {
        let mut w = world(vec![t("T1", "app"), t("T2", "app")], &[]);
        w.begin_rounds(3600, &[("app", "fix F1")]);
        let i = w.of("app")[0];
        w.end_ok(i, &["T1"]);
        assert_eq!(w.pending(), strs(&["app"]));
        assert_eq!(w.of("app").len(), 2);
        assert_eq!(
            w.started[w.of("app")[1]].instructions.as_deref(),
            Some("fix F1")
        );
    }

    #[test]
    fn table_stopped_keeps_the_round_and_does_not_relaunch_until_continue() {
        let mut w = world(vec![t("T1", API)], &["T1"]);
        w.begin_rounds(3600, &[(API, "fix F1")]);
        let i = w.of(API)[0];
        w.end(i, &[], Some(1), None);
        assert_eq!(w.pending(), strs(&[API]));
        assert_eq!(w.of(API).len(), 1);
        w.continue_repo(API);
        assert_eq!(w.of(API).len(), 2);
        assert_eq!(
            w.started[w.of(API)[1]].instructions.as_deref(),
            Some("fix F1")
        );
    }

    #[test]
    fn table_held_keeps_the_round_and_does_not_relaunch_until_continue() {
        let mut w = world(vec![t("T1", API)], &["T1"]);
        w.begin_rounds(3600, &[(API, "fix F1")]);
        w.status_failures = 1;
        let i = w.of(API)[0];
        w.end_ok(i, &[]);
        assert!(w.stopped(API).unwrap().held);
        assert_eq!(w.pending(), strs(&[API]));
        assert_eq!(w.of(API).len(), 1);
        w.continue_repo(API);
        assert_eq!(w.of(API).len(), 2);
        assert_eq!(
            w.started[w.of(API)[1]].instructions.as_deref(),
            Some("fix F1")
        );
    }

    // ---- a new session ----

    fn current_world(currency: ReviewCurrency) -> World {
        let mut heads = BTreeMap::new();
        heads.insert("api".to_string(), "h1".to_string());
        world_with(vec![t("T1", "api")], &["T1"], currency, heads)
    }

    #[test]
    fn a_current_committed_review_is_not_repeated_on_a_new_session() {
        let mut w = current_world(ReviewCurrency::Current { review: 0 });
        w.begin(3600);
        assert_eq!(reviews(&w.log), 0);
        assert!(w.log.is_empty());
        assert_eq!(w.phase(), BuildPhase::Finished);
    }

    #[test]
    fn a_stale_committed_review_runs_again_on_a_new_session() {
        let mut w = current_world(ReviewCurrency::Stale);
        w.begin(3600);
        assert_eq!(w.log, strs(&["review"]));
        assert_eq!(w.phase(), BuildPhase::Reviewing);
    }

    // ---- readiness and the committed review ----

    fn readiness_of(plan: &[Pt], logged: &[&str]) -> Vec<RepoReadiness> {
        let rows: BTreeSet<String> = logged.iter().map(|s| s.to_string()).collect();
        let (p, c) = plan_and_change(plan, &rows);
        readiness(&p, &c, "master")
    }

    fn rr(repo: &str, state: Readiness) -> RepoReadiness {
        RepoReadiness {
            repo: repo.into(),
            state,
        }
    }

    #[test]
    fn readiness_reads_logged_tasks_and_dependencies() {
        let plan = vec![
            t("T1", "api"),
            td("T2", "app", &["T1"]),
            t("T3", "docs"),
            td("T4", "docs", &["T1"]),
            t("T5", "master"),
        ];
        // Ready: nothing logged, so api and docs start and app waits on api's T1; docs' first
        // unlogged task is T3, which depends on nothing. The master is never a build repository.
        assert_eq!(
            readiness_of(&plan, &[]),
            vec![
                rr("api", Readiness::Ready),
                rr(
                    "app",
                    Readiness::Waiting {
                        on: vec!["T1".into()]
                    }
                ),
                rr("docs", Readiness::Ready),
            ]
        );
        // Waiting on another repository's unlogged task: T3 logged, docs' next is T4 on api's T1.
        assert_eq!(
            readiness_of(&plan, &["T3"])[2],
            rr(
                "docs",
                Readiness::Waiting {
                    on: vec!["T1".into()]
                }
            )
        );
        // Done: every task of api is logged, and app is ready once T1 has its row.
        assert_eq!(
            readiness_of(&plan, &["T1"]),
            vec![
                rr("api", Readiness::Done),
                rr("app", Readiness::Ready),
                rr("docs", Readiness::Ready),
            ]
        );
        assert_eq!(
            readiness_of(&plan, &["T1", "T2", "T3", "T4"]),
            vec![
                rr("api", Readiness::Done),
                rr("app", Readiness::Done),
                rr("docs", Readiness::Done),
            ]
        );
    }

    fn committed_review(commit: &str) -> crate::review::ReviewRecord {
        crate::review::ReviewRecord {
            layout: 2,
            reviews: vec![crate::format::ParsedReviewSection {
                number: 1,
                reviewed_at: "2026-11-01".into(),
                commits: [("api".to_string(), commit.to_string())].into(),
                findings: Vec::new(),
            }],
            problems: Vec::new(),
            master_moved: Vec::new(),
        }
    }

    /// A restarted Workbench: the committed review judged against the heads now, then a new session.
    fn restarted(commit: &str) -> World {
        let heads: BTreeMap<String, String> = [("api".to_string(), "abcdef12".to_string())].into();
        let currency = crate::review::currency(&committed_review(commit), &heads);
        world_with(vec![t("T1", "api")], &["T1"], currency, heads)
    }

    #[test]
    fn a_current_committed_review_is_not_repeated() {
        let mut w = restarted("abcdef1");
        w.begin(3600);
        assert!(w.log.is_empty());
        assert_eq!(w.phase(), BuildPhase::Finished);
    }

    #[test]
    fn a_stale_committed_review_runs_again() {
        let mut w = restarted("1111111");
        w.begin(3600);
        assert_eq!(w.log, strs(&["review"]));
        assert_eq!(w.phase(), BuildPhase::Reviewing);
    }
}
