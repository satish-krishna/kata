# Interactive Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an opt-in run pause mid-flight so claude can ask the operator a question (Yes/No, single-choice, multiple-choice, or free text) and resume with the answer fed back as a tool result.

**Architecture:** claude calls a Kata-hosted `ask_user` MCP tool and blocks on its result (a normal, documented tool call — the only headless-safe pause mechanism). The `kata run` engine is the hub: it binds a localhost TCP bridge, the `ask_user` MCP server (`kata _mcp-ask`, spawned by claude) forwards question batches to it over that bridge, the engine emits `ask.requested` and pauses the work-clock, the operator answers (Workbench → kata-cli stdin), and the engine returns the answer down the bridge as the tool result and emits `ask.answered`. One unbroken `claude -p` session; no session resume.

**Tech Stack:** Rust (kata-core lib + kata-cli bin + fake-claude test bin), Tauri v2 (Rust backend), SvelteKit SPA (Svelte 5 runes, TypeScript), ts-rs bindings.

## Global Constraints

- TDD throughout: write the failing test, watch it fail, implement minimally, watch it pass, commit.
- `cargo clippy --all-targets -- -D warnings` must stay clean; `cargo build --locked` must stay green.
- Engine integration tests that mutate process-global env (`KATA_FAKE_MODE`, `KATA_CLAUDE_BIN`, `KATA_HOME`) are `#[serial]` — keep that.
- Exit-code contract (preserve, extend only as stated): turn cap **125**, wall-clock timeout **124**, cancel **130**; CLI validation **1**, load/parse **2**. New: answer-deadline exceeded **123**.
- Engine is thread-based (threads + `mpsc`), not async. Do not introduce tokio/an async HTTP stack into kata-core.
- `RunSpec` + catalog/enum types mirror to TS via ts-rs (`cargo test -p kata-core --features ts export_bindings`); never hand-edit `app/src/bindings/`. The `KataEvent` protocol is hand-mirrored in `app/src/lib/events.ts` (not ts-rs) — keep both in sync by hand.
- Frontend stays presentational; every backend call gates on `inTauri()` with a `mock.ts` fallback. Style only against CSS custom properties (`app/CLAUDE.md`); never hard-code hex. Windows Ctrl-based shortcuts.
- Event JSON uses snake_case keys (matching existing `input_summary`, `is_error`, `num_turns`) — `multi_select`, not `multiSelect`, despite the prototype's ad-hoc JS naming.
- Commit on branch `feat/m9-interactive-sessions` (already created; the design spec is committed there).

---

## Phase 0 — Spike (gates everything)

### Task 0: De-risk the MCP-tool pause mechanism against real claude

This is a throwaway experiment, not shipped code. It answers the three unknowns the design hinges on. If it fails, STOP and revisit Approach A (session resume) with the user before continuing.

**Files:**
- Create (throwaway, delete after): `spike/ask-mcp/mcp-config.json`, `spike/ask-mcp/server.mjs` (a node stdio MCP server is fine for the spike — fastest to write), `spike/ask-mcp/run.sh`.

- [ ] **Step 1: Write a minimal stdio MCP server** exposing one tool `ask_user` (inputSchema: `{ questions: array }`). On `tools/call` it prints the received arguments to its own stderr, then returns `{ "content": [ { "type": "text", "text": "USER SAYS: JWT" } ] }` after a 3-second sleep (simulating a human). Implement the JSON-RPC handshake: respond to `initialize` (echo `protocolVersion`, advertise `{ "tools": {} }` capability, `serverInfo`), accept the `notifications/initialized` notification, answer `tools/list` with the one tool, answer `tools/call`.

- [ ] **Step 2: Write the mcp-config** pointing at the server:

```json
{ "mcpServers": { "kata-ask": { "command": "node", "args": ["server.mjs"] } } }
```

- [ ] **Step 3: Run real claude headless against it** (needs an authenticated `claude` on PATH):

```bash
claude --bare -p "Use the ask_user tool to ask me whether to use JWT or session cookies, then tell me what I chose." \
  --output-format stream-json --verbose --dangerously-skip-permissions \
  --mcp-config spike/ask-mcp/mcp-config.json
```

- [ ] **Step 4: Record the answers to the three unknowns** in `docs/superpowers/specs/2026-06-18-interactive-sessions-design.md` under "Risks & open questions" (append a "Spike results" subsection):
  1. Does claude **call the MCP tool and block** on its (delayed) result, then continue using the returned text? (The mechanism works.)
  2. Does it **auto-approve** under `--dangerously-skip-permissions` (no permission prompt, no termination)?
  3. Does `--bare` **still load `--mcp-config`** (tool is available in the empty room)?
  - Also capture: the exact `tool_use` stream-json line shape for the namespaced tool (`mcp__kata-ask__ask_user` or similar) — Task 5's parser needs the real name, and whether claude accepts `--append-system-prompt <text>` inline vs only `--append-system-prompt-file`.

- [ ] **Step 5: Delete the spike dir and commit the findings**

```bash
rm -rf spike/
git add docs/superpowers/specs/2026-06-18-interactive-sessions-design.md
git commit -m "spike(m9): confirm ask_user MCP tool pauses headless claude"
```

**Gate:** all three answers YES → proceed. Any NO → stop, report to the user, reconsider Approach A.

---

## Phase 1 — The contract (cross-language types)

### Task 1: `Interactive` spec block

**Files:**
- Modify: `crates/kata-core/src/spec.rs` (struct + `RunSpec` field + `Default` + tests)
- Generated: `app/src/bindings/Interactive.ts`, `app/src/bindings/RunSpec.ts` (via ts-rs)

**Interfaces:**
- Produces: `kata_core::spec::Interactive { enabled: bool, answer_timeout_secs: Option<u64> }`; `RunSpec.interactive: Interactive`.

- [ ] **Step 1: Write the failing test** — append to `spec.rs` `mod tests`:

```rust
    #[test]
    fn interactive_defaults_off() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert!(!spec.interactive.enabled, "interactive must default off");
        assert_eq!(spec.interactive.answer_timeout_secs, None);
    }

    #[test]
    fn interactive_parses_explicit_table() {
        let toml = r#"
schema = 1
name = "a"
task = "t"
workdir = "/w"

[interactive]
enabled = true
answer_timeout_secs = 600
"#;
        let spec: RunSpec = toml::from_str(toml).unwrap();
        assert!(spec.interactive.enabled);
        assert_eq!(spec.interactive.answer_timeout_secs, Some(600));
    }
```

- [ ] **Step 2: Run it, expect failure**

Run: `cargo test -p kata-core spec::tests::interactive`
Expected: FAIL — no field `interactive` on `RunSpec`.

- [ ] **Step 3: Implement.** Add the struct after `Auth` in `spec.rs`:

```rust
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Interactive {
    /// Opt-in gate. When false, the engine never wires the ask_user tool, so
    /// claude cannot pause — behaviour is identical to a non-interactive run.
    #[serde(default)]
    pub enabled: bool,
    /// How long the engine waits on the operator's answer before reaping the run
    /// (exit 123). Unset = wait indefinitely until answered or cancelled.
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<u32>"))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_timeout_secs: Option<u64>,
}
```

Add the field to `RunSpec` (after `auth`):

```rust
    #[serde(default)]
    pub interactive: Interactive,
```

And to `RunSpec::default()` (after `auth: Auth::default(),`):

