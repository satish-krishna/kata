//! The engine bridge: how a paused run carries a request from claude (via the
//! `kata mcp-ask` MCP server it spawns) to the engine and a reply back. One JSON
//! object per line over a localhost TCP connection; one request in flight at a
//! time (claude blocks on the tool result).
//!
//! Two tools ride the same bridge, each wired only when its spec section asks
//! for it:
//!
//! - `ask_user` — `[interactive] enabled = true`. Claude asks the operator a
//!   question and waits for the answer.
//! - `approve_tool` — `[permissions] mode = "prompt"`. Claude asks whether a
//!   tool call may proceed, because the run cannot pass
//!   `--dangerously-skip-permissions`. The engine answers from the spec's rules
//!   or, under `unmatched = "ask"`, from the operator.
//!
//! Neither tool is consumer API: a consumer sees only the `ask.*` and
//! `permission.*` events and replies over the engine's stdin.

use crate::event::Question;
use crate::run::CancelToken;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::Sender;
use std::thread;

/// The MCP server name the engine registers in the generated `--mcp-config`.
pub const MCP_SERVER_NAME: &str = "kata-ask";

/// The fully-qualified tool name handed to claude's `--permission-prompt-tool`.
/// Claude namespaces MCP tools as `mcp__<server>__<tool>`.
pub const PERMISSION_PROMPT_TOOL: &str = "mcp__kata-ask__approve_tool";

/// Env var naming which tools the `mcp-ask` server advertises for this run.
/// Set per-server in the generated mcp-config; reserved from `RunSpec.env`.
pub const TOOLS_ENV: &str = "KATA_MCP_TOOLS";

/// The engine's answer to an `approve_tool` call.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Verdict {
    pub allow: bool,
    /// Why it was denied. Claude sees this and may adjust its approach.
    pub message: Option<String>,
}

/// What claude is asking the engine for.
pub(crate) enum RequestPayload {
    /// `ask_user`: a batch of questions for the operator.
    Ask(Vec<Question>),
    /// `approve_tool`: may this tool call proceed?
    Approve { tool: String, input: Value },
}

/// What the engine sends back.
pub(crate) enum ReplyPayload {
    /// One inner Vec per question (chosen option labels, or [typed text], or []
    /// when optional/blank).
    Answers(Vec<Vec<String>>),
    Verdict(Verdict),
}

/// A request handed to the run loop, with the channel to reply on.
pub(crate) struct Request {
    pub payload: RequestPayload,
    pub reply: std::sync::mpsc::Sender<ReplyPayload>,
}

/// Wire frame: engine-internal, versioned only by the binary that writes and
/// reads it (the MCP server is `<current exe> mcp-ask`, so both ends always
/// match). Not part of any published contract.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WireRequest {
    Ask {
        questions: Vec<Question>,
    },
    Approve {
        tool: String,
        #[serde(default)]
        input: Value,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WireReply {
    Answers {
        answers: Vec<Vec<String>>,
    },
    Verdict {
        allow: bool,
        #[serde(default)]
        message: Option<String>,
    },
}

/// Which tools the MCP server advertises. A tool absent here is not in
/// `tools/list` and is rejected by `tools/call`, so a run never exposes a
/// capability its spec did not ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Tools {
    pub ask_user: bool,
    pub approve_tool: bool,
}

impl Tools {
    pub fn none() -> Self {
        Self {
            ask_user: false,
            approve_tool: false,
        }
    }

    /// Render for the `KATA_MCP_TOOLS` env var.
    pub fn to_env(self) -> String {
        let mut names = Vec::new();
        if self.ask_user {
            names.push("ask_user");
        }
        if self.approve_tool {
            names.push("approve_tool");
        }
        names.join(",")
    }

    fn from_env() -> Self {
        let raw = std::env::var(TOOLS_ENV).unwrap_or_default();
        let mut t = Tools::none();
        for name in raw.split(',').map(str::trim) {
            match name {
                "ask_user" => t.ask_user = true,
                "approve_tool" => t.approve_tool = true,
                _ => {}
            }
        }
        t
    }
}

