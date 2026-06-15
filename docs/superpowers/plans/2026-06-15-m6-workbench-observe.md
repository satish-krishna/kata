# M6 — Workbench observe pane (real engine path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Workbench's scripted run stand-in with the real engine path: the Tauri backend spawns the `kata` binary as a sidecar, relays its live JSON-line `KataEvent` stream into the observe pane, and cancels gracefully via a `cancel` line on the run's stdin.

**Architecture:** Four moving parts. (1) The engine (`kata run`) gains a stdin reader that flips its existing `CancelToken` on a `cancel` line. (2) The frontend store learns the three terminal/meta events the scripted stand-in never sent. (3) The `kata` binary ships as a Tauri sidecar, staged by a build script. (4) The Tauri run-bridge (`app/src-tauri/src/lib.rs`) `spec::save`s the spec to a temp `.toml`, spawns `kata run` in the spec's workdir, and relays its stdout lines onto the `kata://event` channel. The frontend stays presentational except for the store change.

**Tech Stack:** Rust (kata-core/kata-cli, edition 2021), Tauri v2 + `tauri-plugin-shell`, SvelteKit SPA + TypeScript, vitest. Engine tests use the offline `fake-claude` helper via `KATA_CLAUDE_BIN`.

**Spec:** `docs/superpowers/specs/2026-06-15-m6-workbench-observe-design.md`. Read it before starting.

## Environment notes (read first)

- This repo lives on a mount where the agent shell cannot delete/rename files. **Run all `git` commands natively in PowerShell** (e.g. `git -C "D:\Repos\kata" ...`). `cargo` and `npm` run fine from the agent shell.
- Work happens on the `feat/m6` branch (already created; the M6 spec is already committed there).
- The engine locates `claude` via `KATA_CLAUDE_BIN` (defaults to `claude`); tests point it at the `fake-claude` helper. `fake-claude` modes are set with `KATA_FAKE_MODE`: `ok` (default, two turns then result), `sleep` (one line, then sleeps 60s), `fail`, `manyturns`.
- Rust's `std::io::Stdout` is line-buffered, so the engine's `println!`-per-event already flushes each JSON line immediately — no engine change is needed for live streaming.

## File structure

```
crates/kata-cli/
  src/main.rs                 # MODIFY: cmd_run gains a stdin cancel-reader thread
  tests/cli_it.rs             # MODIFY: + test for stdin cancel -> exit 130

app/src/lib/
  events.ts                   # MODIFY: + run.started/run.error/run.cancelled; terminalStateFor()
  events.test.ts              # CREATE: unit tests for terminalStateFor()
  run.svelte.ts               # MODIFY: handle() terminal/meta events

app/
  package.json                # MODIFY: + sidecar / tauri:dev / tauri:build scripts
  scripts/stage-sidecar.mjs   # CREATE: build kata + copy to binaries/kata-<triple>
  src-tauri/Cargo.toml        # MODIFY: + tauri-plugin-shell
  src-tauri/tauri.conf.json   # MODIFY: + bundle.externalBin
  src-tauri/src/lib.rs        # MODIFY: real spawn + relay + graceful cancel
  CLAUDE.md                   # MODIFY: document the real-engine dev command

.gitignore                    # MODIFY: ignore app/src-tauri/binaries/
```

---

## Task 1: Engine — graceful cancel via stdin (kata-cli)

**Files:**
- Modify: `crates/kata-cli/src/main.rs` (`cmd_run`)
- Test: `crates/kata-cli/tests/cli_it.rs`

- [ ] **Step 1: Write the failing test in `crates/kata-cli/tests/cli_it.rs`**

Append this test. It drives `kata run` against `fake-claude` in `sleep` mode (one line, then a long sleep), writes `cancel\n` to the child's stdin after a short delay, and asserts the engine cancels: a `run.cancelled` event and exit code 130. `timeout_secs = 8` is a backstop so a broken implementation fails within 8s instead of hanging 60s.

