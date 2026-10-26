# Kata Contracts

This document names the **stable, frozen surfaces** of Kata and the versioning rules that govern them. It was first written for `v1.0.0` and is current as of `v3.2.0`; the breaking changes made since then (`v2.0.0`, `v3.0.0`) are recorded inline under the surface they changed. It is the authority; `docs/consuming-kata.md` explains how to *use* these contracts, and this file defines what may and may not change under them.

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

**Frozen:** the field names, types, defaults, and semantics of every `RunSpec` field and sub-type (`identity`, `plugins`, `model`, `leash`, `auth`, `interactive`, `permissions`, `env`, `env_remove`, …); the `schema = 1` format version; TOML and JSON loading; the structural rules `validate` enforces (required `name`/`task`/`workdir`; `leash.max_turns >= 1`; `leash.max_budget_usd > 0`; `env`/`env_remove` well-formedness and disjointness; the `permissions` coherence rules — `allow`/`deny`/`ask` rules only under `mode = "prompt"` or `"auto"` (a `bypass` spec that sets any is rejected), `unmatched = "ask"` and any `ask` rule only with `interactive.enabled`, `unmatched = "deny"` or `"allow"` rejected under `mode = "auto"`, well-formed rule syntax).

**Breaking (major):** renaming or removing a field; changing a field's type or its default's meaning; tightening `validate` to reject a spec that was previously valid; requiring a `schema` value other than 1.

**Additive (minor):** a new **optional** field with a default that preserves current behavior when absent; loosening validation to accept more specs.

**The `[given]` section (optional).** `given` lists the items a run starts without, in five lists of item identities (each entry switches one item off): `hooks`, `skills`, `plugins`, `instructions` and `tool_servers`. An identity is `<source>:<kind>:<key>` in lowercase kebab case for source and kind, for example `project-local:instruction:CLAUDE.local.md` or `run-spec:skill:triage`; a hook's key is `<event>:<matcher or *>:<fnv1a64 of the command as 16 hex digits>`, so the command itself is never saved. A spec without `given` makes no choices; `[given]` with empty lists chooses "everything on". Entries that match nothing at run time are ignored. `validate` refuses an entry that does not parse, one in the list of the wrong kind, and any `kata:` entry (Kata's own items cannot be switched off). Two more optional fields say what kind of run it is, written by the Workbench and honored by every `kata run`: `required_plugins` (plugin names, without a marketplace, the run cannot work without; each is shown locked on, and `validate` refuses a `plugins` entry that switches one off) and `build` (true for a build run; `validate` refuses a `project` or `project-local` hook in `hooks` when it is true). Both are skipped when empty or false, so an existing spec round-trips unchanged.

### 2. The event protocol — `KataEvent`, `protocolVersion = 1`

One JSON object per line on the engine's stdout (`crates/kata-core/src/event.rs`). Machine mirror: `schema/kata-events.schema.json` (drift-gated in CI).

**Frozen:** the event `type` tags and each event's field names and semantics, for all fifteen — `run.started`, `log`, `assistant.text`, `tool.use`, `tool.result`, `turn`, `ask.requested`, `ask.answered`, `permission.requested`, `permission.decided`, `run.given`, `run.diff`, `run.completed`, `run.error`, `run.cancelled`; the one-object-per-line framing; the guarantee that exactly one terminal event (`run.completed` / `run.error` / `run.cancelled`) ends every stream of a run that got under way (three startup failures emit no terminal event and end with exit 2: an invalid spec and a kit that cannot be assembled emit no event at all, and a failure to spawn `claude` may emit only `run.given`; an authentication refusal or a worktree that cannot be made still ends with `run.error`, exit code 2); that `ask.*` events may appear on any run, and `permission.*` events only when `[permissions] mode` is `"prompt"` or `"auto"`.

**`run.given` (additive, minor).** What the run was given: `items[]` (each `id`, `kind`, `source?`, `name`, `detail`, `brought_by?`, `lock?`, `off`, `status`), `settings`, `env[]` (names only, never a value), `warnings[]` and `options` (`required_plugins[]` and `build`, the options the run was resolved with; optional, and absent from a run recorded before it existed). It is emitted when Claude's start report arrives and again whenever the hook lines seen so far change what is known about which hooks fired, so **the last `run.given` wins**: a consumer keeps only the last one. Every run that gets past validation and kit assembly emits at least one, whatever its ending: a run refused for authentication or whose worktree could not be made emits it before its `run.error`, and one that failed to spawn emits it with no terminal event, in each case with the "no start report" statuses; so does a run that ends before any start report, before `run.diff`. A hook is matched to the lines Claude reports when it fires (`<event>` or `<event>:<trigger>`, the trigger being the tool name or session-start reason) by its matcher as a regular expression that must match the whole trigger; a switched-off hook reads "fired" only when more hooks started than the kept ones account for, and lines no listed hook accounts for read "fired, source unknown". A project skill, agent or command Kata carried over is reported by Claude as `kata-proj:<name>` and a carried project tool server as `dynamic`; both read as the project's item, and Kata's own `kata-proj@inline` plugin is not listed. The `items` list is the one resolved when the run started and never follows edits to the setup made while it runs. `status` is the verdict Kata computed from what it passed and what Claude reported; a consumer labels it and never derives it. An item with no `source` is one Claude reported that Kata did not know.

