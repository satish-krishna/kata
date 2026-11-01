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
use kata_sdlc::round::RoundRequest;
use kata_sdlc::runspec::{change_spec, RunForm};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Channel every change of the build is announced on, one [`BuildEvent`] per event.
pub const BUILD_EVENT: &str = "sdlc://build";

/// The time limit of a run when a build is continued with nothing the engineer chose.
pub const DEFAULT_TIMEOUT_SECS: u64 = 3600;

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

/// One change's build.
struct Build {
    coord: Coordinator,
    ctx: Ctx,
    /// The live runs: coordinator instance to (launch key, run id).
    live: BTreeMap<u64, (String, u64)>,
    form: StartForm,
    last: Option<Snapshot>,
}

/// The coordinators and the holds, behind one lock.
struct Inner {
    builds: HashMap<ChangeKey, Build>,
    holds: HoldTable,
}

pub struct BuildHost {
    tools: Arc<dyn Tools>,
    launcher: Arc<dyn Launcher>,
    workbench_dir: PathBuf,
    inner: Mutex<Inner>,
}

fn key_of(change: &ChangeRef) -> ChangeKey {
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

    /// The build state of `change`, or none when this session hosts no build of it.
    pub fn state(&self, change: &ChangeRef) -> Option<BuildState> {
        let inner = self.inner.lock().unwrap();
        inner
            .builds
            .get(&key_of(change))
            .map(|b| b.coord.state().clone())
    }

    /// Stop every run of `change`'s build.
    pub fn cancel(self: &Arc<Self>, change: &ChangeRef) {
        let key = key_of(change);
        let mut guard = self.inner.lock().unwrap();
        self.drive(&mut guard, &key, Input::CancelAll);
    }

    /// A run of a build ended; called by the launcher once the run has left the run table.
    fn run_ended(self: &Arc<Self>, key: &ChangeKey, instance: u64, end: RunEnd) {
        let mut guard = self.inner.lock().unwrap();
        let Some((launch_key, _)) = guard
            .builds
            .get_mut(key)
            .and_then(|b| b.live.remove(&instance))
        else {
            return;
        };
        let input = Input::RunEnded {
            key: launch_key,
            instance,
            exit: end.exit,
            error: end.error,
            refused: false,
        };
        self.drive(&mut guard, key, input);
    }

    /// The decision of `sdlc_build_start` (`only` is none) and `sdlc_build_continue`.
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
        let mut guard = self.inner.lock().unwrap();
        let existing = guard.builds.get(&key);
        let live_build = existing.is_some_and(|b| !b.live.is_empty());
        let already = match only {
            None => live_build,
            Some(repo) => existing.is_some_and(|b| b.live.values().any(|(k, _)| k == repo)),
        };
        if already {
            return StartOutcome::AlreadyRunning;
        }
        let form = form
            .or_else(|| existing.map(|b| b.form.clone()))
            .unwrap_or(StartForm {
                timeout_secs: DEFAULT_TIMEOUT_SECS,
                instructions: None,
                continue_on_leftovers: false,
                rounds: Vec::new(),
            });
        let (snapshot, plan) = match self.snapshot(&place, &change.system, &change.change) {
            Ok(s) => s,
            Err(output) => return StartOutcome::CouldNotRun { output },
        };
        let master = master_name(&place);
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
        if let Err(held) = guard.holds.take(&key, Purpose::Build, &folders) {
            return StartOutcome::Held {
                held: held
                    .held
                    .into_iter()
                    .map(|(repo, holder)| HeldRepo { repo, holder })
                    .collect(),
            };
        }
        let uncommitted = match self.prepare(&place, change, &needed) {
            Ok(u) => u,
            Err(outcome) => {
                if !live_build {
                    guard.holds.release(&key, Purpose::Build);
                }
                return outcome;
            }
        };
        if !live_build {
            let heads = self.heads(&place, &snapshot.state);
            let currency = match self
                .tools
                .review_record(&place, &change.system, &snapshot.state)
            {
                Ok(Some(record)) => review::currency(&record, &heads),
                _ => ReviewCurrency::None,
            };
            guard.builds.insert(
                key.clone(),
                Build {
                    coord: Coordinator::new(currency, heads),
                    ctx: Ctx {
                        place,
                        system: change.system.clone(),
                        change: change.change.clone(),
                        system_repos: None,
                    },
                    live: BTreeMap::new(),
                    form: form.clone(),
                    last: Some(snapshot),
                },
            );
        }
        let build = guard.builds.get_mut(&key).expect("the build was just made");
        build.form = form.clone();
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
        self.drive(&mut guard, &key, input);
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

    /// Give the coordinator `first` and carry out what it asks until it asks for nothing more. The
    /// state is announced once, and the holds are released when the build has stopped with no run live.
    fn drive(self: &Arc<Self>, inner: &mut Inner, key: &ChangeKey, first: Input) {
        let Inner { builds, holds } = inner;
        let Some(build) = builds.get_mut(key) else {
            return;
        };
        let mut queue = VecDeque::from([first]);
        while let Some(input) = queue.pop_front() {
            for command in build.coord.step(input) {
                match command {
                    Command::ReadStatus => queue.push_back(self.read_status(build)),
                    Command::ReadHeads => {
                        let heads = build
                            .last
                            .as_ref()
                            .map(|s| self.heads(&build.ctx.place, &s.state))
                            .unwrap_or_default();
                        queue.push_back(Input::Heads(heads));
                    }
                    Command::Launch {
                        key: launch_key,
                        instance,
                        task,
                        instructions,
                        choices,
                        ..
                    } => {
                        let launched = Launching {
                            launch_key,
                            instance,
                            task,
                            instructions,
                            choices,
                        };
                        if let Some(failed) = self.launch(build, key, launched) {
                            queue.push_back(failed);
                        }
                    }
                    Command::CancelRun { instance, .. } => {
                        if let Some((_, run_id)) = build.live.get(&instance) {
                            self.launcher.cancel(*run_id);
                        }
                    }
                }
            }
        }
        let state = build.coord.state().clone();
        let settled = matches!(
            state.phase,
            BuildPhase::Stopped | BuildPhase::Finished | BuildPhase::Cancelled
        );
        self.launcher.emit(&BuildEvent {
            change: key.clone(),
            state,
        });
        if settled && build.live.is_empty() {
            holds.release(key, Purpose::Build);
        }
    }

    fn read_status(&self, build: &mut Build) -> Input {
        let ctx = &build.ctx;
        match self.snapshot(&ctx.place, &ctx.system, &ctx.change) {
            Ok((snapshot, plan)) => {
                let facts = BuildFacts::read(&plan, &snapshot.state, &master_name(&ctx.place));
                build.last = Some(snapshot);
                Input::Status(facts)
            }
            Err(_) => Input::StatusFailed,
        }
    }

    /// Start one run the coordinator asked for. A run that cannot start comes back as an ended run.
    fn launch(
        self: &Arc<Self>,
        build: &mut Build,
        key: &ChangeKey,
        asked: Launching,
    ) -> Option<Input> {
        let Launching {
            launch_key,
            instance,
            task,
            instructions,
            choices,
        } = asked;
        let refused = |why: String| {
            Some(Input::RunEnded {
                key: launch_key.clone(),
                instance,
                exit: None,
                error: Some(why),
                refused: true,
            })
        };
        let Some(snapshot) = build.last.clone() else {
            return refused("the change's state was not read".into());
        };
        if build.ctx.system_repos.is_none() {
            build.ctx.system_repos = Some(self.system_repos(&build.ctx));
        }
        let review = launch_key == "review";
        let kind = if review {
            RunKind::Review
        } else {
            RunKind::Build {
                repo: launch_key.clone(),
            }
        };
        let place = RunPlace {
            kind,
            system: build.ctx.system.clone(),
            state: snapshot.state,
            workspace: build.ctx.place.workspace.clone(),
            checkout: build.ctx.place.master.clone(),
            other_copies: snapshot.others,
            system_repos: build.ctx.system_repos.clone().unwrap_or_default(),
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
        let request = LaunchRequest {
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
            ended: Box::new(move |end| host.run_ended(&ended_key, instance, end)),
        };
        match self.launcher.launch(request) {
            Ok(run_id) => {
                build.live.insert(instance, (launch_key, run_id));
                None
            }
            Err(why) => refused(why),
        }
    }

    /// The folder names of the system's repositories as `change show` lists them (none when it cannot
    /// say), and the master.
    fn system_repos(&self, ctx: &Ctx) -> Vec<String> {
        let master = ctx.place.master.display().to_string();
        let workspace = ctx.place.workspace.display().to_string();
        let shown = self.tools.run(
            &[
                "change",
                "show",
                "--json",
                "--change",
                &ctx.change,
                "--master",
                &master,
                "--workspace",
                &workspace,
            ],
            &ctx.place,
        );
        let mut repos: Vec<String> = shown
            .ok()
            .and_then(|v| v["repos"].as_object().map(|o| o.keys().cloned().collect()))
            .unwrap_or_default();
        repos.push(master_name(&ctx.place));
        repos
    }
}

/// A `Launch` command, unpacked.
struct Launching {
    launch_key: String,
    instance: u64,
    task: String,
    instructions: Option<String>,
    choices: BuildChoices,
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
