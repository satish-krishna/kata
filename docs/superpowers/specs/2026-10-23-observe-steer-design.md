# Observe + steer — design

Status: draft for review · 2026-10-23 · target milestone **Observe + steer** (the M9 follow-on in `ROADMAP.md`)

## Context

M9 gave Kata its first back-channel: claude asks, the operator answers (`ask_user`), and claude asks permission, the operator decides (`approve_tool`). Both are **agent-initiated** and both ride a Kata-hosted MCP tool, because in 2026-06 the only way to put a human between claude's turns was a tool call that blocks. The 2026-06-18 interactive-sessions design rejected the alternative, claude's `--input-format stream-json` stdin, as undocumented.

This design adds the other half: **operator-initiated steering.** While a run is working, the operator types a message in the Workbench Observe pane and claude receives it as a new user turn in the same session.

## Feasibility findings

The question was whether to rebuild the engine's wiring on the Claude Agent SDK to get observe and steer. The answer is no; Kata reaches steering more directly over NDJSON.

- **The Agent SDK is a wrapper around the same NDJSON.** The TypeScript and Python SDKs spawn the `claude` binary (they bundle one) with `--input-format stream-json --output-format stream-json`, and add a control protocol over the same pipe. Every SDK steering feature is a message on claude's stdin.
- **The SDK adds nothing Kata needs for observe.** Kata already parses claude's `stream-json` output into `KataEvent`. The SDK's typed messages would be a second schema to keep in step with the frozen event protocol.
- **The SDK costs Kata its single execution path.** It exists only in TypeScript and Python. Kata is Rust and Shokunin is .NET, so adopting it means a Node sidecar between `kata` and `claude`, on the path the GUI, Shokunin and CI all share.
- **The SDK carries an auth restriction.** Its docs say third-party products built on it may not offer claude.ai login unless Anthropic approves.
- **The SDK does not give Kata a fuller or emptier room.** With `settingSources` omitted and the `claude_code` system-prompt preset it loads the full Claude Code setup, which is what `claude -p` without `--bare` already does. Kata's empty room is the opposite posture, and the SDK cannot switch off managed policy settings, `~/.claude.json` or auto memory either.
- **Streaming user messages is now documented.** The CLI reference lists `--input-format stream-json`, `--replay-user-messages` (echo each consumed user message back on stdout), and how a queued message behaves at a `--max-turns` limit. The headless docs say that in this mode a run stays open until stdin closes. That part of the 2026-06 rejection no longer holds.
- **The control protocol is still undocumented.** `interrupt`, `set_permission_mode`, `set_model`, `can_use_tool` and hook callbacks are SDK internals with no wire contract for other callers. The `capabilities` array in `system/init` (for example `interrupt_receipt_v1`) suggests it is becoming one, but nothing frozen should rest on it yet.

Decision: **speak the documented subset of stream-json input from Rust.** User messages carry the prompt and every steer. Permissions and questions stay on the existing MCP bridges. The control protocol stays out of scope until it is documented.

## Goal

- While a run is live and not paused on the operator, the operator can send free text to claude from the Observe pane.
- The message reaches claude as a user message in the same session. If claude is mid-turn it is queued and read before claude's next model request. Claude decides what to do with it, exactly as with a message typed into interactive Claude Code.
- The transcript records what was sent and when claude picked it up, so a run's history shows the steering.
- A headless consumer (kata-cli, Shokunin, CI) can steer through the same stdin line the Workbench uses.

## Non-goals

- **Interrupting a turn.** Stopping claude mid-turn and replacing what it was doing needs either the undocumented `interrupt` control message or SIGINT, whose exit behavior under stream-json input is unverified and has no clean Windows equivalent. Deferred to a follow-up, gated on the probe in *Open questions*.
- **Keeping a session open after it finishes.** Kata runs one job to completion. A run ends at claude's final `result`; a follow-up is a new run. Resume and chat are out of scope.
- **Changing permission mode or model mid-run.** Both are control-protocol only.
- **Adopting the Agent SDK.** See Feasibility.
- **A run-spec field.** Steering is something the operator does to a live run, not part of what to run. The spec and its schema are unchanged.

