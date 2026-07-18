# Consuming Kata from another application

This guide is for developers embedding Kata in their own software — a GUI, an orchestrator, a CI step, a service. It is not about *authoring* run-specs (see the root `README.md`); it is about *driving* a run and observing it from your own code.

**There is one way to run a spec: spawn the `kata` binary and read its JSON-line events.** Every consumer — the Workbench, the Shokunin orchestrator, CI — goes through that single execution path, on purpose. It is language-neutral, process-isolated, and the only path where interactive runs work. Start here; do not reach for anything else unless you have a specific reason the rest of this guide names.

Separately, if you are Rust, you may **link the `kata-core` crate for the pure, side-effect-free operations** — `validate`, `catalog`, `load`/`save` specs. These are cheap synchronous calls; forking a whole process to parse a TOML file would be silly, so the Workbench links them in-process as one-liners. Linking the crate for those helpers is *not* a second way to run — running still goes through the binary. In-process `run()` exists as a narrow escape hatch for one consumer (see [In-process](#in-process-rust)) and does not support interactivity by design.

**The two things that are contractual** — stable across languages and versions — are the **run-spec** (what to run) and the **event protocol** (what comes back). The Rust API is the reference implementation of those contracts, not itself a stability-frozen surface: the crate's signatures can shift between releases even though the contracts do not. If you can, depend on the contracts, not the crate.

---

## Out-of-process (any language)

This is the universal path, and the one the Kata Workbench itself uses. Your program spawns `kata run <spec>` in the spec's working directory and treats it as a black box that emits one JSON event per line on stdout.

### 1. Get the binary

Build it from the workspace (`cargo build --release -p kata-cli` produces `target/release/kata`) and put it on `PATH`. A real run needs an authenticated `claude` on `PATH` as well — Kata drives `claude -p`, it does not replace it.

### 2. Write a run-spec

The fastest start is `kata init`, which scaffolds a valid starter spec wired to the run-spec JSON Schema (`schema/kata-runspec.schema.json`). Open the result in a JSON-Schema-aware TOML editor (VS Code's Even Better TOML / the Taplo LSP) and you get field autocomplete, hover docs, and inline validation as you type — the `#:schema` directive on line one wires it automatically. `kata init myrun` names the file `myrun.toml`; `kata init --local` embeds a working-tree-relative schema path instead of the default version-pinned URL (use it when authoring inside a kata checkout, offline, or before the current version is released). Then edit the placeholders and validate.

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

See [Run-spec reference](#run-spec-reference) for every field.

### 3. Validate before you run

`kata validate <spec>` is a pure preflight: it loads and validates the spec and does **nothing else** — no `claude` spawned, no run started, no side effects. Use it so a consumer never launches a run only to discover the spec was malformed.

```
kata validate triage.toml
```

The exit code is the whole signal:

| Code | Meaning |
|---|---|
| 0 | Valid. Safe to run. Prints `ok: <path> valid`. |
| 1 | Semantic validation failed. One reason per line on stderr. |
| 2 | Could not load or parse the file at all. |

You are not *required* to call `validate` — `kata run` validates the spec internally as its first action and fails fast (before spawning `claude`) on an invalid one, so a bad spec never reaches a run either way. The reason to preflight anyway is twofold: `validate` has zero side effects (so you can check speculatively — on save, on keystroke), and it *distinguishes* the failure. Through `kata run`, a validation failure surfaces as exit **2** (the engine maps every startup error to 2), so it reads the same as an unparseable file. Only `kata validate` separates exit **1** ("your spec is wrong") from exit **2** ("I couldn't read it"). If your integration branches on that distinction, preflight with `validate`; do not try to recover it from `run`.

If you are Rust, `kata_core::spec::validate` is one of the pure re-exports (see [In-process](#in-process-rust)), so you can run this same preflight in-process with zero process spawns and still run the spec out-of-process.

### 4. Run it and read events

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
| `run.diff` | `worktree?`, `branch?`, `files[]`, `insertions`, `deletions`, `by_type[]` | Changeset summary, emitted just before the terminal event on every run. worktree/branch present only under worktree isolation. |
| `run.completed` | `exit_code`, `is_error`, `num_turns`, `cost_usd?`, `duration_ms`, `result?` | Terminal: the run finished on its own. |
| `run.error` | `message`, `exit_code`, `cost_usd?`, `duration_ms` | Terminal: the run was stopped by the leash or failed. |
| `run.cancelled` | `exit_code`, `cost_usd?`, `duration_ms` | Terminal: the run was cancelled. |

Exactly one terminal event (`run.completed` / `run.error` / `run.cancelled`) ends every stream. `ask.*` events appear only when the spec sets `[interactive] enabled = true`.

### The changeset (run.diff)

`run.diff` is emitted on every run, immediately before the terminal event, listing the changed files with per-file status and total insertions/deletions.

`by_type` partitions the changeset by lowercased file extension: each entry is `{ file_type, files, insertions, deletions }`, sorted by `file_type`, with `""` for files that have no extension. Summing `by_type[*].insertions` equals the top-level `insertions` (likewise for `deletions`).

`worktree` and `branch` are present only for a worktree-isolated run.

For a default (non-worktree) run the changeset is the working tree versus `HEAD` at the run's end, so any file left uncommitted before the run is attributed to the run; use `isolation = "worktree"` for clean per-run attribution.

When the workdir is not a git repository, no `run.diff` is emitted; instead a single `info` `log` event with the message `no changeset: workdir is not a git repository` explains why. A genuine git failure (git present but a command errored) is reported as a `warn` `log` instead.

`run.error` and `run.cancelled` now carry `cost_usd` and `duration_ms` matching `run.completed`. `cost_usd` is `null` when the leash kills the child before claude reports a final cost (timeout, cancel, turn cap) and is present on the budget path (exit 122); `duration_ms` is always present.

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

Most Rust consumers link `kata-core` for **only** the pure operations — `validate`, `catalog`, `load`/`save` specs, `bundle` — and still spawn the `kata` binary to run (that is exactly what the Workbench backend does). Those helpers are the everyday reason to depend on the crate.

Running in-process — calling `run()` from your own binary instead of spawning `kata` — is a **narrow escape hatch, not the recommended path.** It exists for one shape of consumer: a concurrent orchestrator that drives many runs inside a single process and wants to avoid a `kata` child per run. If that is not you, spawn the binary and skip to the caveat below. Whatever you do, `run()` in your own binary **cannot do interactive runs** — see [Why interactive is binary-only](#why-interactive-is-binary-only-by-design).

Until Kata is published to a registry, use a git dependency:

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

`run()` takes the spec, the discovered catalog, a cancel token, an answer inbox, and an `FnMut(KataEvent)` sink. It blocks until the run ends and returns the outcome. This block is the crate-root doctest verbatim — CI compiles it, so it cannot silently rot:

```rust
use kata_core::{answer_channel, run, Answer, CancelToken, KataEvent};

let spec = kata_core::spec::load("triage.toml".as_ref())?;
let catalog = kata_core::catalog::discover(
    &kata_core::catalog::roots_for_workdir(Some(&spec.workdir)));

// Call cancel.cancel() from another thread to stop the run.
let cancel = CancelToken::new();
// Keep the sender to answer interactive questions; drop it for non-interactive runs.
let (answer_tx, answers) = answer_channel();

let outcome = run(&spec, &catalog, &cancel, &answers, |event| match event {
    // Interactive fork: reply with one Vec<String> per question
    // (chosen option labels, [typed text], or [] to skip an optional one).
    KataEvent::AskRequested { id, questions } => {
        let reply = questions.iter().map(|_| vec![String::from("yes")]).collect();
        let _ = answer_tx.send(Answer { id, answers: reply });
    }
    // Everything else: forward to your UI, a socket, a log...
    other => println!("{}", serde_json::to_string(&other).unwrap()),
})?;

println!("run finished with exit code {}", outcome.exit_code);
```

The `AskRequested` arm here is a placeholder that answers every question with `"yes"`; a real consumer renders the questions, collects the operator's choices, and builds the `Vec<Vec<String>>` reply matrix from them (see [Answer matrix](#answer-matrix)).

### Why interactive is binary-only (by design)

Interactivity is packaged *inside* Kata — the `ask_user` tool, its schema, the MCP server, and the localhost bridge all live in `kata-core` and never leave the `kata` process. A consumer never touches anything MCP-related; it only renders `ask.requested` and writes `answer` back (see [Interactive runs](#interactive-runs)). That is the point: the MCP is invisible, and the app owns the UI layer.

The mechanism is also why in-process interactive does not work, and is not meant to. When a run goes interactive, the engine tells `claude` to launch the MCP server as `<current exe> mcp-ask`. In the `kata` binary, "current exe" is `kata`, which has that hidden subcommand. Link `run()` into *your* binary and "current exe" is *your* binary — which has no `mcp-ask` — so the server never starts. This is a guardrail, not a gap: the single execution path for a *run* is the binary, and interactive runs are the sharpest case of it.

**So: for interactive runs, spawn the `kata` binary.** Link the crate for the pure operations and, if you are that concurrent orchestrator, for non-interactive `run()`; spawn the `kata` process the moment you need a human in the loop. (Serving `mcp-ask` from your own `main` is technically possible but re-execs your process into a JSON-RPC server on stdout — a real footgun for any non-trivial `main` — and is rarely worth it.)

---

## Run-spec reference

The run-spec is published as a language-neutral JSON Schema at `schema/kata-runspec.schema.json` (generated from `spec::RunSpec` via `schemars`, drift-gated in CI, alongside the event protocol's `schema/kata-events.schema.json`). Its primary use is *authoring*: point a JSON-Schema-aware editor at it — or let `kata init` wire it via the `#:schema` directive — for field autocomplete, hover docs, and inline validation. This table is the human-readable mirror; the schema, the Rust `spec::RunSpec` struct plus `validate()`, and the ts-rs TypeScript bindings in `app/src/bindings/` are the machine artifacts. `kata validate` remains the runtime backstop.

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
| `env` | map | `{}` | Environment variables to set on the `claude` child (name → literal value). Overrides inherited, plugin-forwarded, and `token_env`-derived values. |
| `env_remove` | string[] | `[]` | Environment variable names to unset on the `claude` child, applied last so removal wins — even over a `token_env`-derived `ANTHROPIC_API_KEY`. |

### Environment resolution order

`env` and `env_remove` let a caller shape the exact environment handed to the `claude` child, per run, without touching the host process environment. The child still inherits the parent environment by default; these two fields add a targeted set layer and an unset layer on top. The layers are resolved in a fixed order, each later layer winning over earlier ones for the same key:

1. Inherited parent process environment.
2. `plugins.*.env` forwards (names resolved from the parent environment).
3. `auth.token_env` resolved to `ANTHROPIC_API_KEY` (bare mode only).
4. `env` — set and override (highest-precedence set layer).
5. `env_remove` — unset (applied last, so removal wins).

So `env` overrides an inherited variable, a plugin-forwarded variable, and the `token_env`-derived `ANTHROPIC_API_KEY`; `env_remove` then strips any listed name regardless of which earlier layer set it. A name that appears in both `env` and `env_remove` is a hard validation error — the two fields must be disjoint. Empty/whitespace names, and an `env` key containing `=`, are also rejected. A small set of engine-reserved names (currently `KATA_ASK_PORT`, which wires the interactive ask bridge) cannot be set or unset either — doing so would silently break the run.

The layers are applied to the child process only (via the child's own environment block), never by mutating the host process environment. This is what makes concurrent in-process runs correct by construction: two runs started at the same time with different `env` values for the same key each get their own child value, with no shared-state cross-talk. That is the property an in-process host (e.g. an orchestrator running Agent nodes concurrently against different model egress) depends on. Variable names are matched exactly — no wildcard or prefix matching — and name matching follows the host platform's own rules (case-sensitive on Unix, case-insensitive on Windows).

Generate specs programmatically in TypeScript from the ts-rs bindings in `app/src/bindings/` (build with the `ts` cargo feature). Note: the run-spec types have generated bindings; the `KataEvent` types do not — mirror them by hand (see `app/src/lib/events.ts` for the reference mirror).

---

## Which contracts are stable

`CONTRACTS.md` at the repo root is the authoritative list of frozen surfaces and the versioning rules (what change is major vs minor). In brief:

- **Run-spec** and **event protocol**: stable and language-neutral. Build against these.
- **Exit codes** and the **engine invocation + stdin control channel** (`cancel`, `answer`): stable; part of the CI/orchestrator contract.
- **The `kata_core` Rust API**: the reference implementation, less stable than the contracts above. The curated crate-root re-exports are the intended surface, but signatures may shift between releases — pin a version.
- **The `ask_user` MCP server** is an internal implementation detail, not a contract — drive interactivity via the `ask.*` events and the `answer` control line.
