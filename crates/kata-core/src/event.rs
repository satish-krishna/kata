use serde::{Deserialize, Serialize};
use std::io::BufRead;

/// Wire-protocol version of the `KataEvent` stream. Bump on any breaking
/// change to an event shape. Stamped into `schema/kata-events.schema.json`
/// so consumers can pin and detect breaks.
pub const KATA_EVENT_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "type")]
pub enum KataEvent {
    #[serde(rename = "run.started")]
    RunStarted {
        spec: String,
        model: Option<String>,
        workdir: String,
        isolation: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        worktree: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
    #[serde(rename = "log")]
    Log { level: String, message: String },
    #[serde(rename = "assistant.text")]
    AssistantText { text: String },
    #[serde(rename = "tool.use")]
    ToolUse { name: String, input_summary: String },
    #[serde(rename = "tool.result")]
    ToolResult {
        name: String,
        ok: bool,
        summary: String,
    },
    #[serde(rename = "turn")]
    Turn { n: u32 },
    #[serde(rename = "run.completed")]
    RunCompleted {
        exit_code: i32,
        is_error: bool,
        num_turns: u32,
        cost_usd: Option<f64>,
        duration_ms: u64,
        result: Option<String>,
    },
    #[serde(rename = "run.diff")]
    RunDiff {
        worktree: String,
        branch: String,
        files: Vec<DiffFile>,
        insertions: u32,
        deletions: u32,
    },
    #[serde(rename = "ask.requested")]
    AskRequested {
        id: String,
        questions: Vec<Question>,
    },
    #[serde(rename = "ask.answered")]
    AskAnswered {
        id: String,
        answers: Vec<Vec<String>>,
    },
    #[serde(rename = "run.error")]
    RunError { message: String, exit_code: i32 },
    #[serde(rename = "run.cancelled")]
    RunCancelled { exit_code: i32 },
}

/// One changed file in a worktree-isolation diff summary. Part of the
/// `run.diff` event payload; also produced by `crate::worktree::diff`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DiffFile {
    /// Git short status for the change: "A" | "M" | "D" | "R" | ...
    pub status: String,
    /// Path relative to the worktree root.
    pub path: String,
}

/// One question in an `ask.requested` batch. Mirrored by hand in
/// `app/src/lib/events.ts` (events are not ts-rs exported).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResultPayload {
    pub num_turns: u32,
    pub cost_usd: Option<f64>,
    pub is_error: bool,
    pub result: Option<String>,
    pub subtype: Option<String>,
}

impl ResultPayload {
    /// True when claude stopped because it hit `--max-budget-usd`. The terminal
    /// `result` event carries this subtype; the process exit code is a generic 1.
    pub fn is_budget_exhausted(&self) -> bool {
        self.subtype.as_deref() == Some("error_max_budget_usd")
    }
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub events: Vec<KataEvent>,
    pub is_assistant_message: bool,
    pub result: Option<ResultPayload>,
}

/// Translate one line of Claude `stream-json` into normalized events.
/// Defensive: unknown shapes and malformed JSON yield an empty `Parsed`.
pub fn parse_stream_line(line: &str) -> Parsed {
    let mut out = Parsed::default();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return out;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => {
            out.is_assistant_message = true;
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for block in content {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                out.events.push(KataEvent::AssistantText {
                                    text: t.to_string(),
                                });
                            }
                        }
                        Some("tool_use") => {
                            let name = block
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("")
                                .to_string();
                            // The ask_user MCP tool surfaces via the AskPanel, not a
                            // stream row; suppress its tool.use here.
                            if name.ends_with("ask_user") {
                                continue;
                            }
                            out.events.push(KataEvent::ToolUse {
                                name,
                                input_summary: summarize_input(block.get("input")),
                            });
                        }
                        _ => {}
                    }
                }
            }
        }
        Some("user") => {
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for block in content {
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        let ok = !block
                            .get("is_error")
                            .and_then(|b| b.as_bool())
                            .unwrap_or(false);
                        // TODO: claude tool_result carries a tool_use_id, not a
                        // tool name; correlate it back to the tool.use to fill `name`.
                        out.events.push(KataEvent::ToolResult {
                            name: String::new(),
                            ok,
                            summary: summarize_content(block.get("content")),
                        });
                    }
                }
            }
        }
        Some("result") => {
            out.result = Some(ResultPayload {
                num_turns: v.get("num_turns").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
                cost_usd: v.get("total_cost_usd").and_then(|c| c.as_f64()),
                is_error: v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
                result: v.get("result").and_then(|r| r.as_str()).map(String::from),
                subtype: v.get("subtype").and_then(|s| s.as_str()).map(String::from),
            });
        }
        _ => {}
    }
    out
}

