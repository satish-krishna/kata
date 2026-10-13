# Tool Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every tool call in the Workbench as an expandable rail row (diffs for edits, output for reads, checklists for todos, nested calls for subagents), backed by four new optional fields on the event protocol.

**Architecture:** The engine's `StreamParser` starts emitting claude's `tool_use_id` as `id` and `parent_tool_use_id` as `parent_id` on every run, plus raw `input`/`output` when `kata run --full-payloads` is passed. The Workbench always passes that flag. A pure TypeScript function pairs `tool.use` with `tool.result` by `id` and nests subagent calls by `parent_id`; Svelte components render the pairs as rail rows.

**Tech Stack:** Rust (kata-core, kata-cli, serde, schemars), Svelte 5 runes, TypeScript, Vitest + @testing-library/svelte, the `diff` npm package (v9, ships its own types).

**Spec:** `docs/superpowers/specs/2026-10-12-tool-cards-design.md`

## Global Constraints

- `protocolVersion` stays at **1**. Every new field is optional with `#[serde(default)]`.
- Payload cap: **256 KB** per field (`256 * 1024` bytes), constant `PAYLOAD_CAP_BYTES`.
- The flag is `kata run --full-payloads`. It is never a run-spec field.
- Status labels are exactly `ok`, `error`, `running…`. No `exit N`.
- Diffs carry no line numbers.
- The subagent tool is matched as both `Agent` and `Task`.
- Nesting depth is exactly one level.
- Workbench styles: CSS custom properties only, never a hex literal (`app/CLAUDE.md`). Icons from `@lucide/svelte/icons/*`.
- Existing exit codes, event type tags, and field names are untouched.
- US English in code comments and docs. Markdown has no hard wraps.
- Gates: `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, `cargo build --locked`, `npm run check` (0 errors), `npm test`.

## Review Focus

1. **A pause that happens mid-call.** An `ask.requested` or `permission.requested` arriving between a `tool.use` and its `tool.result` must render right after that call's row, not at the end of the stream and not swallowed into a nested body. Pinned in Task 4 (`withPauses` tests).
2. **A run without `--full-payloads` replayed in history.** Events have `id` but no `input`/`output`. Rows must still render with the summaries in their bodies, and an `Agent` row must still nest its children. Pinned in Task 4 (`rendererFor` without input) and Task 5 (summary-only body test).
3. **A call that is still running when the run is cancelled.** Its row stays `running…` forever; it must not crash or vanish. Pinned in Task 4 (`statusOf` running test) and Task 5 (running row render test).
4. **A failed Edit.** The diff still renders and the error output appears below it, and the row starts open. Pinned in Task 5.
5. **Tool results with no name today.** The engine's live loop parses each stdout line with a fresh, stateless parser (`run.rs`, `parse_stream_line`), so every real `tool.result` currently carries `name: ""` and Kata's own `ask_user` result leaks into the stream as an unnamed row. Pairing by `id` would mask this, so it is pinned directly in Task 2 (`tool.result` for `Read` carries `name: "Read"`).

---

### Task 1: Protocol fields and the stream parser

**Model:** Sonnet (judgment needed updating existing test expectations).

**Files:**
- Modify: `crates/kata-core/src/event.rs` (enum `KataEvent` at the top, `StreamParser` around line 232, helpers after `summarize_content`, tests module)
- Modify: `crates/kata-core/tests/run_it.rs` (the 2 `KataEvent::AssistantText { text }` destructuring patterns, lines ~323 and ~1061)
- Regenerate: `schema/kata-events.schema.json`, `app/src/bindings/kata-events.ts`
- Modify: `docs/consuming-kata.md:78-80`

**Interfaces:**
- Produces: `KataEvent::AssistantText { text, parent_id: Option<String> }`; `KataEvent::ToolUse { name, input_summary, id: Option<String>, parent_id: Option<String>, input: Option<serde_json::Value>, truncated: bool }`; `KataEvent::ToolResult { name, ok, summary, id: Option<String>, parent_id: Option<String>, output: Option<String>, truncated: bool }`; `pub const PAYLOAD_CAP_BYTES: usize`; `StreamParser::new(full_payloads: bool) -> StreamParser` (and `StreamParser::default()` keeps `full_payloads = false`).
- TypeScript (generated): `tool.use` gains `id?: string; parent_id?: string; input?: unknown; truncated?: boolean`; `tool.result` gains `id?: string; parent_id?: string; output?: string; truncated?: boolean`; `assistant.text` gains `parent_id?: string`.

- [ ] **Step 1: Write the failing tests**

Append to the `#[cfg(test)] mod tests` in `crates/kata-core/src/event.rs`:

```rust
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
                KataEvent::ToolUse { input, truncated, id, .. } => {
                    assert!(input.is_none());
                    assert!(!truncated);
                    assert!(id.is_some(), "id is emitted on every run");
                }
                KataEvent::ToolResult { output, truncated, id, .. } => {
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
                assert_eq!(input.as_ref().unwrap(), &serde_json::json!({"file_path": "a.rs"}))
            }
            other => panic!("expected tool.use, got {other:?}"),
        }
        let res = p.push(PARALLEL_RESULTS).events;
        match &res[1] {
            KataEvent::ToolResult { output, truncated, .. } => {
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
            KataEvent::ToolResult { output, truncated, .. } => {
                let out = output.as_ref().unwrap();
                assert!(*truncated);
                assert!(out.len() <= PAYLOAD_CAP_BYTES + 3, "cap plus the ... suffix");
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
            KataEvent::ToolUse { input, truncated, input_summary, .. } => {
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
        let with_image = serde_json::json!([{"type":"text","text":"a"},{"type":"image","source":{}}]);
        assert_eq!(flatten_content(Some(&with_image)), "a\n[image]");
        assert_eq!(flatten_content(None), "");
    }

    #[test]
    fn parent_id_marks_subagent_messages_only() {
        let mut p = StreamParser::default();
        let top = p.push(r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"A","name":"Agent","input":{"prompt":"p"}}]}}"#);
        let inner_use = p.push(r#"{"type":"assistant","parent_tool_use_id":"A","message":{"content":[{"type":"text","text":"looking"},{"type":"tool_use","id":"B","name":"Read","input":{"file_path":"x"}}]}}"#);
        let inner_res = p.push(r#"{"type":"user","parent_tool_use_id":"A","message":{"content":[{"type":"tool_result","tool_use_id":"B","content":"1\thi"}]}}"#);
        assert!(matches!(&top.events[0], KataEvent::ToolUse { parent_id: None, .. }));
        assert!(matches!(&inner_use.events[0], KataEvent::AssistantText { parent_id: Some(p), .. } if p == "A"));
        assert!(matches!(&inner_use.events[1], KataEvent::ToolUse { parent_id: Some(p), .. } if p == "A"));
        assert!(matches!(&inner_res.events[0], KataEvent::ToolResult { parent_id: Some(p), name, .. } if p == "A" && name == "Read"));
    }

    #[test]
    fn transcripts_written_before_the_new_fields_still_load() {
        let u: KataEvent = serde_json::from_str(r#"{"type":"tool.use","name":"Bash","input_summary":"ls"}"#).unwrap();
        assert!(matches!(u, KataEvent::ToolUse { id: None, parent_id: None, input: None, truncated: false, .. }));
        let r: KataEvent = serde_json::from_str(r#"{"type":"tool.result","name":"Bash","ok":true,"summary":"s"}"#).unwrap();
        assert!(matches!(r, KataEvent::ToolResult { id: None, output: None, truncated: false, .. }));
        let t: KataEvent = serde_json::from_str(r#"{"type":"assistant.text","text":"hi"}"#).unwrap();
        assert!(matches!(t, KataEvent::AssistantText { parent_id: None, .. }));
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
        assert_eq!(v, serde_json::json!({"type":"tool.use","name":"Bash","input_summary":"ls"}));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kata-core --lib event::`
Expected: compile errors (`no field id`, `no function new`, `flatten_content not found`, `PAYLOAD_CAP_BYTES not found`).

- [ ] **Step 3: Add the fields**

In `crates/kata-core/src/event.rs`, add below `KATA_EVENT_PROTOCOL_VERSION`:

```rust
/// Per-field ceiling for `tool.use.input` (serialized) and `tool.result.output`
/// under `kata run --full-payloads`. Keeps one accidental `cat` of a minified
/// bundle from reaching the webview as a multi-megabyte DOM node.
pub const PAYLOAD_CAP_BYTES: usize = 256 * 1024;

fn is_false(b: &bool) -> bool {
    !*b
}
```

