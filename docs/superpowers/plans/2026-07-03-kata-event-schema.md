# Kata Event-Protocol Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the `KataEvent` protocol as a single-source-of-truth JSON Schema generated from `kata-core`, retire the hand-written TypeScript mirror by generating it from that schema, and correlate `tool.result` back to its originating `tool.use`.

**Architecture:** Derive `schemars::JsonSchema` (feature-gated `schema`, mirroring the existing feature-gated `ts` idiom) on `KataEvent` and its payload types. A feature-gated Rust test emits a committed, `protocolVersion`-stamped `schema/kata-events.schema.json` and fails on drift. The Workbench generates `app/src/bindings/kata-events.ts` from that committed schema via `json-schema-to-typescript`; `app/src/lib/events.ts` shrinks to a re-export of the generated types plus its hand-written render/status helpers. A small stateful `StreamParser` maintains a `tool_use_id → name` map so `tool.result` events render with their tool name.

**Tech Stack:** Rust (`schemars` 1.x, `serde`, `serde_json`), TypeScript/SvelteKit (`json-schema-to-typescript`), GitHub Actions CI.

## Global Constraints

- **Codegen mechanism is `schemars`, not `ts-rs`.** The events schema is the language-neutral contract; ts-rs is TypeScript-only and out of scope for events.
- **Pin `schemars` to `1.x`** — `1.2.x` is already transitive in `Cargo.lock`; do not introduce a new major version.
- **The `schemars` derive is feature-gated behind a new `schema` feature** (`#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]`). `schemars` is an **optional** dependency — the shipped `kata` binary must not carry it by default.
- **Do NOT change any wire shape.** No new event families, no renames, no new fields on existing `KataEvent` variants. The serde `#[serde(tag = "type", rename = "…")]` tagging and all existing `#[serde]` attributes stay exactly as-is; the schema must match the wire.
- **Preserve existing serde round-trip tests in `event.rs` unchanged** — they pin the wire shapes.
- **`app/src/lib/events.ts` keeps its hand-written helpers** (`gutterFor`, `variantFor`, `bodyFor`, `statusForExit`, `terminalStateFor`, `isStreamEvent`, `RunState`, `STATUS_LABEL`, `RunSummary`, `StreamEvent`, `RunDetail`) and its stable import path. Only the type *union* and `Question`/`QuestionKind`/`QuestionOption`/`DiffFile` type declarations are replaced by re-exports of generated types. 13 files import from `events.ts`; none of their imports may break.
- **Generated files use LF line endings** (match the existing `app/src/bindings/` ts-rs output).
- **Protocol version starts at `1`**, defined once as a Rust const and injected into the schema artifact.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work on branch `feat/event-schema`. Clippy must stay clean (`cargo clippy --all-targets -- -D warnings`), `cargo build --locked` green.

## File Structure

- `crates/kata-core/Cargo.toml` — add optional `schemars` dep + `schema` feature. *(modify)*
- `crates/kata-core/src/event.rs` — add `KATA_EVENT_PROTOCOL_VERSION` const, feature-gated `JsonSchema` derives, feature-gated `generate_schema_json()`, the `StreamParser` correlation, and the freshness + correlation tests. *(modify)*
- `schema/kata-events.schema.json` — committed generated artifact (repo root). *(create)*
- `.github/workflows/ci.yml` — add a Rust schema-freshness step and a web TS-freshness step. *(modify)*
- `app/package.json` — add `json-schema-to-typescript` devDependency + `gen:events` script. *(modify)*
- `app/src/bindings/kata-events.ts` — generated TypeScript event types. *(create)*
- `app/src/lib/events.ts` — replace the hand-written type block with re-exports; keep helpers. *(modify)*
- `app/src/lib/events.test.ts` — add one-event-per-family type/round-trip coverage. *(modify)*

---

### Task 1: Derive `schemars::JsonSchema` on the event types (feature-gated)

**Files:**
- Modify: `crates/kata-core/Cargo.toml`
- Modify: `crates/kata-core/src/event.rs`

