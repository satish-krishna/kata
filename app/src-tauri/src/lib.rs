use kata_core::catalog::{self, CatalogEntry};
use kata_core::spec::{self, RunSpec};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Channel the engine's normalized KataEvents are relayed on to the webview.
const RUN_EVENT: &str = "kata://event";

/// Shared cancellation flag for the in-flight run.
#[derive(Default)]
struct RunControl {
    cancel: Arc<AtomicBool>,
}

/// Scripted demo stream (delay_ms, event). Mirrors `runScript` in mock.ts so the
/// packaged app and the browser dev fallback stream the same triage-flaky-test
/// timeline. The full M6 engine (spawn `kata`, relay its JSON-lines) replaces
/// this body; the command surface and event channel stay the same.
fn run_script() -> Vec<(u64, Value)> {
    vec![
        (250, json!({ "type": "log", "level": "info", "message": "assembled plugin-dir: 1 skill, 1 plugin" })),
        (350, json!({ "type": "log", "level": "info", "message": "worktree: ./.kata/wt-3f9a off main" })),
        (500, json!({ "type": "turn", "n": 1 })),
        (250, json!({ "type": "assistant.text", "text": "Reproducing the flake: I'll run the single test in a tight loop and watch for the failure mode." })),
        (700, json!({ "type": "tool.use", "name": "Bash", "input_summary": "for i in $(seq 1 30); do dotnet test --filter AuthTests.LoginExpiry; done" })),
        (1300, json!({ "type": "tool.result", "name": "Bash", "ok": true, "summary": "27 passed / 3 failed — failures at iterations 8, 19, 26" })),
        (500, json!({ "type": "turn", "n": 2 })),
        (250, json!({ "type": "assistant.text", "text": "It fails ~1 in 10 locally. The failures share a timestamp boundary — this smells like a clock-skew race in token expiry." })),
        (800, json!({ "type": "tool.use", "name": "Read", "input_summary": "src/Auth/TokenValidator.cs" })),
        (850, json!({ "type": "tool.result", "name": "Read", "ok": true, "summary": "TokenValidator.cs — 142 lines" })),
        (500, json!({ "type": "turn", "n": 3 })),
        (250, json!({ "type": "assistant.text", "text": "Found it. `IsExpired` compares `DateTime.UtcNow` against an expiry built with `DateTime.Now` upstream — across the DST/second boundary the two clocks disagree and the token reads as expired." })),
        (800, json!({ "type": "tool.use", "name": "Bash", "input_summary": "git -C ./.kata/wt-3f9a diff --stat" })),
        (700, json!({ "type": "tool.result", "name": "Bash", "ok": false, "summary": "no changes — isolation only, as instructed" })),
        (500, json!({ "type": "turn", "n": 4 })),
        (250, json!({ "type": "assistant.text", "text": "Smallest repro: pin the system clock to 23:59:59.6 local and call LoginExpiry once — fails deterministically. Cause: mixed Now/UtcNow in token expiry. I did not change production code." })),
        (600, json!({ "type": "run.completed", "exit_code": 0, "is_error": false, "num_turns": 4, "cost_usd": 0.041, "duration_ms": 48120, "result": "Isolated AuthTests.LoginExpiry flake to a clock-skew race: TokenValidator.IsExpired mixes DateTime.Now (expiry) with DateTime.UtcNow (check). Deterministic repro: pin clock to 23:59:59.6 local. No production code changed." })),
    ]
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

/// Start a run: relay the engine's KataEvents to the webview over `kata://event`.
/// Spawns a worker so the command returns immediately; the worker bails as soon
/// as `cancel_run` flips the shared flag.
#[tauri::command]
fn run_spec(app: AppHandle, control: State<RunControl>, spec: RunSpec) {
    let _ = &spec; // the M6 engine consumes this; the scripted relay does not.
    control.cancel.store(false, Ordering::SeqCst);
    let cancel = control.cancel.clone();
    thread::spawn(move || {
        for (delay, ev) in run_script() {
            thread::sleep(Duration::from_millis(delay));
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            let _ = app.emit(RUN_EVENT, ev);
        }
    });
}

/// Cancel the in-flight run; the worker stops before its next emit.
#[tauri::command]
fn cancel_run(control: State<RunControl>) {
    control.cancel.store(true, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
