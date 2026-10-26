use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::BufRead;

/// Wire-protocol version of the `KataEvent` stream. Bump on any breaking
/// change to an event shape. Stamped into `schema/kata-events.schema.json`
/// so consumers can pin and detect breaks.
pub const KATA_EVENT_PROTOCOL_VERSION: u32 = 1;

/// Per-field ceiling for `tool.use.input` (serialized) and `tool.result.output`
/// under `kata run --full-payloads`. Keeps one accidental `cat` of a minified
/// bundle from reaching the webview as a multi-megabyte DOM node.
pub const PAYLOAD_CAP_BYTES: usize = 256 * 1024;

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "type")]
// `run.given` carries the whole record of a run; events are built and sent one at a time.
#[allow(clippy::large_enum_variant)]
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
    AssistantText {
        text: String,
        /// `id` of the subagent call this text was written inside; absent at
        /// the top level.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
    #[serde(rename = "tool.use")]
    ToolUse {
        name: String,
        input_summary: String,
        /// claude's `tool_use_id`. Pairs this call with its `tool.result`.
        /// Emitted on every run; absent only in transcripts written before it
        /// existed, or when claude sent none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// `id` of the subagent call this call was made inside; absent at the
        /// top level.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
        /// Raw tool input. Only under `kata run --full-payloads`; omitted, with
        /// `truncated` set, when its serialized form exceeds `PAYLOAD_CAP_BYTES`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "is_false")]
        truncated: bool,
    },
    #[serde(rename = "tool.result")]
    ToolResult {
        name: String,
        ok: bool,
        summary: String,
        /// The `id` of the `tool.use` this result answers.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
        /// The tool's output flattened to text. Only under
        /// `kata run --full-payloads`; cut at `PAYLOAD_CAP_BYTES` with
        /// `truncated` set.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        truncated: bool,
    },
    #[serde(rename = "turn")]
    Turn {
        n: u32,
        /// Set when the assistant message came from inside a subagent: the
        /// `id` of the `tool.use` that spawned it. Omitted at the top level.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
    #[serde(rename = "run.completed")]
    RunCompleted {
        exit_code: i32,
        is_error: bool,
        num_turns: u32,
        cost_usd: Option<f64>,
        duration_ms: u64,
        result: Option<String>,
    },
    /// What the run was given: every item with how Claude's own report squares
    /// with what Kata passed, the run's settings, and the environment names.
    /// Emitted when Claude's start report arrives and again, complete, the first
    /// time a hook fires; a consumer keeps only the last one. A run that ends
    /// before any start report still gets one. Never carries a value of an
    /// environment variable or a hook's command.
    #[serde(rename = "run.given")]
    RunGiven {
        items: Vec<crate::given::GivenItem>,
        settings: crate::given::RunSettings,
        env: Vec<crate::given::EnvName>,
        warnings: Vec<String>,
        /// The options the run was resolved with.
        #[serde(default)]
        options: crate::given::GivenOptions,
    },
    #[serde(rename = "run.diff")]
    RunDiff {
        /// Absolute worktree path — present only for a worktree-isolated run.
        #[serde(skip_serializing_if = "Option::is_none")]
        worktree: Option<String>,
        /// Isolation branch (`kata/<slug>-<id>`) — present only when isolated.
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        files: Vec<DiffFile>,
        insertions: u32,
        deletions: u32,
        /// Changeset partitioned by file extension, sorted by `file_type`.
        /// A partition of the totals above: summing `by_type[*].insertions`
        /// equals `insertions` (same for deletions). `#[serde(default)]` so a
        /// pre-enhancement `run.diff` transcript line still deserializes (as []).
        #[serde(default)]
        by_type: Vec<DiffTypeStat>,
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
    /// A tool call is paused on the operator's decision. Emitted under
    /// `[permissions] mode = "prompt"` with `unmatched = "ask"` for a call no
    /// rule resolved, and under `mode = "auto"` for a call a `permissions.ask`
    /// rule matched — the exact analogue of `ask.requested`. The run stays
    /// paused until the matching `permission.decided`.
    #[serde(rename = "permission.requested")]
    PermissionRequested {
        id: String,
        /// The tool claude wants to use, e.g. `Bash` or `mcp__github__list_issues`.
        tool: String,
        /// The call's target rendered for a human: the shell command, the file
        /// path, the query — whatever the decision actually turns on.
        input_summary: String,
    },
    /// How a permission check was resolved. Emitted only for a check that
    /// reaches Kata's own tool: the `unmatched` policy, the operator, or one of
    /// Kata's own bridge tools. A call claude's settings (or its built-in
    /// read-only auto-approve) resolve is never seen by Kata and gets no event,
    /// so the stream is not a complete audit trail of the agent's permission
    /// checks.
    #[serde(rename = "permission.decided")]
    PermissionDecided {
        /// Correlates with a preceding `permission.requested`, when there was one.
        id: String,
        tool: String,
        /// Same rendering as `permission.requested.input_summary`, repeated here
        /// so an auto-resolved check is legible on its own.
        input_summary: String,
        allow: bool,
        /// What resolved it: `unmatched-policy`, `operator`, or `engine` (one of
        /// Kata's own bridge tools, which are exempt from the rules). A rule can
        /// never appear here — the spec's `allow`/`deny` are enforced by claude
        /// from the generated settings file, and a call they resolve never
        /// reaches Kata. Treat an unrecognized value as "something else decided".
        decided_by: String,
        /// The reason handed back to claude on a denial.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "run.error")]
    RunError {
        message: String,
        exit_code: i32,
        /// Total cost claude reported, if a `result` line arrived. `None` when
        /// the leash killed the child before it could report (timeout, cancel,
        /// turn cap); present on the budget path (exit 122).
        cost_usd: Option<f64>,
        /// Wall-clock run duration in milliseconds. `#[serde(default)]` so a
        /// pre-1.1.0 transcript line that predates this field still deserializes
        /// (as 0) instead of being dropped from run history.
        #[serde(default)]
        duration_ms: u64,
    },
    #[serde(rename = "run.cancelled")]
    RunCancelled {
        exit_code: i32,
        /// Almost always `None`: a cancelled child is killed before it reports
        /// a cost. Kept for symmetry with the other terminal events.
        cost_usd: Option<f64>,
        /// Wall-clock run duration in milliseconds. `#[serde(default)]` so a
        /// pre-1.1.0 transcript line that predates this field still deserializes
        /// (as 0) instead of being dropped from run history.
        #[serde(default)]
        duration_ms: u64,
    },
}

/// One changed file in a run's changeset. Part of the `run.diff` event
/// payload; produced by `crate::changeset::diff_at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DiffFile {
    /// Git short status for the change: "A" | "M" | "D" | "R" | ...
    pub status: String,
    /// Path relative to the run's working directory (the worktree when isolated, the workdir otherwise).
    pub path: String,
}

/// Per-file-type slice of a run's changeset. Part of the `run.diff` payload.
/// `file_type` is a lowercased file extension; `""` means no extension.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DiffTypeStat {
    /// Lowercased file extension ("rs", "ts", "md"); "" for files with no
    /// extension (Makefile, LICENSE, .gitignore).
    pub file_type: String,
    /// Number of changed files of this type.
    pub files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// One question in an `ask.requested` batch. Part of the published event
/// schema (`schema/kata-events.schema.json`); the app's TS type is generated
/// from that schema, not hand-mirrored.
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

/// How Claude's start report described one tool server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpState {
    Connected,
    /// Anything Claude reported that is not a connection or a connection still
    /// being made: `failed`, `needs-auth`, `disabled`.
    Failed,
    /// Claude listed the server and was still connecting.
    Pending,
}

/// Claude's start report: the `system`/`init` line, reduced to what the given
/// view compares with what Kata passed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InitReport {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub output_style: Option<String>,
    pub skills: Vec<String>,
    /// Each plugin's `source` (`<name>@<marketplace>`, or `<name>@builtin`), or
    /// its `name` when it has none.
    pub plugins: Vec<String>,
    pub mcp_servers: Vec<(String, McpState)>,
}