**Interfaces:**
- Produces: a new Cargo feature `schema` that turns on `schemars`; `KataEvent`, `DiffFile`, `Question`, `QuestionKind`, `QuestionOption` implement `schemars::JsonSchema` when built with `--features schema`. `pub const KATA_EVENT_PROTOCOL_VERSION: u32 = 1;` in `event.rs`.

- [ ] **Step 1: Add the optional dependency and feature**

In `crates/kata-core/Cargo.toml`, under `[dependencies]` add after the `ts-rs` line:

```toml
schemars = { version = "1", optional = true }
```

Under `[features]` add:

```toml
schema = ["dep:schemars"]
```

- [ ] **Step 2: Add the protocol-version const and the derives**

In `crates/kata-core/src/event.rs`, immediately below `use std::io::BufRead;` add:

```rust
/// Wire-protocol version of the `KataEvent` stream. Bump on any breaking
/// change to an event shape. Stamped into `schema/kata-events.schema.json`
/// so consumers can pin and detect breaks.
pub const KATA_EVENT_PROTOCOL_VERSION: u32 = 1;
```

Add `#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]` to the `derive` line of **each** of these five types (place it directly above the existing `#[serde(...)]` attributes, leaving those untouched): `KataEvent`, `DiffFile`, `Question`, `QuestionKind`, `QuestionOption`.