```rust
            interactive: Interactive::default(),
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cargo test -p kata-core spec::`
Expected: PASS (existing round-trip tests still pass — `interactive` is `skip`-free but defaults, so absent in minimal TOML, present when set).

- [ ] **Step 5: Regenerate TS bindings**

Run: `cargo test -p kata-core --features ts export_bindings`
Expected: `app/src/bindings/Interactive.ts` created; `RunSpec.ts` gains `interactive: Interactive`.

- [ ] **Step 6: Commit**

```bash
git add crates/kata-core/src/spec.rs app/src/bindings/
git commit -m "feat(spec): add [interactive] block (enabled + answer_timeout_secs)"
```

### Task 2: `ask.requested` / `ask.answered` events + question types

**Files:**
- Modify: `crates/kata-core/src/event.rs` (new `KataEvent` variants, `Question`/`QuestionKind`/`QuestionOption`, tests)

**Interfaces:**
- Produces: `KataEvent::AskRequested { id: String, questions: Vec<Question> }`; `KataEvent::AskAnswered { id: String, answers: Vec<Vec<String>> }`; `Question { kind, header, question, options, multi_select, optional, placeholder }`; `QuestionKind { Confirm, Select, Text }`; `QuestionOption { label, description }`. `Question`/`QuestionOption`/`QuestionKind` derive `Deserialize` (parsed from the `ask_user` tool input).

- [ ] **Step 1: Write the failing test** — append to `event.rs` `mod tests`:

```rust
    #[test]
    fn ask_requested_serializes_with_tag_and_questions() {
        let e = KataEvent::AskRequested {
            id: "q1".into(),
            questions: vec![Question {
                kind: QuestionKind::Select,
                header: "auth".into(),
                question: "Which approach?".into(),
                options: vec![QuestionOption { label: "JWT".into(), description: Some("stateless".into()) }],
                multi_select: false,
                optional: false,
                placeholder: None,
            }],
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""type":"ask.requested""#));
        assert!(s.contains(r#""kind":"select""#));
        assert!(s.contains(r#""multi_select":false"#));
        assert!(s.contains(r#""label":"JWT""#));
    }

    #[test]
    fn ask_answered_serializes_answers_matrix() {
        let e = KataEvent::AskAnswered { id: "q1".into(), answers: vec![vec!["JWT".into()]] };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""type":"ask.answered""#));
        assert!(s.contains(r#""answers":[["JWT"]]"#));
    }

    #[test]
    fn question_deserializes_from_tool_input() {
        let json = r#"{"kind":"confirm","header":"deploy","question":"Ship it?","options":[{"label":"Yes"},{"label":"No"}]}"#;
        let q: Question = serde_json::from_str(json).unwrap();
        assert_eq!(q.kind, QuestionKind::Confirm);
        assert_eq!(q.options.len(), 2);
        assert!(!q.multi_select);
    }
```

- [ ] **Step 2: Run it, expect failure**

Run: `cargo test -p kata-core event::tests::ask`
Expected: FAIL — unknown variants/types.

- [ ] **Step 3: Implement.** Add the two variants to `KataEvent` (before `RunError`):

```rust
    #[serde(rename = "ask.requested")]
    AskRequested { id: String, questions: Vec<Question> },
    #[serde(rename = "ask.answered")]
    AskAnswered { id: String, answers: Vec<Vec<String>> },
```