fn summarize_input(input: Option<&serde_json::Value>) -> String {
    match input {
        Some(v) => v
            .get("command")
            .and_then(|c| c.as_str())
            .map(String::from)
            .unwrap_or_else(|| truncate(&v.to_string(), 200)),
        None => String::new(),
    }
}

fn summarize_content(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => truncate(s, 200),
        Some(other) => truncate(&other.to_string(), 200),
        None => String::new(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Walk back to the nearest char boundary at or before `max` bytes so we
    // never slice through a multibyte character.
    let boundary = s
        .char_indices()
        .map(|(i, _)| i)
        .take_while(|&i| i <= max)
        .last()
        .unwrap_or(0);
    format!("{}...", &s[..boundary])
}

/// Read `stream-json` lines from `reader`, emit normalized events via `emit`,
/// counting assistant turns. Returns the final result payload if seen.
/// `cancel` is polled between lines; when it returns true, the loop stops early.
pub fn pump<R: BufRead>(
    reader: R,
    cancel: &dyn Fn() -> bool,
    emit: &mut dyn FnMut(KataEvent),
) -> Option<ResultPayload> {
    let mut turns: u32 = 0;
    let mut result = None;
    for line in reader.lines() {
        if cancel() {
            break;
        }
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let parsed = parse_stream_line(&line);
        if parsed.is_assistant_message {
            turns += 1;
            emit(KataEvent::Turn { n: turns });
        }
        for e in parsed.events {
            emit(e);
        }
        if let Some(r) = parsed.result {
            result = Some(r);
        }
    }
    result
}

/// Render the canonical `KataEvent` JSON Schema: the schemars output with a
/// stable root `title`, a `protocolVersion` stamp, and a trailing newline.
/// This exact string is what `schema/kata-events.schema.json` must contain.
#[cfg(feature = "schema")]
pub fn generate_schema_json() -> String {
    let mut root = serde_json::to_value(schemars::schema_for!(KataEvent)).unwrap();
    let obj = root.as_object_mut().unwrap();
    // Guarantee a deterministic name for downstream TS codegen.
    obj.insert("title".to_string(), serde_json::json!("KataEvent"));
    obj.insert(
        "protocolVersion".to_string(),
        serde_json::json!(KATA_EVENT_PROTOCOL_VERSION),
    );
    let mut s = serde_json::to_string_pretty(&root).unwrap();
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_assistant_text_and_marks_message() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#;
        let p = parse_stream_line(line);
        assert!(p.is_assistant_message);
        assert_eq!(
            p.events,
            vec![KataEvent::AssistantText {
                text: "hello".into()
            }]
        );
        assert!(p.result.is_none());
    }

    #[test]
    fn parses_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}"#;
        let p = parse_stream_line(line);
        assert_eq!(
            p.events,
            vec![KataEvent::ToolUse {
                name: "Bash".into(),
                input_summary: "ls -la".into()
            }]
        );
    }

    #[test]
    fn parses_tool_result() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"3 failed","is_error":false}]}}"#;
        let p = parse_stream_line(line);
        assert_eq!(
            p.events,
            vec![KataEvent::ToolResult {
                name: String::new(),
                ok: true,
                summary: "3 failed".into()
            }]
        );
        assert!(!p.is_assistant_message);
    }

    #[test]
    fn parses_result_payload() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"num_turns":6,"total_cost_usd":0.04,"result":"done"}"#;
        let p = parse_stream_line(line);
        let r = p.result.unwrap();
        assert_eq!(r.num_turns, 6);
        assert_eq!(r.cost_usd, Some(0.04));
        assert!(!r.is_error);
        assert_eq!(r.result.as_deref(), Some("done"));
    }

    #[test]
    fn unrecognized_line_yields_no_events() {
        let p = parse_stream_line(r#"{"type":"system","subtype":"init"}"#);
        assert!(p.events.is_empty());
        assert!(p.result.is_none());
    }

    #[test]
    fn malformed_json_does_not_panic() {
        let p = parse_stream_line("not json");
        assert!(p.events.is_empty());
        assert!(p.result.is_none());
    }

    #[test]
    fn parses_real_captured_fixture() {
        // Grounds the parser in REAL claude output captured in Task 0.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/stream-hello.jsonl"
        );
        let text = std::fs::read_to_string(path).unwrap();
        let (mut saw_text, mut saw_result) = (false, false);
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let p = parse_stream_line(line);
            if p.events
                .iter()
                .any(|e| matches!(e, KataEvent::AssistantText { .. }))
            {
                saw_text = true;
            }
            if p.result.is_some() {
                saw_result = true;
            }
        }
        assert!(saw_text, "should extract assistant text from real output");
        assert!(
            saw_result,
            "should extract a result payload from real output"
        );
    }

    #[test]
    fn pump_emits_turns_and_returns_result() {
        let input = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"num_turns":2,"total_cost_usd":0.01,"result":"ok"}"#,
            "\n",
        );
        let mut events = Vec::new();
        let result = pump(Cursor::new(input), &|| false, &mut |e| events.push(e));
        assert_eq!(result.unwrap().num_turns, 2);
        assert!(events.contains(&KataEvent::Turn { n: 1 }));
        assert!(events.contains(&KataEvent::Turn { n: 2 }));
        assert!(events.contains(&KataEvent::AssistantText { text: "a".into() }));
    }

    #[test]
    fn truncate_does_not_panic_on_multibyte() {
        // 100 three-byte chars = 300 bytes; a 200-byte cut lands mid-character.
        let s = "あ".repeat(100);
        let t = truncate(&s, 200);
        assert!(t.ends_with("..."));
        assert!(t.len() <= 203); // truncated bytes + the "..." suffix
                                 // The prefix before "..." must be valid UTF-8 (no panic, no broken char).
        assert!(t.trim_end_matches("...").chars().all(|c| c == 'あ'));
    }

    #[test]
    fn run_diff_serializes_with_tag_and_files() {
        let e = KataEvent::RunDiff {
            worktree: "/home/u/.kata/worktrees/spec-abc".into(),
            branch: "kata/spec-abc".into(),
            files: vec![DiffFile {
                status: "M".into(),
                path: "src/run.rs".into(),
            }],
            insertions: 3,
            deletions: 1,
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""type":"run.diff""#));
        assert!(s.contains(r#""branch":"kata/spec-abc""#));
        assert!(s.contains(r#""status":"M""#));
        assert!(s.contains(r#""path":"src/run.rs""#));
        assert!(s.contains(r#""insertions":3"#));
        assert!(s.contains(r#""deletions":1"#));
    }

    #[test]
    fn run_started_omits_worktree_fields_when_none() {
        let e = KataEvent::RunStarted {
            spec: "s".into(),
            model: None,
            workdir: "/w".into(),
            isolation: "none".into(),
            worktree: None,
            branch: None,
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(
            !s.contains("worktree"),
            "absent worktree must not serialize: {s}"
        );
        assert!(
            !s.contains("branch"),
            "absent branch must not serialize: {s}"
        );
    }

    #[test]
    fn ask_requested_serializes_with_tag_and_questions() {
        let e = KataEvent::AskRequested {
            id: "q1".into(),
            questions: vec![Question {
                kind: QuestionKind::Select,
                header: "auth".into(),
                question: "Which approach?".into(),
                options: vec![QuestionOption {
                    label: "JWT".into(),
                    description: Some("stateless".into()),
                }],
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
        let e = KataEvent::AskAnswered {
            id: "q1".into(),
            answers: vec![vec!["JWT".into()]],
        };
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

    #[test]
    fn parses_budget_subtype_and_flags_exhaustion() {
        let line = r#"{"type":"result","subtype":"error_max_budget_usd","is_error":true,"num_turns":1,"total_cost_usd":0.13,"result":null,"errors":["Reached maximum budget ($0.0001)"]}"#;
        let p = parse_stream_line(line);
        let r = p.result.unwrap();
        assert_eq!(r.subtype.as_deref(), Some("error_max_budget_usd"));
        assert!(r.is_budget_exhausted());
    }

    #[test]
    fn success_result_is_not_budget_exhausted() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"num_turns":2,"total_cost_usd":0.02,"result":"done"}"#;
        let r = parse_stream_line(line).result.unwrap();
        assert!(!r.is_budget_exhausted());
    }

    #[test]
    fn ask_user_tool_use_is_suppressed_from_the_stream() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__kata-ask__ask_user","input":{"questions":[]}}]}}"#;
        let p = parse_stream_line(line);
        assert!(p.is_assistant_message, "still counts as an assistant turn");
        assert!(
            p.events.is_empty(),
            "the ask_user tool.use must not render as a row"
        );
    }

    #[cfg(feature = "schema")]
    #[test]
    fn schema_is_internally_tagged_and_names_variants() {
        let json = serde_json::to_value(schemars::schema_for!(KataEvent)).unwrap();
        // Internally-tagged enum → a `oneOf` of variant subschemas.
        let variants = json.get("oneOf").and_then(|v| v.as_array()).unwrap();
        assert!(variants.len() >= 12, "expected one subschema per variant");
        // The wire tag must be the literal event name, e.g. "run.started".
        let dump = json.to_string();
        assert!(dump.contains("run.started"), "tag rename must survive: {dump}");
        assert!(dump.contains("ask.requested"));
        assert!(dump.contains("tool.result"));
    }

    #[test]
    fn terminal_events_carry_exit_code_and_round_trip() {
        let cases = [
            KataEvent::RunError {
                message: "reached max turns (12)".into(),
                exit_code: 125,
            },
            KataEvent::RunCancelled { exit_code: 130 },
            KataEvent::RunCompleted {
                exit_code: 0,
                is_error: false,
                num_turns: 2,
                cost_usd: Some(0.02),
                duration_ms: 100,
                result: Some("done".into()),
            },
        ];
        for ev in cases {
            let json = serde_json::to_string(&ev).unwrap();
            let back: KataEvent = serde_json::from_str(&json).unwrap();
            assert_eq!(ev, back, "round-trip mismatch for {json}");
        }
        let s = serde_json::to_string(&KataEvent::RunCancelled { exit_code: 130 }).unwrap();
        assert!(
            s.contains(r#""exit_code":130"#),
            "cancel must serialize its code: {s}"
        );
    }

    #[cfg(feature = "schema")]
    #[test]
    fn schema_artifact_is_fresh() {
        let generated = super::generate_schema_json();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../schema/kata-events.schema.json");
        if std::env::var_os("KATA_BLESS_SCHEMA").is_some() {
            let p = std::path::Path::new(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, &generated).unwrap();
            return;
        }
        let committed = std::fs::read_to_string(path).unwrap_or_else(|_| {
            panic!("schema/kata-events.schema.json missing — regenerate with \
                    KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema schema_artifact_is_fresh")
        });
        assert_eq!(
            committed, generated,
            "schema drift — regenerate with KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema schema_artifact_is_fresh"
        );
    }
}