Example for `KataEvent`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "type")]
pub enum KataEvent {
```

- [ ] **Step 3: Write the failing test (schema reflects the wire tagging)**

Add to the `mod tests` block in `event.rs`:

```rust
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cargo test -p kata-core --features schema schema_is_internally_tagged`
Expected: FAIL to *compile* first if a derive is missing (`schemars` trait not implemented), then PASS once Steps 1–2 are in. If it compiles and passes immediately, confirm Steps 1–2 were applied; the test is the guard for the derive wiring.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p kata-core --features schema schema_is_internally_tagged`
Expected: PASS

- [ ] **Step 6: Verify the default build is unaffected**

Run: `cargo build -p kata-core` then `cargo build -p kata-cli`
Expected: both succeed and do **not** compile `schemars` (feature off by default).

- [ ] **Step 7: Commit**

```bash
git add crates/kata-core/Cargo.toml crates/kata-core/src/event.rs Cargo.lock
git commit -m "feat(core): derive JsonSchema on KataEvent behind a schema feature

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Emit and commit the versioned schema artifact with a freshness guard

**Files:**
- Modify: `crates/kata-core/src/event.rs`
- Create: `schema/kata-events.schema.json`

**Interfaces:**
- Consumes: `KATA_EVENT_PROTOCOL_VERSION`, `JsonSchema` derives from Task 1.
- Produces: `pub fn generate_schema_json() -> String` (feature-gated `schema`) returning the canonical, `protocolVersion`-stamped, `title`-normalized, pretty JSON with a trailing newline. Committed artifact at repo-root `schema/kata-events.schema.json`.

- [ ] **Step 1: Add the generator function**

In `event.rs`, add near the top-level functions (outside `mod tests`, gated on the feature):

```rust
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
```

- [ ] **Step 2: Write the failing freshness test**

Add to `mod tests`:

```rust
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
```

- [ ] **Step 3: Run to verify it fails (artifact missing)**

Run: `cargo test -p kata-core --features schema schema_artifact_is_fresh`
Expected: FAIL with the "schema/kata-events.schema.json missing" panic.

- [ ] **Step 4: Generate the committed artifact**

Run (PowerShell): `$env:KATA_BLESS_SCHEMA=1; cargo test -p kata-core --features schema schema_artifact_is_fresh; Remove-Item Env:KATA_BLESS_SCHEMA`
Expected: PASS (writes `schema/kata-events.schema.json`).

- [ ] **Step 5: Confirm the artifact and re-run in assert mode**

Run: `cargo test -p kata-core --features schema schema_artifact_is_fresh`
Expected: PASS. Open `schema/kata-events.schema.json` and confirm it contains `"protocolVersion": 1`, `"title": "KataEvent"`, and a `"oneOf"` array. Confirm the file ends with a single newline and uses LF.

- [ ] **Step 6: Commit**

```bash
git add crates/kata-core/src/event.rs schema/kata-events.schema.json
git commit -m "feat(core): publish versioned kata-events JSON schema with drift guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Enforce schema freshness in CI (Rust job)

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `schema_artifact_is_fresh` test from Task 2.

- [ ] **Step 1: Add the freshness step**

In `.github/workflows/ci.yml`, in the `rust` job's `steps`, add immediately **before** the `Build (locked)` step:

```yaml
      - name: Schema freshness (regenerate & diff)
        # Fails if schema/kata-events.schema.json has drifted from the enum.
        # Regenerate locally with:
        #   KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema schema_artifact_is_fresh
        run: cargo test -p kata-core --features schema schema_artifact_is_fresh
```

- [ ] **Step 2: Verify the workflow parses**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!y.includes('Schema freshness')) throw new Error('step missing'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: fail on kata-events schema drift

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Generate the TypeScript event types from the schema and retire the hand-mirror

**Files:**
- Modify: `app/package.json`
- Create: `app/src/bindings/kata-events.ts`
- Modify: `app/src/lib/events.ts`
- Modify: `app/src/lib/events.test.ts`

**Interfaces:**
- Consumes: `schema/kata-events.schema.json` from Task 2.
- Produces: `app/src/bindings/kata-events.ts` exporting `KataEvent`, `Question`, `QuestionKind`, `QuestionOption`, `DiffFile`. `app/src/lib/events.ts` re-exports those names (stable import path preserved) and keeps all helpers.

- [ ] **Step 1: Add the codegen tool and script**

In `app/package.json`, add to `devDependencies`:

```json
    "json-schema-to-typescript": "^15.0.4",
```

Add to `scripts` (after `"sidecar"`):

```json
    "gen:events": "json2ts -i ../schema/kata-events.schema.json -o src/bindings/kata-events.ts --no-additionalProperties --bannerComment \"/* Generated from schema/kata-events.schema.json by 'npm run gen:events'. DO NOT EDIT. */\"",
```

Run: `cd app && npm install`
Expected: `json-schema-to-typescript` installed; `package-lock.json` updated.

- [ ] **Step 2: Generate the types**

Run: `cd app && npm run gen:events`
Expected: creates `app/src/bindings/kata-events.ts`. Open it and confirm it exports a `KataEvent` union and `Question`, `QuestionKind`, `QuestionOption`, `DiffFile`. If the root union is named other than `KataEvent`, stop — re-check that Task 2 Step 5 shows `"title": "KataEvent"` in the schema (json2ts derives the name from `title`).

- [ ] **Step 3: Normalize line endings (if needed)**

Confirm `app/src/bindings/kata-events.ts` uses LF (match sibling ts-rs files). If json2ts emitted CRLF on Windows, convert:

Run (PowerShell): `(Get-Content app/src/bindings/kata-events.ts -Raw) -replace "`r`n","`n" | Set-Content -NoNewline app/src/bindings/kata-events.ts`

- [ ] **Step 4: Rewrite `events.ts` to re-export the generated types**

In `app/src/lib/events.ts`, replace the block from `export type KataEvent =` (line 12) through the end of the `Question` type declaration (the closing `};` at line 44) with:

```ts
import type {
  KataEvent,
  Question,
  QuestionKind,
  QuestionOption,
  DiffFile,
} from "../bindings/kata-events";
export type { KataEvent, Question, QuestionKind, QuestionOption, DiffFile };
```

Leave everything above line 12 (the module doc comment, the `RunRecord` import/re-export, and `RunDetail`) and everything from line 46 onward (all helpers) unchanged. Update the top module comment's parenthetical from "mirrors kata-core::event" to "generated from schema/kata-events.schema.json".

- [ ] **Step 5: Write the failing test (one event per family type-checks)**

Append to `app/src/lib/events.test.ts` (import `KataEvent` from `./events` if not already imported at the top of the file):

```ts
import { describe, it, expect } from "vitest";
import type { KataEvent } from "./events";
import { isStreamEvent, statusForExit } from "./events";

describe("generated KataEvent types", () => {
  it("accepts one representative event per family", () => {
    const events: KataEvent[] = [
      { type: "run.started", spec: "s", model: null, workdir: "/w", isolation: "none" },
      { type: "log", level: "info", message: "hi" },
      { type: "turn", n: 1 },
      { type: "assistant.text", text: "hello" },
      { type: "tool.use", name: "Bash", input_summary: "ls" },
      { type: "tool.result", name: "Bash", ok: true, summary: "ok" },
      { type: "run.completed", exit_code: 0, is_error: false, num_turns: 2, cost_usd: 0.01, duration_ms: 100, result: "done" },
      { type: "run.diff", worktree: "/wt", branch: "b", files: [{ status: "M", path: "a.rs" }], insertions: 1, deletions: 0 },
      { type: "ask.requested", id: "q1", questions: [{ kind: "select", header: "h", question: "?", options: [{ label: "A" }] }] },
      { type: "ask.answered", id: "q1", answers: [["A"]] },
      { type: "run.error", message: "boom", exit_code: 125 },
      { type: "run.cancelled", exit_code: 130 },
    ];
    expect(events).toHaveLength(12);
    expect(isStreamEvent({ type: "assistant.text", text: "x" })).toBe(true);
    expect(statusForExit(0)).toBe("success");
  });
});
```

- [ ] **Step 6: Run type-check and tests**

Run: `cd app && npm run check`
Expected: PASS (0 errors). If the generated union rejects a literal above, the discriminant/field names in `kata-events.ts` diverge from the wire — reconcile by inspecting the generated type, not by loosening the test.

Run: `cd app && npm test`
Expected: all Vitest suites PASS, including the new case.

- [ ] **Step 7: Commit**

```bash
git add app/package.json app/package-lock.json app/src/bindings/kata-events.ts app/src/lib/events.ts app/src/lib/events.test.ts
git commit -m "feat(app): generate KataEvent TS types from schema; retire hand-mirror

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Enforce TS-types freshness in CI (web job)

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `gen:events` script (Task 4) and the committed `schema/kata-events.schema.json` (checked out with the repo).

- [ ] **Step 1: Add the freshness step**

In `.github/workflows/ci.yml`, in the `web` job's `steps`, add immediately **after** the `Install dependencies` step (the job's `working-directory` is `app`):

```yaml
      - name: Event types freshness (regenerate & diff)
        # Regenerate the TS event types from the committed schema and fail on
        # drift. Regenerate locally with: (cd app && npm run gen:events)
        run: |
          npm run gen:events
          git diff --exit-code src/bindings/kata-events.ts
```

- [ ] **Step 2: Verify the workflow parses**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!y.includes('Event types freshness')) throw new Error('step missing'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: fail on drift between schema and generated event types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Correlate `tool.result` back to its `tool.use`

**Files:**
- Modify: `crates/kata-core/src/event.rs`

**Interfaces:**
- Consumes: existing `KataEvent`, `Parsed`, `parse_stream_line`, `pump`.
- Produces: `pub struct StreamParser` with `fn push(&mut self, line: &str) -> Parsed` that fills `KataEvent::ToolResult.name` by correlating Claude's `tool_use_id` to the originating `tool_use` block's `id`+`name`. `parse_stream_line` stays as a stateless one-line convenience wrapper. Wire shapes unchanged.

- [ ] **Step 1: Write the failing correlation test**

Add to `mod tests` in `event.rs`:

```rust
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
        }]
    );
}