/// A hook lifecycle line (`hook_started`, `hook_response`). Claude names the
/// hook by `hook_event` and `hook_name` (`UserPromptSubmit`, or
/// `PreToolUse:Bash` with its matcher); the command is not in the line, so
/// `command` is only set if a future Claude adds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookFired {
    pub event: String,
    pub name: String,
    pub command: Option<String>,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub events: Vec<KataEvent>,
    /// True on the first line of an assistant message. claude emits each content
    /// block (thinking, text, tool_use) as its own line sharing `message.id`, so
    /// one turn spans several lines; a line without an id counts as its own turn.
    pub starts_turn: bool,
    /// The message's `parent_tool_use_id`, when it came from inside a subagent.
    pub parent_id: Option<String>,
    pub result: Option<ResultPayload>,
    /// Claude's start report, on the `system`/`init` line. Produces no event.
    pub init: Option<InitReport>,
    /// A hook lifecycle line. Produces no event.
    pub hook: Option<HookFired>,
    /// True when the hook line is a `hook_started` line (not a `hook_response`).
    pub hook_started: bool,
}

/// Stateful translator for a `stream-json` line sequence. Holds the
/// `tool_use_id → tool name` map so `tool.result` events can be labelled with
/// the tool that produced them (Claude's `tool_result` carries only the id).
#[derive(Debug, Default)]
pub struct StreamParser {
    tool_names: HashMap<String, String>,
    /// Assistant `message.id`s already seen, so a message's later blocks do not
    /// start another turn. A set, not the last id: parallel subagents interleave.
    message_ids: HashSet<String>,
    full_payloads: bool,
}

impl StreamParser {
    /// `full_payloads` adds the raw `input` / `output` to tool events
    /// (`kata run --full-payloads`). `StreamParser::default()` leaves it off.
    pub fn new(full_payloads: bool) -> Self {
        Self {
            full_payloads,
            ..Self::default()
        }
    }

