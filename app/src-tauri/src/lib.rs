#![cfg_attr(test, allow(clippy::disallowed_methods))]
mod build_host;
mod close_guard;
mod history;
mod rename_change;
mod running;
mod runs;
mod sdlc_home;
mod sdlc_state;
mod start_change;
mod steps;
mod versions;
mod zoom;

use kata_core::catalog::{self, CatalogEntry};
use kata_core::given::{self, ResolveOptions, ResolveRoots, Resolved};
use kata_core::spec::{self, RunSpec};
use kata_sdlc as sdlc;
use runs::{LiveRun, RunTable};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Channel the engine's normalized KataEvents are relayed on to the webview.
const RUN_EVENT: &str = "kata://event";
/// Shared run control: every live run plus a monotonic id source. A stale
/// reader task (a finished run still tearing down) removes only its own id, so
/// it never clears a newer run's handle.
#[derive(Default)]
struct RunControl {
    state: Arc<Mutex<RunTable>>,
    next_id: AtomicU64,
}

/// Run ids cross the webview as strings; anything that is not one names no run.
fn parse_run_id(run_id: &str) -> Option<u64> {
    run_id.trim().parse().ok()
}

/// User skills/plugins plus the workdir's project scope (if any).
#[tauri::command]
fn catalog(workdir: Option<String>) -> Vec<CatalogEntry> {
    let roots = catalog::roots_for_workdir(workdir.as_deref());
    catalog::discover(&roots)
}

/// What the run would be given, resolved against the spec's own workdir. Holds
/// names only, never an environment value.
#[tauri::command]
fn preview_run(spec: RunSpec) -> Resolved {
    given::resolve(
        &spec,
        &ResolveRoots::for_spec(&spec),
        &ResolveOptions::from_spec(&spec),
    )
}

#[tauri::command]
fn load_spec(path: String) -> Result<RunSpec, String> {
    spec::load(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_spec(path: String, spec: RunSpec) -> Result<(), String> {
    spec::save(Path::new(&path), &spec).map_err(|e| e.to_string())
}

/// Returns the list of validation error strings (empty = valid).
#[tauri::command]
fn validate_spec(spec: RunSpec) -> Vec<String> {
    spec::validate(&spec).err().unwrap_or_default()
}

/// The lane a `group` stands for until the commands pass lanes directly: a
/// `build:<system>/<change>` group is a build run of that change, no group is a Workbench run.
fn lane_of(group: Option<&str>) -> runs::Lane {
    let Some((system, change)) = group
        .and_then(|g| g.strip_prefix("build:"))
        .and_then(|g| g.split_once('/'))
    else {
        return runs::Lane::Solo;
    };
    runs::Lane::Change {
        key: kata_sdlc::holds::ChangeKey {
            workspace: kata_sdlc::holds::RepoKey::of(Path::new("")),
            system: system.to_string(),
            change: change.to_string(),
        },
        build: true,
    }
}

/// Start a run: write the spec to a temp file, spawn `kata run` in the spec's
/// workdir as a sidecar, and relay its JSON-line KataEvents over `kata://event`.
/// Returns the run id once spawned; an async task drains stdout for the run's
/// lifetime. `group` (`build:<system>/<change>`) rides next to the spec, never
/// inside it, so the table can tell which runs belong to a build. Every relayed
/// event is wrapped as `{ runId, seq, event }`, `seq` being its position in the run, counted from 0.
#[tauri::command]
async fn run_spec(
    app: AppHandle,
    control: State<'_, RunControl>,
    history: State<'_, Arc<history::RunHistory>>,
    spec: RunSpec,
    group: Option<String>,
) -> Result<String, String> {
    // Refuse an old Claude Code before anything is claimed or spawned. The probe
    // blocks, so it runs off the async worker and ahead of the table lock.
    tauri::async_runtime::spawn_blocking(claude_ready)
        .await
        .map_err(|e| e.to_string())??;
    let lane = lane_of(group.as_deref());
    let kind = if lane == runs::Lane::Solo {
        runs::RunKind::Solo
    } else {
        runs::RunKind::Build
    };
    start_run(
        &app,
        &control,
        history.inner(),
        spec,
        group,
        lane,
        kind,
        None,
        None,
    )
}

/// Claim the spec's folder, spawn `kata run` for it and relay its events. `ended` is called once, after
/// the run has left the table, with how it ended; the build host uses it to carry on.
#[allow(clippy::too_many_arguments)]
fn start_run(
    app: &AppHandle,
    control: &RunControl,
    history: &Arc<history::RunHistory>,
    spec: RunSpec,
    group: Option<String>,
    lane: runs::Lane,
    kind: runs::RunKind,
    repo: Option<String>,
    ended: Option<Box<dyn FnOnce(build_host::RunEnd) + Send>>,
) -> Result<String, String> {
    // Hold the table across claim, spawn and insert so two starts cannot both
    // pass the claim.
    let mut table = control.state.lock().unwrap();
    table.claim(Path::new(&spec.workdir), &lane)?;

    // Each run gets a unique id so its reader task only ever touches its own temp
    // file and child handle. A new run can begin the moment a terminal event
    // reaches the UI, before this run's sidecar has finished tearing down.
    let id = control.next_id.fetch_add(1, Ordering::SeqCst) + 1;

    // The engine reads a spec file; serialize this one to a per-run temp path.
    let tmp = std::env::temp_dir().join(format!(
        "kata-workbench-run-{}-{}.toml",
        std::process::id(),
        id
    ));
    spec::save(&tmp, &spec).map_err(|e| e.to_string())?;

    let spawn_result = app.shell().sidecar("kata").and_then(|cmd| {
        // The Observe pane renders tool payloads, so the GUI always asks for them.
        cmd.args(["run", "--full-payloads", &tmp.to_string_lossy()])
            .current_dir(&spec.workdir) // engine discovers its catalog relative to cwd
            .spawn()
    });
    let (mut rx, child) = match spawn_result {
        Ok(pair) => pair,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("spawn kata: {e}"));
        }
    };

    let engine_pid = child.pid();
    let change_key = match &lane {
        runs::Lane::Change { key, .. } => Some(key.clone()),
        _ => None,
    };
    table.insert(LiveRun {
        id,
        workdir: std::path::PathBuf::from(&spec.workdir),
        kind,
        group,
        lane,
        repo,
        child: Some(child),
    });
    drop(table);
    let state = control.state.clone();
    let history = history.clone();
    let app = app.clone();
    announce_running(&app);

    tauri::async_runtime::spawn(async move {
        let mut terminal_seen = false;
        let mut end: Option<build_host::RunEnd> = None;
        let mut exit_code: Option<i32> = None;
        loop {
            let received = tokio::time::timeout(RELAY_TICK, rx.recv()).await;
            let (next, event) = match received {
                Ok(Some(CommandEvent::Terminated(payload))) => {
                    exit_code = Some(payload.code.unwrap_or(-1));
                    (Next::Ended, None)
                }
                Ok(Some(event)) => (Next::Event, Some(event)),
                Ok(None) => (Next::Ended, None),
                Err(_) => (Next::Silent, None),
            };
            let alive = match next {
                Next::Silent => kata_core::pid_alive(engine_pid),
                _ => true,
            };
            let step = relay_step(next, terminal_seen, alive);
            match step {
                Step::Wait => continue,
                Step::End { result } => {
                    if warns(next, &step) {
                        let ev = outlived_warning(id, engine_pid);
                        let seq = history.push(id, &ev);
                        // The in-memory history is gone after a restart, so the transcript keeps the evidence.
                        // Best-effort: a failure here never stops the run from ending.
                        let seen: Vec<Value> =
                            history.replay(id).into_iter().map(|e| e.event).collect();
                        if let Some(run_id) = build_host::transcript_run_id(&seen) {
                            let _ = kata_core::history::append_event(&run_id, &ev);
                        }
                        let _ = app.emit(RUN_EVENT, runs::wrap(id, seq, ev));
                    }
                    if !result {
                        let message = match exit_code {
                            Some(code) => format!("engine exited ({code}) without a result"),
                            None => "the engine exited without a result".to_string(),
                        };
                        end = Some(build_host::RunEnd {
                            exit: exit_code,
                            error: Some(message.clone()),
                            history_id: None,
                        });
                        let ev = json!({ "type": "run.error", "message": message });
                        let seq = history.push(id, &ev);
                        let _ = app.emit(RUN_EVENT, runs::wrap(id, seq, ev));
                    }
                    break;
                }
                Step::Relay => {}
            }
            let Some(event) = event else { continue };
            match event {
                CommandEvent::Stdout(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(v) => {
                        if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
                            if matches!(t, "run.completed" | "run.error" | "run.cancelled") {
                                terminal_seen = true;
                                let exit = v
                                    .get("exit_code")
                                    .and_then(Value::as_i64)
                                    .and_then(|c| i32::try_from(c).ok());
                                end = Some(build_host::RunEnd {
                                    exit,
                                    error: (t == "run.error").then(|| {
                                        v.get("message")
                                            .and_then(Value::as_str)
                                            .unwrap_or("the run failed")
                                            .to_string()
                                    }),
                                    history_id: None,
                                });
                            }
                        }
                        let seq = history.push(id, &v);
                        let announce = matches!(
                            v.get("type").and_then(Value::as_str),
                            Some(
                                "ask.requested"
                                    | "ask.answered"
                                    | "permission.requested"
                                    | "permission.decided"
                            )
                        );
                        let _ = app.emit(RUN_EVENT, runs::wrap(id, seq, v));
                        if announce {
                            announce_running(&app);
                        }
                    }
                    Err(_) => relay_log(&app, &history, id, &bytes),
                },
                CommandEvent::Stderr(bytes) => relay_log(&app, &history, id, &bytes),
                CommandEvent::Error(err) => {
                    terminal_seen = true;
                    end = Some(build_host::RunEnd {
                        exit: None,
                        error: Some(err.clone()),
                        history_id: None,
                    });
                    let ev = json!({ "type": "run.error", "message": err });
                    let seq = history.push(id, &ev);
                    let _ = app.emit(RUN_EVENT, runs::wrap(id, seq, ev));
                }
                _ => {}
            }
        }
        let _ = std::fs::remove_file(&tmp);
        // Remove only this run; a newer run keeps its own entry.
        state.lock().unwrap().remove(id);
        if let (Some(key), Some(marks)) =
            (&change_key, app.try_state::<Arc<running::OpenedMarks>>())
        {
            marks.ended(key);
        }
        if let Some(ended) = ended {
            let mut end = end.unwrap_or(build_host::RunEnd {
                exit: None,
                error: Some("the engine's output ended without a result".into()),
                history_id: None,
            });
            // The transcript the run wrote is where its tasks are linked to.
            let events: Vec<Value> = history.replay(id).into_iter().map(|e| e.event).collect();
            end.history_id = build_host::transcript_run_id(&events);
            // The host's work is blocking (it runs the plugin and takes locks).
            let _ = tauri::async_runtime::spawn_blocking(move || ended(end)).await;
        }
        // The run's last replay is taken; its events are in the transcript the engine wrote.
        history.finish(id);
        announce_running(&app);
    });

    Ok(id.to_string())
}

/// The running changes, computed from the run table, the builds, the histories and the opened marks.
fn running_strip(app: &AppHandle) -> running::RunningStrip {
    let live = app.state::<RunControl>().state.lock().unwrap().live();
    let builds = app
        .try_state::<Arc<build_host::BuildHost>>()
        .map(|h| h.views())
        .unwrap_or_default();
    let history = app.state::<Arc<history::RunHistory>>();
    let marks = app.state::<Arc<running::OpenedMarks>>();
    running::with_workspace_ids(
        running::entries(&live, &builds, &history, &marks),
        &sdlc::store::load_workspaces(),
    )
}

/// Tell the webview the running changes may have changed.
fn announce_running(app: &AppHandle) {
    if app.try_state::<Arc<running::OpenedMarks>>().is_some() {
        let _ = app.emit(running::RUNNING_EVENT, running_strip(app));
    }
}

/// The running changes: the first three and every one.
#[tauri::command]
fn sdlc_running(app: AppHandle) -> running::RunningStrip {
    running_strip(&app)
}

/// The engineer opened a change; it leaves the running changes once nothing of it needs them.
#[tauri::command]
fn sdlc_mark_opened(
    app: AppHandle,
    marks: State<Arc<running::OpenedMarks>>,
    change: build_host::ChangeRef,
) {
    marks.open(&build_host::key_of(&change));
    announce_running(&app);
}

/// Every event of a run from its start, in order, for a session opened after the run began.
#[tauri::command]
fn sdlc_run_history(
    history: State<Arc<history::RunHistory>>,
    run_id: String,
) -> Vec<history::HistoryEntry> {
    parse_run_id(&run_id)
        .map(|id| history.replay(id))
        .unwrap_or_default()
}

/// The ai-sdlc program of the plugin installed for `workspace`, as the build host asks for it.
struct PluginTools;

impl PluginTools {
    fn program(workspace: &Path) -> Result<build_host::ProgramTools, sdlc::ai_sdlc::ProgramError> {
        match state_inputs(&workspace.display().to_string()) {
            (Some(program), readiness) => Ok(build_host::ProgramTools::new(
                program,
                sdlc::plugin::lists_changes(&readiness),
            )),
            (None, sdlc::plugin::Readiness::Blocked { message, .. }) => {
                Err(sdlc::ai_sdlc::ProgramError::CouldNotRun { message })
            }
            (None, _) => Err(sdlc::ai_sdlc::ProgramError::CouldNotRun {
                message: "the ai-sdlc plugin cannot be used".into(),
            }),
        }
    }
}

impl build_host::Tools for PluginTools {
    fn resolve(
        &self,
        workspace: &Path,
    ) -> Result<sdlc::ai_sdlc::Place, sdlc::ai_sdlc::ProgramError> {
        Self::program(workspace)?.resolve(workspace)
    }
    fn run(
        &self,
        command: &[&str],
        place: &sdlc::ai_sdlc::Place,
    ) -> Result<Value, sdlc::ai_sdlc::ProgramError> {
        Self::program(&place.workspace)?.run(command, place)
    }
    fn step_long(
        &self,
        command: &[&str],
        place: &sdlc::ai_sdlc::Place,
        token: &kata_core::proc::CancelToken,
        on_line: Option<kata_core::proc::LineSink>,
    ) -> sdlc::ai_sdlc::Answer {
        match Self::program(&place.workspace) {
            Ok(tools) => tools.step_long(command, place, token, on_line),
            Err(e) => {
                sdlc::ai_sdlc::answer_of(Err(sdlc::ai_sdlc::ExecError::Machine(e.to_string())))
            }
        }
    }
    fn change_state(
        &self,
        place: &sdlc::ai_sdlc::Place,
        system: &str,
        change: &str,
    ) -> Result<Option<sdlc::ai_sdlc::state::ChangeState>, sdlc::ai_sdlc::ProgramError> {
        Self::program(&place.workspace)?.change_state(place, system, change)
    }
    fn other_copies(
        &self,
        place: &sdlc::ai_sdlc::Place,
        system: &str,
        change: &str,
    ) -> Result<Vec<std::path::PathBuf>, sdlc::ai_sdlc::ProgramError> {
        Self::program(&place.workspace)?.other_copies(place, system, change)
    }
    fn plan(
        &self,
        place: &sdlc::ai_sdlc::Place,
        state: &sdlc::ai_sdlc::state::ChangeState,
    ) -> Result<sdlc::format::ParsedPlan, String> {
        Self::program(&place.workspace)
            .map_err(|e| e.to_string())?
            .plan(place, state)
    }
    fn review_record(
        &self,
        place: &sdlc::ai_sdlc::Place,
        system: &str,
        state: &sdlc::ai_sdlc::state::ChangeState,
    ) -> Result<Option<sdlc::review::ReviewRecord>, String> {
        Self::program(&place.workspace)
            .map_err(|e| e.to_string())?
            .review_record(place, system, state)
    }
    fn workspace_id(&self, folder: &Path) -> Option<String> {
        build_host::workspace_id_in_store(folder)
    }
    fn link_tasks(&self, links: &[sdlc::store::TaskLink]) -> Result<(), String> {
        sdlc::store::append_task_links(links).map_err(|e| e.to_string())
    }
    fn head(&self, dir: &Path) -> Result<String, String> {
        sdlc::git::Repo::open(dir)
            .and_then(|r| r.head_sha())
            .map_err(|e| e.to_string())
    }
}

