use kata_core::catalog::{self, CatalogEntry};
use kata_core::spec::{self, RunSpec};
use kata_sdlc as sdlc;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Channel the engine's normalized KataEvents are relayed on to the webview.
const RUN_EVENT: &str = "kata://event";

/// The in-flight `kata` child plus the id of the run that owns it. A stale
/// reader task (a finished run still tearing down) must not clear a newer run's
/// handle, so cleanup is guarded by this id. `id == 0` means no active run.
#[derive(Default)]
struct RunState {
    id: u64,
    child: Option<CommandChild>,
}

/// Shared run control: the active run's state plus a monotonic id source.
#[derive(Default)]
struct RunControl {
    state: Arc<Mutex<RunState>>,
    next_id: AtomicU64,
}

/// User skills/plugins plus the workdir's project scope (if any).
#[tauri::command]
fn catalog(workdir: Option<String>) -> Vec<CatalogEntry> {
    let roots = catalog::roots_for_workdir(workdir.as_deref());
    catalog::discover(&roots)
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
/// Returns once spawned; an async task drains stdout for the run's lifetime.
#[tauri::command]
fn run_spec(app: AppHandle, control: State<RunControl>, spec: RunSpec) -> Result<(), String> {
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

    {
        let mut st = control.state.lock().unwrap();
        st.id = id;
        st.child = Some(child);
    }
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
                        let _ = app.emit(RUN_EVENT, v);
                    }
                    Err(_) => relay_log(&app, &bytes),
                },
                CommandEvent::Stderr(bytes) => relay_log(&app, &bytes),
                CommandEvent::Terminated(payload) => {
                    if !terminal_seen {
                        let code = payload.code.unwrap_or(-1);
                        let _ = app.emit(
                            RUN_EVENT,
                            json!({
                                "type": "run.error",
                                "message": format!("engine exited ({code}) without a result"),
                            }),
                        );
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    terminal_seen = true;
                    let _ = app.emit(RUN_EVENT, json!({ "type": "run.error", "message": err }));
                }
                _ => {}
            }
        }
        let _ = std::fs::remove_file(&tmp);
        // Only clear the handle if this run is still the active one; a newer run
        // may have replaced it while this sidecar was tearing down.
        let mut st = state.lock().unwrap();
        if st.id == id {
            st.child = None;
            st.id = 0;
        }
    });

    Ok(())
}

// ---- AI-SDLC mode: thin wrappers over `kata-sdlc` ----

#[tauri::command]
fn sdlc_settings() -> sdlc::store::Settings {
    sdlc::store::load_settings()
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

#[tauri::command]
fn sdlc_scan(folder: String) -> Result<sdlc::workspace::WorkspaceScan, String> {
    sdlc::workspace::scan(Path::new(&folder)).map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_context_health(
    folder: String,
    master: String,
    system: String,
    repo: String,
) -> sdlc::workspace::ContextState {
    sdlc::workspace::context_health(Path::new(&folder), &master, &system, &repo)
}

#[tauri::command]
fn sdlc_changes(master: String, system: String) -> Vec<sdlc::changes::ChangeInfo> {
    sdlc::changes::list(Path::new(&master), &system)
}

#[tauri::command]
fn sdlc_branches(master: String) -> sdlc::changes::BranchInfo {
    sdlc::changes::branch_info(Path::new(&master))
}

#[tauri::command]
fn sdlc_read_doc(master: String, system: String, change: String, doc: String) -> Option<String> {
    sdlc::changes::read_doc(Path::new(&master), &system, &change, &doc)
}

#[tauri::command]
fn sdlc_snapshot(master: String) -> Result<sdlc::snapshot::Snapshot, String> {
    sdlc::snapshot::take(Path::new(&master)).map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_leftovers(
    master: String,
    before: sdlc::snapshot::Snapshot,
    product_repos: Vec<String>,
) -> Result<sdlc::snapshot::Leftovers, String> {
    let repos: Vec<std::path::PathBuf> = product_repos.into_iter().map(Into::into).collect();
    sdlc::snapshot::leftovers(Path::new(&master), &before, &repos).map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_discard(
    master: String,
    before: sdlc::snapshot::Snapshot,
    paths: Vec<String>,
) -> Result<(), String> {
    sdlc::snapshot::discard(Path::new(&master), &before, &paths).map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_start_change(master: String, base: String) -> Result<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    sdlc::branch::start_pending(Path::new(&master), &base, now).map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_finish_change(
    master: String,
    pending: String,
    base: String,
) -> Result<sdlc::branch::FinishOutcome, String> {
    sdlc::branch::finish_pending(Path::new(&master), &pending, &base).map_err(|e| e.to_string())
}

#[tauri::command]
fn sdlc_checkout(master: String, branch: String) -> Result<(), String> {
    sdlc::branch::checkout(Path::new(&master), &branch).map_err(|e| e.to_string())
}

#[tauri::command]
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

/// Relay a non-JSON stdout/stderr line as a warn-level log event.
fn relay_log(app: &AppHandle, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim();
    if !line.is_empty() {
        let _ = app.emit(
            RUN_EVENT,
            json!({ "type": "log", "level": "warn", "message": line }),
        );
    }
}

/// Cancel the in-flight run: write a `cancel` line to the engine's stdin so it
/// traps it, kills claude, cleans up, and emits run.cancelled. Falls back to a
/// hard kill if the stdin write fails (child already gone).
#[tauri::command]
fn cancel_run(control: State<RunControl>) {
    let mut st = control.state.lock().unwrap();
    let still_alive = st
        .child
        .as_mut()
        .map(|c| c.write(b"cancel\n").is_ok())
        .unwrap_or(false);
    if !still_alive {
        if let Some(child) = st.child.take() {
            let _ = child.kill();
        }
    }
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
fn submit_answer(control: State<RunControl>, id: String, answers: Vec<Vec<String>>) {
    let json = serde_json::to_string(&answers).unwrap_or_else(|_| "[]".into());
    let line = format!("answer {id} {json}\n");
    let mut st = control.state.lock().unwrap();
    if let Some(child) = st.child.as_mut() {
        let _ = child.write(line.as_bytes());
    }
}

/// Send the operator's verdict on a paused permission check: write a
/// `decide <id> allow|deny [reason]` line to the engine's stdin (the engine
/// returns it to claude as the permission-prompt tool result and emits
/// permission.decided). The reason is free text and must stay on one line, so
/// newlines collapse to spaces before it goes on the wire.
#[tauri::command]
fn submit_decision(control: State<RunControl>, id: String, allow: bool, message: Option<String>) {
    let verdict = if allow { "allow" } else { "deny" };
    let reason = message
        .map(|m| m.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|m| !m.is_empty())
        .map(|m| format!(" {m}"))
        .unwrap_or_default();
    let line = format!("decide {id} {verdict}{reason}\n");
    let mut st = control.state.lock().unwrap();
    if let Some(child) = st.child.as_mut() {
        let _ = child.write(line.as_bytes());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(RunControl::default())
        .invoke_handler(tauri::generate_handler![
            catalog,
            load_spec,
            save_spec,
            validate_spec,
            run_spec,
            cancel_run,
            submit_answer,
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
            sdlc_workspaces,
            sdlc_save_workspaces,
            sdlc_scan,
            sdlc_context_health,
            sdlc_changes,
            sdlc_branches,
            sdlc_read_doc,
            sdlc_snapshot,
            sdlc_leftovers,
            sdlc_discard,
            sdlc_start_change,
            sdlc_finish_change,
            sdlc_checkout,
            sdlc_decide,
            sdlc_run_links,
            sdlc_link_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
