# M6 — Workbench observe pane: real engine path (design)

> Status: approved 2026-06-15. Completes M6 in `ROADMAP.md` (Phase 2 — the Workbench). Predecessor: `docs/superpowers/specs/2026-06-13-m5-workbench-compose-design.md`.

## Goal

Replace the scripted stand-in in the Workbench's run bridge with the real engine path: the Tauri backend spawns the `kata` binary, relays its live JSON-line `KataEvent` stream into the observe pane, and cancels the run gracefully. After M6 the GUI shares the engine's single execution path — it runs exactly what `kata run` runs, with no duplicated orchestration.

## Non-goals (explicit)

- No human-in-the-loop. The run is observe-only by design: the engine drives `claude -p` headless with `--dangerously-skip-permissions`, so a run takes no mid-flight intervention. The only back-channel is a `cancel` line on stdin. Observe + steer / observe + approve are deferred to Phase 5 (M9) and build on this same stdin seam.
- Minimal frontend change only. The engine's streaming `KataEvent` tags (`log`, `assistant.text`, `tool.use`, `tool.result`, `turn`, `run.completed`) already match what the observe pane renders. But the scripted stand-in never emitted three events the real engine does — `run.started` (meta), `run.error`, and `run.cancelled` — and the store treats only `run.completed` as terminal, so an errored or timed-out run would hang in "running". M6 extends the `KataEvent` union and the store's terminal handling to cover those three; the components, the api bridge, and the run-spec/event contract are otherwise unchanged. Status-line badges already come from the spec prop, so `run.started` carries no UI obligation.
- No change to the run-spec format, the catalog, or the `kata run` event protocol. The contract is already in place; M6 only wires the GUI onto it.

## The existing contract (what M6 builds on)

`kata run <specfile>` (in `crates/kata-cli/src/main.rs`) loads the spec, discovers the catalog from `DiscoveryRoots::defaults(cwd)`, runs to completion, and prints one `KataEvent` JSON object per line to stdout. Exit codes from the engine leash: `124` wall-clock timeout, `125` engine-side turn cap, `130` cancel, `2` load/run error, `0` success. The engine already emits `RunCancelled` (then exit 130) when its `CancelToken` flips, and runs RAII cleanup of the disposable plugin-dir on the way out.

## Architecture and data flow

```
ComposePane ──(RunSpec)──▶ run_spec command (Tauri backend, app/src-tauri/src/lib.rs)
                                │
                                ├─ spec::save(RunSpec → <tmp>/kata-run.toml)   [kata-core, in-process]
                                ├─ app.shell().sidecar("kata")
                                │     .args(["run", <tmp .toml path>])
                                │     .current_dir(spec.workdir)               ← project-scoped catalog + run match
                                │     .spawn()  ──▶ (Receiver<CommandEvent>, CommandChild)
                                │
                  reader task:  CommandEvent::Stdout(line)
                                │     └─ parse JSON line → app.emit("kata://event", value)
                                │     CommandEvent::Stderr(line) → relay as a log event
                                │     CommandEvent::Terminated{ code }
                                │           └─ if no terminal event seen → emit synthetic run.error
                                │           └─ delete the temp spec file
                                ▼
                    kata://event ──▶ onRunEvent ──▶ runStore (terminal handling extended)

cancel_run command ──▶ child.write("cancel\n")  ──▶ kata stdin reader flips CancelToken
                                                       └─ engine kills claude, RAII-cleans, emits run.cancelled (130)
                       (fallback: child.kill() if the stdin write fails)
```

## Work area 1 — engine: graceful cancel via stdin

`cmd_run` in `crates/kata-cli/src/main.rs` gains a stdin-reader thread that flips the existing `CancelToken` when it reads a `cancel` line. EOF on stdin is a no-op (plain-CLI use closes stdin). The existing `ctrlc` handler stays for interactive CLI use; both feed the same flag. No change to `kata_core::run::run` — it already emits `RunCancelled` and returns exit 130 when the flag is set.

Shape:

```rust
let flag = cancel.flag();
std::thread::spawn(move || {
    let mut line = String::new();
    let stdin = std::io::stdin();
    while stdin.lock().read_line(&mut line).unwrap_or(0) != 0 {
        if line.trim() == "cancel" {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            break;
        }
        line.clear();
    }
});
```

TDD (`crates/kata-cli/tests/cli_it.rs`): drive `kata run` against the `fake-claude` helper with a stream slow enough to be interrupted, write `cancel\n` to the child's stdin, and assert a `{"type":"run.cancelled"}` line on stdout and exit code 130. This reuses the `KATA_CLAUDE_BIN`/`fake-claude` harness already established in the engine tests.

## Work area 2 — sidecar packaging

The `kata` binary ships as a Tauri sidecar so the packaged app spawns the same engine CI uses.