Add the supporting types after `DiffFile` (note `Deserialize`, since these are parsed from claude's tool-call input):

```rust
/// One question in an `ask.requested` batch. Mirrored by hand in
/// `app/src/lib/events.ts` (events are not ts-rs exported).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Question {
    pub kind: QuestionKind,
    pub header: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default)]
    pub optional: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionKind {
    /// Yes/No (or two-option) inline choice.
    Confirm,
    /// Single-choice (radio) or, with `multi_select`, multiple-choice (checkbox).
    Select,
    /// Free-form typed answer.
    Text,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cargo test -p kata-core event::`
Expected: PASS.

- [ ] **Step 5: Mirror the types in the frontend** — edit `app/src/lib/events.ts`. Add to the `KataEvent` union (before `run.error`):

```ts
  | { type: "ask.requested"; id: string; questions: Question[] }
  | { type: "ask.answered"; id: string; answers: string[][] }
```

Add the supporting types (after the `KataEvent` union):

```ts
export type QuestionKind = "confirm" | "select" | "text";
export type QuestionOption = { label: string; description?: string };
export type Question = {
  kind: QuestionKind;
  header: string;
  question: string;
  options?: QuestionOption[];
  multi_select?: boolean;
  optional?: boolean;
  placeholder?: string;
};
```

Extend the `StreamEvent` exclusion (ask events drive the AskPanel, not an EventRow):

```ts
export type StreamEvent = Exclude<
  KataEvent,
  { type: "run.started" | "run.completed" | "run.error" | "run.cancelled" | "run.diff" | "ask.requested" | "ask.answered" }
>;
```

- [ ] **Step 6: Type-check the frontend**

Run (from `app/`): `npm run check`
Expected: PASS (no new type errors; `gutterFor`/`variantFor`/`bodyFor` switch only over `StreamEvent`, which still excludes the ask events).

- [ ] **Step 7: Commit**

```bash
git add crates/kata-core/src/event.rs app/src/lib/events.ts
git commit -m "feat(event): add ask.requested/ask.answered + question types"
```

---

## Phase 2 — The engine mechanism

> Phase 2 builds the headless-testable core. By the end, an interactive run is fully exercisable from the CLI with `fake-claude` standing in for the `ask_user` caller — no Workbench, no real claude required.

### Task 3: The ask bridge module — frames + engine-side TCP listener

The bridge protocol (engine ⟷ ask client) is one JSON object per line, one question-batch in flight at a time:
- client → engine: `{"questions":[ <Question>, ... ]}`
- engine → client: `{"answers":[ ["JWT"], ... ]}`

**Files:**
- Create: `crates/kata-core/src/ask.rs`
- Modify: `crates/kata-core/src/lib.rs` (add `pub mod ask;`)

**Interfaces:**
- Produces:
  - `ask::AskRequest { questions: Vec<Question>, reply: std::sync::mpsc::Sender<Vec<Vec<String>>> }`
  - `ask::Bridge::bind() -> std::io::Result<Bridge>` with `Bridge::port(&self) -> u16` and `Bridge::serve(self, tx: Sender<AskRequest>, cancel: CancelToken)` (spawns the accept loop on its own thread; each received question-batch becomes an `AskRequest` sent on `tx`, then the thread blocks on the `reply` receiver and writes the answer frame back).
  - Wire (de)serialization helpers tested here.

- [ ] **Step 1: Write the failing test** — `ask.rs` `mod tests`: bind a bridge, connect a `TcpStream` as a fake client, write a question frame, assert an `AskRequest` arrives on the channel, send an answer through its `reply`, assert the answer frame is written back to the socket.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{Question, QuestionKind};
    use crate::run::CancelToken;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;
    use std::sync::mpsc;

    #[test]
    fn bridge_round_trips_a_question_and_answer() {
        let bridge = Bridge::bind().unwrap();
        let port = bridge.port();
        let (tx, rx) = mpsc::channel::<AskRequest>();
        bridge.serve(tx, CancelToken::new());

        let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
        writeln!(sock, r#"{{"questions":[{{"kind":"text","header":"h","question":"q?"}}]}}"#).unwrap();

        let req = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        assert_eq!(req.questions.len(), 1);
        assert_eq!(req.questions[0].kind, QuestionKind::Text);
        req.reply.send(vec![vec!["typed answer".into()]]).unwrap();

        let mut reader = BufReader::new(sock.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains(r#""answers":[["typed answer"]]"#), "got {line}");
    }
}
```

- [ ] **Step 2: Run it, expect failure**

Run: `cargo test -p kata-core ask::tests`
Expected: FAIL — module/types do not exist.

- [ ] **Step 3: Implement `ask.rs`** (engine-side bridge; the stdio MCP server half is Task 4):

```rust
//! The ask bridge: how a paused interactive run carries a question from claude
//! (via the `kata _mcp-ask` MCP server it spawns) to the engine and an answer
//! back. One JSON object per line over a localhost TCP connection; one
//! question-batch in flight at a time (claude blocks on the tool result).

use crate::event::Question;
use crate::run::CancelToken;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::Sender;
use std::thread;

/// A question-batch handed to the run loop. Reply with one inner Vec per
/// question (chosen option labels, or [typed text], or [] when optional/blank).
pub struct AskRequest {
    pub questions: Vec<Question>,
    pub reply: std::sync::mpsc::Sender<Vec<Vec<String>>>,
}

#[derive(Deserialize)]
struct QuestionFrame { questions: Vec<Question> }

#[derive(Serialize)]
struct AnswerFrame<'a> { answers: &'a [Vec<String>] }

/// Localhost listener for the ask bridge. Bind early in the run so the port can
/// be handed to the child; then `serve` to accept the MCP server's connection.
pub struct Bridge {
    listener: TcpListener,
}

impl Bridge {
    pub fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        Ok(Self { listener })
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    /// Spawn the accept loop. For each line on an accepted connection, parse a
    /// question-batch, forward it as an `AskRequest`, block on its reply, and
    /// write the answer frame back. Stops when `cancel` trips or the peer closes.
    pub fn serve(self, tx: Sender<AskRequest>, cancel: CancelToken) {
        // Unblock the blocking accept() promptly on cancel.
        let _ = self.listener.set_nonblocking(false);
        thread::spawn(move || {
            for stream in self.listener.incoming() {
                if cancel.is_cancelled() { break; }
                let Ok(stream) = stream else { break };
                if handle_conn(stream, &tx, &cancel).is_err() { /* peer gone */ }
                if cancel.is_cancelled() { break; }
            }
        });
    }
}

fn handle_conn(stream: TcpStream, tx: &Sender<AskRequest>, cancel: &CancelToken) -> std::io::Result<()> {
    let mut write_half = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 { return Ok(()); } // peer closed
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        let Ok(frame) = serde_json::from_str::<QuestionFrame>(trimmed) else { continue };
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        if tx.send(AskRequest { questions: frame.questions, reply: reply_tx }).is_err() {
            return Ok(()); // run loop gone
        }
        // Block until the run loop supplies an answer (or is cancelled/torn down).
        let answers = match reply_rx.recv() {
            Ok(a) => a,
            Err(_) => {
                if cancel.is_cancelled() { return Ok(()); }
                return Ok(());
            }
        };
        let frame = AnswerFrame { answers: &answers };
        writeln!(write_half, "{}", serde_json::to_string(&frame).unwrap())?;
        write_half.flush()?;
    }
}
```

Add to `crates/kata-core/src/lib.rs`: `pub mod ask;`

- [ ] **Step 4: Run tests, expect pass**

Run: `cargo test -p kata-core ask::tests && cargo clippy -p kata-core --all-targets -- -D warnings`
Expected: PASS, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add crates/kata-core/src/ask.rs crates/kata-core/src/lib.rs
git commit -m "feat(ask): engine-side TCP bridge for question/answer frames"
```

### Task 4: The `kata _mcp-ask` stdio MCP server

This is the process claude launches. It speaks minimal MCP over stdio to claude and the bridge protocol over TCP to the engine. **Use the spike's recorded handshake details** (`protocolVersion`, the exact `tools/call` result shape) to pin specifics.

**Files:**
- Modify: `crates/kata-core/src/ask.rs` (add `serve_stdio()`)
- Modify: `crates/kata-cli/src/main.rs` (hidden `_mcp-ask` subcommand)

**Interfaces:**
- Consumes: `KATA_ASK_PORT` env var (the bridge port), the `ask_user` tool input `{ questions: [...] }`.
- Produces: `ask::serve_stdio() -> std::io::Result<()>` — reads JSON-RPC from stdin, writes to stdout; on `tools/call`, opens a TCP connection to `127.0.0.1:$KATA_ASK_PORT`, sends the question frame, blocks on the answer frame, returns it as the tool result text.

- [ ] **Step 1: Write the failing test** — in `ask.rs` `mod tests`, drive `serve_stdio`-internal helpers. Since stdio is awkward to test directly, factor the JSON-RPC handling into a pure `fn handle_rpc(line: &str, port: u16) -> Option<String>` (returns the response JSON line, or `None` for notifications) and test that:

```rust
    #[test]
    fn rpc_initialize_advertises_tools_capability() {
        let resp = handle_rpc(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#, 0).unwrap();
        assert!(resp.contains(r#""tools""#));
        assert!(resp.contains(r#""serverInfo""#));
    }

    #[test]
    fn rpc_tools_list_exposes_ask_user_with_schema() {
        let resp = handle_rpc(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, 0).unwrap();
        assert!(resp.contains(r#""name":"ask_user""#));
        assert!(resp.contains(r#""questions""#)); // inputSchema mentions questions
    }

    #[test]
    fn rpc_initialized_notification_has_no_response() {
        assert!(handle_rpc(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, 0).is_none());
    }

    #[test]
    fn rpc_tools_call_bridges_to_the_listener() {
        // Stand up a bridge that auto-answers, then drive a tools/call through it.
        let bridge = Bridge::bind().unwrap();
        let port = bridge.port();
        let (tx, rx) = mpsc::channel::<AskRequest>();
        bridge.serve(tx, CancelToken::new());
        thread::spawn(move || {
            let req = rx.recv().unwrap();
            req.reply.send(vec![vec!["JWT".into()]]).unwrap();
        });
        let call = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask_user","arguments":{"questions":[{"kind":"text","header":"h","question":"q?"}]}}}"#;
        let resp = handle_rpc(call, port).unwrap();
        assert!(resp.contains("JWT"), "tool result should carry the answer: {resp}");
        assert!(resp.contains(r#""content""#));
    }
```

- [ ] **Step 2: Run it, expect failure**

Run: `cargo test -p kata-core ask::tests::rpc`
Expected: FAIL — `handle_rpc` does not exist.

- [ ] **Step 3: Implement** `handle_rpc` + `serve_stdio` in `ask.rs`. `handle_rpc` returns the response line; `tools/call` connects to the port, writes the `{"questions":...}` frame, reads the `{"answers":...}` frame, formats the answer as readable text for claude (e.g. one line per question: header + chosen labels / typed text), and wraps it in `{ "content": [ { "type": "text", "text": ... } ] }`. Use the spike-confirmed `protocolVersion`. `serve_stdio` is the stdin→`handle_rpc`→stdout loop reading `KATA_ASK_PORT`.

```rust
// (sketch — fill the result-formatting and handshake from the spike findings)
pub fn serve_stdio() -> std::io::Result<()> {
    let port: u16 = std::env::var("KATA_ASK_PORT").ok()
        .and_then(|s| s.parse().ok()).unwrap_or(0);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        if stdin.lock().read_line(&mut line)? == 0 { return Ok(()); }
        if let Some(resp) = handle_rpc(line.trim(), port) {
            writeln!(stdout, "{resp}")?;
            stdout.flush()?;
        }
    }
}
```

`handle_rpc` matches on `method`: `initialize` → result with `protocolVersion`, `capabilities:{tools:{}}`, `serverInfo:{name:"kata-ask",version:...}`; `notifications/*` → `None`; `tools/list` → the `ask_user` tool with an `inputSchema` describing `questions` (array of `{kind, header, question, options?, multi_select?, optional?, placeholder?}`); `tools/call` → bridge round-trip (factor the TCP round-trip into `fn ask_over_bridge(port, questions) -> Vec<Vec<String>>`). Return JSON-RPC errors for unknown methods.

- [ ] **Step 4: Wire the hidden CLI subcommand** in `crates/kata-cli/src/main.rs`. Add to `enum Cmd`:

```rust
    /// (internal) MCP stdio server backing the interactive `ask_user` tool.
    #[command(hide = true)]
    McpAsk,
```

Add to the `match cli.command` in `main`:

```rust
        Cmd::McpAsk => match kata_core::ask::serve_stdio() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => { eprintln!("error: {e}"); ExitCode::from(2) }
        },
```

(Clap derives the subcommand name from the variant as `mcp-ask`; the engine will invoke it via `current_exe() mcp-ask`. Confirm the exact derived name with `kata --help` is hidden but `kata mcp-ask` works.)

- [ ] **Step 5: Run tests, expect pass**

Run: `cargo test -p kata-core ask:: && cargo test -p kata-cli && cargo clippy --all-targets -- -D warnings`
Expected: PASS, clippy clean.

- [ ] **Step 6: Commit**

```bash
git add crates/kata-core/src/ask.rs crates/kata-cli/src/main.rs
git commit -m "feat(ask): kata _mcp-ask stdio MCP server bridging to the engine"
```

### Task 5: Parse the `ask_user` tool call out of the stream (no-op safety)

The engine learns a question is pending from the **bridge** (Task 3), not from claude's stdout. But the `ask_user` `tool_use` line still streams on stdout; left as a generic `tool.use` it would render a noisy row. Suppress it so the AskPanel is the only surface for the pause.

**Files:**
- Modify: `crates/kata-core/src/event.rs` (`parse_stream_line` skips the ask tool's `tool_use`/`tool_result`)

- [ ] **Step 1: Write the failing test** (use the spike-confirmed namespaced name; placeholder `mcp__kata-ask__ask_user`):

```rust
    #[test]
    fn ask_user_tool_use_is_suppressed_from_the_stream() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__kata-ask__ask_user","input":{"questions":[]}}]}}"#;
        let p = parse_stream_line(line);
        assert!(p.is_assistant_message, "still counts as an assistant turn");
        assert!(p.events.is_empty(), "the ask_user tool.use must not render as a row");
    }
```

- [ ] **Step 2: Run it, expect failure** — `cargo test -p kata-core event::tests::ask_user_tool_use` → FAIL (a `ToolUse` event is produced).

- [ ] **Step 3: Implement.** In `parse_stream_line`'s `tool_use` arm, skip when the name ends with `ask_user`:

```rust
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                            // The ask_user MCP tool surfaces via the AskPanel, not a
                            // stream row; suppress its tool.use here.
                            if name.ends_with("ask_user") { continue; }
                            out.events.push(KataEvent::ToolUse { name, input_summary: summarize_input(block.get("input")) });
                        }
```

- [ ] **Step 4: Run tests, expect pass** — `cargo test -p kata-core event::` → PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kata-core/src/event.rs
git commit -m "feat(event): suppress the ask_user tool_use from the stream"
```

### Task 6: Run-loop integration — wire the bridge, pause the leash, answer-deadline (exit 123)

The heart of the feature. When interactive, `run()` binds the bridge before spawn, injects the wiring into the child, and the main loop services questions and answers.

**Files:**
- Modify: `crates/kata-core/src/run.rs` (signature gains an answer source; bridge setup; main-loop state machine; `Termination::AnswerTimeout`)
- Modify: all `run(...)` call sites: `crates/kata-cli/src/main.rs`, `crates/kata-core/tests/run_it.rs`

**Interfaces:**
- Produces:
  - `run::AnswerRx` (newtype `Default` over `Option<mpsc::Receiver<Answer>>`); `run::Answer { id: String, answers: Vec<Vec<String>> }`; `run::answer_channel() -> (mpsc::Sender<Answer>, AnswerRx)`.
  - New signature: `run(spec, catalog, cancel: &CancelToken, answers: &AnswerRx, emit) -> Result<RunOutcome, RunError>`.
- Consumes: `ask::Bridge`, `ask::AskRequest`.

- [ ] **Step 1: Write the failing integration test** — append to `crates/kata-core/tests/run_it.rs`. It relies on a new `fake-claude` mode `ask` (Task 7) that connects to `KATA_ASK_PORT`, sends a question, and completes after the answer. Drive an answer in via the `AnswerRx`:

```rust
#[test]
#[serial]
fn interactive_run_pauses_and_resumes_on_answer() {
    with_fake("ask");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.interactive.enabled = true;
    let cancel = CancelToken::new();
    let (answer_tx, answers) = kata_core::run::answer_channel();

    // Answer the first ask.requested we observe, from another thread.
    let mut events: Vec<KataEvent> = Vec::new();
    let tx = answer_tx.clone();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, &answers, |e| {
        if let KataEvent::AskRequested { id, .. } = &e {
            tx.send(kata_core::run::Answer { id: id.clone(), answers: vec![vec!["JWT".into()]] }).unwrap();
        }
        events.push(e);
    }).unwrap();

    assert_eq!(outcome.exit_code, 0);
    assert!(events.iter().any(|e| matches!(e, KataEvent::AskRequested { .. })));
    assert!(events.iter().any(|e| matches!(e, KataEvent::AskAnswered { .. })));
    assert!(matches!(events.last().unwrap(), KataEvent::RunCompleted { exit_code: 0, .. }));
}

#[test]
#[serial]
fn interactive_run_answer_deadline_reaps_with_123() {
    with_fake("ask"); // asks, then waits forever for an answer that never comes
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.interactive.enabled = true;
    spec.interactive.answer_timeout_secs = Some(1);
    let cancel = CancelToken::new();
    let (_tx, answers) = kata_core::run::answer_channel();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, &answers, |e| events.push(e)).unwrap();

    assert_eq!(outcome.exit_code, 123, "answer-deadline must reap with 123");
    assert!(events.iter().any(|e| matches!(e, KataEvent::AskRequested { .. })));
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunError { .. })));
}
```

- [ ] **Step 2: Update every existing `run(...)` call site** to the new arity (insert `&AnswerRx::default()` for the non-interactive tests). In `run_it.rs` each existing call becomes e.g.:

```rust
    let outcome = run(&base_spec(&work.path().to_string_lossy()), &[] as &[CatalogEntry], &cancel, &kata_core::run::AnswerRx::default(), |e| events.push(e)).unwrap();
