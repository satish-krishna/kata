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

You are not *required* to call `validate` — `kata run` validates the spec internally as its first action and fails fast (before spawning `claude`) on an invalid one, so a bad spec never reaches a run either way. The reason to preflight anyway is twofold: `validate` has zero side effects (so you can check speculatively — on save, on keystroke), and it *distinguishes* the failure. Through `kata run`, a validation failure surfaces as exit **2** (the engine maps every startup error to 2), so it reads the same as an unparseable file; `kata run` never exits 1 for a bad spec. Only `kata validate` separates exit **1** ("your spec is wrong") from exit **2** ("I couldn't read it"). If your integration branches on that distinction, preflight with `validate`; do not try to recover it from `run`.

If you are Rust, `kata_core::spec::validate` is one of the pure re-exports (see [In-process](#in-process-rust)), so you can run this same preflight in-process with zero process spawns and still run the spec out-of-process.

### 4. Run it and read events

```
kata run triage.toml
```

stdout is a stream of newline-delimited JSON objects, each an event. stderr carries the transcript path and any human-readable claude noise. The process exit code is the leash outcome (see [Exit codes](#exit-codes)).

Your loop is: read a line, parse JSON, switch on `type`.

### The event protocol

Every event is a JSON object with a `type` field. Fields below are exactly as serialized. The protocol is versioned: `protocolVersion` is `1` (`KATA_EVENT_PROTOCOL_VERSION`), stamped into `schema/kata-events.schema.json`, and bumped only on a breaking change.

| `type` | Fields | Meaning |
|---|---|---|
| `run.started` | `spec`, `model`, `workdir`, `isolation`, `worktree?`, `branch?` | Run began. `worktree`/`branch` present only under worktree isolation. |
| `log` | `level`, `message` | Engine log line (`info` / `warn`). |
| `assistant.text` | `text`, `parent_id?` | A chunk of the agent's assistant-visible text. `parent_id` is the `id` of the subagent call it was written inside; absent at the top level. |
| `tool.use` | `name`, `input_summary`, `id?`, `parent_id?`, `input?`, `truncated?` | The agent invoked a tool. `id` is claude's `tool_use_id`, emitted on every run; pair it with the `tool.result` carrying the same `id`. `input` (the raw tool input) is present only under `kata run --full-payloads`, and is omitted with `truncated: true` when its JSON exceeds 256 KB. |
| `tool.result` | `name`, `ok`, `summary`, `id?`, `parent_id?`, `output?`, `truncated?` | A tool returned. `ok` is false on tool error. `id` matches the `tool.use` it answers. `output` (the result flattened to text) is present only under `kata run --full-payloads`, cut at 256 KB with `truncated: true`. |
| `turn` | `n`, `parent_id?` | The nth assistant turn began (the turn counter the `max_turns` leash counts). `parent_id` is set when the message came from inside a subagent (the spawning `tool.use` id). |
| `ask.requested` | `id`, `questions[]` | The agent is paused, asking the operator. Any run. See [Interactive](#interactive-runs). |
| `ask.answered` | `id`, `answers[][]` | The operator's answer was delivered (echo, for your transcript). |
| `permission.requested` | `id`, `tool`, `input_summary` | A tool call is paused on the operator's decision: under `mode = "prompt"` with `unmatched = "ask"`, and under `mode = "auto"` for a call a `permissions.ask` rule matched. See [Permissions](#permission-prompting). |
| `permission.decided` | `id`, `tool`, `input_summary`, `allow`, `decided_by`, `message?` | How a permission check was resolved. Emitted only for a check that reaches Kata's own tool — the `unmatched` policy, the operator, or one of Kata's own bridge tools (`decided_by: "engine"`). A call claude's own settings (or its built-in read-only auto-approve) resolved is never seen by Kata and gets no event at all — this is **not** a complete audit trail of every permission check. |
| `message.sent` | `id`, `text`, `sent_at` | A `say` message was accepted and written to Claude's input. `sent_at` is milliseconds since the Unix epoch. See [The control channel](#the-control-channel-stdin). |
| `message.read` | `id`, `read_at` | Claude took the message in. `read_at` is milliseconds since the Unix epoch. |
| `message.refused` | `id`, `reason`, `text` | The message was not accepted. `reason` is `waiting-on-operator`, `run-ending` or `repeated`. The set is open, like `decided_by`: show an unrecognized `reason` as "not sent". |
| `run.given` | `items[]`, `settings`, `env[]`, `warnings[]`, `options?` | What the run was given, checked against claude's start report. Emitted when the start report arrives, again when the hooks seen firing change, and, when no start report ever arrived, once on the way out (including a refused or failed-to-spawn run); keep only the last one. `options` is `{ required_plugins[], build }`, the options the run was resolved with. Names of environment variables only, never values. |
| `run.diff` | `worktree?`, `branch?`, `files[]`, `insertions`, `deletions`, `by_type[]` | Changeset summary, emitted just before the terminal event on every run in a git repository. worktree/branch present only under worktree isolation. |
| `run.completed` | `exit_code`, `is_error`, `num_turns`, `cost_usd?`, `duration_ms`, `result?` | Terminal: the run finished on its own. |
| `run.error` | `message`, `exit_code`, `cost_usd?`, `duration_ms` | Terminal: the run was stopped by the leash or failed. |
| `run.cancelled` | `exit_code`, `cost_usd?`, `duration_ms` | Terminal: the run was cancelled. |

Exactly one terminal event (`run.completed` / `run.error` / `run.cancelled`) ends the stream of every run that got under way. A refused authentication or a worktree that cannot be made still ends with `run.error` (exit code 2). The exceptions are startup failures with no terminal event, after which `kata run` exits 2: an invalid spec and a kit that cannot be assembled emit no event at all, and a failure to spawn `claude` may emit only `run.given`. Treat "stdout closed with exit 2 and no terminal event" as a failed start. `ask.*` events may appear on any run; `permission.*` events only when it sets `[permissions] mode = "prompt"` or `"auto"`.

### The changeset (run.diff)

`run.diff` is emitted on every run that reaches its end in a git repository (a run refused for authentication or a worktree failure has none, and see the last paragraph below for any other workdir), immediately before the terminal event, listing the changed files with per-file status and total insertions/deletions.

`by_type` partitions the changeset by lowercased file extension: each entry is `{ file_type, files, insertions, deletions }`, sorted by `file_type`, with `""` for files that have no extension. Summing `by_type[*].insertions` equals the top-level `insertions` (likewise for `deletions`).

`worktree` and `branch` are present only for a worktree-isolated run.

For a default (non-worktree) run the changeset is the working tree versus `HEAD` at the run's end, so any file left uncommitted before the run is attributed to the run; use `isolation = "worktree"` for clean per-run attribution.

When the workdir is not a git repository, no `run.diff` is emitted; instead a single `info` `log` event with the message `no changeset: workdir is not a git repository` explains why. A genuine git failure (git present but a command errored) is reported as a `warn` `log` instead.

`run.error` and `run.cancelled` now carry `cost_usd` and `duration_ms` matching `run.completed`. `cost_usd` is `null` when the leash kills the child before claude reports a final cost (timeout, cancel, turn cap) and is present on the budget path (exit 122); `duration_ms` is always present.

### The control channel (stdin)

The engine reads control lines on its stdin. Four commands:

- `cancel` — stop the run. The engine kills claude, cleans up (worktree, temp kit), emits `run.cancelled`, and exits 130. EOF on stdin is a no-op, so a plain CLI invocation that closes stdin runs normally.
- `answer <id> <json>` — answer a pending `ask.requested`. `<id>` is the id from the event; `<json>` is the answer matrix (see below). Ignored unless it matches the pending question's id.
- `decide <id> allow|deny [reason]` — settle a pending `permission.requested`. The optional trailing free text is the reason claude sees on a denial. A line that is neither `allow` nor `deny` is ignored rather than guessed at. Ignored unless it matches the pending check's id.
- `say <id> <json-string>` — send a message to the agent while it works. `<id>` is chosen by you, has no spaces and must be new within the run. `<json-string>` is one JSON string, so a message with line breaks still fits on one line; build the line with a JSON encoder (`kata_core::control::say_line` in Rust), never by pasting raw text. A line that does not follow this grammar is ignored.

The engine answers a `say` line from its own state, checked in this order: blank text is ignored with no event; an id already used in the run is refused with `message.refused` and reason `repeated`; a run paused on `ask.requested` or `permission.requested` is refused with `waiting-on-operator`; a run whose Claude input is already closed is refused with `run-ending`; anything else is accepted. The same text under a new id is a new message. A run that receives no `say` line emits none of the three message events.

A worked example. You write one line to stdin:

```
say m1 "Stop editing the parser;\nthe bug is in the lexer"
```

The engine accepts it and announces it, then announces that Claude took it in:

```json
{"type":"message.sent","id":"m1","text":"Stop editing the parser;\nthe bug is in the lexer","sent_at":1790000000000}
{"type":"message.read","id":"m1","read_at":1790000004200}
```

Sending `m1` again is refused instead:

```json
{"type":"message.refused","id":"m1","reason":"repeated","text":"Stop editing the parser;\nthe bug is in the lexer"}
```

### Exit codes

The process exit code is the leash outcome, and part of the contract — CI and orchestrators branch on it.

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | (CLI) `kata validate`: spec validation failed. When no leash trips, `kata run` passes claude's own exit code through, so a failed claude run can also exit 1. |
| 2 | (CLI) could not load/parse the spec, or an engine error: an invalid spec through `kata run`, a startup failure. |
| 73 | (CLI) `kata init` refused to overwrite an existing file (`--force` overwrites). |
| 122 | Budget ceiling reached (`leash.max_budget_usd`). Spend may overshoot by up to one turn. |
| 123 | Answer deadline exceeded (`interactive.answer_timeout_secs`) — an unanswered question *or* an undecided permission check. Distinct from 124 so logs can tell "nobody answered" from "work ran too long". |
| 124 | Wall-clock timeout (`leash.timeout_secs`, or the 1800s default when unset). |
| 125 | Turn cap reached (`leash.max_turns`). Only reachable when the cap is set. |
| 130 | Cancelled. |

---

## Interactive runs

Every run — interactive or not, in any permission mode — gives the agent an `ask_user` tool, so any run can pause at a genuine decision fork. There is no automatic answer: **handle `ask.requested` on every run**, or close the engine's stdin so an unanswerable question ends the run with exit 123 instead of waiting. (`[interactive] enabled` only decides whether permission checks may pause too.) **You do not implement anything MCP-related** — Kata owns the `ask_user` tool, its schema, the server, and the bridge. Your only job is to render the question and send back an answer.

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

## Permission prompting

By default a run passes `--dangerously-skip-permissions`, so claude never asks about a tool call. That flag is exactly what a machine's **managed settings** can forbid: an admin who sets `permissions.disableBypassPermissionsMode` makes claude reject it at startup, and every Kata run on that machine fails before it begins.

**What changed, and what to stop relying on:** an earlier version of Kata matched `allow`/`deny` rules itself and emitted a `permission.decided` event for every check. That guarantee never held up against a real `claude` session and has been removed — see below. If your integration reads the event stream as a complete log of every tool call claude considered, or expects a `decided_by` value that names a *rule* as the resolver, stop: neither is true anymore. Only `unmatched-policy`, `operator`, and `engine` occur now.

`[permissions] mode = "prompt"` is the way through. **Kata does not match permission rules itself.** The spec's `allow`/`deny` are written verbatim into a generated claude `--settings` file, and claude enforces them natively — that is a deliberate change from an earlier engine-side matcher, which was removed because it could never see the calls claude resolves before consulting anything external (see below). The engine still passes `--permission-prompt-tool` pointing at its own MCP tool, but that tool now carries only the `unmatched` policy: it is consulted only for a call claude's settings left unresolved.

This is **not** a bypass by another name. Claude's evaluation order, from experiment against a real session:

1. settings **deny** → refused, the prompt tool is never called.
2. settings **allow** → permitted, the prompt tool is never called.
3. claude's own **read-only command set** (`git status`, `git log`, `ls`, `cat`, `hostname`, …) → auto-approved, the prompt tool is never called.
4. otherwise → the prompt tool, i.e. Kata's `unmatched` policy or the operator.

The consequence worth internalizing: a **`deny` rule reaches read-only commands**, because settings are consulted before claude's auto-approve step. `deny = ["Bash(git log*)"]` refuses `git log --oneline -3` outright — an engine-side matcher could never have done this, because a call claude auto-approves is never surfaced to anything outside claude.

### Choosing a posture

`mode = "auto"` is the third posture: Kata passes `--permission-mode auto` alongside the same prompt tool, and claude's own classifier decides every call that `allow` and `deny` do not resolve, approving routine work and blocking the destructive or externally-reaching call. Kata's `unmatched` policy does not apply (the classifier is the unmatched handler), so `validate` rejects `unmatched = "deny"` or `"allow"` under `auto`. `permissions.ask` is the operator's entry point under `auto`: a matching call emits `permission.requested` and pauses the run. Under `prompt` an `ask` rule does not pause by itself, because a call that reaches Kata's tool is settled by `unmatched`; a non-empty `ask` list still requires `interactive.enabled` under both modes. Settings `deny` and `allow` are enforced before the classifier, exactly as under `prompt`.

The mode is explicit and never inferred. There is deliberately no automatic fallback between modes: a run whose safety posture silently changed between machines is not reproducible, which is the whole point of a run-spec.

```toml
[permissions]
mode = "prompt"        # "bypass" (default) | "prompt" | "auto"
unmatched = "deny"     # "ask" (default) | "deny" | "allow"
allow = ["Read", "Grep", "Bash(git *)"]
deny  = ["Bash(rm *)"]
```

`unmatched` says what happens to a call claude's settings leave unresolved, and it is the field to get right:

| Value | Behaviour | Use when |
|---|---|---|
| `ask` | Pause the run and put the call to the operator. **Requires `[interactive] enabled = true`** — `validate` rejects the spec otherwise, since nothing else could answer. | A human is watching (the Workbench). |
| `deny` | Deny it and tell claude why. Note this does **not** make `allow` the run's complete tool surface — claude's settings have no catch-all deny (a bare `Bash` or `Bash(*)` entry denies nothing), so `unmatched = "deny"` is the only thing standing between an unlisted call and the operator/refusal split. | Headless and CI. |
| `allow` | Allow it. | You want to let unmatched calls through without a human. |

### Rule syntax

`Tool` or `Tool(specifier)`, with `*` matching any run of characters — this is **claude's own grammar**, handed over verbatim, not Kata's:

- `Read` — every `Read` call
- `Bash(git *)` — shell commands starting with `git ` (note the space before `*` — it is what makes this a *prefix* match; `Bash(git*)`, without the space, would also match unrelated commands like `git-lfs` or a hypothetical `gitignore-checker`)
- `mcp__github__get_*` — the `get_` tools of the `github` MCP server

The specifier matches the call's *target*: the `command` for `Bash`, the `file_path` for `Read`/`Write`/`Edit`, the `pattern` for `Glob`/`Grep`, the `url` for `WebFetch`, the `query` for `WebSearch`, and the whole input JSON for anything else. **`deny` is evaluated before `allow`.** A malformed rule is a validation error at spec-load time, never a silent wildcard — Kata still validates rule *syntax*, it just does not match rules against calls at run time.

Kata's own bridge tools (`ask_user`, `approve_tool`) are exempt and never consulted against the rules — they resolve immediately with `decided_by: "engine"`. Claude sees `ask_user` as an ordinary MCP tool, so without the exemption a headless `deny` policy would silently switch interactivity off, and `ask` would ask the operator for permission to ask the operator.

### The loop

1. Claude resolves most calls itself, from its settings or its read-only auto-approve. Kata is never consulted and emits **no event** for these.
2. A call claude's settings leave unresolved reaches Kata's prompt tool. The `unmatched` policy resolves it immediately (`deny`/`allow`) and emits `permission.decided` with `decided_by: "unmatched-policy"`, or (`ask`) emits `permission.requested` and pauses the run.
3. Under `ask`, you render `tool` and `input_summary`, then write `decide <id> allow` or `decide <id> deny <reason>`.
4. The engine unblocks claude and emits `permission.decided` with `decided_by: "operator"`.

`interactive.answer_timeout_secs` bounds this wait too: an undecided check is reaped with exit 123, the same code as an unanswered question.

**The event stream is not a complete audit trail of every permission check.** Only the checks that reach Kata — the `unmatched` policy or the operator — produce a `permission.decided` event. A call claude's own settings or read-only auto-approve resolved leaves no trace in the event stream at all; if you need a full record, it is claude's own settings/transcript that would carry it, not Kata's events.

### What this does not solve

- **`disableSideloadFlags`.** An organization strict enough to disable bypass may also set this, which makes claude reject `--mcp-config` and `--plugin-dir`. That breaks the curated kit and this bridge alike, and no run-spec field can route around it — the run needs an admin change, not a different spec.
- **Managed `deny` and `ask` rules.** They are evaluated before the prompt tool. A call an admin denied never reaches Kata, and no `allow` rule here re-opens it.
- **`defaultMode = "dontAsk"`.** That mode denies without ever calling the prompt tool, so prompt mode is inert under it. Managed settings outrank CLI arguments, so a run cannot override it.
- **Tools marked `requiresUserInteraction`.** Claude converts an `allow` from a permission prompt tool into a deny for these, so Kata cannot approve one no matter what the rules say.

---

## In-process (Rust)

Most Rust consumers link `kata-core` for **only** the pure operations — `validate`, `catalog`, `load`/`save` specs, `bundle` — and still spawn the `kata` binary to run (that is exactly what the Workbench backend does). Those helpers are the everyday reason to depend on the crate.

Running in-process — calling `run()` from your own binary instead of spawning `kata` — is a **narrow escape hatch, not the recommended path.** It exists for one shape of consumer: a concurrent orchestrator that drives many runs inside a single process and wants to avoid a `kata` child per run. If that is not you, spawn the binary and skip to the caveat below. Whatever you do, `run()` in your own binary needs that binary to serve `mcp-ask`, because every run wires the `ask_user` tool — see [Why interactive is binary-only](#why-interactive-is-binary-only-by-design).

Until Kata is published to a registry, use a git dependency:

```toml
[dependencies]
kata-core = { git = "https://github.com/satish-krishna/kata", package = "kata-core" }
serde_json = "1"
```

### The public surface

The crate root re-exports the intended API. Engine plumbing (`assemble`, `builtin`, `command`, `fsutil`) is `pub(crate)`; `ask` is public only so the `kata` binary can serve `mcp-ask`, and is hidden from the docs. Other public modules exist but are not the consumer API.

- `RunSpec`, `validate`, and the `spec` module — the run-spec contract (load/save/validate).
- `KataEvent`, `Question`, `QuestionKind`, `QuestionOption`, and the `event` module — the event protocol.
- `run`, `answer_channel`, `Answer`, `AnswerRx`, `decision_channel`, `Decision`, `DecisionRx`, `CancelToken`, `RunOutcome`, `RunError` — driving a run.
- The `given` module (`ItemKind`, `Source`) — item identities and the preview of what a run starts with — and the `permission` and `changeset` modules.
- The `catalog`, `bundle`, `worktree`, `history`, `katas`, `presets` modules — the pure operations the GUI and CLI also build on.

### Driving a run

`run()` takes the spec, the discovered catalog, a cancel token, an answer inbox, a permission-decision inbox, and an `FnMut(KataEvent)` sink. It blocks until the run ends and returns the outcome. This block is the crate-root doctest verbatim — CI compiles it, so it cannot silently rot:

```rust
use kata_core::{answer_channel, decision_channel, run, Answer, CancelToken, Decision, KataEvent};

let spec = kata_core::spec::load("triage.toml".as_ref())?;
let catalog = kata_core::catalog::discover(
    &kata_core::catalog::roots_for_workdir(Some(&spec.workdir)));

// Call cancel.cancel() from another thread to stop the run.
let cancel = CancelToken::new();
// Keep the senders to answer questions (any run can ask) and approve tool
// calls. An `AnswerRx::default()` / `DecisionRx::default()` means nobody can
// answer: a pause on it ends the run with exit 123.
let (answer_tx, answers) = answer_channel();
let (decision_tx, decisions) = decision_channel();

let outcome = run(&spec, &catalog, &cancel, &answers, &decisions, |event| match event {
    // Interactive fork: reply with one Vec<String> per question
    // (chosen option labels, [typed text], or [] to skip an optional one).
    KataEvent::AskRequested { id, questions } => {
        let reply = questions.iter().map(|_| vec![String::from("yes")]).collect();
        let _ = answer_tx.send(Answer { id, answers: reply });
    }
    // Permission fork ([permissions] mode = "prompt", unmatched = "ask"):
    // decide whether this tool call may proceed.
    KataEvent::PermissionRequested { id, tool, input_summary } => {
        println!("{tool}: {input_summary}");
        let _ = decision_tx.send(Decision { id, allow: false, message: None });
    }
    // Everything else: forward to your UI, a socket, a log...
    other => println!("{}", serde_json::to_string(&other).unwrap()),
})?;

println!("run finished with exit code {}", outcome.exit_code);
```

The `AskRequested` arm here is a placeholder that answers every question with `"yes"`; a real consumer renders the questions, collects the operator's choices, and builds the `Vec<Vec<String>>` reply matrix from them (see [Answer matrix](#answer-matrix)).

### Why interactive is binary-only (by design)

Interactivity is packaged *inside* Kata — the `ask_user` tool, its schema, the MCP server, and the localhost bridge all live in `kata-core` and never leave the `kata` process. A consumer never touches anything MCP-related; it only renders `ask.requested` and writes `answer` back (see [Interactive runs](#interactive-runs)). That is the point: the MCP is invisible, and the app owns the UI layer.

The mechanism is also why in-process runs do not work out of the box, and are not meant to. Every run tells `claude` to launch the MCP server as `<current exe> mcp-ask`. In the `kata` binary, "current exe" is `kata`, which has that hidden subcommand. Link `run()` into *your* binary and "current exe" is *your* binary — which has no `mcp-ask` — so the server never starts. This is a guardrail, not a gap: the single execution path for a *run* is the binary, and interactive runs are the sharpest case of it.

**So: to run a spec, spawn the `kata` binary.** Link the crate for the pure operations. If you are that concurrent orchestrator and must call `run()` in-process, your `main` has to dispatch an `mcp-ask` first argument to `kata_core::ask::serve_stdio()` before doing anything else — it re-execs your process into a JSON-RPC server on stdout, a real footgun for any non-trivial `main`. Without it claude cannot start the server, and the run has no way to ask its operator anything.

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
| `interactive.enabled` | bool | `false` | Let permission checks (`permissions.ask`, `unmatched = "ask"`) pause on the operator. Questions do not depend on it: `ask_user` is on every run. |
| `interactive.answer_timeout_secs` | int? | — | How long to wait on an answer, or on a permission decision (exit 123). Unset = wait indefinitely. |
| `permissions.mode` | `"bypass"` \| `"prompt"` \| `"auto"` | `bypass` | How claude's permission checks are answered. See [Permission prompting](#permission-prompting). |
| `permissions.unmatched` | `"ask"` \| `"deny"` \| `"allow"` | `ask` | What Kata's prompt tool does with a call claude's own settings left unresolved. `ask` requires `interactive.enabled`. Rejected as an explicit value under `auto`. |
| `permissions.allow` | string[] | `[]` | Rules written verbatim into claude's generated settings under `mode = "prompt"` or `"auto"`; claude enforces them, Kata does not match them. Rejected under `bypass`. |
| `permissions.deny` | string[] | `[]` | Rules written verbatim into claude's generated settings under `mode = "prompt"` or `"auto"`. Evaluated before `allow`, and reaches read-only commands claude would otherwise auto-approve. Rejected under `bypass`. |
| `permissions.ask` | string[] | `[]` | Under `auto`, rules that route a matching call to Kata's `approve_tool` and pause the run on the operator; under `prompt` a call reaching that tool is settled by `unmatched`. Requires `interactive.enabled`. Rejected under `bypass`. |
| `given` | table? | — | The items the run starts without: lists `hooks`, `skills`, `plugins`, `instructions`, `tool_servers` of item identities (`<source>:<kind>:<key>`), each entry switching one item off, plus the Workbench-written `required_plugins` and `build`. Absent means the spec makes no choices. See `CONTRACTS.md`. |
| `env` | map | `{}` | Environment variables to set on the `claude` child (name → literal value). Overrides inherited, plugin-forwarded, and `token_env`-derived values. |
| `env_remove` | string[] | `[]` | Environment variable names to unset on the `claude` child, applied last so removal wins — even over a `token_env`-derived `ANTHROPIC_API_KEY`. |

### What `validate` enforces

Beyond the required `name`, `task` and `workdir`: `leash.max_turns` is at least 1 when set; `leash.max_budget_usd` is finite and above 0; `env` and `env_remove` are well formed, disjoint and free of engine-reserved names; under `permissions.mode = "bypass"` the `allow`, `deny` and `ask` lists must be empty; `unmatched = "ask"` and any `ask` rule need `interactive.enabled = true`; `mode = "auto"` rejects `unmatched = "deny"` or `"allow"`; rule syntax and `[given]` entries must parse.

### Where things are kept

Saved run-specs live in `~/.kata/katas` (or `$KATA_HOME/katas` when `KATA_HOME` is set), context presets in `presets` beside them, run transcripts in `runs`, and worktrees of a `leash.isolation = "worktree"` run in `worktrees/<slug>-<id>` on the branch `kata/<slug>-<id>`, kept for review until you remove them with `git worktree remove`.

### Bundles and the catalog

`kata catalog` prints the skills and plugins discoverable from the workdir as JSON. `kata bundle <spec> [-o dir] [--force]` vendors the resolved kit into a folder with a `kata-bundle.toml` marker; `kata run <dir>` on that folder runs hermetically, discovering the kit only from the bundle. `kata run --full-payloads` adds the raw tool input and output (each capped at 256 KB) to `tool.use` and `tool.result`.

### Environment resolution order

`env` and `env_remove` let a caller shape the exact environment handed to the `claude` child, per run, without touching the host process environment. The child still inherits the parent environment by default; these two fields add a targeted set layer and an unset layer on top. The layers are resolved in a fixed order, each later layer winning over earlier ones for the same key:

1. Inherited parent process environment.
2. `plugins.*.env` forwards (names resolved from the parent environment).
3. `auth.token_env` resolved to `ANTHROPIC_API_KEY` (bare mode only).
4. `env` — set and override (highest-precedence set layer).
5. `env_remove` — unset (applied last, so removal wins).

So `env` overrides an inherited variable, a plugin-forwarded variable, and the `token_env`-derived `ANTHROPIC_API_KEY`; `env_remove` then strips any listed name regardless of which earlier layer set it. A name that appears in both `env` and `env_remove` is a hard validation error — the two fields must be disjoint. Empty/whitespace names, and an `env` key containing `=`, are also rejected. A small set of engine-reserved names (currently `KATA_ASK_PORT` and `KATA_MCP_TOOLS`, which wire the engine's MCP bridge) cannot be set or unset either — doing so would silently break the run.

The layers are applied to the child process only (via the child's own environment block), never by mutating the host process environment. This is what makes concurrent in-process runs correct by construction: two runs started at the same time with different `env` values for the same key each get their own child value, with no shared-state cross-talk. That is the property an in-process host (e.g. an orchestrator running Agent nodes concurrently against different model egress) depends on. Variable names are matched exactly — no wildcard or prefix matching — and name matching follows the host platform's own rules (case-sensitive on Unix, case-insensitive on Windows).

Generate specs programmatically in TypeScript from the ts-rs bindings in `app/src/bindings/` (build with the `ts` cargo feature). The event types have generated TypeScript too: `app/src/bindings/kata-events.ts` is generated from `schema/kata-events.schema.json` by `cd app && npm run gen:events` (CI diffs it), and `app/src/app/lib/events.ts` re-exports it with the Workbench's hand-written render helpers.

---

## Which contracts are stable

`CONTRACTS.md` at the repo root is the authoritative list of frozen surfaces and the versioning rules (what change is major vs minor). In brief:

- **Run-spec** and **event protocol**: stable and language-neutral. Build against these.
- **Exit codes** and the **engine invocation + stdin control channel** (`cancel`, `answer`, `decide`, `say`): stable; part of the CI/orchestrator contract.
- **The `kata_core` Rust API**: the reference implementation, less stable than the contracts above. The curated crate-root re-exports are the intended surface, but signatures may shift between releases — pin a version.
- **The `ask_user` and `approve_tool` MCP tools** are internal implementation details, not contracts — drive interactivity via the `ask.*` events and the `answer` control line, and permissions via the `permission.*` events and the `decide` control line.
