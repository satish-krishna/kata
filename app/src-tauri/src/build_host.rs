//! The backend's host for each change's build: one `Coordinator` per change, the holds on product
//! repositories, and the plugin's `build.start` that prepares every repository before any run starts.
//! The host executes the coordinator's commands; it decides nothing the coordinator or the plugin decides.
//! Everything outside the process (the ai-sdlc program, the run table and sidecar, the event channel)
//! sits behind [`Tools`] and [`Launcher`], so the tests need no Tauri app.
#![allow(dead_code)]

use crate::runs::{self, Lane};
use kata_core::spec::PermissionMode;
use kata_core::RunSpec;
use kata_sdlc::ai_sdlc::state::{read_state, ChangeState};
use kata_sdlc::ai_sdlc::{Place, Program, ProgramError};
use kata_sdlc::coordinator::{
    self, BuildChoices, BuildFacts, BuildPhase, BuildState, Command, Coordinator, Input,
};
use kata_sdlc::format::{self, ParsedPlan, ReadResult};
use kata_sdlc::git;
use kata_sdlc::holds::{needed_repos, review_repos, ChangeKey, HoldTable, Purpose, RepoKey};
use kata_sdlc::permissions::{RunKind, RunPlace};
use kata_sdlc::review::{self, ReviewCurrency, ReviewRecord};
use kata_sdlc::round::{self, RoundOffer, RoundPicks, RoundPlan, RoundRequest};
use kata_sdlc::runspec::{change_spec, RunForm};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Channel every change of the build is announced on, one [`BuildEvent`] per event.
pub const BUILD_EVENT: &str = "sdlc://build";

/// The time limit of a run when a build is continued with nothing the engineer chose.
pub const DEFAULT_TIMEOUT_SECS: u64 = 3600;

/// The coordinator's key for the review run.
pub const REVIEW: &str = "review";

/// A change as the webview names it.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRef {
    pub workspace: String,
    pub system: String,
    pub change: String,
}

/// What the engineer chose for a build.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartForm {
    pub timeout_secs: u64,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub continue_on_leftovers: bool,
    #[serde(default)]
    pub rounds: Vec<RoundRequest>,
}

/// A repository another change holds.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeldRepo {
    pub repo: String,
    pub holder: ChangeKey,
}

/// What starting or continuing a build came to.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StartOutcome {
    /// The build is under way. `uncommitted` names, per repository, the files the plugin found
    /// uncommitted on the change's branch; the build goes on over them.
    Started {
        uncommitted: BTreeMap<String, Vec<String>>,
    },
    /// A build of this change is live; no second one starts.
    AlreadyRunning,
    /// Another change holds a repository this build needs; nothing was prepared.
    Held { held: Vec<HeldRepo> },
    /// The plugin refused, and these are its reasons.
    Refused { problems: Vec<String> },
    /// The machine could not run the plugin's step.
    CouldNotRun { output: String },
}

/// A change's build state, announced on [`BUILD_EVENT`].
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildEvent {
    pub change: ChangeKey,
    pub state: BuildState,
    /// The repositories another change holds that keep the review from starting; empty when it is not waiting.
    pub review_waiting: Vec<HeldRepo>,
}

/// What the running-changes strip reads of one change's build.
#[derive(Clone, Debug)]
pub struct BuildView {
    pub change: ChangeKey,
    /// None when this session hosts no build of the change (only a held start is remembered).
    pub state: Option<BuildState>,
    pub review_waiting: Vec<HeldRepo>,
    /// The repositories that held the change's last start, until the engineer starts it again.
    pub held_start: Vec<HeldRepo>,
    /// When the state last changed, in unix milliseconds.
    pub changed_ms: u64,
}

/// How a run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunEnd {
    pub exit: Option<i32>,
    pub error: Option<String>,
}

/// One run the coordinator asked for.
pub struct LaunchRequest {
    pub spec: RunSpec,
    pub lane: Lane,
    pub kind: runs::RunKind,
    /// The product repository of a build run.
    pub repo: Option<String>,
    /// The plan task the run is on; empty for a review or a round.
    pub task: String,
    /// `build:<system>/<change>`, which the run table's group check reads.
    pub group: String,
    /// Called once, after the run has left the run table.
    pub ended: Box<dyn FnOnce(RunEnd) + Send>,
}

/// What the host asks of the ai-sdlc program and the repositories.
pub trait Tools: Send + Sync {
    /// The master repository and the workspace around `workspace`.
    fn resolve(&self, workspace: &Path) -> Result<Place, ProgramError>;
    /// One program command, as `Program::run`.
    fn run(&self, command: &[&str], place: &Place) -> Result<Value, ProgramError>;
    /// Every change of `system`.
    fn states(&self, place: &Place, system: &str) -> Result<Vec<ChangeState>, ProgramError>;
    /// The change's plan, as committed.
    fn plan(&self, place: &Place, state: &ChangeState) -> Result<ParsedPlan, String>;
    /// The change's committed review document, if it has one.
    fn review_record(
        &self,
        place: &Place,
        system: &str,
        state: &ChangeState,
    ) -> Result<Option<ReviewRecord>, String>;
    /// The commit a repository's `HEAD` is on.
    fn head(&self, dir: &Path) -> Result<String, String>;
}

/// What the host asks of the run table, the sidecar and the webview.
pub trait Launcher: Send + Sync {
    /// Start a run; the run id on success, why not on a refusal (for example a folder in use).
    fn launch(&self, request: LaunchRequest) -> Result<u64, String>;
    /// Ask a live run to stop.
    fn cancel(&self, run_id: u64);
    /// Announce a change's build state.
    fn emit(&self, event: &BuildEvent);
}

/// [`Tools`] over one ai-sdlc program.
pub struct ProgramTools {
    program: Program,
}

impl ProgramTools {
    pub fn new(program: Program) -> Self {
        ProgramTools { program }
    }
}

impl Tools for ProgramTools {
    fn resolve(&self, workspace: &Path) -> Result<Place, ProgramError> {
        self.program.resolve(workspace)
    }

    fn run(&self, command: &[&str], place: &Place) -> Result<Value, ProgramError> {
        self.program.run(command, place)
    }

    fn states(&self, place: &Place, system: &str) -> Result<Vec<ChangeState>, ProgramError> {
        let answer = self
            .program
            .run(&["state", "--json", "--system", system], place)?;
        Ok(read_state(answer)?.changes)
    }

    fn plan(&self, _place: &Place, state: &ChangeState) -> Result<ParsedPlan, String> {
        let file = Path::new(&state.folder).join("plan.md");
        match format::read(&self.program.entry, &file) {
            Ok(ReadResult::Plan { document, .. }) => Ok(document),
            Ok(_) => Err(format!("{} is not a plan", file.display())),
            Err(e) => Err(e.to_string()),
        }
    }

    fn review_record(
        &self,
        _place: &Place,
        system: &str,
        state: &ChangeState,
    ) -> Result<Option<ReviewRecord>, String> {
        let plugin = self
            .program
            .entry
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "the ai-sdlc program has no plugin folder".to_string())?;
        review::record(plugin, Path::new(&state.master), system, &state.change)
            .map_err(|e| e.to_string())
    }

    fn head(&self, dir: &Path) -> Result<String, String> {
        git::Repo::open(dir)
            .and_then(|r| r.head_sha())
            .map_err(|e| e.to_string())
    }
}

/// What `states` last said about the change, for the runs the coordinator launches.
#[derive(Clone)]
struct Snapshot {
    state: ChangeState,
    /// The masters of every other change that lives in a copy.
    others: Vec<PathBuf>,
}

/// Where a change's build runs.
struct Ctx {
    place: Place,
    system: String,
    change: String,
    /// The folder names of the system's repositories; read once, at the first launch.
    system_repos: Option<Vec<String>>,
}