```

(Apply to all ~12 calls in `run_it.rs`.) Update `crates/kata-cli/src/main.rs` `cmd_run` (Task 8 finishes the wiring; for now pass `&kata_core::run::AnswerRx::default()` so it compiles).

- [ ] **Step 3: Run it, expect failure** — `cargo test -p kata-core --test run_it interactive` → FAIL (signature/types missing).

- [ ] **Step 4: Implement in `run.rs`.**

Add the answer types near `CancelToken`:

```rust
/// An operator's answer to a pending `ask.requested`, routed from the engine's
/// stdin (kata-cli) into the run loop.
#[derive(Debug, Clone)]
pub struct Answer {
    pub id: String,
    pub answers: Vec<Vec<String>>,
}

/// The run loop's answer inbox. `Default` is an empty inbox (non-interactive
/// runs never deliver answers). Build a live one with [`answer_channel`].
#[derive(Default)]
pub struct AnswerRx(Option<mpsc::Receiver<Answer>>);

impl AnswerRx {
    fn try_recv(&self) -> Option<Answer> {
        self.0.as_ref().and_then(|rx| rx.try_recv().ok())
    }
}

/// Create a connected (sender, inbox) pair for an interactive run.
pub fn answer_channel() -> (mpsc::Sender<Answer>, AnswerRx) {
    let (tx, rx) = mpsc::channel();
    (tx, AnswerRx(Some(rx)))
}
```

Add `AnswerTimeout` to `enum Termination`. Change `run`'s signature to add `answers: &AnswerRx` after `cancel`.

Before spawn, when `spec.interactive.enabled`, set up the bridge and child wiring (create after the auth check, before building the final command):

```rust
    // Interactive: bind the ask bridge, hand the child its port + the ask_user
    // MCP tool + the retasking note. Temp artifacts live until the child exits.
    let mut interactive_tmp: Option<tempfile::TempDir> = None;
    let mut ask_rx: Option<mpsc::Receiver<crate::ask::AskRequest>> = None;
    if spec.interactive.enabled {
        let bridge = crate::ask::Bridge::bind().map_err(|e| RunError::Spawn(e.to_string()))?;
        let port = bridge.port();
        let (atx, arx) = mpsc::channel();
        bridge.serve(atx, cancel.clone());
        ask_rx = Some(arx);

        let dir = tempfile::tempdir().map_err(|e| RunError::Spawn(e.to_string()))?;
        let exe = std::env::current_exe().map_err(|e| RunError::Spawn(e.to_string()))?;
        let cfg = dir.path().join("mcp-config.json");
        std::fs::write(&cfg, serde_json::json!({
            "mcpServers": { "kata-ask": {
                "command": exe.to_string_lossy(),
                "args": ["mcp-ask"]
            }}
        }).to_string()).map_err(|e| RunError::Spawn(e.to_string()))?;
        let note = dir.path().join("retask.txt");
        std::fs::write(&note, INTERACTIVE_RETASK).map_err(|e| RunError::Spawn(e.to_string()))?;

        // Append to the invocation built by build_invocation.
        // (inv is `let mut inv` — see below.)
        inv.args.push("--mcp-config".into());
        inv.args.push(cfg.to_string_lossy().into_owned());
        inv.args.push("--append-system-prompt-file".into());
        inv.args.push(note.to_string_lossy().into_owned());
        inv.env.push(("KATA_ASK_PORT".into(), port.to_string()));
        interactive_tmp = Some(dir);
    }
