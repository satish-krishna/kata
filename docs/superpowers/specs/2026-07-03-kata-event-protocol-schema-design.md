# Kata event-protocol schema — enhancement design

- Date: 2026-07-03
- Status: **implemented** (Deliverable 1 + Optional item 2, PR #31). Deliverable 2 (the .NET package) and Optional item 1 (`notify`) remain deferred to their own sessions — see "Session scope & resolved decisions" below.
- Repo: **this spec targets the Kata repo** (`crates/kata-core`, `app/`); originally authored from the Jig session and staged here. Deliverable 1 and Optional item 2 have since been implemented in Kata.

## Goal

Turn Kata into a **multi-runtime distribution of one protocol**. Two deliverables:

1. **A single-source-of-truth schema** for the `KataEvent` protocol, from which every consumer generates types (cures Kata's existing internal drift).
2. **A .NET agent package** — the second *runtime* of the same protocol, so Kata speaks `KataEvent` both as a Rust CLI (local/desktop) and as a .NET NuGet (server/web). The schema is the contract both runtimes honor; it is what makes them agree.

Downstream, an app like Jig then consumes **the right flavor of Kata per wire** — bridge the CLI on desktop, host the .NET package on the web — and never implements an agent itself.

The event protocol is **not a feature add.** The event families are already complete (`assistant.text`, `tool.use`/`tool.result`, `ask.requested`/`ask.answered`, and the full run lifecycle in `KataEvent`). The gap is that the shape lives only in `crates/kata-core/src/event.rs`, and `app/src/lib/events.ts` mirrors it **by hand** (the code says so at the `Question` doc comment: "events are not ts-rs exported"). Two hand-kept copies already; the .NET runtime and Jig make four.

## The core change: publish a schema

1. **Derive a schema from the source of truth.** Add `schemars::JsonSchema` (or `ts-rs`, evaluated below) to `KataEvent` and its payload types — `Question`, `QuestionKind`, `QuestionOption`, `DiffFile`. Keep serde's existing `#[serde(tag = "type", rename = "run.started" …)]` tagging so the schema matches the wire exactly.
2. **Emit the schema as an artifact.** A `kata schema` subcommand (or a build step) writes a versioned `schema/kata-events.schema.json`, committed to the repo. Prefer a committed artifact plus a CI freshness check (regenerate and diff — the same guarantee Jig uses for its capability catalog), so the schema can never silently fall out of sync with the enum.
3. **Version the protocol.** Stamp a `protocolVersion` in the schema/artifact so consumers can pin and detect breaks.
4. **Retire the hand-mirror.** Generate `app/src/lib/events.ts` from the schema and delete the hand-written copy. This is the proof the schema works: Kata's own app consumes it first.

### `schemars` vs `ts-rs`

- **`ts-rs`** emits TypeScript directly — good for Kata's own Svelte app, but TypeScript-only, so Jig's .NET web loop can't consume it.
- **`schemars`** emits a JSON Schema — language-neutral, so TS (Kata app, Jig frontend) and C# (the .NET loop) all generate from one artifact.

Recommendation: **`schemars`**, because the whole point is a cross-language contract. Generate TS from the JSON Schema with `json-schema-to-typescript` (or `openapi-typescript`-style tooling) on both the Kata and Jig sides.

## Second deliverable: the .NET agent package

A NuGet package (working name `Kata.Agent`) that is a **second runtime of the same protocol** — where the Rust CLI wraps `claude -p`, this hosts the agent on the **Microsoft Agent Framework** and emits the identical `KataEvent` stream. This is the flavor Jig's web build hosts.

- **API surface.** Mirror the CLI's stdout/stdin as an idiomatic .NET streaming API: a run exposes an `IAsyncEnumerable<KataEvent>` (the event stream) plus an answer channel that accepts an `ask.answered` payload by id. The consumer (Jig's .NET API) hosts this behind SSE; it does not touch the Agent Framework.
- **Implementation.** Configure a `Microsoft.Agents.AI` `AIAgent` with the framework's **Anthropic connector so it runs Claude** — behavior parity with the CLI's `claude -p`. Map the framework's streaming run updates to `KataEvent` (assistant text → `assistant.text`, function calls → `tool.use`/`tool.result`, completion → `run.completed`), cleanest through framework **middleware**. Register **`ask_user` as a function tool** backed by the framework's human-in-the-loop / session state: emit `ask.requested`, block, resolve on an answer by id. If a durable pause needs more than tool-blocking, implement that leg as an Agent Framework **Workflow** with a HITL step.
- **Types from the schema.** The package generates its C# `KataEvent` types from Deliverable 1's JSON Schema, so the .NET runtime cannot drift from the Rust one. This is the concrete payoff of schema-first: two runtimes, one contract.
- **Parity.** Both runtimes run Claude and emit the same schema, so an app cannot tell the flavors apart beyond the transport.

The Agent Framework is released (GA), so this is a production dependency, not a preview gamble — but it is a new language and a substantial dependency entering the Kata repo (see Scope).

## Optional item 1: a `notify` MCP tool (probably not needed for v1)

Today `assistant.text` already relays the model's own output — the "message displayed on the UI" need is met. A `notify` tool would only add value if the agent should **curate** what the user sees, distinct from its full narration. Ship v1 on `assistant.text`; add `notify` (a non-blocking sibling of `ask_user`, emitting a new `message` event) only if raw assistant text proves too noisy in practice. Marked optional so it does not gate the schema work.

## Optional item 2: `tool.result` correlation (small, worth it)

`parse_stream_line` sets `ToolResult.name` to an empty string — the code's TODO notes that Claude's `tool_result` carries a `tool_use_id`, not the tool name. Correlate the `tool_use_id` back to the originating `tool.use` so results render with their tool. This is independent of the schema work but improves any consumer's tool display, including Jig's chat feature.

## Consumers of the published schema

- **Kata's own `app/`** (generated `events.ts`, hand-mirror retired) — the first consumer and the regression guard.
- **Kata's own `.NET` runtime** (generated C# types) — the package above; the second producer of the protocol.
- **Jig frontend** (`AgentEvent` TS types).

## Testing

- Keep the existing `event.rs` serde round-trip tests unchanged — they already pin the wire shapes.
- Add a test/CI check that the committed `schema/kata-events.schema.json` matches the current enum (regenerate-and-diff).
- Add a round-trip through the generated TS types for a representative event of each family.
- **Cross-runtime conformance:** a shared fixture of one event per family that both runtimes must produce/serialize identically, so the Rust CLI and the .NET package cannot diverge.

## Non-goals

- No new event families (they exist).
- No protocol redesign or renaming of existing events (would break Kata's own app and any consumer).
- No token-level streaming events — Kata's protocol stays coarse by design.

## Scope

The .NET package is a deliberate expansion of Kata's surface: a Rust-first repo gains a second-language runtime and a substantial dependency (the Agent Framework). That is the correct home for it — the alternative is every downstream app reimplementing the web agent — but it is real, ongoing maintenance (two runtimes to keep conformant, a .NET publish pipeline). Own it consciously. The schema-first approach and the cross-runtime conformance tests are what keep the two runtimes from drifting.

## Session scope & resolved decisions (2026-07-03, Kata implementation session)

This spec is now being implemented *in Kata*. The implementing session is scoped to **everything except the .NET package** (Deliverable 2), which remains its own future session per Sequencing below. Concretely, in scope:

- **Deliverable 1** in full — schemars derive on `KataEvent` + payload types, a committed versioned `schema/kata-events.schema.json`, a `protocolVersion` stamp, generated `events.ts` types replacing the hand-mirror, and a CI freshness check.
- **Optional item 2** — `tool.result` `tool_use_id` correlation.

Resolved implementation decisions:

1. **Codegen mechanism: `schemars` (not `ts-rs`).** The whole point is a language-neutral contract for the future .NET runtime; ts-rs would be TypeScript-only and get redone later. Pin kata-core to `schemars` **1.x** (1.2.x is already transitive in `Cargo.lock`, so no new major version enters the tree).
2. **Derive is feature-gated + the artifact is emitted by a feature-gated test**, mirroring the existing `ts`/`export_bindings` idiom — *not* a runtime `kata schema` subcommand. This keeps `schemars` an optional dependency (no compile-cost tax on the shipped `kata` binary) and reuses the repo's regen-and-diff CI guarantee. The spec's "a `kata schema` subcommand **or a build step**" explicitly permits this.
3. **Optional item 1 (`notify` MCP tool) is excluded**, per the spec's own recommendation to ship v1 on `assistant.text`.
4. **TS generation preserves the hand-written helpers.** `app/src/lib/events.ts` is half type-union, half hand-written render/status helpers (`gutterFor`, `variantFor`, `bodyFor`, `statusForExit`, `RunState`, `STATUS_LABEL`, `isStreamEvent`). Only the *type union* + `Question`/`QuestionKind`/`QuestionOption`/`DiffFile` types are generated (into a separate `bindings/` file); the helpers stay hand-written and import the generated types.
5. **`protocolVersion`** is stamped as a constant in `kata-core` and injected into the schema artifact so consumers can pin and detect breaks. Starts at `1`.

## Sequencing

1. **Schema first** — publish it and retire the hand-mirror; nothing else can generate types until it exists.
2. **The .NET package** — generates its C# types from the schema, implements the Agent Framework runtime.
3. Both unblock the Jig agent-streaming feature (companion spec `2026-07-03-agent-streaming-design.md`), which cannot begin until the schema (for codegen) and the package (for the web provider) exist. Do all of this in its own Kata session.