Replace the three variants:

```rust
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
```

- [ ] **Step 4: Teach the parser the new fields**

Replace the `StreamParser` struct and the start of its `impl`:

```rust
#[derive(Debug, Default)]
pub struct StreamParser {
    tool_names: HashMap<String, String>,
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
```

In the `Some("text")` arm, construct `KataEvent::AssistantText { text: t.to_string(), parent_id: parent_id.clone() }`.

Replace the `Some("tool_use")` arm body with:

```rust
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
```

Replace the body of the `tool_result` branch in the `Some("user")` arm with:

```rust
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
```

Add after `summarize_content`:

```rust
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
```

- [ ] **Step 5: Fix the existing constructors and patterns**

Every existing `KataEvent::ToolUse { .. }`, `KataEvent::ToolResult { .. }`, and `KataEvent::AssistantText { .. }` *construction* in `event.rs` tests now needs the new fields, and every destructuring *pattern* that lists fields without `..` needs a trailing `..`. Add `id: None, parent_id: None, input: None, truncated: false` (ToolUse), `id: None, parent_id: None, output: None, truncated: false` (ToolResult), `parent_id: None` (AssistantText). Where the test's input line carries a `tool_use` `"id"` or a `tool_result` `"tool_use_id"`, the expected event now has `id: Some("<that id>".into())` instead of `None`: read each fixture line and set it to match. Do not change what any test asserts beyond these fields.

In `crates/kata-core/tests/run_it.rs`, change both `KataEvent::AssistantText { text } => Some(text.clone())` patterns to `KataEvent::AssistantText { text, .. } => Some(text.clone())`.

- [ ] **Step 6: Run the engine tests**

Run: `cargo test -p kata-core -p kata-cli`
Expected: all pass, including the 9 new tests. The three goldens in `crates/kata-cli/tests/golden/` must pass unchanged: the fake's `ok` mode sends no `id`, so no new key appears. If a golden fails, stop and report it rather than re-blessing.

- [ ] **Step 7: Regenerate the schema and the TypeScript types**

```bash
KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema schema_artifact_is_fresh
cd app && npm run gen:events && cd ..
```

Expected: `schema/kata-events.schema.json` and `app/src/bindings/kata-events.ts` change; `git diff app/src/bindings/kata-events.ts` shows the new optional fields on the three event types and nothing else. Then `cd app && npm run check` must report 0 errors.

- [ ] **Step 8: Document the fields**

In `docs/consuming-kata.md`, replace rows 78-80 with:

```markdown
| `assistant.text` | `text`, `parent_id?` | A chunk of the agent's assistant-visible text. `parent_id` is the `id` of the subagent call it was written inside; absent at the top level. |
| `tool.use` | `name`, `input_summary`, `id?`, `parent_id?`, `input?`, `truncated?` | The agent invoked a tool. `id` is claude's `tool_use_id`, emitted on every run; pair it with the `tool.result` carrying the same `id`. `input` (the raw tool input) is present only under `kata run --full-payloads`, and is omitted with `truncated: true` when its JSON exceeds 256 KB. |
| `tool.result` | `name`, `ok`, `summary`, `id?`, `parent_id?`, `output?`, `truncated?` | A tool returned. `ok` is false on tool error. `id` matches the `tool.use` it answers. `output` (the result flattened to text) is present only under `kata run --full-payloads`, cut at 256 KB with `truncated: true`. |
```

- [ ] **Step 9: Commit**

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
git add crates/kata-core/src/event.rs crates/kata-core/tests/run_it.rs schema/kata-events.schema.json app/src/bindings/kata-events.ts docs/consuming-kata.md
git commit -m "feat(events): id, parent_id, and opt-in payloads on tool events"
```

---

### Task 2: Wire the parser into the run loop, and the `subagent` fake

**Model:** Sonnet (restructuring `run` into `run_with` without changing behavior).

**Files:**
- Modify: `crates/kata-core/src/run.rs` (`pub fn run` at line ~226; the stream loop at line ~710)
- Modify: `crates/kata-core/src/bin/fake-claude.rs` (doc comment line 4; new match arm)
- Test: `crates/kata-core/tests/run_it.rs`

**Interfaces:**
- Consumes: `StreamParser::new(bool)`, the new event fields (Task 1).
- Produces: `pub struct RunOptions { pub full_payloads: bool }` (`Debug, Clone, Copy, Default`); `pub fn run_with<F: FnMut(KataEvent)>(spec: &RunSpec, catalog: &[CatalogEntry], cancel: &CancelToken, answers: &AnswerRx, decisions: &DecisionRx, opts: RunOptions, emit: F) -> Result<RunOutcome, RunError>`. `run(...)` keeps its exact signature and calls `run_with` with `RunOptions::default()`. Fake mode `KATA_FAKE_MODE=subagent`.

- [ ] **Step 1: Add the `subagent` fake mode**

In `crates/kata-core/src/bin/fake-claude.rs`, add `| "subagent"` to the mode list in the line-4 doc comment, and add this arm before the `_ =>` fallback. It replays the shape captured from a real `claude` 2.1.296 run:

```rust
        "subagent" => {
            // One Agent call whose subagent reads a file, mirroring a real
            // claude 2.1.296 stream: inner messages carry parent_tool_use_id,
            // and the Agent result's content is an array of text blocks.
            for line in [
                r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_A","name":"Agent","input":{"description":"Read probe","subagent_type":"general-purpose","prompt":"Read probe.txt"}}]}}"#,
                r#"{"type":"user","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"text","text":"Read probe.txt"}]}}"#,
                r#"{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"text","text":"reading"},{"type":"tool_use","id":"toolu_B","name":"Read","input":{"file_path":"probe.txt"}}]}}"#,
                r#"{"type":"user","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_B","content":"1\thello"}]}}"#,
                r#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_A","content":[{"type":"text","text":"probe.txt says hello"}]}]}}"#,
                r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"done"}]}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":0.01,"result":"done"}"#,
            ] {
                let _ = writeln!(out, "{line}");
            }
            let _ = out.flush();
        }
```

- [ ] **Step 2: Write the failing tests**

In `crates/kata-core/tests/run_it.rs`, change the import to `use kata_core::run::{run, run_with, CancelToken, RunError, RunOptions};` and append:

```rust
fn run_subagent(opts: RunOptions) -> Vec<KataEvent> {
    with_fake("subagent");
    let work = tempfile::tempdir().unwrap();
    let mut events = Vec::new();
    let outcome = run_with(
        &base_spec(&work.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &CancelToken::new(),
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        opts,
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);
    events
}

#[test]
#[serial]
fn tool_results_carry_their_tool_name_ids_and_parent() {
    // Before this change the live loop parsed each line with a fresh parser,
    // so every tool.result had name "" in a real run.
    let events = run_subagent(RunOptions::default());
    let read_result = events
        .iter()
        .find_map(|e| match e {
            KataEvent::ToolResult { id, name, parent_id, output, .. } if id.as_deref() == Some("toolu_B") => {
                Some((name.clone(), parent_id.clone(), output.clone()))
            }
            _ => None,
        })
        .expect("a tool.result for the subagent's Read");
    assert_eq!(read_result, ("Read".into(), Some("toolu_A".into()), None));
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::ToolUse { name, parent_id: None, .. } if name == "Agent")));
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::AssistantText { text, parent_id: Some(p) } if text == "reading" && p == "toolu_A")));
}

