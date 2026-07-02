# Consuming Kata from another application

This guide is for developers embedding Kata in their own software — a GUI, an orchestrator, a CI step, a service. It is not about *authoring* run-specs (see the root `README.md`); it is about *driving* a run and observing it from your own code.

There are two integration modes. Pick by language first, then by how much you want to own.

| | Out-of-process | In-process |
|---|---|---|
| **Who** | Any language | Rust only |
| **How** | Spawn the `kata` binary, read JSON-line events | Depend on the `kata-core` crate, call `run()` |
| **You depend on** | The run-spec + event protocol (language-neutral) | The `kata_core` Rust API |
| **Interactive runs** | Fully supported, nothing extra | Supported only if you spawn `kata` for it (see [Interactive](#interactive-runs)) |
| **Use when** | You are not Rust, or you want process isolation | You are Rust and want the pure operations in-process |

**The two things that are contractual** — stable across languages and versions — are the **run-spec** (what to run) and the **event protocol** (what comes back). The Rust API is the reference implementation of those contracts, not itself a frozen surface (pre-1.0; expect it to move). If you can, depend on the contracts, not the crate.

---

## Out-of-process (any language)

This is the universal path, and the one the Kata Workbench itself uses. Your program spawns `kata run <spec>` in the spec's working directory and treats it as a black box that emits one JSON event per line on stdout.

### 1. Get the binary

Build it from the workspace (`cargo build --release -p kata-cli` produces `target/release/kata`) and put it on `PATH`. A real run needs an authenticated `claude` on `PATH` as well — Kata drives `claude -p`, it does not replace it.

### 2. Write a run-spec

A run-spec is one TOML (or JSON) file describing the job. Minimal:

```toml
schema = 1
name = "triage"
task = "Read the failing test in tests/auth_it.rs and fix the bug it exposes. Do not touch unrelated files."
workdir = "/path/to/repo"

[leash]
max_turns = 30
timeout_secs = 1800
```

See [Run-spec reference](#run-spec-reference) for every field. Validate before running: `kata validate triage.toml` (exit 0 = valid; exit 1 = invalid with reasons on stderr; exit 2 = could not load/parse).

### 3. Run it and read events

```
kata run triage.toml
```

stdout is a stream of newline-delimited JSON objects, each an event. stderr carries the transcript path and any human-readable claude noise. The process exit code is the leash outcome (see [Exit codes](#exit-codes)).

Your loop is: read a line, parse JSON, switch on `type`.

### The event protocol

Every event is a JSON object with a `type` field. Fields below are exactly as serialized.

| `type` | Fields | Meaning |
|---|---|---|
| `run.started` | `spec`, `model`, `workdir`, `isolation`, `worktree?`, `branch?` | Run began. `worktree`/`branch` present only under worktree isolation. |
| `log` | `level`, `message` | Engine log line (`info` / `warn`). |
| `assistant.text` | `text` | A chunk of the agent's assistant-visible text. |
| `tool.use` | `name`, `input_summary` | The agent invoked a tool. |
| `tool.result` | `name`, `ok`, `summary` | A tool returned. `ok` is false on tool error. |
| `turn` | `n` | The nth assistant turn began (the turn counter the `max_turns` leash counts). |
| `ask.requested` | `id`, `questions[]` | The agent is paused, asking the operator. Interactive runs only. See [Interactive](#interactive-runs). |
| `ask.answered` | `id`, `answers[][]` | The operator's answer was delivered (echo, for your transcript). |
| `run.diff` | `worktree`, `branch`, `files[]`, `insertions`, `deletions` | Worktree diff summary, emitted just before the terminal event under worktree isolation. |
| `run.completed` | `exit_code`, `is_error`, `num_turns`, `cost_usd?`, `duration_ms`, `result?` | Terminal: the run finished on its own. |
| `run.error` | `message`, `exit_code` | Terminal: the run was stopped by the leash or failed. |
| `run.cancelled` | `exit_code` | Terminal: the run was cancelled. |

Exactly one terminal event (`run.completed` / `run.error` / `run.cancelled`) ends every stream. `ask.*` events appear only when the spec sets `[interactive] enabled = true`.

### The control channel (stdin)

The engine reads control lines on its stdin. Two commands:

- `cancel` — stop the run. The engine kills claude, cleans up (worktree, temp kit), emits `run.cancelled`, and exits 130. EOF on stdin is a no-op, so a plain CLI invocation that closes stdin runs normally.
- `answer <id> <json>` — answer a pending `ask.requested`. `<id>` is the id from the event; `<json>` is the answer matrix (see below). Ignored unless it matches the pending question's id.

### Exit codes

The process exit code is the leash outcome, and part of the contract — CI and orchestrators branch on it.

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | (CLI) spec validation failed. |
| 2 | (CLI) could not load/parse the spec, or an engine error. |
| 122 | Budget ceiling reached (`leash.max_budget_usd`). Spend may overshoot by up to one turn. |
| 123 | Answer deadline exceeded (`interactive.answer_timeout_secs`). Distinct from 124 so logs can tell "nobody answered" from "work ran too long". |
| 124 | Wall-clock timeout (`leash.timeout_secs`, or the 1800s default when unset). |
| 125 | Turn cap reached (`leash.max_turns`). Only reachable when the cap is set. |
| 130 | Cancelled. |

---

## Interactive runs

When the spec sets `[interactive] enabled = true`, the agent gets an `ask_user` tool and can pause at a genuine decision fork. **You do not implement anything MCP-related** — Kata owns the `ask_user` tool, its schema, the server, and the bridge. Your only job is to render the question and send back an answer.

The loop:

1. You receive `ask.requested` with an `id` and a list of `questions`.
2. You render the questions in your UI and collect the operator's choices.
3. You write `answer <id> <matrix>` to the engine's stdin.
4. The engine unblocks the agent and emits `ask.answered` as an echo.

### Question shape

Each entry in `questions[]`:

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"confirm"` \| `"select"` \| `"text"` | Confirm = two-option inline; select = radio (or checkbox with `multi_select`); text = free-form. |
| `header` | string | Short label. |
| `question` | string | The full question. |
| `options` | `[{label, description?}]` | Choices, for `select`. Absent/empty for `text`. |
| `multi_select` | bool | `select` only: allow multiple. |
| `optional` | bool | The operator may answer with nothing. |
| `placeholder` | string? | Hint for `text`. |

### Answer matrix

The answer is a `string[][]` — **one inner array per question, in order**:

- `select` / `confirm`: the chosen option label(s). `["JWT"]` for single; `["JWT","OAuth"]` for `multi_select`.
- `text`: a single-element array with the typed string, `["use a refresh token"]`.
- optional-and-skipped: an empty array, `[]`.

Example: two questions (a `select` and a `text`), answered:

```
answer q1 [["JWT"],["use a refresh token"]]
```

If `answer_timeout_secs` is set and no answer arrives in time, the run is reaped with exit 123. Unset means wait indefinitely (until answered or cancelled); the wall-clock leash excludes time spent waiting on an answer.

---

## In-process (Rust)

Depend on `kata-core` and call the engine directly. Until Kata is published to a registry, use a git dependency:

```toml
[dependencies]
kata-core = { git = "https://github.com/satish-krishna/kata", package = "kata-core" }
serde_json = "1"
```

### The public surface

The crate root re-exports the intended API; everything else is `pub(crate)` and off-limits.

- `RunSpec`, `validate`, and the `spec` module — the run-spec contract (load/save/validate).
- `KataEvent`, `Question`, `QuestionKind`, `QuestionOption`, and the `event` module — the event protocol.
- `run`, `answer_channel`, `Answer`, `AnswerRx`, `CancelToken`, `RunOutcome`, `RunError` — driving a run.
- The `catalog`, `bundle`, `worktree`, `history`, `katas`, `presets` modules — the pure operations the GUI and CLI also build on.

### Driving a run

`run()` takes the spec, the discovered catalog, a cancel token, an answer inbox, and an `FnMut(KataEvent)` sink. It blocks until the run ends and returns the outcome.

```rust
use kata_core::{answer_channel, run, CancelToken};

let spec = kata_core::spec::load("triage.toml".as_ref())?;
let catalog = kata_core::catalog::discover(
    &kata_core::catalog::roots_for_workdir(Some(&spec.workdir)));

let cancel = CancelToken::new();          // call cancel.cancel() from another thread to stop
let (_answer_tx, answers) = answer_channel(); // non-interactive: leave the sender unused

let outcome = run(&spec, &catalog, &cancel, &answers, |event| {
    // your sink: forward to a channel, serialize to a socket, update UI state...
    println!("{}", serde_json::to_string(&event).unwrap());
})?;

std::process::exit(outcome.exit_code);
```

For an interactive run, keep `_answer_tx`: when your sink sees `KataEvent::AskRequested { id, .. }`, send `Answer { id, answers }` on it, where `answers` is the same `Vec<Vec<String>>` matrix described above.

### The one caveat: interactive in-process

The `ask_user` MCP server is spawned by claude as `<current exe> mcp-ask`. When you link `run()` into your own binary, "current exe" is *your* binary — which has no `mcp-ask` subcommand — so interactive runs cannot reach the operator.

The clean answer: **for interactive runs, spawn the `kata` binary** (the out-of-process path) rather than linking `run()`. Link the crate for the pure operations and non-interactive runs; rent the `kata` process when you need a human in the loop. (Serving `mcp-ask` from your own `main` is possible but rarely worth it.)

---

## Run-spec reference

Every field, with its default. Only `name`, `task`, and `workdir` are required.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `schema` | int | `1` | Spec format version. |
| `name` | string | — | Run name (also the transcript/bundle slug source). |
| `description` | string? | — | Human note; ignored by the engine. |
| `task` | string | — | The prompt handed to the agent. |
| `context` | string? | — | Extra context prepended to the task. |
| `workdir` | string | — | Directory the run executes in. |
| `identity.system_prompt` | string? | — | A system prompt to append or replace with. |
| `identity.mode` | `append` \| `replace` | `append` | How `system_prompt` combines with the default. |
| `skills` | string[] | `[]` | Skills to vendor into the disposable kit. |
| `plugins` | map | `{}` | Plugins to vendor, each `{ mcp?, env? }`. |
| `model.id` | string? | — | Model id (e.g. `opus`); unset uses claude's default. |
| `leash.max_turns` | int? | — | Turn cap (exit 125). Unset = unbounded, bounded only by the timeout. |
| `leash.timeout_secs` | int? | `1800` | Wall-clock cap (exit 124). Never unbounded. |
| `leash.max_budget_usd` | float? | — | Spend ceiling (exit 122). |
| `leash.isolation` | `none` \| `worktree` | `none` | `worktree` branches off HEAD and runs there; requires a git workdir. |
| `auth.bare` | bool | `true` | Run in the empty room (`--bare`). |
| `auth.token_env` | string? | — | Env var holding the API token; the engine fails fast if it names an unset var under `bare`. |
| `interactive.enabled` | bool | `false` | Opt in to the `ask_user` tool. |
| `interactive.answer_timeout_secs` | int? | — | How long to wait on an answer (exit 123). Unset = wait indefinitely. |

Generate specs programmatically in TypeScript from the ts-rs bindings in `app/src/bindings/` (build with the `ts` cargo feature). Note: the run-spec types have generated bindings; the `KataEvent` types do not — mirror them by hand (see `app/src/lib/events.ts` for the reference mirror).

---

## Which contracts are stable

- **Run-spec** and **event protocol**: stable and language-neutral. Build against these.
- **Exit codes**: stable; part of the CI/orchestrator contract.
- **The `kata_core` Rust API**: the reference implementation, pre-1.0. The curated crate-root re-exports are the intended surface, but signatures may change before 1.0 — pin a git rev or version.