```rust
#[test]
fn run_cancel_via_stdin_exits_130() {
    use std::io::Write;
    use std::process::Stdio;

    let work = tempfile::tempdir().unwrap();
    let spec = write(work.path(), "c.kata.toml",
        &format!("schema = 1\nname = \"c\"\ntask = \"t\"\nworkdir = \"{}\"\n\n[leash]\ntimeout_secs = 8\n",
            work.path().to_string_lossy().replace('\\', "/")));

    let fake = fake_claude();
    let mut child = kata()
        .arg("run").arg(&spec)
        .env("KATA_CLAUDE_BIN", &fake)
        .env("KATA_FAKE_MODE", "sleep")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    // Give the engine time to spawn fake-claude and enter its run loop.
    std::thread::sleep(std::time::Duration::from_millis(500));
    child.stdin.take().unwrap().write_all(b"cancel\n").unwrap();

    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(130), "stdin cancel should exit 130");
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.lines().any(|l| {
        serde_json::from_str::<serde_json::Value>(l)
            .map(|v| v["type"] == "run.cancelled").unwrap_or(false)
    }), "expected a run.cancelled event, got:\n{stdout}");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kata-cli --test cli_it run_cancel_via_stdin_exits_130`
Expected: FAIL — without stdin handling the `cancel` line is ignored; the run hits the 8s timeout and exits 124 (not 130).

- [ ] **Step 3: Add the stdin cancel-reader thread to `cmd_run` in `crates/kata-cli/src/main.rs`**

In `cmd_run`, immediately after the existing `ctrlc::set_handler(...)` line, add a stdin reader that flips the same cancel flag. Insert:

```rust
    // GUI / programmatic cancel: a `cancel` line on stdin flips the same flag the
    // ctrlc handler uses. EOF (plain CLI use closes stdin) is a no-op.
    let stdin_flag = cancel.flag();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        let mut line = String::new();
        while stdin.lock().read_line(&mut line).unwrap_or(0) != 0 {
            if line.trim() == "cancel" {
                stdin_flag.store(true, Ordering::SeqCst);
                break;
            }
            line.clear();
        }
    });
```

`Ordering` is already imported (`use std::sync::atomic::Ordering;` at the top of the file). `cancel.flag()` returns the shared `Arc<AtomicBool>` (it is already called once for the ctrlc handler just above).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p kata-cli --test cli_it run_cancel_via_stdin_exits_130`
Expected: PASS — the engine reads `cancel`, flips the token, kills fake-claude, emits `run.cancelled`, exits 130 (well under the 8s backstop).

- [ ] **Step 5: Run the full engine test suite + clippy**

Run: `cargo test -p kata-cli && cargo clippy -p kata-cli --all-targets`
Expected: all tests pass, clippy clean.

- [ ] **Step 6: Commit**

```bash
git -C "D:\Repos\kata" add crates/kata-cli/src/main.rs crates/kata-cli/tests/cli_it.rs
git -C "D:\Repos\kata" commit -m "feat(cli): cancel a run via a `cancel` line on stdin"
```

---

## Task 2: Frontend — terminal/meta event handling

**Files:**
- Modify: `app/src/lib/events.ts`
- Create: `app/src/lib/events.test.ts`
- Modify: `app/src/lib/run.svelte.ts`

- [ ] **Step 1: Write the failing unit test in `app/src/lib/events.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { terminalStateFor, type KataEvent } from "./events";