#[test]
#[serial]
fn full_payloads_adds_input_and_output() {
    let events = run_subagent(RunOptions { full_payloads: true });
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::ToolUse { name, input: Some(i), .. }
            if name == "Read" && i == &serde_json::json!({"file_path": "probe.txt"}))));
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::ToolResult { name, output: Some(o), .. } if name == "Read" && o == "1\thello")));
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::ToolResult { name, output: Some(o), .. } if name == "Agent" && o == "probe.txt says hello")));
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p kata-core --test run_it subagent full_payloads tool_results_carry`
Expected: compile error, `run_with` and `RunOptions` not found.

- [ ] **Step 4: Add `RunOptions` and `run_with`, and use a stateful parser**

In `crates/kata-core/src/run.rs`, above `pub fn run`:

```rust
/// What a run reports, as opposed to what it does. Kept out of `RunSpec` on
/// purpose: a spec stays a reproducible description of the work.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunOptions {
    /// Emit raw tool `input` / `output` on tool events (`kata run --full-payloads`).
    pub full_payloads: bool,
}
```

Rename the existing `pub fn run<F: FnMut(KataEvent)>(...)` to `pub fn run_with` and add `opts: RunOptions,` as the parameter just before `mut emit: F`. Then add a new `run` with the old signature:

```rust
pub fn run<F: FnMut(KataEvent)>(
    spec: &RunSpec,
    catalog: &[CatalogEntry],
    cancel: &CancelToken,
    answers: &AnswerRx,
    decisions: &DecisionRx,
    emit: F,
) -> Result<RunOutcome, RunError> {
    run_with(spec, catalog, cancel, answers, decisions, RunOptions::default(), emit)
}
```

In `run_with`, find the stream loop that calls `crate::event::parse_stream_line(&line)` (line ~710). Declare one parser before the loop that contains it (next to the existing `turns` / `result` locals), and replace the call:

```rust
    // One parser for the whole stream: it carries the tool_use_id → name map
    // that labels each tool.result. A fresh parser per line loses it.
    let mut parser = crate::event::StreamParser::new(opts.full_payloads);
```

```rust
                let parsed = parser.push(&line);
```

If `parse_stream_line` has no other callers left, keep it: it is public API used by tests.

- [ ] **Step 5: Run the tests**

Run: `cargo test -p kata-core -p kata-cli`
Expected: all pass, including the two new tests and the three CLI goldens unchanged.

- [ ] **Step 6: Commit**

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
git add crates/kata-core/src/run.rs crates/kata-core/src/bin/fake-claude.rs crates/kata-core/tests/run_it.rs
git commit -m "fix(run): one stream parser per run, so tool results keep their names

Adds RunOptions/run_with for --full-payloads and a subagent fake mode."
```

---

### Task 3: The `--full-payloads` flag, and the Workbench passes it

**Model:** Haiku (the brief contains the complete code).

**Files:**
- Modify: `crates/kata-cli/src/main.rs` (`Cmd::Run` at line ~24, dispatch at line ~59, `fn cmd_run` at line ~307, the `kata_core::run::run(` call at line ~373)
- Modify: `app/src-tauri/src/lib.rs:72`
- Test: `crates/kata-cli/tests/cli_it.rs`

**Interfaces:**
- Consumes: `kata_core::run::{run_with, RunOptions}` (Task 2), fake mode `subagent`.
- Produces: `kata run [--full-payloads] <spec>`.

- [ ] **Step 1: Write the failing test**

Append to `crates/kata-cli/tests/cli_it.rs`:

```rust
#[test]
fn run_full_payloads_flag_adds_tool_output() {
    let work = tempfile::tempdir().unwrap();
    let kata_home = tempfile::tempdir().unwrap();
    let spec = write(
        work.path(),
        "p.kata.toml",
        &format!(
            "schema = 1\nname = \"p\"\ntask = \"t\"\nworkdir = \"{}\"\n",
            work.path().to_string_lossy().replace('\\', "/")
        ),
    );
    let run = |flag: bool| {
        let mut cmd = kata();
        cmd.arg("run");
        if flag {
            cmd.arg("--full-payloads");
        }
        let out = cmd
            .arg(&spec)
            .env("KATA_CLAUDE_BIN", fake_claude())
            .env("KATA_FAKE_MODE", "subagent")
            .env("KATA_HOME", kata_home.path())
            .output()
            .unwrap();
        assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
            .find(|v| v["type"] == "tool.result" && v["name"] == "Read")
            .expect("a Read tool.result")
    };
    let lean = run(false);
    assert_eq!(lean["id"], "toolu_B");
    assert!(lean.get("output").is_none());
    let full = run(true);
    assert_eq!(full["output"], "1\thello");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p kata-cli --test cli_it run_full_payloads_flag_adds_tool_output`
Expected: FAIL, clap rejects `--full-payloads` as an unexpected argument.

- [ ] **Step 3: Add the flag**

In `crates/kata-cli/src/main.rs`, change the variant:

```rust
    /// Run a kata to completion, streaming JSON-line events.
    Run {
        spec: PathBuf,
        /// Add raw tool input and output to tool.use / tool.result events
        /// (each capped at 256 KB). Off by default to keep CI logs lean.
        #[arg(long)]
        full_payloads: bool,
    },
```

Change the dispatch to `Cmd::Run { spec, full_payloads } => cmd_run(&spec, full_payloads),`, the function signature to `fn cmd_run(path: &std::path::Path, full_payloads: bool) -> ExitCode {`, and the run call to:

```rust
    let opts = kata_core::run::RunOptions { full_payloads };
    match kata_core::run::run_with(&spec, &catalog, &cancel, &answers, &decisions, opts, emit) {
```

- [ ] **Step 4: Run the CLI tests**

Run: `cargo test -p kata-cli`
Expected: all pass.

- [ ] **Step 5: The Workbench always passes the flag**

In `app/src-tauri/src/lib.rs`, change line 72:

```rust
        // The Observe pane renders tool payloads, so the GUI always asks for them.
        cmd.args(["run", "--full-payloads", &tmp.to_string_lossy()])
```

Run: `node app/scripts/stage-sidecar.mjs && cargo build --locked`
Expected: builds.

- [ ] **Step 6: Commit**

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
git add crates/kata-cli/src/main.rs crates/kata-cli/tests/cli_it.rs app/src-tauri/src/lib.rs
git commit -m "feat(cli): kata run --full-payloads; the Workbench always passes it"
```

---

### Task 4: Pairing, nesting, and renderer selection (pure TypeScript)

**Model:** Sonnet.

**Files:**
- Create: `app/src/lib/toolcards.ts`
- Test: `app/src/lib/toolcards.test.ts`
- Modify: `app/package.json` (add `diff`)

**Interfaces:**
- Consumes: generated `tool.use` / `tool.result` / `assistant.text` fields (Task 1); `PermissionRecord`, `AskRecord` from `app/src/lib/run.svelte.ts` (each has `id: string` and `at: number`).
- Produces (all exported from `$lib/toolcards`):
  - `type ToolUseEv`, `type ToolResultEv`
  - `type ToolCall = { id: string; use: ToolUseEv; result: ToolResultEv | null; depth: 0 | 1; children: StreamItem[] }`
  - `type StreamItem = { kind: "event"; key: string; at: number; ev: StreamEvent } | { kind: "call"; key: string; at: number; call: ToolCall }`
  - `type PausedItem = StreamItem | { kind: "perm"; key: string; p: PermissionRecord } | { kind: "ask"; key: string; a: AskRecord }`
  - `pairToolEvents(events: StreamEvent[]): StreamItem[]`
  - `withPauses(items: StreamItem[], permissions: PermissionRecord[], asks: AskRecord[]): PausedItem[]`
  - `type Renderer = "edit" | "multiedit" | "write" | "read" | "search" | "todo" | "agent" | "generic"`
  - `rendererFor(call: ToolCall): Renderer`
  - `type CallStatus = "ok" | "error" | "running"`; `statusOf(call: ToolCall): CallStatus`; `STATUS_TEXT: Record<CallStatus, string>`
  - `defaultOpen(call: ToolCall): boolean`
  - `inputOf(call: ToolCall): Record<string, unknown>`; `str(v: unknown): string`
  - `type Todo = { content: string; status: string }`; `todosOf(call: ToolCall): Todo[]`
  - `editStats(oldText: string, newText: string): { add: number; del: number }`
  - `targetFor(call: ToolCall): string`
  - `type Meta = { add?: number; del?: number; text?: string }`; `metaFor(call: ToolCall): Meta`

- [ ] **Step 1: Install the diff package**

Run: `cd app && npm install diff@^9`
Expected: `diff` appears under `dependencies` in `app/package.json`. It ships its own types; do not add `@types/diff`.

- [ ] **Step 2: Write the failing tests**

Create `app/src/lib/toolcards.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { StreamEvent } from "./events";
import type { AskRecord, PermissionRecord } from "./run.svelte";
import {
  pairToolEvents, withPauses, rendererFor, statusOf, defaultOpen,
  targetFor, metaFor, editStats, todosOf, type ToolCall, type StreamItem,
} from "./toolcards";

const use = (id: string, name: string, extra: Record<string, unknown> = {}): StreamEvent =>
  ({ type: "tool.use", name, input_summary: `${name} summary`, id, ...extra }) as StreamEvent;