/// Localhost listener for the bridge. Bind early in the run so the port can be
/// handed to the child; then `serve` to accept the MCP server's connection.
pub(crate) struct Bridge {
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
    /// request, forward it, block on its reply, and write the reply frame back.
    /// Stops when `cancel` trips or the peer closes.
    pub fn serve(self, tx: Sender<Request>, cancel: CancelToken) {
        // Note: a cancel only takes effect between connections — a bridge idle in
        // accept() unblocks when the next connection arrives or when the process
        // exits (each run is its own OS process).
        thread::spawn(move || {
            for stream in self.listener.incoming() {
                if cancel.is_cancelled() {
                    break;
                }
                let Ok(stream) = stream else { break };
                if handle_conn(stream, &tx).is_err() { /* peer gone */ }
                if cancel.is_cancelled() {
                    break;
                }
            }
        });
    }
}

fn handle_conn(stream: TcpStream, tx: &Sender<Request>) -> std::io::Result<()> {
    let mut write_half = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(()); // peer closed
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<WireRequest>(trimmed) else {
            continue;
        };
        let payload = match frame {
            WireRequest::Ask { questions } => RequestPayload::Ask(questions),
            WireRequest::Approve { tool, input } => RequestPayload::Approve { tool, input },
        };
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        if tx
            .send(Request {
                payload,
                reply: reply_tx,
            })
            .is_err()
        {
            return Ok(()); // run loop gone
        }
        // Block until the run loop supplies a reply (or is cancelled/torn down).
        let reply = match reply_rx.recv() {
            Ok(r) => r,
            Err(_) => return Ok(()),
        };
        let frame = match reply {
            ReplyPayload::Answers(answers) => WireReply::Answers { answers },
            ReplyPayload::Verdict(v) => WireReply::Verdict {
                allow: v.allow,
                message: v.message,
            },
        };
        let body = serde_json::to_string(&frame).map_err(std::io::Error::other)?;
        writeln!(write_half, "{body}")?;
        write_half.flush()?;
    }
}

/// Handle one JSON-RPC 2.0 line from claude. Returns the response JSON line,
/// or `None` for notifications (which require no response per the MCP spec).
pub(crate) fn handle_rpc(line: &str, port: u16, tools: Tools) -> Option<String> {
    // 1. Parse JSON; if it fails, return Parse error response per JSON-RPC 2.0
    let val: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            // Unparseable input gets Parse error with id: null
            return Some(json_rpc_error(
                &serde_json::Value::Null,
                -32700,
                "Parse error",
            ));
        }
    };

    // 2. Check if it's a notification (no id field) — notifications get no response
    val.get("id")?;

    // 3. Extract method; if missing, return Invalid Request
    let method = match val["method"].as_str() {
        Some(m) => m,
        None => {
            let id = &val["id"];
            return Some(json_rpc_error(id, -32600, "Invalid Request"));
        }
    };

    let id = &val["id"];

    let result = match method {
        "initialize" => {
            let proto = val["params"]["protocolVersion"]
                .as_str()
                .unwrap_or("2024-11-05");
            serde_json::json!({
                "protocolVersion": proto,
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": MCP_SERVER_NAME,
                    "version": env!("CARGO_PKG_VERSION")
                }
            })
        }
        "tools/list" => serde_json::json!({ "tools": tool_definitions(tools) }),
        "tools/call" => {
            let name = val["params"]["name"].as_str().unwrap_or("");
            let args = &val["params"]["arguments"];
            match name {
                "ask_user" if tools.ask_user => match call_ask_user(port, args) {
                    Ok(r) => r,
                    Err(e) => return Some(e(id)),
                },
                "approve_tool" if tools.approve_tool => match call_approve_tool(port, args) {
                    Ok(r) => r,
                    Err(e) => return Some(e(id)),
                },
                _ => return Some(json_rpc_error(id, -32601, "Unknown tool")),
            }
        }
        _ => {
            return Some(json_rpc_error(id, -32601, "Method not found"));
        }
    };

    let resp = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    });
    Some(resp.to_string())
}

/// A deferred JSON-RPC error: the id is only known at the call site.
type RpcError = Box<dyn FnOnce(&serde_json::Value) -> String>;

fn rpc_err(code: i32, message: String) -> RpcError {
    Box::new(move |id| json_rpc_error(id, code, &message))
}