    pub fn push(&mut self, line: &str) -> Parsed {
        let mut out = Parsed::default();
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            return out;
        };
        // Set on every message claude emits from inside a subagent.
        let parent_id = v
            .get("parent_tool_use_id")
            .and_then(|p| p.as_str())
            .map(String::from);
        out.parent_id = parent_id.clone();
        match v.get("type").and_then(|t| t.as_str()) {
            Some("assistant") => {
                out.starts_turn = match v.pointer("/message/id").and_then(|i| i.as_str()) {
                    Some(id) => self.message_ids.insert(id.to_string()),
                    None => true,
                };
                if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                    for block in content {
                        match block.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                    out.events.push(KataEvent::AssistantText {
                                        text: t.to_string(),
                                        parent_id: parent_id.clone(),
                                    });
                                }
                            }
                            Some("tool_use") => {
                                let name = block
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let id = block.get("id").and_then(|i| i.as_str()).map(String::from);
                                // Record id → name for later tool_result correlation,
                                // even for ask_user (harmless; its result is suppressed).
                                if let Some(id) = &id {
                                    self.tool_names.insert(id.clone(), name.clone());
                                }
                                // Kata's own bridge tools surface as their own
                                // events (ask.* / permission.*), not stream rows;
                                // suppress their tool.use here.
                                if is_bridge_tool(&name) {
                                    continue;
                                }
                                let (input, truncated) = if self.full_payloads {
                                    capped_input(block.get("input"))
                                } else {
                                    (None, false)
                                };
                                out.events.push(KataEvent::ToolUse {
                                    name,
                                    input_summary: summarize_input(block.get("input")),
                                    id,
                                    parent_id: parent_id.clone(),
                                    input,
                                    truncated,
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
                            let id = block
                                .get("tool_use_id")
                                .and_then(|i| i.as_str())
                                .map(String::from);
                            let name = id
                                .as_deref()
                                .and_then(|id| self.tool_names.get(id))
                                .cloned()
                                .unwrap_or_default();
                            // Mirrors the tool_use suppression above: a bridge
                            // tool's result surfaces via `ask.answered` /
                            // `permission.decided`, not a stream row.
                            if is_bridge_tool(&name) {
                                continue;
                            }
                            let (output, truncated) = if self.full_payloads {
                                capped_output(block.get("content"))
                            } else {
                                (None, false)
                            };
                            out.events.push(KataEvent::ToolResult {
                                name,
                                ok,
                                summary: summarize_content(block.get("content")),
                                id,
                                parent_id: parent_id.clone(),
                                output,
                                truncated,
                            });
                        }
                    }
                }
            }
            Some("system") => match v.get("subtype").and_then(|s| s.as_str()) {
                Some("init") => out.init = Some(parse_init(&v)),
                Some(kind @ ("hook_started" | "hook_response")) => {
                    out.hook = parse_hook(&v);
                    out.hook_started = kind == "hook_started";
                }
                _ => {}
            },
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
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|s| s.as_str()).map(String::from)
}

fn parse_init(v: &serde_json::Value) -> InitReport {
    let strings = |key: &str| -> Vec<String> {
        v.get(key)
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    let plugins = v
        .get("plugins")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| str_field(p, "source").or_else(|| str_field(p, "name")))
                .collect()
        })
        .unwrap_or_default();
    let mcp_servers = v
        .get("mcp_servers")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let name = str_field(s, "name")?;
                    let state = match s.get("status").and_then(|t| t.as_str()) {
                        Some("connected") => McpState::Connected,
                        Some("pending") => McpState::Pending,
                        _ => McpState::Failed,
                    };
                    Some((name, state))
                })
                .collect()
        })
        .unwrap_or_default();
    InitReport {
        model: str_field(v, "model"),
        permission_mode: str_field(v, "permissionMode"),
        output_style: str_field(v, "output_style"),
        skills: strings("skills"),
        plugins,
        mcp_servers,
    }
}

fn parse_hook(v: &serde_json::Value) -> Option<HookFired> {
    let event = str_field(v, "hook_event")?;
    let name = str_field(v, "hook_name").unwrap_or_else(|| event.clone());
    Some(HookFired {
        event,
        name,
        command: str_field(v, "command"),
    })
}

/// Translate one line of Claude `stream-json` into normalized events.
/// Stateless convenience wrapper over [`StreamParser`]; a `tool.result` whose
/// `tool_use` arrived on an earlier line will have an empty `name` here — use
/// [`StreamParser`] across a stream to correlate. Defensive: unknown shapes
/// and malformed JSON yield an empty `Parsed`.
pub fn parse_stream_line(line: &str) -> Parsed {
    StreamParser::default().push(line)
}