const res = (id: string, name: string, ok = true, extra: Record<string, unknown> = {}): StreamEvent =>
  ({ type: "tool.result", name, ok, summary: `${name} done`, id, ...extra }) as StreamEvent;
const text = (t: string, parent_id?: string): StreamEvent =>
  ({ type: "assistant.text", text: t, ...(parent_id ? { parent_id } : {}) }) as StreamEvent;
const callAt = (items: StreamItem[], k: number): ToolCall => {
  const it = items[k];
  if (it.kind !== "call") throw new Error(`item ${k} is ${it.kind}`);
  return it.call;
};

describe("pairToolEvents", () => {
  it("pairs parallel calls of the same tool by id, not by order", () => {
    const items = pairToolEvents([use("a", "Read"), use("b", "Read"), res("b", "Read", false), res("a", "Read")]);
    expect(items).toHaveLength(2);
    expect(callAt(items, 0).result?.ok).toBe(true);
    expect(callAt(items, 1).result?.ok).toBe(false);
  });

  it("leaves a call without a result running", () => {
    const items = pairToolEvents([use("a", "Bash")]);
    expect(callAt(items, 0).result).toBeNull();
    expect(statusOf(callAt(items, 0))).toBe("running");
  });

  it("nests a subagent's calls and text one level deep", () => {
    const items = pairToolEvents([
      use("A", "Agent"),
      text("reading", "A"),
      use("B", "Read", { parent_id: "A" }),
      res("B", "Read", true, { parent_id: "A" }),
      res("A", "Agent"),
    ]);
    expect(items).toHaveLength(1);
    const agent = callAt(items, 0);
    expect(agent.children.map((c) => c.kind)).toEqual(["event", "call"]);
    const read = callAt(agent.children, 1);
    expect(read.depth).toBe(1);
    expect(read.result?.ok).toBe(true);
  });

  it("flattens a subagent's subagent into the first level", () => {
    const items = pairToolEvents([
      use("A", "Agent"),
      use("B", "Agent", { parent_id: "A" }),
      use("C", "Read", { parent_id: "B" }),
    ]);
    const agent = callAt(items, 0);
    expect(agent.children).toHaveLength(2);
    expect(callAt(agent.children, 1).use.name).toBe("Read");
    expect(callAt(agent.children, 1).depth).toBe(1);
  });

  it("shows an event whose parent never arrived at the top level", () => {
    const items = pairToolEvents([use("B", "Read", { parent_id: "missing" })]);
    expect(items).toHaveLength(1);
    expect(callAt(items, 0).use.name).toBe("Read");
  });

  it("passes id-less events (old transcripts) through untouched", () => {
    const old = { type: "tool.use", name: "Bash", input_summary: "ls" } as StreamEvent;
    const items = pairToolEvents([old, text("hi")]);
    expect(items.map((i) => i.kind)).toEqual(["event", "event"]);
  });

  it("shows a result whose call never arrived as a plain event", () => {
    const items = pairToolEvents([res("zz", "Read")]);
    expect(items[0].kind).toBe("event");
  });

  it("records the raw index of the event that opened each item", () => {
    const items = pairToolEvents([text("a"), use("x", "Read"), res("x", "Read"), text("b")]);
    expect(items.map((i) => i.at)).toEqual([0, 1, 3]);
  });
});

describe("withPauses", () => {
  const perm = (id: string, at: number) => ({ id, at, tool: "Bash", input_summary: "", decided: null }) as PermissionRecord;
  const ask = (id: string, at: number) => ({ id, at, questions: [], answers: null }) as unknown as AskRecord;

  it("puts a pause that happened mid-call right after that call's row", () => {
    // tool.use at 1, the ask after 2 events (between use and result), result at 2.
    const items = pairToolEvents([text("a"), use("x", "Bash"), res("x", "Bash"), text("b")]);
    const out = withPauses(items, [], [ask("q", 2)]);
    expect(out.map((i) => i.key)).toEqual(["e:0", "c:x", "a:q", "e:3"]);
  });

  it("puts a pause at 0 first and one past the end last, permissions before asks", () => {
    const items = pairToolEvents([text("a")]);
    const out = withPauses(items, [perm("p0", 0), perm("p9", 9)], [ask("q0", 0)]);
    expect(out.map((i) => i.key)).toEqual(["p:p0", "a:q0", "e:0", "p:p9"]);
  });
});

describe("renderer selection", () => {
  const call = (name: string, input?: unknown, extra: Record<string, unknown> = {}): ToolCall =>
    callAt(pairToolEvents([use("i", name, { ...(input !== undefined ? { input } : {}), ...extra })]), 0);

  it("picks a renderer per tool and matches both Agent and Task", () => {
    expect(rendererFor(call("Edit", { old_string: "a", new_string: "b" }))).toBe("edit");
    expect(rendererFor(call("MultiEdit", { edits: [] }))).toBe("multiedit");
    expect(rendererFor(call("Write", { content: "x" }))).toBe("write");
    expect(rendererFor(call("Read", {}))).toBe("read");
    expect(rendererFor(call("Grep", {}))).toBe("search");
    expect(rendererFor(call("Glob", {}))).toBe("search");
    expect(rendererFor(call("TodoWrite", { todos: [] }))).toBe("todo");
    expect(rendererFor(call("Agent", {}))).toBe("agent");
    expect(rendererFor(call("Task", {}))).toBe("agent");
    expect(rendererFor(call("WebFetch", {}))).toBe("generic");
  });

  it("falls back to generic without a payload, except for subagents", () => {
    expect(rendererFor(call("Edit"))).toBe("generic");
    expect(rendererFor(call("Agent"))).toBe("agent");
  });

  it("never draws a diff from a truncated input", () => {
    expect(rendererFor(call("Edit", undefined, { truncated: true }))).toBe("generic");
  });

  it("opens edits, todos, and failures; collapses the rest", () => {
    expect(defaultOpen(call("Edit", { old_string: "a", new_string: "b" }))).toBe(true);
    expect(defaultOpen(call("TodoWrite", { todos: [] }))).toBe(true);
    expect(defaultOpen(call("Read", {}))).toBe(false);
    expect(defaultOpen(call("Agent", {}))).toBe(false);
    const failed = callAt(pairToolEvents([use("i", "Read", { input: {} }), res("i", "Read", false)]), 0);
    expect(defaultOpen(failed)).toBe(true);
  });
});

