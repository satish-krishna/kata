use kata_core::catalog::{self, CatalogEntry};
use kata_core::spec::{self, RunSpec};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Channel the engine's normalized KataEvents are relayed on to the webview.
const RUN_EVENT: &str = "kata://event";

/// Handle to the in-flight `kata` child, so `cancel_run` can reach it.
#[derive(Default)]
struct RunControl {
    child: Arc<Mutex<Option<CommandChild>>>,
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
    // The engine reads a spec file; serialize this one to a per-process temp path.
    let tmp = std::env::temp_dir().join(format!("kata-workbench-run-{}.toml", std::process::id()));
    spec::save(&tmp, &spec).map_err(|e| e.to_string())?;

    let (mut rx, child) = app
        .shell()
        .sidecar("kata")
        .map_err(|e| format!("sidecar kata: {e}"))?
        .args(["run", &tmp.to_string_lossy()])
        .current_dir(&spec.workdir) // engine discovers its catalog relative to cwd
        .spawn()
        .map_err(|e| format!("spawn kata: {e}"))?;

    *control.child.lock().unwrap() = Some(child);
    let child_slot = control.child.clone();

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
                    let _ = app.emit(RUN_EVENT, json!({ "type": "run.error", "message": err }));
                }
                _ => {}
            }
        }
        let _ = std::fs::remove_file(&tmp);
        *child_slot.lock().unwrap() = None;
    });

    Ok(())
}

/// Relay a non-JSON stdout/stderr line as a warn-level log event.
fn relay_log(app: &AppHandle, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim();
    if !line.is_empty() {
        let _ = app.emit(RUN_EVENT, json!({ "type": "log", "level": "warn", "message": line }));
    }
}

/// Cancel the in-flight run: write a `cancel` line to the engine's stdin so it
/// traps it, kills claude, cleans up, and emits run.cancelled. Falls back to a
/// hard kill if the stdin write fails (child already gone).
#[tauri::command]
fn cancel_run(control: State<RunControl>) {
    let mut slot = control.child.lock().unwrap();
    let still_alive = slot.as_mut().map(|c| c.write(b"cancel\n").is_ok()).unwrap_or(false);
    if !still_alive {
        if let Some(child) = slot.take() {
            let _ = child.kill();
        }
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
            cancel_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