fn tool_definitions(tools: Tools) -> Vec<serde_json::Value> {
    let mut defs = Vec::new();
    if tools.ask_user {
        defs.push(serde_json::json!({
            "name": "ask_user",
            "description": "Ask the user one or more questions and wait for their answers.",
            "inputSchema": {
                "type": "object",
                "required": ["questions"],
                "properties": {
                    "questions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["kind", "header", "question"],
                            "properties": {
                                "kind": {
                                    "type": "string",
                                    "enum": ["confirm", "select", "text"]
                                },
                                "header": { "type": "string" },
                                "question": { "type": "string" },
                                "options": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "required": ["label"],
                                        "properties": {
                                            "label": { "type": "string" },
                                            "description": { "type": "string" }
                                        }
                                    }
                                },
                                "multi_select": { "type": "boolean" },
                                "optional": { "type": "boolean" },
                                "placeholder": { "type": "string" }
                            }
                        }
                    }
                }
            }
        }));
    }
    if tools.approve_tool {
        // Claude Code invokes this itself, as the target of
        // --permission-prompt-tool. It is nonetheless visible in the model's
        // tool list, so the description tells the model to leave it alone.
        defs.push(serde_json::json!({
            "name": "approve_tool",
            "description": "INTERNAL — Claude Code's permission prompt handler for this run. \
                            It is invoked automatically when a tool call needs approval. \
                            Never call it yourself; calling it directly does nothing useful.",
            "inputSchema": {
                "type": "object",
                "required": ["tool_name", "input"],
                "properties": {
                    "tool_name": { "type": "string" },
                    "input": { "type": "object" },
                    "tool_use_id": { "type": "string" }
                }
            }
        }));
    }
    defs
}

fn call_ask_user(port: u16, args: &Value) -> Result<Value, RpcError> {
    let questions: Vec<Question> = serde_json::from_value(args["questions"].clone())
        .map_err(|e| rpc_err(-32600, format!("Invalid questions: {e}")))?;
    let reply = round_trip(
        port,
        &WireRequest::Ask {
            questions: questions.clone(),
        },
    )
    .map_err(|e| rpc_err(-32603, format!("Bridge error: {e}")))?;
    let WireReply::Answers { answers } = reply else {
        return Err(rpc_err(-32603, "Bridge error: expected answers".into()));
    };
    let text = format_answers(&questions, &answers);
    Ok(serde_json::json!({ "content": [{ "type": "text", "text": text }] }))
}

fn call_approve_tool(port: u16, args: &Value) -> Result<Value, RpcError> {
    // Claude passes `tool_name` and `input`. A call without them is the model
    // poking at the tool by hand; say so rather than treating it as a decision.
    let Some(tool) = args["tool_name"].as_str().filter(|s| !s.is_empty()) else {
        return Err(rpc_err(
            -32600,
            "approve_tool is Claude Code's permission handler and takes a tool_name; \
             it is not callable directly"
                .into(),
        ));
    };
    let input = args.get("input").cloned().unwrap_or(Value::Null);
    let reply = round_trip(
        port,
        &WireRequest::Approve {
            tool: tool.to_string(),
            input: input.clone(),
        },
    )
    .map_err(|e| rpc_err(-32603, format!("Bridge error: {e}")))?;
    let WireReply::Verdict { allow, message } = reply else {
        return Err(rpc_err(-32603, "Bridge error: expected a verdict".into()));
    };
    // The permission-prompt contract: one text block whose body is the decision
    // JSON. `updatedInput` is mandatory on allow — before claude 2.1.207 an
    // allow that omitted it was rejected as a validation error and denied.
    let decision = if allow {
        serde_json::json!({ "behavior": "allow", "updatedInput": input })
    } else {
        serde_json::json!({
            "behavior": "deny",
            "message": message.unwrap_or_else(|| "denied by the run's permission rules".into())
        })
    };
    Ok(serde_json::json!({
        "content": [{ "type": "text", "text": decision.to_string() }]
    }))
}

fn json_rpc_error(id: &serde_json::Value, code: i32, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
    .to_string()
}

