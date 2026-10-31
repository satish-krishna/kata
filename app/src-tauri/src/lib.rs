#![cfg_attr(test, allow(clippy::disallowed_methods))]
mod runs;
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
/// What publishing is doing, one `PublishStep` per event.
const PUBLISH_STEP_EVENT: &str = "sdlc://publish-step";
/// What a stage pass reports, one `StageEvent` per event.
const STAGE_EVENT: &str = "sdlc://stage";

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

/// Start a run: write the spec to a temp file, spawn `kata run` in the spec's
/// workdir as a sidecar, and relay its JSON-line KataEvents over `kata://event`.
/// Returns the run id once spawned; an async task drains stdout for the run's
/// lifetime. `group` (`build:<system>/<change>`) rides next to the spec, never
/// inside it, so the table can tell which runs belong to a build. Every relayed
/// event is wrapped as `{ runId, event }`.
#[tauri::command]
async fn run_spec(
    app: AppHandle,
    control: State<'_, RunControl>,
    spec: RunSpec,
    group: Option<String>,
) -> Result<String, String> {
    // Refuse an old Claude Code before anything is claimed or spawned. The probe
    // blocks, so it runs off the async worker and ahead of the table lock.
    tauri::async_runtime::spawn_blocking(claude_ready)
        .await
        .map_err(|e| e.to_string())??;
    // Hold the table across claim, spawn and insert so two starts cannot both
    // pass the claim.
    let mut table = control.state.lock().unwrap();
    table.claim(Path::new(&spec.workdir), group.as_deref())?;

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

    table.insert(LiveRun {
        id,
        workdir: std::path::PathBuf::from(&spec.workdir),
        group,
        child: Some(child),
    });
    drop(table);
    let state = control.state.clone();

    tauri::async_runtime::spawn(async move {
        let mut terminal_seen = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(v) => {
                        if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
                            if matches!(t, "run.completed" | "run.error" | "run.cancelled") {
                                terminal_seen = true;
                            }
                        }
                        let _ = app.emit(RUN_EVENT, runs::wrap(id, v));
                    }
                    Err(_) => relay_log(&app, id, &bytes),
                },
                CommandEvent::Stderr(bytes) => relay_log(&app, id, &bytes),
                CommandEvent::Terminated(payload) => {
                    if !terminal_seen {
                        let code = payload.code.unwrap_or(-1);
                        let _ = app.emit(
                            RUN_EVENT,
                            runs::wrap(
                                id,
                                json!({
                                    "type": "run.error",
                                    "message": format!("engine exited ({code}) without a result"),
                                }),
                            ),
                        );
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    terminal_seen = true;
                    let _ = app.emit(
                        RUN_EVENT,
                        runs::wrap(id, json!({ "type": "run.error", "message": err })),
                    );
                }
                _ => {}
            }
        }
        let _ = std::fs::remove_file(&tmp);
        // Remove only this run; a newer run keeps its own entry.
        state.lock().unwrap().remove(id);
    });

    Ok(id.to_string())
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
    sdlc::store::save_settings(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_workspaces() -> Vec<sdlc::store::WorkspaceEntry> {
    sdlc::store::load_workspaces()
}

#[tauri::command]
fn sdlc_save_workspaces(workspaces: Vec<sdlc::store::WorkspaceEntry>) -> Result<(), String> {
    sdlc::store::save_workspaces(&workspaces).map_err(|e| e.to_string())
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

/// The changes of a system and the title of each intent, from the folder alone.
#[tauri::command(async)]
fn sdlc_change_names(master: String, system: String) -> Vec<sdlc::changes::ChangeName> {
    sdlc::changes::names(Path::new(&master), &system)
}

/// Starts reading the stage of every change of the system on a background thread and returns the pass
/// id at once; each result goes out on `sdlc://stage`. `first` is read before the others. A pass already
/// running for the window is superseded and reports nothing more.
#[tauri::command]
fn sdlc_read_stages(
    window: tauri::Window,
    passes: State<Arc<StagePasses>>,
    master: String,
    system: String,
    first: Option<String>,
) -> u64 {
    let sink: StageSink = {
        let window = window.clone();
        Arc::new(move |ev| {
            let _ = window.emit(STAGE_EVENT, ev);
        })
    };
    start_pass(
        &passes,
        window.label(),
        sink,
        move |pass, cancelled, emit| {
            let master = Path::new(&master);
            let mut order: Vec<String> = sdlc::changes::names(master, &system)
                .into_iter()
                .map(|n| n.change)
                .collect();
            if let Some(at) = first.and_then(|f| order.iter().position(|c| *c == f)) {
                let moved = order.remove(at);
                order.insert(0, moved);
            }
            let plugin = ai_sdlc_dir(&master.to_string_lossy()).ok();
            let ctx = sdlc::changes::ReadContext::new(plugin.as_deref(), master);
            sdlc::changes::read_stages(&ctx, &system, &order, pass, cancelled, emit);
        },
    )
}

/// One change read in full, for the list row and the change page.
#[tauri::command(async)]
fn sdlc_read_change(
    master: String,
    system: String,
    change: String,
) -> Result<sdlc::changes::ChangeInfo, String> {
    let plugin = ai_sdlc_dir(&master).ok();
    let ctx = sdlc::changes::ReadContext::new(plugin.as_deref(), Path::new(&master));
    sdlc::changes::read_change(&ctx, &system, &change)
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
fn sdlc_branches(master: String) -> sdlc::changes::BranchInfo {
    sdlc::changes::branch_info(Path::new(&master))
}

#[tauri::command(async)]
fn sdlc_read_doc(master: String, system: String, change: String, doc: String) -> Option<String> {
    sdlc::changes::read_doc(Path::new(&master), &system, &change, &doc)
}

/// The spec or plan of a change read by the format program, for the Workbench's list views. An error
/// (no plugin, no Node.js) is the caller's cue to show the document as plain text.
#[tauri::command(async)]
fn sdlc_read_parsed(
    master: String,
    system: String,
    change: String,
    doc: String,
) -> Result<Option<sdlc::format::ReadResult>, String> {
    let plugin = ai_sdlc_dir(&master)?;
    sdlc::changes::read_parsed(&plugin, Path::new(&master), &system, &change, &doc)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_snapshot(master: String) -> Result<sdlc::snapshot::Snapshot, String> {
    sdlc::snapshot::take(Path::new(&master)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_leftovers(
    master: String,
    before: sdlc::snapshot::Snapshot,
    product_repos: Vec<String>,
    build: Option<sdlc::snapshot::BuildScope>,
) -> Result<sdlc::snapshot::Leftovers, String> {
    let repos: Vec<std::path::PathBuf> = product_repos.into_iter().map(Into::into).collect();
    sdlc::snapshot::leftovers(Path::new(&master), &before, &repos, build.as_ref())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_discard(
    master: String,
    before: sdlc::snapshot::Snapshot,
    paths: Vec<String>,
    build: Option<sdlc::snapshot::BuildScope>,
) -> Result<(), String> {
    sdlc::snapshot::discard(Path::new(&master), &before, &paths, build.as_ref())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_start_change(master: String) -> Result<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    sdlc::branch::start_pending(Path::new(&master), now).map_err(|e| e.to_string())
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

/// The branch name the system's setting gives `change`.
#[tauri::command(async)]
fn sdlc_suggest_branch(
    folder: String,
    master_repo: String,
    system: String,
    change: String,
    work_type: String,
) -> Result<String, String> {
    let plugin = ai_sdlc_readiness(Some(&folder));
    let master = Path::new(&folder).join(&master_repo);
    sdlc::branch::suggest_branch(&plugin, &master, &system, &change, &work_type)
        .map_err(|e| e.to_string())
}

/// Rename the pending branch to the engineer's chosen `name` and record it for the change.
#[tauri::command(async)]
fn sdlc_confirm_branch(
    folder: String,
    master_repo: String,
    system: String,
    change: String,
    pending: String,
    name: String,
    work_type: String,
) -> Result<sdlc::branch::FinishOutcome, String> {
    let plugin = ai_sdlc_readiness(Some(&folder));
    sdlc::branch::confirm_branch(
        &plugin,
        Path::new(&folder),
        &master_repo,
        &system,
        &change,
        &pending,
        &name,
        &work_type,
    )
    .map_err(|e| e.to_string())
}

/// What a rename did, for the window.
#[derive(serde::Serialize)]
struct RenameResult {
    old: String,
    new: String,
    repos: Vec<String>,
}

/// Rename the change's branch in every repository that has it, then move the pull requests saved
/// under the old name to the record's left-behind list. Refused while a build run of the change is
/// live, since a run holds the branch checked out.
#[tauri::command(async)]
fn sdlc_rename_branch(
    control: State<'_, RunControl>,
    folder: String,
    workspace_id: String,
    master_repo: String,
    system: String,
    change: String,
    new_name: String,
) -> Result<RenameResult, String> {
    if control
        .state
        .lock()
        .unwrap()
        .group_live(&format!("build:{system}/{change}"))
    {
        return Err("A build run of this change is live. Rename the branch after it ends.".into());
    }
    let plugin = ai_sdlc_readiness(Some(&folder));
    let out = sdlc::branch_record::rename(
        &plugin,
        Path::new(&folder),
        &master_repo,
        &system,
        &change,
        &new_name,
    )
    .map_err(|e| e.to_string())?;
    let found = sdlc::store::load_pr_records()
        .into_iter()
        .find(|r| r.workspace_id == workspace_id && r.system == system && r.change == change);
    if let Some(mut record) = found {
        record.retire(&out.new);
        sdlc::store::save_pr_record(&record).map_err(|e| e.to_string())?;
    }
    Ok(RenameResult {
        old: out.old,
        new: out.new,
        repos: out.repos,
    })
}

/// The repositories whose GitHub branch of the change holds work this machine does not have.
#[tauri::command(async)]
fn sdlc_remote_clashes(
    touched: Vec<sdlc::publish::PublishRepo>,
    master_repo: String,
    system: String,
    change: String,
) -> Result<Vec<sdlc::publish::RemoteClash>, String> {
    let Some(master) = touched.iter().find(|r| r.repo == master_repo) else {
        return Err(format!(
            "{master_repo} is not among the repositories of the change"
        ));
    };
    let branch = sdlc::branch_record::change_branch(Path::new(&master.path), &system, &change)
        .map_err(|e| e.to_string())?;
    sdlc::publish::remote_clashes(
        &sdlc::github::RealHosts::new(&sdlc::github::SystemSource),
        &touched,
        &branch,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_finish_change(
    master: String,
    pending: String,
) -> Result<sdlc::branch::FinishOutcome, String> {
    sdlc::branch::finish_pending(Path::new(&master), &pending).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_checkout(master: String, branch: String) -> Result<(), String> {
    sdlc::branch::checkout(Path::new(&master), &branch).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_decide(
    master: String,
    system: String,
    change: String,
    decision: sdlc::decide::Decision,
    confirmed: bool,
) -> Result<sdlc::decide::DecideOutcome, String> {
    sdlc::decide::apply(Path::new(&master), &system, &change, decision, confirmed)
        .map_err(|e| e.to_string())
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

#[tauri::command]
fn sdlc_link_tasks(links: Vec<sdlc::store::TaskLink>) -> Result<(), String> {
    sdlc::store::append_task_links(&links).map_err(|e| e.to_string())
}

// ---- AI-SDLC mode: the build, the diff, checks and publishing ----

#[tauri::command(async)]
fn sdlc_build_status(
    master: String,
    system: String,
    change: String,
) -> Result<sdlc::build::BuildStatus, String> {
    let plugin = ai_sdlc_dir(&master)?;
    sdlc::build::status(&plugin, Path::new(&master), &system, &change).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_unsaved_rows(
    master: String,
    system: String,
    change: String,
) -> Result<Vec<sdlc::build::UnsavedRows>, String> {
    let plugin = ai_sdlc_dir(&master)?;
    sdlc::build::unsaved_rows(&plugin, Path::new(&master), &system, &change)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_review_record(
    master: String,
    system: String,
    change: String,
) -> Result<Option<sdlc::review::ReviewRecord>, String> {
    let plugin = ai_sdlc_dir(&master)?;
    sdlc::review::record(&plugin, Path::new(&master), &system, &change).map_err(|e| e.to_string())
}

/// The files a review run changed besides the change's review document (none when it kept to it); `before` is the master's dirty files when the run started.
#[tauri::command(async)]
fn sdlc_review_verify(
    master: String,
    system: String,
    change: String,
    since: String,
    before: std::collections::BTreeMap<String, String>,
) -> Vec<String> {
    sdlc::review::verify_run(Path::new(&master), &system, &change, &since, &before)
        .err()
        .unwrap_or_default()
}

#[tauri::command(async)]
fn sdlc_build_prepare(
    folder: String,
    master_repo: String,
    system: String,
    change: String,
    action: sdlc::build::BuildAction,
    continue_with_leftovers: bool,
    pending: Option<String>,
) -> Result<sdlc::start::PrepareOutcome, String> {
    let plugin = ai_sdlc_dir_in(&folder)?;
    sdlc::start::prepare(
        &plugin,
        Path::new(&folder),
        &master_repo,
        &system,
        &change,
        action,
        continue_with_leftovers,
        pending.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_build_participants(
    folder: String,
    master_repo: String,
    system: String,
    change: String,
    pending: Option<String>,
) -> Result<Vec<sdlc::participants::Participant>, String> {
    let plugin = ai_sdlc_dir_in(&folder)?;
    sdlc::participants::participants(
        &plugin,
        Path::new(&folder),
        &master_repo,
        &system,
        &change,
        pending.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_build_settle(start: sdlc::start::BuildStart) -> Result<Vec<String>, String> {
    sdlc::start::settle(&start).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_build_heads(
    folder: String,
    master_repo: String,
    system: String,
    repos: Vec<String>,
    change: String,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    sdlc::start::heads(Path::new(&folder), &master_repo, &system, &repos, &change)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_plugin_readiness(workdir: Option<String>) -> sdlc::plugin::Readiness {
    ai_sdlc_readiness(workdir.as_deref())
}

/// Whether the ai-sdlc plugin that `workdir`'s catalog finds can be used, and where it is.
fn ai_sdlc_readiness(workdir: Option<&str>) -> sdlc::plugin::Readiness {
    let roots = catalog::roots_for_workdir(workdir);
    let found = catalog::discover(&roots);
    let plugin = found.iter().find(|e| {
        e.kind == catalog::EntryKind::Plugin
            && e.name == "ai-sdlc"
            && e.provides.iter().any(|p| p == "skill:build")
    });
    sdlc::plugin::readiness(plugin.map(|e| e.path.as_path()))
}

/// The ai-sdlc plugin folder the format program is read from, or why the build cannot be read. It is
/// found from the workspace folder (the master repository's parent), the same place `sdlc_plugin_readiness`
/// is asked about, so a project-scoped plugin there is the one every command uses.
fn ai_sdlc_dir(master: &str) -> Result<std::path::PathBuf, String> {
    let folder = Path::new(master)
        .parent()
        .and_then(Path::to_str)
        .unwrap_or(master);
    ai_sdlc_dir_in(folder)
}

/// [`ai_sdlc_dir`] for a command that is given the workspace folder itself.
fn ai_sdlc_dir_in(folder: &str) -> Result<std::path::PathBuf, String> {
    match ai_sdlc_readiness(Some(folder)) {
        sdlc::plugin::Readiness::Ready { dir, .. } => Ok(dir),
        sdlc::plugin::Readiness::Missing => Err("the ai-sdlc plugin is not installed".into()),
        sdlc::plugin::Readiness::TooOld { have, need } => Err(format!(
            "the ai-sdlc plugin is version {have}; version {need} or later is needed"
        )),
    }
}

#[tauri::command(async)]
fn sdlc_change_repos(
    folder: String,
    master_repo: String,
    system: String,
    change: String,
) -> Result<Vec<sdlc::publish::ChangeRepo>, String> {
    sdlc::publish::change_repos(Path::new(&folder), &master_repo, &system, &change)
}

#[tauri::command(async)]
fn sdlc_missing_change_branches(
    folder: String,
    master_repo: String,
    system: String,
    change: String,
) -> Result<Vec<String>, String> {
    let plugin = ai_sdlc_dir_in(&folder)?;
    sdlc::participants::missing_change_branches(
        &plugin,
        Path::new(&folder),
        &master_repo,
        &system,
        &change,
    )
    .map_err(|e| e.to_string())
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
fn sdlc_diff_base(repo_path: String) -> Result<sdlc::base::BaseInfo, String> {
    sdlc::base::base_info(Path::new(&repo_path)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_touched_repos(
    folder: String,
    master_repo: String,
    system: String,
    change: String,
) -> Result<Vec<sdlc::publish::PublishRepo>, String> {
    sdlc::publish::touched_repos(Path::new(&folder), &master_repo, &system, &change)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_commit_offenders(
    folder: String,
    master_repo: String,
    system: String,
    change: String,
) -> Result<Vec<sdlc::commits::Offender>, String> {
    sdlc::publish::change_offenders(Path::new(&folder), &master_repo, &system, &change)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_checks_dir() -> String {
    sdlc::checks::checks_dir()
        .map(|d| d.display().to_string())
        .unwrap_or_default()
}

/// The checks file of a system, with the system's repositories and the master as the names a
/// check may target.
fn load_checks(
    folder: &Path,
    master_repo: &str,
    system: &str,
) -> Result<sdlc::checks::ChecksPlan, String> {
    let scan = sdlc::workspace::scan(folder).map_err(|e| e.to_string())?;
    let mut allowed = sdlc::workspace::system_repos(&scan, system);
    if !allowed.iter().any(|r| r == master_repo) {
        allowed.push(master_repo.to_string());
    }
    sdlc::checks::load(system, folder, &allowed).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_checks_load(
    folder: String,
    master_repo: String,
    system: String,
) -> Result<sdlc::checks::ChecksPlan, String> {
    load_checks(Path::new(&folder), &master_repo, &system)
}

#[tauri::command(async)]
fn sdlc_run_checks(
    folder: String,
    master_repo: String,
    system: String,
    repo: sdlc::publish::PublishRepo,
) -> Result<sdlc::checks::RepoChecks, String> {
    let plan = load_checks(Path::new(&folder), &master_repo, &system)?;
    Ok(sdlc::checks::run_repo(
        &plan,
        &repo.repo,
        Path::new(&repo.path),
    ))
}

#[tauri::command(async)]
fn sdlc_gh_signed_in(repos: Vec<sdlc::publish::PublishRepo>) -> Result<String, String> {
    sdlc::publish::signed_in(
        &sdlc::github::RealHosts::new(&sdlc::github::SystemSource),
        &repos,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_gh_origins(repos: Vec<sdlc::publish::PublishRepo>) -> Result<(), String> {
    sdlc::publish::origins(
        &sdlc::github::RealHosts::new(&sdlc::github::SystemSource),
        &repos,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn sdlc_publish(
    app: AppHandle,
    folder: String,
    workspace_id: String,
    master_repo: String,
    system: String,
    change: String,
    repos: Vec<sdlc::publish::PublishRepo>,
) -> sdlc::publish::PublishSummary {
    let plugin = ai_sdlc_readiness(Some(&folder));
    sdlc::publish::publish(
        &sdlc::github::RealHosts::new(&sdlc::github::SystemSource),
        &plugin,
        &master_repo,
        &system,
        &change,
        &repos,
        &mut sdlc::publish::Recorder::stored(&workspace_id, &system, &change),
        &mut |step| {
            let _ = app.emit(PUBLISH_STEP_EVENT, step);
        },
    )
}

/// Whether the change shows as done and with which links, from what is saved. GitHub is asked
/// only when nothing is saved and the build is finished.
#[tauri::command(async)]
fn sdlc_done_view(
    folder: String,
    master_repo: String,
    workspace_id: String,
    system: String,
    change: String,
    build_finished: bool,
) -> Result<sdlc::prs::DoneView, String> {
    sdlc::prs::done_view_for(
        &sdlc::github::RealHosts::new(&sdlc::github::SystemSource),
        Path::new(&folder),
        &master_repo,
        &workspace_id,
        &system,
        &change,
        build_finished,
    )
}

/// Ask GitHub for the state of every saved pull request, save the answers and return the new view.
#[tauri::command(async)]
fn sdlc_refresh_pr_states(
    folder: String,
    master_repo: String,
    workspace_id: String,
    system: String,
    change: String,
    build_finished: bool,
) -> Result<sdlc::prs::DoneView, String> {
    sdlc::prs::refresh_states(
        &sdlc::github::RealHosts::new(&sdlc::github::SystemSource),
        Path::new(&folder),
        &master_repo,
        &workspace_id,
        &system,
        &change,
        build_finished,
    )
}

#[tauri::command(async)]
fn sdlc_pull_requests(
    master_repo: String,
    system: String,
    repos: Vec<sdlc::publish::PublishRepo>,
    change: String,
) -> Result<Vec<sdlc::publish::PrState>, String> {
    sdlc::publish::open_pull_requests(
        &sdlc::github::RealHosts::new(&sdlc::github::SystemSource),
        &master_repo,
        &system,
        &repos,
        &change,
    )
}

/// The stage pass each window is running, so a new start can cancel the one before it.
#[derive(Default)]
struct StagePasses {
    next: AtomicU64,
    live: Mutex<std::collections::HashMap<String, (u64, Arc<std::sync::atomic::AtomicBool>)>>,
}

/// Where a pass sends its events.
type StageSink = Arc<dyn Fn(sdlc::changes::StageEvent) + Send + Sync>;

/// Starts `work` on a background thread as the window's only pass and returns its id at once.
///
/// A pass already running for the window is cancelled first: `work` is asked through its `cancelled`
/// function, and whatever it still emits is dropped before it reaches `sink`. The page also filters by
/// pass id, so the one event that can slip between the check and the send does no harm.
fn start_pass<F>(passes: &Arc<StagePasses>, window: &str, sink: StageSink, work: F) -> u64
where
    F: FnOnce(u64, &dyn Fn() -> bool, &mut dyn FnMut(sdlc::changes::StageEvent)) + Send + 'static,
{
    let id = passes.next.fetch_add(1, Ordering::SeqCst) + 1;
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let before = passes
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(window.to_string(), (id, flag.clone()));
    if let Some((_, old)) = before {
        old.store(true, Ordering::SeqCst);
    }
    let passes = passes.clone();
    let window = window.to_string();
    std::thread::spawn(move || {
        let cancelled = || flag.load(Ordering::SeqCst);
        let mut emit = |ev: sdlc::changes::StageEvent| {
            if !flag.load(Ordering::SeqCst) {
                sink(ev);
            }
        };
        work(id, &cancelled, &mut emit);
        let mut live = passes.live.lock().unwrap_or_else(|e| e.into_inner());
        if live.get(&window).is_some_and(|(current, _)| *current == id) {
            live.remove(&window);
        }
    });
    id
}

/// Relay a non-JSON stdout/stderr line as a warn-level log event.
fn relay_log(app: &AppHandle, run_id: u64, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim();
    if !line.is_empty() {
        let _ = app.emit(
            RUN_EVENT,
            runs::wrap(
                run_id,
                json!({ "type": "log", "level": "warn", "message": line }),
            ),
        );
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
        .manage(RunControl::default())
        .manage(Arc::new(StagePasses::default()))
        .setup(|app| {
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
            catalog,
            load_spec,
            save_spec,
            validate_spec,
            preview_run,
            run_spec,
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
            load_build_layout,
            save_build_layout,
            sdlc_workspaces,
            sdlc_save_workspaces,
            sdlc_scan,
            sdlc_context_health,
            sdlc_read_context,
            sdlc_instructions,
            sdlc_change_names,
            sdlc_read_stages,
            sdlc_read_change,
            sdlc_missing_folders,
            sdlc_branches,
            sdlc_read_doc,
            sdlc_read_parsed,
            sdlc_snapshot,
            sdlc_leftovers,
            sdlc_discard,
            sdlc_start_change,
            sdlc_finish_change,
            sdlc_naming,
            sdlc_check_scope,
            sdlc_suggest_branch,
            sdlc_confirm_branch,
            sdlc_rename_branch,
            sdlc_remote_clashes,
            sdlc_checkout,
            sdlc_decide,
            sdlc_run_links,
            sdlc_task_links,
            sdlc_link_tasks,
            sdlc_link_run,
            sdlc_wait_run_exit,
            sdlc_build_status,
            sdlc_unsaved_rows,
            sdlc_build_prepare,
            sdlc_build_participants,
            sdlc_build_settle,
            sdlc_build_heads,
            sdlc_review_record,
            sdlc_review_verify,
            sdlc_plugin_readiness,
            sdlc_change_repos,
            sdlc_missing_change_branches,
            sdlc_diff_files,
            sdlc_commit_files,
            sdlc_diff_pair,
            sdlc_diff_base,
            sdlc_touched_repos,
            sdlc_commit_offenders,
            sdlc_checks_dir,
            sdlc_checks_load,
            sdlc_run_checks,
            sdlc_gh_signed_in,
            sdlc_gh_origins,
            sdlc_publish,
            sdlc_done_view,
            sdlc_refresh_pr_states,
            sdlc_pull_requests,
            zoom,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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

    #[test]
    fn read_stages_command_supersedes_the_running_pass() {
        use sdlc::changes::StageEvent;
        use std::sync::mpsc;
        let passes = Arc::new(StagePasses::default());
        let seen: Arc<Mutex<Vec<StageEvent>>> = Arc::default();
        let sink: StageSink = {
            let seen = seen.clone();
            Arc::new(move |ev| seen.lock().unwrap().push(ev))
        };
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let (ended_tx, ended_rx) = mpsc::channel::<()>();
        let first = start_pass(
            &passes,
            "main",
            sink.clone(),
            move |pass, _cancelled, emit| {
                emit(StageEvent::Progress {
                    pass,
                    read: 1,
                    total: 2,
                });
                started_tx.send(()).unwrap();
                go_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                // The pass was superseded while it waited, so this one must not reach the page.
                emit(StageEvent::Progress {
                    pass,
                    read: 2,
                    total: 2,
                });
                ended_tx.send(()).unwrap();
            },
        );
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (second_tx, second_rx) = mpsc::channel::<()>();
        let second = start_pass(&passes, "main", sink, move |pass, _cancelled, emit| {
            emit(StageEvent::Done { pass });
            second_tx.send(()).unwrap();
        });
        assert_ne!(first, second);
        go_tx.send(()).unwrap();
        ended_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        second_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                StageEvent::Progress {
                    pass: first,
                    read: 1,
                    total: 2
                },
                StageEvent::Done { pass: second },
            ]
        );
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
            child: None,
        }
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
        static HOME: Mutex<()> = Mutex::new(());
        let _guard = HOME.lock().unwrap();
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
            r#"{"name":"ai-sdlc","version":"0.9.0"}"#,
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
        let resolved = ai_sdlc_dir(master.to_str().unwrap());

        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        let _ = std::fs::remove_dir_all(&root);
        let sdlc::plugin::Readiness::Ready { dir, .. } = readiness else {
            panic!("the workspace's own plugin should be ready, got {readiness:?}");
        };
        assert_eq!(resolved, Ok(dir));
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
            r#"{"name":"ai-sdlc","version":"0.9.0"}"#,
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
