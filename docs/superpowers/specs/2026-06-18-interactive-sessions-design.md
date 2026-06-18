# Interactive sessions — design

Status: draft for review · 2026-06-18 · target milestone **M9 (Observe + steer → recast as Observe + ask)**

## Context

Kata drives `claude -p` headless to completion and observes it. The empty room, the leash, the curated kit — Kata controls the edges, never the agent loop. The MVP is observe-only by design: a run takes no mid-flight intervention.

This design adds the first human-in-the-loop capability: **the agent can pause mid-run to ask the operator a question, and the operator answers in the Workbench.** It is agent-initiated only — claude asks, you answer. Unsolicited operator steering and tool-approval gates are explicitly out of scope (see Non-goals).

The UI for this already exists in the design system: `design/README.md` §3 ("Human-in-the-loop") specifies the run state, event protocol, and the `AskPanel` with three question kinds, and `prototype/hitl.html` is the pixel reference. This design adopts that UI and protocol verbatim, and supplies the engine mechanism the design handoff left unspecified.

## Goal

A spec marked interactive can have its run pause when claude asks a question; the Workbench surfaces the question(s), the operator answers, and the same `claude` session resumes with the answer fed back as a tool result. The agent never knows a human was involved — HITL is a property of the leash, not a change to the agent.