/// The run table, the sidecar and the webview, for the build host.
struct AppLauncher {
    app: AppHandle,
}

impl build_host::Launcher for AppLauncher {
    fn launch(&self, request: build_host::LaunchRequest) -> Result<u64, String> {
        claude_ready()?;
        let control = self.app.state::<RunControl>();
        let history = self.app.state::<Arc<history::RunHistory>>();
        start_run(
            &self.app,
            &control,
            history.inner(),
            request.spec,
            Some(request.group),
            request.lane,
            request.kind,
            request.repo,
            Some(request.ended),
        )?
        .parse()
        .map_err(|_| "the run id is not a number".to_string())
    }

    fn cancel(&self, run_id: u64) {
        cancel_by_id(&self.app.state::<RunControl>(), run_id);
    }

    fn emit(&self, event: &build_host::BuildEvent) {
        let _ = self.app.emit(build_host::BUILD_EVENT, event);
    }

    fn announce_running(&self) {
        announce_running(&self.app);
    }
}

/// Start a change's build. The decision is the host's; see `BuildHost::start`.
#[tauri::command(async)]
fn sdlc_build_start(
    app: AppHandle,
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
    form: build_host::StartForm,
) -> build_host::StartOutcome {
    let outcome = host.start(&change, form);
    announce_running(&app);
    outcome
}

/// Continue a change's build in one repository.
#[tauri::command(async)]
fn sdlc_build_continue(
    app: AppHandle,
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
    repo: String,
    off: Option<Vec<String>>,
) -> build_host::StartOutcome {
    let outcome = host.continue_with(&change, &repo, off);
    announce_running(&app);
    outcome
}

/// Where a change's build stands, or none when this session hosts no build of it.
/// The key the backend gives a change, which every build announcement carries: the page compares the two.
#[tauri::command]
fn sdlc_change_key(change: build_host::ChangeRef) -> sdlc::holds::ChangeKey {
    build_host::key_of(&change)
}

#[tauri::command]
fn sdlc_build_state(
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
) -> Option<sdlc::coordinator::BuildState> {
    host.state(&change)
}

/// Start a document run (intent, spec, plan, triage or fix) of a change that exists. The host composes
/// the spec, with the deny rules of every run of a change, and the run claims the change's own lane.
#[tauri::command(async)]
fn sdlc_run_change(
    app: AppHandle,
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
    kind: runs::RunKind,
    form: sdlc::runspec::RunForm,
) -> Result<String, String> {
    let id = host.change_run(&change, kind, form)?;
    announce_running(&app);
    Ok(id.to_string())
}

/// Start a change's review by hand; it waits when another change holds a repository it reads.
#[tauri::command(async)]
fn sdlc_review_start(
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
    off: Option<Vec<String>>,
) -> build_host::StartOutcome {
    host.review_start_with(&change, off)
}

/// The repositories other changes hold that keep a change's review from starting; none when it is free.
#[tauri::command]
fn sdlc_review_waiting(
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
) -> Vec<build_host::HeldRepo> {
    host.review_waiting(&change)
}

/// What a round may fix, and the picks that start selected, from the change's latest review.
#[tauri::command(async)]
fn sdlc_round_offer(
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
) -> Result<(sdlc::round::RoundOffer, sdlc::round::RoundPicks), String> {
    let offer = host.round_offer(&change)?;
    let picks = sdlc::round::default_picks(&offer);
    Ok((offer, picks))
}

/// The requests a round with these picks would start.
#[tauri::command(async)]
fn sdlc_round_plan(
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
    picks: sdlc::round::RoundPicks,
) -> Result<sdlc::round::RoundPlan, String> {
    host.round_plan(&change, &picks)
}

/// Stop the run of one repository (or `review`) of a change's build, or, with none named, every run of it.
#[tauri::command(async)]
fn sdlc_build_cancel(
    app: AppHandle,
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
    repo: Option<String>,
) {
    match repo {
        Some(key) => host.cancel_run(&change, &key),
        None => host.cancel(&change),
    }
    announce_running(&app);
}

/// The runs of a change's build that are live, each with its run's id.
#[tauri::command]
fn sdlc_build_runs(
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
) -> Vec<build_host::BuildRunRef> {
    host.runs(&change)
}

/// The run-spec a document run of a change would start with: the call `sdlc_run_change` composes it with. Nothing starts.
#[tauri::command(async)]
fn sdlc_preview_change_run(
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
    kind: runs::RunKind,
    form: sdlc::runspec::RunForm,
) -> Result<RunSpec, String> {
    host.preview_change_run(&change, kind, form)
}

/// The run-spec of each run a build's preview lists: the call a start composes them with. Nothing starts.
#[tauri::command(async)]
fn sdlc_preview_build(
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
    which: build_host::BuildPreviewKind,
    repo: Option<String>,
    form: build_host::StartForm,
) -> Result<Vec<build_host::BuildSection>, String> {
    host.preview_build(&change, which, repo.as_deref(), &form)
}

/// The latest review as the build page lists it: the Review group's rows and the round dialog's groups.
#[tauri::command(async)]
fn sdlc_review_view(
    host: State<Arc<build_host::BuildHost>>,
    change: build_host::ChangeRef,
) -> Result<build_host::ReviewView, String> {
    host.review_view(&change)
}

/// Step the window's zoom and remember the new level for the next launch.
#[tauri::command]
fn zoom(
    webview: tauri::Webview,
    level: State<zoom::Level>,
    step: zoom::Step,
) -> Result<f64, String> {
    zoom::apply(
        &level.0,
        step,
        |z| webview.set_zoom(z).map_err(|e| e.to_string()),
        zoom::save,
    )
}

// ---- AI-SDLC mode: thin wrappers over `kata-sdlc` ----

#[tauri::command]
fn sdlc_settings() -> sdlc::store::Settings {
    sdlc::store::load_settings()
}

#[tauri::command]
fn load_build_layout() -> serde_json::Value {
    sdlc::store::load_build_layout()
}