fn master_name(place: &Place) -> String {
    place
        .master
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// One live run of a build. A run is listed before it is launched, so a build with a launch under way
/// is not idle; `run_id` is known once the launch has answered.
struct LiveRun {
    /// The coordinator's key for it: a repository's name or `review`.
    key: String,
    run_id: Option<u64>,
    /// A cancel arrived while the launch was under way.
    cancel_asked: bool,
}

/// One change's build.
struct Build {
    /// Which coordinator this is. An answer meant for an earlier coordinator of the change is dropped.
    generation: u64,
    coord: Coordinator,
    ctx: Ctx,
    /// The live runs by the coordinator's instance id.
    live: BTreeMap<u64, LiveRun>,
    form: StartForm,
    last: Option<Snapshot>,
    /// The state last announced, so only a change is announced.
    emitted: Option<(BuildState, Vec<HeldRepo>)>,
    /// What keeps the review from starting: the repositories other changes hold. Empty when it is not waiting.
    review_waiting: Vec<HeldRepo>,
    /// When the announced state last changed, in unix milliseconds.
    changed_ms: u64,
}

/// The coordinators and the holds, behind one lock. The lock is held only to read or change this
/// table, never across a call of the plugin, a read of a repository or the start of a run.
struct Inner {
    builds: HashMap<ChangeKey, Build>,
    holds: HoldTable,
    /// The changes whose build is being started or continued: a second start waits for none.
    starting: HashSet<ChangeKey>,
    /// The last start of each change that another change held, with when; cleared when the change
    /// is started again and gets its repositories.
    held_starts: HashMap<ChangeKey, (Vec<HeldRepo>, u64)>,
    next_generation: u64,
}

pub struct BuildHost {
    tools: Arc<dyn Tools>,
    launcher: Arc<dyn Launcher>,
    workbench_dir: PathBuf,
    inner: Mutex<Inner>,
}

pub fn key_of(change: &ChangeRef) -> ChangeKey {
    ChangeKey {
        workspace: RepoKey::of(Path::new(&change.workspace)),
        system: change.system.clone(),
        change: change.change.clone(),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// The folders of the product repositories a change's review reads.
fn review_folders(place: &Place, state: &ChangeState) -> Vec<RepoKey> {
    review_repos(state, &master_name(place))
        .iter()
        .map(|r| RepoKey::of(&place.workspace.join(r)))
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn held_repos(held: kata_sdlc::holds::Held) -> Vec<HeldRepo> {
    held.held
        .into_iter()
        .map(|(repo, holder)| HeldRepo { repo, holder })
        .collect()
}

fn error_text(e: &ProgramError) -> String {
    match e {
        ProgramError::CouldNotRun { message } => message.clone(),
        other => other.to_string(),
    }
}

fn could_not_run(e: &ProgramError) -> StartOutcome {
    StartOutcome::CouldNotRun {
        output: error_text(e),
    }
}

/// Says what an answer of the plugin that did not pass came to.
fn failure(answer: &Value) -> StartOutcome {
    let problems = strings(&answer["problems"]);
    match answer["outcome"].as_str() {
        Some("refused") => StartOutcome::Refused { problems },
        _ => StartOutcome::CouldNotRun {
            output: if problems.is_empty() {
                format!("the ai-sdlc program answered {}", answer["outcome"])
            } else {
                problems.join("\n")
            },
        },
    }
}

/// What the commands of a step need, copied out of the build so they run without the lock.
struct Exec {
    place: Place,
    system: String,
    change: String,
    last: Option<Snapshot>,
    system_repos: Option<Vec<String>>,
}

/// What a batch of commands found out, to be applied under the lock at the next step.
#[derive(Default)]
struct Update {
    last: Option<Snapshot>,
    system_repos: Option<Vec<String>>,
    /// What the last attempt to start the review found: the repositories held (empty when it was free).
    review_waiting: Option<Vec<HeldRepo>>,
    /// Each launch by its instance: the run id, or why it did not start.
    launched: Vec<(u64, Result<u64, String>)>,
}

/// A `Launch` command, unpacked.
struct Launching {
    launch_key: String,
    instance: u64,
    task: String,
    instructions: Option<String>,
    choices: BuildChoices,
}

impl BuildHost {
    pub fn new(
        tools: Arc<dyn Tools>,
        launcher: Arc<dyn Launcher>,
        workbench_dir: PathBuf,
    ) -> Arc<BuildHost> {
        Arc::new(BuildHost {
            tools,
            launcher,
            workbench_dir,
            inner: Mutex::new(Inner {
                builds: HashMap::new(),
                holds: HoldTable::default(),
                starting: HashSet::new(),
                held_starts: HashMap::new(),
                next_generation: 0,
            }),
        })
    }

    /// Start `change`'s build: nothing starts unless every repository it needs is free and the
    /// plugin's `build.start` passes in all of them.
    pub fn start(self: &Arc<Self>, change: &ChangeRef, form: StartForm) -> StartOutcome {
        self.begin(change, Some(form), None)
    }

    /// Continue `change`'s build in `repo`; a build with no live run is rebuilt from where the change stands.
    pub fn continue_repo(self: &Arc<Self>, change: &ChangeRef, repo: &str) -> StartOutcome {
        self.begin(change, None, Some(repo))
    }

    /// Start a document run (intent, spec, plan, triage or fix) of an existing change: the change's
    /// master is its folder, the run claims the change's own lane and gets the deny rules of R19.1.
    pub fn change_run(
        &self,
        _change: &ChangeRef,
        _kind: runs::RunKind,
        _form: RunForm,
    ) -> Result<u64, String> {
        Err("not implemented".into())
    }

    /// The build state of `change`, or none when this session hosts no build of it. It only reads.
    pub fn state(&self, change: &ChangeRef) -> Option<BuildState> {
        let inner = self.inner.lock().unwrap();
        inner
            .builds
            .get(&key_of(change))
            .map(|b| b.coord.state().clone())
    }

    /// What the running-changes strip reads of every build this session hosts and of every start
    /// another change held. It only reads.
    pub fn views(&self) -> Vec<BuildView> {
        let inner = self.inner.lock().unwrap();
        let mut views: Vec<BuildView> = inner
            .builds
            .iter()
            .map(|(key, b)| BuildView {
                change: key.clone(),
                state: Some(b.coord.state().clone()),
                review_waiting: b.review_waiting.clone(),
                held_start: inner
                    .held_starts
                    .get(key)
                    .map(|(h, _)| h.clone())
                    .unwrap_or_default(),
                changed_ms: b.changed_ms,
            })
            .collect();
        for (key, (held, at)) in &inner.held_starts {
            if !inner.builds.contains_key(key) {
                views.push(BuildView {
                    change: key.clone(),
                    state: None,
                    review_waiting: Vec::new(),
                    held_start: held.clone(),
                    changed_ms: *at,
                });
            }
        }
        views
    }

    /// Start `change`'s review by hand. It starts only when every product repository the review reads is
    /// free; the coordinator's own launch takes the hold again and keeps it until the run ends.
    pub fn review_start(self: &Arc<Self>, change: &ChangeRef) -> StartOutcome {
        let place = match self.tools.resolve(Path::new(&change.workspace)) {
            Ok(p) => p,
            Err(e) => return could_not_run(&e),
        };
        let key = key_of(change);
        let (snapshot, _) = match self.snapshot(&place, &change.system, &change.change) {
            Ok(s) => s,
            Err(output) => return StartOutcome::CouldNotRun { output },
        };
        let unrecorded = snapshot
            .state
            .tasks
            .iter()
            .flatten()
            .any(|(_, t)| !t.unlogged.is_empty());
        if unrecorded {
            return StartOutcome::Refused {
                problems: vec![format!(
                    "Change {} has tasks with no build log row; its review starts once the last task is recorded.",
                    change.change
                )],
            };
        }
        let folders = review_folders(&place, &snapshot.state);
        let taken = self
            .inner
            .lock()
            .unwrap()
            .holds
            .take(&key, Purpose::Review, &folders);
        if let Err(held) = taken {
            return StartOutcome::Held {
                held: held_repos(held),
            };
        }
        let outcome = self.begin(change, None, None);
        // The hold stays only with a review that is running.
        let mut guard = self.inner.lock().unwrap();
        let reviewing = guard
            .builds
            .get(&key)
            .is_some_and(|b| b.live.values().any(|r| r.key == REVIEW));
        if !reviewing {
            guard.holds.release(&key, Purpose::Review);
        }
        outcome
    }

    /// The repositories another change holds that keep `change`'s review from starting.
    pub fn review_waiting(&self, change: &ChangeRef) -> Vec<HeldRepo> {
        let inner = self.inner.lock().unwrap();
        inner
            .builds
            .get(&key_of(change))
            .map(|b| b.review_waiting.clone())
            .unwrap_or_default()
    }

    /// What a round may fix, from the change's latest committed review. The repositories it may go to
    /// are the change's product repositories and the master.
    pub fn round_offer(&self, change: &ChangeRef) -> Result<RoundOffer, String> {
        let place = self
            .tools
            .resolve(Path::new(&change.workspace))
            .map_err(|e| error_text(&e))?;
        let (snapshot, _) = self.snapshot(&place, &change.system, &change.change)?;
        let record = self
            .tools
            .review_record(&place, &change.system, &snapshot.state)?;
        let master = master_name(&place);
        let mut repos = review_repos(&snapshot.state, &master);
        repos.push(master);
        Ok(round::offer(record.as_ref(), &repos))
    }

    /// The requests a round with these picks would start.
    pub fn round_plan(&self, change: &ChangeRef, picks: &RoundPicks) -> Result<RoundPlan, String> {
        Ok(round::plan(&self.round_offer(change)?, picks))
    }

    /// Start the round the picks describe, through the same rows as a build's start.
    pub fn round_start(self: &Arc<Self>, change: &ChangeRef, picks: RoundPicks) -> StartOutcome {
        let plan = match self.round_plan(change, &picks) {
            Ok(p) => p,
            Err(output) => return StartOutcome::CouldNotRun { output },
        };
        if let Some(blocked) = plan.blocked {
            return StartOutcome::Refused {
                problems: vec![blocked],
            };
        }
        let mut form = self
            .inner
            .lock()
            .unwrap()
            .builds
            .get(&key_of(change))
            .map(|b| b.form.clone())
            .unwrap_or(StartForm {
                timeout_secs: DEFAULT_TIMEOUT_SECS,
                instructions: None,
                continue_on_leftovers: false,
                rounds: Vec::new(),
            });
        form.rounds = plan.requests;
        self.begin(change, Some(form), None)
    }

    /// Take the review hold on every product repository the change's review reads. The lock is held for
    /// the take alone.
    fn take_review(&self, exec: &Exec, key: &ChangeKey) -> Result<(), Vec<HeldRepo>> {
        let Some(last) = &exec.last else {
            return Ok(());
        };
        let folders = review_folders(&exec.place, &last.state);
        let taken = self
            .inner
            .lock()
            .unwrap()
            .holds
            .take(key, Purpose::Review, &folders);
        taken.map_err(held_repos)
    }

    /// Stop every run of `change`'s build.
    pub fn cancel(self: &Arc<Self>, change: &ChangeRef) {
        self.drive(&key_of(change), None, Input::CancelAll);
    }

    /// A run of a build ended; called by the launcher once the run has left the run table. A run of an
    /// earlier coordinator of the change (`generation`) is not this build's.
    fn run_ended(self: &Arc<Self>, key: &ChangeKey, generation: u64, instance: u64, end: RunEnd) {
        let launch_key = {
            let mut guard = self.inner.lock().unwrap();
            let removed = guard
                .builds
                .get_mut(key)
                .filter(|b| b.generation == generation)
                .and_then(|b| b.live.remove(&instance));
            let Some(run) = removed else {
                return;
            };
            // A review's holds end with its run, whatever the outcome.
            if run.key == REVIEW {
                guard.holds.release(key, Purpose::Review);
            }
            run.key
        };
        self.drive(
            key,
            Some(generation),
            Input::RunEnded {
                key: launch_key,
                instance,
                exit: end.exit,
                error: end.error,
                refused: false,
            },
        );
    }

    /// The decision of `sdlc_build_start` (`only` is none) and `sdlc_build_continue`. Only one start of a
    /// change goes on at a time; a second is refused as a build already under way.
    fn begin(
        self: &Arc<Self>,
        change: &ChangeRef,
        form: Option<StartForm>,
        only: Option<&str>,
    ) -> StartOutcome {
        let place = match self.tools.resolve(Path::new(&change.workspace)) {
            Ok(p) => p,
            Err(e) => return could_not_run(&e),
        };
        let key = key_of(change);
        let before = {
            let mut guard = self.inner.lock().unwrap();
            let existing = guard.builds.get(&key);
            let live_build = existing.is_some_and(|b| !b.live.is_empty());
            let already = match only {
                None => live_build,
                Some(repo) => existing.is_some_and(|b| b.live.values().any(|r| r.key == repo)),
            };
            if already || guard.starting.contains(&key) {
                return StartOutcome::AlreadyRunning;
            }
            let before = Before {
                live_build,
                generation: existing.map(|b| b.generation),
                form: existing.map(|b| b.form.clone()),
            };
            guard.starting.insert(key.clone());
            before
        };
        let outcome = self.begin_marked(&place, change, &key, form, only, before);
        self.inner.lock().unwrap().starting.remove(&key);
        outcome
    }

    fn begin_marked(
        self: &Arc<Self>,
        place: &Place,
        change: &ChangeRef,
        key: &ChangeKey,
        form: Option<StartForm>,
        only: Option<&str>,
        before: Before,
    ) -> StartOutcome {
        let Before {
            live_build,
            generation: existing_generation,
            form: existing_form,
        } = before;
        let form = form.or(existing_form).unwrap_or(StartForm {
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            instructions: None,
            continue_on_leftovers: false,
            rounds: Vec::new(),
        });
        let (snapshot, plan) = match self.snapshot(place, &change.system, &change.change) {
            Ok(s) => s,
            Err(output) => return StartOutcome::CouldNotRun { output },
        };
        let master = master_name(place);
        let rounds: Vec<String> = form.rounds.iter().map(|r| r.repo.clone()).collect();
        let needed: Vec<String> = match only {
            Some(repo) if live_build => {
                if repo == master {
                    Vec::new()
                } else {
                    vec![repo.to_string()]
                }
            }
            _ => needed_repos(&plan, &snapshot.state, &rounds, &master),
        };
        let folders: Vec<RepoKey> = needed
            .iter()
            .map(|r| RepoKey::of(&place.workspace.join(r)))
            .collect();
        // The one step that must be atomic: the first change to ask for a repository gets it.
        let taken = {
            let mut guard = self.inner.lock().unwrap();
            let taken = guard.holds.take(key, Purpose::Build, &folders);
            match &taken {
                Ok(_) => {
                    guard.held_starts.remove(key);
                }
                Err(held) => {
                    let held = held_repos(held.clone());
                    guard.held_starts.insert(key.clone(), (held, now_ms()));
                }
            }
            taken
        };
        if let Err(held) = taken {
            return StartOutcome::Held {
                held: held_repos(held),
            };
        }
        let release = |outcome: StartOutcome| {
            let mut guard = self.inner.lock().unwrap();
            if guard.builds.get(key).is_none_or(|b| b.live.is_empty()) {
                guard.holds.release(key, Purpose::Build);
            }
            outcome
        };
        let uncommitted = match self.prepare(place, change, &needed) {
            Ok(u) => u,
            Err(outcome) => return release(outcome),
        };
        let fresh = if live_build {
            None
        } else {
            let heads = self.heads(place, &snapshot.state);
            let currency = match self
                .tools
                .review_record(place, &change.system, &snapshot.state)
            {
                Ok(Some(record)) => review::currency(&record, &heads),
                _ => ReviewCurrency::None,
            };
            Some(Coordinator::new(currency, heads))
        };
        let generation = {
            let mut guard = self.inner.lock().unwrap();
            if live_build {
                match guard.builds.get(key) {
                    Some(b) if Some(b.generation) == existing_generation => b.generation,
                    _ => return StartOutcome::AlreadyRunning,
                }
            } else {
                if guard.builds.get(key).is_some_and(|b| !b.live.is_empty()) {
                    return StartOutcome::AlreadyRunning;
                }
                let Some(coord) = fresh else {
                    return StartOutcome::AlreadyRunning;
                };
                guard.next_generation += 1;
                let generation = guard.next_generation;
                guard.builds.insert(
                    key.clone(),
                    Build {
                        generation,
                        coord,
                        ctx: Ctx {
                            place: place.clone(),
                            system: change.system.clone(),
                            change: change.change.clone(),
                            system_repos: None,
                        },
                        live: BTreeMap::new(),
                        form: form.clone(),
                        last: Some(snapshot),
                        emitted: None,
                        review_waiting: Vec::new(),
                        changed_ms: now_ms(),
                    },
                );
                generation
            }
        };
        let input = match only {
            Some(repo) if live_build => Input::ContinueRepo {
                repo: repo.to_string(),
            },
            _ => Input::Begin {
                timeout_secs: form.timeout_secs,
                rounds: form
                    .rounds
                    .iter()
                    .map(|r| coordinator::RoundRequest {
                        repo: r.repo.clone(),
                        instructions: r.instructions.clone(),
                    })
                    .collect(),
                choices: BuildChoices {
                    timeout_secs: form.timeout_secs,
                    instructions: form.instructions.clone(),
                    continue_on_leftovers: form.continue_on_leftovers,
                },
            },
        };
        if let Some(build) = self.inner.lock().unwrap().builds.get_mut(key) {
            build.form = form;
        }
        self.drive(key, Some(generation), input);
        StartOutcome::Started { uncommitted }
    }

    /// The change's state and plan as the plugin reports them now.
    fn snapshot(
        &self,
        place: &Place,
        system: &str,
        change: &str,
    ) -> Result<(Snapshot, ParsedPlan), String> {
        let states = self
            .tools
            .states(place, system)
            .map_err(|e| error_text(&e))?;
        let others: Vec<PathBuf> = states
            .iter()
            .filter(|s| s.in_copy && s.change != change)
            .map(|s| PathBuf::from(&s.master))
            .collect();
        let state = states
            .into_iter()
            .find(|s| s.change == change)
            .ok_or_else(|| format!("the plugin knows no change {change}"))?;
        let plan = self.tools.plan(place, &state)?;
        Ok((Snapshot { state, others }, plan))
    }

    /// The commit each product repository of the change is on; one that cannot be read is left out.
    fn heads(&self, place: &Place, state: &ChangeState) -> BTreeMap<String, String> {
        review_repos(state, &master_name(place))
            .into_iter()
            .filter_map(|repo| {
                let head = self.tools.head(&place.workspace.join(&repo)).ok()?;
                Some((repo, head))
            })
            .collect()
    }

    /// One `build.start --check` naming every repository, then `build.start` in each in plan order.
    /// The error is the outcome to give; when the check refused, no repository was changed. The Ok is
    /// the uncommitted files the plugin named, per repository.
    fn prepare(
        &self,
        place: &Place,
        change: &ChangeRef,
        repos: &[String],
    ) -> Result<BTreeMap<String, Vec<String>>, StartOutcome> {
        let mut uncommitted = BTreeMap::new();
        if repos.is_empty() {
            return Ok(uncommitted);
        }
        let base = [
            "run",
            "build.start",
            "--json",
            "--system",
            &change.system,
            "--change",
            &change.change,
        ];
        let mut check: Vec<&str> = base.to_vec();
        check.push("--check");
        for repo in repos {
            check.extend(["--repo", repo]);
        }
        let answer = self
            .tools
            .run(&check, place)
            .map_err(|e| could_not_run(&e))?;
        if answer["outcome"] != "passed" {
            return Err(failure(&answer));
        }
        for repo in repos {
            let mut command: Vec<&str> = base.to_vec();
            command.extend(["--repo", repo]);
            let answer = self
                .tools
                .run(&command, place)
                .map_err(|e| could_not_run(&e))?;
            if answer["outcome"] != "passed" {
                return Err(failure(&answer));
            }
            let files = strings(&answer["details"]["uncommitted"]);
            if !files.is_empty() {
                uncommitted.insert(repo.clone(), files);
            }
        }
        Ok(uncommitted)
    }

    /// Give the coordinator `first` and carry out what it asks until it asks for nothing more. Each step
    /// is taken under the lock; the commands (reading the plugin and the repositories, starting runs) run
    /// with the lock released, and what they found is applied at the next step. A step of a coordinator
    /// that has been replaced since `generation` is dropped.
    fn drive(self: &Arc<Self>, key: &ChangeKey, generation: Option<u64>, first: Input) {
        let mut inputs = VecDeque::from([first]);
        let mut update = Update::default();
        let mut generation = generation;
        loop {
            let (commands, cancels, mut exec) = {
                let mut guard = self.inner.lock().unwrap();
                let Inner {
                    builds,
                    holds,
                    starting,
                    ..
                } = &mut *guard;
                let Some(build) = builds.get_mut(key) else {
                    return;
                };
                if generation.is_some_and(|g| g != build.generation) {
                    return;
                }
                generation = Some(build.generation);
                let mut cancels: Vec<u64> = Vec::new();
                if let Some(last) = update.last.take() {
                    build.last = Some(last);
                }
                if let Some(repos) = update.system_repos.take() {
                    build.ctx.system_repos = Some(repos);
                }
                if let Some(waiting) = update.review_waiting.take() {
                    build.review_waiting = waiting;
                }
                for (instance, result) in update.launched.drain(..) {
                    match result {
                        Ok(run_id) => {
                            if let Some(run) = build.live.get_mut(&instance) {
                                run.run_id = Some(run_id);
                                if run.cancel_asked {
                                    cancels.push(run_id);
                                }
                            }
                        }
                        Err(why) => {
                            if let Some(run) = build.live.remove(&instance) {
                                if run.key == REVIEW {
                                    holds.release(key, Purpose::Review);
                                }
                                inputs.push_back(Input::RunEnded {
                                    key: run.key,
                                    instance,
                                    exit: None,
                                    error: Some(why),
                                    refused: true,
                                });
                            }
                        }
                    }
                }
                let mut commands: Vec<Command> = Vec::new();
                while let Some(input) = inputs.pop_front() {
                    commands.extend(build.coord.step(input));
                }
                for command in &commands {
                    match command {
                        Command::Launch {
                            key: launch_key,
                            instance,
                            ..
                        } => {
                            build.live.insert(
                                *instance,
                                LiveRun {
                                    key: launch_key.clone(),
                                    run_id: None,
                                    cancel_asked: false,
                                },
                            );
                        }
                        Command::CancelRun { instance, .. } => {
                            if let Some(run) = build.live.get_mut(instance) {
                                match run.run_id {
                                    Some(id) => cancels.push(id),
                                    None => run.cancel_asked = true,
                                }
                            }
                        }
                        _ => {}
                    }
                }
                let state = build.coord.state().clone();
                let settled = matches!(
                    state.phase,
                    BuildPhase::Stopped | BuildPhase::Finished | BuildPhase::Cancelled
                );
                let announced = (state, build.review_waiting.clone());
                if build.emitted.as_ref() != Some(&announced) {
                    build.emitted = Some(announced.clone());
                    build.changed_ms = now_ms();
                    self.launcher.emit(&BuildEvent {
                        change: key.clone(),
                        state: announced.0.clone(),
                        review_waiting: announced.1,
                    });
                }
                // A start under way has taken the holds for the build it is about to begin.
                if settled && build.live.is_empty() && !starting.contains(key) {
                    holds.release(key, Purpose::Build);
                }
                let exec = Exec {
                    place: build.ctx.place.clone(),
                    system: build.ctx.system.clone(),
                    change: build.ctx.change.clone(),
                    last: build.last.clone(),
                    system_repos: build.ctx.system_repos.clone(),
                };
                (commands, cancels, exec)
            };
            if commands.is_empty() && cancels.is_empty() {
                return;
            }
            for run_id in cancels {
                self.launcher.cancel(run_id);
            }
            for command in commands {
                match command {
                    Command::ReadStatus => {
                        match self.snapshot(&exec.place, &exec.system, &exec.change) {
                            Ok((snapshot, plan)) => {
                                let facts = BuildFacts::read(
                                    &plan,
                                    &snapshot.state,
                                    &master_name(&exec.place),
                                );
                                exec.last = Some(snapshot.clone());
                                update.last = Some(snapshot);
                                inputs.push_back(Input::Status(facts));
                            }
                            Err(_) => inputs.push_back(Input::StatusFailed),
                        }
                    }
                    Command::ReadHeads => {
                        let heads = exec
                            .last
                            .as_ref()
                            .map(|s| self.heads(&exec.place, &s.state))
                            .unwrap_or_default();
                        inputs.push_back(Input::Heads(heads));
                    }
                    Command::Launch {
                        key: launch_key,
                        instance,
                        task,
                        instructions,
                        choices,
                        ..
                    } => {
                        if launch_key == REVIEW {
                            // The review reads every product repository of the change: all or none.
                            match self.take_review(&exec, key) {
                                Ok(()) => update.review_waiting = Some(Vec::new()),
                                Err(held) => {
                                    let names: Vec<String> = held
                                        .iter()
                                        .map(|h| {
                                            format!("change {} holds {}", h.holder.change, h.repo)
                                        })
                                        .collect();
                                    update.review_waiting = Some(held);
                                    update.launched.push((instance, Err(names.join(", "))));
                                    continue;
                                }
                            }
                        }
                        if exec.system_repos.is_none() {
                            let repos = self.system_repos(&exec);
                            exec.system_repos = Some(repos.clone());
                            update.system_repos = Some(repos);
                        }
                        let result = self.launch(
                            &exec,
                            key,
                            generation.unwrap_or_default(),
                            Launching {
                                launch_key,
                                instance,
                                task,
                                instructions,
                                choices,
                            },
                        );
                        update.launched.push((instance, result));
                    }
                    Command::CancelRun { .. } => {}
                }
            }
        }
    }

    /// Start one run the coordinator asked for; the run id, or why it did not start.
    fn launch(
        self: &Arc<Self>,
        exec: &Exec,
        key: &ChangeKey,
        generation: u64,
        asked: Launching,
    ) -> Result<u64, String> {
        let Launching {
            launch_key,
            instance,
            task,
            instructions,
            choices,
        } = asked;
        let Some(snapshot) = exec.last.clone() else {
            return Err("the change's state was not read".into());
        };
        let review = launch_key == REVIEW;
        let kind = if review {
            RunKind::Review
        } else {
            RunKind::Build {
                repo: launch_key.clone(),
            }
        };
        let place = RunPlace {
            kind,
            system: exec.system.clone(),
            state: snapshot.state,
            workspace: exec.place.workspace.clone(),
            checkout: exec.place.master.clone(),
            other_copies: snapshot.others,
            system_repos: exec.system_repos.clone().unwrap_or_default(),
            workbench_dir: self.workbench_dir.clone(),
        };
        let spec = change_spec(
            &place,
            RunForm {
                name: String::new(),
                task: String::new(),
                bare: false,
                permission_mode: PermissionMode::Auto,
                timeout_secs: choices.timeout_secs,
                instructions: instructions.or(choices.instructions),
                continue_on_leftovers: choices.continue_on_leftovers,
            },
        );
        let host = Arc::clone(self);
        let ended_key = key.clone();
        self.launcher.launch(LaunchRequest {
            spec,
            lane: Lane::Change {
                key: key.clone(),
                build: true,
            },
            kind: if review {
                runs::RunKind::Review
            } else {
                runs::RunKind::Build
            },
            repo: (!review).then(|| launch_key.clone()),
            task,
            group: format!("build:{}/{}", key.system, key.change),
            ended: Box::new(move |end| host.run_ended(&ended_key, generation, instance, end)),
        })
    }

    /// The folder names of the system's repositories as `change show` lists them (none when it cannot
    /// say), and the master.
    fn system_repos(&self, exec: &Exec) -> Vec<String> {
        let master = exec.place.master.display().to_string();
        let workspace = exec.place.workspace.display().to_string();
        let shown = self.tools.run(
            &[
                "change",
                "show",
                "--json",
                "--change",
                &exec.change,
                "--master",
                &master,
                "--workspace",
                &workspace,
            ],
            &exec.place,
        );
        let mut repos: Vec<String> = shown
            .ok()
            .and_then(|v| v["repos"].as_object().map(|o| o.keys().cloned().collect()))
            .unwrap_or_default();
        repos.push(master_name(&exec.place));
        repos
    }
}

/// What `begin` read under the lock before it called out.
struct Before {
    live_build: bool,
    generation: Option<u64>,
    form: Option<StartForm>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use kata_sdlc::coordinator::BuildPhase;
    use kata_sdlc::format::{ParsedReviewSection, ParsedTask};
    use kata_sdlc::holds::{Purpose, RepoKey};
    use serde_json::json;
    use std::collections::BTreeSet;

    const WS: &str = "D:/ws";
    const SYSTEM: &str = "demo";

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn cref(change: &str) -> ChangeRef {
        ChangeRef {
            workspace: WS.into(),
            system: SYSTEM.into(),
            change: change.into(),
        }
    }

    fn key(change: &str) -> ChangeKey {
        ChangeKey {
            workspace: RepoKey::of(Path::new(WS)),
            system: SYSTEM.into(),
            change: change.into(),
        }
    }

    fn form() -> StartForm {
        StartForm {
            timeout_secs: 600,
            instructions: None,
            continue_on_leftovers: false,
            rounds: Vec::new(),
        }
    }

    fn gate() -> Value {
        json!({"candidate": false, "stop": null, "accept": []})
    }

    /// The state the plugin reports: per repository its task ids, and the ones with a log row.
    fn change_state(
        change: &str,
        master: &str,
        in_copy: bool,
        tasks: &[(&str, &[&str], &[&str])],
    ) -> ChangeState {
        let doc = json!({"exists": true, "inHead": true, "headStatus": "accepted", "workingStatus": "accepted", "uncommitted": false});
        let tasks: BTreeMap<String, Value> = tasks
            .iter()
            .map(|(repo, all, logged)| {
                let unlogged: Vec<&&str> = all.iter().filter(|t| !logged.contains(t)).collect();
                (
                    repo.to_string(),
                    json!({"all": all, "logged": logged, "unlogged": unlogged}),
                )
            })
            .collect();
        serde_json::from_value(json!({
            "change": change,
            "master": master,
            "folder": format!("{master}/intent/{SYSTEM}/{change}"),
            "inCopy": in_copy,
            "title": null,
            "track": "full",
            "documents": {"intent": doc, "spec": doc, "plan": doc},
            "scenarios": 1,
            "tasks": tasks,
            "buildLogs": {},
            "review": {"committed": 0, "draft": "none"},
            "fix": null,
            "ready": {"spec": gate(), "plan": gate(), "build": gate(), "review": gate(), "done": gate(), "reject": gate()},
        }))
        .unwrap()
    }

    fn plan(rows: &[(&str, &str, &[&str])]) -> ParsedPlan {
        ParsedPlan {
            tasks: rows
                .iter()
                .map(|(id, repo, deps)| ParsedTask {
                    id: id.to_string(),
                    name: id.to_string(),
                    repo: repo.to_string(),
                    depends_on: strs(deps),
                    uses: Vec::new(),
                    files: Vec::new(),
                    covers: Vec::new(),
                    supports: Vec::new(),
                    sections: Vec::new(),
                    text: format!("### {id}"),
                    line: 1,
                })
                .collect(),
            shared_decisions: Vec::new(),
        }
    }

    fn copy_of(change: &str) -> String {
        format!("{WS}/.ai-sdlc/copies/{change}")
    }

    fn passed_start(repo: &str, uncommitted: &[&str]) -> Value {
        json!({"event": "build.start", "repo": repo, "outcome": "passed", "problems": [],
            "details": {"branch": "change/x", "created": true, "uncommitted": uncommitted, "from": "main"}})
    }

    fn passed_check(repos: &[String]) -> Value {
        json!({"event": "build.start", "check": true, "outcome": "passed", "problems": [], "refusing": [],
            "repos": repos.iter().map(|r| json!({"repo": r, "outcome": "passed", "problems": []})).collect::<Vec<_>>()})
    }

    /// A stand-in for the ai-sdlc program and the repositories.
    struct FakeTools {
        place: Place,
        system_repos: Vec<String>,
        states: Mutex<Vec<ChangeState>>,
        plans: Mutex<HashMap<String, ParsedPlan>>,
        heads: Mutex<HashMap<String, String>>,
        review: Mutex<Option<ReviewRecord>>,
        check: Mutex<Option<Result<Value, ProgramError>>>,
        starts: Mutex<HashMap<String, Result<Value, ProgramError>>>,
        calls: Mutex<Vec<Vec<String>>>,
        /// The next `states` call announces itself on `.0` and waits for `.1`.
        gate: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    }

    impl FakeTools {
        fn new(place: Place) -> Arc<FakeTools> {
            Arc::new(FakeTools {
                place,
                system_repos: strs(&["ai-sdlc", "kata", "bob"]),
                states: Mutex::new(Vec::new()),
                plans: Mutex::new(HashMap::new()),
                heads: Mutex::new(HashMap::new()),
                review: Mutex::new(None),
                check: Mutex::new(None),
                starts: Mutex::new(HashMap::new()),
                calls: Mutex::new(Vec::new()),
                gate: Mutex::new(None),
            })
        }

        fn add_change(
            &self,
            change: &str,
            master: &str,
            in_copy: bool,
            tasks: &[(&str, &[&str], &[&str])],
            rows: &[(&str, &str, &[&str])],
        ) {
            self.states
                .lock()
                .unwrap()
                .push(change_state(change, master, in_copy, tasks));
            self.plans
                .lock()
                .unwrap()
                .insert(change.to_string(), plan(rows));
        }

        /// The task gets its build log row.
        fn log(&self, change: &str, repo: &str, task: &str) {
            let mut states = self.states.lock().unwrap();
            let state = states.iter_mut().find(|s| s.change == change).unwrap();
            let t = state.tasks.as_mut().unwrap().get_mut(repo).unwrap();
            t.unlogged.retain(|x| x != task);
            t.logged.push(task.to_string());
        }

        fn refuse_check(&self, repo: &str, problem: &str) {
            *self.check.lock().unwrap() = Some(Ok(json!({
                "event": "build.start", "check": true, "outcome": "refused",
                "problems": [problem], "refusing": [repo], "repos": []})));
        }

        fn check_cannot_run(&self, why: &str) {
            *self.check.lock().unwrap() = Some(Err(ProgramError::CouldNotRun {
                message: why.into(),
            }));
        }

        fn start_answer(&self, repo: &str, answer: Value) {
            self.starts
                .lock()
                .unwrap()
                .insert(repo.to_string(), Ok(answer));
        }

        fn calls_for(&self, change: &str) -> Vec<Vec<String>> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.iter().any(|a| a == change))
                .cloned()
                .collect()
        }

        fn checks(&self, change: &str) -> Vec<Vec<String>> {
            self.calls_for(change)
                .into_iter()
                .filter(|c| {
                    c.contains(&"build.start".to_string()) && c.contains(&"--check".to_string())
                })
                .collect()
        }

        fn real_starts(&self, change: &str) -> Vec<String> {
            self.calls_for(change)
                .into_iter()
                .filter(|c| {
                    c.contains(&"build.start".to_string()) && !c.contains(&"--check".to_string())
                })
                .map(|c| c[c.iter().position(|a| a == "--repo").unwrap() + 1].clone())
                .collect()
        }
    }

    impl Tools for FakeTools {
        fn resolve(&self, _workspace: &Path) -> Result<Place, ProgramError> {
            Ok(self.place.clone())
        }
        fn run(&self, command: &[&str], _place: &Place) -> Result<Value, ProgramError> {
            self.calls
                .lock()
                .unwrap()
                .push(command.iter().map(|s| s.to_string()).collect());
            if command.starts_with(&["change", "show"]) {
                let repos: BTreeMap<&String, Value> =
                    self.system_repos.iter().map(|r| (r, json!({}))).collect();
                return Ok(json!({"repos": repos}));
            }
            let repos: Vec<String> = command
                .windows(2)
                .filter(|w| w[0] == "--repo")
                .map(|w| w[1].to_string())
                .collect();
            if command.contains(&"--check") {
                return match self.check.lock().unwrap().clone() {
                    Some(answer) => answer,
                    None => Ok(passed_check(&repos)),
                };
            }
            match self.starts.lock().unwrap().get(&repos[0]).cloned() {
                Some(answer) => answer,
                None => Ok(passed_start(&repos[0], &[])),
            }
        }
        fn states(&self, _place: &Place, _system: &str) -> Result<Vec<ChangeState>, ProgramError> {
            let gate = self.gate.lock().unwrap().take();
            if let Some((entered, release)) = gate {
                entered.send(()).unwrap();
                release.recv().unwrap();
            }
            Ok(self.states.lock().unwrap().clone())
        }
        fn plan(&self, _place: &Place, state: &ChangeState) -> Result<ParsedPlan, String> {
            self.plans
                .lock()
                .unwrap()
                .get(&state.change)
                .cloned()
                .ok_or_else(|| "no plan".to_string())
        }
        fn review_record(
            &self,
            _place: &Place,
            _system: &str,
            _state: &ChangeState,
        ) -> Result<Option<ReviewRecord>, String> {
            Ok(self.review.lock().unwrap().clone())
        }
        fn head(&self, dir: &Path) -> Result<String, String> {
            let name = dir.file_name().unwrap().to_string_lossy().into_owned();
            Ok(self
                .heads
                .lock()
                .unwrap()
                .get(&name)
                .cloned()
                .unwrap_or_else(|| format!("head-of-{name}")))
        }
    }

    struct Launched {
        id: u64,
        workdir: String,
        repo: Option<String>,
        kind: runs::RunKind,
        task: String,
        spec: String,
        ended: Option<Box<dyn FnOnce(RunEnd) + Send>>,
        live: bool,
    }

    /// The run table with no sidecar: a run lives until the test finishes it.
    #[derive(Default)]
    struct FakeLauncher {
        table: Mutex<runs::RunTable<()>>,
        runs: Mutex<Vec<Launched>>,
        events: Mutex<Vec<BuildEvent>>,
        cancelled: Mutex<Vec<u64>>,
    }

    impl Launcher for FakeLauncher {
        fn launch(&self, request: LaunchRequest) -> Result<u64, String> {
            let mut table = self.table.lock().unwrap();
            table.claim(Path::new(&request.spec.workdir), &request.lane)?;
            let mut list = self.runs.lock().unwrap();
            let id = list.len() as u64 + 1;
            table.insert(runs::LiveRun {
                id,
                workdir: PathBuf::from(&request.spec.workdir),
                group: Some(request.group.clone()),
                lane: request.lane.clone(),
                kind: request.kind,
                repo: request.repo.clone(),
                child: None,
            });
            list.push(Launched {
                id,
                spec: serde_json::to_string(&request.spec).unwrap_or_default(),
                workdir: request.spec.workdir.clone(),
                repo: request.repo,
                kind: request.kind,
                task: request.task,
                ended: Some(request.ended),
                live: true,
            });
            Ok(id)
        }
        fn cancel(&self, run_id: u64) {
            self.cancelled.lock().unwrap().push(run_id);
        }
        fn emit(&self, event: &BuildEvent) {
            self.events.lock().unwrap().push(event.clone());
        }
    }

    impl FakeLauncher {
        /// The run ends with `exit`, the way the reader task reports it.
        fn finish(&self, id: u64, exit: i32) {
            let ended = {
                let mut list = self.runs.lock().unwrap();
                let run = list.iter_mut().find(|r| r.id == id).unwrap();
                run.live = false;
                run.ended.take().unwrap()
            };
            self.table.lock().unwrap().remove(id);
            ended(RunEnd {
                exit: Some(exit),
                error: None,
            });
        }

        fn launched(&self, repo: &str) -> Vec<u64> {
            self.runs
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.repo.as_deref() == Some(repo))
                .map(|r| r.id)
                .collect()
        }

        fn live_dirs(&self) -> BTreeSet<String> {
            self.runs
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.live)
                .map(|r| r.workdir.clone())
                .collect()
        }

        fn reviews(&self) -> Vec<u64> {
            self.runs
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.kind == runs::RunKind::Review)
                .map(|r| r.id)
                .collect()
        }

        fn spec_of(&self, id: u64) -> String {
            self.runs
                .lock()
                .unwrap()
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .spec
                .clone()
        }

        fn count(&self) -> usize {
            self.runs.lock().unwrap().len()
        }

        fn task_of(&self, id: u64) -> String {
            self.runs
                .lock()
                .unwrap()
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .task
                .clone()
        }
    }

    struct Rig {
        tools: Arc<FakeTools>,
        launcher: Arc<FakeLauncher>,
        host: Arc<BuildHost>,
    }

    fn fake_place() -> Place {
        Place {
            master: PathBuf::from("D:/ws/ai-sdlc"),
            workspace: PathBuf::from(WS),
        }
    }

    fn rig_with(tools: Arc<FakeTools>) -> Rig {
        let launcher = Arc::new(FakeLauncher::default());
        let host = BuildHost::new(tools.clone(), launcher.clone(), PathBuf::from("D:/wb"));
        Rig {
            tools,
            launcher,
            host,
        }
    }

    fn rig() -> Rig {
        rig_with(FakeTools::new(fake_place()))
    }

    impl Rig {
        /// A change in its own copy whose tasks (repo, all, logged) and plan rows (id, repo, deps) are given.
        fn change(
            &self,
            change: &str,
            tasks: &[(&str, &[&str], &[&str])],
            rows: &[(&str, &str, &[&str])],
        ) {
            self.tools
                .add_change(change, &copy_of(change), true, tasks, rows);
        }

        /// A change with one task in each of `repos`.
        fn simple(&self, change: &str, repos: &[&str]) {
            let ids: Vec<String> = (1..=repos.len()).map(|n| format!("T{n}")).collect();
            let tasks: Vec<(&str, Vec<&str>)> = repos
                .iter()
                .zip(&ids)
                .map(|(r, id)| (*r, vec![id.as_str()]))
                .collect();
            let task_refs: Vec<(&str, &[&str], &[&str])> = tasks
                .iter()
                .map(|(r, ids)| (*r, ids.as_slice(), &[][..]))
                .collect();
            let rows: Vec<(&str, &str, &[&str])> = repos
                .iter()
                .zip(&ids)
                .map(|(r, id)| (id.as_str(), *r, &[][..]))
                .collect();
            self.change(change, &task_refs, &rows);
        }

        /// A change with one task in each of `repos`, every one recorded.
        fn complete(&self, change: &str, repos: &[&str]) {
            self.simple(change, repos);
            for (i, repo) in repos.iter().enumerate() {
                self.tools.log(change, repo, &format!("T{}", i + 1));
            }
        }

        /// `change` holds `repo` for a build.
        fn hold_as(&self, change: &str, repo: &str) {
            self.host
                .inner
                .lock()
                .unwrap()
                .holds
                .take(
                    &key(change),
                    Purpose::Build,
                    &[RepoKey::of(&Path::new(WS).join(repo))],
                )
                .unwrap();
        }

        fn free(&self, change: &str) {
            self.host
                .inner
                .lock()
                .unwrap()
                .holds
                .release(&key(change), Purpose::Build);
        }

        fn phase(&self, change: &str) -> BuildPhase {
            self.host.state(&cref(change)).unwrap().phase
        }

        fn holder(&self, repo: &str) -> Option<ChangeKey> {
            self.host
                .inner
                .lock()
                .unwrap()
                .holds
                .holder(&RepoKey::of(&Path::new(WS).join(repo)))
                .cloned()
        }
    }

    // R11.1
    #[test]
    fn starting_a_run_follows_who_holds_its_folders() {
        #[derive(Clone, Copy, Debug)]
        enum A {
            Building,
            Reviewing,
            Stopped,
            Finished,
            Cancelled,
        }
        enum Want {
            Started,
            Held(&'static str),
            Checked,
        }
        use Want::*;
        let cases: [(A, &[&str], Want); 7] = [
            (A::Building, &["bob"], Started),
            (A::Building, &["kata"], Held("kata")),
            (A::Building, &["kata", "bob"], Held("kata")),
            (A::Reviewing, &["kata"], Held("kata")),
            (A::Stopped, &["kata"], Checked),
            (A::Finished, &["kata"], Checked),
            (A::Cancelled, &["kata"], Checked),
        ];
        for (state_of_a, folders_of_b, want) in cases {
            let r = rig();
            r.simple("A", &["kata"]);
            r.simple("B", folders_of_b);
            match state_of_a {
                A::Building | A::Stopped | A::Cancelled => {
                    assert!(matches!(
                        r.host.start(&cref("A"), form()),
                        StartOutcome::Started { .. }
                    ));
                    let a_run = r.launcher.launched("kata")[0];
                    match state_of_a {
                        A::Stopped => {
                            r.launcher.finish(a_run, 1);
                            assert_eq!(r.phase("A"), BuildPhase::Stopped);
                        }
                        A::Cancelled => {
                            r.host.cancel(&cref("A"));
                            r.launcher.finish(a_run, 130);
                            assert_eq!(r.phase("A"), BuildPhase::Cancelled);
                        }
                        _ => {}
                    }
                }
                A::Reviewing => {
                    r.host
                        .inner
                        .lock()
                        .unwrap()
                        .holds
                        .take(
                            &key("A"),
                            Purpose::Review,
                            &[RepoKey::of(&Path::new(WS).join("kata"))],
                        )
                        .unwrap();
                }
                A::Finished => {
                    r.tools.log("A", "kata", "T1");
                    r.tools
                        .heads
                        .lock()
                        .unwrap()
                        .insert("kata".into(), "abc1234".into());
                    *r.tools.review.lock().unwrap() = Some(ReviewRecord {
                        layout: 2,
                        reviews: vec![ParsedReviewSection {
                            number: 1,
                            reviewed_at: "2026-11-01".into(),
                            commits: BTreeMap::from([("kata".to_string(), "abc1234".to_string())]),
                            findings: Vec::new(),
                        }],
                        problems: Vec::new(),
                        master_moved: Vec::new(),
                    });
                    r.host.start(&cref("A"), form());
                    assert_eq!(r.phase("A"), BuildPhase::Finished);
                }
            }
            let runs_before = r.launcher.count();
            let outcome = r.host.start(&cref("B"), form());
            let label = format!("A {state_of_a:?}, B needs {folders_of_b:?}");
            match want {
                Started => {
                    assert!(matches!(outcome, StartOutcome::Started { .. }), "{label}");
                    assert_eq!(
                        r.launcher.live_dirs(),
                        BTreeSet::from(["D:/ws/kata".to_string(), "D:/ws/bob".to_string()]),
                        "{label}: both builds run"
                    );
                }
                Held(repo) => {
                    assert_eq!(
                        outcome,
                        StartOutcome::Held {
                            held: vec![HeldRepo {
                                repo: repo.into(),
                                holder: key("A")
                            }]
                        },
                        "{label}"
                    );
                    assert_eq!(r.launcher.count(), runs_before, "{label}: no run started");
                    assert!(
                        r.tools.calls_for("B").is_empty(),
                        "{label}: nothing prepared"
                    );
                    assert_eq!(r.holder("bob"), None, "{label}: no hold taken in bob");
                }
                Checked => {
                    assert!(matches!(outcome, StartOutcome::Started { .. }), "{label}");
                    let checks = r.tools.checks("B");
                    assert_eq!(checks.len(), 1, "{label}: the plugin checked it");
                    assert!(
                        checks[0].windows(2).any(|w| w == ["--repo", "kata"]),
                        "{label}"
                    );
                    assert_eq!(r.holder("kata"), Some(key("B")), "{label}");
                }
            }
        }

        // A spec run in B's own copy is not held by A's build.
        let r = rig();
        r.simple("A", &["kata"]);
        r.simple("B", &["bob"]);
        r.host.start(&cref("A"), form());
        let b_lane = Lane::Change {
            key: key("B"),
            build: false,
        };
        let b_copy = copy_of("B");
        assert!(r
            .launcher
            .table
            .lock()
            .unwrap()
            .claim(Path::new(&b_copy), &b_lane)
            .is_ok());
    }

    // R4.1 and the decision table, rows 1 to 6
    #[test]
    fn preparing_repositories_rows() {
        // Row 1: a build of this change is live.
        {
            let r = rig();
            r.simple("A", &["kata", "bob"]);
            r.host.start(&cref("A"), form());
            let calls = r.tools.calls.lock().unwrap().len();
            assert_eq!(
                r.host.start(&cref("A"), form()),
                StartOutcome::AlreadyRunning
            );
            assert_eq!(
                r.tools.calls.lock().unwrap().len(),
                calls,
                "row 1: nothing prepared"
            );
            assert_eq!(r.launcher.count(), 2, "row 1: no second build");
        }
        // Row 2: held.
        {
            let r = rig();
            r.simple("A", &["kata"]);
            r.simple("B", &["kata", "bob"]);
            r.host.start(&cref("A"), form());
            let outcome = r.host.start(&cref("B"), form());
            assert_eq!(
                outcome,
                StartOutcome::Held {
                    held: vec![HeldRepo {
                        repo: "kata".into(),
                        holder: key("A")
                    }]
                }
            );
            assert!(r.tools.calls_for("B").is_empty(), "row 2: nothing prepared");
        }
        // Row 3 and R4.1 "refuses bob": the plugin's reasons, no start, holds released, no run.
        {
            let r = rig();
            r.simple("A", &["kata", "bob"]);
            r.tools.refuse_check("bob", "bob has uncommitted files: x.txt. Commit or put them away first; nothing was switched.");
            let outcome = r.host.start(&cref("A"), form());
            assert_eq!(
                outcome,
                StartOutcome::Refused {
                    problems: strs(&["bob has uncommitted files: x.txt. Commit or put them away first; nothing was switched."])
                }
            );
            assert!(
                r.tools.real_starts("A").is_empty(),
                "row 3: build.start never ran"
            );
            assert_eq!(r.launcher.count(), 0, "row 3: no run in either repository");
            assert_eq!(r.holder("kata"), None, "row 3: holds released");
            assert_eq!(r.holder("bob"), None);
            let checks = r.tools.checks("A");
            assert_eq!(checks.len(), 1);
            assert!(checks[0].windows(2).any(|w| w == ["--repo", "kata"]));
            assert!(
                checks[0].windows(2).any(|w| w == ["--repo", "bob"]),
                "one check names both"
            );
        }
        // Row 4 and R4.1 "cannot run": the machine could not run the step.
        {
            let r = rig();
            r.simple("A", &["kata", "bob"]);
            r.tools
                .check_cannot_run("ai-sdlc needs Node.js 22.18 or later");
            assert_eq!(
                r.host.start(&cref("A"), form()),
                StartOutcome::CouldNotRun {
                    output: "ai-sdlc needs Node.js 22.18 or later".into()
                }
            );
            assert!(
                r.tools.real_starts("A").is_empty(),
                "row 4: build.start never ran"
            );
            assert_eq!(r.launcher.count(), 0);
            assert_eq!(r.holder("kata"), None);
        }
        // Row 5: the check passes, a start refuses (something changed in between).
        {
            let r = rig();
            r.simple("A", &["kata", "bob"]);
            r.tools.start_answer(
                "bob",
                json!({"event": "build.start", "repo": "bob", "outcome": "refused", "problems": ["bob changed since the check"], "details": null}),
            );
            assert_eq!(
                r.host.start(&cref("A"), form()),
                StartOutcome::Refused {
                    problems: strs(&["bob changed since the check"])
                }
            );
            assert_eq!(
                r.tools.real_starts("A"),
                ["kata", "bob"],
                "row 5: started in plan order up to the refusal"
            );
            assert_eq!(r.launcher.count(), 0);
            assert_eq!(r.holder("kata"), None, "row 5: holds released");
            assert_eq!(r.holder("bob"), None);
        }
        {
            let r = rig();
            r.simple("A", &["kata", "bob"]);
            r.tools.start_answer(
                "kata",
                json!({"event": "build.start", "repo": "kata", "outcome": "could-not-run", "problems": ["git failed"], "details": null}),
            );
            assert_eq!(
                r.host.start(&cref("A"), form()),
                StartOutcome::CouldNotRun {
                    output: "git failed".into()
                }
            );
            assert_eq!(r.tools.real_starts("A"), ["kata"]);
            assert_eq!(r.launcher.count(), 0);
        }
        // Row 6 and R4.1 "passes for both": both runs start, holds kept, in plan order.
        {
            let r = rig();
            r.simple("A", &["kata", "bob"]);
            assert_eq!(
                r.host.start(&cref("A"), form()),
                StartOutcome::Started {
                    uncommitted: BTreeMap::new()
                }
            );
            assert_eq!(r.tools.real_starts("A"), ["kata", "bob"]);
            assert_eq!(
                r.launcher.live_dirs(),
                BTreeSet::from(["D:/ws/kata".to_string(), "D:/ws/bob".to_string()])
            );
            assert_eq!(r.holder("kata"), Some(key("A")), "row 6: holds kept");
            assert_eq!(r.holder("bob"), Some(key("A")));
        }
    }

    // R4.2
    #[test]
    fn a_repository_on_the_branch_with_work_continues() {
        let r = rig();
        r.simple("A", &["kata"]);
        r.tools
            .start_answer("kata", passed_start("kata", &["src/a.rs", "src/b.rs"]));
        let outcome = r.host.continue_repo(&cref("A"), "kata");
        assert_eq!(
            outcome,
            StartOutcome::Started {
                uncommitted: BTreeMap::from([(
                    "kata".to_string(),
                    strs(&["src/a.rs", "src/b.rs"])
                )])
            }
        );
        assert_eq!(
            r.launcher.launched("kata").len(),
            1,
            "the build continues in kata"
        );
    }

    // R11.2
    #[test]
    fn a_held_build_does_not_start_when_the_holder_ends() {
        let r = rig();
        r.simple("A", &["kata"]);
        r.simple("B", &["kata"]);
        r.host.start(&cref("A"), form());
        assert!(matches!(
            r.host.start(&cref("B"), form()),
            StartOutcome::Held { .. }
        ));
        let a_run = r.launcher.launched("kata")[0];
        r.launcher.finish(a_run, 1);
        assert!(
            r.host.state(&cref("B")).is_none(),
            "B was not started by A ending"
        );
        assert_eq!(r.launcher.launched("kata").len(), 1, "no run for B");
        assert!(r.tools.calls_for("B").is_empty(), "nothing prepared for B");
        assert_eq!(r.holder("kata"), None, "A's hold is gone");
        // The engineer starts it again: a fresh start, checked by the plugin.
        assert!(matches!(
            r.host.start(&cref("B"), form()),
            StartOutcome::Started { .. }
        ));
        assert_eq!(r.tools.checks("B").len(), 1);
        assert_eq!(r.holder("kata"), Some(key("B")));
    }

    // R11.4
    #[test]
    fn a_second_start_of_a_running_build_is_refused() {
        let r = rig();
        r.simple("A", &["kata"]);
        r.host.start(&cref("A"), form());
        assert_eq!(
            r.host.start(&cref("A"), form()),
            StartOutcome::AlreadyRunning
        );
        assert_eq!(
            r.host.continue_repo(&cref("A"), "kata"),
            StartOutcome::AlreadyRunning
        );
        assert_eq!(r.launcher.launched("kata").len(), 1);
    }

    // R11.5
    #[test]
    fn a_build_run_works_in_the_workspace_checkout() {
        let r = rig();
        r.simple("B", &["bob"]);
        r.host.start(&cref("B"), form());
        assert_eq!(
            r.launcher.live_dirs(),
            BTreeSet::from(["D:/ws/bob".to_string()])
        );
        let calls = r.tools.calls_for("B");
        assert!(
            calls.iter().all(|c| c[0] == "run" || c[0] == "change"),
            "no copy of bob is made: {calls:?}"
        );
    }

    // R11.7
    #[test]
    fn a_held_build_started_again_over_uncommitted_files() {
        let r = rig();
        r.simple("A", &["kata"]);
        r.simple("B", &["kata"]);
        r.host.start(&cref("A"), form());
        assert!(matches!(
            r.host.start(&cref("B"), form()),
            StartOutcome::Held { .. }
        ));
        r.launcher.finish(r.launcher.launched("kata")[0], 1);
        r.tools.refuse_check("kata", "kata has uncommitted files: wip.txt. Commit or put them away first; nothing was switched.");
        let outcome = r.host.start(&cref("B"), form());
        assert_eq!(
            outcome,
            StartOutcome::Refused {
                problems: strs(&["kata has uncommitted files: wip.txt. Commit or put them away first; nothing was switched."])
            },
            "the plugin decides"
        );
        assert!(r.tools.real_starts("B").is_empty());
        assert_eq!(r.launcher.launched("kata").len(), 1, "no run for B");
        assert_eq!(r.holder("kata"), None);
    }

    // R13.5
    #[test]
    fn the_build_launches_the_next_repository_and_the_review_with_no_screen() {
        let r = rig();
        r.change(
            "A",
            &[("kata", &["T1"], &[]), ("bob", &["T2"], &[])],
            &[("T1", "kata", &[]), ("T2", "bob", &["T1"])],
        );
        r.host.start(&cref("A"), form());
        assert_eq!(r.launcher.launched("kata").len(), 1);
        assert!(r.launcher.launched("bob").is_empty(), "bob waits for T1");
        // kata's run ends with T1 recorded; nobody looks at a page.
        r.tools.log("A", "kata", "T1");
        r.launcher.finish(r.launcher.launched("kata")[0], 0);
        assert_eq!(
            r.launcher.launched("bob").len(),
            1,
            "the ready repository starts by itself"
        );
        // bob's run ends with the last task recorded: the review starts.
        r.tools.log("A", "bob", "T2");
        r.launcher.finish(r.launcher.launched("bob")[0], 0);
        let review: Vec<_> = r
            .launcher
            .runs
            .lock()
            .unwrap()
            .iter()
            .filter(|l| l.kind == runs::RunKind::Review)
            .map(|l| l.workdir.clone())
            .collect();
        assert_eq!(
            review,
            [copy_of("A")],
            "the review runs in the change's master"
        );
        assert_eq!(r.phase("A"), BuildPhase::Reviewing);
        let events = r.launcher.events.lock().unwrap();
        let last = events.last().unwrap();
        assert_eq!(last.change, key("A"));
        assert_eq!(last.state.phase, BuildPhase::Reviewing);
    }

    // R20.1
    #[test]
    fn a_change_in_the_checkout_runs_beside_a_copy_change() {
        let r = rig();
        r.tools.add_change(
            "X",
            "D:/ws/ai-sdlc",
            false,
            &[("bob", &["T1"], &["T1"])],
            &[("T1", "bob", &[])],
        );
        r.tools.add_change(
            "Y",
            &copy_of("Y"),
            true,
            &[("kata", &["T1"], &["T1"])],
            &[("T1", "kata", &[])],
        );
        // Both are complete, so each goes straight to its review in its own master.
        assert!(matches!(
            r.host.start(&cref("X"), form()),
            StartOutcome::Started { .. }
        ));
        assert!(matches!(
            r.host.start(&cref("Y"), form()),
            StartOutcome::Started { .. }
        ));
        assert_eq!(
            r.launcher.live_dirs(),
            BTreeSet::from(["D:/ws/ai-sdlc".to_string(), copy_of("Y")]),
            "X reviews in the checkout, Y in its copy, at once"
        );
        // The folder rule still holds: a second run in the checkout is refused.
        let lane = Lane::Change {
            key: key("X"),
            build: false,
        };
        assert!(r
            .launcher
            .table
            .lock()
            .unwrap()
            .claim(Path::new("D:/ws/ai-sdlc"), &lane)
            .is_err());
    }

    // R4.1 and R11.1 hold for several changes at once: a slow call of the plugin for one change
    // never stops another change's build.
    #[test]
    fn a_slow_plugin_call_does_not_block_another_changes_build() {
        use std::sync::mpsc::{channel, RecvTimeoutError};
        use std::time::Duration;
        let r = rig();
        r.simple("A", &["api"]);
        r.change(
            "B",
            &[("kata", &["T1"], &[]), ("bob", &["T2"], &[])],
            &[("T1", "kata", &[]), ("T2", "bob", &["T1"])],
        );
        assert!(matches!(
            r.host.start(&cref("B"), form()),
            StartOutcome::Started { .. }
        ));
        // A's start asks the plugin for the state, and the plugin is slow.
        let (entered_tx, entered_rx) = channel();
        let (release_tx, release_rx) = channel();
        *r.tools.gate.lock().unwrap() = Some((entered_tx, release_rx));
        let host_a = r.host.clone();
        let slow = std::thread::spawn(move || host_a.start(&cref("A"), form()));
        entered_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("A's start reached the plugin");
        // Meanwhile B's run ends and B goes on.
        let (done_tx, done_rx) = channel();
        let host_b = r.host.clone();
        let launcher = r.launcher.clone();
        let tools = r.tools.clone();
        std::thread::spawn(move || {
            tools.log("B", "kata", "T1");
            launcher.finish(launcher.launched("kata")[0], 0);
            let launched = launcher.launched("bob").len();
            let answered = host_b.state(&cref("B")).is_some();
            let _ = done_tx.send((launched, answered));
        });
        let seen = done_rx.recv_timeout(Duration::from_secs(5));
        release_tx.send(()).unwrap();
        match seen {
            Ok((launched, answered)) => {
                assert_eq!(launched, 1, "B's next repository launched");
                assert!(answered, "state(B) answered");
            }
            Err(RecvTimeoutError::Timeout) => {
                panic!("B was blocked behind A's slow plugin call")
            }
            Err(e) => panic!("{e}"),
        }
        assert!(matches!(slow.join().unwrap(), StartOutcome::Started { .. }));
    }

    #[test]
    fn a_spec_run_claims_its_change_and_gets_the_denies() {
        let r = rig();
        r.simple("A", &["api"]);
        r.simple("B", &["kata"]);
        assert!(matches!(
            r.host.start(&cref("A"), form()),
            StartOutcome::Started { .. }
        ));
        let run_form = RunForm {
            name: "sdlc-demo-B-spec".into(),
            task: "Use the ai-sdlc spec skill.".into(),
            bare: true,
            permission_mode: PermissionMode::Auto,
            timeout_secs: 900,
            instructions: None,
            continue_on_leftovers: false,
        };
        let id = r
            .host
            .change_run(&cref("B"), runs::RunKind::Spec, run_form)
            .expect("a spec run of B starts beside A's build");
        let spec = r.launcher.spec_of(id);
        let deny = |p: &str| {
            format!(
                "Edit({}/**)",
                kata_sdlc::permissions::rule_path(Path::new(p))
            )
        };
        assert!(
            spec.contains(&deny("D:/ws/ai-sdlc")),
            "the engineer's checkout is denied"
        );
        assert!(
            spec.contains(&deny(&copy_of("A"))),
            "another change's copy is denied"
        );
        assert!(
            !spec.contains(&deny(&copy_of("B"))),
            "its own master is not denied"
        );
        let live = r.launcher.table.lock().unwrap().live();
        let run = live.iter().find(|l| l.id == id).unwrap();
        assert_eq!(
            run.lane,
            Lane::Change {
                key: key("B"),
                build: false
            }
        );
        assert_eq!(run.kind, runs::RunKind::Spec);
        assert!(
            !r.launcher.table.lock().unwrap().group_live("build:demo/B"),
            "a document run is not part of B's build"
        );
        assert!(r.host.state(&cref("A")).is_some());
    }

    fn held_kata(holder: &str) -> Vec<HeldRepo> {
        vec![HeldRepo {
            repo: "kata".into(),
            holder: key(holder),
        }]
    }

    // R12.1
    #[test]
    fn the_automatic_review_waits_for_a_held_repository() {
        let r = rig();
        r.complete("A", &["kata"]);
        r.hold_as("B", "kata");
        assert!(matches!(
            r.host.start(&cref("A"), form()),
            StartOutcome::Started { .. }
        ));
        assert!(r.launcher.reviews().is_empty(), "the review did not launch");
        assert_eq!(r.launcher.count(), 0);
        assert_eq!(r.host.review_waiting(&cref("A")), held_kata("B"));
        assert_eq!(r.phase("A"), BuildPhase::Stopped);
        assert_eq!(r.holder("kata"), Some(key("B")), "B still holds kata");
        {
            let events = r.launcher.events.lock().unwrap();
            assert_eq!(events.last().unwrap().review_waiting, held_kata("B"));
        }
        // Nothing restarts it by itself when B lets go.
        r.free("B");
        assert_eq!(r.launcher.count(), 0);
        assert_eq!(r.holder("kata"), None);
    }

    // R12.2
    #[test]
    fn a_review_started_by_hand_waits() {
        let r = rig();
        r.complete("A", &["kata"]);
        r.hold_as("B", "kata");
        assert_eq!(
            r.host.review_start(&cref("A")),
            StartOutcome::Held {
                held: held_kata("B")
            }
        );
        assert_eq!(r.launcher.count(), 0);
        assert!(r.host.state(&cref("A")).is_none(), "no build was begun");
        assert!(r.tools.real_starts("A").is_empty());
        assert_eq!(r.holder("kata"), Some(key("B")));
    }

    // R12.3
    #[test]
    fn a_running_review_holds_its_repositories() {
        let r = rig();
        r.complete("A", &["kata"]);
        r.simple("B", &["kata"]);
        assert!(matches!(
            r.host.start(&cref("A"), form()),
            StartOutcome::Started { .. }
        ));
        let review = r.launcher.reviews();
        assert_eq!(review.len(), 1, "A's review runs");
        assert_eq!(r.holder("kata"), Some(key("A")));
        assert_eq!(
            r.host.start(&cref("B"), form()),
            StartOutcome::Held {
                held: held_kata("A")
            }
        );
        assert!(r.tools.calls_for("B").is_empty(), "nothing prepared for B");
        // The hold ends with the review run.
        r.launcher.finish(review[0], 0);
        assert_eq!(r.holder("kata"), None);
        assert!(matches!(
            r.host.start(&cref("B"), form()),
            StartOutcome::Started { .. }
        ));
    }

    // R12.1, R12.2 and R12.3: the decision table
    #[test]
    fn review_start_rows() {
        // Row 3, by hand: taken, the review launches in the change's master with --review --master.
        {
            let r = rig();
            r.complete("A", &["kata"]);
            assert!(matches!(
                r.host.review_start(&cref("A")),
                StartOutcome::Started { .. }
            ));
            let review = r.launcher.reviews();
            assert_eq!(review.len(), 1);
            assert!(r.launcher.spec_of(review[0]).contains("--review --master"));
            assert_eq!(r.holder("kata"), Some(key("A")), "row 3: hold kept");
            // The hold goes when the run ends, whatever its outcome.
            r.launcher.finish(review[0], 1);
            assert_eq!(r.holder("kata"), None, "row 3: released at the run's end");
        }
        // Row 1 then row 3: a review that waited starts when the engineer chooses.
        {
            let r = rig();
            r.complete("A", &["kata"]);
            r.hold_as("B", "kata");
            r.host.start(&cref("A"), form());
            assert_eq!(r.host.review_waiting(&cref("A")), held_kata("B"));
            r.free("B");
            assert!(matches!(
                r.host.review_start(&cref("A")),
                StartOutcome::Started { .. }
            ));
            assert_eq!(r.launcher.reviews().len(), 1);
            assert!(r.host.review_waiting(&cref("A")).is_empty());
            assert_eq!(r.holder("kata"), Some(key("A")));
        }
        // Row 2: by hand and held, nothing launches and nothing is left held by A.
        {
            let r = rig();
            r.complete("A", &["kata", "bob"]);
            r.hold_as("B", "bob");
            assert_eq!(
                r.host.review_start(&cref("A")),
                StartOutcome::Held {
                    held: vec![HeldRepo {
                        repo: "bob".into(),
                        holder: key("B")
                    }]
                }
            );
            assert_eq!(r.launcher.count(), 0);
            assert_eq!(r.holder("kata"), None, "all or none");
        }
    }

    // R12.3 and R18.2
    #[test]
    fn a_round_starts_the_requests_its_plan_shows() {
        use kata_sdlc::format::{Concern, ParsedFinding, Severity};
        let r = rig();
        r.complete("A", &["kata"]);
        r.tools
            .heads
            .lock()
            .unwrap()
            .insert("kata".into(), "abc1234".into());
        *r.tools.review.lock().unwrap() = Some(ReviewRecord {
            layout: 2,
            reviews: vec![ParsedReviewSection {
                number: 1,
                reviewed_at: "2026-11-01".into(),
                commits: BTreeMap::from([("kata".to_string(), "abc1234".to_string())]),
                findings: vec![ParsedFinding {
                    id: "F1".into(),
                    severity: Severity::High,
                    file: "src/a.rs".into(),
                    line: 3,
                    text: "The claim never expires.".into(),
                    repo: Some("kata".into()),
                    concern: Some(Concern::Bug),
                    rule: None,
                }],
            }],
            problems: Vec::new(),
            master_moved: Vec::new(),
        });
        let offer = r.host.round_offer(&cref("A")).unwrap();
        assert_eq!(offer.review, Some(1));
        assert_eq!(offer.findings.len(), 1);
        assert!(offer.repos.contains(&"kata".to_string()));
        assert_eq!(
            r.host.round_offer(&cref("A")).unwrap(),
            offer,
            "the same on every read"
        );
        let picks = round::default_picks(&offer);
        assert!(picks.picked.contains("F1"));
        let shown = r.host.round_plan(&cref("A"), &picks).unwrap();
        assert_eq!(shown, round::plan(&offer, &picks));
        assert_eq!(shown.requests.len(), 1);
        // A round with nothing picked is refused with the plan's reason; nothing starts.
        assert_eq!(
            r.host.round_start(&cref("A"), RoundPicks::default()),
            StartOutcome::Refused {
                problems: vec!["Pick a finding or write a note.".into()]
            }
        );
        assert_eq!(r.launcher.count(), 0);
        // The start launches exactly the requests the plan showed.
        assert!(matches!(
            r.host.round_start(&cref("A"), picks),
            StartOutcome::Started { .. }
        ));
        let launched = r.launcher.launched("kata");
        assert_eq!(launched.len(), shown.requests.len());
        assert!(r
            .launcher
            .spec_of(launched[0])
            .contains("Fix these findings from review 1"));
    }

    // R20.2
    #[test]
    fn a_build_continued_after_the_upgrade_starts_at_the_first_unlogged_task() {
        let r = rig();
        r.change(
            "Y",
            &[("kata", &["T1", "T2", "T3", "T4", "T5"], &["T1", "T2"])],
            &[
                ("T1", "kata", &[]),
                ("T2", "kata", &[]),
                ("T3", "kata", &[]),
                ("T4", "kata", &[]),
                ("T5", "kata", &[]),
            ],
        );
        let outcome = r.host.continue_repo(&cref("Y"), "kata");
        assert!(matches!(outcome, StartOutcome::Started { .. }));
        let run = r.launcher.launched("kata")[0];
        assert_eq!(r.launcher.task_of(run), "T3");
    }

    // The tests below run the vendored 1.1.0 program against temp git repositories.

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn init_repo(ws: &Path, name: &str) -> PathBuf {
        let dir = ws.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("README.md"), "init\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    fn vendored() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../crates/kata-sdlc/tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    /// A workspace with the master, `kata` and `bob`, and the changes started in their own copies.
    struct Real {
        _dir: tempfile::TempDir,
        ws: PathBuf,
        place: Place,
        branches: HashMap<String, String>,
        copies: HashMap<String, String>,
    }

    fn real_workspace(changes: &[&str]) -> Real {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().canonicalize().unwrap();
        let master = init_repo(&ws, "ai-sdlc");
        std::fs::write(
            master.join(".ai-sdlc.json"),
            r#"{"version":1,"systems":{"demo":{"repos":["kata","bob"]}}}"#,
        )
        .unwrap();
        git(&master, &["add", "."]);
        git(&master, &["commit", "-q", "-m", "marker"]);
        init_repo(&ws, "kata");
        init_repo(&ws, "bob");
        let program = vendored();
        let place = program.resolve(&ws).unwrap();
        let mut branches = HashMap::new();
        let mut copies = HashMap::new();
        for change in changes {
            let started = program
                .run(
                    &[
                        "change",
                        "start",
                        "--json",
                        "--system",
                        SYSTEM,
                        "--change",
                        change,
                        "--type",
                        "feat",
                        "--scope",
                        "X-1",
                        "--master",
                        &place.master.display().to_string(),
                        "--workspace",
                        &place.workspace.display().to_string(),
                    ],
                    &place,
                )
                .unwrap();
            assert_eq!(started["outcome"], "passed", "{started}");
            let copy = started["details"]["copy"].as_str().unwrap().to_string();
            std::fs::create_dir_all(Path::new(&copy).join(format!("intent/{SYSTEM}/{change}")))
                .unwrap();
            std::fs::write(
                Path::new(&copy).join(format!("intent/{SYSTEM}/{change}/intent.md")),
                "---\ntitle: T\nstatus: accepted\n---\n\n# Intent\n",
            )
            .unwrap();
            branches.insert(
                change.to_string(),
                started["details"]["branch"].as_str().unwrap().to_string(),
            );
            copies.insert(change.to_string(), copy);
        }
        Real {
            _dir: dir,
            ws,
            place,
            branches,
            copies,
        }
    }

    /// The real program and repositories, with the fake's states, plans and run table.
    struct RealRun {
        real: ProgramTools,
        fake: Arc<FakeTools>,
    }

    impl Tools for RealRun {
        fn resolve(&self, workspace: &Path) -> Result<Place, ProgramError> {
            self.real.resolve(workspace)
        }
        fn run(&self, command: &[&str], place: &Place) -> Result<Value, ProgramError> {
            self.real.run(command, place)
        }
        fn states(&self, place: &Place, system: &str) -> Result<Vec<ChangeState>, ProgramError> {
            self.fake.states(place, system)
        }
        fn plan(&self, place: &Place, state: &ChangeState) -> Result<ParsedPlan, String> {
            self.fake.plan(place, state)
        }
        fn review_record(
            &self,
            place: &Place,
            system: &str,
            state: &ChangeState,
        ) -> Result<Option<ReviewRecord>, String> {
            self.fake.review_record(place, system, state)
        }
        fn head(&self, dir: &Path) -> Result<String, String> {
            self.fake.head(dir)
        }
    }

    fn real_rig(real: &Real, changes: &[&str]) -> Rig {
        let fake = FakeTools::new(real.place.clone());
        for change in changes {
            fake.add_change(
                change,
                &real.copies[*change],
                true,
                &[("kata", &["T1"], &[]), ("bob", &["T2"], &[])],
                &[("T1", "kata", &[]), ("T2", "bob", &[])],
            );
        }
        let tools = Arc::new(RealRun {
            real: ProgramTools::new(vendored()),
            fake: fake.clone(),
        });
        let launcher = Arc::new(FakeLauncher::default());
        let host = BuildHost::new(tools, launcher.clone(), PathBuf::from("D:/wb"));
        Rig {
            tools: fake,
            launcher,
            host,
        }
    }

    fn cref_in(real: &Real, change: &str) -> ChangeRef {
        ChangeRef {
            workspace: real.ws.display().to_string(),
            system: SYSTEM.into(),
            change: change.into(),
        }
    }

    // R4.3
    #[test]
    fn a_refusal_in_one_repository_changes_no_repository() {
        let real = real_workspace(&["2026-11-01-a"]);
        let bob_file = real.ws.join("bob/scratch.txt");
        std::fs::write(&bob_file, "mine\n").unwrap();
        let r = real_rig(&real, &["2026-11-01-a"]);
        let outcome = r.host.start(&cref_in(&real, "2026-11-01-a"), form());
        match outcome {
            StartOutcome::Refused { problems } => {
                assert!(
                    problems
                        .iter()
                        .any(|p| p.contains("bob has uncommitted files: scratch.txt")),
                    "{problems:?}"
                );
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert_eq!(
            git(&real.ws.join("kata"), &["branch", "--show-current"]),
            "main"
        );
        assert_eq!(
            git(&real.ws.join("bob"), &["branch", "--show-current"]),
            "main"
        );
        assert_eq!(std::fs::read_to_string(&bob_file).unwrap(), "mine\n");
        assert!(git(&real.ws.join("kata"), &["status", "--porcelain"]).is_empty());
        assert!(
            !real.ws.join("kata/.git/ai-sdlc/active-build.json").exists(),
            "build.start never ran in kata"
        );
        assert_eq!(r.launcher.count(), 0);
    }

    // R11.8
    #[test]
    fn a_repository_left_on_the_previous_changes_branch() {
        let (a, b) = ("2026-11-01-a", "2026-11-01-b");
        // No uncommitted files: the plugin moves kata, Kata switches nothing.
        {
            let real = real_workspace(&[a, b]);
            let kata = real.ws.join("kata");
            git(&kata, &["checkout", "-q", "-b", &real.branches[a]]);
            let r = real_rig(&real, &[b]);
            let outcome = r.host.start(&cref_in(&real, b), form());
            assert!(
                matches!(outcome, StartOutcome::Started { .. }),
                "{outcome:?}"
            );
            assert_eq!(git(&kata, &["branch", "--show-current"]), real.branches[b]);
            assert_eq!(r.launcher.launched("kata").len(), 1);
        }
        // Uncommitted files: the plugin refuses, naming them, and nothing is changed.
        {
            let real = real_workspace(&[a, b]);
            let kata = real.ws.join("kata");
            git(&kata, &["checkout", "-q", "-b", &real.branches[a]]);
            std::fs::write(kata.join("wip.txt"), "work\n").unwrap();
            let r = real_rig(&real, &[b]);
            let outcome = r.host.start(&cref_in(&real, b), form());
            match outcome {
                StartOutcome::Refused { problems } => {
                    assert!(
                        problems.iter().any(|p| p.contains("wip.txt")),
                        "{problems:?}"
                    );
                }
                other => panic!("expected a refusal, got {other:?}"),
            }
            assert_eq!(git(&kata, &["branch", "--show-current"]), real.branches[a]);
            assert_eq!(
                std::fs::read_to_string(kata.join("wip.txt")).unwrap(),
                "work\n"
            );
            assert_eq!(r.launcher.count(), 0);
        }
    }
}