describe("terminalStateFor", () => {
  it("maps run.completed (ok) to success", () => {
    const ev: KataEvent = { type: "run.completed", exit_code: 0, is_error: false, num_turns: 2, cost_usd: 0.02, duration_ms: 100, result: "ok" };
    expect(terminalStateFor(ev)).toBe("success");
  });
  it("maps run.completed (error) to error", () => {
    const ev: KataEvent = { type: "run.completed", exit_code: 1, is_error: true, num_turns: 1, cost_usd: null, duration_ms: 100, result: "boom" };
    expect(terminalStateFor(ev)).toBe("error");
  });
  it("maps run.error to error", () => {
    expect(terminalStateFor({ type: "run.error", message: "timed out" })).toBe("error");
  });
  it("maps run.cancelled to warning", () => {
    expect(terminalStateFor({ type: "run.cancelled" })).toBe("warning");
  });
  it("returns null for streaming events", () => {
    expect(terminalStateFor({ type: "assistant.text", text: "hi" })).toBeNull();
    expect(terminalStateFor({ type: "run.started", spec: "n", model: null, workdir: "/w", isolation: "none" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `app/`): `npm test -- events`
Expected: FAIL — `terminalStateFor` and the `run.started`/`run.error`/`run.cancelled` union members don't exist yet (type + import errors).

- [ ] **Step 3: Extend the union, `StreamEvent`, and add `terminalStateFor` in `app/src/lib/events.ts`**

Replace the union and the two type aliases (lines 6–25) with this. The three new members mirror `kata-core::event::KataEvent`. `StreamEvent` now excludes every non-row event, so `gutterFor`/`variantFor`/`bodyFor` below stay exhaustive and unchanged.

```ts
export type KataEvent =
  | { type: "run.started"; spec: string; model: string | null; workdir: string; isolation: string }
  | { type: "log"; level?: string; message: string }
  | { type: "turn"; n: number }
  | { type: "assistant.text"; text: string }
  | { type: "tool.use"; name: string; input_summary: string }
  | { type: "tool.result"; name: string; ok: boolean; summary: string }
  | {
      type: "run.completed";
      exit_code: number;
      is_error: boolean;
      num_turns: number;
      cost_usd: number | null;
      duration_ms: number;
      result: string;
    }
  | { type: "run.error"; message: string }
  | { type: "run.cancelled" };

/** The terminal event carrying the run summary. */
export type RunSummary = Extract<KataEvent, { type: "run.completed" }>;
/** Everything that renders as a row in the stream (meta + terminal events excluded). */
export type StreamEvent = Exclude<
  KataEvent,
  { type: "run.started" | "run.completed" | "run.error" | "run.cancelled" }
>;

/** Terminal run state for an event, or null if the event is a streaming row. */
export function terminalStateFor(ev: KataEvent): RunState | null {
  switch (ev.type) {
    case "run.completed": return ev.is_error ? "error" : "success";
    case "run.error": return "error";
    case "run.cancelled": return "warning";
    default: return null;
  }
}
```

`RunState` is already declared below this block (`export type RunState = ...`); `terminalStateFor` references it fine since it is a module-level type.

- [ ] **Step 4: Run the unit test to verify it passes**

Run (from `app/`): `npm test -- events`
Expected: PASS (5 assertions).

- [ ] **Step 5: Update the store's `handle()` in `app/src/lib/run.svelte.ts`**

Replace the `handle` function (lines 23–31) with a switch that drops the `run.started` meta event, surfaces `run.error` as a log row, records the summary on `run.completed`, and tears down on any terminal event. Also add `terminalStateFor` to the existing events import.

Change the import on line 5 from:
```ts
import type { KataEvent, StreamEvent, RunSummary, RunState } from "./events";
```
to:
```ts
import type { KataEvent, StreamEvent, RunSummary, RunState } from "./events";
import { terminalStateFor } from "./events";
```

Replace `handle`:
```ts
function handle(ev: KataEvent) {
  switch (ev.type) {
    case "run.started":
      return; // meta only; the status badges come from the spec
    case "run.completed":
      runStore.summary = ev;
      break;
    case "run.error":
      runStore.events.push({ type: "log", level: "error", message: ev.message });
      break;
    case "run.cancelled":
      break;
    default:
      runStore.events.push(ev); // streaming row
      return;
  }
  const terminal = terminalStateFor(ev);
  if (terminal) {
    runStore.state = terminal;
    teardown();
  }
}
```

In the `default` arm, `ev` narrows to `StreamEvent`, so `runStore.events.push(ev)` type-checks.

- [ ] **Step 6: Type-check and run the full frontend test suite**

Run (from `app/`): `npm run check && npm test`
Expected: `svelte-check` reports 0 errors; vitest passes.

- [ ] **Step 7: Commit**

```bash
git -C "D:\Repos\kata" add app/src/lib/events.ts app/src/lib/events.test.ts app/src/lib/run.svelte.ts
git -C "D:\Repos\kata" commit -m "feat(app): handle run.started/error/cancelled terminal events in the store"
```

---

## Task 3: Sidecar packaging (config + stage script)

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/tauri.conf.json`
- Create: `app/scripts/stage-sidecar.mjs`
- Modify: `app/package.json`
- Modify: `.gitignore`

This task wires the build so `kata` is available as a sidecar; the bridge code in Task 4 consumes it. There is no unit test — verification is a successful stage + compile.

- [ ] **Step 1: Add `tauri-plugin-shell` to `app/src-tauri/Cargo.toml`**

Under `[dependencies]`, after the `tauri-plugin-dialog = "2"` line, add:
```toml
tauri-plugin-shell = "2"
```

- [ ] **Step 2: Declare the sidecar in `app/src-tauri/tauri.conf.json`**

In the `"bundle"` object, add an `externalBin` array (place it right after `"active": true,`):
```json
    "externalBin": ["binaries/kata"],
```
The bundler resolves `binaries/kata` to `binaries/kata-<target-triple>[.exe]` at build time; the next step stages that file.

- [ ] **Step 3: Create the stage script `app/scripts/stage-sidecar.mjs`**

```js
// Builds the kata engine and stages it as a Tauri sidecar binary named
// kata-<target-triple>[.exe] under src-tauri/binaries/. Pass --release to
// build/stage the release profile (used by tauri:build); default is debug.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const profile = process.argv.includes("--release") ? "release" : "debug";
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(appDir, "..");

// Host target triple from rustc -vV (the line `host: <triple>`).
const vv = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const triple = vv.split("\n").find((l) => l.startsWith("host:")).slice(5).trim();
const ext = process.platform === "win32" ? ".exe" : "";

// Build the engine.
const buildArgs = ["build", "-p", "kata-cli"];
if (profile === "release") buildArgs.push("--release");
execFileSync("cargo", buildArgs, { cwd: repoRoot, stdio: "inherit" });

// Copy target/<profile>/kata -> src-tauri/binaries/kata-<triple>.
const src = join(repoRoot, "target", profile, `kata${ext}`);
const destDir = join(appDir, "src-tauri", "binaries");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, `kata-${triple}${ext}`);
copyFileSync(src, dest);
console.log(`staged sidecar: ${dest}`);
```

- [ ] **Step 4: Add npm scripts to `app/package.json`**

In `"scripts"`, replace the `"tauri": "tauri",` line with these four lines (the convenience commands stage the sidecar first so the bundler/dev loader finds it):
```json
    "tauri": "tauri",
    "sidecar": "node scripts/stage-sidecar.mjs",
    "tauri:dev": "node scripts/stage-sidecar.mjs && tauri dev",
    "tauri:build": "node scripts/stage-sidecar.mjs --release && tauri build",
```

- [ ] **Step 5: Ignore the staged binaries in `.gitignore`**

Append to the repo-root `.gitignore`:
```
app/src-tauri/binaries/
```

- [ ] **Step 6: Stage the sidecar and verify it builds**

Run (from `app/`): `npm run sidecar`
Expected: prints `staged sidecar: .../app/src-tauri/binaries/kata-<triple>[.exe]` and the file exists.

Then confirm the backend compiles with the new dependency (Task 4 adds the code that uses it; here we only confirm the crate resolves):
Run (from `app/src-tauri/`): `cargo build`
Expected: compiles (the plugin is a dependency but not yet wired — that's Task 4).

- [ ] **Step 7: Commit**

```bash
git -C "D:\Repos\kata" add app/src-tauri/Cargo.toml app/src-tauri/tauri.conf.json app/scripts/stage-sidecar.mjs app/package.json app/src-tauri/Cargo.lock .gitignore
git -C "D:\Repos\kata" commit -m "build(app): ship the kata engine as a Tauri sidecar"
```

(If `app/src-tauri/Cargo.lock` did not change or is not tracked, omit it from the `add`.)

---

## Task 4: Run-bridge rewrite — real spawn + relay + graceful cancel

**Files:**
- Modify: `app/src-tauri/src/lib.rs`

This replaces the scripted stand-in (`run_script`, the scripted thread in `run_spec`, the `AtomicBool` in `RunControl`, and the flag-flip `cancel_run`) with the real engine path. No automated test — the bridge spawns real processes; verify by build + manual run (Task 5).

- [ ] **Step 1: Replace the imports and `RunControl` at the top of `app/src-tauri/src/lib.rs`**

Replace lines 1–18 (from `use kata_core::...` through the end of the `RunControl` struct) with:

```rust
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
```

- [ ] **Step 2: Delete the `run_script` function**

Remove the entire `run_script()` function (the `fn run_script() -> Vec<(u64, Value)> { ... }` block with the scripted timeline). The `catalog`, `load_spec`, `save_spec`, and `validate_spec` commands stay exactly as they are.

- [ ] **Step 3: Replace `run_spec` and `cancel_run` with the real engine path**

Replace both `run_spec` and `cancel_run` (everything from `#[tauri::command]\nfn run_spec(...)` through the end of `fn cancel_run(...)`) with:

```rust
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
                        let _ = app.emit(RUN_EVENT, json!({
                            "type": "run.error",
                            "message": format!("engine exited ({code}) without a result"),
                        }));
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
    let still_alive = slot.as_ref().map(|c| c.write(b"cancel\n").is_ok()).unwrap_or(false);
    if !still_alive {
        if let Some(child) = slot.take() {
            let _ = child.kill();
        }
    }
}
```

- [ ] **Step 4: Register the shell plugin in the builder**

In `pub fn run()`, add the shell plugin next to the dialog plugin. Change:
```rust
        .plugin(tauri_plugin_dialog::init())
```
to:
```rust
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
```
The `invoke_handler!` list and `manage(RunControl::default())` stay unchanged (command names are identical).

- [ ] **Step 5: Build the backend and lint**

Run (from `app/src-tauri/`): `cargo build && cargo clippy --all-targets`
Expected: compiles clean. No unused-import warnings (the old `AtomicBool`/`Ordering`/`thread`/`Duration` imports were removed in Step 1).

- [ ] **Step 6: Commit**

```bash
git -C "D:\Repos\kata" add app/src-tauri/src/lib.rs
git -C "D:\Repos\kata" commit -m "feat(app): spawn the kata engine and relay live events; graceful cancel"
```

---

## Task 5: Docs + end-to-end verification

**Files:**
- Modify: `app/CLAUDE.md`

- [ ] **Step 1: Document the real-engine dev command in `app/CLAUDE.md`**

In the "Dev / review (browser without the native app)" section, after the existing run-bridge bullet, add:

```markdown
- The real engine path runs under Tauri only: `npm run tauri:dev` stages the `kata` sidecar (builds `kata-cli`, copies it to `src-tauri/binaries/kata-<target-triple>`) then launches the desktop app, which spawns `kata run` and relays its live JSON-lines. `npm run dev` (browser) keeps the scripted `mock.ts` timeline for screenshots. A real run needs an authenticated `claude` on PATH.
```

- [ ] **Step 2: Commit the docs**

```bash
git -C "D:\Repos\kata" add app/CLAUDE.md
git -C "D:\Repos\kata" commit -m "docs(app): document the real-engine tauri:dev path"
```

- [ ] **Step 3: Full workspace verification (automated)**

Run from the repo root: `cargo test --workspace && cargo clippy --all-targets`
Run from `app/`: `npm run check && npm test`
Expected: all green. This is the automated gate; the steps below are the manual end-to-end check.

- [ ] **Step 4: Manual end-to-end run (requires an authenticated `claude`)**

Run (from `app/`): `npm run tauri:dev`
In the app: compose a tiny spec (a real `workdir`, a trivial task like "list the files in this directory and stop"), press **Run**. Confirm the observe pane streams live `run.started` → `turn`/`assistant.text`/`tool.use`/`tool.result` → `run.completed`, and the summary card shows a real exit code / turns / cost / duration.

- [ ] **Step 5: Manual cancel check**

Start another run with a longer task, press **Cancel** mid-run. Confirm the run stops promptly, the status line goes to "Stopped" (warning), and the temp spec file (`%TEMP%/kata-workbench-run-<pid>.toml`) is gone afterward.

- [ ] **Step 6: Update the roadmap M6 checkboxes**

In `ROADMAP.md`, mark M6 and its two remaining sub-items done: change the `- [~] **M6 ...` line to `- [x]`, and the two `- [~]` sub-bullets (spawn `kata run` / cancel button) to `- [x]`. Commit:
```bash
git -C "D:\Repos\kata" add ROADMAP.md
git -C "D:\Repos\kata" commit -m "docs(roadmap): M6 complete — real engine path wired"
```

---

## Definition of done

- `kata run` cancels on a `cancel` stdin line (exit 130, `run.cancelled` emitted) — covered by `run_cancel_via_stdin_exits_130`.
- The store handles `run.started`/`run.error`/`run.cancelled`; an errored/timed-out run reaches a terminal state — `terminalStateFor` unit-tested.
- `npm run tauri:dev` stages the sidecar and the app drives a real `claude -p` run, streaming live events and a real summary.
- Cancel stops the run gracefully and the temp spec file is cleaned up.
- `cargo test --workspace`, `cargo clippy --all-targets`, `npm run check`, and `npm test` are all green.

## Risks / confirm during implementation

- **Shell-plugin stdout buffering:** the relay assumes `CommandEvent::Stdout` arrives one JSON object per line. The plugin line-buffers by default, so this holds; if a line ever arrives split, buffer per-child and split on `\n` before parsing.
- **Sidecar permission scope:** backend `app.shell().sidecar(...)` is not gated by capability permissions (those gate the JS API), so no `capabilities/default.json` change is planned. If `spawn` fails at runtime with a scope/permission error on the installed plugin version, add `"shell:allow-execute"` to the capability and a sidecar entry to the shell scope.
- **Windows kill fallback:** the graceful stdin path is primary; `child.kill()` is only the write-failure fallback and may leave a claude grandchild briefly — acceptable for M6.