```

(Change `let inv = build_invocation(...)` to `let mut inv = ...`. Note `CancelToken` must be `Clone` — it already is. Add `const INTERACTIVE_RETASK: &str = "...";` with the retasking copy from the design spec. If the spike found `--append-system-prompt <text>` works inline, prefer it and drop the `retask.txt` file.)

Main-loop changes (add awaiting state + servicing). Before the loop:

```rust
    let answer_deadline = spec.interactive.answer_timeout_secs.map(Duration::from_secs);
    let mut awaiting_since: Option<Instant> = None;
    let mut paused: Duration = Duration::ZERO;
    let mut pending: Option<(String, std::sync::mpsc::Sender<Vec<Vec<String>>>)> = None;
    let mut ask_seq: u32 = 0;
```

Inside the loop, replace the deadline check and add servicing:

```rust
        // Work-clock deadline excludes time spent awaiting an answer.
        if awaiting_since.is_none() && Instant::now() >= deadline + paused {
            termination = Some(Termination::TimedOut);
            break;
        }
        // Answer-deadline: only while awaiting, only if configured.
        if let (Some(since), Some(limit)) = (awaiting_since, answer_deadline) {
            if since.elapsed() >= limit {
                termination = Some(Termination::AnswerTimeout);
                break;
            }
        }
        // A new question from the bridge → emit ask.requested, enter awaiting.
        if pending.is_none() {
            if let Some(rx) = &ask_rx {
                if let Ok(req) = rx.try_recv() {
                    ask_seq += 1;
                    let id = format!("q{ask_seq}");
                    pending = Some((id.clone(), req.reply));
                    awaiting_since = Some(Instant::now());
                    emit(KataEvent::AskRequested { id, questions: req.questions });
                }
            }
        }
        // An answer from the operator → return it down the bridge, resume.
        if let Some((pid, _)) = &pending {
            if let Some(ans) = answers.try_recv() {
                if &ans.id == pid {
                    let (id, reply) = pending.take().unwrap();
                    let _ = reply.send(ans.answers.clone());
                    if let Some(since) = awaiting_since.take() { paused += since.elapsed(); }
                    emit(KataEvent::AskAnswered { id, answers: ans.answers });
                }
            }
        }
```

Add the terminal arm in the `match termination`:

```rust
                Termination::AnswerTimeout => (123, KataEvent::RunError {
                    message: format!("answer deadline exceeded after {}s",
                        spec.interactive.answer_timeout_secs.unwrap_or(0)),
                }),
```

Keep `interactive_tmp` alive until after `child.wait()` (it already lives to function end; ensure it is not dropped early — bind it with a trailing `let _ = &interactive_tmp;` before return if clippy warns, or `drop(interactive_tmp);` after the diff block).

- [ ] **Step 5: Run it, expect pass** (after Task 7 lands the `ask` fake mode; if implementing strictly in order, write Task 7 first, then return here). Run: `cargo test -p kata-core --test run_it interactive`
Expected: PASS.

- [ ] **Step 6: Clippy + full engine suite**

Run: `cargo test -p kata-core && cargo test -p kata-cli && cargo clippy --all-targets -- -D warnings`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add crates/kata-core/src/run.rs crates/kata-cli/src/main.rs crates/kata-core/tests/run_it.rs
git commit -m "feat(run): interactive bridge, leash pause, answer-deadline (exit 123)"
```

### Task 7: `fake-claude` interactive mode (offline test driver)

**Files:**
- Modify: `crates/kata-core/src/bin/fake-claude.rs`

- [ ] **Step 1: Add the `ask` mode.** It plays the role of `_mcp-ask`: connect to `KATA_ASK_PORT`, send a question frame, wait for the answer frame, then complete. Add to the module doc-comment mode list, and a new arm:

```rust
        "ask" => {
            use std::io::{BufRead, BufReader, Write as _};
            use std::net::TcpStream;
            let port: u16 = std::env::var("KATA_ASK_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"mcp__kata-ask__ask_user","input":{{"questions":[]}}}}]}}}}"#);
            let _ = out.flush();
            if let Ok(mut sock) = TcpStream::connect(("127.0.0.1", port)) {
                let _ = writeln!(sock, r#"{{"questions":[{{"kind":"text","header":"h","question":"q?"}}]}}"#);
                let _ = sock.flush();
                // Wait (possibly forever — exercises the answer-deadline) for the answer.
                let mut reader = BufReader::new(sock);
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
            }
            let _ = writeln!(out, r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#);
            let _ = out.flush();
        }
```

