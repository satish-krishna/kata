# Kata Contracts

This document names the **stable, frozen surfaces** of Kata as of `v1.0.0` and the versioning rules that govern them. It is the authority; `docs/consuming-kata.md` explains how to *use* these contracts, and this file defines what may and may not change under them.

If you are changing code under `crates/kata-core/src/spec.rs`, `crates/kata-core/src/event.rs`, the CLI's exit codes or stdin/stdout behavior, read this first. Breaking any contract below requires a **major** version bump.

## Versioning policy

Kata follows semantic versioning against the frozen contracts below:

- **Major (`2.0.0`)** — a breaking change to any frozen contract: renaming or removing a field/event/code, changing what one *means*, or rejecting input that was previously valid.
- **Minor (`1.x.0`)** — a backward-compatible addition: a new optional run-spec field with a default, a new event type, a new optional field on an existing event, a new exit code for a new condition, a new CLI subcommand or flag.
- **Patch (`1.0.x`)** — bug fixes that do not change any contract.

The test: **would existing, correct consumer code or an existing valid run-spec break?** If yes, it is major. If it only *adds* something an old consumer can ignore, it is minor.

## Frozen contracts

### 1. The run-spec — `RunSpec`, format `schema = 1`

The TOML/JSON run-spec (`crates/kata-core/src/spec.rs`). Machine mirror: `schema/kata-runspec.schema.json` (drift-gated in CI).

**Frozen:** the field names, types, defaults, and semantics of every `RunSpec` field and sub-type (`identity`, `plugins`, `model`, `leash`, `auth`, `interactive`, `env`, `env_remove`, …); the `schema = 1` format version; TOML and JSON loading; the structural rules `validate` enforces (required `name`/`task`/`workdir`; `leash.max_turns >= 1`; `leash.max_budget_usd > 0`; `env`/`env_remove` well-formedness and disjointness).

**Breaking (major):** renaming or removing a field; changing a field's type or its default's meaning; tightening `validate` to reject a spec that was previously valid; requiring a `schema` value other than 1.

**Additive (minor):** a new **optional** field with a default that preserves current behavior when absent; loosening validation to accept more specs.

### 2. The event protocol — `KataEvent`, `protocolVersion = 1`

One JSON object per line on the engine's stdout (`crates/kata-core/src/event.rs`). Machine mirror: `schema/kata-events.schema.json` (drift-gated in CI).

**Frozen:** the event `type` tags and each event's field names and semantics, for all twelve — `run.started`, `log`, `assistant.text`, `tool.use`, `tool.result`, `turn`, `ask.requested`, `ask.answered`, `run.diff`, `run.completed`, `run.error`, `run.cancelled`; the one-object-per-line framing; the guarantee that exactly one terminal event (`run.completed` / `run.error` / `run.cancelled`) ends every stream; that `ask.*` events appear only when `[interactive] enabled = true`.

**Breaking (major):** renaming or removing an event type or a field; changing a field's meaning; changing the single-terminal-event guarantee or the framing.

**Additive (minor):** a new event type; a new **optional** field on an existing event.

**Not part of this contract:** the *text* of a `log` event's `message` (its `level` field is frozen; the prose is not), and the *text* of `assistant.text` / tool summaries (passthrough of agent output, not a Kata-defined value).

### 3. Exit codes — the leash

The process exit code of `kata run` (and the CLI's own codes). Consumers and CI branch on these.

**Frozen:**

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | (CLI) spec validation failed. |
| 2 | (CLI) could not load/parse the spec, or an engine error. |
| 73 | (CLI) `kata init` refused to overwrite an existing file (`EX_CANTCREAT`). |
| 122 | Budget ceiling reached (`leash.max_budget_usd`). |
| 123 | Answer deadline exceeded (`interactive.answer_timeout_secs`). |
| 124 | Wall-clock timeout (`leash.timeout_secs`, or the 1800s default). |
| 125 | Turn cap reached (`leash.max_turns`). |
| 130 | Cancelled. |

**Breaking (major):** reassigning the meaning of any code above.

**Additive (minor):** assigning a new, previously-unused code to a new condition. (`70`/`EX_SOFTWARE` is an internal "unexpected error" placeholder, not a contractual outcome.)

### 4. The engine invocation and control channel

How a consumer drives a run (`docs/consuming-kata.md`).

**Frozen:** `kata run <spec>` emits `KataEvent` lines on **stdout** and human-readable noise plus the transcript path on **stderr**, and its exit code is the leash outcome; the stdin control lines `cancel` and `answer <id> <json>`; `kata validate <spec>` as a side-effect-free preflight whose exit codes are 0/1/2 as above.

**Breaking (major):** changing which stream carries events; changing the grammar of a control line; changing `validate`'s exit-code semantics.

**Additive (minor):** new subcommands, new flags, new control-line commands.

## Explicitly NOT frozen

These may change in any release; do not build load-bearing consumers on them.

- **The `kata_core` Rust API.** It is the reference implementation of the contracts above, not a frozen surface. Signatures may shift between releases — pin a version.
- **The `ask_user` MCP server** (its tool name, input schema, and the localhost bridge). This is an internal implementation detail of interactive runs. Consumers interact with the human-in-the-loop flow **only** through the `ask.requested` / `ask.answered` events and the `answer` control line — never the MCP directly.
- **Log and passthrough text**, as noted under the event protocol.
- **The transcript file's format and location**, the disposable kit (`--plugin-dir`) assembly, and the exact `#:schema` URL scheme beyond "it points at the tagged schema for the emitting version."
- **Internal module layout**, the `fake-claude` test binary, and test harnesses.

## How the contracts are guarded

- **Shape drift** is caught automatically: the `schema/kata-runspec.schema.json` and `schema/kata-events.schema.json` freshness tests and the ts-rs bindings fail CI if a type's shape diverges from its published artifact.
- **Semantic breaks** — renaming an event, repurposing an exit code, changing a field's meaning — are **not** caught by the drift gates. A change touching `spec.rs` (`RunSpec`/`validate`), `event.rs` (`KataEvent`), the exit codes, or the CLI's stdin/stdout behavior must be reviewed against this document. If it breaks a frozen contract, it is a `2.0.0`.
