//! Th backend's host for each change's build: one `Coordinator` per change, the holds on product
//! repositories, and the plugin's `build.start` that prepares every repository before any run starts.
//! The host executes the coordinator's commands; it decides nothing the coordinator or the plugin decides.
//! Everything outside the process (the ai-sdlc program, the run table and sidecar, the event channel)
//! sits behind [`Tools`] and [`Launcher`], so the tests need no Tauri app.

use crate::runs::{self, Lane};
use crate::steps::{StepGuard, StepKind, StepTable};
use kata_core::proc::{CancelToken, LineSink};
use kata_core::spec::PermissionMode;
use kata_core::RunSpec;
use kata_sdlc::ai_sdlc::state::{self, read_state, ChangeState};
use kata_sdlc::ai_sdlc::{
    progress_of, Answer, HookFailure, Place, Program, ProgramError, StepOutcome, StepProgressKind,
};
use kata_sdlc::coordinator::{
    self, BuildChoices, BuildFacts, BuildPhase, BuildState, Command, Coordinator, Input,
};
use kata_sdlc::format::{self, ParsedPlan, ReadResult};
use kata_sdlc::git;
use kata_sdlc::holds::{needed_repos, review_repos, ChangeKey, HoldTable, Purpose, RepoKey};
use kata_sdlc::permissions::{RunKind, RunPlace};
use kata_sdlc::review::{self, ReviewCurrency, ReviewRecord};
use kata_sdlc::round::{self, RoundOffer, RoundPicks, RoundPlan, RoundRequest};
use kata_sdlc::runspec::{change_spec, given_for, RunForm};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ChangeRef {
    pub workspace: String,
    pub system: String,
    pub change: String,
}

/// What the engineer chose for a build.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct StartForm {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub timeout_secs: u64,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub instructions: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<bool>"))]
    pub continue_on_leftovers: bool,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<Vec<RoundRequest>>"))]
    pub rounds: Vec<RoundRequest>,
    /// The keys of the given items the engineer switched off, as the build's given rows carry them.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<Vec<String>>"))]
    pub off: Vec<String>,
}

/// A repository another change holds.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct HeldRepo {
    pub repo: String,
    pub holder: ChangeKey,
}

/// A run of a build that is live: the coordinator's key for it (a repository's name or `review`) and the run's id.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildRunRef {
    pub key: String,
    pub run: String,
}

/// Which preview of a build is being opened; the run-spec it lists is the one the start composes.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "kebab-case"))]
pub enum BuildPreviewKind {
    Start,
    ContinueAll,
    ContinueOne,
    Round,
    ManualReview,
}

/// One folder a build runs in, with the run-spec its run starts with: a product repository, or, with `repo`
/// none, the master repository for the review.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildSection {
    pub title: String,
    pub repo: Option<String>,
    pub spec: RunSpec,
}

/// The latest review as the build page lists it: the Review group's rows, and the round dialog's groups.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ReviewView {
    pub rows: round::ReviewRows,
    pub groups: Vec<round::RoundGroup>,
}

/// What starting or continuing a build came to.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
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
    /// A team hook or the plugin's own step failed: a failure of the work, with the hook's output.
    Failed {
        problems: Vec<String>,
        hook: Option<HookFailure>,
    },
    /// The machine could not run the plugin's step; `repo` is the repository the plugin names, if any.
    CouldNotRun {
        output: String,
        repo: Option<String>,
    },
    /// The engineer stopped the preparation; nothing was launched. `prepared` names the repositories the
    /// plugin had prepared before the stop, in plan order.
    Stopped { prepared: Vec<String> },
}

/// A change's build state, announced on [`BUILD_EVENT`].
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildEvent {
    pub change: ChangeKey,
    pub state: BuildState,
    /// The repositories another change holds that keep the review from starting; empty when it is not waiting.
    pub review_waiting: Vec<HeldRepo>,
    /// The runs of the build that are live, each with its run's id once the launch has answered.
    pub runs: Vec<BuildRunRef>,
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
    /// The id of the run's transcript in the history (the file stem), when the run wrote one.
    pub history_id: Option<String>,
}