/// True for a tool served by Kata's own `mcp-ask` bridge.
///
/// Matched on the `<server>__<tool>` suffix rather than the full
/// `mcp__kata-ask__…` name, because claude's namespacing prefix has changed
/// across versions — but the server segment is required. A bare `ask_user`
/// suffix would be enough for stream suppression, where a false positive only
/// hides a row; it is not enough for `run.rs`, which uses this to exempt Kata's
/// own tools from the permission rules, and there a third-party tool that
/// happened to end in `ask_user` would be silently auto-approved.
pub(crate) fn is_bridge_tool(name: &str) -> bool {
    name.ends_with("kata-ask__ask_user") || name.ends_with("kata-ask__approve_tool")
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

/// A `tool_result.content` as plain text. claude sends a string for most tools
/// and an array of content blocks for some (the subagent `Agent` tool). Text
/// blocks contribute their text; any other block a `[<type>]` placeholder.
pub(crate) fn flatten_content(content: Option<&serde_json::Value>) -> String {
    match content {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .map(|b| match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => b
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string(),
                Some(other) => format!("[{other}]"),
                None => b.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
    }
}

/// The raw input, or nothing (with `truncated`) when it is over the cap: a cut
/// JSON object would be invalid, so it is dropped whole.
fn capped_input(input: Option<&serde_json::Value>) -> (Option<serde_json::Value>, bool) {
    match input {
        None => (None, false),
        Some(v) if v.to_string().len() > PAYLOAD_CAP_BYTES => (None, true),
        Some(v) => (Some(v.clone()), false),
    }
}

fn capped_output(content: Option<&serde_json::Value>) -> (Option<String>, bool) {
    let text = flatten_content(content);
    if text.len() > PAYLOAD_CAP_BYTES {
        (Some(truncate(&text, PAYLOAD_CAP_BYTES)), true)
    } else {
        (Some(text), false)
    }
}

pub(crate) fn truncate(s: &str, max: usize) -> String {
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
    let mut parser = StreamParser::default();
    for line in reader.lines() {
        if cancel() {
            break;
        }
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let parsed = parser.push(&line);
        if parsed.starts_turn {
            turns += 1;
            emit(KataEvent::Turn {
                n: turns,
                parent_id: parsed.parent_id.clone(),
            });
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
        assert!(p.starts_turn);
        assert_eq!(
            p.events,
            vec![KataEvent::AssistantText {
                text: "hello".into(),
                parent_id: None,
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
                input_summary: "ls -la".into(),
                id: None,
                parent_id: None,
                input: None,
                truncated: false,
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
                summary: "3 failed".into(),
                id: None,
                parent_id: None,
                output: None,
                truncated: false,
            }]
        );
        assert!(!p.starts_turn);
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
        let p = parse_stream_line(r#"{"type":"system","subtype":"mystery"}"#);
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
    fn content_blocks_of_one_message_are_one_turn() {
        // Real claude 2.x shape: each content block is its own line, all sharing
        // message.id, and a redacted thinking block comes first with no text.
        let input = concat!(
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"thinking","thinking":"","signature":"s"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"m2","content":[{"type":"thinking","thinking":"","signature":"s"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"done"}]}}"#,
            "\n",
        );
        let mut events = Vec::new();
        pump(Cursor::new(input), &|| false, &mut |e| events.push(e));
        let turns: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, KataEvent::Turn { .. }))
            .collect();
        assert_eq!(
            turns,
            vec![
                &KataEvent::Turn {
                    n: 1,
                    parent_id: None
                },
                &KataEvent::Turn {
                    n: 2,
                    parent_id: None
                },
            ]
        );
        // The turn marker lands before the first block, so the thinking line opens it.
        assert_eq!(events[0], *turns[0]);
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
        assert!(events.contains(&KataEvent::Turn {
            n: 1,
            parent_id: None
        }));
        assert!(events.contains(&KataEvent::Turn {
            n: 2,
            parent_id: None
        }));
        assert!(events.contains(&KataEvent::AssistantText {
            text: "a".into(),
            parent_id: None
        }));
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
    fn permission_events_serialize_with_their_tags() {
        let req = KataEvent::PermissionRequested {
            id: "p1".into(),
            tool: "Bash".into(),
            input_summary: "rm -rf build/".into(),
        };
        let s = serde_json::to_string(&req).unwrap();
        assert!(s.contains(r#""type":"permission.requested""#));
        assert!(s.contains(r#""tool":"Bash""#));
        assert!(s.contains("rm -rf build/"));

        let decided = KataEvent::PermissionDecided {
            id: "p1".into(),
            tool: "Bash".into(),
            input_summary: "rm -rf build/".into(),
            allow: false,
            decided_by: "deny-rule".into(),
            message: Some("matched permissions.deny".into()),
        };
        let s = serde_json::to_string(&decided).unwrap();
        assert!(s.contains(r#""type":"permission.decided""#));
        assert!(s.contains(r#""allow":false"#));
        assert!(s.contains(r#""decided_by":"deny-rule""#));

        // An allow carries no message, and must not serialize a null one.
        let allowed = KataEvent::PermissionDecided {
            id: "p2".into(),
            tool: "Read".into(),
            input_summary: "/etc/hosts".into(),
            allow: true,
            decided_by: "allow-rule".into(),
            message: None,
        };
        let s = serde_json::to_string(&allowed).unwrap();
        assert!(
            !s.contains("message"),
            "absent message must be omitted: {s}"
        );
    }

    #[test]
    fn permission_events_round_trip() {
        for ev in [
            KataEvent::PermissionRequested {
                id: "p1".into(),
                tool: "Bash".into(),
                input_summary: "ls".into(),
            },
            KataEvent::PermissionDecided {
                id: "p1".into(),
                tool: "Bash".into(),
                input_summary: "ls".into(),
                allow: true,
                decided_by: "operator".into(),
                message: None,
            },
        ] {
            let json = serde_json::to_string(&ev).unwrap();
            let back: KataEvent = serde_json::from_str(&json).unwrap();
            assert_eq!(ev, back, "round-trip mismatch for {json}");
        }
    }

    // Claude invokes the permission prompt tool itself; if a version of it ever
    // surfaces in the stream, it must not render as an ordinary tool row —
    // permission.* events already tell that story.
    #[test]
    fn approve_tool_calls_are_suppressed_from_the_stream() {
        let mut p = StreamParser::default();
        let use_line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_a","name":"mcp__kata-ask__approve_tool","input":{"tool_name":"Bash"}}]}}"#;
        let res_line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_a","content":"allowed","is_error":false}]}}"#;
        assert!(p.push(use_line).events.is_empty());
        assert!(p.push(res_line).events.is_empty());
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

    // The exemption in run.rs turns on this predicate, so a lookalike from a
    // third-party MCP server must not match it.
    #[test]
    fn only_katas_own_server_counts_as_a_bridge_tool() {
        assert!(is_bridge_tool("mcp__kata-ask__ask_user"));
        assert!(is_bridge_tool("mcp__kata-ask__approve_tool"));
        assert!(!is_bridge_tool("mcp__helpful-bot__ask_user"));
        assert!(!is_bridge_tool("ask_user"));
        assert!(!is_bridge_tool("Bash"));
    }

    #[test]
    fn ask_user_tool_use_is_suppressed_from_the_stream() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__kata-ask__ask_user","input":{"questions":[]}}]}}"#;
        let p = parse_stream_line(line);
        assert!(p.starts_turn, "still counts as an assistant turn");
        assert!(
            p.events.is_empty(),
            "the ask_user tool.use must not render as a row"
        );
    }

    #[test]
    fn stream_parser_suppresses_ask_user_tool_result() {
        let mut p = StreamParser::default();
        // Real interactive shape: the ask_user tool_use carries an id...
        let use_line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_ask","name":"mcp__kata-ask__ask_user","input":{"questions":[]}}]}}"#;
        // ...and its tool_result references that id.
        let res_line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_ask","content":"answered","is_error":false}]}}"#;

        let used = p.push(use_line);
        assert!(used.starts_turn, "still counts as an assistant turn");
        assert!(
            used.events.is_empty(),
            "ask_user tool.use must not render a row"
        );

        let result = p.push(res_line);
        assert!(
            result.events.is_empty(),
            "ask_user tool.result must not render a row either (answer surfaces via ask.answered)"
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
        assert!(
            dump.contains("run.started"),
            "tag rename must survive: {dump}"
        );
        assert!(dump.contains("ask.requested"));
        assert!(dump.contains("permission.requested"));
        assert!(dump.contains("permission.decided"));
        assert!(dump.contains("tool.result"));
    }

    #[test]
    fn terminal_events_deserialize_without_duration_ms_from_old_transcripts() {
        // Pre-1.1.0 run.error / run.cancelled lines lack duration_ms; they must
        // still parse (duration_ms defaults to 0) so old history is not dropped.
        let err: KataEvent =
            serde_json::from_str(r#"{"type":"run.error","message":"boom","exit_code":124}"#)
                .unwrap();
        assert!(matches!(
            err,
            KataEvent::RunError {
                duration_ms: 0,
                cost_usd: None,
                exit_code: 124,
                ..
            }
        ));
        let cancelled: KataEvent =
            serde_json::from_str(r#"{"type":"run.cancelled","exit_code":130}"#).unwrap();
        assert!(matches!(
            cancelled,
            KataEvent::RunCancelled {
                duration_ms: 0,
                cost_usd: None,
                exit_code: 130
            }
        ));
    }

    #[test]
    fn terminal_events_carry_cost_duration_and_round_trip() {
        let cases = [
            KataEvent::RunError {
                message: "reached max turns (12)".into(),
                exit_code: 125,
                cost_usd: None,
                duration_ms: 4200,
            },
            KataEvent::RunCancelled {
                exit_code: 130,
                cost_usd: None,
                duration_ms: 300,
            },
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
        // The budget-exhaustion path is the one run.error that carries a real cost.
        let s = serde_json::to_string(&KataEvent::RunError {
            message: "budget ceiling $0.01 reached; spent $0.13".into(),
            exit_code: 122,
            cost_usd: Some(0.13),
            duration_ms: 900,
        })
        .unwrap();
        assert!(
            s.contains(r#""cost_usd":0.13"#),
            "budget error carries cost: {s}"
        );
        assert!(s.contains(r#""duration_ms":900"#));
        // A killed run's cancel serializes duration and a null cost.
        let c = serde_json::to_string(&KataEvent::RunCancelled {
            exit_code: 130,
            cost_usd: None,
            duration_ms: 300,
        })
        .unwrap();
        assert!(
            c.contains(r#""exit_code":130"#),
            "cancel must serialize its code: {c}"
        );
        assert!(
            c.contains(r#""cost_usd":null"#),
            "cancel serializes null cost: {c}"
        );
        assert!(c.contains(r#""duration_ms":300"#));
    }

    #[test]
    fn run_diff_omits_worktree_and_branch_when_none() {
        // Non-worktree run: no worktree/branch, still a full changeset.
        let e = KataEvent::RunDiff {
            worktree: None,
            branch: None,
            files: vec![DiffFile {
                status: "M".into(),
                path: "src/run.rs".into(),
            }],
            insertions: 3,
            deletions: 1,
            by_type: vec![],
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""type":"run.diff""#));
        assert!(
            !s.contains("worktree"),
            "absent worktree must not serialize: {s}"
        );
        assert!(
            !s.contains("branch"),
            "absent branch must not serialize: {s}"
        );
        assert!(s.contains(r#""status":"M""#));
        assert!(s.contains(r#""insertions":3"#));
        assert!(s.contains(r#""deletions":1"#));

        // Worktree run: both present.
        let w = KataEvent::RunDiff {
            worktree: Some("/home/u/.kata/worktrees/spec-abc".into()),
            branch: Some("kata/spec-abc".into()),
            files: vec![],
            insertions: 0,
            deletions: 0,
            by_type: vec![],
        };
        let ws = serde_json::to_string(&w).unwrap();
        assert!(
            ws.contains(r#""branch":"kata/spec-abc""#),
            "worktree run keeps branch: {ws}"
        );
    }

    #[test]
    fn run_diff_by_type_round_trips_and_defaults_when_absent() {
        // A pre-enhancement run.diff line (no by_type) still parses, as [].
        let old: KataEvent =
            serde_json::from_str(r#"{"type":"run.diff","files":[],"insertions":0,"deletions":0}"#)
                .unwrap();
        assert!(matches!(old, KataEvent::RunDiff { ref by_type, .. } if by_type.is_empty()));

        // A populated by_type round-trips.
        let ev = KataEvent::RunDiff {
            worktree: None,
            branch: None,
            files: vec![DiffFile {
                status: "A".into(),
                path: "src/x.rs".into(),
            }],
            insertions: 5,
            deletions: 0,
            by_type: vec![DiffTypeStat {
                file_type: "rs".into(),
                files: 1,
                insertions: 5,
                deletions: 0,
            }],
        };
        let back: KataEvent = serde_json::from_str(&serde_json::to_string(&ev).unwrap()).unwrap();
        assert_eq!(ev, back);
    }

    #[test]
    fn stream_parser_correlates_tool_result_name() {
        let mut p = StreamParser::default();
        let use_line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}"#;
        let res_line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok","is_error":false}]}}"#;

        let _ = p.push(use_line);
        let parsed = p.push(res_line);

        assert_eq!(
            parsed.events,
            vec![KataEvent::ToolResult {
                name: "Bash".into(),
                ok: true,
                summary: "ok".into(),
                id: Some("toolu_1".into()),
                parent_id: None,
                output: None,
                truncated: false,
            }]
        );
    }

    #[test]
    fn stream_parser_leaves_name_empty_when_uncorrelated() {
        // A result whose tool_use was never seen keeps an empty name (no panic).
        let mut p = StreamParser::default();
        let res_line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"ok","is_error":false}]}}"#;
        let parsed = p.push(res_line);
        assert_eq!(
            parsed.events[0],
            KataEvent::ToolResult {
                name: String::new(),
                ok: true,
                summary: "ok".into(),
                id: Some("toolu_x".into()),
                parent_id: None,
                output: None,
                truncated: false,
            }
        );
    }

    #[test]
    fn pump_labels_tool_results_across_lines() {
        let input = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Read","input":{"command":"cat x"}}]}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"data","is_error":false}]}}"#,
            "\n",
        );
        let mut events = Vec::new();
        let _ = pump(Cursor::new(input), &|| false, &mut |e| events.push(e));
        assert!(events.contains(&KataEvent::ToolResult {
            name: "Read".into(),
            ok: true,
            summary: "data".into(),
            id: Some("toolu_9".into()),
            parent_id: None,
            output: None,
            truncated: false,
        }));
    }

    #[cfg(feature = "schema")]
    #[test]
    fn schema_artifact_is_fresh() {
        let generated = super::generate_schema_json();
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../schema/kata-events.schema.json"
        );
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

    const PARALLEL_USE: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.rs"}},{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"b.rs"}},{"type":"tool_use","id":"t3","name":"Grep","input":{"pattern":"x"}}]}}"#;
    const PARALLEL_RESULTS: &str = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t3","content":"m"},{"type":"tool_result","tool_use_id":"t1","content":"1\thello"},{"type":"tool_result","tool_use_id":"t2","content":"2\tbye"}]}}"#;

    fn results(events: &[KataEvent]) -> Vec<(Option<String>, String)> {
        events
            .iter()
            .filter_map(|e| match e {
                KataEvent::ToolResult { id, name, .. } => Some((id.clone(), name.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn parallel_calls_pair_by_id() {
        let mut p = StreamParser::default();
        let uses = p.push(PARALLEL_USE).events;
        let ids: Vec<_> = uses
            .iter()
            .filter_map(|e| match e {
                KataEvent::ToolUse { id, .. } => id.clone(),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec!["t1", "t2", "t3"]);
        let res = p.push(PARALLEL_RESULTS).events;
        assert_eq!(
            results(&res),
            vec![
                (Some("t3".into()), "Grep".into()),
                (Some("t1".into()), "Read".into()),
                (Some("t2".into()), "Read".into()),
            ]
        );
    }

    #[test]
    fn payloads_absent_without_the_flag() {
        let mut p = StreamParser::default();
        let mut events = p.push(PARALLEL_USE).events;
        events.extend(p.push(PARALLEL_RESULTS).events);
        for e in &events {
            match e {
                KataEvent::ToolUse {
                    input,
                    truncated,
                    id,
                    ..
                } => {
                    assert!(input.is_none());
                    assert!(!truncated);
                    assert!(id.is_some(), "id is emitted on every run");
                }
                KataEvent::ToolResult {
                    output,
                    truncated,
                    id,
                    ..
                } => {
                    assert!(output.is_none());
                    assert!(!truncated);
                    assert!(id.is_some());
                }
                _ => {}
            }
        }
    }

    #[test]
    fn payloads_present_with_the_flag() {
        let mut p = StreamParser::new(true);
        let uses = p.push(PARALLEL_USE).events;
        match &uses[0] {
            KataEvent::ToolUse { input, .. } => {
                assert_eq!(
                    input.as_ref().unwrap(),
                    &serde_json::json!({"file_path": "a.rs"})
                )
            }
            other => panic!("expected tool.use, got {other:?}"),
        }
        let res = p.push(PARALLEL_RESULTS).events;
        match &res[1] {
            KataEvent::ToolResult {
                output, truncated, ..
            } => {
                assert_eq!(output.as_deref(), Some("1\thello"));
                assert!(!truncated);
            }
            other => panic!("expected tool.result, got {other:?}"),
        }
    }

    #[test]
    fn oversized_output_is_cut_on_a_char_boundary() {
        let mut p = StreamParser::new(true);
        p.push(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}"#);
        let big = "é".repeat(PAYLOAD_CAP_BYTES); // 2 bytes each: twice the cap
        let line = serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":big}]}}).to_string();
        match &p.push(&line).events[0] {
            KataEvent::ToolResult {
                output, truncated, ..
            } => {
                let out = output.as_ref().unwrap();
                assert!(*truncated);
                assert!(
                    out.len() <= PAYLOAD_CAP_BYTES + 3,
                    "cap plus the ... suffix"
                );
                assert!(out.ends_with("..."));
            }
            other => panic!("expected tool.result, got {other:?}"),
        }
    }

    #[test]
    fn oversized_input_is_omitted_not_cut() {
        let mut p = StreamParser::new(true);
        let line = serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"content":"x".repeat(PAYLOAD_CAP_BYTES + 1)}}]}}).to_string();
        match &p.push(&line).events[0] {
            KataEvent::ToolUse {
                input,
                truncated,
                input_summary,
                ..
            } => {
                assert!(input.is_none(), "a cut JSON object would be invalid");
                assert!(*truncated);
                assert!(!input_summary.is_empty(), "the summary still renders");
            }
            other => panic!("expected tool.use, got {other:?}"),
        }
    }

    #[test]
    fn string_and_block_array_content_flatten_alike() {
        let s = serde_json::json!("a\nb");
        let blocks = serde_json::json!([{"type":"text","text":"a"},{"type":"text","text":"b"}]);
        assert_eq!(flatten_content(Some(&s)), flatten_content(Some(&blocks)));
        let with_image =
            serde_json::json!([{"type":"text","text":"a"},{"type":"image","source":{}}]);
        assert_eq!(flatten_content(Some(&with_image)), "a\n[image]");
        assert_eq!(flatten_content(None), "");
    }

    #[test]
    fn parent_id_marks_subagent_messages_only() {
        let mut p = StreamParser::default();
        let top = p.push(r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"A","name":"Agent","input":{"prompt":"p"}}]}}"#);
        let inner_use = p.push(r#"{"type":"assistant","parent_tool_use_id":"A","message":{"content":[{"type":"text","text":"looking"},{"type":"tool_use","id":"B","name":"Read","input":{"file_path":"x"}}]}}"#);
        let inner_res = p.push(r#"{"type":"user","parent_tool_use_id":"A","message":{"content":[{"type":"tool_result","tool_use_id":"B","content":"1\thi"}]}}"#);
        assert!(matches!(
            &top.events[0],
            KataEvent::ToolUse {
                parent_id: None,
                ..
            }
        ));
        assert!(
            matches!(&inner_use.events[0], KataEvent::AssistantText { parent_id: Some(p), .. } if p == "A")
        );
        assert!(
            matches!(&inner_use.events[1], KataEvent::ToolUse { parent_id: Some(p), .. } if p == "A")
        );
        assert!(
            matches!(&inner_res.events[0], KataEvent::ToolResult { parent_id: Some(p), name, .. } if p == "A" && name == "Read")
        );
    }

    #[test]
    fn pump_stamps_a_subagent_turn_with_its_parent() {
        let input = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"top"}]}}"#,
            "
",
            r#"{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"text","text":"inner"}]}}"#,
            "
",
        );
        let mut events = Vec::new();
        pump(std::io::Cursor::new(input), &|| false, &mut |e| {
            events.push(e)
        });
        assert!(events.contains(&KataEvent::Turn {
            n: 1,
            parent_id: None
        }));
        assert!(events.contains(&KataEvent::Turn {
            n: 2,
            parent_id: Some("toolu_A".into())
        }));
    }

    #[test]
    fn transcripts_written_before_the_new_fields_still_load() {
        let u: KataEvent =
            serde_json::from_str(r#"{"type":"tool.use","name":"Bash","input_summary":"ls"}"#)
                .unwrap();
        assert!(matches!(
            u,
            KataEvent::ToolUse {
                id: None,
                parent_id: None,
                input: None,
                truncated: false,
                ..
            }
        ));
        let r: KataEvent =
            serde_json::from_str(r#"{"type":"tool.result","name":"Bash","ok":true,"summary":"s"}"#)
                .unwrap();
        assert!(matches!(
            r,
            KataEvent::ToolResult {
                id: None,
                output: None,
                truncated: false,
                ..
            }
        ));
        let t: KataEvent =
            serde_json::from_str(r#"{"type":"assistant.text","text":"hi"}"#).unwrap();
        assert!(matches!(
            t,
            KataEvent::AssistantText {
                parent_id: None,
                ..
            }
        ));
    }

    #[test]
    fn absent_fields_are_not_serialized() {
        let v = serde_json::to_value(KataEvent::ToolUse {
            name: "Bash".into(),
            input_summary: "ls".into(),
            id: None,
            parent_id: None,
            input: None,
            truncated: false,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"type":"tool.use","name":"Bash","input_summary":"ls"})
        );
    }

    fn fixture_line(name: &str) -> String {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn the_start_report_is_read_from_the_captured_init_line() {
        let one_line: serde_json::Value =
            serde_json::from_str(&fixture_line("claude-init.json")).unwrap();
        let p = parse_stream_line(&one_line.to_string());
        assert!(p.events.is_empty(), "the init line makes no stream event");
        assert!(p.hook.is_none() && p.result.is_none());
        let init = p.init.expect("init report");
        assert_eq!(init.model.as_deref(), Some("claude-haiku-5-5"));
        assert_eq!(init.permission_mode.as_deref(), Some("bypassPermissions"));
        assert_eq!(init.output_style.as_deref(), Some("Explanatory"));
        assert!(init
            .skills
            .contains(&"superpowers:brainstorming".to_string()));
        assert!(init.skills.contains(&"projskill".to_string()));
        assert!(init
            .plugins
            .contains(&"superpowers@claude-plugins-official".to_string()));
        assert!(init
            .plugins
            .contains(&"cc-plugin-telemetry@builtin".to_string()));
        let state = |n: &str| {
            init.mcp_servers
                .iter()
                .find(|(s, _)| s == n)
                .map(|(_, st)| *st)
        };
        assert_eq!(state("srv-a"), Some(McpState::Connected));
        assert_eq!(state("plugin:design:gmail"), Some(McpState::Failed));
        assert_eq!(state("plugin:design:slack"), Some(McpState::Failed));
    }

    #[test]
    fn a_hook_lifecycle_line_is_read_and_makes_no_stream_event() {
        for line in fixture_line("claude-hook-events.jsonl").lines() {
            let p = parse_stream_line(line);
            assert!(p.events.is_empty() && p.init.is_none());
            let h = p.hook.expect("hook line");
            assert_eq!(h.event, "UserPromptSubmit");
            assert_eq!(h.name, "UserPromptSubmit");
            assert_eq!(h.command, None);
        }
        let p = parse_stream_line(
            r#"{"type":"system","subtype":"hook_response","hook_event":"PreToolUse","hook_name":"PreToolUse:Bash","hook_id":"h"}"#,
        );
        assert_eq!(p.hook.unwrap().name, "PreToolUse:Bash");
    }
}