#[tauri::command]
fn save_build_layout(layout: serde_json::Value) -> Result<(), String> {
    sdlc::store::save_build_layout(&layout).map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_save_settings(settings: sdlc::store::Settings) -> Result<(), String> {
    // The screens never carry the list of systems already told about their old checks; saving keeps it.
    let settings = sdlc::old_checks::keep_shown(&sdlc::store::load_settings(), settings);
    sdlc::store::save_settings(&settings).map_err(|e| e.to_string())
}

/// The old per-machine checks files of the systems the home lists, for each the engineer has not been told about yet, in
/// one answer. Read to be shown, never run and never converted. `folder` is the workspace the engineer opened; the files
/// are per machine, not per workspace.
#[tauri::command]
fn sdlc_old_checks(folder: String, systems: Vec<String>) -> Vec<sdlc::old_checks::OldChecksNotice> {
    let _ = folder;
    let Some(home) = sdlc::old_checks::kata_home() else {
        return Vec::new();
    };
    sdlc::old_checks::notices(&home, &systems, &sdlc::store::load_settings())
}

/// Record that the engineer has been told about the old checks files of these systems.
#[tauri::command]
fn sdlc_old_checks_seen(systems: Vec<String>) -> Result<(), String> {
    sdlc::old_checks::record_shown(&systems).map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_workspaces() -> Vec<sdlc::store::WorkspaceEntry> {
    sdlc::store::load_workspaces()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
async fn sdlc_open_workspace(id: String) -> Result<sdlc::store::WorkspaceChoice, String> {
    sdlc::store::open_workspace(&id, now_secs()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn sdlc_add_workspace(
    name: String,
    folder: String,
) -> Result<sdlc::store::WorkspaceChoice, String> {
    sdlc::store::add_workspace(&name, &folder, now_secs()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn sdlc_remove_workspace(id: String) -> Result<sdlc::store::WorkspaceChoice, String> {
    sdlc::store::remove_workspace(&id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_scan(folder: String) -> Result<sdlc::workspace::WorkspaceScan, String> {
    sdlc::workspace::scan(Path::new(&folder)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_context_health(
    folder: String,
    master: String,
    system: String,
    repo: String,
) -> sdlc::workspace::ContextState {
    sdlc::workspace::context_health(Path::new(&folder), &master, &system, &repo)
}

/// The text of one repo's context file in the master, or `None` when it is not there.
#[tauri::command(async)]
fn sdlc_read_context(master: String, system: String, repo: String) -> Option<String> {
    sdlc::workspace::read_context(Path::new(&master), &system, &repo)
}

#[tauri::command(async)]
fn sdlc_instructions(folder: String, master_repo: String) -> sdlc::workspace::InstructionsState {
    let folder = Path::new(&folder);
    sdlc::workspace::instructions(folder, &folder.join(master_repo))
}

/// Which of the folders no longer exist. Nothing else is looked at.
#[tauri::command(async)]
fn sdlc_missing_folders(folders: Vec<String>) -> Vec<String> {
    folders
        .into_iter()
        .filter(|f| !Path::new(f).is_dir())
        .collect()
}

#[tauri::command(async)]
fn sdlc_branches(master: String) -> sdlc::branch::BranchInfo {
    sdlc::branch::branch_info(Path::new(&master))
}

#[tauri::command(async)]
fn sdlc_read_doc(change: build_host::ChangeRef, doc: String) -> Result<Option<String>, String> {
    let (_, home) = resolved(&change)?;
    Ok(read_doc_in(&home, &doc))
}

/// A document's text and, for the spec and plan, the format program's read of it, from one resolution. A program
/// that cannot read the document answers with its message inside `parsed`, so the text still shows as plain text.
#[tauri::command(async)]
fn sdlc_read_document(change: build_host::ChangeRef, doc: String) -> Result<DocumentRead, String> {
    let (plugin, home) = resolved(&change)?;
    Ok(read_document_in(&home, &plugin, &change.system, &doc))
}

/// Where a run's folder is taken, listed and discarded: a folder the caller names (setup, context and
/// triage runs), or a change, whose folder is wherever the plugin says it lives.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum SnapshotTarget {
    Workspace { master: String },
    Change(build_host::ChangeRef),
}

/// A `SnapshotTarget` after asking the plugin where the change lives. Short-lived, so not boxed.
#[allow(clippy::large_enum_variant)]
enum Placed {
    Workspace(std::path::PathBuf),
    Change {
        workspace: std::path::PathBuf,
        system: String,
        home: Result<sdlc::home::ChangeHome, sdlc::home::HomeError>,
    },
}

impl Placed {
    fn placing(&self) -> sdlc::snapshot::Placing<'_> {
        match self {
            Placed::Workspace(master) => sdlc::snapshot::Placing::Workspace(master),
            Placed::Change { home, .. } => {
                sdlc::snapshot::Placing::Change(home.as_ref().map(|h| h.master.as_path()))
            }
        }
    }
}

fn place_target_with(program: &sdlc::ai_sdlc::Program, target: &SnapshotTarget) -> Placed {
    match target {
        SnapshotTarget::Workspace { master } => Placed::Workspace(master.into()),
        SnapshotTarget::Change(change) => Placed::Change {
            workspace: (&change.workspace).into(),
            system: change.system.clone(),
            home: sdlc::home::resolve(
                program,
                Path::new(&change.workspace),
                &change.system,
                &change.change,
            ),
        },
    }
}

fn place_target(target: &SnapshotTarget) -> Placed {
    match target {
        SnapshotTarget::Workspace { master } => Placed::Workspace(master.into()),
        SnapshotTarget::Change(change) => match plugin_for_change(&change.workspace) {
            Ok(dir) => place_target_with(&sdlc::ai_sdlc::Program::locate(&dir), target),
            Err(e) => Placed::Change {
                workspace: (&change.workspace).into(),
                system: change.system.clone(),
                home: Err(e),
            },
        },
    }
}

/// The folder a snapshot and a leftovers read are taken in; the plugin's refusal when it cannot be placed.
fn take_master(placed: &Placed) -> Result<&Path, String> {
    match placed {
        Placed::Workspace(master) => Ok(master),
        Placed::Change { home, .. } => home
            .as_ref()
            .map(|h| h.master.as_path())
            .map_err(|e| e.to_string()),
    }
}

fn snapshot_in(placed: &Placed) -> Result<sdlc::snapshot::Snapshot, String> {
    let master = take_master(placed)?;
    sdlc::snapshot::take(master).map_err(|e| e.to_string())
}

fn leftovers_in(
    placed: &Placed,
    before: &sdlc::snapshot::Snapshot,
    build: Option<&sdlc::snapshot::BuildScope>,
) -> Result<sdlc::snapshot::Leftovers, String> {
    let master = take_master(placed)?;
    let repos = match placed {
        Placed::Workspace(master) => sdlc::snapshot::sibling_repos(master),
        Placed::Change {
            workspace, system, ..
        } => sdlc::snapshot::product_repos(workspace, system),
    };
    sdlc::snapshot::leftovers(master, before, &repos, build).map_err(|e| e.to_string())
}

fn discard_in(
    placed: &Placed,
    before: &sdlc::snapshot::Snapshot,
    paths: &[String],
    build: Option<&sdlc::snapshot::BuildScope>,
) -> Result<(), String> {
    sdlc::snapshot::discard_placed(&placed.placing(), before, paths, build)
}

#[tauri::command(async)]
fn sdlc_snapshot(target: SnapshotTarget) -> Result<sdlc::snapshot::Snapshot, String> {
    snapshot_in(&place_target(&target))
}

#[tauri::command(async)]
fn sdlc_leftovers(
    target: SnapshotTarget,
    before: sdlc::snapshot::Snapshot,
    build: Option<sdlc::snapshot::BuildScope>,
) -> Result<sdlc::snapshot::Leftovers, String> {
    leftovers_in(&place_target(&target), &before, build.as_ref())
}

#[tauri::command(async)]
fn sdlc_discard(
    target: SnapshotTarget,
    before: sdlc::snapshot::Snapshot,
    paths: Vec<String>,
    build: Option<sdlc::snapshot::BuildScope>,
) -> Result<(), String> {
    discard_in(&place_target(&target), &before, &paths, build.as_ref())
}

/// The name the plugin will be asked to give a change described by `title`, so a preview can show it.
#[tauri::command]
fn sdlc_change_name(title: String) -> String {
    let first = title.lines().map(str::trim).find(|l| !l.is_empty());
    sdlc::naming::change_name(&start_change::today(), first.unwrap_or_default())
}

/// Start a change through the plugin: its branch and its own copy of the master repository. Kata makes
/// neither itself. A refusal is an answer carrying the plugin's reasons; an error is a plugin that could
/// not run.
#[tauri::command(async)]
fn sdlc_start_change(
    steps: State<'_, steps::StepTable>,
    folder: String,
    system: String,
    title: String,
    work_type: String,
    scope: String,
    branch: Option<String>,
) -> Result<start_change::ChangeStart, String> {
    let program = sdlc::ai_sdlc::Program::locate(&ai_sdlc_dir_in(&folder)?);
    let place = program
        .resolve(Path::new(&folder))
        .map_err(|e| e.to_string())?;
    start_change::start_change(
        &program,
        &place,
        &start_change::today(),
        &start_change::StartRequest {
            system: &system,
            title: &title,
            work_type: &work_type,
            scope: &scope,
            branch: branch.as_deref(),
        },
        &steps,
        Path::new(&folder),
    )
}

/// A system's naming setting as the window sees it: none declared, the patterns, or why they cannot be
/// used. `reason` lets the window tell the failures apart.
#[derive(serde::Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum NamingState {
    None,
    Setting {
        branch: String,
        pull_request_title: String,
    },
    Error {
        reason: &'static str,
        message: String,
    },
}

impl NamingState {
    fn from_error(e: sdlc::naming::NamingError) -> Self {
        use sdlc::naming::NamingError as E;
        let reason = match &e {
            E::PluginMissing => "pluginMissing",
            E::PluginTooOld { .. } => "pluginTooOld",
            E::Unusable(_) => "unusable",
            E::Unreadable(_) => "unreadable",
            E::Name(_) => "name",
        };
        NamingState::Error {
            reason,
            message: e.to_string(),
        }
    }
}

/// The system's naming setting, read from the master repository's committed marker.
#[tauri::command(async)]
fn sdlc_naming(folder: String, master_repo: String, system: String) -> NamingState {
    let plugin = ai_sdlc_readiness(Some(&folder));
    let master = Path::new(&folder).join(&master_repo);
    match sdlc::naming::setting(&plugin, &master, &system) {
        Ok(None) => NamingState::None,
        Ok(Some(n)) => NamingState::Setting {
            branch: n.branch,
            pull_request_title: n.pull_request_title,
        },
        Err(e) => NamingState::from_error(e),
    }
}

/// Why a scope typed at the start of a change cannot be used; empty when it is accepted as typed.
#[tauri::command(async)]
fn sdlc_check_scope(folder: String, scope: String) -> Result<Vec<String>, String> {
    let plugin = ai_sdlc_readiness(Some(&folder));
    sdlc::naming::check_scope(&plugin, &scope).map_err(|e| e.to_string())
}

/// Rename the change's branch through the plugin, which moves it in every repository that has it or in
/// none. Refused while any run of the change is live (build, review or document), since a run works on the branch.
#[tauri::command(async)]
fn sdlc_rename_branch(
    control: State<'_, RunControl>,
    steps: State<'_, steps::StepTable>,
    folder: String,
    workspace_id: String,
    system: String,
    change: String,
    to: String,
) -> Result<rename_change::RenameOutcome, String> {
    if let Some(refused) = rename_refusal(&control.state.lock().unwrap(), &system, &change) {
        return Err(refused);
    }
    let program = sdlc::ai_sdlc::Program::locate(&ai_sdlc_dir_in(&folder)?);
    let place = program
        .resolve(Path::new(&folder))
        .map_err(|e| e.to_string())?;
    let legacy = sdlc::pull_requests::legacy_entries(&workspace_id, &system, &change);
    let key = sdlc::holds::ChangeKey {
        workspace: sdlc::holds::RepoKey::of(Path::new(&folder)),
        system,
        change,
    };
    rename_change::rename_change(&program, &place, &to, &legacy, &steps, &key)
}

/// The change a triage run started, named by the run's own record: the plugin's `change start` answer among its
/// tool results. None when the run started no change of `system`.
#[tauri::command(async)]
fn sdlc_triage_change(transcript: String, system: String) -> Result<Option<String>, String> {
    let run = kata_core::history::load_run(&transcript).map_err(|e| e.to_string())?;
    Ok(start_change::started_by_run(&run.events, &system))
}

/// Switch the master checkout to `branch`. Refused while a live run works in that folder, naming its change;
/// the runs table stays locked through the switch, so no run can claim the folder half way.
#[tauri::command(async)]
fn sdlc_checkout(
    control: State<'_, RunControl>,
    master: String,
    branch: String,
) -> Result<(), String> {
    let table = control.state.lock().unwrap();
    table.may_switch(Path::new(&master))?;
    let out = sdlc::branch::checkout(Path::new(&master), &branch).map_err(|e| e.to_string());
    drop(table);
    out
}

/// Where the plugin has the change: `kata_sdlc::home::resolve` for the change's workspace.
fn change_home(
    program: &sdlc::ai_sdlc::Program,
    change: &build_host::ChangeRef,
) -> Result<sdlc::home::ChangeHome, String> {
    sdlc::home::resolve(
        program,
        Path::new(&change.workspace),
        &change.system,
        &change.change,
    )
    .map_err(|e| e.to_string())
}

/// Accept a document of a change: the status edit, the plugin's acceptance commit, then its `doc.accept` event.
#[tauri::command(async)]
fn sdlc_accept(
    steps: State<'_, steps::StepTable>,
    change: build_host::ChangeRef,
    doc: sdlc::accept::ChangeDocument,
) -> Result<sdlc::accept::AcceptOutcome, String> {
    let program = sdlc::ai_sdlc::Program::locate(&change_plugin_dir(&change.workspace)?);
    accept_in(&steps, &program, &change, doc)
}

/// The accept step of `sdlc_accept`, with the program given.
fn accept_in(
    steps: &steps::StepTable,
    program: &sdlc::ai_sdlc::Program,
    change: &build_host::ChangeRef,
    doc: sdlc::accept::ChangeDocument,
) -> Result<sdlc::accept::AcceptOutcome, String> {
    let step = steps
        .begin(build_host::key_of(change), steps::StepKind::Accepting(doc))
        .map_err(|_| start_change::STEP_BUSY.to_string())?;
    let home = change_home(program, change)?;
    Ok(sdlc::accept::apply(
        program,
        &home.place,
        &change.system,
        &home.state,
        doc,
        step.token(),
    ))
}

/// Reject a change the way the plugin does: it commits the rejection and removes the change's copy. No run
/// of the change starts while that goes on, and none may be live when it begins.
#[tauri::command(async)]
fn sdlc_reject(
    control: State<'_, RunControl>,
    steps: State<'_, steps::StepTable>,
    change: build_host::ChangeRef,
) -> Result<sdlc::accept::RejectOutcome, String> {
    let program = sdlc::ai_sdlc::Program::locate(&change_plugin_dir(&change.workspace)?);
    reject_in(&control, &steps, &program, &change)
}

/// The reject step of `sdlc_reject`, with the program given.
fn reject_in(
    control: &RunControl,
    steps: &steps::StepTable,
    program: &sdlc::ai_sdlc::Program,
    change: &build_host::ChangeRef,
) -> Result<sdlc::accept::RejectOutcome, String> {
    let key = build_host::key_of(change);
    let step = steps
        .begin(
            key.clone(),
            steps::StepKind::Rejecting(sdlc::accept::ChangeDocument::Intent),
        )
        .map_err(|_| start_change::STEP_BUSY.to_string())?;
    control.state.lock().unwrap().begin_rejecting(&key)?;
    let outcome = change_home(program, change).map(|home| {
        sdlc::accept::reject(
            program,
            &home.place,
            &change.system,
            &home.state,
            step.token(),
        )
    });
    control.state.lock().unwrap().end_rejecting(&key);
    outcome
}

/// What the change page offers for the change's copy: removal once its pull requests are merged and the
/// copy holds nothing uncommitted, else the files that keep it, else nothing. Asks GitHub for the states.
#[tauri::command(async)]
fn sdlc_copy_removal(
    change: build_host::ChangeRef,
) -> Result<sdlc::copy_removal::CopyRemoval, String> {
    let program = sdlc::ai_sdlc::Program::locate(&change_plugin_dir(&change.workspace)?);
    let home = change_home(&program, &change)?;
    sdlc::copy_removal::offer(&program, &home.place, &home.state)
}

/// The branch the change's copy holds, as the plugin records it.
#[tauri::command(async)]
fn sdlc_copy_branch(change: build_host::ChangeRef) -> Result<String, String> {
    let program = sdlc::ai_sdlc::Program::locate(&change_plugin_dir(&change.workspace)?);
    let place = program
        .resolve(Path::new(&change.workspace))
        .map_err(|e| e.to_string())?;
    sdlc::copy_removal::branch(&program, &place, &change.change)
}

/// Remove the change's copy on the engineer's confirmation. The plugin refuses a copy with uncommitted
/// files. No run of the change starts while the copy goes, and none may be live when it begins.
#[tauri::command(async)]
fn sdlc_remove_copy(
    control: State<'_, RunControl>,
    steps: State<'_, steps::StepTable>,
    change: build_host::ChangeRef,
) -> Result<sdlc::copy_removal::RemoveOutcome, String> {
    let program = sdlc::ai_sdlc::Program::locate(&change_plugin_dir(&change.workspace)?);
    remove_copy_in(&control, &steps, &program, &change)
}

/// The removal step of `sdlc_remove_copy`, with the program given.
fn remove_copy_in(
    control: &RunControl,
    steps: &steps::StepTable,
    program: &sdlc::ai_sdlc::Program,
    change: &build_host::ChangeRef,
) -> Result<sdlc::copy_removal::RemoveOutcome, String> {
    let key = build_host::key_of(change);
    let step = steps
        .begin(key.clone(), steps::StepKind::RemovingCopy)
        .map_err(|_| start_change::STEP_BUSY.to_string())?;
    control.state.lock().unwrap().begin_rejecting(&key)?;
    let outcome = change_home(program, change)
        .map(|home| sdlc::copy_removal::remove(program, &home.place, &home.state, step.token()));
    control.state.lock().unwrap().end_rejecting(&key);
    outcome
}

/// Open the folder of the change's copy in the system file manager. The folder is the plugin's, never one
/// the webview names, and only a change in a copy has one.
#[tauri::command(async)]
fn sdlc_open_copy_folder(app: AppHandle, change: build_host::ChangeRef) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let program = sdlc::ai_sdlc::Program::locate(&change_plugin_dir(&change.workspace)?);
    let home = change_home(&program, &change)?;
    open_copy_with(home.in_copy, &home.state.master, |path| {
        app.opener()
            .open_path(path, None::<&str>)
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn sdlc_run_links() -> Vec<sdlc::store::RunLink> {
    sdlc::store::load_run_links()
}

#[tauri::command]
fn sdlc_link_run(link: sdlc::store::RunLink) -> Result<(), String> {
    sdlc::store::append_run_link(link).map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_task_links() -> Vec<sdlc::store::TaskLink> {
    sdlc::store::load_task_links()
}

// ---- AI-SDLC mode: the build, the diff, checks and publishing ----

#[tauri::command(async)]
fn sdlc_build_status(change: build_host::ChangeRef) -> Result<sdlc::build::BuildStatus, String> {
    let (plugin, home) = resolved(&change)?;
    sdlc::build::status(&plugin, &home.master, &change.system, &change.change)
        .map_err(|e| e.to_string())
}

/// The build page's tasks area for the repositories asked for: where each stands and what each task's row shows, from the build log's
/// status and the live runs and stops the host announced, both as the page last read them from the backend.
#[tauri::command]
fn sdlc_build_board(
    repos: Vec<String>,
    status: sdlc::build::BuildStatus,
    going: std::collections::BTreeSet<String>,
    stopped: std::collections::BTreeMap<String, sdlc::coordinator::Stop>,
) -> Vec<sdlc::board::RepoBoard> {
    sdlc::board::board(&repos, &status, &going, &stopped)
}

/// Whether the change's latest review covers its current work, from the inputs the page read: the run links, the run
/// records, where each repository stands now, the review document and the master repository's name.
#[tauri::command]
fn sdlc_review_standing(
    links: Vec<sdlc::store::RunLink>,
    records: Vec<kata_core::history::RunRecord>,
    heads: std::collections::BTreeMap<String, String>,
    scope: sdlc::review::ReviewScope,
    document: Option<sdlc::review::ReviewRecord>,
    master: Option<String>,
) -> sdlc::review::ReviewStanding {
    sdlc::review::standing(
        &links,
        &records,
        &heads,
        &scope,
        document.as_ref(),
        master.as_deref(),
    )
}

#[tauri::command(async)]
fn sdlc_review_record(
    change: build_host::ChangeRef,
) -> Result<Option<sdlc::review::ReviewRecord>, String> {
    let (plugin, home) = resolved(&change)?;
    sdlc::review::record(&plugin, &home.master, &change.system, &change.change)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_build_heads(
    change: build_host::ChangeRef,
    repos: Vec<String>,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let (_, home) = resolved(&change)?;
    sdlc::branch::heads(
        &home.place.workspace,
        &home.master,
        &master_repo_of(&home),
        &change.system,
        &repos,
        &change.change,
    )
}

/// What the run table knows about a change: any of its runs (build, review or document) makes it live, and
/// only a build or review run makes its build live. `build_stopped` is false here.
fn live_facts(control: &RunControl, system: &str, change: &str) -> sdlc::offer::LiveFacts {
    live_facts_of(&control.state.lock().unwrap(), system, change)
}

/// The live facts of a change in `table`.
fn live_facts_of<C>(table: &RunTable<C>, system: &str, change: &str) -> sdlc::offer::LiveFacts {
    sdlc::offer::LiveFacts {
        run_live: table.change_live(system, change),
        build_stopped: false,
        build_live: table.group_live(&format!("build:{system}/{change}")),
    }
}

/// Why the change's branch cannot be renamed now: a run of the change (build, review or document) is live
/// in `table`.
fn rename_refusal<C>(table: &RunTable<C>, system: &str, change: &str) -> Option<String> {
    table
        .change_live(system, change)
        .then(|| "A run of this change is live. Rename the branch after it ends.".to_string())
}

/// The program to ask, and the readiness, for a workspace folder. Only a ready mode has a program.
fn state_inputs(folder: &str) -> (Option<sdlc::ai_sdlc::Program>, sdlc::plugin::Readiness) {
    let readiness = ai_sdlc_readiness(Some(folder));
    let program = match &readiness {
        sdlc::plugin::Readiness::Ready { plugin, .. } => {
            Some(sdlc::ai_sdlc::Program::locate(&plugin.dir))
        }
        sdlc::plugin::Readiness::Blocked { .. } => None,
    };
    (program, readiness)
}

/// Every change of every system the home lists, with its stage, what it offers and its live facts, from one `state`
/// call per system made side by side, and whether a new change may be started across the set. One system's failed read
/// fails the answer.
#[tauri::command(async)]
fn sdlc_state(
    control: State<'_, RunControl>,
    folder: String,
    systems: Vec<String>,
) -> Result<sdlc_state::WorkspaceView, String> {
    let (program, readiness) = state_inputs(&folder);
    let control: &RunControl = &control;
    let views = std::thread::scope(|scope| {
        let reads: Vec<_> = systems
            .iter()
            .map(|system| {
                let (program, readiness, folder) = (&program, &readiness, &folder);
                scope.spawn(move || {
                    let source = program.as_ref().map(|p| p as &dyn sdlc_state::StateSource);
                    sdlc_state::system_view(
                        source,
                        readiness,
                        &|s, c| live_facts(control, s, c),
                        Path::new(folder),
                        system,
                    )
                })
            })
            .collect();
        reads
            .into_iter()
            .map(|read| {
                read.join()
                    .unwrap_or_else(|_| Err("reading a system's changes failed".to_string()))
            })
            .collect::<Result<Vec<_>, String>>()
    })?;
    Ok(sdlc_state::workspace_view(views))
}

/// The home's list for a saved workspace: the system shown (the one used last, else the first) with its open and
/// finished changes, or `Legacy` where the plugin cannot list changes.
#[tauri::command(async)]
fn sdlc_home_list(
    workspace_id: String,
    systems: Vec<String>,
) -> Result<sdlc::open_changes::HomeList, String> {
    let entry = sdlc::store::load_workspaces()
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| "that workspace is not saved".to_string())?;
    let (program, readiness) = state_inputs(&entry.folder);
    let Some(program) = program else {
        return Ok(sdlc::open_changes::HomeList::Legacy);
    };
    sdlc_home::home_list(
        &program,
        &readiness,
        entry.last_system.as_deref(),
        Path::new(&entry.folder),
        &systems,
    )
}

/// The engineer picked a system on the home: remember it, then list it.
#[tauri::command(async)]
fn sdlc_home_pick(
    workspace_id: String,
    system: String,
    systems: Vec<String>,
) -> Result<sdlc::open_changes::HomeList, String> {
    if !systems.contains(&system) {
        return Err(format!("{system} is not a system of this workspace"));
    }
    sdlc::store::remember_system(&workspace_id, &system).map_err(|e| e.to_string())?;
    sdlc_home_list(workspace_id, systems)
}

/// The open changes of the shown system, read alone, as rows.
#[tauri::command(async)]
fn sdlc_home_open(
    control: State<'_, RunControl>,
    memory: State<'_, sdlc_home::HomeMemory>,
    folder: String,
    system: String,
    shown: Vec<String>,
    trigger: sdlc::open_changes::Refresh,
) -> Result<sdlc::open_changes::HomeOpen, String> {
    let (program, readiness) = state_inputs(&folder);
    let program = program.ok_or_else(|| "the AI-SDLC mode cannot run here".to_string())?;
    sdlc_home::home_open(
        &program,
        &readiness,
        &|s, c| live_facts(&control, s, c),
        Path::new(&folder),
        &system,
        &shown,
        trigger,
        &memory,
    )
}

/// The merge check for the named open changes, side by side.
#[tauri::command(async)]
fn sdlc_home_pull_requests(
    memory: State<'_, sdlc_home::HomeMemory>,
    folder: String,
    system: String,
    changes: Vec<String>,
) -> Result<sdlc::open_changes::HomeChecked, String> {
    let (program, readiness) = state_inputs(&folder);
    let program = program.ok_or_else(|| "the AI-SDLC mode cannot run here".to_string())?;
    sdlc_home::home_pull_requests(
        &program,
        &readiness,
        Path::new(&folder),
        &system,
        &changes,
        &memory,
    )
}

/// One change of a system, as [`sdlc_state`] shows it.
#[tauri::command(async)]
fn sdlc_change_state(
    control: State<'_, RunControl>,
    folder: String,
    system: String,
    change: String,
) -> Result<sdlc_state::ChangeView, String> {
    let (program, readiness) = state_inputs(&folder);
    let source = program.as_ref().map(|p| p as &dyn sdlc_state::StateSource);
    let mut view = sdlc_state::change_view(
        source,
        &readiness,
        &|s, c| live_facts(&control, s, c),
        Path::new(&folder),
        &system,
        &change,
    )?;
    if let Some(program) = &program {
        drop_declare_done_after_earlier_declaration(program, &folder, &system, &change, &mut view);
    }
    Ok(view)
}

/// A change an earlier version of Kata declared done is not offered declaring done again. Only a change whose
/// offer lists it and that Kata saved pull requests for needs the plugin asked, so a page costs nothing more
/// for any other change.
fn drop_declare_done_after_earlier_declaration(
    program: &sdlc::ai_sdlc::Program,
    folder: &str,
    system: &str,
    change: &str,
    view: &mut sdlc_state::ChangeView,
) {
    use sdlc::offer::StageAction::DeclareDone;
    if !view.offer.actions.iter().any(|a| a.action == DeclareDone) {
        return;
    }
    let Some(workspace) = sdlc::store::load_workspaces()
        .into_iter()
        .find(|w| Path::new(&w.folder) == Path::new(folder))
    else {
        return;
    };
    let legacy = sdlc::pull_requests::legacy_entries(&workspace.id, system, change);
    if legacy.is_empty() {
        return;
    }
    let Ok(place) = program.resolve(Path::new(folder)) else {
        return;
    };
    if let Ok(shown) = program.change_show(&place, change, false) {
        // Only whether declaring done stays offered is read here, and Kata's earlier record decides that.
        let pull_requests = sdlc::pull_requests::view(&shown, &legacy, false);
        view.offer = sdlc::offer::after_pull_requests(view.offer.clone(), &pull_requests);
    }
}

/// The Workbench and ai-sdlc versions for the version line. The ai-sdlc plugin is looked up from the
/// workspace the home opens on (the most recently opened), or the engineer's own scope when none.
#[tauri::command(async)]
fn app_versions(app: tauri::AppHandle) -> versions::Versions {
    let list = sdlc::store::load_workspaces();
    let folder = sdlc::store::current_workspace(&list).map(|w| std::path::PathBuf::from(&w.folder));
    versions::versions(
        &app.package_info().version.to_string(),
        cfg!(debug_assertions),
        versions::find_ai_sdlc(folder.as_deref()),
    )
}

/// The id of the workspace the home opens on, decided once here (see `store::current_workspace`).
#[tauri::command(async)]
fn sdlc_current_workspace() -> Option<String> {
    let list = sdlc::store::load_workspaces();
    sdlc::store::current_workspace(&list).map(|w| w.id.clone())
}

#[tauri::command(async)]
fn sdlc_plugin_readiness(workdir: Option<String>) -> sdlc::plugin::Readiness {
    ai_sdlc_readiness(workdir.as_deref())
}

/// The installed plugin that is the ai-sdlc plugin: a plugin named `ai-sdlc` that provides the build skill.
pub(crate) fn ai_sdlc_entry(found: &[CatalogEntry]) -> Option<&CatalogEntry> {
    found.iter().find(|e| {
        e.kind == catalog::EntryKind::Plugin
            && e.name == "ai-sdlc"
            && e.provides.iter().any(|p| p == "skill:build")
    })
}

/// Whether the ai-sdlc plugin that `workdir`'s catalog finds can be used, and where it is.
fn ai_sdlc_readiness(workdir: Option<&str>) -> sdlc::plugin::Readiness {
    let roots = catalog::roots_for_workdir(workdir);
    let found = catalog::discover(&roots);
    let plugin = ai_sdlc_entry(&found);
    sdlc::plugin::readiness(&sdlc::plugin::Machine::detect(
        plugin.map(|e| e.path.as_path()),
    ))
}

/// The ai-sdlc plugin folder the format program is read from, or why the build cannot be read. It is
/// found from the workspace folder, the same place `sdlc_plugin_readiness` is asked about, so a
/// project-scoped plugin there is the one every command uses.
fn ai_sdlc_dir_in(folder: &str) -> Result<std::path::PathBuf, String> {
    match ai_sdlc_readiness(Some(folder)) {
        sdlc::plugin::Readiness::Ready { plugin, .. } => Ok(plugin.dir),
        sdlc::plugin::Readiness::Blocked { message, .. } => Err(message),
    }
}

/// The one place a plugin that cannot be used becomes a resolution error: the readiness message, as the
/// reason the change could not be placed.
fn plugin_of(
    readiness: &sdlc::plugin::Readiness,
) -> Result<std::path::PathBuf, sdlc::home::HomeError> {
    match readiness {
        sdlc::plugin::Readiness::Ready { plugin, .. } => Ok(plugin.dir.clone()),
        sdlc::plugin::Readiness::Blocked { message, .. } => {
            Err(sdlc::home::HomeError::Unanswered(message.clone()))
        }
    }
}

/// The plugin folder for a command on one change, found from the change's workspace folder.
fn plugin_for_change(workspace: &str) -> Result<std::path::PathBuf, sdlc::home::HomeError> {
    plugin_of(&ai_sdlc_readiness(Some(workspace)))
}

/// `plugin_for_change` with the message a command returns.
fn change_plugin_dir(workspace: &str) -> Result<std::path::PathBuf, String> {
    plugin_for_change(workspace).map_err(|e| e.to_string())
}

/// Everything the change page needs to open a change, read from one resolution of where it lives.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct OpenedChange {
    pub view: sdlc_state::ChangeView,
    pub text: Option<String>,
    pub parsed: Option<ParsedRead>,
    pub status: Option<sdlc::build::BuildStatus>,
    pub review: Option<sdlc::review::ReviewRecord>,
    /// What part of the open could not be read (the build status, the review record), in the backend's words.
    /// The part is then `None` and the open still succeeds.
    pub notices: Vec<OpenNotice>,
}

/// The part of an opened change a notice concerns.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum NoticePart {
    BuildStatus,
    Review,
}

/// What could not be read when a change was opened, and which part it concerns.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct OpenNotice {
    pub part: NoticePart,
    pub message: String,
}

/// The format program's read of a document, or its own message when it could not read it.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(untagged)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ParsedRead {
    Read(sdlc::format::ReadResult),
    Failed(ReadFailure),
}

/// A document the format program could not read; `kind` is always `error`.
#[derive(serde::Serialize, Clone, Debug)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ReadFailure {
    pub kind: String,
    pub message: String,
}

/// A document's text and the format program's read of it, from one resolution of where the change lives.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct DocumentRead {
    pub text: Option<String>,
    pub parsed: Option<ParsedRead>,
}

fn read_document_in(
    home: &sdlc::home::ChangeHome,
    plugin: &Path,
    system: &str,
    doc: &str,
) -> DocumentRead {
    DocumentRead {
        text: read_doc_in(home, doc),
        parsed: parsed_of(home, plugin, system, doc),
    }
}

/// The format program's read of a document as the page shows it: a program that cannot read it answers with its
/// own message, never a failed call.
fn parsed_of(
    home: &sdlc::home::ChangeHome,
    plugin: &Path,
    system: &str,
    doc: &str,
) -> Option<ParsedRead> {
    match read_parsed_in(home, plugin, system, doc) {
        Ok(read) => read.map(ParsedRead::Read),
        Err(e) => Some(ParsedRead::Failed(ReadFailure {
            kind: "error".into(),
            message: e.to_string(),
        })),
    }
}

/// The text of a document as the change's own master holds it, uncommitted edits included.
fn read_doc_in(home: &sdlc::home::ChangeHome, doc: &str) -> Option<String> {
    if !matches!(doc, "intent" | "spec" | "plan") {
        return None;
    }
    std::fs::read_to_string(home.folder.join(format!("{doc}.md"))).ok()
}

/// The format program's read of a spec or plan in the change's own master.
fn read_parsed_in(
    home: &sdlc::home::ChangeHome,
    plugin: &Path,
    system: &str,
    doc: &str,
) -> Result<Option<sdlc::format::ReadResult>, sdlc::format::FormatError> {
    sdlc::changes::read_parsed(plugin, &home.master, system, &home.state.change, doc)
}

/// The name of the workspace's master checkout, the folder the diff and branch reads call the master repository.
fn master_repo_of(home: &sdlc::home::ChangeHome) -> String {
    home.place
        .master
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The change page's first read: one resolution, the change's view, the document and the build and review.
fn open_change_in(
    home: &sdlc::home::ChangeHome,
    plugin: &Path,
    readiness: &sdlc::plugin::Readiness,
    live: sdlc::offer::LiveFacts,
    system: &str,
    doc: &str,
) -> Result<OpenedChange, String> {
    let change = &home.state.change;
    let parsed = parsed_of(home, plugin, system, doc);
    let planned = home.state.documents.plan.exists;
    // The change is placed, so a part that cannot be read (a plan written but not yet committed, say) is left
    // out with its reason; it never fails the open.
    let mut notices = Vec::new();
    let status = if planned {
        match sdlc::build::status(plugin, &home.master, system, change) {
            Ok(status) => Some(status),
            Err(e) => {
                notices.push(OpenNotice {
                    part: NoticePart::BuildStatus,
                    message: e.to_string(),
                });
                None
            }
        }
    } else {
        None
    };
    let review = if planned {
        match sdlc::review::record(plugin, &home.master, system, change) {
            Ok(review) => review,
            Err(e) => {
                notices.push(OpenNotice {
                    part: NoticePart::Review,
                    message: e.to_string(),
                });
                None
            }
        }
    } else {
        None
    };
    Ok(OpenedChange {
        view: sdlc_state::view_of(home.state.clone(), readiness, live),
        text: read_doc_in(home, doc),
        parsed,
        status,
        review,
        notices,
    })
}

/// The plugin folder and where the change lives, resolved once for a command.
fn resolved(
    change: &build_host::ChangeRef,
) -> Result<(std::path::PathBuf, sdlc::home::ChangeHome), String> {
    let plugin = change_plugin_dir(&change.workspace)?;
    let home = change_home(&sdlc::ai_sdlc::Program::locate(&plugin), change)?;
    Ok((plugin, home))
}

/// Open a change: its view, the document asked for and the build and review, from one resolution.
#[tauri::command(async)]
fn sdlc_open_change(
    control: State<'_, RunControl>,
    change: build_host::ChangeRef,
    doc: String,
) -> Result<OpenedChange, String> {
    let readiness = ai_sdlc_readiness(Some(&change.workspace));
    let plugin_dir = plugin_of(&readiness).map_err(|e| e.to_string())?;
    let program = sdlc::ai_sdlc::Program::locate(&plugin_dir);
    let home = change_home(&program, &change)?;
    let live = live_facts(&control, &change.system, &change.change);
    let mut opened = open_change_in(&home, &plugin_dir, &readiness, live, &change.system, &doc)?;
    drop_declare_done_after_earlier_declaration(
        &program,
        &change.workspace,
        &change.system,
        &change.change,
        &mut opened.view,
    );
    Ok(opened)
}

#[tauri::command(async)]
fn sdlc_change_repos(change: build_host::ChangeRef) -> Result<Vec<sdlc::diff::ChangeRepo>, String> {
    let (_, home) = resolved(&change)?;
    sdlc::diff::change_repos(
        &home.place.workspace,
        &home.master,
        &master_repo_of(&home),
        &change.system,
        &change.change,
    )
}

#[tauri::command(async)]
fn sdlc_missing_change_branches(change: build_host::ChangeRef) -> Result<Vec<String>, String> {
    let (plugin, home) = resolved(&change)?;
    sdlc::branch::missing_change_branches(
        &plugin,
        &home.place.workspace,
        &home.master,
        &master_repo_of(&home),
        &change.system,
        &change.change,
    )
}

#[tauri::command(async)]
fn sdlc_diff_files(
    repo_path: String,
    part: sdlc::diff::Part,
) -> Result<sdlc::diff::DiffListing, String> {
    let files =
        sdlc::diff::changed_files(Path::new(&repo_path), part).map_err(|e| e.to_string())?;
    let loc = sdlc::diff::loc_by_file_type(&files);
    Ok(sdlc::diff::DiffListing { files, loc })
}

#[tauri::command(async)]
fn sdlc_commit_files(repo_path: String) -> Result<Vec<sdlc::diff::CommitFiles>, String> {
    sdlc::diff::commit_files(Path::new(&repo_path)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_diff_pair(
    repo_path: String,
    part: sdlc::diff::Part,
    path: String,
) -> Result<sdlc::diff::FilePair, String> {
    sdlc::diff::file_pair(Path::new(&repo_path), part, &path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_diff_base(repo_path: String) -> Result<sdlc::diff::BaseInfo, String> {
    sdlc::diff::base_info(Path::new(&repo_path)).map_err(|e| e.to_string())
}

/// What each repository of the change's checks came to, as the plugin recorded it on this machine against the
/// hooks the team committed to the master's base branch. Kata runs no check and reads no checks file.
#[tauri::command(async)]
fn sdlc_checks_view(
    change: build_host::ChangeRef,
) -> Result<Vec<sdlc::checks_view::RepoCheckView>, String> {
    let program = sdlc::ai_sdlc::Program::locate(&change_plugin_dir(&change.workspace)?);
    let home = change_home(&program, &change)?;
    let (place, state) = (home.place, home.state);
    let repos: Vec<String> = state
        .tasks
        .as_ref()
        .map(|tasks| tasks.keys().cloned().collect())
        .unwrap_or_default();
    sdlc::checks_view::for_change(&program, &place, &change.system, &change.change, &repos)
        .map_err(|e| e.to_string())
}

/// Declare a change done through the plugin: it verifies the change, pushes every touched repository and
/// opens one pull request each, the master's last. Each step it reports goes out on `sdlc://step`. A
/// step the machine cannot run is the answer, not an error.
#[tauri::command(async)]
fn sdlc_declare_done(
    steps: State<'_, steps::StepTable>,
    change: build_host::ChangeRef,
) -> sdlc::done::DeclareView {
    let program = match change_plugin_dir(&change.workspace) {
        Ok(dir) => sdlc::ai_sdlc::Program::locate(&dir),
        Err(message) => return sdlc::done::DeclareView::CouldNotRun { message },
    };
    let readiness = ai_sdlc_readiness(Some(&change.workspace));
    declare_in(&steps, &program, &readiness, &change)
}

/// The declare step of `sdlc_declare_done`, with the program and the machine's readiness given.
fn declare_in(
    steps: &steps::StepTable,
    program: &sdlc::ai_sdlc::Program,
    readiness: &sdlc::plugin::Readiness,
    change: &build_host::ChangeRef,
) -> sdlc::done::DeclareView {
    let could_not_run = |message: String| sdlc::done::DeclareView::CouldNotRun { message };
    let key = build_host::key_of(change);
    let Ok(step) = steps.begin(key.clone(), steps::StepKind::DeclaringDone) else {
        return could_not_run(start_change::STEP_BUSY.to_string());
    };
    let (place, state) = match change_home(program, change) {
        Ok(home) => (home.place, home.state),
        Err(message) => return could_not_run(message),
    };
    // A change that lives in a copy is declared done from its copy.
    let at = sdlc::ai_sdlc::Place {
        master: std::path::PathBuf::from(&state.master),
        workspace: place.workspace,
    };
    sdlc::done::declare(
        program,
        &at,
        readiness,
        &change.system,
        &change.change,
        {
            let steps = steps.clone();
            Arc::new(move |progress| steps.label(&key, progress))
        },
        step.token(),
    )
}

/// The change's pull requests as the page shows them: the plugin's record in `change.yml` first, else what an
/// earlier version of Kata saved. With `refresh` the plugin also asks GitHub for each state, which starts `gh`
/// and is slow, so the page asks without it first and with it in the background. Pull requests an earlier
/// version of Kata saved are not asked about: the plugin does not know them.
#[tauri::command(async)]
fn sdlc_pull_requests_view(
    folder: String,
    workspace_id: String,
    system: String,
    change: String,
    refresh: bool,
) -> Result<sdlc::pull_requests::PullRequestsView, String> {
    let program = sdlc::ai_sdlc::Program::locate(&ai_sdlc_dir_in(&folder)?);
    let place = program
        .resolve(Path::new(&folder))
        .map_err(|e| e.to_string())?;
    sdlc::pull_requests::read_view(
        &program,
        &place,
        Some(&workspace_id),
        &system,
        &change,
        refresh,
    )
}

/// Relay a non-JSON stdout/stderr line as a warn-level log event.
fn relay_log(app: &AppHandle, history: &history::RunHistory, run_id: u64, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim();
    if !line.is_empty() {
        let event = json!({ "type": "log", "level": "warn", "message": line });
        let seq = history.push(run_id, &event);
        let _ = app.emit(RUN_EVENT, runs::wrap(run_id, seq, event));
    }
}

/// Cancel one run: write a `cancel` line to its engine's stdin so it traps it,
/// kills claude, cleans up, and emits run.cancelled. Falls back to a hard kill
/// if the stdin write fails (child already gone). Touches only that run.
#[tauri::command]
fn cancel_run(control: State<RunControl>, run_id: String) {
    let Some(id) = parse_run_id(&run_id) else {
        return;
    };
    cancel_by_id(&control, id);
}

/// The write `cancel_run` does, for a run the backend itself holds the id of.
fn cancel_by_id(control: &RunControl, id: u64) {
    let mut table = control.state.lock().unwrap();
    let Some(run) = table.get_mut(id) else {
        return;
    };
    let still_alive = run
        .child
        .as_mut()
        .map(|c| c.write(b"cancel\n").is_ok())
        .unwrap_or(false);
    if !still_alive {
        if let Some(child) = run.child.take() {
            let _ = child.kill();
        }
    }
}

/// The close guard's wrapper: apply `on_close` to the live runs and the builds being started or
/// launched. A confirm first stops the build host, so no change launches anything more, then stops every long step and cancels every
/// run the table holds, as `cancel_run` does, including one a launch under way adds later; it waits up to
/// ten seconds in total for the table to empty, the launches to settle and the step table to empty, then destroys the window (a
/// plain `close` would ask again). No lock is held across the wait.
fn close_window(app: &AppHandle, answer: close_guard::CloseAnswer) {
    let host = app
        .try_state::<Arc<build_host::BuildHost>>()
        .map(|h| h.inner().clone());
    let launching = host.as_ref().map(|h| h.launching()).unwrap_or_default();
    let live = app.state::<RunControl>().state.lock().unwrap().live();
    let step_table = app.state::<steps::StepTable>().inner().clone();
    let running_steps = step_table.running();
    match close_guard::on_close(&live, &launching, &running_steps, answer) {
        close_guard::CloseOutcome::Close => destroy_main(app),
        ask @ close_guard::CloseOutcome::Ask { .. } => {
            let _ = app.emit(close_guard::CLOSE_ASKED_EVENT, ask);
        }
        close_guard::CloseOutcome::Stay => {}
        close_guard::CloseOutcome::CancelThenClose { steps: to_stop, .. } => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(host) = &host {
                    host.stop_all();
                }
                for change in &to_stop {
                    step_table.stop(change);
                }
                let control = app.state::<RunControl>();
                let deadline = std::time::Instant::now()
                    + std::time::Duration::from_secs(close_guard::CANCEL_WAIT_SECS);
                let mut cancelled: std::collections::HashSet<u64> = Default::default();
                loop {
                    let live = control.state.lock().unwrap().live();
                    let launching = host.as_ref().map(|h| h.launching()).unwrap_or_default();
                    if live.is_empty() && launching.is_empty() && step_table.running().is_empty() {
                        break;
                    }
                    for run in &live {
                        if cancelled.insert(run.id) {
                            cancel_by_id(&control, run.id);
                        }
                    }
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                destroy_main(&app);
            });
        }
    }
}

fn destroy_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.destroy();
    }
}

/// The engineer's answer to the close question.
#[tauri::command]
fn sdlc_close_answer(app: AppHandle, confirm: bool) {
    close_window(
        &app,
        if confirm {
            close_guard::CloseAnswer::Confirm
        } else {
            close_guard::CloseAnswer::Decline
        },
    );
}

/// Poll until run `id` is no longer live (the reader task has seen the engine
/// exit and removed it), or until `timeout` passes. True when the engine is gone.
fn wait_idle<C>(
    state: &Mutex<RunTable<C>>,
    id: u64,
    timeout: std::time::Duration,
    every: std::time::Duration,
) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if !state.lock().unwrap().is_live(id) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(every);
    }
}

/// Wait for one run's engine process to exit after the run ends or is
/// cancelled. The UI sees the terminal event before the sidecar has finished
/// tearing down, so anything that touches the repo afterwards waits here first.
#[tauri::command]
async fn sdlc_wait_run_exit(
    control: State<'_, RunControl>,
    run_id: String,
    timeout_ms: u64,
) -> Result<bool, String> {
    let Some(id) = parse_run_id(&run_id) else {
        return Ok(true);
    };
    let state = control.state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        wait_idle(
            &state,
            id,
            std::time::Duration::from_millis(timeout_ms),
            std::time::Duration::from_millis(50),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// List all completed runs from the history store.
#[tauri::command]
fn list_runs() -> Result<Vec<kata_core::history::RunRecord>, String> {
    Ok(kata_core::history::list_runs())
}

/// Load the full detail for a single run by id.
#[tauri::command]
fn load_run(id: String) -> Result<kata_core::history::RunDetail, String> {
    kata_core::history::load_run(&id).map_err(|e| e.to_string())
}

/// Save a kata (named run-spec) to the user's kata library.
#[tauri::command]
fn save_kata(spec: kata_core::spec::RunSpec) -> Result<(), String> {
    kata_core::katas::save_kata(&spec)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// List the user's kata library: the katas that loaded, and any `*.toml` that
/// would not. The failures are returned rather than dropped so a broken kata
/// shows up as broken instead of silently disappearing.
#[tauri::command]
fn list_katas() -> Result<kata_core::katas::KataListing, String> {
    Ok(kata_core::katas::list_katas())
}

/// Load a single kata by name from the user's kata library.
#[tauri::command]
fn load_kata(name: String) -> Result<kata_core::spec::RunSpec, String> {
    kata_core::katas::load_kata(&name).map_err(|e| e.to_string())
}

/// List all presets from the user's preset library.
#[tauri::command]
fn list_presets() -> Result<Vec<kata_core::presets::Preset>, String> {
    Ok(kata_core::presets::list_presets())
}

/// Save a preset (named prompt body) to the user's preset library.
#[tauri::command]
fn save_preset(name: String, body: String) -> Result<(), String> {
    kata_core::presets::save_preset(&kata_core::presets::Preset { name, body })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Export a kata as a portable bundle directory under the given output path.
/// Bundles into a fresh `<slug>-bundle` subdirectory of the picked folder
/// and uses force=true so re-exporting overwrites cleanly.
#[tauri::command]
fn export_bundle(spec: kata_core::spec::RunSpec, out: String) -> Result<(), String> {
    let workdir = std::path::PathBuf::from(&spec.workdir);
    let roots = kata_core::catalog::DiscoveryRoots::defaults(&workdir);
    let catalog = kata_core::catalog::discover(&roots);
    let dest = std::path::Path::new(&out).join(kata_core::bundle::default_out_dir(&spec));
    kata_core::bundle::bundle(&spec, &catalog, &dest, true).map_err(|e| e.to_string())
}

/// Send the operator's answer to a paused interactive run: write an
/// `answer <id> <json>` line to the engine's stdin (the engine returns it to
/// claude as the ask_user tool result and emits ask.answered).
#[tauri::command]
fn submit_answer(
    control: State<RunControl>,
    run_id: String,
    id: String,
    answers: Vec<Vec<String>>,
) {
    let json = serde_json::to_string(&answers).unwrap_or_else(|_| "[]".into());
    let line = format!("answer {id} {json}\n");
    write_to_run(&control, &run_id, &line);
}

/// Something a line can be written to: a run's engine stdin, or a fake in a test.
trait InputSink {
    fn send(&mut self, bytes: &[u8]);
}

impl InputSink for tauri_plugin_shell::process::CommandChild {
    fn send(&mut self, bytes: &[u8]) {
        let _ = self.write(bytes);
    }
}

/// Write one line to the input of run `run_id` in `table`, and to no other run's.
fn write_line<C: InputSink>(table: &mut RunTable<C>, run_id: &str, line: &str) {
    let Some(run_id) = parse_run_id(run_id) else {
        return;
    };
    if let Some(child) = table.get_mut(run_id).and_then(|r| r.child.as_mut()) {
        child.send(line.as_bytes());
    }
}

/// Check the installed Claude Code before a run starts, with the same function the
/// engine uses, so the Workbench refuses a run the engine would refuse. Blocks for
/// up to the version probe's limit; callers keep it off the UI thread.
fn claude_ready() -> Result<(), String> {
    kata_core::claude::check_installed(&kata_core::claude::program())
        .map(|_| ())
        .map_err(|refusal| refusal.to_string())
}

/// Write one line to the stdin of run `run_id`'s engine, and to no other run's.
fn write_to_run(control: &RunControl, run_id: &str, line: &str) {
    write_line(&mut control.state.lock().unwrap(), run_id, line);
}

/// Send the operator's message to a live run: write a `say <id> <json>` line to that
/// run's engine stdin and to no other run's. The line is built by the engine's own
/// formatter, never here. The engine answers with `message.sent`, `message.read` or
/// `message.refused` on the event channel.
#[tauri::command]
fn send_message(
    control: State<RunControl>,
    run_id: String,
    id: String,
    text: String,
) -> Result<(), String> {
    let line = kata_core::control::say_line(&id, &text)
        .ok_or_else(|| "a message id must be non-empty and contain no whitespace".to_string())?;
    write_to_run(&control, &run_id, &line);
    Ok(())
}

/// Send the operator's verdict on a paused permission check: write a
/// `decide <id> allow|deny [reason]` line to the engine's stdin (the engine
/// returns it to claude as the permission-prompt tool result and emits
/// permission.decided). The reason is free text and must stay on one line, so
/// newlines collapse to spaces before it goes on the wire.
#[tauri::command]
fn submit_decision(
    control: State<RunControl>,
    run_id: String,
    id: String,
    allow: bool,
    message: Option<String>,
) {
    let verdict = if allow { "allow" } else { "deny" };
    let reason = message
        .map(|m| m.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|m| !m.is_empty())
        .map(|m| format!(" {m}"))
        .unwrap_or_default();
    let line = format!("decide {id} {verdict}{reason}\n");
    write_to_run(&control, &run_id, &line);
}

/// Accepts only http and https addresses.
fn web_url(url: &str) -> Result<&str, String> {
    let scheme = url.split_once(':').map_or("", |(s, _)| s);
    if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
        Ok(url)
    } else if scheme.is_empty() {
        Err("only http and https addresses can be opened".to_string())
    } else {
        Err(format!(
            "only http and https addresses can be opened, not {scheme}"
        ))
    }
}

/// Open a web address in the default browser. The webview has no opener permission; it asks here.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = web_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Opens the change's copy folder with `open`, and only when the change is in a copy. `master` is the
/// plugin's own folder for the change, as its state reports it; the webview never names a path.
fn open_copy_with(
    in_copy: bool,
    master: &str,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    if !in_copy {
        return Err("This change has no copy of its own to open.".into());
    }
    open(master)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        // The plugin's click-catching script would forward target="_blank" and Ctrl/Shift-clicked links to
        // a command the webview has no permission for, so it is refused and logs an error. Off; `open_url` opens links.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let live = app.state::<RunControl>().state.lock().unwrap().live();
                if !live.is_empty() {
                    api.prevent_close();
                    close_window(app, close_guard::CloseAnswer::NotAsked);
                }
            }
        })
        .manage(RunControl::default())
        .manage(sdlc_home::HomeMemory::default())
        .manage(Arc::new(history::RunHistory::default()))
        .manage(Arc::new(running::OpenedMarks::default()))
        .setup(|app| {
            let handle = app.handle().clone();
            let step_table = steps::StepTable::new(Arc::new(move |event| {
                let _ = handle.emit(steps::STEP_EVENT, event);
            }));
            app.manage(step_table.clone());
            app.manage(build_host::BuildHost::new(
                Arc::new(PluginTools),
                Arc::new(AppLauncher {
                    app: app.handle().clone(),
                }),
                sdlc::store::workbench_dir().unwrap_or_default(),
                step_table,
            ));
            // Open at the remembered zoom; a failure leaves the window at 100%.
            let saved = zoom::load();
            let applied = app
                .get_webview_window("main")
                .is_some_and(|w| w.set_zoom(saved).is_ok());
            app.manage(zoom::Level(std::sync::Mutex::new(if applied {
                saved
            } else {
                1.0
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            steps::sdlc_stop_step,
            steps::sdlc_steps,
            catalog,
            app_versions,
            sdlc_current_workspace,
            load_spec,
            save_spec,
            validate_spec,
            preview_run,
            run_spec,
            sdlc_run_history,
            sdlc_build_start,
            sdlc_build_continue,
            sdlc_build_state,
            sdlc_change_key,
            sdlc_build_cancel,
            sdlc_build_runs,
            sdlc_preview_change_run,
            sdlc_preview_build,
            sdlc_review_view,
            sdlc_run_change,
            sdlc_review_start,
            sdlc_review_waiting,
            sdlc_running,
            sdlc_close_answer,
            sdlc_mark_opened,
            sdlc_round_offer,
            sdlc_round_plan,
            cancel_run,
            submit_answer,
            send_message,
            submit_decision,
            list_runs,
            load_run,
            save_kata,
            list_katas,
            load_kata,
            list_presets,
            save_preset,
            export_bundle,
            sdlc_settings,
            sdlc_save_settings,
            sdlc_old_checks,
            sdlc_old_checks_seen,
            load_build_layout,
            save_build_layout,
            sdlc_workspaces,
            sdlc_open_workspace,
            sdlc_add_workspace,
            sdlc_remove_workspace,
            sdlc_scan,
            sdlc_context_health,
            sdlc_read_context,
            sdlc_instructions,
            sdlc_missing_folders,
            sdlc_branches,
            sdlc_read_doc,
            sdlc_read_document,
            sdlc_snapshot,
            sdlc_leftovers,
            sdlc_discard,
            sdlc_change_name,
            sdlc_start_change,
            sdlc_triage_change,
            sdlc_naming,
            sdlc_check_scope,
            sdlc_rename_branch,
            sdlc_checkout,
            sdlc_accept,
            sdlc_reject,
            sdlc_run_links,
            sdlc_task_links,
            sdlc_link_run,
            sdlc_wait_run_exit,
            sdlc_build_status,
            sdlc_build_heads,
            sdlc_review_record,
            sdlc_plugin_readiness,
            sdlc_state,
            sdlc_home_list,
            sdlc_home_pick,
            sdlc_home_open,
            sdlc_home_pull_requests,
            sdlc_build_board,
            sdlc_review_standing,
            sdlc_change_state,
            sdlc_open_change,
            sdlc_change_repos,
            sdlc_missing_change_branches,
            sdlc_diff_files,
            sdlc_commit_files,
            sdlc_diff_pair,
            sdlc_diff_base,
            sdlc_checks_view,
            sdlc_declare_done,
            sdlc_pull_requests_view,
            sdlc_copy_removal,
            sdlc_copy_branch,
            sdlc_remove_copy,
            sdlc_open_copy_folder,
            zoom,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// What the relay loop saw next: an event from the engine, the end of its stream or its
/// termination, or a poll tick that passed with nothing. `Event` is a marker; the loop
/// keeps the event itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Next {
    Event,
    Ended,
    Silent,
}

/// What the relay loop does with what it saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// Handle the event as usual.
    Relay,
    /// Keep waiting.
    Wait,
    /// Leave the loop; `result` says whether the run had already reported its result.
    End { result: bool },
}

/// The relay loop's decision, by what it saw, whether the run reported a result and whether
/// its engine process still exists.
fn relay_step(next: Next, result_seen: bool, engine_alive: bool) -> Step {
    match next {
        Next::Event => Step::Relay,
        Next::Ended => Step::End {
            result: result_seen,
        },
        Next::Silent if engine_alive => Step::Wait,
        Next::Silent => Step::End {
            result: result_seen,
        },
    }
}

/// How often the relay loop checks that the engine still exists while its output is quiet.
const RELAY_TICK: std::time::Duration = std::time::Duration::from_secs(2);

/// The `log` event recorded when a run is ended because its engine exited while its output
/// stayed open.
fn outlived_warning(run: u64, pid: u32) -> Value {
    json!({
        "type": "log",
        "level": "warn",
        "message": format!(
            "run {run}: the engine (pid {pid}) exited, but its output stayed open; the run was ended without waiting for it"
        ),
    })
}

/// Whether ending the run on this step records the outlived-output warning: only an end
/// decided on a quiet poll (`Silent`), never one the stream itself reported.
fn warns(next: Next, step: &Step) -> bool {
    next == Next::Silent && matches!(step, Step::End { .. })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn relay_ends_per_table() {
        use Next::*;
        // (next, result seen, engine alive, expected)
        let rows = [
            (Event, true, true, Step::Relay),
            (Event, true, false, Step::Relay),
            (Event, false, true, Step::Relay),
            (Event, false, false, Step::Relay),
            (Ended, true, true, Step::End { result: true }),
            (Ended, true, false, Step::End { result: true }),
            (Ended, false, true, Step::End { result: false }),
            (Ended, false, false, Step::End { result: false }),
            (Silent, true, true, Step::Wait),
            (Silent, true, false, Step::End { result: true }),
            (Silent, false, true, Step::Wait),
            (Silent, false, false, Step::End { result: false }),
        ];
        for (next, seen, alive, expected) in rows {
            assert_eq!(
                relay_step(next, seen, alive),
                expected,
                "{next:?} seen={seen} alive={alive}"
            );
        }
    }

    #[test]
    fn ending_by_engine_exit_records_one_warning() {
        let ev = outlived_warning(7, 4242);
        assert_eq!(ev["type"], "log");
        assert_eq!(ev["level"], "warn");
        let message = ev["message"].as_str().unwrap();
        assert!(message.contains("run 7"), "{message}");
        assert!(message.contains("4242"), "{message}");

        for seen in [true, false] {
            let silent_end = relay_step(Next::Silent, seen, false);
            assert!(warns(Next::Silent, &silent_end));
            assert!(!warns(Next::Silent, &relay_step(Next::Silent, seen, true)));
            for next in [Next::Ended, Next::Event] {
                for alive in [true, false] {
                    assert!(!warns(next, &relay_step(next, seen, alive)));
                }
            }
        }
    }

    /// Held by every test that points HOME at another folder.
    pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// F2: a per-change command whose plugin cannot be found says it could not find where the change
    /// lives, with the readiness message, through the real readiness check.
    #[test]
    fn plugin_not_found_is_a_resolution_error_for_a_change_command_f2() {
        let _guard = ENV_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(format!("kata-f2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let workspace = root.join("ws");
        let empty_home = root.join("home");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&empty_home).unwrap();
        let saved: Vec<_> = ["HOME", "USERPROFILE"]
            .iter()
            .map(|k| (*k, std::env::var_os(k)))
            .collect();
        for (k, _) in &saved {
            std::env::set_var(k, &empty_home);
        }
        let ws = workspace.to_str().unwrap();
        let readiness = ai_sdlc_readiness(Some(ws));
        let direct = change_plugin_dir(ws);
        let through_resolved = resolved(&build_host::ChangeRef {
            workspace: ws.into(),
            system: "demo".into(),
            change: "2026-11-02-greeting".into(),
        });
        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        let _ = std::fs::remove_dir_all(&root);
        let sdlc::plugin::Readiness::Blocked { message, .. } = readiness else {
            panic!("no plugin in the workspace or the home should be blocked, got {readiness:?}");
        };
        let expected = format!("Could not find where this change lives: {message}");
        assert_eq!(direct, Err(expected.clone()));
        assert_eq!(through_resolved.map(|_| ()), Err(expected));
    }

    #[test]
    fn open_copy_folder_opens_only_a_copy() {
        // In a copy: the folder the plugin reports is opened, once.
        let opened = std::cell::RefCell::new(Vec::new());
        let fake = |path: &str| {
            opened.borrow_mut().push(path.to_string());
            Ok(())
        };
        open_copy_with(true, "/ws/.ai-sdlc/copies/c", fake).unwrap();
        assert_eq!(*opened.borrow(), ["/ws/.ai-sdlc/copies/c"]);
        // Not in a copy: the master is the engineer's own checkout, which is not opened, and the reason is said.
        let opened = std::cell::RefCell::new(Vec::new());
        let fake = |path: &str| {
            opened.borrow_mut().push(path.to_string());
            Ok(())
        };
        let err = open_copy_with(false, "/ws/ai-sdlc", fake).expect_err("not a copy");
        assert!(err.contains("copy"), "reason should explain: {err}");
        assert!(opened.borrow().is_empty());
        // The opener's own failure comes back.
        let err = open_copy_with(true, "/x", |_| Err("no such folder".into())).unwrap_err();
        assert_eq!(err, "no such folder");
    }

    #[test]
    fn open_url_refuses_non_web_addresses() {
        for bad in [
            "file:///C:/Windows/notepad.exe",
            "javascript:alert(1)",
            "C:\\x.exe",
        ] {
            let err = web_url(bad).expect_err(bad);
            assert!(err.contains("http"), "reason should explain: {err}");
        }
        assert_eq!(
            web_url("https://github.com/o/r/pull/1"),
            Ok("https://github.com/o/r/pull/1")
        );
        assert_eq!(web_url("http://example.com"), Ok("http://example.com"));
        assert!(web_url("HTTPS://example.com").is_ok());
    }

    #[derive(Default)]
    struct FakeInput(Vec<u8>);

    impl InputSink for FakeInput {
        fn send(&mut self, bytes: &[u8]) {
            self.0.extend_from_slice(bytes);
        }
    }

    fn live_with_input(id: u64) -> LiveRun<FakeInput> {
        LiveRun {
            id,
            workdir: std::path::PathBuf::from(format!("D:/ws/repo{id}")),
            group: Some("build:s/c".into()),
            lane: lane_of(Some("build:s/c")),
            kind: runs::RunKind::Build,
            repo: None,
            child: Some(FakeInput::default()),
        }
    }

    #[test]
    fn send_message_writes_only_to_the_named_run() {
        let mut table = RunTable::<FakeInput>::default();
        table.insert(live_with_input(1));
        table.insert(live_with_input(2));
        let line = kata_core::control::say_line("m1", "Stop editing the parser").unwrap();
        write_line(&mut table, "2", &line);
        let sent = |t: &mut RunTable<FakeInput>, id| {
            t.get_mut(id).unwrap().child.as_ref().unwrap().0.clone()
        };
        assert_eq!(sent(&mut table, 2), line.as_bytes());
        assert!(sent(&mut table, 1).is_empty());
    }

    /// The tests that point `KATA_CLAUDE_BIN` at fake-claude share the process environment.
    static CLAUDE_ENV: Mutex<()> = Mutex::new(());

    /// Run `claude_ready` with `KATA_CLAUDE_BIN` set to the fake-claude beside the test binaries
    /// (`cargo build -p kata-core --bin fake-claude` builds it) and its version set to `version`.
    fn ready_with(version: Option<&str>) -> Result<(), String> {
        let _guard = CLAUDE_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let exe = std::env::current_exe().unwrap();
        let fake = exe
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(format!("fake-claude{}", std::env::consts::EXE_SUFFIX));
        assert!(fake.exists(), "build fake-claude first: {}", fake.display());
        std::env::set_var("KATA_CLAUDE_BIN", &fake);
        match version {
            Some(v) => std::env::set_var("KATA_FAKE_CLAUDE_VERSION", v),
            None => std::env::remove_var("KATA_FAKE_CLAUDE_VERSION"),
        }
        let got = claude_ready();
        std::env::remove_var("KATA_CLAUDE_BIN");
        std::env::remove_var("KATA_FAKE_CLAUDE_VERSION");
        got
    }

    #[test]
    fn run_spec_refuses_too_old_claude() {
        let err = ready_with(Some("2.0.1 (Claude Code)")).unwrap_err();
        assert!(err.contains("2.0.1") && err.contains("2.1.311"), "{err}");
        let err = ready_with(Some("garbage")).unwrap_err();
        assert!(err.contains("could not read"), "{err}");
        assert_eq!(ready_with(None), Ok(()));
    }

    fn live(id: u64) -> LiveRun<()> {
        LiveRun {
            id,
            workdir: std::path::PathBuf::from("D:/ws/app"),
            group: None,
            lane: runs::Lane::Solo,
            kind: runs::RunKind::Solo,
            repo: None,
            child: None,
        }
    }

    // The rename design (R2.4): a live document run of the change (here its spec run) refuses the rename,
    // and the change's live facts carry it, which takes the rename off the offer.
    #[test]
    fn a_live_document_run_refuses_the_rename_and_removes_the_offer() {
        let mut table = RunTable::<()>::default();
        table.insert(LiveRun {
            id: 1,
            workdir: std::path::PathBuf::from("D:/ws/.ai-sdlc/copies/c/ai-sdlc"),
            group: Some("document:s/c".into()),
            lane: runs::Lane::Change {
                key: kata_sdlc::holds::ChangeKey {
                    workspace: kata_sdlc::holds::RepoKey::of(Path::new("D:/ws")),
                    system: "s".into(),
                    change: "c".into(),
                },
                build: false,
            },
            kind: runs::RunKind::Spec,
            repo: None,
            child: None,
        });
        assert!(rename_refusal(&table, "s", "c").is_some());
        let facts = live_facts_of(&table, "s", "c");
        assert!(facts.run_live, "a run of the change is live");
        assert!(!facts.build_live, "it is not a build run");
        // Another change is not affected.
        assert_eq!(rename_refusal(&table, "s", "other"), None);
        assert!(!live_facts_of(&table, "s", "other").run_live);
    }

    #[test]
    fn wait_idle_returns_true_once_the_reader_clears_the_run() {
        let state = Arc::new(Mutex::new(RunTable::<()>::default()));
        state.lock().unwrap().insert(live(3));
        let clearer = state.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            clearer.lock().unwrap().remove(3);
        });
        assert!(wait_idle(
            &state,
            3,
            Duration::from_secs(5),
            Duration::from_millis(10)
        ));
        t.join().unwrap();
    }

    #[test]
    fn wait_idle_returns_false_on_timeout() {
        let state = Arc::new(Mutex::new(RunTable::<()>::default()));
        state.lock().unwrap().insert(live(3));
        assert!(!wait_idle(
            &state,
            3,
            Duration::from_millis(60),
            Duration::from_millis(10)
        ));
    }

    #[test]
    fn wait_idle_ignores_other_live_runs() {
        let state = Arc::new(Mutex::new(RunTable::<()>::default()));
        state.lock().unwrap().insert(live(4));
        assert!(wait_idle(
            &state,
            3,
            Duration::ZERO,
            Duration::from_millis(10)
        ));
    }

    #[test]
    fn wait_idle_is_immediate_with_no_run() {
        let state = Arc::new(Mutex::new(RunTable::<()>::default()));
        assert!(wait_idle(
            &state,
            3,
            Duration::ZERO,
            Duration::from_millis(10)
        ));
    }

    /// F8: every command resolves the plugin the way readiness does, from the workspace folder (the master
    /// path's parent), so a project-scoped plugin there is the one that reads, builds and shows the notice.
    #[test]
    fn commands_resolve_the_same_plugin_as_readiness_f8() {
        // The catalog reads the user scope from HOME; point it at an empty folder so the machine's own
        // plugins cannot answer. Nothing else in this test binary reads HOME.
        let _guard = ENV_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(format!("kata-f8-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let workspace = root.join("ws");
        let master = workspace.join("master");
        let plugin = workspace.join(".claude").join("plugins").join("ai-sdlc");
        std::fs::create_dir_all(master.join("intent")).unwrap();
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::create_dir_all(plugin.join("skills").join("build")).unwrap();
        std::fs::write(
            plugin.join("skills").join("build").join("SKILL.md"),
            "---
name: build
---
",
        )
        .unwrap();
        std::fs::write(
            plugin.join(".claude-plugin").join("plugin.json"),
            r#"{"name":"ai-sdlc","version":"1.1.0"}"#,
        )
        .unwrap();
        let empty_home = root.join("home");
        std::fs::create_dir_all(&empty_home).unwrap();
        let saved: Vec<_> = ["HOME", "USERPROFILE"]
            .iter()
            .map(|k| (*k, std::env::var_os(k)))
            .collect();
        for (k, _) in &saved {
            std::env::set_var(k, &empty_home);
        }

        let readiness = ai_sdlc_readiness(Some(workspace.to_str().unwrap()));
        let resolved = ai_sdlc_dir_in(workspace.to_str().unwrap());

        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        let _ = std::fs::remove_dir_all(&root);
        let sdlc::plugin::Readiness::Ready { plugin: found, .. } = readiness else {
            panic!("the workspace's own plugin should be ready, got {readiness:?}");
        };
        assert_eq!(resolved, Ok(found.dir));
    }

    mod snapshot_target {
        use super::*;
        use sdlc::home::HomeError;
        use std::path::PathBuf;

        fn git(dir: &Path, args: &[&str]) {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {out:?}");
        }

        fn repo(dir: &Path) {
            std::fs::create_dir_all(dir).unwrap();
            git(dir, &["init", "-q", "-b", "main"]);
            git(dir, &["config", "user.name", "Test"]);
            git(dir, &["config", "user.email", "test@example.com"]);
            git(dir, &["config", "commit.gpgsign", "false"]);
            std::fs::write(dir.join("README.md"), "init\n").unwrap();
            git(dir, &["add", "-A"]);
            git(dir, &["commit", "-q", "-m", "init"]);
        }

        fn change_ref(workspace: &Path) -> build_host::ChangeRef {
            build_host::ChangeRef {
                workspace: workspace.to_string_lossy().into_owned(),
                system: "demo".into(),
                change: "2026-11-02-greeting".into(),
            }
        }

        #[test]
        fn leftovers_for_the_workspace_target_are_unchanged() {
            let dir = tempfile::tempdir().unwrap();
            let master = dir.path().join("ai-sdlc");
            repo(&master);
            repo(&dir.path().join("app"));
            repo(&dir.path().join("web"));
            let placed = Placed::Workspace(master.clone());
            let before = snapshot_in(&placed).unwrap();
            assert_eq!(before.folder, master.to_string_lossy());
            std::fs::write(master.join("run.md"), "x").unwrap();
            std::fs::write(dir.path().join("app").join("dirty.txt"), "x").unwrap();
            let l = leftovers_in(&placed, &before, None).unwrap();
            assert_eq!(l.discardable, vec!["run.md"]);
            assert_eq!(l.product_repos_changed, vec!["app"]);
            assert!(l.product_repos_unchecked.is_empty());
        }

        #[test]
        fn discard_for_the_workspace_target_acts_in_the_snapshots_folder() {
            let dir = tempfile::tempdir().unwrap();
            let master = dir.path().join("ai-sdlc");
            repo(&master);
            let placed = Placed::Workspace(master.clone());
            let before = snapshot_in(&placed).unwrap();
            std::fs::write(master.join("run.md"), "x").unwrap();
            discard_in(&placed, &before, &["run.md".into()], None).unwrap();
            assert!(!master.join("run.md").exists());
        }

        #[test]
        fn discard_with_an_unplaceable_change_target_refuses() {
            let dir = tempfile::tempdir().unwrap();
            let master = dir.path().join("ai-sdlc");
            repo(&master);
            let before = snapshot_in(&Placed::Workspace(master.clone())).unwrap();
            std::fs::write(master.join("run.md"), "x").unwrap();
            // A plugin folder with no program: the plugin cannot say where the change lives.
            let program = sdlc::ai_sdlc::Program::locate(&dir.path().join("no-plugin"));
            let target = SnapshotTarget::Change(change_ref(dir.path()));
            let placed = place_target_with(&program, &target);
            assert!(matches!(
                placed,
                Placed::Change {
                    home: Err(HomeError::Unanswered(_)),
                    ..
                }
            ));
            let err = discard_in(&placed, &before, &["run.md".into()], None).unwrap_err();
            assert!(
                err.starts_with("Nothing discarded: Could not find where this change lives"),
                "{err}"
            );
            assert!(master.join("run.md").exists(), "nothing discarded");
            let _: PathBuf = master;
        }
    }

    mod open {
        use super::*;
        use sdlc::ai_sdlc::state::read_state;
        use sdlc::home::ChangeHome;
        use std::path::PathBuf;

        const SYSTEM: &str = "demo";
        const CHANGE: &str = "2026-11-02-greeting";
        const SPEC: &str =
            include_str!("../../../crates/kata-sdlc/tests/ai-sdlc-tools/examples/spec/2/valid.md");
        const PLAN: &str =
            include_str!("../../../crates/kata-sdlc/tests/ai-sdlc-tools/examples/plan/2/valid.md");
        const REVIEW: &str = include_str!(
            "../../../crates/kata-sdlc/tests/ai-sdlc-tools/examples/review/2/valid.md"
        );

        fn git(dir: &Path, args: &[&str]) {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {out:?}");
        }

        fn repo(dir: &Path) {
            std::fs::create_dir_all(dir).unwrap();
            git(dir, &["init", "-q", "-b", "main"]);
            git(dir, &["config", "user.name", "Test"]);
            git(dir, &["config", "user.email", "test@example.com"]);
            git(dir, &["config", "commit.gpgsign", "false"]);
        }

        fn write(master: &Path, file: &str, text: &str) {
            let path = master.join("intent").join(SYSTEM).join(CHANGE).join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }

        fn commit(master: &Path, message: &str) {
            git(master, &["add", "-A"]);
            git(master, &["commit", "-q", "-m", message]);
        }

        fn copy_dir(from: &Path, to: &Path) {
            std::fs::create_dir_all(to).unwrap();
            for entry in std::fs::read_dir(from).unwrap().flatten() {
                let target = to.join(entry.file_name());
                if entry.path().is_dir() {
                    copy_dir(&entry.path(), &target);
                } else {
                    std::fs::copy(entry.path(), target).unwrap();
                }
            }
        }

        /// A stand-in plugin folder: the vendored format program under `tools/`.
        fn plugin(root: &Path) -> PathBuf {
            let dir = root.join("plugin");
            copy_dir(
                &Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../crates/kata-sdlc/tests/ai-sdlc-tools"),
                &dir.join("tools"),
            );
            std::fs::create_dir_all(dir.join(".claude-plugin")).unwrap();
            std::fs::write(
                dir.join(".claude-plugin/plugin.json"),
                r#"{"name":"ai-sdlc","version":"1.1.0"}"#,
            )
            .unwrap();
            dir
        }

        fn ready(plugin: &Path) -> sdlc::plugin::Readiness {
            sdlc::plugin::Readiness::Ready {
                plugin: sdlc::plugin::Plugin {
                    dir: plugin.to_path_buf(),
                    version: "1.1.0".into(),
                    layouts: vec![],
                },
                gh: sdlc::plugin::GhPresence::Present,
            }
        }

        /// The plugin's `state` entry for the change, with the documents that exist.
        fn state_of(
            master: &Path,
            folder: &Path,
            in_copy: bool,
            plan: bool,
        ) -> sdlc::ai_sdlc::state::ChangeState {
            let doc = |exists: bool| {
                format!(
                    r#"{{"exists":{exists},"inHead":{exists},"headStatus":null,"workingStatus":null,"uncommitted":false,"pin":null}}"#
                )
            };
            let json = format!(
                r#"{{"system":"{SYSTEM}","problems":[],"changes":[{{"change":"{CHANGE}","master":{},"folder":{},"inCopy":{in_copy},"title":null,"track":"full",
 "documents":{{"intent":{},"spec":{},"plan":{}}},
 "scenarios":null,"tasks":null,"buildLogs":{{}},"review":{{"committed":0,"draft":"none"}},"fix":null,
 "ready":{{"spec":{{"candidate":true,"stop":null,"accept":[]}},"plan":{{"candidate":false,"stop":"no spec","accept":[]}},"build":{{"candidate":false,"stop":"no plan","accept":[]}},"review":{{"candidate":false,"stop":"no build","accept":[]}},"done":{{"candidate":false,"stop":"no review","accept":[]}},"reject":{{"candidate":true,"stop":null,"accept":[]}}}}}}]}}"#,
                serde_json::to_string(&master.to_string_lossy()).unwrap(),
                serde_json::to_string(&folder.to_string_lossy()).unwrap(),
                doc(true),
                doc(true),
                doc(plan),
            );
            read_state(serde_json::from_str(&json).unwrap())
                .unwrap()
                .changes
                .remove(0)
        }

        struct Fx {
            _dir: tempfile::TempDir,
            checkout: PathBuf,
            copy: PathBuf,
            plugin: PathBuf,
        }

        /// A checkout holding an older version of the change's documents, and a copy whose documents are
        /// committed, with a review, and whose `spec.md` has an uncommitted edit.
        fn fx() -> Fx {
            let dir = tempfile::tempdir().unwrap();
            let checkout = dir.path().join("ai-sdlc");
            let copy = dir.path().join(".ai-sdlc/copies").join(CHANGE);
            repo(&checkout);
            write(&checkout, "intent.md", "older intent from the checkout\n");
            write(&checkout, "spec.md", "older spec from the checkout\n");
            write(&checkout, "plan.md", "older plan from the checkout\n");
            commit(&checkout, "older");
            repo(&copy);
            write(&copy, "intent.md", "the copy's intent\n");
            write(&copy, "spec.md", SPEC);
            write(&copy, "plan.md", PLAN);
            write(&copy, "build/review.md", REVIEW);
            commit(&copy, "documents");
            write(
                &copy,
                "spec.md",
                &format!("{SPEC}\nedited, not committed\n"),
            );
            let plugin = plugin(dir.path());
            Fx {
                _dir: dir,
                checkout,
                copy,
                plugin,
            }
        }

        fn home_of_copy(fx: &Fx, plan: bool) -> ChangeHome {
            let folder = fx.copy.join("intent").join(SYSTEM).join(CHANGE);
            ChangeHome {
                place: sdlc::ai_sdlc::Place {
                    master: fx.checkout.clone(),
                    workspace: fx.checkout.parent().unwrap().to_path_buf(),
                },
                state: state_of(&fx.copy, &folder, true, plan),
                master: fx.copy.clone(),
                folder,
                in_copy: true,
            }
        }

        #[test]
        fn read_doc_never_reads_the_checkout_for_a_copy_change() {
            let fx = fx();
            let home = home_of_copy(&fx, true);
            assert_eq!(
                read_doc_in(&home, "intent").as_deref(),
                Some("the copy's intent\n")
            );
        }

        #[test]
        fn read_doc_returns_uncommitted_edits_in_the_copy() {
            let fx = fx();
            let home = home_of_copy(&fx, true);
            let text = read_doc_in(&home, "spec").unwrap();
            assert!(text.contains("edited, not committed"), "{text}");
        }

        #[test]
        fn read_document_returns_the_text_and_the_parsed_read_from_one_home() {
            let fx = fx();
            let home = home_of_copy(&fx, true);
            let read = read_document_in(&home, &fx.plugin, SYSTEM, "plan");
            assert_eq!(read.text.as_deref(), Some(PLAN));
            assert!(
                matches!(
                    read.parsed,
                    Some(ParsedRead::Read(sdlc::format::ReadResult::Plan { .. }))
                ),
                "{:?}",
                read.parsed
            );
            let intent = read_document_in(&home, &fx.plugin, SYSTEM, "intent");
            assert_eq!(intent.text.as_deref(), Some("the copy's intent\n"));
            assert!(intent.parsed.is_none(), "the intent has no parsed form");
        }

        /// A plugin folder whose format program fails with a message.
        fn failing_plugin(root: &Path) -> PathBuf {
            let dir = root.join("failing-plugin");
            std::fs::create_dir_all(dir.join("tools")).unwrap();
            std::fs::write(
                dir.join("tools/ai-sdlc.ts"),
                "console.error('boom'); process.exit(2);\n",
            )
            .unwrap();
            dir
        }

        /// F4: a program that cannot read a document comes back as a parsed failure carrying its message, and the
        /// document's text is still returned, never a missing document.
        #[test]
        fn read_document_returns_the_programs_message_when_it_cannot_read_a_document() {
            let fx = fx();
            let home = home_of_copy(&fx, true);
            let failing = failing_plugin(fx.plugin.parent().unwrap());
            let read = read_document_in(&home, &failing, SYSTEM, "spec");
            assert!(
                read.text.as_deref().is_some_and(|t| t.contains(SPEC)),
                "{:?}",
                read.text
            );
            match read.parsed {
                Some(ParsedRead::Failed(f)) => assert!(f.message.contains("boom"), "{}", f.message),
                other => panic!("expected a parsed failure, got {other:?}"),
            }
        }

        #[test]
        fn open_change_returns_the_programs_message_when_it_cannot_read_a_document() {
            let fx = fx();
            let home = home_of_copy(&fx, true);
            let failing = failing_plugin(fx.plugin.parent().unwrap());
            let opened = open_change_in(
                &home,
                &failing,
                &ready(&failing),
                sdlc::offer::LiveFacts::default(),
                SYSTEM,
                "spec",
            )
            .unwrap();
            assert!(
                opened.text.as_deref().is_some_and(|t| t.contains(SPEC)),
                "{:?}",
                opened.text
            );
            match opened.parsed {
                Some(ParsedRead::Failed(f)) => assert!(f.message.contains("boom"), "{}", f.message),
                other => panic!("expected a parsed failure, got {other:?}"),
            }
        }

        #[test]
        fn open_change_bundles_one_resolution() {
            let fx = fx();
            let home = home_of_copy(&fx, true);
            let opened = open_change_in(
                &home,
                &fx.plugin,
                &ready(&fx.plugin),
                sdlc::offer::LiveFacts::default(),
                SYSTEM,
                "plan",
            )
            .unwrap();
            assert_eq!(opened.view.state.change, CHANGE);
            assert_eq!(opened.text.as_deref(), Some(PLAN));
            assert!(
                matches!(
                    opened.parsed,
                    Some(ParsedRead::Read(sdlc::format::ReadResult::Plan { .. }))
                ),
                "{:?}",
                opened.parsed
            );
            assert!(
                opened.status.is_some(),
                "the build status is read from the copy"
            );
            let review = opened.review.expect("the review is read from the copy");
            assert!(!review.reviews.is_empty());
            assert!(opened.notices.is_empty(), "{:?}", opened.notices);
        }

        /// F1: a plan written but not committed (a plan run in progress) opens: the status is left out and the
        /// notice says why; the document text is still there.
        #[test]
        fn open_change_with_an_uncommitted_plan_succeeds_with_a_notice_f1() {
            let fx = fx();
            let plan = format!("intent/{SYSTEM}/{CHANGE}/plan.md");
            git(&fx.copy, &["rm", "-q", "--cached", &plan]);
            git(&fx.copy, &["commit", "-q", "-m", "plan not committed"]);
            assert!(fx.copy.join(&plan).is_file());
            let home = home_of_copy(&fx, true);
            let opened = open_change_in(
                &home,
                &fx.plugin,
                &ready(&fx.plugin),
                sdlc::offer::LiveFacts::default(),
                SYSTEM,
                "plan",
            )
            .expect("a failed status read never fails the open");
            assert!(opened.status.is_none());
            assert_eq!(opened.text.as_deref(), Some(PLAN));
            assert!(
                opened
                    .notices
                    .iter()
                    .any(|n| n.part == NoticePart::BuildStatus && n.message.contains("HEAD")),
                "{:?}",
                opened.notices
            );
        }
    }

    #[test]
    fn preview_run_resolves_against_the_specs_workdir() {
        let dir = std::env::temp_dir().join(format!("kata-preview-run-{}", std::process::id()));
        let skill = dir.join(".claude").join("skills").join("preview-probe");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: preview-probe\ndescription: does preview-probe\n---\nbody\n",
        )
        .unwrap();
        // The setup's skills are listed outside the empty room only.
        let mut spec = RunSpec {
            workdir: dir.to_string_lossy().into_owned(),
            ..RunSpec::default()
        };
        spec.auth.bare = false;
        let resolved = preview_run(spec);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            resolved
                .items
                .iter()
                .any(|i| i.id == "project:skill:preview-probe"),
            "items: {:?}",
            resolved.items.iter().map(|i| &i.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn preview_run_reads_the_options_from_the_spec() {
        use kata_core::given::LockReason;
        let dir = std::env::temp_dir().join(format!("kata-preview-opts-{}", std::process::id()));
        // A project-scoped ai-sdlc, so the test never depends on the machine having the plugin installed.
        let plugin = dir.join(".claude").join("plugins").join("ai-sdlc");
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::write(
            plugin.join(".claude-plugin").join("plugin.json"),
            r#"{"name":"ai-sdlc","version":"1.1.0"}"#,
        )
        .unwrap();
        let mut plugins = std::collections::BTreeMap::new();
        plugins.insert("ai-sdlc".to_string(), spec::PluginConfig::default());
        let spec = RunSpec {
            workdir: dir.to_string_lossy().into_owned(),
            plugins,
            given: Some(spec::Given {
                required_plugins: vec!["ai-sdlc".into()],
                ..spec::Given::default()
            }),
            ..RunSpec::default()
        };
        let resolved = preview_run(spec);
        let _ = std::fs::remove_dir_all(&dir);
        let item = resolved
            .items
            .iter()
            .find(|i| i.kind == given::ItemKind::Plugin && i.name == "ai-sdlc")
            .expect("the ai-sdlc plugin is listed");
        assert!(
            matches!(item.lock, Some(LockReason::Required { .. })),
            "{:?}",
            item.lock
        );
    }
}

/// Every long-step command takes part in the step table: it begins a step of its kind, a stop ends the call
/// with its stopped answer, and the entry is gone afterwards. The commands themselves are Tauri commands, so
/// the tests call the functions they delegate to, with a program whose one long call waits to be stopped.
#[cfg(test)]
mod steps_commands {
    use super::*;
    use crate::steps::{StepEvent, StepKind, StepTable};
    use sdlc::accept::{AcceptOutcome, ChangeDocument, RejectOutcome};
    use sdlc::ai_sdlc::{Place, Program};
    use sdlc::copy_removal::RemoveOutcome;
    use sdlc::done::DeclareView;
    use sdlc::plugin::{GhPresence, Plugin, Readiness};
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::Duration;

    const SYSTEM: &str = "demo";
    const CHANGE: &str = "2026-11-01-password-reset";
    const MARKER: &str = r#"{"version":1,"systems":{"demo":{"repos":["app"]}}}"#;

    fn real_program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../crates/kata-sdlc/tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    /// A workspace with a master, a product repository and a change the plugin started in its own copy, with
    /// an intent in it.
    struct Fx {
        _dir: tempfile::TempDir,
        change: build_host::ChangeRef,
    }

    fn fixture() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_path_buf();
        for name in ["ai-sdlc", "app"] {
            let repo = ws.join(name);
            std::fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init", "-q", "-b", "main"]);
            git(&repo, &["config", "user.name", "Test"]);
            git(&repo, &["config", "user.email", "test@example.com"]);
            git(&repo, &["config", "commit.gpgsign", "false"]);
        }
        let master = ws.join("ai-sdlc");
        std::fs::write(master.join(".ai-sdlc.json"), MARKER).unwrap();
        git(&master, &["add", "."]);
        git(&master, &["commit", "-q", "-m", "marker"]);
        std::fs::write(ws.join("app").join("a.txt"), "a").unwrap();
        git(&ws.join("app"), &["add", "."]);
        git(&ws.join("app"), &["commit", "-q", "-m", "init"]);
        let place = Place {
            master,
            workspace: ws.clone(),
        };
        let no_steps = StepTable::new(Arc::new(|_| {}));
        let started = start_change::start_change(
            &real_program(),
            &place,
            "2026-11-01",
            &start_change::StartRequest {
                system: SYSTEM,
                title: "Password reset",
                work_type: "feat",
                scope: "X-1",
                branch: None,
            },
            &no_steps,
            &ws,
        )
        .unwrap();
        let start_change::ChangeStart::Started { copy, .. } = started else {
            panic!("{started:?}");
        };
        let copy = PathBuf::from(copy);
        let folder = copy.join("intent").join(SYSTEM).join(CHANGE);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("intent.md"),
            "---\ntitle: Reset\nsystem: demo\nauthor: t\ndate: 2026-11-01\nstatus: draft\nscope: demo\n---\n\n# Intent: Reset\n",
        )
        .unwrap();
        // Rejecting is refused while the intent has uncommitted changes.
        git(&copy, &["add", "."]);
        git(&copy, &["commit", "-q", "-m", "intent"]);
        Fx {
            _dir: dir,
            change: build_host::ChangeRef {
                workspace: ws.display().to_string(),
                system: SYSTEM.into(),
                change: CHANGE.into(),
            },
        }
    }

    /// The real program for every call except the one `trigger` (a JS condition on `args`) names: that call
    /// writes a marker and waits to be stopped, and ends itself after 60 s so a red test fails, not hangs.
    fn stopping_program(dir: &Path, trigger: &str) -> (Program, PathBuf) {
        let marker = dir.join("stopping.marker");
        let real = real_program().entry;
        let script = format!(
            "import {{ spawnSync }} from 'node:child_process';
import {{ writeFileSync }} from 'node:fs';
const args = process.argv.slice(2);
if ({trigger}) {{
  writeFileSync({marker:?}, 'x');
  setTimeout(() => {{ console.error('the fake was never stopped'); process.exit(3); }}, 60000);
}} else {{
  const r = spawnSync(process.execPath, [{real:?}, ...args], {{ stdio: 'inherit' }});
  process.exit(r.status ?? 2);
}}
",
            marker = marker.display().to_string(),
            real = real.display().to_string(),
        );
        let entry = dir.join("fake-ai-sdlc.mjs");
        std::fs::write(&entry, script).unwrap();
        (
            Program {
                node: "node".into(),
                entry,
            },
            marker,
        )
    }

    fn capturing_steps() -> (StepTable, Arc<Mutex<Vec<StepEvent>>>) {
        let seen: Arc<Mutex<Vec<StepEvent>>> = Arc::default();
        let sink = seen.clone();
        (
            StepTable::new(Arc::new(move |e| sink.lock().unwrap().push(e))),
            seen,
        )
    }

    fn ready() -> Readiness {
        Readiness::Ready {
            plugin: Plugin {
                dir: PathBuf::new(),
                version: "1.1.0".into(),
                layouts: vec![2],
            },
            gh: GhPresence::Present,
        }
    }

    /// Runs `call` with the step table and the fake; once the fake's long call is reached the change's step is
    /// stopped through the table, as the page's Stop does. Returns the call's answer, whether the stop found
    /// a step, and the table.
    fn stopped_during<T>(
        fx: &Fx,
        trigger: &str,
        call: impl FnOnce(&StepTable, &Program, &Arc<Mutex<Vec<StepEvent>>>) -> T,
    ) -> (T, bool, StepTable) {
        let dir = tempfile::tempdir().unwrap();
        let (fake, marker) = stopping_program(dir.path(), trigger);
        let (steps, seen) = capturing_steps();
        let key = build_host::key_of(&fx.change);
        let watcher = {
            let steps = steps.clone();
            std::thread::spawn(move || {
                for _ in 0..1200 {
                    if marker.exists() {
                        return steps.stop(&key);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                false
            })
        };
        let answer = call(&steps, &fake, &seen);
        (answer, watcher.join().unwrap(), steps)
    }

    #[test]
    fn a_stop_gives_the_stopped_outcome_and_leaves_no_entry() {
        let commit = "args[0] === 'commit'";
        let remove = "args[0] === 'change' && args[1] === 'remove'";
        let done = "args[0] === 'run' && args[1] === 'change.done'";

        let fx = fixture();
        let (outcome, stopped, steps) = stopped_during(&fx, commit, |steps, fake, _| {
            accept_in(steps, fake, &fx.change, ChangeDocument::Intent).unwrap()
        });
        assert!(stopped, "accept: the step was not in the table");
        assert!(
            matches!(outcome, AcceptOutcome::Stopped { .. }),
            "{outcome:?}"
        );
        assert!(steps.running().is_empty(), "accept");

        let fx = fixture();
        let control = RunControl::default();
        let (outcome, stopped, steps) = stopped_during(&fx, commit, |steps, fake, _| {
            reject_in(&control, steps, fake, &fx.change).unwrap()
        });
        assert!(
            stopped,
            "reject: the step was not in the table: {outcome:?}"
        );
        assert!(
            matches!(outcome, RejectOutcome::Stopped { .. }),
            "{outcome:?}"
        );
        assert!(steps.running().is_empty(), "reject");

        let fx = fixture();
        let control = RunControl::default();
        let (outcome, stopped, steps) = stopped_during(&fx, remove, |steps, fake, _| {
            remove_copy_in(&control, steps, fake, &fx.change).unwrap()
        });
        assert!(stopped, "remove: the step was not in the table");
        assert!(
            matches!(outcome, RemoveOutcome::Stopped { .. }),
            "{outcome:?}"
        );
        assert!(steps.running().is_empty(), "remove");

        let fx = fixture();
        let (view, stopped, steps) = stopped_during(&fx, done, |steps, fake, seen| {
            let view = declare_in(steps, fake, &ready(), &fx.change);
            // Declare done reports through the step table, under its own kind.
            let seen = seen.lock().unwrap();
            assert!(
                seen.iter().any(|e| e.kind == StepKind::DeclaringDone),
                "{seen:?}"
            );
            view
        });
        assert!(stopped, "declare: the step was not in the table");
        assert!(matches!(view, DeclareView::Stopped { .. }), "{view:?}");
        assert!(steps.running().is_empty(), "declare");
    }

    /// A change that already has a long step is refused by every command, and the program is not asked.
    #[test]
    fn a_busy_change_is_refused_by_every_command() {
        let fx = fixture();
        let dir = tempfile::tempdir().unwrap();
        let (fake, marker) = stopping_program(
            dir.path(),
            "args[0] === 'commit' || args[0] === 'change' || args[0] === 'run'",
        );
        let (steps, _) = capturing_steps();
        let _running = steps
            .begin(build_host::key_of(&fx.change), StepKind::Starting)
            .unwrap();
        let control = RunControl::default();
        assert!(accept_in(&steps, &fake, &fx.change, ChangeDocument::Intent).is_err());
        assert!(reject_in(&control, &steps, &fake, &fx.change).is_err());
        assert!(remove_copy_in(&control, &steps, &fake, &fx.change).is_err());
        assert!(matches!(
            declare_in(&steps, &fake, &ready(), &fx.change),
            DeclareView::CouldNotRun { .. }
        ));
        assert!(!marker.exists(), "the program was asked");
    }
}