/// The id the Workbench's workspace list keeps `folder` under.
pub fn workspace_id_in_store(folder: &Path) -> Option<String> {
    let norm = |t: &str| {
        t.replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    let wanted = norm(&folder.display().to_string());
    kata_sdlc::store::load_workspaces()
        .into_iter()
        .find(|w| norm(&w.folder) == wanted)
        .map(|w| w.id)
}

/// The id of a run's transcript: the stem of the path in its first `transcript: <path>` log event.
pub fn transcript_run_id(events: &[Value]) -> Option<String> {
    events.iter().find_map(|e| {
        if e["type"] != "log" {
            return None;
        }
        let path = e["message"].as_str()?.strip_prefix("transcript: ")?.trim();
        let file = path.rsplit(['\\', '/']).next()?;
        let stem = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
        (!stem.is_empty()).then(|| stem.to_string())
    })
}

/// One run the coordinator asked for.
pub struct LaunchRequest {
    pub spec: RunSpec,
    pub lane: Lane,
    pub kind: runs::RunKind,
    /// The product repository of a build run.
    pub repo: Option<String>,
    /// The plan task the run is on; empty for a review or a round. Only the tests read it, to see which
    /// task the coordinator asked for.
    #[cfg_attr(not(test), allow(dead_code))]
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
    /// One program command that reads, as `Program::run`.
    fn run(&self, command: &[&str], place: &Place) -> Result<Value, ProgramError>;
    /// One long program step, as `Program::step_long`: no time limit, ended when the plugin answers or
    /// `token` is cancelled.
    fn step_long(
        &self,
        command: &[&str],
        place: &Place,
        token: &CancelToken,
        on_line: Option<LineSink>,
    ) -> Answer;
    /// Where `change` stands, read for that change alone; `None` when the plugin knows no such change.
    fn change_state(
        &self,
        place: &Place,
        system: &str,
        change: &str,
    ) -> Result<Option<ChangeState>, ProgramError>;
    /// The `master` of every change of `system` that lives in a copy and is not `change`.
    fn other_copies(
        &self,
        place: &Place,
        system: &str,
        change: &str,
    ) -> Result<Vec<PathBuf>, ProgramError>;
    /// The change's plan, as committed.
    fn plan(&self, place: &Place, state: &ChangeState) -> Result<ParsedPlan, String>;
    /// The change's committed review document, if it has one.
    fn review_record(
        &self,
        place: &Place,
        system: &str,
        state: &ChangeState,
    ) -> Result<Option<ReviewRecord>, String>;
    /// The id the Workbench keeps `folder` under, if it is one of its workspaces.
    fn workspace_id(&self, folder: &Path) -> Option<String>;
    /// Append task-to-run links to Kata's store.
    fn link_tasks(&self, links: &[kata_sdlc::store::TaskLink]) -> Result<(), String>;
    /// The commit a repository's `HEAD` is on.
    fn head(&self, dir: &Path) -> Result<String, String>;
}

/// What the host asks of the run table, the sidecar and the webview.
pub trait Launcher: Send + Sync {
    /// Start a run; the run id on success, why not on a refusal (for example a folder in use).
    fn launch(&self, request: LaunchRequest) -> Result<u64, String>;
    /// Ask a live run to stop.
    fn cancel(&self, run_id: u64);
    /// Announce a change's build state. Called under the host's lock, so it must not read the host.
    fn emit(&self, event: &BuildEvent);
    /// Announce the running changes. Called with no host lock held, so it may read the host.
    fn announce_running(&self);
}

/// [`Tools`] over one ai-sdlc program.
pub struct ProgramTools {
    program: Program,
    /// Whether the plugin can list changes (1.3.0 or later), so the copies come from the light list.
    lists: bool,
}

impl ProgramTools {
    pub fn new(program: Program, lists: bool) -> Self {
        ProgramTools { program, lists }
    }

    /// Every change of `system`, from the whole-system `state` read an older plugin needs.
    fn states(&self, place: &Place, system: &str) -> Result<Vec<ChangeState>, ProgramError> {
        let answer = self
            .program
            .run(&["state", "--json", "--system", system], place)?;
        Ok(read_state(answer)?.changes)
    }
}

impl Tools for ProgramTools {
    fn resolve(&self, workspace: &Path) -> Result<Place, ProgramError> {
        self.program.resolve(workspace)
    }

    fn run(&self, command: &[&str], place: &Place) -> Result<Value, ProgramError> {
        self.program.run(command, place)
    }

    fn step_long(
        &self,
        command: &[&str],
        place: &Place,
        token: &CancelToken,
        on_line: Option<LineSink>,
    ) -> Answer {
        self.program.step_long(command, place, token, on_line)
    }

    fn change_state(
        &self,
        place: &Place,
        system: &str,
        change: &str,
    ) -> Result<Option<ChangeState>, ProgramError> {
        state::one(&self.program, place, system, change)
    }

    fn other_copies(
        &self,
        place: &Place,
        system: &str,
        change: &str,
    ) -> Result<Vec<PathBuf>, ProgramError> {
        if self.lists {
            let list = self.program.list(place, system)?;
            return Ok(list
                .changes
                .iter()
                .filter(|c| c.in_copy && c.change != change)
                .map(|c| PathBuf::from(&c.master))
                .collect());
        }
        Ok(self
            .states(place, system)?
            .iter()
            .filter(|s| s.in_copy && s.change != change)
            .map(|s| PathBuf::from(&s.master))
            .collect())
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

    fn workspace_id(&self, folder: &Path) -> Option<String> {
        workspace_id_in_store(folder)
    }
    fn link_tasks(&self, links: &[kata_sdlc::store::TaskLink]) -> Result<(), String> {
        kata_sdlc::store::append_task_links(links).map_err(|e| e.to_string())
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

/// The runs of a build that are live and whose launch has answered, in the order they were asked for.
fn live_runs(build: &Build) -> Vec<BuildRunRef> {
    build
        .live
        .values()
        .filter_map(|r| {
            r.run_id.map(|id| BuildRunRef {
                key: r.key.clone(),
                run: id.to_string(),
            })
        })
        .collect()
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
    emitted: Option<(BuildState, Vec<HeldRepo>, Vec<BuildRunRef>)>,
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
    /// The last start of each change that another change held, with when; cleared when the change
    /// is started again and gets its repositories.
    held_starts: HashMap<ChangeKey, (Vec<HeldRepo>, u64)>,
    next_generation: u64,
    /// The Workbench is closing: no run of any change is launched any more.
    stopped: bool,
}

pub struct BuildHost {
    tools: Arc<dyn Tools>,
    launcher: Arc<dyn Launcher>,
    workbench_dir: PathBuf,
    /// The long steps that are running: a build's preparation is one entry of it.
    steps: StepTable,
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

/// Why nothing starts while the Workbench is closing.
const CLOSING: &str = "The Workbench is closing.";

fn closing() -> StartOutcome {
    StartOutcome::CouldNotRun {
        output: CLOSING.into(),
        repo: None,
    }
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
        repo: None,
    }
}

/// What a step of the plugin that did not pass came to, as `ai_sdlc::answer_of` read it; None when it
/// passed. `prepared` names the repositories already prepared, for a call that was stopped.
fn failure(outcome: StepOutcome, prepared: &[String]) -> Option<StartOutcome> {
    match outcome {
        StepOutcome::Passed { .. } => None,
        StepOutcome::Refused { problems } => Some(StartOutcome::Refused { problems }),
        StepOutcome::Failed { problems, hook } => Some(StartOutcome::Failed { problems, hook }),
        StepOutcome::CouldNotRun { reason, repo, hook } => Some(StartOutcome::CouldNotRun {
            output: match hook.map(|h| h.output) {
                Some(output) if !output.trim().is_empty() => format!(
                    "{reason}
{output}"
                ),
                _ => reason,
            },
            repo,
        }),
        StepOutcome::Stopped => Some(StartOutcome::Stopped {
            prepared: prepared.to_vec(),
        }),
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
        steps: StepTable,
    ) -> Arc<BuildHost> {
        Arc::new(BuildHost {
            tools,
            launcher,
            workbench_dir,
            steps,
            inner: Mutex::new(Inner {
                builds: HashMap::new(),
                holds: HoldTable::default(),
                held_starts: HashMap::new(),
                next_generation: 0,
                stopped: false,
            }),
        })
    }

    /// Start `change`'s build: nothing starts unless every repository it needs is free and the
    /// plugin's `build.start` passes in all of them.
    pub fn start(self: &Arc<Self>, change: &ChangeRef, form: StartForm) -> StartOutcome {
        self.begin(change, Some(form), None, None, StepKind::PreparingBuild)
    }

    /// Continue `change`'s build in `repo` with the given items the engineer switched off in the preview
    /// (none: the build's own); a build with no live run is rebuilt from where the change stands.
    pub fn continue_with(
        self: &Arc<Self>,
        change: &ChangeRef,
        repo: &str,
        off: Option<Vec<String>>,
    ) -> StartOutcome {
        self.begin(change, None, Some(repo), off, StepKind::PreparingBuild)
    }

    /// Start a document run (intent, spec, plan, triage or fix) of an existing change: the change's
    /// master is its folder, the run claims the change's own lane and gets the deny rules of R19.1.
    pub fn change_run(
        &self,
        change: &ChangeRef,
        kind: runs::RunKind,
        form: RunForm,
    ) -> Result<u64, String> {
        if self.inner.lock().unwrap().stopped {
            return Err(CLOSING.into());
        }
        let spec = self.document_spec(change, kind, form)?;
        let key = key_of(change);
        self.launcher.launch(LaunchRequest {
            spec,
            lane: Lane::Change { key, build: false },
            kind,
            repo: None,
            task: String::new(),
            group: format!("document:{}/{}", change.system, change.change),
            ended: Box::new(|_| {}),
        })
    }

    /// The run-spec a document run of `change` would start with; nothing starts. It is the composition
    /// `change_run` launches, so a preview shows what the run will be.
    pub fn preview_change_run(
        &self,
        change: &ChangeRef,
        kind: runs::RunKind,
        form: RunForm,
    ) -> Result<RunSpec, String> {
        self.document_spec(change, kind, form)
    }

    /// The run-spec of a document run: the one place it is composed.
    fn document_spec(
        &self,
        change: &ChangeRef,
        kind: runs::RunKind,
        form: RunForm,
    ) -> Result<RunSpec, String> {
        let run_kind = match kind {
            runs::RunKind::Intent | runs::RunKind::Spec | runs::RunKind::Plan => RunKind::Document,
            runs::RunKind::Triage => RunKind::Triage,
            runs::RunKind::Fix => RunKind::Fix,
            other => return Err(format!("{other:?} is not a document run")),
        };
        // Everything is read before the run starts and under no lock.
        let place = self
            .tools
            .resolve(Path::new(&change.workspace))
            .map_err(|e| error_text(&e))?;
        let others = self
            .tools
            .other_copies(&place, &change.system, &change.change)
            .map_err(|e| error_text(&e))?;
        let state = self
            .tools
            .change_state(&place, &change.system, &change.change)
            .map_err(|e| error_text(&e))?
            .ok_or_else(|| format!("the plugin knows no change {}", change.change))?;
        let exec = Exec {
            place,
            system: change.system.clone(),
            change: change.change.clone(),
            last: None,
            system_repos: None,
        };
        let run_place = RunPlace {
            kind: run_kind,
            system: change.system.clone(),
            state,
            workspace: exec.place.workspace.clone(),
            checkout: exec.place.master.clone(),
            other_copies: others,
            system_repos: self.system_repos(&exec),
            workbench_dir: self.workbench_dir.clone(),
        };
        Ok(change_spec(&run_place, form))
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
    /// `off` is the given items the engineer switched off in the review's preview (none: the build's own).
    pub fn review_start_with(
        self: &Arc<Self>,
        change: &ChangeRef,
        off: Option<Vec<String>>,
    ) -> StartOutcome {
        let place = match self.tools.resolve(Path::new(&change.workspace)) {
            Ok(p) => p,
            Err(e) => return could_not_run(&e),
        };
        let key = key_of(change);
        let (snapshot, _) = match self.snapshot(&place, &change.system, &change.change) {
            Ok(s) => s,
            Err(output) => return StartOutcome::CouldNotRun { output, repo: None },
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
        let outcome = self.begin(change, None, None, off, StepKind::PreparingReview);
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

    /// Stop the host for closing the Workbench: no further run of any change is launched, and every
    /// build is cancelled. Not undone; the Workbench is closing.
    pub fn stop_all(self: &Arc<Self>) {
        let keys: Vec<ChangeKey> = {
            let mut guard = self.inner.lock().unwrap();
            guard.stopped = true;
            guard.builds.keys().cloned().collect()
        };
        for key in keys {
            self.drive(&key, None, Input::CancelAll);
        }
    }

    /// The runs of builds being launched that have no run id yet, for the close question: a launch that
    /// has not answered. A start still preparing its repositories is an entry of the step table.
    pub fn launching(&self) -> Vec<runs::Launching> {
        let inner = self.inner.lock().unwrap();
        let mut out: Vec<runs::Launching> = Vec::new();
        for (key, build) in &inner.builds {
            for run in build.live.values().filter(|r| r.run_id.is_none()) {
                let review = run.key == REVIEW;
                out.push(runs::Launching {
                    change: key.clone(),
                    kind: if review {
                        runs::RunKind::Review
                    } else {
                        runs::RunKind::Build
                    },
                    repo: (!review).then(|| run.key.clone()),
                });
            }
        }
        out
    }

    /// Stop every run of `change`'s build.
    pub fn cancel(self: &Arc<Self>, change: &ChangeRef) {
        self.drive(&key_of(change), None, Input::CancelAll);
    }

    /// Stop the run of one repository (or `review`) of `change`'s build and nothing else.
    pub fn cancel_run(self: &Arc<Self>, change: &ChangeRef, key: &str) {
        self.drive(
            &key_of(change),
            None,
            Input::Cancel {
                key: key.to_string(),
            },
        );
    }

    /// The runs of `change`'s build that are live, with the id of each once its launch has answered.
    pub fn runs(&self, change: &ChangeRef) -> Vec<BuildRunRef> {
        let inner = self.inner.lock().unwrap();
        inner
            .builds
            .get(&key_of(change))
            .map(live_runs)
            .unwrap_or_default()
    }

    /// The run-spec each run of a build preview would start with; nothing starts. The sections are the
    /// folders the kind runs in, and each spec is composed by the call a launch makes.
    pub fn preview_build(
        &self,
        change: &ChangeRef,
        which: BuildPreviewKind,
        repo: Option<&str>,
        form: &StartForm,
    ) -> Result<Vec<BuildSection>, String> {
        let place = self
            .tools
            .resolve(Path::new(&change.workspace))
            .map_err(|e| error_text(&e))?;
        let (snapshot, plan) = self.snapshot(&place, &change.system, &change.change)?;
        let master = master_name(&place);
        let rounds: Vec<String> = form.rounds.iter().map(|r| r.repo.clone()).collect();
        let review = || ("Review".to_string(), None::<String>);
        let folders: Vec<(String, Option<String>)> = match which {
            BuildPreviewKind::Start | BuildPreviewKind::ContinueAll => {
                needed_repos(&plan, &snapshot.state, &[], &master)
                    .into_iter()
                    .map(|r| (r.clone(), Some(r)))
                    .chain([review()])
                    .collect()
            }
            BuildPreviewKind::ContinueOne => match repo {
                Some(r) if r != REVIEW => vec![(r.to_string(), Some(r.to_string()))],
                _ => vec![review()],
            },
            BuildPreviewKind::Round => rounds
                .iter()
                .map(|r| (r.clone(), Some(r.clone())))
                .collect(),
            BuildPreviewKind::ManualReview => vec![review()],
        };
        let exec = Exec {
            place,
            system: change.system.clone(),
            change: change.change.clone(),
            last: Some(snapshot.clone()),
            system_repos: None,
        };
        let system_repos = self.system_repos(&exec);
        Ok(folders
            .into_iter()
            .map(|(title, repo)| {
                let key = repo.clone().unwrap_or_else(|| REVIEW.to_string());
                let instructions = form
                    .rounds
                    .iter()
                    .find(|r| r.repo == key)
                    .map(|r| r.instructions.clone())
                    .or_else(|| form.instructions.clone());
                let spec = self.build_spec(
                    &exec,
                    &snapshot,
                    &system_repos,
                    &key,
                    instructions,
                    BuildChoices {
                        timeout_secs: form.timeout_secs,
                        instructions: form.instructions.clone(),
                        continue_on_leftovers: form.continue_on_leftovers,
                    },
                    &form.off,
                );
                BuildSection { title, repo, spec }
            })
            .collect())
    }

    /// The run-spec of one run of a build: the one place it is composed, for a launch and for a preview.
    #[allow(clippy::too_many_arguments)]
    fn build_spec(
        &self,
        exec: &Exec,
        snapshot: &Snapshot,
        system_repos: &[String],
        launch_key: &str,
        instructions: Option<String>,
        choices: BuildChoices,
        off: &[String],
    ) -> RunSpec {
        let kind = if launch_key == REVIEW {
            RunKind::Review
        } else {
            RunKind::Build {
                repo: launch_key.to_string(),
            }
        };
        let place = RunPlace {
            kind,
            system: exec.system.clone(),
            state: snapshot.state.clone(),
            workspace: exec.place.workspace.clone(),
            checkout: exec.place.master.clone(),
            other_copies: snapshot.others.clone(),
            system_repos: system_repos.to_vec(),
            workbench_dir: self.workbench_dir.clone(),
        };
        let mut form = RunForm {
            name: String::new(),
            task: String::new(),
            bare: false,
            permission_mode: PermissionMode::Auto,
            timeout_secs: choices.timeout_secs,
            instructions: instructions.or(choices.instructions),
            continue_on_leftovers: choices.continue_on_leftovers,
            given: None,
        };
        let spec = change_spec(&place, form.clone());
        if off.is_empty() {
            return spec;
        }
        // A project item is switched off for the run in its own folder only, and the folder is the spec's.
        form.given = Some(given_for(off, &spec.workdir));
        change_spec(&place, form)
    }

    /// The latest review as the build page lists it: the Review group's rows in the build's repository
    /// order, and the round dialog's groups in the same order.
    pub fn review_view(&self, change: &ChangeRef) -> Result<ReviewView, String> {
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
        let rows = match &record {
            Some(r) => round::review_rows_in(r, &repos),
            None => round::rows_of(&[], &repos),
        };
        let offer = round::offer(record.as_ref(), &repos);
        let groups = round::round_groups(&offer, &rows);
        Ok(ReviewView { rows, groups })
    }

    /// Link the tasks a build run recorded to the run's transcript, in Kata's store. The host does it when
    /// the run ends, whether or not a page is open; a failed append is reported on stderr and changes nothing else.
    fn link_tasks_of(
        &self,
        key: &ChangeKey,
        repo: &str,
        place: &Place,
        logged_before: &BTreeSet<String>,
        end: &RunEnd,
    ) {
        let Some(run_id) = end.history_id.as_ref().filter(|_| repo != REVIEW) else {
            return;
        };
        let Ok(Some(state)) = self.tools.change_state(place, &key.system, &key.change) else {
            return;
        };
        let Some(workspace_id) = self.tools.workspace_id(&place.workspace) else {
            return;
        };
        let links: Vec<kata_sdlc::store::TaskLink> = state
            .tasks
            .iter()
            .flatten()
            .filter(|(r, _)| r.as_str() == repo)
            .flat_map(|(_, t)| t.logged.iter())
            .filter(|task| !logged_before.contains(*task))
            .map(|task| kata_sdlc::store::TaskLink {
                workspace_id: workspace_id.clone(),
                system: key.system.clone(),
                change: key.change.clone(),
                repo: repo.to_string(),
                task: task.clone(),
                run_id: run_id.clone(),
            })
            .collect();
        if links.is_empty() {
            return;
        }
        if let Err(e) = self.tools.link_tasks(&links) {
            eprintln!("could not link the tasks of {repo} to its run: {e}");
        }
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
        off: Option<Vec<String>>,
        kind: StepKind,
    ) -> StartOutcome {
        let place = match self.tools.resolve(Path::new(&change.workspace)) {
            Ok(p) => p,
            Err(e) => return could_not_run(&e),
        };
        let key = key_of(change);
        let (before, step) = {
            let guard = self.inner.lock().unwrap();
            let existing = guard.builds.get(&key);
            let live_build = existing.is_some_and(|b| !b.live.is_empty());
            let already = match only {
                None => live_build,
                Some(repo) => existing.is_some_and(|b| b.live.values().any(|r| r.key == repo)),
            };
            if guard.stopped {
                return closing();
            }
            if already {
                return StartOutcome::AlreadyRunning;
            }
            let before = Before {
                live_build,
                generation: existing.map(|b| b.generation),
                form: existing.map(|b| b.form.clone()),
                off,
            };
            // The change's long step: a second start, or any other step of the change, is refused as busy.
            let Ok(step) = self.steps.begin(key.clone(), kind) else {
                return StartOutcome::AlreadyRunning;
            };
            (before, step)
        };
        // The step's entry ends when `step` drops, after the build has begun.
        self.begin_marked(&place, change, &key, form, only, before, &step)
    }

    #[allow(clippy::too_many_arguments)]
    fn begin_marked(
        self: &Arc<Self>,
        place: &Place,
        change: &ChangeRef,
        key: &ChangeKey,
        form: Option<StartForm>,
        only: Option<&str>,
        before: Before,
        step: &StepGuard,
    ) -> StartOutcome {
        let Before {
            live_build,
            generation: existing_generation,
            form: existing_form,
            off,
        } = before;
        let mut form = form.or(existing_form).unwrap_or(StartForm {
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            instructions: None,
            continue_on_leftovers: false,
            rounds: Vec::new(),
            off: Vec::new(),
        });
        // The choices this start was given are the build's from now on.
        if let Some(off) = off {
            form.off = off;
        }
        let (snapshot, plan) = match self.snapshot(place, &change.system, &change.change) {
            Ok(s) => s,
            Err(output) => return StartOutcome::CouldNotRun { output, repo: None },
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
        let uncommitted = match self.prepare(place, change, &needed, step) {
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
        let others = self
            .tools
            .other_copies(place, system, change)
            .map_err(|e| error_text(&e))?;
        let state = self
            .tools
            .change_state(place, system, change)
            .map_err(|e| error_text(&e))?
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
    /// Whether the change has a preparation under way, which has taken the holds for the build it is
    /// about to begin.
    fn preparing(&self, key: &ChangeKey) -> bool {
        self.steps.running().iter().any(|s| {
            s.change == *key
                && matches!(s.kind, StepKind::PreparingBuild | StepKind::PreparingReview)
        })
    }

    /// Tell the page which repository the preparation is on, and give a sink that does the same for each hook
    /// line the plugin streams while it runs. `repo` is the repository of the call, which the lines never name.
    /// The step's own first label ("Checking every repository before building") went out when the step began, so
    /// the call that is for no repository says nothing more until a line arrives. The words are the step
    /// table's.
    fn announce(&self, key: &ChangeKey, repo: Option<&str>) -> LineSink {
        if repo.is_some() {
            self.steps.report(key, repo, None);
        }
        let (steps, key) = (self.steps.clone(), key.clone());
        let repo = repo.map(str::to_string);
        Arc::new(move |line: &str| {
            let Some(progress) = progress_of(line) else {
                return;
            };
            if progress.kind != StepProgressKind::Hook {
                return;
            }
            steps.report(&key, repo.as_deref(), Some(progress));
        })
    }

    fn prepare(
        &self,
        place: &Place,
        change: &ChangeRef,
        repos: &[String],
        step: &StepGuard,
    ) -> Result<BTreeMap<String, Vec<String>>, StartOutcome> {
        let key = key_of(change);
        let token = step.token();
        let stopped = |prepared: &[String]| StartOutcome::Stopped {
            prepared: prepared.to_vec(),
        };
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
        if token.is_cancelled() {
            return Err(stopped(&[]));
        }
        let sink = self.announce(&key, None);
        let answer = self.tools.step_long(&check, place, token, Some(sink));
        if let Some(outcome) = failure(answer.outcome, &[]) {
            return Err(outcome);
        }
        let mut prepared: Vec<String> = Vec::new();
        for repo in repos {
            if token.is_cancelled() {
                return Err(stopped(&prepared));
            }
            let mut command: Vec<&str> = base.to_vec();
            command.extend(["--repo", repo]);
            let sink = self.announce(&key, Some(repo));
            let answer = self.tools.step_long(&command, place, token, Some(sink));
            if let Some(outcome) = failure(answer.outcome, &prepared) {
                return Err(outcome);
            }
            prepared.push(repo.clone());
            let files = strings(&answer.json["details"]["uncommitted"]);
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
            let (commands, cancels, mut exec, emitted) = {
                let mut guard = self.inner.lock().unwrap();
                let Inner {
                    builds,
                    holds,
                    stopped,
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
                // Closing: whatever the coordinator would start next is not started.
                if *stopped {
                    commands.retain(|c| !matches!(c, Command::Launch { .. }));
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
                let announced = (state, build.review_waiting.clone(), live_runs(build));
                let emitted = build.emitted.as_ref() != Some(&announced);
                if emitted {
                    build.emitted = Some(announced.clone());
                    build.changed_ms = now_ms();
                    self.launcher.emit(&BuildEvent {
                        change: key.clone(),
                        state: announced.0.clone(),
                        review_waiting: announced.1,
                        runs: announced.2,
                    });
                }
                // A start under way has taken the holds for the build it is about to begin.
                if settled && build.live.is_empty() && !self.preparing(key) {
                    holds.release(key, Purpose::Build);
                }
                let exec = Exec {
                    place: build.ctx.place.clone(),
                    system: build.ctx.system.clone(),
                    change: build.ctx.change.clone(),
                    last: build.last.clone(),
                    system_repos: build.ctx.system_repos.clone(),
                };
                (commands, cancels, exec, emitted)
            };
            // The host's lock is released: announcing reads the host, so it cannot happen under it.
            if emitted {
                self.launcher.announce_running();
            }
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
        // The build's choices as they stand when the run starts.
        let off = self
            .inner
            .lock()
            .unwrap()
            .builds
            .get(key)
            .map(|b| b.form.off.clone())
            .unwrap_or_default();
        let spec = self.build_spec(
            exec,
            &snapshot,
            &exec.system_repos.clone().unwrap_or_default(),
            &launch_key,
            instructions,
            choices,
            &off,
        );
        // What the run records is what the build log gains while it runs.
        let logged_before: BTreeSet<String> = snapshot
            .state
            .tasks
            .iter()
            .flatten()
            .filter(|(repo, _)| **repo == launch_key)
            .flat_map(|(_, t)| t.logged.iter().cloned())
            .collect();
        let place = exec.place.clone();
        let host = Arc::clone(self);
        let ended_key = key.clone();
        let repo_key = launch_key.clone();
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
            ended: Box::new(move |end| {
                host.link_tasks_of(&ended_key, &repo_key, &place, &logged_before, &end);
                host.run_ended(&ended_key, generation, instance, end);
            }),
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
    /// The choices the start was given, which become the build's.
    off: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::steps::{StepEvent, StepKind};
    use kata_sdlc::ai_sdlc::StepProgressKind;
    use kata_sdlc::ai_sdlc::{answer_of, ExecError, Reply};
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
            off: Vec::new(),
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
        check: Mutex<Option<Result<Reply, String>>>,
        starts: Mutex<HashMap<String, Result<Reply, String>>>,
        calls: Mutex<Vec<Vec<String>>>,
        /// The next `states` call announces itself on `.0` and waits for `.1`.
        gate: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
        /// The task links the host recorded.
        links: Mutex<Vec<kata_sdlc::store::TaskLink>>,
        /// How long each long call takes.
        delay: Mutex<std::time::Duration>,
        /// What stops the call it names, `check` or a repository: `stop_in` stops during that call and
        /// the call ends only once the token is cancelled; `stop_after` stops once that call has passed.
        stop_in: Mutex<Option<String>>,
        stop_after: Mutex<Option<String>>,
        /// Stops the change under test, through the step table, as the page's Stop does.
        stopper: Mutex<Option<Box<dyn Fn() + Send>>>,
        /// Called at the start of every long call, to see what the host had registered by then.
        probe: Mutex<Option<Box<dyn Fn() + Send>>>,
        /// The stream lines a call prints, by call (`check` or a repository).
        lines: Mutex<HashMap<String, Vec<String>>>,
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
                links: Mutex::new(Vec::new()),
                delay: Mutex::new(std::time::Duration::ZERO),
                stop_in: Mutex::new(None),
                stop_after: Mutex::new(None),
                stopper: Mutex::new(None),
                probe: Mutex::new(None),
                lines: Mutex::new(HashMap::new()),
            })
        }

        fn stop_now(&self) {
            if let Some(stop) = self.stopper.lock().unwrap().as_ref() {
                stop();
            }
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
            *self.check.lock().unwrap() = Some(Ok(Reply::json(
                1,
                &json!({
                "event": "build.start", "check": true, "outcome": "refused",
                "problems": [problem], "refusing": [repo], "repos": []}),
            )));
        }

        fn check_cannot_run(&self, why: &str) {
            *self.check.lock().unwrap() = Some(Err(why.into()));
        }

        /// `repo`'s build start prints `answer` and exits with the code the plugin gives that outcome.
        fn start_answer(&self, repo: &str, answer: Value) {
            let code = match answer["outcome"].as_str() {
                Some("passed") => 0,
                Some("could-not-run") => 2,
                _ => 1,
            };
            self.starts
                .lock()
                .unwrap()
                .insert(repo.to_string(), Ok(Reply::json(code, &answer)));
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

    impl FakeTools {
        fn exec(&self, command: &[&str], _place: &Place) -> Result<Reply, String> {
            self.calls
                .lock()
                .unwrap()
                .push(command.iter().map(|s| s.to_string()).collect());
            let repos: Vec<String> = command
                .windows(2)
                .filter(|w| w[0] == "--repo")
                .map(|w| w[1].to_string())
                .collect();
            if command.contains(&"--check") {
                return match self.check.lock().unwrap().clone() {
                    Some(answer) => answer,
                    None => Ok(Reply::json(0, &passed_check(&repos))),
                };
            }
            match self.starts.lock().unwrap().get(&repos[0]).cloned() {
                Some(answer) => answer,
                None => Ok(Reply::json(0, &passed_start(&repos[0], &[]))),
            }
        }
    }

    impl Tools for FakeTools {
        fn step_long(
            &self,
            command: &[&str],
            place: &Place,
            token: &CancelToken,
            on_line: Option<LineSink>,
        ) -> Answer {
            let which = match command.iter().position(|a| *a == "--repo") {
                Some(at) if !command.contains(&"--check") => command[at + 1].to_string(),
                _ => "check".to_string(),
            };
            if token.is_cancelled() {
                return answer_of(Err(ExecError::Stopped));
            }
            if let Some(probe) = self.probe.lock().unwrap().as_ref() {
                probe();
            }
            if self.stop_in.lock().unwrap().as_deref() == Some(which.as_str()) {
                self.stop_now();
                let began = std::time::Instant::now();
                while !token.is_cancelled() {
                    assert!(
                        began.elapsed() < std::time::Duration::from_secs(60),
                        "the call named {which} was stopped but its token was never cancelled"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                return answer_of(Err(ExecError::Stopped));
            }
            let delay = *self.delay.lock().unwrap();
            std::thread::sleep(delay);
            let lines = self.lines.lock().unwrap().get(&which).cloned();
            if let (Some(sink), Some(lines)) = (&on_line, lines) {
                for line in lines {
                    sink(&line);
                }
            }
            let answer = answer_of(self.exec(command, place).map_err(ExecError::Machine));
            if self.stop_after.lock().unwrap().as_deref() == Some(which.as_str()) {
                self.stop_now();
            }
            answer
        }
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
            panic!("a step goes through exec: {command:?}")
        }
        fn change_state(
            &self,
            _place: &Place,
            _system: &str,
            change: &str,
        ) -> Result<Option<ChangeState>, ProgramError> {
            let gate = self.gate.lock().unwrap().take();
            if let Some((entered, release)) = gate {
                entered.send(()).unwrap();
                release.recv().unwrap();
            }
            Ok(self
                .states
                .lock()
                .unwrap()
                .iter()
                .find(|s| s.change == change)
                .cloned())
        }
        fn other_copies(
            &self,
            _place: &Place,
            _system: &str,
            change: &str,
        ) -> Result<Vec<PathBuf>, ProgramError> {
            Ok(self
                .states
                .lock()
                .unwrap()
                .iter()
                .filter(|s| s.in_copy && s.change != change)
                .map(|s| PathBuf::from(&s.master))
                .collect())
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
        fn workspace_id(&self, _folder: &Path) -> Option<String> {
            Some("ws-id".to_string())
        }
        fn link_tasks(&self, links: &[kata_sdlc::store::TaskLink]) -> Result<(), String> {
            self.links.lock().unwrap().extend_from_slice(links);
            Ok(())
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
        /// Set by a rig that makes announcing read the host, as the Workbench's does.
        host: Mutex<std::sync::Weak<BuildHost>>,
        announcements: std::sync::atomic::AtomicUsize,
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
        fn announce_running(&self) {
            let host = self.host.lock().unwrap().upgrade();
            if let Some(host) = host {
                host.views();
                self.announcements
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }

    impl FakeLauncher {
        /// The run ends with `exit`; `history_id` is the transcript the run wrote, if it wrote one.
        fn finish_with(&self, id: u64, exit: i32, history_id: Option<&str>) {
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
                history_id: history_id.map(str::to_string),
            });
        }

        /// The run ends with its exit code, the way the reader task reports it.
        fn finish(&self, id: u64, exit: i32) {
            self.finish_with(id, exit, None);
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
        steps: StepTable,
        /// Every progress report the step table sent to the page.
        labels: Arc<Mutex<Vec<StepEvent>>>,
    }

    /// A step table whose reports are kept.
    fn test_steps() -> (StepTable, Arc<Mutex<Vec<StepEvent>>>) {
        let labels: Arc<Mutex<Vec<StepEvent>>> = Arc::default();
        let sink = labels.clone();
        (
            StepTable::new(Arc::new(move |e| sink.lock().unwrap().push(e))),
            labels,
        )
    }

    fn fake_place() -> Place {
        Place {
            master: PathBuf::from("D:/ws/ai-sdlc"),
            workspace: PathBuf::from(WS),
        }
    }

    fn rig_with(tools: Arc<FakeTools>) -> Rig {
        let launcher = Arc::new(FakeLauncher::default());
        let (steps, labels) = test_steps();
        let host = BuildHost::new(
            tools.clone(),
            launcher.clone(),
            PathBuf::from("D:/wb"),
            steps.clone(),
        );
        Rig {
            tools,
            launcher,
            host,
            steps,
            labels,
        }
    }

    fn rig() -> Rig {
        rig_with(FakeTools::new(fake_place()))
    }

    /// A rig whose launcher reads the host when it announces, as the Workbench's does.
    fn rig_reading_host() -> Rig {
        let r = rig();
        *r.launcher.host.lock().unwrap() = Arc::downgrade(&r.host);
        r
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

    // R1.1
    #[test]
    fn a_build_starts_when_announcing_reads_the_host() {
        let r = rig_reading_host();
        r.simple("A", &["kata"]);
        let (tx, rx) = std::sync::mpsc::channel();
        let host = r.host.clone();
        std::thread::spawn(move || {
            let _ = tx.send(host.start(&cref("A"), form()));
        });
        let outcome = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the build start never returned: announcing deadlocked on the host's lock");
        assert!(matches!(outcome, StartOutcome::Started { .. }));
        assert!(!r.launcher.events.lock().unwrap().is_empty());
        assert!(
            r.launcher
                .announcements
                .load(std::sync::atomic::Ordering::SeqCst)
                >= 1
        );
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
                    output: "ai-sdlc needs Node.js 22.18 or later".into(),
                    repo: None
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
        // F3: the plugin prints its could-not-run answer and exits 2; its reason and repository are shown.
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
                    output: "git failed".into(),
                    repo: Some("kata".into())
                }
            );
            assert_eq!(r.tools.real_starts("A"), ["kata"]);
            assert_eq!(r.launcher.count(), 0);
        }
        // F10: a team hook marked to stop fails; the engineer sees the hook's failure and its output.
        {
            let r = rig();
            r.simple("A", &["kata", "bob"]);
            r.tools.start_answer(
                "bob",
                json!({"event": "build.start", "repo": "bob", "outcome": "failed",
                    "problems": ["hook deps failed with exit code 1"], "hooks": [],
                    "failed": {"id": "deps", "onFailure": "stop", "output": "npm ci: lockfile out of date"}, "details": {}}),
            );
            assert_eq!(
                r.host.start(&cref("A"), form()),
                StartOutcome::Failed {
                    problems: strs(&["hook deps failed with exit code 1"]),
                    hook: Some(HookFailure {
                        id: "deps".into(),
                        on_failure: Some("stop".into()),
                        output: "npm ci: lockfile out of date".into()
                    })
                }
            );
            assert_eq!(r.launcher.count(), 0);
            assert_eq!(r.holder("kata"), None);
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
        let outcome = r.host.continue_with(&cref("A"), "kata", None);
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
            r.host.continue_with(&cref("A"), "kata", None),
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
            given: None,
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
            r.host.review_start_with(&cref("A"), None),
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
                r.host.review_start_with(&cref("A"), None),
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
                r.host.review_start_with(&cref("A"), None),
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
                r.host.review_start_with(&cref("A"), None),
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
        // A round with nothing picked is blocked with the plan's reason, which the dialog shows; nothing starts.
        assert_eq!(
            r.host
                .round_plan(&cref("A"), &RoundPicks::default())
                .unwrap()
                .blocked
                .as_deref(),
            Some("Pick a finding or write a note.")
        );
        assert_eq!(r.launcher.count(), 0);
        // The page starts the round through a build start carrying the plan's requests; it launches exactly those.
        let mut started = form();
        started.rounds = shown.requests.clone();
        assert!(matches!(
            r.host.start(&cref("A"), started),
            StartOutcome::Started { .. }
        ));
        let launched = r.launcher.launched("kata");
        assert_eq!(launched.len(), shown.requests.len());
        assert!(r
            .launcher
            .spec_of(launched[0])
            .contains("Fix these findings from review 1"));
    }

    fn run_form(task: &str) -> RunForm {
        RunForm {
            name: "sdlc-demo-B-spec".into(),
            task: task.into(),
            bare: false,
            permission_mode: PermissionMode::Auto,
            timeout_secs: 900,
            instructions: None,
            continue_on_leftovers: false,
            given: None,
        }
    }

    // R11.1: one repository's cancel reaches that repository's run alone.
    #[test]
    fn cancelling_one_repository_stops_only_its_run() {
        let r = rig();
        r.simple("A", &["kata", "bob"]);
        assert!(matches!(
            r.host.start(&cref("A"), form()),
            StartOutcome::Started { .. }
        ));
        let kata = r.launcher.launched("kata")[0];
        let bob = r.launcher.launched("bob")[0];
        r.host.cancel_run(&cref("A"), "kata");
        assert_eq!(*r.launcher.cancelled.lock().unwrap(), vec![kata]);
        assert!(!r.launcher.cancelled.lock().unwrap().contains(&bob));
    }

    // R16.1: closing stops the build host first. A run the close cancels ends with exit 130; the
    // coordinator would read the state and launch the repository that was waiting on it, a run the close
    // never named. Stopped, the host launches nothing more for any change, and a new start launches nothing.
    #[test]
    fn closing_stops_the_build_host_so_nothing_more_launches() {
        let r = rig();
        r.change(
            "A",
            &[("kata", &["T1"], &[]), ("bob", &["T2"], &[])],
            &[("T1", "kata", &[]), ("T2", "bob", &["T1"])],
        );
        r.simple("B", &["api"]);
        r.host.start(&cref("A"), form());
        let kata = r.launcher.launched("kata")[0];
        // kata recorded T1 just before the close, so bob is ready.
        r.tools.log("A", "kata", "T1");
        r.host.stop_all();
        assert_eq!(
            *r.launcher.cancelled.lock().unwrap(),
            vec![kata],
            "stopping the host cancels the build's live run"
        );
        r.launcher.finish(kata, 130);
        assert!(
            r.launcher.launched("bob").is_empty(),
            "no follow-on repository is launched while closing"
        );
        assert!(r.launcher.reviews().is_empty(), "no review is launched");
        r.host.start(&cref("B"), form());
        assert_eq!(
            r.launcher.count(),
            1,
            "a start after the stop launches nothing"
        );
    }

    // R9.1: a build whose preparation is under way is an entry of the step table, which the close question
    // reads; `launching` lists only the runs whose launch has not answered. Once its run has an id, the
    // build is neither.
    #[test]
    fn a_build_being_prepared_is_a_step_not_a_launch() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let r = rig();
        r.simple("A", &["kata"]);
        let (entered_tx, entered_rx) = channel();
        let (release_tx, release_rx) = channel();
        *r.tools.gate.lock().unwrap() = Some((entered_tx, release_rx));
        let host = r.host.clone();
        let starting = std::thread::spawn(move || host.start(&cref("A"), form()));
        entered_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("A's start reached the plugin");
        assert!(r.host.launching().is_empty());
        let running = r.steps.running();
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].change, key("A"));
        assert_eq!(running[0].kind, StepKind::PreparingBuild);
        release_tx.send(()).unwrap();
        assert!(matches!(
            starting.join().unwrap(),
            StartOutcome::Started { .. }
        ));
        assert_eq!(r.launcher.launched("kata").len(), 1);
        assert!(r.host.launching().is_empty());
        assert!(
            r.steps.running().is_empty(),
            "the entry ends with the start"
        );
    }

    impl Rig {
        /// Records, at every long call, the kinds of step the table held.
        fn probe_steps(&self) -> Arc<Mutex<Vec<Vec<StepKind>>>> {
            let seen: Arc<Mutex<Vec<Vec<StepKind>>>> = Arc::default();
            let (steps, sink) = (self.steps.clone(), seen.clone());
            *self.tools.probe.lock().unwrap() = Some(Box::new(move || {
                let kinds = steps.running().iter().map(|s| s.kind).collect();
                sink.lock().unwrap().push(kinds);
            }));
            seen
        }

        /// `stop_in` and `stop_after` stop `change` through the step table, as the page's Stop does.
        fn arm_stop(&self, change: &str) {
            let steps = self.steps.clone();
            let change = key(change);
            *self.tools.stopper.lock().unwrap() = Some(Box::new(move || {
                steps.stop(&change);
            }));
        }
    }

    // R12.1
    #[test]
    fn a_slow_preparation_is_not_cut_off() {
        let r = rig();
        r.simple("A", &["kata"]);
        *r.tools.delay.lock().unwrap() = std::time::Duration::from_secs(2);
        let seen = r.probe_steps();
        assert!(matches!(
            r.host.start(&cref("A"), form()),
            StartOutcome::Started { .. }
        ));
        assert_eq!(
            *seen.lock().unwrap(),
            vec![vec![StepKind::PreparingBuild]; 2],
            "the check and the repository both ran as the change's preparation step"
        );
        assert_eq!(r.tools.real_starts("A"), ["kata"]);
        assert_eq!(r.launcher.launched("kata").len(), 1);
    }

    // R6.1
    #[test]
    fn stopping_a_preparation_starts_nothing_and_frees_the_holds() {
        let r = rig();
        r.simple("A", &["kata", "bob"]);
        r.simple("B", &["kata"]);
        r.arm_stop("A");
        *r.tools.stop_in.lock().unwrap() = Some("check".into());
        assert_eq!(
            r.host.start(&cref("A"), form()),
            StartOutcome::Stopped {
                prepared: Vec::new()
            }
        );
        assert!(r.tools.real_starts("A").is_empty());
        assert_eq!(r.launcher.count(), 0, "no run was launched");
        assert_eq!(r.holder("kata"), None);
        assert_eq!(r.holder("bob"), None);
        assert!(r.steps.running().is_empty());
        *r.tools.stop_in.lock().unwrap() = None;
        assert!(
            matches!(
                r.host.start(&cref("B"), form()),
                StartOutcome::Started { .. }
            ),
            "another change takes the repository"
        );
    }

    // R17.1, R6.1, R8.1: every row of the preparation's outcome table.
    #[test]
    fn a_preparation_stopped_partway_names_the_prepared_repositories() {
        struct Row {
            label: &'static str,
            set: fn(&Rig),
            want: StartOutcome,
            real_starts: &'static [&'static str],
            launched: usize,
            held: bool,
        }
        let failed_hook = HookFailure {
            id: "deps".into(),
            on_failure: Some("stop".into()),
            output: "npm ci: lockfile out of date".into(),
        };
        let rows = vec![
            Row {
                label: "check passed, every repository passes",
                set: |_| {},
                want: StartOutcome::Started {
                    uncommitted: BTreeMap::new(),
                },
                real_starts: &["kata", "bob"],
                launched: 2,
                held: true,
            },
            Row {
                label: "check refused",
                set: |r| r.tools.refuse_check("bob", "bob is dirty"),
                want: StartOutcome::Refused {
                    problems: strs(&["bob is dirty"]),
                },
                real_starts: &[],
                launched: 0,
                held: false,
            },
            Row {
                label: "check failed",
                set: |r| {
                    *r.tools.check.lock().unwrap() = Some(Ok(Reply::json(
                        1,
                        &json!({"event": "build.start", "check": true, "outcome": "failed",
                            "problems": ["hook deps failed with exit code 1"], "hooks": [],
                            "failed": {"id": "deps", "onFailure": "stop", "output": "npm ci: lockfile out of date"},
                            "repos": []}),
                    )));
                },
                want: StartOutcome::Failed {
                    problems: strs(&["hook deps failed with exit code 1"]),
                    hook: Some(failed_hook),
                },
                real_starts: &[],
                launched: 0,
                held: false,
            },
            Row {
                label: "check could not run",
                set: |r| r.tools.check_cannot_run("no node"),
                want: StartOutcome::CouldNotRun {
                    output: "no node".into(),
                    repo: None,
                },
                real_starts: &[],
                launched: 0,
                held: false,
            },
            Row {
                label: "check stopped",
                set: |r| *r.tools.stop_in.lock().unwrap() = Some("check".into()),
                want: StartOutcome::Stopped {
                    prepared: Vec::new(),
                },
                real_starts: &[],
                launched: 0,
                held: false,
            },
            Row {
                label: "repository 1 refused",
                set: |r| {
                    r.tools.start_answer(
                        "kata",
                        json!({"event": "build.start", "repo": "kata", "outcome": "refused", "problems": ["kata changed"], "details": null}),
                    )
                },
                want: StartOutcome::Refused {
                    problems: strs(&["kata changed"]),
                },
                real_starts: &["kata"],
                launched: 0,
                held: false,
            },
            Row {
                label: "repository 2 failed",
                set: |r| {
                    r.tools.start_answer(
                        "bob",
                        json!({"event": "build.start", "repo": "bob", "outcome": "failed",
                            "problems": ["hook deps failed with exit code 1"], "hooks": [],
                            "failed": {"id": "deps", "onFailure": "stop", "output": "npm ci: lockfile out of date"}, "details": {}}),
                    )
                },
                want: StartOutcome::Failed {
                    problems: strs(&["hook deps failed with exit code 1"]),
                    hook: Some(HookFailure {
                        id: "deps".into(),
                        on_failure: Some("stop".into()),
                        output: "npm ci: lockfile out of date".into(),
                    }),
                },
                real_starts: &["kata", "bob"],
                launched: 0,
                held: false,
            },
            Row {
                label: "repository 1 could not run",
                set: |r| {
                    r.tools.start_answer(
                        "kata",
                        json!({"event": "build.start", "repo": "kata", "outcome": "could-not-run", "problems": ["git failed"], "details": null}),
                    )
                },
                want: StartOutcome::CouldNotRun {
                    output: "git failed".into(),
                    repo: Some("kata".into()),
                },
                real_starts: &["kata"],
                launched: 0,
                held: false,
            },
            Row {
                label: "repository 1 stopped",
                set: |r| *r.tools.stop_in.lock().unwrap() = Some("kata".into()),
                want: StartOutcome::Stopped {
                    prepared: Vec::new(),
                },
                real_starts: &[],
                launched: 0,
                held: false,
            },
            Row {
                label: "repository 2 stopped",
                set: |r| *r.tools.stop_in.lock().unwrap() = Some("bob".into()),
                want: StartOutcome::Stopped {
                    prepared: strs(&["kata"]),
                },
                real_starts: &["kata"],
                launched: 0,
                held: false,
            },
            Row {
                label: "token cancelled between the check and repository 1",
                set: |r| *r.tools.stop_after.lock().unwrap() = Some("check".into()),
                want: StartOutcome::Stopped {
                    prepared: Vec::new(),
                },
                real_starts: &[],
                launched: 0,
                held: false,
            },
            Row {
                label: "token cancelled between repository 1 and repository 2",
                set: |r| *r.tools.stop_after.lock().unwrap() = Some("kata".into()),
                want: StartOutcome::Stopped {
                    prepared: strs(&["kata"]),
                },
                real_starts: &["kata"],
                launched: 0,
                held: false,
            },
        ];
        for row in rows {
            let r = rig();
            r.simple("A", &["kata", "bob"]);
            r.arm_stop("A");
            (row.set)(&r);
            assert_eq!(r.host.start(&cref("A"), form()), row.want, "{}", row.label);
            assert_eq!(r.tools.real_starts("A"), row.real_starts, "{}", row.label);
            assert_eq!(r.launcher.count(), row.launched, "{}", row.label);
            let holder = if row.held { Some(key("A")) } else { None };
            assert_eq!(r.holder("kata"), holder, "{}: kata", row.label);
            assert_eq!(r.holder("bob"), holder, "{}: bob", row.label);
        }
    }

    // R15.1
    #[test]
    fn preparation_labels_name_repo_and_check() {
        let r = rig();
        r.simple("A", &["kata", "bob"]);
        let hook = |t: &str, outcome: Option<&str>| {
            let mut line = json!({"type": t, "id": "base-tests"});
            if let Some(o) = outcome {
                line["outcome"] = json!(o);
            }
            line.to_string()
        };
        r.tools.lines.lock().unwrap().insert(
            "check".into(),
            vec![hook("hook-start", None), "not json".into()],
        );
        r.tools.lines.lock().unwrap().insert(
            "kata".into(),
            vec![hook("hook-start", None), hook("hook-end", Some("passed"))],
        );
        assert!(matches!(
            r.host.start(&cref("A"), form()),
            StartOutcome::Started { .. }
        ));
        let seen: Vec<(StepProgressKind, String, Option<String>, Option<String>)> = r
            .labels
            .lock()
            .unwrap()
            .iter()
            .map(|e| {
                assert_eq!(e.change, key("A"));
                assert_eq!(e.kind, StepKind::PreparingBuild);
                let p = e.progress.clone();
                (p.kind, p.label, p.repo, p.check)
            })
            .collect();
        let some = |s: &str| Some(s.to_string());
        let expected = vec![
            (
                StepProgressKind::Verifying,
                "Checking every repository before building".to_string(),
                None,
                None,
            ),
            (
                StepProgressKind::Hook,
                "Checking every repository before building: running base-tests".to_string(),
                None,
                some("base-tests"),
            ),
            (
                StepProgressKind::Repository,
                "Preparing kata".to_string(),
                some("kata"),
                None,
            ),
            (
                StepProgressKind::Hook,
                "Preparing kata: running base-tests".to_string(),
                some("kata"),
                some("base-tests"),
            ),
            (
                StepProgressKind::Hook,
                "Preparing kata: base-tests passed".to_string(),
                some("kata"),
                some("base-tests"),
            ),
            (
                StepProgressKind::Repository,
                "Preparing bob".to_string(),
                some("bob"),
                None,
            ),
        ];
        assert_eq!(seen, expected);
    }

    // R19.1
    #[test]
    fn preparation_does_not_use_the_build_limit() {
        let r = rig();
        r.simple("A", &["kata"]);
        *r.tools.delay.lock().unwrap() = std::time::Duration::from_secs(2);
        let mut short = form();
        short.timeout_secs = 1;
        let seen = r.probe_steps();
        assert!(matches!(
            r.host.start(&cref("A"), short),
            StartOutcome::Started { .. }
        ));
        assert_eq!(
            *seen.lock().unwrap(),
            vec![vec![StepKind::PreparingBuild]; 2],
            "preparation is the step with no limit of its own"
        );
        let spec: Value =
            serde_json::from_str(&r.launcher.spec_of(r.launcher.launched("kata")[0])).unwrap();
        assert_eq!(spec["leash"]["timeout_secs"], 1, "{spec}");
    }

    // The page learns which runs are the build's from the announcement, not from a launch of its own.
    #[test]
    fn a_build_announcement_names_the_live_runs() {
        let r = rig();
        r.simple("A", &["kata", "bob"]);
        r.host.start(&cref("A"), form());
        let kata = r.launcher.launched("kata")[0];
        let bob = r.launcher.launched("bob")[0];
        let live = vec![
            BuildRunRef {
                key: "bob".into(),
                run: bob.to_string(),
            },
            BuildRunRef {
                key: "kata".into(),
                run: kata.to_string(),
            },
        ];
        let mut named = r.host.runs(&cref("A"));
        named.sort_by(|a, b| a.key.cmp(&b.key));
        assert_eq!(named, live);
        let last = r.launcher.events.lock().unwrap().last().cloned().unwrap();
        let mut announced = last.runs.clone();
        announced.sort_by(|a, b| a.key.cmp(&b.key));
        assert_eq!(announced, live, "the announcement carries the run ids");
        r.launcher.finish(kata, 0);
        assert_eq!(
            r.host.runs(&cref("A")),
            vec![BuildRunRef {
                key: "bob".into(),
                run: bob.to_string()
            }]
        );
    }

    // The preview and the run are one computation (kata-architecture, section 2).
    #[test]
    fn a_document_preview_is_the_spec_the_run_starts_with() {
        let r = rig();
        r.simple("B", &["kata"]);
        let previewed = r
            .host
            .preview_change_run(
                &cref("B"),
                runs::RunKind::Spec,
                run_form("Use the ai-sdlc spec skill."),
            )
            .expect("the preview composes the spec");
        assert_eq!(r.launcher.count(), 0, "a preview starts nothing");
        let id = r
            .host
            .change_run(
                &cref("B"),
                runs::RunKind::Spec,
                run_form("Use the ai-sdlc spec skill."),
            )
            .unwrap();
        assert_eq!(
            r.launcher.spec_of(id),
            serde_json::to_string(&previewed).unwrap()
        );
        assert!(r
            .host
            .preview_change_run(&cref("B"), runs::RunKind::Build, run_form("x"))
            .is_err());
    }

    #[test]
    fn a_build_preview_lists_the_spec_each_run_starts_with() {
        let r = rig();
        r.simple("A", &["kata", "bob"]);
        let sections = r
            .host
            .preview_build(&cref("A"), BuildPreviewKind::Start, None, &form())
            .expect("the preview composes the specs");
        assert_eq!(r.launcher.count(), 0, "a preview starts nothing");
        let named: Vec<(String, Option<String>)> = sections
            .iter()
            .map(|s| (s.title.clone(), s.repo.clone()))
            .collect();
        assert_eq!(
            named,
            vec![
                ("kata".to_string(), Some("kata".to_string())),
                ("bob".to_string(), Some("bob".to_string())),
                ("Review".to_string(), None),
            ]
        );
        r.host.start(&cref("A"), form());
        for section in sections.iter().filter(|s| s.repo.is_some()) {
            let repo = section.repo.as_deref().unwrap();
            let run = r.launcher.launched(repo)[0];
            assert_eq!(
                r.launcher.spec_of(run),
                serde_json::to_string(&section.spec).unwrap(),
                "the {repo} section is the spec its run started with"
            );
        }
    }

    #[test]
    fn a_build_preview_lists_the_folders_its_kind_runs_in() {
        let r = rig();
        r.simple("A", &["kata", "bob"]);
        let titles = |which, repo: Option<&str>, f: &StartForm| -> Vec<String> {
            r.host
                .preview_build(&cref("A"), which, repo, f)
                .unwrap()
                .iter()
                .map(|s| s.title.clone())
                .collect()
        };
        assert_eq!(
            titles(BuildPreviewKind::ManualReview, None, &form()),
            vec!["Review"]
        );
        assert_eq!(
            titles(BuildPreviewKind::ContinueOne, Some("bob"), &form()),
            vec!["bob"]
        );
        assert_eq!(
            titles(BuildPreviewKind::ContinueOne, Some("review"), &form()),
            vec!["Review"]
        );
        let mut round = form();
        round.rounds = vec![RoundRequest {
            repo: "bob".into(),
            instructions: "Fix F1.".into(),
            summary: "bob".into(),
        }];
        assert_eq!(titles(BuildPreviewKind::Round, None, &round), vec!["bob"]);
        let sections = r
            .host
            .preview_build(&cref("A"), BuildPreviewKind::Round, None, &round)
            .unwrap();
        assert!(
            serde_json::to_string(&sections[0].spec)
                .unwrap()
                .contains("Fix F1."),
            "a round's section carries its instructions"
        );
    }

    // The build page's switched-off given items reach the previewed spec and the launched run alike.
    #[test]
    fn a_switched_off_item_is_off_in_the_preview_and_in_the_run() {
        let r = rig();
        r.simple("A", &["kata"]);
        let mut f = form();
        f.off = vec!["run-spec:skill:doc-writer".to_string()];
        let skills = |spec: &str| -> Value {
            serde_json::from_str::<Value>(spec).unwrap()["given"]["skills"].clone()
        };
        let sections = r
            .host
            .preview_build(&cref("A"), BuildPreviewKind::Start, None, &f)
            .unwrap();
        for s in &sections {
            assert_eq!(
                skills(&serde_json::to_string(&s.spec).unwrap()),
                json!(["run-spec:skill:doc-writer"]),
                "the {} section previews it off",
                s.title
            );
        }
        r.host.start(&cref("A"), f);
        let run = r.launcher.launched("kata")[0];
        assert_eq!(
            skills(&r.launcher.spec_of(run)),
            json!(["run-spec:skill:doc-writer"]),
            "the run starts with it off"
        );
        assert_eq!(
            r.launcher.spec_of(run),
            serde_json::to_string(&sections[0].spec).unwrap(),
            "and the preview is the spec the run started with"
        );
    }

    #[test]
    fn a_continue_and_a_manual_review_carry_the_choices_they_were_given() {
        let r = rig();
        r.simple("A", &["kata"]);
        let off = vec!["run-spec:skill:doc-writer".to_string()];
        r.host.continue_with(&cref("A"), "kata", Some(off.clone()));
        let run = r.launcher.launched("kata")[0];
        let given = |id| {
            serde_json::from_str::<Value>(&r.launcher.spec_of(id)).unwrap()["given"]["skills"]
                .clone()
        };
        assert_eq!(given(run), json!(["run-spec:skill:doc-writer"]));
        r.launcher.finish(run, 0);
        r.tools.log("A", "kata", "T1");
        r.host.review_start_with(&cref("A"), Some(Vec::new()));
        let review = r.launcher.reviews()[0];
        assert_eq!(given(review), json!([]), "a review's own choices apply");
    }

    // R13.5: the host keeps going with no page open, and the links are the host's to write.
    #[test]
    fn a_run_that_ends_with_no_page_leaves_its_task_links() {
        let r = rig();
        r.simple("A", &["kata", "bob"]);
        r.host.start(&cref("A"), form());
        let run = r.launcher.launched("kata")[0];
        r.tools.log("A", "kata", "T1");
        r.launcher
            .finish_with(run, 0, Some("sdlc-kata-build-20261101T180000Z"));
        assert_eq!(
            *r.tools.links.lock().unwrap(),
            vec![kata_sdlc::store::TaskLink {
                workspace_id: "ws-id".into(),
                system: SYSTEM.into(),
                change: "A".into(),
                repo: "kata".into(),
                task: "T1".into(),
                run_id: "sdlc-kata-build-20261101T180000Z".into(),
            }]
        );
    }

    #[test]
    fn a_run_that_wrote_no_transcript_links_nothing() {
        let r = rig();
        r.simple("A", &["kata"]);
        r.host.start(&cref("A"), form());
        let run = r.launcher.launched("kata")[0];
        r.tools.log("A", "kata", "T1");
        r.launcher.finish_with(run, 0, None);
        assert!(r.tools.links.lock().unwrap().is_empty());
    }

    #[test]
    fn the_transcript_of_a_run_is_the_stem_of_its_first_transcript_log() {
        let events = vec![
            json!({"type": "log", "level": "warn", "message": "other"}),
            json!({"type": "log", "level": "warn", "message": r"transcript: C:\Users\x\.kata\runs\abc-1.jsonl"}),
        ];
        assert_eq!(transcript_run_id(&events), Some("abc-1".to_string()));
        assert_eq!(transcript_run_id(&events[..1]), None);
    }

    // R18.1
    #[test]
    fn the_review_view_is_the_backends_order_counts_and_low_split() {
        use kata_sdlc::format::{ParsedFinding, Severity};
        let r = rig();
        r.complete("A", &["kata"]);
        let finding = |id: &str, severity: Severity, text: &str| ParsedFinding {
            id: id.into(),
            severity,
            file: "src/a.rs".into(),
            line: 3,
            text: text.into(),
            repo: Some("kata".into()),
            concern: None,
            rule: None,
        };
        let record = ReviewRecord {
            layout: 2,
            reviews: vec![ParsedReviewSection {
                number: 1,
                reviewed_at: "2026-11-01".into(),
                commits: BTreeMap::from([("kata".to_string(), "abc1234".to_string())]),
                findings: vec![
                    finding("F1", Severity::Low, "A nit."),
                    finding("F2", Severity::Medium, "A smell."),
                    finding("F3", Severity::High, "A bug."),
                ],
            }],
            problems: Vec::new(),
            master_moved: Vec::new(),
        };
        *r.tools.review.lock().unwrap() = Some(record.clone());
        let view = r.host.review_view(&cref("A")).unwrap();
        let repos = vec!["kata".to_string(), "ai-sdlc".to_string()];
        assert_eq!(view.rows, round::review_rows_in(&record, &repos));
        let group = &view.rows.groups[0];
        let keys: Vec<&str> = group.rows.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["F3", "F2"], "most serious first");
        assert_eq!(group.low.len(), 1, "the low finding is set apart");
        assert_eq!(view.rows.total, 3);
        assert_eq!(
            view.groups,
            round::round_groups(&r.host.round_offer(&cref("A")).unwrap(), &view.rows)
        );
        assert_eq!(
            r.host.review_view(&cref("A")).unwrap(),
            view,
            "the same on every read"
        );
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
        let outcome = r.host.continue_with(&cref("Y"), "kata", None);
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
                .step_long(
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
                    &kata_core::proc::CancelToken::new(),
                    None,
                )
                .json;
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
        fn step_long(
            &self,
            command: &[&str],
            place: &Place,
            token: &CancelToken,
            on_line: Option<LineSink>,
        ) -> Answer {
            self.real.step_long(command, place, token, on_line)
        }
        fn resolve(&self, workspace: &Path) -> Result<Place, ProgramError> {
            self.real.resolve(workspace)
        }
        fn run(&self, command: &[&str], place: &Place) -> Result<Value, ProgramError> {
            self.real.run(command, place)
        }
        fn change_state(
            &self,
            place: &Place,
            system: &str,
            change: &str,
        ) -> Result<Option<ChangeState>, ProgramError> {
            self.fake.change_state(place, system, change)
        }
        fn other_copies(
            &self,
            place: &Place,
            system: &str,
            change: &str,
        ) -> Result<Vec<PathBuf>, ProgramError> {
            self.fake.other_copies(place, system, change)
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
        fn workspace_id(&self, folder: &Path) -> Option<String> {
            self.fake.workspace_id(folder)
        }
        fn link_tasks(&self, links: &[kata_sdlc::store::TaskLink]) -> Result<(), String> {
            self.fake.link_tasks(links)
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
            real: ProgramTools::new(vendored(), true),
            fake: fake.clone(),
        });
        let launcher = Arc::new(FakeLauncher::default());
        let (steps, labels) = test_steps();
        let host = BuildHost::new(
            tools,
            launcher.clone(),
            PathBuf::from("D:/wb"),
            steps.clone(),
        );
        Rig {
            tools: fake,
            launcher,
            host,
            steps,
            labels,
        }
    }

    fn cref_in(real: &Real, change: &str) -> ChangeRef {
        ChangeRef {
            workspace: real.ws.display().to_string(),
            system: SYSTEM.into(),
            change: change.into(),
        }
    }

    /// The real program for the two reads the build makes of a change, with a plan from the fake.
    struct ReadsReal {
        real: ProgramTools,
        fake: Arc<FakeTools>,
    }

    impl Tools for ReadsReal {
        fn step_long(
            &self,
            command: &[&str],
            place: &Place,
            token: &CancelToken,
            on_line: Option<LineSink>,
        ) -> Answer {
            self.real.step_long(command, place, token, on_line)
        }
        fn resolve(&self, workspace: &Path) -> Result<Place, ProgramError> {
            self.real.resolve(workspace)
        }
        fn run(&self, command: &[&str], place: &Place) -> Result<Value, ProgramError> {
            self.real.run(command, place)
        }
        fn change_state(
            &self,
            place: &Place,
            system: &str,
            change: &str,
        ) -> Result<Option<ChangeState>, ProgramError> {
            self.real.change_state(place, system, change)
        }
        fn other_copies(
            &self,
            place: &Place,
            system: &str,
            change: &str,
        ) -> Result<Vec<PathBuf>, ProgramError> {
            self.real.other_copies(place, system, change)
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
        fn workspace_id(&self, folder: &Path) -> Option<String> {
            self.fake.workspace_id(folder)
        }
        fn link_tasks(&self, links: &[kata_sdlc::store::TaskLink]) -> Result<(), String> {
            self.fake.link_tasks(links)
        }
        fn head(&self, dir: &Path) -> Result<String, String> {
            self.fake.head(dir)
        }
    }

    /// The vendored program behind a script that appends each call's arguments to a log. Returns the
    /// program and the log's path.
    fn recording_program(dir: &Path) -> (Program, PathBuf) {
        let log = dir.join("calls.log");
        let script = dir.join("record.mjs");
        let source = r#"import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const log = LOG;
const entry = ENTRY;
const args = process.argv.slice(2);
appendFileSync(log, args.join(' ') + '\n');
const r = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
"#
        .replace(
            "LOG",
            &serde_json::to_string(&log.display().to_string()).unwrap(),
        )
        .replace(
            "ENTRY",
            &serde_json::to_string(&vendored().entry.display().to_string()).unwrap(),
        );
        std::fs::write(&script, source).unwrap();
        (
            Program {
                node: "node".into(),
                entry: script,
            },
            log,
        )
    }

    /// What `snapshot` of the first of two started changes reads, and the calls it made.
    fn snapshot_with(lists: bool) -> (Snapshot, Vec<String>, String) {
        let real = real_workspace(&["2026-11-01-a", "2026-11-02-b"]);
        let logs = tempfile::tempdir().unwrap();
        let (program, log) = recording_program(logs.path());
        let fake = FakeTools::new(real.place.clone());
        fake.plans
            .lock()
            .unwrap()
            .insert("2026-11-01-a".into(), plan(&[("T1", "kata", &[])]));
        let tools = Arc::new(ReadsReal {
            real: ProgramTools::new(program, lists),
            fake,
        });
        let host = BuildHost::new(
            tools,
            Arc::new(FakeLauncher::default()),
            PathBuf::from("D:/wb"),
            test_steps().0,
        );
        let (snapshot, _) = host.snapshot(&real.place, SYSTEM, "2026-11-01-a").unwrap();
        let calls = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .filter(|l| l.starts_with("list") || l.starts_with("state"))
            .map(str::to_string)
            .collect();
        (snapshot, calls, real.copies["2026-11-02-b"].clone())
    }

    // R4.3
    #[test]
    fn build_reads_its_change_and_the_light_list() {
        let (snapshot, calls, other) = snapshot_with(true);
        assert_eq!(snapshot.state.change, "2026-11-01-a");
        assert_eq!(snapshot.others, vec![PathBuf::from(other)]);
        assert_eq!(
            calls.iter().filter(|c| c.starts_with("list")).count(),
            1,
            "{calls:?}"
        );
        let states: Vec<&String> = calls.iter().filter(|c| c.starts_with("state")).collect();
        assert!(
            !states.is_empty() && states.iter().all(|c| c.contains("--change")),
            "{calls:?}"
        );
    }

    // R4.3
    #[test]
    fn an_older_plugin_reads_copies_from_state() {
        let (snapshot, calls, other) = snapshot_with(false);
        assert_eq!(snapshot.others, vec![PathBuf::from(other)]);
        assert!(!calls.iter().any(|c| c.starts_with("list")), "{calls:?}");
        assert!(
            calls
                .iter()
                .any(|c| c.starts_with("state --json --system") && !c.contains("--change")),
            "{calls:?}"
        );
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