## Architecture

```
Workbench composer ──submit_steer──▶ Tauri ──"steer <id> <json>"──▶ kata-cli stdin
                                                                       │
                                                               SteerRx inbox
                                                                       │
                                     run loop ── user-message JSON line ──▶ claude stdin
                                        ▲                                       │
                                        └── replayed user message (stdout) ─────┘
                                                 → steer.delivered
```

### 1. Claude's stdin becomes a pipe the engine owns

`run.rs` spawns claude with `.stdin(Stdio::null())` today, so an unauthenticated claude cannot block on an inherited terminal. That reason stays satisfied: the engine owns the pipe, never inherits the parent's stdin, and the wall-clock leash still applies.

`command::build_invocation` changes:

- Add `--input-format stream-json` and `--replay-user-messages` (the latter requires stream-json on both sides, which Kata already has for output).
- Keep `-p` (print mode) but drop the prompt argument. `compose_prompt(spec)` is written instead as the **first user message** on stdin, right after spawn. That also removes Windows' command-line length limit on long tasks and contexts.

The first message, like every steer, is one line:

```json
{"type":"user","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null,"uuid":"<id>"}
```

This is always on, with no opt-in. It is wiring, not posture: a run that is never steered behaves as it does today.

### 2. When the run ends

Under stream-json input, claude does not exit after its `result` until stdin closes. The engine therefore decides the end:

- On a `result` line, if every steer sent to claude has been **delivered** (claude echoed it back), the run is over: the engine closes claude's stdin, stops accepting steers, and collects the exit as today.
- If a steer was sent but not yet echoed when `result` arrives, it is still queued inside claude and starts another turn. The engine keeps stdin open and waits for the next `result`.
- A `steer` line that reaches the engine after it has closed claude's stdin, or after a terminal event, is refused with `steer.rejected` (`reason: "run ending"`).

Every leash outcome (turn cap 125, timeout 124, answer deadline 123, budget 122, cancel 130) still kills the child exactly as now. Closing stdin is only the normal-completion path.

### 3. The steer inbox

Alongside `AnswerRx` and `DecisionRx`, `run.rs` gains a `SteerRx` and `steer_channel()`, polled once per loop iteration:

- A steer arriving while the run is `running` is written to claude's stdin at once, and the engine emits `steer.sent`. Claude queues it if it is mid-turn.
- A steer arriving while the run is **paused on the operator** (a pending `ask.requested` or `permission.requested`) is refused with `steer.rejected` (`reason: "awaiting operator"`). Claude is blocked inside a tool call and would only read the message after the tool returns, by which point the operator's answer may have made it stale. The composer is disabled in this state anyway; this rule covers a headless caller.
- A duplicate `id` is refused with `steer.rejected` (`reason: "duplicate id"`).
- An empty inbox (kata-cli stdin at EOF, or a library caller that passes none) means nobody will steer. Unlike the answer inbox, that is not a failure: no exit 123, the run simply proceeds.

A steered message starts a new turn as far as claude is concerned, so it counts against `leash.max_turns` like any other turn. Steering never pauses the work-clock.

### 4. The stdin line (kata-cli)

`parse_stdin_line` gains one shape beside `cancel`, `answer` and `decide`:

```
steer <id> <json-string>
```

`<id>` is chosen by the caller (the Workbench generates one per message so it can match its optimistic bubble to the events). It must be non-empty, without whitespace, and unique within the run. `<json-string>` is a JSON string literal, so the text can carry newlines and quotes. An empty or whitespace-only text is ignored.

The engine uses `<id>` as the message `uuid`. That is how it recognizes the replay, if claude echoes the uuid (see *Open questions*).

### 5. Events

Three additive events. `protocolVersion` stays 1 and `CONTRACTS.md` records a minor change.