- [ ] **Step 2: Run the Task 6 interactive tests, expect pass**

Run: `cargo test -p kata-core --test run_it interactive`
Expected: PASS (resume case completes; deadline case reaps with 123 because no answer arrives).

- [ ] **Step 3: Commit**

```bash
git add crates/kata-core/src/bin/fake-claude.rs
git commit -m "test(fake-claude): add interactive 'ask' mode driving the bridge"
```

### Task 8: kata-cli stdin `answer` protocol

**Files:**
- Modify: `crates/kata-cli/src/main.rs` (`cmd_run` stdin thread parses `answer <id> <json>`, wires `AnswerRx`)

**Interfaces:**
- Consumes: `run::answer_channel()`, the new `run(...)` arity.

- [ ] **Step 1: Add a unit test for the line parser.** Factor parsing into a pure helper and test it:

```rust
#[cfg(test)]
mod tests {
    use super::{slug, parse_stdin_line, StdinCmd};

    #[test]
    fn parses_cancel_and_answer_lines() {
        assert!(matches!(parse_stdin_line("cancel"), Some(StdinCmd::Cancel)));
        match parse_stdin_line(r#"answer q1 [["JWT"]]"#) {
            Some(StdinCmd::Answer(a)) => {
                assert_eq!(a.id, "q1");
                assert_eq!(a.answers, vec![vec!["JWT".to_string()]]);
            }
            other => panic!("expected Answer, got {other:?}"),
        }
        assert!(parse_stdin_line("garbage").is_none());
    }
}
```

- [ ] **Step 2: Run it, expect failure** — `cargo test -p kata-cli parses_cancel_and_answer` → FAIL.

- [ ] **Step 3: Implement.** Add above `cmd_run`:

```rust
#[derive(Debug)]
enum StdinCmd {
    Cancel,
    Answer(kata_core::run::Answer),
}

/// Parse one engine-stdin control line: `cancel` or `answer <id> <json-matrix>`.
fn parse_stdin_line(line: &str) -> Option<StdinCmd> {
    let line = line.trim();
    if line == "cancel" { return Some(StdinCmd::Cancel); }
    let rest = line.strip_prefix("answer ")?;
    let (id, json) = rest.split_once(' ')?;
    let answers: Vec<Vec<String>> = serde_json::from_str(json.trim()).ok()?;
    Some(StdinCmd::Answer(kata_core::run::Answer { id: id.trim().to_string(), answers }))
}
```

Rework the stdin thread in `cmd_run` to route both, and create the answer channel:

```rust
    let cancel = kata_core::run::CancelToken::new();
    let flag = cancel.flag();
    let _ = ctrlc::set_handler(move || flag.store(true, Ordering::SeqCst));

    let (answer_tx, answers) = kata_core::run::answer_channel();
    let stdin_flag = cancel.flag();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        let mut line = String::new();
        while stdin.lock().read_line(&mut line).unwrap_or(0) != 0 {
            match parse_stdin_line(&line) {
                Some(StdinCmd::Cancel) => { stdin_flag.store(true, Ordering::SeqCst); break; }
                Some(StdinCmd::Answer(a)) => { let _ = answer_tx.send(a); }
                None => {}
            }
            line.clear();
        }
    });
```

Update the `run::run(...)` call to pass `&answers`:

```rust
    match kata_core::run::run(&spec, &catalog, &cancel, &answers, emit) {
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cargo test -p kata-cli && cargo clippy --all-targets -- -D warnings`
Expected: PASS, clean.

- [ ] **Step 5: End-to-end CLI smoke (manual, optional but recommended).** With `KATA_CLAUDE_BIN` set to fake-claude `ask` mode, pipe an answer:

```bash
printf 'answer q1 [["JWT"]]\n' | KATA_CLAUDE_BIN=$(...fake-claude) KATA_FAKE_MODE=ask cargo run -p kata-cli -- run /path/to/interactive-spec.toml
```

Expected: an `ask.requested` line, then `ask.answered`, then `run.completed` exit 0.

- [ ] **Step 6: Commit**

```bash
git add crates/kata-cli/src/main.rs
git commit -m "feat(cli): route 'answer <id> <json>' from engine stdin to the run loop"
```

### Task 9 (real-claude smoke, opt-in): end-to-end interactive run

**Files:**
- Modify: `crates/kata-core/tests/run_it.rs` (a `KATA_SMOKE_REAL`-gated test, mirroring the existing opt-in convention)

- [ ] **Step 1: Add the gated test** — skips unless `KATA_SMOKE_REAL` is set and a real `claude` is authenticated. It runs an interactive spec with no `KATA_CLAUDE_BIN` override, answers the first `ask.requested` programmatically, and asserts a clean exit 0 with `ask.answered` observed. (Code mirrors `interactive_run_pauses_and_resumes_on_answer` but without `with_fake`, gated by `std::env::var("KATA_SMOKE_REAL").is_ok()` early-return.)

- [ ] **Step 2: Run it both ways**

Run (skips): `cargo test -p kata-core --test run_it real_interactive`
Run (real, manual): `KATA_SMOKE_REAL=1 cargo test -p kata-core --test run_it real_interactive -- --nocapture`
Expected: skip when unset; real run pauses, accepts the answer, completes 0.

- [ ] **Step 3: Commit**

```bash
git add crates/kata-core/tests/run_it.rs
git commit -m "test(smoke): opt-in real-claude interactive end-to-end"
```

---

## Phase 3 — The Workbench

> Engine is done and CLI-verifiable. Phase 3 layers the GUI. Verify each step in the browser (`npm run dev`) where possible; the Tauri command needs `npm run tauri:dev`.

### Task 10: Vendor the HITL CSS

**Files:**
- Modify: `app/src/styles/components/components.css` (append the `.k-ask*` block + `.k-status--awaiting` + `@keyframes k-pulse-amber`, copied verbatim from `design/design_system/components/components.css`)