#[test]
fn stream_parser_leaves_name_empty_when_uncorrelated() {
    // A result whose tool_use was never seen keeps an empty name (no panic).
    let mut p = StreamParser::default();
    let res_line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"ok","is_error":false}]}}"#;
    let parsed = p.push(res_line);
    assert_eq!(parsed.events[0], KataEvent::ToolResult { name: String::new(), ok: true, summary: "ok".into() });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kata-core stream_parser_correlates`
Expected: FAIL to compile — `StreamParser` does not exist yet.

- [ ] **Step 3: Introduce the stateful parser**

In `event.rs`, refactor parsing into a stateful struct. Replace the free `pub fn parse_stream_line(line: &str) -> Parsed` with a thin wrapper and move the body into `StreamParser::push`. Concretely:

Add above `parse_stream_line`:

```rust
use std::collections::HashMap;

/// Stateful translator for a `stream-json` line sequence. Holds the
/// `tool_use_id → tool name` map so `tool.result` events can be labelled with
/// the tool that produced them (Claude's `tool_result` carries only the id).
#[derive(Debug, Default)]
pub struct StreamParser {
    tool_names: HashMap<String, String>,
}

impl StreamParser {
    pub fn push(&mut self, line: &str) -> Parsed {
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
                                    out.events.push(KataEvent::AssistantText { text: t.to_string() });
                                }
                            }
                            Some("tool_use") => {
                                let name = block
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                // Record id → name for later tool_result correlation,
                                // even for ask_user (harmless; its result is suppressed).
                                if let Some(id) = block.get("id").and_then(|i| i.as_str()) {
                                    self.tool_names.insert(id.to_string(), name.clone());
                                }
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
                            let name = block
                                .get("tool_use_id")
                                .and_then(|i| i.as_str())
                                .and_then(|id| self.tool_names.get(id))
                                .cloned()
                                .unwrap_or_default();
                            out.events.push(KataEvent::ToolResult {
                                name,
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
}
```

Then replace the old function body so it delegates:

```rust
/// Translate one line of Claude `stream-json` into normalized events.
/// Stateless convenience wrapper over [`StreamParser`]; a `tool.result` whose
/// `tool_use` arrived on an earlier line will have an empty `name` here — use
/// [`StreamParser`] across a stream to correlate. Defensive: unknown shapes
/// and malformed JSON yield an empty `Parsed`.
pub fn parse_stream_line(line: &str) -> Parsed {
    StreamParser::default().push(line)
}
```

Delete the old inline `match` body that previously lived in `parse_stream_line` (it now lives in `StreamParser::push`).

- [ ] **Step 4: Make `pump` use a persistent parser**

In `pump`, replace `let parsed = parse_stream_line(&line);` with a parser created once before the loop:

Before the `for line in reader.lines()` loop, add:

```rust
    let mut parser = StreamParser::default();
```

Inside the loop, change:

```rust
        let parsed = parse_stream_line(&line);
```

to:

```rust
        let parsed = parser.push(&line);
```

- [ ] **Step 5: Run the new and existing tests**

Run: `cargo test -p kata-core stream_parser`
Expected: PASS (both new tests).

Run: `cargo test -p kata-core`
Expected: PASS — all pre-existing `event.rs` tests still green (`parses_tool_result` still asserts an empty name because it calls the stateless `parse_stream_line` with only the result line).

- [ ] **Step 6: Update the correlation TODO and verify pump behavior**

Confirm the old `// TODO: claude tool_result carries a tool_use_id …` comment no longer exists (it was inside the moved body; ensure the new code does not reintroduce it). Add a pump-level test:

```rust
#[test]
fn pump_labels_tool_results_across_lines() {
    let input = concat!(
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Read","input":{"command":"cat x"}}]}}"#,
        "\n",
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"data","is_error":false}]}}"#,
        "\n",
    );
    let mut events = Vec::new();
    let _ = pump(std::io::Cursor::new(input), &|| false, &mut |e| events.push(e));
    assert!(events.contains(&KataEvent::ToolResult {
        name: "Read".into(),
        ok: true,
        summary: "data".into(),
    }));
}
```

Run: `cargo test -p kata-core pump_labels_tool_results`
Expected: PASS.

- [ ] **Step 7: Clippy + full workspace**

Run: `cargo clippy --all-targets -- -D warnings`
Expected: clean.
Run: `cargo test --workspace`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/kata-core/src/event.rs
git commit -m "feat(core): correlate tool.result to its tool.use by tool_use_id

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Final verification and docs touch-up

**Files:**
- Modify: `crates/kata-core/src/event.rs` doc comment on `Question` (remove the stale "mirrored by hand" note).
- Modify: `CLAUDE.md` (document the new schema artifact + regen commands).

**Interfaces:** none new.

- [ ] **Step 1: Fix the stale `Question` doc comment**

In `event.rs`, change the `Question` doc comment from:

```rust
/// One question in an `ask.requested` batch. Mirrored by hand in
/// `app/src/lib/events.ts` (events are not ts-rs exported).
```

to:

```rust
/// One question in an `ask.requested` batch. Part of the published event
/// schema (`schema/kata-events.schema.json`); the app's TS type is generated
/// from that schema, not hand-mirrored.
```

- [ ] **Step 2: Document the schema in CLAUDE.md**

In `D:\Repos\kata\CLAUDE.md`, in the "Two contracts that cross language boundaries" section, after the `RunSpec` ts-rs paragraph, add:

```markdown
The **event protocol** is published as a JSON Schema at `schema/kata-events.schema.json`, generated from `KataEvent` via `schemars` (gated behind the `schema` Cargo feature) and stamped with `protocolVersion`. Regenerate after changing any event type: `KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema schema_artifact_is_fresh`. The Workbench's TS event types (`app/src/bindings/kata-events.ts`) are generated from that schema with `cd app && npm run gen:events`; `app/src/lib/events.ts` re-exports them and adds hand-written render/status helpers. CI fails on drift in either direction.
```

- [ ] **Step 3: Full green run**

Run: `cargo test --workspace`
Expected: PASS.
Run: `cargo test -p kata-core --features schema`
Expected: PASS (schema tests included).
Run: `cargo clippy --all-targets -- -D warnings`
Expected: clean.
Run: `cd app && npm run check && npm test`
Expected: PASS.

- [ ] **Step 4: Confirm the shipped binary stays schemars-free**

Run: `cargo build -p kata-cli --locked` then inspect: `cargo tree -p kata-cli -i schemars`
Expected: `cargo tree` reports schemars is **not** in kata-cli's dependency graph (feature off).

- [ ] **Step 5: Commit**

```bash
git add crates/kata-core/src/event.rs CLAUDE.md
git commit -m "docs: document the published kata-events schema and regen flow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Publish a schema from source of truth → Tasks 1–2 (schemars derive + `generate_schema_json` + committed artifact). ✓
- Emit as a committed artifact + CI freshness check → Task 2 (artifact) + Task 3 (Rust CI). ✓
- Version the protocol (`protocolVersion`) → Task 2 (`KATA_EVENT_PROTOCOL_VERSION` injected). ✓
- Retire the hand-mirror; generate `events.ts` → Task 4. ✓
- `schemars` over `ts-rs` → Global Constraints + Task 1. ✓
- Keep existing serde round-trip tests unchanged → Global Constraints; Tasks add tests, never edit the existing ones. ✓
- Round-trip through generated TS for one event per family → Task 4 Step 5. ✓
- Optional item 2 (`tool.result` correlation) → Task 6. ✓
- Optional item 1 (`notify`) and the .NET package → explicitly out of scope (spec's "Session scope & resolved decisions"). Not planned. ✓
- Cross-runtime conformance fixture → deferred with the .NET runtime (no second runtime exists this session; nothing to conform against). Noted, not planned.

**Placeholder scan:** No TBD/TODO/"handle edge cases" left; every code step carries full code. The one remaining runtime `TODO` comment in `event.rs` is explicitly *removed* in Task 6 Step 6. ✓

**Type consistency:** `StreamParser`, `push`, `generate_schema_json`, `KATA_EVENT_PROTOCOL_VERSION`, and the `schema`/`ts` features are referenced identically across tasks. `parse_stream_line` retains its signature. `KataEvent` variant/field names in the TS test match `event.rs` exactly. ✓

**Risk note:** Task 4 depends on `json-schema-to-typescript` naming the root union `KataEvent`; Task 2's `title` injection makes that deterministic. If the generated discriminated union ever fails to accept a literal in the Task 4 test, that is a *real* schema/wire mismatch to reconcile in the schema, not a test to loosen.