| Event | Fields | When |
|---|---|---|
| `steer.sent` | `id`, `text` | The engine wrote the message to claude's stdin. |
| `steer.delivered` | `id` | Claude's stdout replayed that user message, so claude has read it. |
| `steer.rejected` | `id`, `reason` | The engine refused the line (`awaiting operator`, `run ending`, `duplicate id`). |

`event::StreamParser` must tell a replayed user message (text content, `uuid` echoed) apart from the `user` lines that carry `tool_result` blocks. The prompt's own replay is consumed silently and emits nothing.

### 6. Workbench

**Backend (`app/src-tauri/src/lib.rs`).** A `submit_steer(run_id, id, text)` command, a sibling of `submit_answer`, writes the `steer` line to that run's engine stdin through the existing per-run writer. Register it in `generate_handler!`.

**Transport.** `KataTransport.submitSteer(runId, id, text)`. `TauriTransport` invokes `submit_steer`. `MockTransport` emits `steer.sent` at once and `steer.delivered` on the scripted timeline's next turn, so `?demo=run` can show it.

**Run state (`core/run/run.store.ts`).** The store folds the three events into `steers: SteerRecord[]`:

```ts
interface SteerRecord { id: string; text: string; at: number; state: 'pending' | 'sent' | 'delivered' | 'rejected'; reason?: string }
```

`submitSteer` adds a `pending` record before calling the transport, so the bubble appears immediately. A failed transport call marks it `rejected`.

**Observe pane (`ui/observe-pane.ts`).**

- New input `steers` and new output `steer = output<string>()`. The ViewModel generates the id and calls the store, so the component stays presentational.
- The **composer** is a Helm `textarea` and a send button docked below the stream, in the space the `AskPanel` uses when a question is open.
  - Enter sends, Shift+Enter adds a newline. The send button is disabled for empty text.
  - It is shown while the run is `running` or `awaiting`, and hidden for `idle` and every terminal state.
  - While `awaiting` it is disabled, with the hint "Answer the question above to keep steering." The `AskPanel` or permission card owns the bottom of the pane then.
  - Placeholder: "Message claude — it reads this before its next step."
- **Steer rows** are spliced into the stream by `at`, the same way `withPauses` splices asks and permission checks (extend `lib/toolcards.ts`). An operator row is right-aligned in the transcript's operator style, with a quiet state line: "Queued", "Read by claude" or "Not sent: <reason>".
- Styles come only from CSS custom properties, per `app/CLAUDE.md`. No new color: `pending` and `sent` use the muted text token, `delivered` the default text, `rejected` the andon error token.

**Where the composer appears.** Everywhere `ObservePane` renders a live run: the Workbench, and the AI-SDLC session and build views. An input `steerable = input(true)` lets a host switch it off. The build view keeps the default unless review finds a reason not to (see *Open questions*).

**Parity.** The composer changes the running-state pixels (`?demo=run`). Re-blessing `app/parity/baseline/` needs the owner's sign-off, per `docs/adding-a-feature.md`.

## Testing

**fake-claude.**

- Every existing mode must read the first user message from stdin, since the prompt no longer arrives as an argument. A small shared helper does it.
- A new `steer` mode: read the first message and start a turn; for each further stdin line, echo it as a replayed user message and run another turn; emit `result` only after an idle gap with nothing queued; exit on stdin EOF.
- `blockstdin` changes meaning. It used to prove claude got a closed stdin; now it proves the engine closes stdin after `result`, and that a fake that never emits `result` is still reaped by the wall-clock timeout (124).

**Engine (`crates/kata-core/tests/run_it.rs`, `#[serial]`).**

- A steer is written, emitted as `steer.sent`, then `steer.delivered`, and starts an extra turn.
- A steer that is queued when `result` arrives keeps the run open for one more `result`.
- A steer during a pending ask is rejected with `awaiting operator`.
- A steer after the final `result` is rejected with `run ending`.
- `max_turns` counts steered turns.
- A run with no steer inbox behaves as today: same events, same exit codes.
- `command.rs` unit tests: `--input-format stream-json` and `--replay-user-messages` are present, and no prompt argument follows `-p`.