- [ ] **Step 1: Copy the classes.** From `design/design_system/components/components.css`, copy: line 143 (`.k-status--awaiting .k-status__dot`), line 145 (`@keyframes k-pulse-amber`), line 146 (the `prefers-reduced-motion` rule — merge with the app's existing one so both `--running` and `--awaiting` are covered), and the whole `.k-ask*` block (lines 194–235). Paste into the app's `components.css` in the status and (new) ask sections.

- [ ] **Step 2: Verify the tokens exist.** Confirm `--warning-border`, `--warning-subtle`, `--warning-text`, `--accent-subtle`, `--success-text` resolve in the app's `tokens/colors.css` (the design source uses them). If any are missing, port them from the design source too.

- [ ] **Step 3: Visual check** — `npm run dev`, temporarily drop a `<div class="k-ask">…</div>` into a route to confirm it renders amber-bannered and flat. Remove the scaffold.

- [ ] **Step 4: Commit**

```bash
git add app/src/styles/components/components.css app/src/styles/tokens/colors.css
git commit -m "style(workbench): vendor .k-ask* + awaiting status classes"
```

### Task 11: Run store + api/mock wiring for the pause

**Files:**
- Modify: `app/src/lib/events.ts` (`RunState` + `STATUS_LABEL`)
- Modify: `app/src/lib/run.svelte.ts` (handle ask events, `pendingAsk`, `submitAnswer`)
- Modify: `app/src/lib/api.ts` (`submitAnswer` bridge)
- Modify: `app/src/lib/mock.ts` (a scripted `ask.requested` step)

**Interfaces:**
- Produces: `runStore.pendingAsk: { id: string; questions: Question[] } | null`; `submitAnswer(id, answers)`; `api.submitAnswer(id, answers)`.

- [ ] **Step 1: Extend `RunState`** in `events.ts`:

```ts
export type RunState = "idle" | "running" | "awaiting" | "success" | "warning" | "error";

export const STATUS_LABEL: Record<RunState, string> = {
  idle: "Idle",
  running: "Running",
  awaiting: "Awaiting",
  success: "Completed",
  error: "Error",
  warning: "Stopped",
};
```

- [ ] **Step 2: Add a Vitest** for the store transition — `app/src/lib/run.test.ts` (or extend the existing run test): feed an `ask.requested` then `ask.answered`, assert `state` goes `running → awaiting → running` and `pendingAsk` is set then cleared.

- [ ] **Step 3: Run it, expect failure** — `npm test` → FAIL.

- [ ] **Step 4: Implement in `run.svelte.ts`.** Add `pendingAsk` to the store:

```ts
export const runStore = $state<{
  state: RunState;
  events: StreamEvent[];
  summary: RunSummary | null;
  pendingAsk: { id: string; questions: Question[] } | null;
}>({ state: "idle", events: [], summary: null, pendingAsk: null });
```

(Import `Question` from `./events`.) In `handle()`, add cases before `default`:

```ts
    case "ask.requested":
      runStore.pendingAsk = { id: ev.id, questions: ev.questions };
      runStore.state = "awaiting";
      return;
    case "ask.answered":
      runStore.pendingAsk = null;
      runStore.state = "running";
      return;
```

Reset `pendingAsk` in `startRun` (`runStore.pendingAsk = null;`). Add the submit action:

```ts
export async function submitAnswer(id: string, answers: string[][]) {
  if (runStore.state !== "awaiting") return;
  await api.submitAnswer(id, answers);
  // optimistic; the engine's ask.answered will flip state back to running
}
```

Allow cancel while awaiting — change `cancelRun`'s guard:

```ts
  if (runStore.state !== "running" && runStore.state !== "awaiting") return;
```

- [ ] **Step 5: Implement `api.submitAnswer`** in `api.ts`:

```ts
/** Send the operator's answer to a pending ask.requested. */
export async function submitAnswer(id: string, answers: string[][]): Promise<void> {
  if (inTauri()) return invoke<void>("submit_answer", { id, answers });
  // Browser mock: resolve the scripted pause by feeding an ask.answered + resume.
  browserCb?.({ type: "ask.answered", id, answers });
  resumeMockAfterAnswer();
}
```

(Where `resumeMockAfterAnswer` continues the scripted timeline — see Step 6.)

- [ ] **Step 6: Add a mock pause** in `mock.ts`. Split `runScript` so a `{ type: "ask.requested", … }` step fires mid-run and the remaining steps are replayed by `resumeMockAfterAnswer()` (export a small continuation from `mock.ts` or keep the tail in `api.ts`). Insert after turn 2, e.g.:

```ts
  { delay: 400, ev: { type: "ask.requested", id: "q1", questions: [
    { kind: "select", header: "scope", question: "Fix the flake, or just isolate it?",
      options: [ { label: "Isolate only", description: "as instructed" }, { label: "Fix it", description: "change prod code" } ],
      multi_select: false } ] } },
```

Keep the demo runnable via `?demo=run`: the timeline pauses at the ask until the panel is answered, then resumes to `run.completed`.

- [ ] **Step 7: Run tests + browser check**

Run: `npm test && npm run check`
Expected: PASS. Then `npm run dev` + `/?demo=run` → run pauses at the question (panel appears once Task 12 lands).

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/events.ts app/src/lib/run.svelte.ts app/src/lib/api.ts app/src/lib/mock.ts app/src/lib/run.test.ts
git commit -m "feat(workbench): awaiting state + ask event handling + submitAnswer"
```

### Task 12: The `AskPanel` component + Observe pane wiring

**Files:**
- Create: `app/src/lib/components/AskPanel.svelte`
- Modify: `app/src/lib/components/ObservePane.svelte` (render the panel + the awaiting status)
- Modify: the run page/toolbar that toggles Run/Cancel (`app/src/routes/+page.svelte` and/or `app/src/lib/components/Toolbar.svelte`): treat `awaiting` like `running` for the Cancel button and the Ctrl+Enter guard.

**Interfaces:**
- Consumes: `runStore.pendingAsk`, `submitAnswer`, `Question`/`QuestionKind`.

- [ ] **Step 1: Build `AskPanel.svelte`.** Renders the amber banner + one block per question by `kind`, collects answers, and calls `submitAnswer` on send. Use the vendored `.k-ask*` classes (do not hard-code styles). Structure:

```svelte
<script lang="ts">
  import type { Question } from "$lib/events";
  let { id, questions, onSubmit }: {
    id: string;
    questions: Question[];
    onSubmit: (id: string, answers: string[][]) => void;
  } = $props();

  // answers[i] is the selection/text for question i.
  let answers = $state<string[][]>(questions.map(() => []));
  let text = $state<string[]>(questions.map(() => ""));

  function toggle(i: number, label: string, multi: boolean) {
    const cur = answers[i];
    if (multi) {
      answers[i] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    } else {
      answers[i] = [label];
    }
  }

  const ready = $derived(questions.every((q, i) =>
    q.kind === "text" ? (q.optional || text[i].trim().length > 0) : answers[i].length > 0));

  function send() {
    const payload = questions.map((q, i) => (q.kind === "text" ? [text[i]] : answers[i]));
    onSubmit(id, payload);
  }
</script>

<div class="k-ask">
  <div class="k-ask__banner">
    <span class="k-ask__banner-dot"></span>
    <span class="k-ask__banner-label">awaiting your input</span>
    <span class="k-ask__banner-tool">ask_user</span>
  </div>
  <div class="k-ask__body">
    {#each questions as q, i}
      <div class="k-ask__q">
        <div class="k-ask__q-head">
          <span class="k-ask__q-eyebrow">{q.header}</span>
          {#if q.kind === "select" && q.multi_select}<span class="k-ask__q-multi">choose any</span>{/if}
        </div>
        <div class="k-ask__q-text">{q.question}</div>

        {#if q.kind === "confirm"}
          <div class="k-ask__confirm">
            {#each (q.options ?? [{ label: "Yes" }, { label: "No" }]) as opt}
              <button type="button" class="k-ask__confirm-btn"
                class:k-ask__confirm-btn--selected={answers[i][0] === opt.label}
                onclick={() => (answers[i] = [opt.label])}>{opt.label}</button>
            {/each}
          </div>
        {:else if q.kind === "select"}
          <div class="k-ask__opts">
            {#each q.options ?? [] as opt}
              <button type="button" class="k-ask__opt"
                class:k-ask__opt--selected={answers[i].includes(opt.label)}
                onclick={() => toggle(i, opt.label, !!q.multi_select)}>
                <span class="k-ask__mark {q.multi_select ? 'k-ask__mark--check' : 'k-ask__mark--radio'}">
                  {#if answers[i].includes(opt.label)}{#if q.multi_select}✓{:else}<span class="k-ask__mark-dot"></span>{/if}{/if}
                </span>
                <span class="k-ask__opt-text">
                  <span class="k-ask__opt-label">{opt.label}</span>
                  {#if opt.description}<span class="k-ask__opt-desc">{opt.description}</span>{/if}
                </span>
              </button>
            {/each}
          </div>
        {:else}
          <textarea class="k-textarea" rows="3" placeholder={q.placeholder ?? ""} bind:value={text[i]}></textarea>
        {/if}
      </div>
    {/each}
    <div class="k-ask__foot">
      <span class="k-ask__hint">the run is paused on the leash</span>
      <button class="k-btn k-btn--primary" disabled={!ready} onclick={send}>Send answer · resume</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Wire it into `ObservePane.svelte`.** Add the prop and render below the stream when awaiting:

```svelte
  // in the props block add:
  //   pendingAsk: { id: string; questions: Question[] } | null;
  //   onAnswer: (id: string, answers: string[][]) => void;
```

```svelte
{#if pendingAsk}
  <div class="wb-event-enter"><AskPanel id={pendingAsk.id} questions={pendingAsk.questions} onSubmit={onAnswer} /></div>
{/if}
```

(Import `AskPanel`; the status badge already reads `k-status--{runState}`, so `awaiting` now resolves to the amber pulse class from Task 10.)

- [ ] **Step 3: Pass the wiring from the page.** Where `ObservePane` is used, pass `pendingAsk={runStore.pendingAsk}` and `onAnswer={submitAnswer}` (import from `run.svelte.ts`).

- [ ] **Step 4: Toolbar/Run-Cancel.** In the component that swaps Run↔Cancel and guards Ctrl+Enter, change the `state === "running"` checks to `state === "running" || state === "awaiting"` so Cancel stays available and Run stays disabled during a pause. (Grep for `"running"` in `app/src/routes/+page.svelte` and `app/src/lib/components/Toolbar.svelte`.)

- [ ] **Step 5: Browser verify**

Run: `npm run check && npm run dev` → `/?demo=run`
Expected: the run reaches turn 2, the amber AskPanel appears, the status dot pulses amber, Cancel is shown; choosing an option + Send resumes the timeline to `run.completed`.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/components/AskPanel.svelte app/src/lib/components/ObservePane.svelte app/src/routes/+page.svelte app/src/lib/components/Toolbar.svelte
git commit -m "feat(workbench): AskPanel + observe-pane pause/answer wiring"
```

### Task 13: Tauri `submit_answer` command + Compose interactive section

**Files:**
- Modify: `app/src-tauri/src/lib.rs` (`submit_answer` command writing to the sidecar stdin)
- Modify: the Compose pane (`app/src/lib/components/ComposePane.svelte`) — an Interactive section bound to `spec.interactive`

- [ ] **Step 1: Implement `submit_answer`** in `app/src-tauri/src/lib.rs`, mirroring `cancel_run`:

```rust
/// Send the operator's answer to a paused interactive run: write an
/// `answer <id> <json>` line to the engine's stdin (the engine returns it to
/// claude as the ask_user tool result and emits ask.answered).
#[tauri::command]
fn submit_answer(control: State<RunControl>, id: String, answers: Vec<Vec<String>>) {
    let json = serde_json::to_string(&answers).unwrap_or_else(|_| "[]".into());
    let line = format!("answer {id} {json}\n");
    let mut st = control.state.lock().unwrap();
    if let Some(child) = st.child.as_mut() {
        let _ = child.write(line.as_bytes());
    }
}
```

Register it in the `invoke_handler!` list (add `submit_answer`).

- [ ] **Step 2: Add the Compose Interactive section.** In `ComposePane.svelte`, add a `.wb-section` with a `.k-seg` toggle bound to `spec.interactive.enabled` (off/on) and, when on, a `.k-field` numeric input bound to `spec.interactive.answer_timeout_secs` (spec key shown in mono: `answer_timeout_secs`, hint: "seconds to wait on your answer; blank = wait indefinitely"). Follow the existing Leash section's markup exactly (it already pairs a segmented control with grid fields). Default a `New` spec's `interactive` to `{ enabled: false, answer_timeout_secs: null }` in `spec.ts`'s `defaultSpec` (and seed it in `mock.ts`'s `seedSpec`).

- [ ] **Step 3: Type-check + browser verify**

Run: `npm run check && npm run dev`
Expected: toggling Interactive on reveals the timeout field; the spec round-trips (Save/Open) with the `[interactive]` block.

- [ ] **Step 4: Real desktop smoke (manual).**

Run (from `app/`): `npm run tauri:dev` (needs an authenticated `claude`). Compose an interactive spec with a task that forces a question; Run; confirm the AskPanel appears, answering resumes the run, and the summary lands.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/lib.rs app/src/lib/components/ComposePane.svelte app/src/lib/spec.ts app/src/lib/mock.ts
git commit -m "feat(workbench): submit_answer command + compose interactive section"
```

---

## Phase 4 — Docs & close-out

### Task 14: Docs + roadmap

**Files:**
- Modify: `ROADMAP.md` (mark M9 status, note the divergence from the original "intercept AskUserQuestion" framing)
- Modify: `README.md` (a short "Interactive runs" subsection: the opt-in spec block, the question kinds, the `answer <id> <json>` stdin protocol)
- Modify: `CLAUDE.md` if any engine/contract note needs updating (the new exit code 123; the `ask` event pair)

- [ ] **Step 1: Update `ROADMAP.md`** — mark M9 done (or in-progress), with a one-line note that the mechanism is a Kata-hosted `ask_user` MCP tool (not interception of the built-in tool), per `docs/superpowers/specs/2026-06-18-interactive-sessions-design.md`.

- [ ] **Step 2: Update `README.md` / `CLAUDE.md`** with the user-facing usage and the extended exit-code/event contract (123; `ask.requested`/`ask.answered`).

- [ ] **Step 3: Full suite + clippy + build**

Run: `cargo test --workspace && cargo clippy --all-targets -- -D warnings && cargo build --locked`
Run (from `app/`): `npm run check && npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add ROADMAP.md README.md CLAUDE.md
git commit -m "docs(m9): interactive sessions usage + contract notes"
```

---

## Self-review (completed against the spec)

- **Spec coverage:** opt-in `[interactive]` block → Task 1; `ask.requested`/`ask.answered` + four question kinds → Tasks 2, 12; `ask_user` MCP tool + bridge → Tasks 3, 4; mechanism feasibility → Task 0; work-clock pause + answer-deadline (exit 123) → Task 6; retasking → Task 6; `answer <id> <json>` back-channel → Tasks 6, 8; CI safety (opt-in, tool not wired when off) → Tasks 1, 6; Workbench (vendor CSS, AskPanel, awaiting, compose toggle, mock) → Tasks 10–13; testing (spike, fake-claude mode, engine + frontend tests, opt-in smoke) → Tasks 0, 6, 7, 9, 11; docs → Task 14. All covered.
- **Placeholder scan:** the only deliberately-deferred specifics are claude's MCP handshake details (`protocolVersion`, exact namespaced tool name, inline-vs-file append-system-prompt), which Task 0 records and Tasks 4–5 consume — these are external facts to capture, not unwritten code.
- **Type consistency:** `Answer { id, answers: Vec<Vec<String>> }`, `AnswerRx`, `answer_channel()`, `ask::Bridge`/`AskRequest`, `Question`/`QuestionKind`/`QuestionOption`, `KataEvent::AskRequested/AskAnswered`, and the TS `Question`/`RunState` mirror are used identically across tasks. The `run(...)` signature change (adding `&AnswerRx`) is applied at every call site in Task 6 Step 2.