Question kinds supported (the four the product asked for, via the design's three `kind`s):

- **Yes/No** → `kind: "confirm"` (inline two-button choice)
- **Single choice** → `kind: "select"`, `multiSelect: false` (radio options)
- **Multiple choice** → `kind: "select"`, `multiSelect: true` (checkbox options)
- **Descriptive** → `kind: "text"` (free-form typed answer)

## Non-goals

- Operator-initiated steering (injecting unsolicited guidance mid-run). That is the roadmap's other M9 idea; it shares this back-channel and can land later.
- Tool-approval gates ("approve before this write"). The interactive heir to `--dangerously-skip-permissions`; deferred.
- Reverse-engineering claude's undocumented `--input-format stream-json` stdin protocol. Rejected — see Feasibility.

## Feasibility findings (why the obvious approach is dead)

Investigated against Claude Code's documented behavior:

- **`claude -p` cannot natively pause-and-ask.** Per the permission-mode docs: in headless mode there is no UI to ask the human, so the process is *terminated* when the model invokes an interactive prompt (e.g. the built-in `AskUserQuestion`). There is no "blocked on input" state and stdin is closed. So the design README's literal mechanism — "intercept the `AskUserQuestion` tool call at the edge" — is not reachable headless.
- **`--input-format stream-json` is undocumented.** The flag exists but the stdin message shape is reverse-engineered and unsupported (open upstream issue). We will not anchor a cross-language contract to it.
- **`--permission-prompt-tool` is undocumented/experimental.** Same rejection.
- **A normal tool call that blocks is fully supported.** A custom MCP tool whose result the controlling process supplies asynchronously is ordinary, documented behavior — the model waits for the tool result like any other tool. With `--dangerously-skip-permissions`, MCP tool calls are auto-approved (no prompt). This is the seam we build on.

## Architecture — Approach B: a Kata-hosted `ask_user` MCP tool

When `interactive.enabled`, the engine stands up a local MCP tool named `ask_user` and points the `claude` child at it, then appends a retasking note telling claude the tool exists. claude asks by *calling the tool*; the engine catches the call at the MCP boundary, surfaces the question, waits for the operator, and returns the answer as the tool result. One unbroken `claude -p` session, start to finish — no resume, no session store, no `--bare`/`--resume` conflict, and turn/leash accounting never skips.

### Flow

1. Engine resolves an interactive spec → stands up the `ask_user` server, generates an ephemeral `--mcp-config`, appends the retasking note, spawns `claude -p … --output-format stream-json --dangerously-skip-permissions` as today.
2. claude works normally. At a consequential fork it calls `ask_user({ questions: [...] })` and blocks on the result.
3. The engine's tool handler receives the call → emits `ask.requested` → run enters the `awaiting` state → the work-clock pauses and the answer-deadline starts.
4. The operator answers in the Workbench → answer travels app → kata-cli stdin → engine → returned as the tool result.
5. Engine emits `ask.answered`, run returns to `running`, the work-clock resumes; claude continues in the same session.

### Transport (the top implementation risk → first spike)

The engine is thread-based (no tokio/async; `run.rs` is threads + channels). To avoid dragging in an async HTTP stack, the recommended shape is:

- A thin `kata _mcp-ask` stdio MCP subcommand that `claude` launches itself (named in the generated `--mcp-config`). It speaks minimal MCP over stdio: `initialize`, `tools/list` (the single `ask_user` tool), `tools/call`.
- The subprocess bridges back to the run engine over a localhost TCP line-protocol: the engine listens on an ephemeral `127.0.0.1` port (passed to the subprocess via an env var), the subprocess sends the question JSON and blocks on a single answer line. Synchronous, cross-platform, std-only.

Alternative considered: an in-process MCP-over-HTTP server (no IPC, handler lives in the engine) — cleaner data flow but pulls in an async HTTP/MCP dependency the engine otherwise doesn't need. Defer unless the stdio+TCP bridge proves awkward.

**Spike before building anything on top** (opt-in real-claude, gated like the existing `KATA_SMOKE_REAL`): prove that (1) a custom MCP tool can block-and-return mid `-p` run, (2) it auto-approves under `--dangerously-skip-permissions`, and (3) `--bare` still lets claude load a `--mcp-config`. If the spike fails, fall back to Approach A (session resume) and re-open the `--bare`/`--resume` question.

## Event protocol (adopts `design/README.md` §3 names and payloads)

Two new `KataEvent` variants (Rust source of truth in `event.rs`, mirrored to TS via ts-rs):

```jsonc
// engine → observer: the run is paused on the leash, claude is waiting on you
{ "type": "ask.requested",
  "id": "q1",
  "questions": [
    { "kind": "select", "header": "auth", "question": "Which auth approach?",
      "options": [ { "label": "session cookie", "description": "server-side; simplest" },
                   { "label": "JWT", "description": "stateless; mobile-friendly" } ],
      "multiSelect": false } ] }

// engine → observer: answers accepted, session resumed
{ "type": "ask.answered", "id": "q1", "answers": [ ["JWT"] ] }
```

- `id` — a correlation id (engine addition on top of the design README's payload) so the `answer <id>` back-channel routes to the right pause. The only deviation from the design's protocol; everything else is its shape unchanged.
- `questions[]` — one or more questions surfaced in a single pause (the design's `AskPanel` already renders multiple). Each: `{ kind, header, question, options?, multiSelect?, optional?, placeholder? }`.
- `answers: string[][]` — one inner array per question, carrying the chosen option label(s) or the typed text. `confirm`/single-`select` → one element; multi-`select` → zero+; `text` → one (empty allowed when `optional`).

These supersede the `agent.question`/`agent.answered` names floated during brainstorming; we use the design system's names so the shipped CSS, prototype, and frontend store stay consistent.

### The back-channel (extends kata-cli stdin)

Today kata-cli's stdin understands one line: `cancel`. We add one shape beside it:

```
answer <id> <json>      # <json> is the answers: string[][] payload for request <id>
```

The CLI routes it to the engine, which hands it to the blocked tool handler. `cancel` still works while awaiting (kills claude + the `_mcp-ask` subprocess; the blocked handler unblocks and the run ends with exit 130).

## RunSpec change (`spec.rs`)

A new optional block — default off, so every existing spec, CI run, and Shokunin job is byte-for-byte unchanged:

```toml
[interactive]
enabled = true              # default false — the opt-in gate
answer_timeout_secs = 600   # optional; the answer-deadline. unset = wait until answered or cancelled
```

Mirrored to `app/src/bindings/` (`cargo test -p kata-core --features ts export_bindings`). When `enabled` is false the `ask_user` tool is never wired in, so claude *cannot* ask — the headless contract is preserved exactly.

## The leash (`run.rs`)

- **Work-clock pauses while awaiting.** On `ask.requested` the engine stops charging the wall-clock work deadline; on `ask.answered` it resumes. Human think-time never counts against the work timeout (implementation: accumulate waited duration and push the deadline out by it).
- **Separate answer-deadline.** `answer_timeout_secs` bounds how long the engine waits on the operator. Exceeded → reap the run with a new, distinct exit code **123 (answer deadline exceeded)** — kept separate from 124 (work timed out) so logs and CI can tell "the work ran too long" from "nobody answered." Unset → wait indefinitely until answered or cancelled.
- **Turn cap unchanged.** One session, so assistant-turn counting continues normally; no cross-spawn accounting.
- New run state `awaiting`. Exit-code table is otherwise preserved (124 timeout, 125 max turns, 130 cancel; CLI 1 validation, 2 load/parse).

## Retasking (`command.rs` / `assemble.rs`)

When `interactive.enabled`, the engine **always appends** a short system-prompt fragment — even under identity `Replace` mode, because it describes a Kata-provided capability the operator did not author:

> You have an `ask_user` tool. When you hit a consequential fork you cannot resolve from the task and context — ambiguous requirements, a decision with real trade-offs, a destructive action you are unsure about — call `ask_user` with a crisp question (choose the `kind` that fits: confirm / select / text) instead of guessing. Do not use it for trivia you can decide yourself.

Plus the generated `--mcp-config` wiring the `ask_user` server in. This composes with the existing append/replace identity logic; the fragment is additive and independent of the operator's own system prompt.

## Workbench UI (per `design/README.md` §3 and `prototype/hitl.html`)

The design is fully specified and the CSS exists in the design source but is **not yet vendored into the app** — the implementation ports it across and wires it up. No new visual design; style only against the existing CSS custom properties (`app/CLAUDE.md` rules: dark sumi-ink, single azure accent, andon status, IBM Plex, 13px base, no hard-coded hex).

- **Vendor the CSS.** Port the `.k-ask*` block and `.k-status--awaiting` + `@keyframes k-pulse-amber` from `design/design_system/components/components.css` into the app's `app/src/styles/components/components.css`. (Confirmed present in the source, absent in the app.)
- **New run state `awaiting`** (`app/src/lib/events.ts`): extend `RunState` to `"idle" | "running" | "awaiting" | "success" | "warning" | "error"`; add its `STATUS_LABEL`. The status dot is a **pulsing amber** (`.k-status--awaiting`). While awaiting, Run is replaced by Cancel and the bottom status bar reads `paused — waiting on your answer`.
- **The `AskPanel`** (`.k-ask*`) renders inline at the bottom of the event stream where the run paused — an amber banner (`awaiting your input` + the invoked tool name), then one block per question by `kind`:
  - `confirm` → `.k-ask__confirm` two-button pair; chosen button takes the azure accent.
  - `select` → `.k-ask__opts` / `.k-ask__opt` with radio marks, or checkbox marks when `multiSelect`; selected option takes azure border + tint + filled mark; option descriptions sit muted beneath.
  - `text` → a `.k-textarea`; `optional: true` lets it be left blank.
  - Footer (`.k-ask__foot`): hint `the run is paused on the leash` + a primary **Send answer · resume** button, disabled until every required question is answered.
- **Answered state** (`.k-ask--answered`): the banner turns jade (`answered · run resumed`), selections stay highlighted, typed text shows in `.k-ask__answer`, and the exchange stays in the permanent run log as the stream continues below.
- **Compose pane:** a small **Interactive** section — an enabled toggle (`interactive.enabled`) plus a conditional answer-timeout field (`answer_timeout_secs`), built from the existing `.k-field` / `.k-seg` primitives with the literal spec keys shown in mono.
- **Run store** (`app/src/lib/run.svelte.ts`): `handle()` routes `ask.requested` → store the pending question(s) + flip state to `awaiting`; `ask.answered` → clear + back to `running`. New `submitAnswer(id, answers)` → new `submit_answer` Tauri command → writes `answer <id> <json>` to the sidecar stdin (mirrors `cancel_run` at `app/src-tauri/src/lib.rs`).
- **Browser/mock path** (`app/src/lib/mock.ts`, `api.ts`): the scripted timeline gains an `ask.requested` step and a simulated answer so `npm run dev` + `?demo=run` shows the full pause → answer → resume loop with no native backend, preserving the `inTauri()` fixture discipline.

## CLI behavior + CI safety

- Headless `kata run` of an interactive spec still works: `answer <id> <json>` lines can be typed or piped to kata-cli's stdin (it already reads stdin for `cancel`). A terminal operator can answer too.
- **CI safety rests on the opt-in.** CI/Shokunin specs leave `[interactive]` off → `ask_user` is never wired → claude cannot ask → behavior is identical to today. An interactive spec run truly unattended simply waits out its answer-deadline and exits 123 — deterministic, never an indefinite silent stall.

## Testing

- **Spike first** (opt-in real-claude): the three transport unknowns above. Gate like `KATA_SMOKE_REAL`.
- **`fake-claude` gains an interactive mode** (`KATA_FAKE_MODE`): emits an `ask_user` tool call, waits for the answer, consumes it, continues — so the engine's await/answer/resume loop is exercised fully offline. These tests mutate process-global env → keep `#[serial]`.
- **Engine tests:** question → pause → answer → resume (each kind); answer-deadline → exit 123; work-clock excludes wait time; cancel while awaiting → exit 130; interactive-off → `ask_user` never offered.
- **Frontend (Vitest):** run-store transitions through `awaiting`; the mock timeline drives the `AskPanel` and the answered collapse.

## Risks & open questions

1. **MCP-blocks-mid-run** (the spike). If a custom tool cannot hold the turn open under `-p`, fall back to Approach A (session resume) and re-open the `--bare`/`--resume` conflict. Highest unknown — gated first.
2. **`ask_user` auto-approval** under `--dangerously-skip-permissions`. Expected (normal tool, not an interactive prompt), confirmed by the spike.
3. **`--bare` + `--mcp-config`.** Does the empty room still load an explicit MCP config? Likely yes (explicit flag, not ambient config); confirmed by the spike.
4. **Tool name in the UI banner.** MCP server tools are namespaced (`mcp__<server>__ask_user`); the banner copy ("awaiting your input" + invoked tool name) should show something legible, not the raw namespaced id.

## Spike results (2026-06-18)

Ran a Node.js stdio MCP server (`spike/ask-mcp/server.mjs`) exposing a single `ask_user` tool that sleeps 3 s then returns `"USER SAYS: JWT"`. Invoked via:

```
claude -p "Use the ask_user tool to ask me whether to use JWT or session cookies. Then tell me exactly what I chose." \
  --output-format stream-json --verbose --dangerously-skip-permissions \
  --mcp-config spike/ask-mcp/mcp-config.json
```

**Q1 — Does headless `claude -p` call the MCP tool, block on the (~3 s) result, then continue using the returned text? YES.**

Evidence — the `tool_use` line captured from the stream:

```json
{"type":"assistant","message":{"model":"claude-opus-4-8","id":"msg_017ZkXRjyKnX4tYZjegtwajV","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Un5PbMXcuec2mKzQD5fqUP","name":"mcp__kata-ask__ask_user","input":{"questions":["For authentication, should we use JWT (JSON Web Tokens) or session cookies?"]},"caller":{"type":"direct"}}], ...}}
```

Claude's final reply confirmed it acted on the answer: `"You chose **JWT**."`. Total run duration was 18 109 ms (api time 13 636 ms); the 3 s server sleep is accounted for within that window.

**Q2 — Does it auto-approve under `--dangerously-skip-permissions` (no prompt, no termination)? YES.**

The `result` line shows `"is_error":false`, `"terminal_reason":"completed"`, and `"permission_denials":[]`. No prompt was issued; the tool call succeeded without any approval gate.

**Q3 — Does `--bare` still load `--mcp-config` (tool is available in the empty room)? YES (partial caveat).**

The `system/init` line under `--bare` clearly shows `"mcp_servers":[{"name":"kata-ask","status":"pending"}]` — the config was parsed and the server registered. The run failed with `authentication_failed` because `--bare` on this machine skips keychain/OAuth and no `ANTHROPIC_API_KEY` is set; that is an environment constraint, not a `--mcp-config` parsing failure. The tool registration itself is confirmed.

**Real namespaced tool name:**

`mcp__kata-ask__ask_user`

The pattern is `mcp__<mcpServers-key>__<tool-name>`. Task 5's `parse_stream_line` should match on this exact name.

**`--append-system-prompt` inline vs file:**

Both work on this `claude` version (2.1.181):
- `--append-system-prompt "SWORDFISH"` (inline text) — confirmed: claude echoed the word.
- `--append-system-prompt-file /tmp/sp_probe.txt` — confirmed: claude echoed `SWORDFISH_FROM_FILE` from the file.

The `--help` output lists `--append-system-prompt <prompt>` as a named option and references `--append-system-prompt[-file]` in the `--bare` description, confirming both forms exist.

## Implementation surface (for the plan)

- `crates/kata-core/src/spec.rs` — `Interactive { enabled, answer_timeout_secs }` block; `validate`; ts-rs binding.
- `crates/kata-core/src/event.rs` — `AskRequested` / `AskAnswered` variants + `parse_stream_line` handling of the `ask_user` `tool_use`; ts-rs binding.
- `crates/kata-core/src/command.rs` / `assemble.rs` — retasking fragment, generated `--mcp-config`.
- `crates/kata-core/src/run.rs` — tool-call handler, answer back-channel, `awaiting` handling, work-clock pause, answer-deadline (exit 123).
- `crates/kata-cli/src/main.rs` — stdin `answer <id> <json>` parsing; new `_mcp-ask` subcommand (stdio MCP server + TCP bridge).
- `crates/kata-core` (`fake-claude`) — interactive `KATA_FAKE_MODE`.
- `app/src-tauri/src/lib.rs` — `submit_answer` command (write to sidecar stdin).
- `app/src/lib/events.ts`, `run.svelte.ts`, `api.ts`, `mock.ts` — `awaiting` state, event routing, `submitAnswer`, mock step.
- `app/src/lib/components/` — `AskPanel.svelte`; Compose **Interactive** section; ObservePane status + Cancel-while-awaiting.
- `app/src/styles/components/components.css` — vendor `.k-ask*` + `.k-status--awaiting`.
- `app/src/bindings/` — regenerated, not hand-edited.

## Sequencing (proposed)

1. **Spike** the MCP transport against real claude (throwaway). Gate the design on its result.
2. Engine contract: `spec.rs` + `event.rs` + ts-rs bindings (the cross-language surface first).
3. Engine mechanism: `_mcp-ask` server + TCP bridge + `run.rs` handler + leash + `fake-claude` interactive mode + tests.
4. Workbench: vendor CSS, `AskPanel`, store wiring, `submit_answer`, Compose toggle, mock timeline.
5. Docs: README usage note + roadmap M9 status.