**CLI.** `parse_stdin_line` parses `steer`, including newlines and quotes in the JSON string, and refuses a missing id or non-string JSON. A `cli_it.rs` test pipes a `steer` line into `kata run`.

**Frontend.** Specs for the composer's states (hidden, enabled, disabled while awaiting, Enter versus Shift+Enter), the store's folding of the three events, and steer-row ordering in the stream. `check:boot` and `check:interaction` stay green.

**Real claude.** The opt-in smoke test (`KATA_SMOKE_REAL`) gains a steered run to confirm the replay shape against a real binary.

## Open questions (probe before building)

Each is a short manual run against a real `claude` recorded in an appendix to this spec, then frozen in a fake-claude mode.

1. **Replay shape.** Does `--replay-user-messages` echo the caller's `uuid`, and which field marks a line as a replay rather than a tool-result carrier? If the uuid is not echoed, match replays by order, since steers are delivered first-in, first-out.
2. **Mid-turn queueing.** Is a message written while claude is mid-turn read before the next model request, or only after the turn ends? The composer's wording depends on it.
3. **Slash commands in the first message.** Does `/<plugin>:<skill>` in a stdin user message expand the way it does as a `-p` argument? Some katas start with one. If not, keep the prompt as the `-p` argument and use stdin for steers only.
4. **Unauthenticated start.** With stdin piped, does an unauthenticated claude still fail fast with a `result` or stderr line instead of waiting? The wall-clock bounds it either way, but a fast failure is the contract today.
5. **The `result` and close race.** Can claude emit `result` and then consume a message written just before stdin closed? Check whether the delivered-or-not rule in *When the run ends* is enough or needs a short grace window.
6. **Minimum claude version** for `--replay-user-messages`. If an older one rejects the flag, `run.error` should say so plainly. There is no silent fallback to argument-only input.
7. **AI-SDLC build runs.** Should steering be offered on build runs, whose stage outputs feed a review loop? The default is yes; the owner decides.
8. **Interrupt follow-up.** What does SIGINT do to a stream-json-input `claude -p`: end the turn and wait for input, or exit? Answering this opens the "interrupt and steer" follow-up.

## Files touched

- `crates/kata-core/src/command.rs`: input-format flags; prompt moves off the command line.
- `crates/kata-core/src/run.rs`: piped stdin, first message, `SteerRx` / `steer_channel`, close-on-result rule, the three events.
- `crates/kata-core/src/event.rs`: `steer.*` variants; parser recognizes replayed user messages.
- `crates/kata-core/src/bin/fake-claude.rs`: stdin prompt helper, `steer` mode, `blockstdin` rework.
- `crates/kata-cli/src/main.rs`: `steer <id> <json>` line, wired to the steer channel.
- `schema/kata-events.schema.json`, `app/src/bindings/kata-events.ts`: regenerated (`KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema schema_artifact_is_fresh`, then `cd app && npm run gen:events`).
- `app/src-tauri/src/lib.rs`: `submit_steer`.
- `app/src/app/core/transport/*`: `submitSteer` in the abstract, Tauri and Mock transports.
- `app/src/app/core/run/run.store.ts`: `steers` and `submitSteer`.
- `app/src/app/ui/observe-pane.ts` (+ template, CSS, spec), `app/src/app/lib/toolcards.ts`: composer and steer rows.
- `app/src/app/workbench/workbench.view-model.ts` and the SDLC hosts: pass `steers`, handle `steer`.
- `CONTRACTS.md`: the `steer` stdin line joins the frozen set; the `steer.*` events are a minor addition.
- `CLAUDE.md`, `ROADMAP.md`: event list, the "claude never reads stdin" note, the Observe + steer milestone.