fn format_answers(questions: &[Question], answers: &[Vec<String>]) -> String {
    questions
        .iter()
        .zip(answers.iter())
        .map(|(q, a)| {
            let answer_text = if a.is_empty() {
                "(no answer)".to_string()
            } else {
                a.join(", ")
            };
            format!("{}: {}", q.header, answer_text)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Send one request over the bridge and block for its reply.
fn round_trip(port: u16, req: &WireRequest) -> std::io::Result<WireReply> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    let body = serde_json::to_string(req).map_err(std::io::Error::other)?;
    writeln!(stream, "{body}")?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    serde_json::from_str(line.trim()).map_err(std::io::Error::other)
}

/// MCP stdio server loop. Reads `KATA_ASK_PORT` and `KATA_MCP_TOOLS` from the
/// environment, then loops reading JSON-RPC 2.0 lines from stdin and writing
/// responses to stdout. EOF on stdin is a clean exit.
pub fn serve_stdio() -> std::io::Result<()> {
    let port: u16 = std::env::var("KATA_ASK_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let tools = Tools::from_env();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        if stdin.lock().read_line(&mut line)? == 0 {
            return Ok(());
        }
        if let Some(resp) = handle_rpc(line.trim(), port, tools) {
            writeln!(stdout, "{resp}")?;
            stdout.flush()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::QuestionKind;
    use crate::run::CancelToken;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;
    use std::sync::mpsc;
    use std::thread;

    fn both() -> Tools {
        Tools {
            ask_user: true,
            approve_tool: true,
        }
    }
    fn ask_only() -> Tools {
        Tools {
            ask_user: true,
            approve_tool: false,
        }
    }

    #[test]
    fn bridge_round_trips_a_question_and_answer() {
        let bridge = Bridge::bind().unwrap();
        let port = bridge.port();
        let (tx, rx) = mpsc::channel::<Request>();
        bridge.serve(tx, CancelToken::new());

        let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
        writeln!(
            sock,
            r#"{{"kind":"ask","questions":[{{"kind":"text","header":"h","question":"q?"}}]}}"#
        )
        .unwrap();

        let req = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        let RequestPayload::Ask(questions) = req.payload else {
            panic!("expected an ask");
        };
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].kind, QuestionKind::Text);
        req.reply
            .send(ReplyPayload::Answers(vec![vec!["typed answer".into()]]))
            .unwrap();

        let mut reader = BufReader::new(sock.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(
            line.contains(r#""answers":[["typed answer"]]"#),
            "got {line}"
        );
    }

    #[test]
    fn bridge_round_trips_an_approval_and_verdict() {
        let bridge = Bridge::bind().unwrap();
        let port = bridge.port();
        let (tx, rx) = mpsc::channel::<Request>();
        bridge.serve(tx, CancelToken::new());

        let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
        writeln!(
            sock,
            r#"{{"kind":"approve","tool":"Bash","input":{{"command":"ls"}}}}"#
        )
        .unwrap();

        let req = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        let RequestPayload::Approve { tool, input } = req.payload else {
            panic!("expected an approve");
        };
        assert_eq!(tool, "Bash");
        assert_eq!(input["command"], "ls");
        req.reply
            .send(ReplyPayload::Verdict(Verdict {
                allow: false,
                message: Some("nope".into()),
            }))
            .unwrap();

        let mut reader = BufReader::new(sock.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains(r#""allow":false"#), "got {line}");
        assert!(line.contains("nope"), "got {line}");
    }

    #[test]
    fn rpc_initialize_advertises_tools_capability() {
        let resp = handle_rpc(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#,
            0,
            ask_only(),
        )
        .unwrap();
        assert!(resp.contains(r#""tools""#));
        assert!(resp.contains(r#""serverInfo""#));
    }

    #[test]
    fn rpc_tools_list_exposes_ask_user_with_schema() {
        let resp = handle_rpc(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            0,
            ask_only(),
        )
        .unwrap();
        assert!(resp.contains(r#""name":"ask_user""#));
        assert!(resp.contains(r#""questions""#)); // inputSchema mentions questions
    }

    // A run only exposes what its spec asked for: a non-interactive prompt-mode
    // run must not hand claude an ask_user it has no way to answer, and a plain
    // interactive run must not advertise the permission handler.
    #[test]
    fn tools_list_is_gated_by_the_enabled_set() {
        let list =
            |t| handle_rpc(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, 0, t).unwrap();
        let ask = list(ask_only());
        assert!(ask.contains("ask_user"));
        assert!(!ask.contains("approve_tool"));

        let approve = list(Tools {
            ask_user: false,
            approve_tool: true,
        });
        assert!(approve.contains("approve_tool"));
        assert!(!approve.contains("ask_user"));

        let none = list(Tools::none());
        assert!(none.contains(r#""tools":[]"#), "got {none}");
    }

    #[test]
    fn calling_a_tool_this_run_did_not_enable_is_an_unknown_tool() {
        let call = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"approve_tool","arguments":{"tool_name":"Bash","input":{}}}}"#;
        let resp = handle_rpc(call, 0, ask_only()).unwrap();
        assert!(resp.contains("-32601"), "expected Unknown tool, got {resp}");
    }

    #[test]
    fn rpc_initialized_notification_has_no_response() {
        assert!(handle_rpc(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            0,
            both()
        )
        .is_none());
    }

    #[test]
    fn rpc_tools_call_bridges_to_the_listener() {
        // Stand up a bridge that auto-answers, then drive a tools/call through it.
        let bridge = Bridge::bind().unwrap();
        let port = bridge.port();
        let (tx, rx) = mpsc::channel::<Request>();
        bridge.serve(tx, CancelToken::new());
        thread::spawn(move || {
            let req = rx.recv().unwrap();
            req.reply
                .send(ReplyPayload::Answers(vec![vec!["JWT".into()]]))
                .unwrap();
        });
        let call = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask_user","arguments":{"questions":[{"kind":"text","header":"h","question":"q?"}]}}}"#;
        let resp = handle_rpc(call, port, both()).unwrap();
        assert!(
            resp.contains("JWT"),
            "tool result should carry the answer: {resp}"
        );
        assert!(resp.contains(r#""content""#));
    }

    // The shape claude requires of a permission prompt tool: a text block whose
    // body is the decision JSON, and `updatedInput` present on every allow.
    #[test]
    fn approve_tool_returns_the_permission_result_contract() {
        for (allow, expect) in [(true, "allow"), (false, "deny")] {
            let bridge = Bridge::bind().unwrap();
            let port = bridge.port();
            let (tx, rx) = mpsc::channel::<Request>();
            bridge.serve(tx, CancelToken::new());
            thread::spawn(move || {
                let req = rx.recv().unwrap();
                req.reply
                    .send(ReplyPayload::Verdict(Verdict {
                        allow,
                        message: Some("policy says no".into()),
                    }))
                    .unwrap();
            });
            let call = r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"approve_tool","arguments":{"tool_name":"Bash","input":{"command":"ls -la"},"tool_use_id":"toolu_1"}}}"#;
            let resp = handle_rpc(call, port, both()).unwrap();

            let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
            let text = v["result"]["content"][0]["text"].as_str().unwrap();
            let decision: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(decision["behavior"], expect);
            if allow {
                assert_eq!(
                    decision["updatedInput"]["command"], "ls -la",
                    "an allow must echo updatedInput or claude denies the call"
                );
            } else {
                assert_eq!(decision["message"], "policy says no");
            }
        }
    }

    // The model can see approve_tool in its tool list. A hand-rolled call with no
    // tool_name must be refused, not mistaken for a real permission decision.
    #[test]
    fn approve_tool_refuses_a_direct_call_without_a_tool_name() {
        let call = r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"approve_tool","arguments":{"why":"curious"}}}"#;
        let resp = handle_rpc(call, 0, both()).unwrap();
        assert!(resp.contains("-32600"), "got {resp}");
        assert!(resp.contains("not callable directly"), "got {resp}");
    }

    #[test]
    fn rpc_malformed_json_returns_parse_error() {
        let resp = handle_rpc("this is not json", 0, both()).expect("must respond, not hang");
        assert!(resp.contains("-32700"), "expected Parse error, got {resp}");
    }

    #[test]
    fn rpc_missing_method_returns_invalid_request() {
        let resp = handle_rpc(r#"{"jsonrpc":"2.0","id":9}"#, 0, both()).expect("must respond");
        assert!(
            resp.contains("-32600"),
            "expected Invalid Request, got {resp}"
        );
    }

    #[test]
    fn rpc_notification_without_id_returns_none() {
        // A message with no id is a notification → no response.
        assert!(handle_rpc(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            0,
            both()
        )
        .is_none());
    }

    #[test]
    fn tools_env_round_trips() {
        for t in [
            Tools::none(),
            ask_only(),
            Tools {
                ask_user: false,
                approve_tool: true,
            },
            both(),
        ] {
            let raw = t.to_env();
            let mut back = Tools::none();
            for name in raw.split(',').map(str::trim) {
                match name {
                    "ask_user" => back.ask_user = true,
                    "approve_tool" => back.approve_tool = true,
                    _ => {}
                }
            }
            assert_eq!(t, back, "round-trip failed for {raw:?}");
        }
    }
}