describe("row text", () => {
  it("counts added and removed lines", () => {
    expect(editStats("a\nb\n", "a\nc\nd\n")).toEqual({ add: 2, del: 1 });
    expect(editStats("", "x\ny")).toEqual({ add: 2, del: 0 });
  });

  it("builds target and meta from the payload", () => {
    const edit = callAt(pairToolEvents([use("i", "Edit", { input: { file_path: "src/a.rs", old_string: "x", new_string: "y" } })]), 0);
    expect(targetFor(edit)).toBe("src/a.rs");
    expect(metaFor(edit)).toEqual({ add: 1, del: 1 });

    const todo = callAt(pairToolEvents([use("i", "TodoWrite", { input: { todos: [
      { content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" },
    ] } })]), 0);
    expect(metaFor(todo)).toEqual({ text: "1 / 3" });
    expect(todosOf(todo).map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);

    const read = callAt(pairToolEvents([use("i", "Read", { input: { file_path: "a.rs" } }), res("i", "Read", true, { output: "1\ta\n2\tb\n" })]), 0);
    expect(metaFor(read)).toEqual({ text: "2 lines" });

    const agent = callAt(pairToolEvents([
      use("A", "Agent", { input: { subagent_type: "Explore", description: "find checks" } }),
      use("B", "Grep", { parent_id: "A" }),
    ]), 0);
    expect(targetFor(agent)).toBe("Explore: find checks");
    expect(metaFor(agent)).toEqual({ text: "1 call" });
  });

  it("uses the summary as the target when there is no payload", () => {
    const bare = callAt(pairToolEvents([use("i", "Edit")]), 0);
    expect(targetFor(bare)).toBe("Edit summary");
    expect(metaFor(bare)).toEqual({});
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd app && npx vitest run src/lib/toolcards.test.ts`
Expected: FAIL, cannot resolve `./toolcards`.

- [ ] **Step 4: Implement**

Create `app/src/lib/toolcards.ts`:

```ts
/* Pairs tool.use with tool.result by `id`, nests a subagent's events under its
 * call by `parent_id`, and picks how each call renders. Pure: the Observe pane
 * and the run history both derive their rows from this. */

import { diffLines } from "diff";
import type { StreamEvent } from "./events";
import type { AskRecord, PermissionRecord } from "./run.svelte";

export type ToolUseEv = Extract<StreamEvent, { type: "tool.use" }>;
export type ToolResultEv = Extract<StreamEvent, { type: "tool.result" }>;

export type ToolCall = {
  id: string;
  use: ToolUseEv;
  /** `null` until the result arrives (or forever, if the run was cut short). */
  result: ToolResultEv | null;
  /** 0 at the top level, 1 inside a subagent. Never deeper. */
  depth: 0 | 1;
  children: StreamItem[];
};

/** `at` is the raw index of the event that opened the item. */
export type StreamItem =
  | { kind: "event"; key: string; at: number; ev: StreamEvent }
  | { kind: "call"; key: string; at: number; call: ToolCall };

export type PausedItem =
  | StreamItem
  | { kind: "perm"; key: string; p: PermissionRecord }
  | { kind: "ask"; key: string; a: AskRecord };

type Slot = { list: StreamItem[]; depth: 0 | 1 };

export function pairToolEvents(events: StreamEvent[]): StreamItem[] {
  const top: StreamItem[] = [];
  const calls = new Map<string, ToolCall>();
  // Where each call's own events go. A top-level call collects them in its
  // children; a nested call hands them to the list it already lives in, which
  // flattens a subagent's subagent to one level.
  const slots = new Map<string, Slot>();
  const slotFor = (parentId: string | undefined): Slot =>
    (parentId ? slots.get(parentId) : undefined) ?? { list: top, depth: 0 };

  events.forEach((ev, i) => {
    if (ev.type === "tool.use" && ev.id) {
      const slot = slotFor(ev.parent_id);
      const call: ToolCall = { id: ev.id, use: ev, result: null, depth: slot.depth, children: [] };
      calls.set(ev.id, call);
      slots.set(ev.id, slot.depth === 0 ? { list: call.children, depth: 1 } : slot);
      slot.list.push({ kind: "call", key: `c:${ev.id}`, at: i, call });
      return;
    }
    if (ev.type === "tool.result" && ev.id) {
      const call = calls.get(ev.id);
      if (call) {
        call.result = ev;
        return;
      }
    }
    const parentId =
      ev.type === "tool.use" || ev.type === "tool.result" || ev.type === "assistant.text"
        ? ev.parent_id
        : undefined;
    slotFor(parentId).list.push({ kind: "event", key: `e:${i}`, at: i, ev });
  });
  return top;
}

/** Splice pause records back where they happened. A record's `at` counts the
 *  raw events before it, so it goes after the last top-level item that opened
 *  before that point: a pause between a call and its result lands right after
 *  that call's row. Permissions precede asks at the same slot so the order is
 *  deterministic (a run is only ever paused on one thing at a time). */
export function withPauses(
  items: StreamItem[],
  permissions: PermissionRecord[],
  asks: AskRecord[],
): PausedItem[] {
  const slotOf = (at: number) => items.filter((it) => it.at < at).length;
  const pauses: PausedItem[][] = Array.from({ length: items.length + 1 }, () => []);
  for (const p of permissions) pauses[slotOf(p.at)].push({ kind: "perm", key: `p:${p.id}`, p });
  for (const a of asks) pauses[slotOf(a.at)].push({ kind: "ask", key: `a:${a.id}`, a });
  const out: PausedItem[] = [...pauses[0]];
  items.forEach((it, k) => out.push(it, ...pauses[k + 1]));
  return out;
}

export type Renderer = "edit" | "multiedit" | "write" | "read" | "search" | "todo" | "agent" | "generic";

export function rendererFor(call: ToolCall): Renderer {
  const name = call.use.name;
  // A subagent nests its children whether or not payloads were captured.
  if (name === "Agent" || name === "Task") return "agent";
  // No payload (a run without --full-payloads) or a cut one: never draw a diff
  // or a checklist from it.
  if (call.use.truncated || call.use.input === undefined) return "generic";
  switch (name) {
    case "Edit": return "edit";
    case "MultiEdit": return "multiedit";
    case "Write": return "write";
    case "Read": return "read";
    case "Grep":
    case "Glob": return "search";
    case "TodoWrite": return "todo";
    default: return "generic";
  }
}

export type CallStatus = "ok" | "error" | "running";

export function statusOf(call: ToolCall): CallStatus {
  if (call.result === null) return "running";
  return call.result.ok ? "ok" : "error";
}

/** The label beside every status dot: color is never shown alone. */
export const STATUS_TEXT: Record<CallStatus, string> = { ok: "ok", error: "error", running: "running…" };

const OPEN_BY_DEFAULT = new Set<Renderer>(["edit", "multiedit", "write", "todo"]);

export function defaultOpen(call: ToolCall): boolean {
  return statusOf(call) === "error" || OPEN_BY_DEFAULT.has(rendererFor(call));
}

export function inputOf(call: ToolCall): Record<string, unknown> {
  const v = call.use.input;
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type Todo = { content: string; status: string };

export function todosOf(call: ToolCall): Todo[] {
  const todos = inputOf(call).todos;
  if (!Array.isArray(todos)) return [];
  return todos.map((t) => ({ content: str(t?.content), status: str(t?.status) }));
}

const lineCount = (s: string): number => (s === "" ? 0 : s.replace(/\n$/, "").split("\n").length);

export function editStats(oldText: string, newText: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const part of diffLines(oldText, newText)) {
    const n = part.count ?? lineCount(part.value);
    if (part.added) add += n;
    else if (part.removed) del += n;
  }
  return { add, del };
}

export function targetFor(call: ToolCall): string {
  const inp = inputOf(call);
  switch (rendererFor(call)) {
    case "edit":
    case "multiedit":
    case "write":
    case "read": return str(inp.file_path);
    case "search": return str(inp.pattern);
    case "todo": return "";
    case "agent":
      return inp.subagent_type
        ? `${str(inp.subagent_type)}: ${str(inp.description)}`
        : call.use.input_summary;
    case "generic": return call.use.input_summary;
  }
}

export type Meta = { add?: number; del?: number; text?: string };

const countCalls = (items: StreamItem[]): number => items.filter((i) => i.kind === "call").length;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function metaFor(call: ToolCall): Meta {
  const inp = inputOf(call);
  const output = call.result?.output;
  switch (rendererFor(call)) {
    case "edit": return editStats(str(inp.old_string), str(inp.new_string));
    case "multiedit": {
      const edits = Array.isArray(inp.edits) ? inp.edits : [];
      return edits.reduce<{ add: number; del: number }>((acc, e) => {
        const s = editStats(str(e?.old_string), str(e?.new_string));
        return { add: acc.add + s.add, del: acc.del + s.del };
      }, { add: 0, del: 0 });
    }
    case "write": return { add: lineCount(str(inp.content)) };
    case "read": return output !== undefined ? { text: plural(lineCount(output), "line") } : {};
    case "search":
      return output !== undefined
        ? { text: plural(output.split("\n").filter((l) => l.trim() !== "").length, "match", "matches") }
        : {};
    case "todo": {
      const todos = todosOf(call);
      return { text: `${todos.filter((t) => t.status === "completed").length} / ${todos.length}` };
    }
    case "agent": return { text: plural(countCalls(call.children), "call") };
    case "generic": return {};
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd app && npx vitest run src/lib/toolcards.test.ts && npm run check`
Expected: all pass; 0 type errors. If `npm run check` flags `part.count` as possibly undefined differently than handled, keep the `?? lineCount(...)` fallback and adjust only the type annotation.

- [ ] **Step 6: Commit**

```bash
git add app/package.json app/package-lock.json app/src/lib/toolcards.ts app/src/lib/toolcards.test.ts
git commit -m "feat(workbench): pair, nest, and classify tool events"
```

---

### Task 5: The rail components

**Model:** Sonnet (visual work against the design rules).

**Files:**
- Create: `app/src/lib/components/ToolCard.svelte`
- Create: `app/src/lib/components/toolcards/DiffBody.svelte`, `TodoBody.svelte`, `OutputBody.svelte`, `JsonBody.svelte`
- Modify: `app/src/styles/components/components.css` (append)
- Test: `app/src/lib/components/ToolCard.test.ts`

**Interfaces:**
- Consumes: everything Task 4 exports.
- Produces: `<ToolCard call={ToolCall} />`. `<DiffBody oldText newText />`, `<TodoBody todos />`, `<OutputBody text truncated? />`, `<JsonBody value />`.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/components/ToolCard.test.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import ToolCard from "./ToolCard.svelte";
import { pairToolEvents, type ToolCall } from "$lib/toolcards";
import type { StreamEvent } from "$lib/events";

const callOf = (events: Record<string, unknown>[]): ToolCall => {
  const it = pairToolEvents(events as StreamEvent[])[0];
  if (it.kind !== "call") throw new Error("not a call");
  return it.call;
};
const use = (name: string, input?: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: "tool.use", name, input_summary: `${name} summary`, id: "i", ...(input !== undefined ? { input } : {}), ...extra });
const res = (name: string, ok = true, extra: Record<string, unknown> = {}) =>
  ({ type: "tool.result", name, ok, summary: `${name} result summary`, id: "i", ...extra });

describe("ToolCard", () => {
  it("renders an Edit open, as a diff, with a status label", () => {
    const { container } = render(ToolCard, { call: callOf([
      use("Edit", { file_path: "src/claim.rs", old_string: "if now > t {", new_string: "if now >= t {" }),
      res("Edit"),
    ]) });
    expect(screen.getByText("src/claim.rs")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(container.querySelector(".k-toolcard__dl--del")).toHaveTextContent("if now > t {");
    expect(container.querySelector(".k-toolcard__dl--add")).toHaveTextContent("if now >= t {");
  });

  it("renders a Read collapsed and opens it on click", async () => {
    render(ToolCard, { call: callOf([use("Read", { file_path: "a.rs" }), res("Read", true, { output: "1\tfn main() {}" })]) });
    expect(screen.queryByText("1\tfn main() {}", { normalizer: (s) => s })).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: /Read/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    await fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("1\tfn main() {}", { normalizer: (s) => s })).toBeInTheDocument();
  });

  it("opens a failed Edit and shows the error under the diff", () => {
    render(ToolCard, { call: callOf([
      use("Edit", { file_path: "a.rs", old_string: "x", new_string: "y" }),
      res("Edit", false, { output: "old_string not found" }),
    ]) });
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("old_string not found")).toBeInTheDocument();
  });

  it("shows a running call with its label and no body", () => {
    render(ToolCard, { call: callOf([use("Bash", { command: "cargo test" })]) });
    expect(screen.getByText("running…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bash/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("renders a TodoWrite as a checklist", () => {
    const { container } = render(ToolCard, { call: callOf([use("TodoWrite", { todos: [
      { content: "reproduce", status: "completed" },
      { content: "fix", status: "in_progress" },
      { content: "ship", status: "pending" },
    ] }), res("TodoWrite")]) });
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(container.querySelector(".k-toolcard__todo-item--completed")).toHaveTextContent("reproduce");
    expect(container.querySelector(".k-toolcard__todo-item--in_progress")).toHaveTextContent("fix");
  });

  it("nests a subagent's calls inside its body", async () => {
    render(ToolCard, { call: callOf([
      use("Agent", { subagent_type: "Explore", description: "find checks", prompt: "Find every expiry check" }, { id: "A" }),
      { type: "tool.use", name: "Grep", input_summary: "expires_at", id: "B", parent_id: "A", input: { pattern: "expires_at" } },
      { type: "tool.result", name: "Grep", ok: true, summary: "7", id: "B", parent_id: "A", output: "a.rs:1" },
      { type: "tool.result", name: "Agent", ok: true, summary: "done", id: "A", output: "lease.rs has the bug" },
    ]) });
    await fireEvent.click(screen.getByRole("button", { name: /Agent/ }));
    expect(screen.getByText("Find every expiry check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Grep/ })).toBeInTheDocument();
    expect(screen.getByText("lease.rs has the bug")).toBeInTheDocument();
  });

  it("matches the older Task name for subagents", () => {
    render(ToolCard, { call: callOf([use("Task", { subagent_type: "general-purpose", description: "look" })]) });
    expect(screen.getByText("general-purpose: look")).toBeInTheDocument();
  });

  it("shows summaries when the run carried no payloads", async () => {
    render(ToolCard, { call: callOf([use("Edit"), res("Edit")]) });
    await fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(screen.getAllByText("Edit summary").length).toBeGreaterThan(0);
    expect(screen.getByText("Edit result summary")).toBeInTheDocument();
  });

  it("marks a truncated output", async () => {
    render(ToolCard, { call: callOf([use("Read", { file_path: "big.min.js" }), res("Read", true, { output: "x", truncated: true })]) });
    await fireEvent.click(screen.getByRole("button", { name: /Read/ }));
    expect(screen.getByText("… truncated at 256 KB")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && npx vitest run src/lib/components/ToolCard.test.ts`
Expected: FAIL, cannot resolve `./ToolCard.svelte`.

- [ ] **Step 3: Write the body components**

`app/src/lib/components/toolcards/OutputBody.svelte`:

```svelte
<script lang="ts">
  let { text, truncated = false }: { text: string; truncated?: boolean } = $props();
</script>

<pre class="k-toolcard__out">{text || "(no output)"}</pre>
{#if truncated}<div class="k-toolcard__trunc">… truncated at 256 KB</div>{/if}
```

`app/src/lib/components/toolcards/JsonBody.svelte`:

```svelte
<script lang="ts">
  let { value }: { value: unknown } = $props();
</script>

<pre class="k-toolcard__out">{JSON.stringify(value, null, 2)}</pre>
```

`app/src/lib/components/toolcards/DiffBody.svelte`:

```svelte
<script lang="ts">
  import { diffLines } from "diff";

  let { oldText, newText }: { oldText: string; newText: string } = $props();

  type Line = { kind: "add" | "del" | "ctx"; text: string };
  /* No line numbers: an Edit's input carries no position in the file. */
  const lines: Line[] = $derived(
    diffLines(oldText, newText).flatMap((part) => {
      const kind = part.added ? "add" : part.removed ? "del" : "ctx";
      return part.value.replace(/\n$/, "").split("\n").map((text): Line => ({ kind, text }));
    }),
  );
  const MARK = { add: "+", del: "-", ctx: " " } as const;
</script>

<div class="k-toolcard__diff">
  {#each lines as l, i (i)}
    <div class="k-toolcard__dl k-toolcard__dl--{l.kind}"><span class="k-toolcard__dm">{MARK[l.kind]}</span>{l.text}</div>
  {/each}
</div>
```

`app/src/lib/components/toolcards/TodoBody.svelte`:

```svelte
<script lang="ts">
  import type { Todo } from "$lib/toolcards";
  import Check from "@lucide/svelte/icons/check";
  import CircleDot from "@lucide/svelte/icons/circle-dot";
  import Circle from "@lucide/svelte/icons/circle";

  let { todos }: { todos: Todo[] } = $props();
</script>

<ul class="k-toolcard__todo">
  {#each todos as t, i (i)}
    <li class="k-toolcard__todo-item k-toolcard__todo-item--{t.status}">
      {#if t.status === "completed"}<Check size={12} />{:else if t.status === "in_progress"}<CircleDot size={12} />{:else}<Circle size={12} />{/if}
      <span>{t.content}</span>
    </li>
  {/each}
</ul>
```

- [ ] **Step 4: Write the card**

`app/src/lib/components/ToolCard.svelte`:

```svelte
<script lang="ts">
  import type { ToolCall } from "$lib/toolcards";
  import {
    rendererFor, statusOf, defaultOpen, targetFor, metaFor, inputOf, todosOf, str, STATUS_TEXT,
  } from "$lib/toolcards";
  import EventRow from "./EventRow.svelte";
  import ToolCard from "./ToolCard.svelte";
  import DiffBody from "./toolcards/DiffBody.svelte";
  import TodoBody from "./toolcards/TodoBody.svelte";
  import OutputBody from "./toolcards/OutputBody.svelte";
  import JsonBody from "./toolcards/JsonBody.svelte";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  let { call }: { call: ToolCall } = $props();

  const renderer = $derived(rendererFor(call));
  const status = $derived(statusOf(call));
  // null until the operator clicks: until then the default policy decides, so
  // a call that fails after it rendered (running → error) still opens itself.
  let toggled = $state<boolean | null>(null);
  const open = $derived(toggled ?? defaultOpen(call));
  const inp = $derived(inputOf(call));
  const meta = $derived(metaFor(call));
  const output = $derived(call.result ? (call.result.output ?? call.result.summary) : "");
  const outTruncated = $derived(call.result?.truncated ?? false);
  const edits = $derived(Array.isArray(inp.edits) ? (inp.edits as Record<string, unknown>[]) : []);
  // Bespoke bodies show the tool's own view; a failure's message goes under it.
  const showErrorOutput = $derived(
    status === "error" && (renderer === "edit" || renderer === "multiedit" || renderer === "write" || renderer === "todo"),
  );
</script>

<div class="k-toolcard">
  <button type="button" class="k-toolcard__row" aria-expanded={open} onclick={() => (toggled = !open)}>
    <span class="k-toolcard__chev">{#if open}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}</span>
    <span class="k-toolcard__dot k-toolcard__dot--{status}"></span>
    <span class="k-toolcard__name">{call.use.name}</span>
    <span class="k-toolcard__target">{targetFor(call)}</span>
    <span class="k-toolcard__meta">
      {#if meta.add !== undefined}<span class="k-toolcard__add">+{meta.add}</span>{/if}
      {#if meta.del !== undefined}<span class="k-toolcard__del">−{meta.del}</span>{/if}
      {#if meta.text}<span>{meta.text}</span>{/if}
    </span>
    <span class="k-toolcard__status k-toolcard__status--{status}">{STATUS_TEXT[status]}</span>
  </button>

  {#if open}
    <div class="k-toolcard__body">
      {#if renderer === "edit"}
        <DiffBody oldText={str(inp.old_string)} newText={str(inp.new_string)} />
      {:else if renderer === "multiedit"}
        {#each edits as e, i (i)}<DiffBody oldText={str(e.old_string)} newText={str(e.new_string)} />{/each}
      {:else if renderer === "write"}
        <DiffBody oldText="" newText={str(inp.content)} />
      {:else if renderer === "todo"}
        <TodoBody todos={todosOf(call)} />
      {:else if renderer === "agent"}
        {#if str(inp.prompt)}
          <div class="k-toolcard__label">prompt</div>
          <div class="k-toolcard__prose">{str(inp.prompt)}</div>
        {/if}
        {#each call.children as child (child.key)}
          {#if child.kind === "call"}<ToolCard call={child.call} />{:else}<EventRow ev={child.ev} />{/if}
        {/each}
        {#if call.result}
          <div class="k-toolcard__label">result</div>
          <OutputBody text={output} truncated={outTruncated} />
        {/if}
      {:else if renderer === "read" || renderer === "search"}
        <OutputBody text={output} truncated={outTruncated} />
      {:else}
        <div class="k-toolcard__label">input</div>
        {#if call.use.input !== undefined}
          <JsonBody value={call.use.input} />
        {:else}
          <OutputBody text={call.use.input_summary} truncated={call.use.truncated ?? false} />
        {/if}
        {#if call.result}
          <div class="k-toolcard__label">output</div>
          <OutputBody text={output} truncated={outTruncated} />
        {/if}
      {/if}
      {#if showErrorOutput}
        <OutputBody text={output} truncated={outTruncated} />
      {/if}
    </div>
  {/if}
</div>
```

- [ ] **Step 5: Add the styles**

Append to `app/src/styles/components/components.css`:

```css
/* tool cards — the rail (docs/superpowers/specs/2026-10-12-tool-cards-design.md) */
.k-toolcard { display: flex; flex-direction: column; }
.k-toolcard__row { appearance: none; background: none; border: 0; width: 100%; display: flex; align-items: center; gap: var(--space-2); padding: 2px var(--space-2); border-radius: var(--radius-xs); font: var(--font-code-sm); color: var(--text-secondary); text-align: left; cursor: pointer; }
.k-toolcard__row:hover { background: var(--surface-hover); }
.k-toolcard__row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.k-toolcard__chev { flex: none; display: inline-flex; color: var(--text-faint); }
.k-toolcard__dot { flex: none; width: 7px; height: 7px; border-radius: var(--radius-full); }
.k-toolcard__dot--ok { background: var(--success); }
.k-toolcard__dot--error { background: var(--error); }
.k-toolcard__dot--running { background: var(--text-faint); }
.k-toolcard__name { flex: none; color: var(--text-primary); font-weight: var(--weight-medium); }
.k-toolcard__target { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent-text); }
.k-toolcard__meta { margin-left: auto; flex: none; display: inline-flex; gap: var(--space-2); color: var(--text-faint); }
.k-toolcard__add { color: var(--success-text); }
.k-toolcard__del { color: var(--error-text); }
.k-toolcard__status { flex: none; min-width: 56px; text-align: right; font-size: var(--text-2xs); }
.k-toolcard__status--ok { color: var(--success-text); }
.k-toolcard__status--error { color: var(--error-text); }
.k-toolcard__status--running { color: var(--text-faint); }
.k-toolcard__body { margin: var(--space-1) 0 var(--space-2) 21px; padding-left: var(--space-3); border-left: 1px solid var(--border-default); display: flex; flex-direction: column; gap: var(--space-2); }
.k-toolcard__out { margin: 0; font: var(--font-code-sm); color: var(--text-secondary); background: var(--surface-inset); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; }
.k-toolcard__trunc { font: var(--font-code-sm); font-size: var(--text-2xs); color: var(--text-faint); }
.k-toolcard__label { font: var(--weight-medium) var(--text-2xs)/1 var(--font-mono); letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--text-faint); }
.k-toolcard__prose { font: var(--text-sm)/1.5 var(--font-sans); color: var(--text-secondary); white-space: pre-wrap; }
.k-toolcard__diff { font: var(--font-code-sm); background: var(--surface-inset); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); overflow: auto; max-height: 480px; }
.k-toolcard__dl { padding: 0 var(--space-2); white-space: pre; color: var(--text-muted); }
.k-toolcard__dl--add { background: var(--success-subtle); color: var(--success-text); }
.k-toolcard__dl--del { background: var(--error-subtle); color: var(--error-text); }
.k-toolcard__dm { display: inline-block; width: 1.5ch; user-select: none; }
.k-toolcard__todo { list-style: none; margin: 0; padding: 0; font: var(--font-code-sm); line-height: 1.7; }
.k-toolcard__todo-item { display: flex; gap: var(--space-2); align-items: center; color: var(--text-muted); }
.k-toolcard__todo-item--completed { color: var(--text-faint); text-decoration: line-through; }
.k-toolcard__todo-item--in_progress { color: var(--accent-text); }
```

Every token above exists in `app/src/styles/tokens/` (checked while planning). Run `grep -n "#[0-9a-fA-F]\{3,6\}" app/src/styles/components/components.css | grep k-toolcard`; expected: no output.

- [ ] **Step 6: Run the tests**

Run: `cd app && npx vitest run src/lib/components/ToolCard.test.ts && npm run check`
Expected: all pass; 0 errors. If a `getByText` with a tab character fails to match, keep the `normalizer: (s) => s` option shown in the test rather than changing the component.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/components/ToolCard.svelte app/src/lib/components/ToolCard.test.ts app/src/lib/components/toolcards app/src/styles/components/components.css
git commit -m "feat(workbench): the tool-call rail"
```

---

### Task 6: Wire the rail into the Observe pane, the run history, and the demo

**Model:** Sonnet.

**Files:**
- Modify: `app/src/lib/components/ObservePane.svelte` (the `StreamItem` type and `streamItems` derivation at lines ~58-97; the `{#each}` at lines ~120-150)
- Modify: `app/src/routes/library/+page.svelte:56` and `:227`
- Modify: `app/src/lib/mock.ts` (the `runScriptHead` / `runScriptMid` / `runScriptTail` tool events)
- Test: `app/src/lib/components/ObservePane.test.ts`

**Interfaces:**
- Consumes: `pairToolEvents`, `withPauses`, `PausedItem` (Task 4); `ToolCard` (Task 5).

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/components/ObservePane.test.ts`:

```ts
describe("ObservePane — tool calls", () => {
  it("renders a paired call as one rail row, not two log rows", () => {
    renderPane({
      events: [
        { type: "tool.use", name: "Read", input_summary: "src/a.rs", id: "t1", input: { file_path: "src/a.rs" } },
        { type: "tool.result", name: "Read", ok: true, summary: "12 lines", id: "t1", output: "1\tfn a() {}" },
      ],
    });
    expect(screen.getByRole("button", { name: /Read/ })).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.queryByText("12 lines")).not.toBeInTheDocument();
  });

  it("still renders id-less events from old transcripts as log rows", () => {
    renderPane({ events: [{ type: "tool.use", name: "Bash", input_summary: "ls -la" }] });
    expect(screen.getByText("ls -la")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx vitest run src/lib/components/ObservePane.test.ts`
Expected: the first new test FAILS (no button named Read); the existing tests pass.

- [ ] **Step 3: Use the pairing in ObservePane**

In `app/src/lib/components/ObservePane.svelte`:

Add imports:

```ts
  import ToolCard from "./ToolCard.svelte";
  import { pairToolEvents, withPauses, type PausedItem } from "../toolcards";
```

Replace the whole block from the comment `/* A pause belongs where it happened` through the end of the `const streamItems ... $derived.by(...)` declaration with:

```ts
  /* A pause belongs where it happened, not in a pile at the end of the
   * transcript: reading "…ran the tests, then asked about this" is the whole
   * point of a stream. Tool calls are paired first, then each ask and
   * permission record is spliced back by its `at` (see withPauses). */
  const streamItems: PausedItem[] = $derived(withPauses(pairToolEvents(events), permissions, asks));
```

In the template, replace the event branch of the `{#each streamItems as item (item.key)}` block:

```svelte
      {#if item.kind === "event"}
        <div class="wb-event-enter"><EventRow ev={item.ev} /></div>
      {:else if item.kind === "call"}
        <div class="wb-event-enter"><ToolCard call={item.call} /></div>
```

Leave the `perm` and ask branches exactly as they are.

- [ ] **Step 4: Use the pairing in the run history**

In `app/src/routes/library/+page.svelte`, add imports:

```ts
  import ToolCard from "$lib/components/ToolCard.svelte";
  import { pairToolEvents } from "$lib/toolcards";
```

Change line 56 to:

```ts
  let stream = $derived(detail ? pairToolEvents(detail.events.filter(isStreamEvent)) : null);
```

Change line 227 to:

```svelte
                {#each stream as item (item.key)}
                  {#if item.kind === "call"}<ToolCard call={item.call} />{:else}<EventRow ev={item.ev} />{/if}
                {/each}
```

- [ ] **Step 5: Give the demo run real tool calls**

In `app/src/lib/mock.ts`, give every `tool.use` / `tool.result` pair a shared `id` and payloads, and add a todo list and a subagent so `?demo=run` shows every renderer except diffs (the demo run changes no code, by design). Replace these entries:

In `runScriptHead`, replace the Bash pair with:

```ts
  { delay: 200, ev: { type: "tool.use", name: "TodoWrite", input_summary: "{\"todos\":[…]}", id: "toolu_todo1", input: { todos: [
    { content: "Reproduce the LoginExpiry flake", status: "in_progress" },
    { content: "Find the root cause", status: "pending" },
    { content: "Write the isolation report", status: "pending" },
  ] } } },
  { delay: 150, ev: { type: "tool.result", name: "TodoWrite", ok: true, summary: "Todos updated", id: "toolu_todo1", output: "Todos have been modified successfully." } },
  { delay: 300, ev: { type: "tool.use", name: "Bash", input_summary: "dotnet test --filter AuthTests.LoginExpiry", id: "toolu_bash1", input: { command: "dotnet test --filter AuthTests.LoginExpiry", description: "Hammer the flaky test" } } },
  { delay: 1300, ev: { type: "tool.result", name: "Bash", ok: true, summary: "3 of 30 runs failed — iterations 8, 19, 26", id: "toolu_bash1", output: "Passed!  - Failed: 0, Passed: 1 (run 1)\n…\nFailed!  - Failed: 1, Passed: 0 (run 8)\n  AuthTests.LoginExpiry: token reported expired 0.4s early\n…\n3 of 30 runs failed — iterations 8, 19, 26" } },
```

In `runScriptMid`, replace the Read pair with a subagent that does the reading:

```ts
  { delay: 300, ev: { type: "tool.use", name: "Agent", input_summary: "Explore: find expiry comparisons", id: "toolu_agent1", input: { subagent_type: "Explore", description: "find expiry comparisons", prompt: "Find every place token expiry is computed or compared in src/Auth and report which clock each one uses." } } },
  { delay: 400, ev: { type: "tool.use", name: "Grep", input_summary: "IsExpired|ExpiresAt", id: "toolu_grep1", parent_id: "toolu_agent1", input: { pattern: "IsExpired|ExpiresAt", path: "src/Auth" } } },
  { delay: 350, ev: { type: "tool.result", name: "Grep", ok: true, summary: "4 matches", id: "toolu_grep1", parent_id: "toolu_agent1", output: "src/Auth/TokenValidator.cs:41\nsrc/Auth/TokenValidator.cs:58\nsrc/Auth/TokenIssuer.cs:22\nsrc/Auth/SessionStore.cs:107" } },
  { delay: 300, ev: { type: "tool.use", name: "Read", input_summary: "src/Auth/TokenValidator.cs", id: "toolu_read1", parent_id: "toolu_agent1", input: { file_path: "src/Auth/TokenValidator.cs" } } },
  { delay: 600, ev: { type: "tool.result", name: "Read", ok: true, summary: "TokenValidator.cs — 142 lines", id: "toolu_read1", parent_id: "toolu_agent1", output: "    38\tpublic bool IsExpired(Token t)\n    39\t{\n    40\t    // expiry was stamped by TokenIssuer\n    41\t    return DateTime.UtcNow > t.ExpiresAt;\n    42\t}" } },
  { delay: 400, ev: { type: "tool.result", name: "Agent", ok: true, summary: "TokenIssuer stamps with DateTime.Now", id: "toolu_agent1", output: "TokenValidator.cs:41 compares DateTime.UtcNow; TokenIssuer.cs:22 stamps ExpiresAt with DateTime.Now. The other two use UtcNow consistently." } },
```

and give the denied `git log` pair `id: "toolu_bash2"` on both events (plus `input: { command: "git log --oneline -3" }` on the use and `output` equal to its `summary` on the result).

In `runScriptTail`, give the `git -C … diff --stat` pair `id: "toolu_bash3"` on both events, `input: { command: "git -C ./.kata/wt-3f9a diff --stat" }` on the use, and `output: ""` on the result.

If `npm run check` rejects a field on these literals, the generated types from Task 1 are stale: rerun `npm run gen:events`, do not cast.

- [ ] **Step 6: Run everything**

Run: `cd app && npm test && npm run check`
Expected: all pass, 0 errors. The existing ObservePane approval-card and ask tests pass unchanged; if one fails, the `withPauses` slotting is wrong, so fix `toolcards.ts`, not the test.

- [ ] **Step 7: Look at it**

Run: `cd app && npm run dev`, open `http://localhost:1420/?demo=run`. Check, and write down the result of each:
1. The TodoWrite row starts open as a checklist; the Bash row starts collapsed with `ok`.
2. The ask panel appears right after the Bash row, not at the bottom.
3. The Agent row starts collapsed; opening it shows the prompt, the nested Grep and Read rows, and the result.
4. The denied `git log` row starts open with `error`.
5. The permission panel appears after the `git log` row; after allowing, the final Bash row resolves from `running…` to its result.
6. No hard-coded colors: `grep -rn "#[0-9a-fA-F]\{6\}" app/src/lib/components/ToolCard.svelte app/src/lib/components/toolcards` prints nothing.

Then, with an authenticated `claude` on PATH, run `npm run tauri:dev` and launch a real kata that edits a file, fails one command, and uses a subagent. Check that the Edit row shows a diff with the right lines, and that the run appears in the Library with the same rows after it finishes.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/components/ObservePane.svelte app/src/lib/components/ObservePane.test.ts app/src/routes/library/+page.svelte app/src/lib/mock.ts
git commit -m "feat(workbench): render tool calls as rail rows in the stream and history"
```

---

### Task 7: Final gates and review

**Model:** Opus for the review (non-negotiable per the global instructions).

- [ ] **Step 1: Run every gate**

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo build --locked
node app/scripts/stage-sidecar.mjs
cargo test --workspace
cd app && npm run check && npm test
```

Expected: all clean and green.

- [ ] **Step 2: Walk CONTRACTS.md by hand**

Confirm against `CONTRACTS.md` §2 (event protocol) and the CLI section: every change is a new optional field on an existing event or a new flag; no type tag, field name, field meaning, or exit code changed; `protocolVersion` is still 1 in `schema/kata-events.schema.json`.

- [ ] **Step 3: Whole-branch review on Opus**

Dispatch a reviewer on the full `git diff origin/main...HEAD` with the spec and this plan, focused on the Review Focus list above.

- [ ] **Step 4: Open the PR**

One PR for the branch, per the spec.