**Breaking in `v3.0.0`:** `ask.*` events are no longer confined to `[interactive] enabled = true`. No permission mode stops claude from wanting to ask a question, and its built-in `AskUserQuestion` kills a headless `claude -p` session — so every run now gets Kata's `ask_user` tool, and a question on any run emits `ask.requested` and pauses on the operator. There is no automatic answer. **A consumer must handle `ask.requested` on every run** — answer it, or close the engine's stdin so the run ends with 123 (see exit codes) — rather than assume a non-interactive spec never asks. `interactive.enabled` correspondingly narrows to "permission checks may pause on the operator", and `interactive.answer_timeout_secs` bounds the wait on every run.

**Breaking in `v2.0.0`:** `permission.decided` is no longer emitted for every check. Kata does not match permission rules — under `mode = "prompt"` the spec's `allow`/`deny` are written into a generated claude settings file and claude enforces them itself, before it ever consults Kata's prompt tool and before its own built-in read-only auto-approve. A call settings (or the auto-approve) resolve is never seen by Kata and gets no `permission.decided` event at all. `permission.decided` now fires only for a check that reaches Kata's own tool: the `unmatched` policy, the operator, or one of Kata's own bridge tools. **A consumer must stop treating the event stream as a complete audit trail of every permission check** — it is a record only of the checks Kata itself answered.

Not frozen: the *set* of `decided_by` values on `permission.decided`. Today it is `unmatched-policy` / `operator` / `engine` (the last for Kata's own bridge tools, `ask_user`/`approve_tool`, which are exempt from the rules). Kata no longer matches permission rules itself, so a `decided_by` value naming a *rule* as the resolver can no longer occur — a call an `allow`/`deny` rule resolves is settled by claude directly, from its own generated settings file, and never reaches Kata at all, so it never gets a `decided_by` value from this set. A consumer must treat an unrecognized value as "something else decided it" rather than failing.

**Breaking (major):** renaming or removing an event type or a field; changing a field's meaning; changing the single-terminal-event guarantee or the framing.

**Additive (minor):** a new event type; a new **optional** field on an existing event.

**Not part of this contract:** the *text* of a `log` event's `message` (its `level` field is frozen; the prose is not), and the *text* of `assistant.text` / tool summaries (passthrough of agent output, not a Kata-defined value).

### 3. Exit codes — the leash

The process exit code of `kata run` (and the CLI's own codes). Consumers and CI branch on these.

**Frozen:**

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | (CLI) `kata validate`: spec validation failed. `kata run` reports an invalid spec as 2; when no leash trips it passes claude's own exit code through, so a failed claude run can also exit 1. |
| 2 | (CLI) could not load/parse the spec, or an engine error. |
| 73 | (CLI) `kata init` refused to overwrite an existing file (`EX_CANTCREAT`). |
| 122 | Budget ceiling reached (`leash.max_budget_usd`). |
| 123 | Nobody answered — an unanswered question or an undecided permission check outlived `interactive.answer_timeout_secs`, or the engine's answer channel was closed (kata-cli stdin at EOF) so no answer could ever arrive. |
| 124 | Wall-clock timeout (`leash.timeout_secs`, or the 1800s default). |
| 125 | Turn cap reached (`leash.max_turns`). |
| 130 | Cancelled. |

**Breaking (major):** reassigning the meaning of any code above.

**Additive (minor):** assigning a new, previously-unused code to a new condition. (`70`/`EX_SOFTWARE` is an internal "unexpected error" placeholder, not a contractual outcome.)

### 4. The engine invocation and control channel

How a consumer drives a run (`docs/consuming-kata.md`).

**Frozen:** `kata run <spec>` emits `KataEvent` lines on **stdout** and human-readable noise plus the transcript path on **stderr**, and its exit code is the leash outcome; the stdin control lines `cancel`, `answer <id> <json>`, and `decide <id> allow|deny [reason]`; `kata validate <spec>` as a side-effect-free preflight whose exit codes are 0/1/2 as above.

**Breaking (major):** changing which stream carries events; changing the grammar of a control line; changing `validate`'s exit-code semantics.

**Additive (minor):** new subcommands, new flags, new control-line commands.

## Explicitly NOT frozen

These may change in any release; do not build load-bearing consumers on them.

- **The `kata_core` Rust API.** It is the reference implementation of the contracts above, not a frozen surface. Signatures may shift between releases — pin a version.
- **The `mcp-ask` MCP server** — the `ask_user` and `approve_tool` tools, their input schemas, and the localhost bridge frames. These are internal implementation details of every run (`ask_user`) and of prompt- and auto-mode runs (`approve_tool`). Consumers interact with the human-in-the-loop flow **only** through the `ask.*` / `permission.*` events and the `answer` / `decide` control lines — never the MCP directly.
- **Log and passthrough text**, as noted under the event protocol.
- **The transcript file's format and location**, the disposable kit (`--plugin-dir`) assembly, and the exact `#:schema` URL scheme beyond "it points at the tagged schema for the emitting version."
- **Internal module layout**, the `fake-claude` test binary, and test harnesses.

## How the contracts are guarded

- **Shape drift** is caught automatically: the `schema/kata-runspec.schema.json` and `schema/kata-events.schema.json` freshness tests and the ts-rs bindings fail CI if a type's shape diverges from its published artifact.
- **Semantic breaks** — renaming an event, repurposing an exit code, changing a field's meaning — are **not** caught by the drift gates. A change touching `spec.rs` (`RunSpec`/`validate`), `event.rs` (`KataEvent`), the exit codes, or the CLI's stdin/stdout behavior must be reviewed against this document. If it breaks a frozen contract, it is a `2.0.0`.
