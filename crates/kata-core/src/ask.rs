//! The ask bridge: how a paused interactive run carries a question from claude
//! (via the `kata mcp-ask` MCP server it spawns) to the engine and an answer
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

#[derive(Serialize, Deserialize)]
struct QuestionFrame {
    questions: Vec<Question>,
}

#[derive(Serialize)]
struct AnswerFrame<'a> {
    answers: &'a [Vec<String>],
}

#[derive(Deserialize)]
struct AnswerFrameOwned {
    answers: Vec<Vec<String>>,
}

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

fn handle_conn(stream: TcpStream, tx: &Sender<AskRequest>) -> std::io::Result<()> {
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
        let Ok(frame) = serde_json::from_str::<QuestionFrame>(trimmed) else {
            continue;
        };
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        if tx
            .send(AskRequest {
                questions: frame.questions,
                reply: reply_tx,
            })
            .is_err()
        {
            return Ok(()); // run loop gone
        }
        // Block until the run loop supplies an answer (or is cancelled/torn down).
        let answers = match reply_rx.recv() {
            Ok(a) => a,
            Err(_) => return Ok(()),
        };
        let frame = AnswerFrame { answers: &answers };
        let body = serde_json::to_string(&frame).map_err(std::io::Error::other)?;
        writeln!(write_half, "{body}")?;
        write_half.flush()?;
    }
}

/// Handle one JSON-RPC 2.0 line from claude. Returns the response JSON line,
/// or `None` for notifications (which require no response per the MCP spec).
pub fn handle_rpc(line: &str, port: u16) -> Option<String> {
    // 1. Parse JSON; if it fails, return Parse error response per JSON-RPC 2.0
    let val: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            // Unparseable input gets Parse error with id: null
            return Some(json_rpc_error(&serde_json::Value::Null, -32700, "Parse error"));
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
                    "name": "kata-ask",
                    "version": env!("CARGO_PKG_VERSION")
                }
            })
        }
        "tools/list" => {
            serde_json::json!({
                "tools": [{
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
                }]
            })
        }
        "tools/call" => {
            let name = val["params"]["name"].as_str().unwrap_or("");
            if name != "ask_user" {
                return Some(json_rpc_error(id, -32601, "Unknown tool"));
            }
            let questions_val = &val["params"]["arguments"]["questions"];
            let questions: Vec<Question> = match serde_json::from_value(questions_val.clone()) {
                Ok(q) => q,
                Err(e) => {
                    return Some(json_rpc_error(
                        id,
                        -32600,
                        &format!("Invalid questions: {e}"),
                    ))
                }
            };
            let answers = match ask_over_bridge(port, &questions) {
                Ok(a) => a,
                Err(e) => {
                    return Some(json_rpc_error(id, -32603, &format!("Bridge error: {e}")))
                }
            };
            let text = format_answers(&questions, &answers);
            serde_json::json!({
                "content": [{ "type": "text", "text": text }]
            })
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

fn ask_over_bridge(port: u16, questions: &[Question]) -> std::io::Result<Vec<Vec<String>>> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    let frame = QuestionFrame {
        questions: questions.to_vec(),
    };
    let body = serde_json::to_string(&frame).map_err(std::io::Error::other)?;
    writeln!(stream, "{body}")?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let ans: AnswerFrameOwned =
        serde_json::from_str(line.trim()).map_err(std::io::Error::other)?;
    Ok(ans.answers)
}

/// MCP stdio server loop. Reads `KATA_ASK_PORT` from the environment, then
/// loops reading JSON-RPC 2.0 lines from stdin and writing responses to stdout.
/// EOF on stdin is a clean exit.
pub fn serve_stdio() -> std::io::Result<()> {
    let port: u16 = std::env::var("KATA_ASK_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        if stdin.lock().read_line(&mut line)? == 0 {
            return Ok(());
        }
        if let Some(resp) = handle_rpc(line.trim(), port) {
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

    #[test]
    fn bridge_round_trips_a_question_and_answer() {
        let bridge = Bridge::bind().unwrap();
        let port = bridge.port();
        let (tx, rx) = mpsc::channel::<AskRequest>();
        bridge.serve(tx, CancelToken::new());

        let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
        writeln!(
            sock,
            r#"{{"questions":[{{"kind":"text","header":"h","question":"q?"}}]}}"#
        )
        .unwrap();

        let req = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(req.questions.len(), 1);
        assert_eq!(req.questions[0].kind, QuestionKind::Text);
        req.reply.send(vec![vec!["typed answer".into()]]).unwrap();

        let mut reader = BufReader::new(sock.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(
            line.contains(r#""answers":[["typed answer"]]"#),
            "got {line}"
        );
    }

    #[test]
    fn rpc_initialize_advertises_tools_capability() {
        let resp = handle_rpc(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#,
            0,
        )
        .unwrap();
        assert!(resp.contains(r#""tools""#));
        assert!(resp.contains(r#""serverInfo""#));
    }

    #[test]
    fn rpc_tools_list_exposes_ask_user_with_schema() {
        let resp =
            handle_rpc(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, 0).unwrap();
        assert!(resp.contains(r#""name":"ask_user""#));
        assert!(resp.contains(r#""questions""#)); // inputSchema mentions questions
    }

    #[test]
    fn rpc_initialized_notification_has_no_response() {
        assert!(
            handle_rpc(
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                0
            )
            .is_none()
        );
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

    #[test]
    fn rpc_malformed_json_returns_parse_error() {
        let resp = handle_rpc("this is not json", 0).expect("must respond, not hang");
        assert!(resp.contains("-32700"), "expected Parse error, got {resp}");
    }

    #[test]
    fn rpc_missing_method_returns_invalid_request() {
        let resp = handle_rpc(r#"{"jsonrpc":"2.0","id":9}"#, 0).expect("must respond");
        assert!(resp.contains("-32600"), "expected Invalid Request, got {resp}");
    }

    #[test]
    fn rpc_notification_without_id_returns_none() {
        // A message with no id is a notification → no response.
        assert!(handle_rpc(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, 0).is_none());
    }
}
