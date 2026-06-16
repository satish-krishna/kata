use serde::Serialize;
use std::io::BufRead;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum KataEvent {
    #[serde(rename = "run.started")]
    RunStarted { spec: String, model: Option<String>, workdir: String, isolation: String },
    #[serde(rename = "log")]
    Log { level: String, message: String },
    #[serde(rename = "assistant.text")]
    AssistantText { text: String },
    #[serde(rename = "tool.use")]
    ToolUse { name: String, input_summary: String },
    #[serde(rename = "tool.result")]
    ToolResult { name: String, ok: bool, summary: String },
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
    #[serde(rename = "run.error")]
    RunError { message: String },
    #[serde(rename = "run.cancelled")]
    RunCancelled,
}

/// One changed file in a worktree-isolation diff summary. Part of the
/// `run.diff` event payload; also produced by `crate::worktree::diff`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiffFile {
    /// Git short status for the change: "A" | "M" | "D" | "R" | ...
    pub status: String,
    /// Path relative to the worktree root.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResultPayload {
    pub num_turns: u32,
    pub cost_usd: Option<f64>,
    pub is_error: bool,
    pub result: Option<String>,
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
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return out };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => {
            out.is_assistant_message = true;
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for block in content {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                out.events.push(KataEvent::AssistantText { text: t.to_string() });
                            }
                        }
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                            out.events.push(KataEvent::ToolUse { name, input_summary: summarize_input(block.get("input")) });
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
                        let ok = !block.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
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
            });
        }
        _ => {}
    }
    out
}

fn summarize_input(input: Option<&serde_json::Value>) -> String {
    match input {
        Some(v) => v.get("command").and_then(|c| c.as_str())
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
        if cancel() { break; }
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let parsed = parse_stream_line(&line);
        if parsed.is_assistant_message {
            turns += 1;
            emit(KataEvent::Turn { n: turns });
        }
        for e in parsed.events { emit(e); }
        if let Some(r) = parsed.result { result = Some(r); }
    }
    result
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
        assert_eq!(p.events, vec![KataEvent::AssistantText { text: "hello".into() }]);
        assert!(p.result.is_none());
    }

    #[test]
    fn parses_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}"#;
        let p = parse_stream_line(line);
        assert_eq!(p.events, vec![KataEvent::ToolUse { name: "Bash".into(), input_summary: "ls -la".into() }]);
    }

    #[test]
    fn parses_tool_result() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"3 failed","is_error":false}]}}"#;
        let p = parse_stream_line(line);
        assert_eq!(p.events, vec![KataEvent::ToolResult { name: String::new(), ok: true, summary: "3 failed".into() }]);
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
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stream-hello.jsonl");
        let text = std::fs::read_to_string(path).unwrap();
        let (mut saw_text, mut saw_result) = (false, false);
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let p = parse_stream_line(line);
            if p.events.iter().any(|e| matches!(e, KataEvent::AssistantText { .. })) { saw_text = true; }
            if p.result.is_some() { saw_result = true; }
        }
        assert!(saw_text, "should extract assistant text from real output");
        assert!(saw_result, "should extract a result payload from real output");
    }

    #[test]
    fn pump_emits_turns_and_returns_result() {
        let input = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#, "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"num_turns":2,"total_cost_usd":0.01,"result":"ok"}"#, "\n",
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
            files: vec![DiffFile { status: "M".into(), path: "src/run.rs".into() }],
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
}