- `app/src-tauri/Cargo.toml`: add `tauri-plugin-shell = "2"`.
- `app/src-tauri/src/lib.rs`: register `.plugin(tauri_plugin_shell::init())`.
- `app/src-tauri/tauri.conf.json`: declare `bundle.externalBin: ["binaries/kata"]`.
- `app/src-tauri/capabilities/default.json`: grant the sidecar execute permission scoped to `kata` only (Tauri v2 `shell:allow-execute` with the sidecar in scope; exact permission identifier confirmed against the installed plugin version during implementation).
- A copy step that builds the engine and stages the binary where the sidecar loader expects it: `app/src-tauri/binaries/kata-<target-triple>[.exe]`. Implemented as a small Node script (cross-platform; reads the host triple from `rustc -vV`) wired into `package.json` as `predev`/`prebuild` so both `npm run tauri dev` and a packaged build pick up a fresh engine. `app/src-tauri/binaries/` is gitignored.

The target-triple-suffixed name is a Tauri sidecar requirement; the loader resolves `binaries/kata` to `binaries/kata-<triple>` at spawn time. The copy script is the bridge between `cargo build -p kata-cli` (which writes `target/{debug,release}/kata[.exe]`) and that naming.

## Work area 3 — run-bridge rewrite (`app/src-tauri/src/lib.rs`)

Delete `run_script()` and the scripted thread. `run_spec` becomes:

1. `spec::save` the incoming `RunSpec` to a temp `.toml` file (kata-core is already linked in-process). Retain the path for cleanup.
2. `app.shell().sidecar("kata")?.args(["run", &tmp_path]).current_dir(&spec.workdir).spawn()`.
3. Stash the returned `CommandChild` in shared state for `cancel_run`.
4. On the receiver: for each `CommandEvent::Stdout(bytes)`, parse the line as `serde_json::Value` and `app.emit("kata://event", value)`. Relay `Stderr` lines as `{"type":"log","level":"warn","message":...}`. On `Terminated`, if no `run.completed`/`run.error`/`run.cancelled` was seen, emit a synthetic `run.error` carrying the exit code; then delete the temp spec file and drop the child handle.

`RunControl` changes from holding an `AtomicBool` to holding the `CommandChild` (behind a `Mutex`/`Option`), since cancel now writes to the child rather than flipping a flag the worker polls.

`spec.workdir` as the child cwd is deliberate: `kata run` discovers its catalog relative to its process cwd, so spawning in the workdir makes the engine resolve the same project-scoped skills/plugins the compose pane showed for that workdir.

## Work area 4 — cancel command

`cancel_run` writes `cancel\n` to the stored child's stdin. If the write fails (child already gone, or stdin closed), fall back to `child.kill()`. The engine then emits `run.cancelled` and exits 130; that event flows through the same relay. The frontend already shows an optimistic cancelled line and sets a warning state, so the engine's `run.cancelled` event arriving as an event row is acceptable redundancy (noted; not changed in M6).

## Work area 5 — frontend terminal handling (`app/src/lib/events.ts`, `app/src/lib/run.svelte.ts`)

Add `run.started`, `run.error`, and `run.cancelled` to the `KataEvent` union and redefine `StreamEvent` to exclude all three (plus `run.completed`) so the existing row-rendering switches stay exhaustive and untouched. A pure `terminalStateFor(ev): RunState | null` helper maps `run.completed` → success/error, `run.error` → error, `run.cancelled` → warning, else null — unit-tested in isolation. The store's `handle()` uses it: `run.started` is dropped (no row; badges come from the spec), `run.error` pushes an `error`-level log row before going terminal, and any terminal event sets the state and tears down the listener. This is the only frontend code that changes; components are untouched.

## Error and edge handling

- Spawn failure (sidecar missing / not yet built): `run_spec` emits a `run.error` event explaining the engine binary was not found, and returns. The observe pane shows the error state via the existing store path.
- Process terminates without a terminal event (engine crash): the `Terminated` branch synthesizes a `run.error` with the exit code so the UI never hangs in "running".
- Temp spec file is always deleted on `Terminated` and on spawn failure; it lives in the OS temp dir, so a missed delete is reclaimed by the OS.

## Testing strategy

- Engine stdin-cancel: an integration test in `crates/kata-cli/tests/cli_it.rs` against `fake-claude` (deterministic, offline) — the only automated test M6 adds.
- The Tauri bridge is verified by running the app and exercising a real run, per `app/CLAUDE.md` dev tooling (browser fallback still uses the scripted timeline for screenshots; the real path requires `npm run tauri dev` with a built sidecar and an authenticated `claude`). This is manual by necessity — spawning the real engine + `claude` is the opt-in, environment-dependent path the engine smoke test already treats as opt-in.

## Risks / to confirm during implementation

- tauri-plugin-shell stdout line-buffering: confirm `CommandEvent::Stdout` arrives per-line (so each JSON object parses cleanly); if it arrives in arbitrary chunks, buffer and split on newline in the reader.
- Exact Tauri v2 sidecar permission identifier and `externalBin` path resolution for the installed plugin version.
- Windows process-tree teardown on the `kill()` fallback (the claude grandchild). The graceful stdin path avoids this; `kill()` is fallback-only.
