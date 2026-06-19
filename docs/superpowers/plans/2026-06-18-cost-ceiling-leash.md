# Cost-ceiling Leash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-spec dollar ceiling to a Kata run, enforced by claude's native `--max-budget-usd`, surfaced through the leash contract as a distinct exit code (122).

**Architecture:** A new optional `leash.max_budget_usd` field flows into `build_invocation` as `--max-budget-usd`. When claude hits the ceiling it self-exits (code 1) and emits a terminal `result` with `subtype == "error_max_budget_usd"`. The engine detects that subtype and overrides the outcome to exit 122 + a `RunError`, joining the timeout/turn-cap leash family. The Workbench gains a budget field; the field is absent-by-default so all existing specs are unchanged.

**Tech Stack:** Rust (Cargo workspace: `kata-core`, `kata-cli`), ts-rs binding generation, SvelteKit/TypeScript (Svelte 5) Workbench.

## Global Constraints

- TDD: write the failing test first, watch it fail, then implement.
- `cargo clippy --all-targets -- -D warnings` must stay clean.
- `cargo build --locked` must stay green.
- Do not hand-edit `app/src/bindings/`; regenerate with `cargo test -p kata-core --features ts export_bindings`.
- Engine integration tests that mutate process-global env (`KATA_FAKE_MODE`) are `#[serial]`; keep that.
- Exit-code contract is part of the CI/orchestrator interface — preserve existing codes (130/125/124/123) and add **122 = budget ceiling reached**.
- Work on branch `feat/cost-ceiling-leash` (already created). Frequent commits, one per task.
- The cap is **approximate** (claude checks the budget at turn boundaries and overshoots by up to one turn). Any user-facing copy must not imply a hard real-time cap.
- Frontend: style only against CSS custom properties; the new field reuses existing `.k-input` / `Field` primitives (no new styling).

---

### Task 1: Spec contract — `leash.max_budget_usd`

**Files:**
- Modify: `crates/kata-core/src/spec.rs` (the `Leash` struct, its `Default`, `validate`, and the `full_spec()` test helper)
- Test: `crates/kata-core/src/spec.rs` (`#[cfg(test)] mod tests`)
- Regenerate: `app/src/bindings/Leash.ts`

**Interfaces:**
- Produces: `Leash { max_turns: u32, timeout_secs: Option<u64>, max_budget_usd: Option<f64>, isolation: Isolation }`. Later tasks read `spec.leash.max_budget_usd: Option<f64>`.

- [ ] **Step 1: Write the failing tests**

Add to `spec.rs` `mod tests`:

```rust
#[test]
fn parses_max_budget_usd() {
    let toml = r#"
schema = 1
name = "a"
task = "t"
workdir = "/w"

[leash]
max_budget_usd = 5.0
"#;
    let spec: RunSpec = toml::from_str(toml).unwrap();
    assert_eq!(spec.leash.max_budget_usd, Some(5.0));
}

#[test]
fn budget_defaults_to_none() {
    let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
    assert_eq!(spec.leash.max_budget_usd, None);
}

#[test]
fn validate_rejects_nonpositive_budget() {
    let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
    spec.leash.max_budget_usd = Some(0.0);
    let errs = validate(&spec).unwrap_err();
    assert!(errs.iter().any(|e| e.contains("max_budget_usd")));
}

#[test]
fn validate_accepts_positive_budget() {
    let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
    spec.leash.max_budget_usd = Some(2.5);
    assert!(validate(&spec).is_ok());
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kata-core spec:: 2>&1 | tail -20`
Expected: compile error — `Leash` has no field `max_budget_usd`.

- [ ] **Step 3: Add the field, default, and validation**

In `spec.rs`, the `Leash` struct (insert after `timeout_secs`):

```rust
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<f64>"))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_budget_usd: Option<f64>,
```

Update `impl Default for Leash`:

```rust
impl Default for Leash {
    fn default() -> Self {
        Self { max_turns: default_max_turns(), timeout_secs: None, max_budget_usd: None, isolation: Isolation::None }
    }
}
```

In `validate`, after the `max_turns` check:

```rust
    if let Some(b) = spec.leash.max_budget_usd {
        if b <= 0.0 { errs.push("leash.max_budget_usd must be > 0".into()); }
    }
```

Fix the existing `full_spec()` test helper's explicit `Leash` literal to include the new field:

```rust
            leash: Leash { max_turns: 8, timeout_secs: Some(600), max_budget_usd: None, isolation: Isolation::Worktree },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kata-core spec:: 2>&1 | tail -20`
Expected: PASS (all spec tests, including the four new ones).

- [ ] **Step 5: Regenerate TS bindings and verify**

Run: `cargo test -p kata-core --features ts export_bindings`
Then confirm `app/src/bindings/Leash.ts` now reads (order may vary):

```ts
export type Leash = { max_turns: number, timeout_secs?: number | null, max_budget_usd?: number | null, isolation: Isolation, };
```

- [ ] **Step 6: Clippy + commit**

```bash
cargo clippy -p kata-core --all-targets -- -D warnings
git add crates/kata-core/src/spec.rs app/src/bindings/Leash.ts
git commit -m "feat(spec): leash.max_budget_usd field + validation"
```

---

### Task 2: Command flag — `--max-budget-usd`

**Files:**
- Modify: `crates/kata-core/src/command.rs` (`build_invocation`)
- Test: `crates/kata-core/src/command.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `spec.leash.max_budget_usd: Option<f64>` from Task 1.
- Produces: when `Some(b)`, the two args `["--max-budget-usd", "<b>"]` appear in `inv.args` (formatted via `format!("{b}")`, e.g. `5.0` → `"5"`, `0.5` → `"0.5"`).

- [ ] **Step 1: Write the failing tests**

Add to `command.rs` `mod tests`:

```rust
#[test]
fn includes_max_budget_when_set() {
    let mut s = spec();
    s.leash.max_budget_usd = Some(5.0);
    let inv = build_invocation(&s, &assembled_with(None, None));
    assert!(
        inv.args.windows(2).any(|w| w[0] == "--max-budget-usd" && w[1] == "5"),
        "expected --max-budget-usd 5, got {:?}", inv.args
    );
}

#[test]
fn omits_max_budget_when_unset() {
    let inv = build_invocation(&spec(), &assembled_with(None, None));
    assert!(!inv.args.iter().any(|a| a == "--max-budget-usd"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kata-core command:: 2>&1 | tail -20`
Expected: FAIL — `includes_max_budget_when_set` (no such flag emitted).

- [ ] **Step 3: Emit the flag**

In `build_invocation`, after the `--model` block and before `--output-format`:

```rust
    if let Some(b) = spec.leash.max_budget_usd {
        args.push("--max-budget-usd".into());
        args.push(format!("{b}"));
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kata-core command:: 2>&1 | tail -20`
Expected: PASS (both new tests + the unchanged base-command test).

- [ ] **Step 5: Clippy + commit**

```bash
cargo clippy -p kata-core --all-targets -- -D warnings
git add crates/kata-core/src/command.rs
git commit -m "feat(command): pass --max-budget-usd when leash sets a ceiling"
```

---

### Task 3: Event detection — `ResultPayload.subtype` + `is_budget_exhausted`

**Files:**
- Modify: `crates/kata-core/src/event.rs` (`ResultPayload` struct, `parse_stream_line` result arm, new impl)
- Test: `crates/kata-core/src/event.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `ResultPayload` gains `pub subtype: Option<String>`, and `impl ResultPayload { pub fn is_budget_exhausted(&self) -> bool }` returning true iff `subtype == Some("error_max_budget_usd")`. Task 4 calls `payload.is_budget_exhausted()`.

- [ ] **Step 1: Write the failing test**

Add to `event.rs` `mod tests`:

```rust
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kata-core event:: 2>&1 | tail -20`
Expected: compile error — `ResultPayload` has no field `subtype` / no method `is_budget_exhausted`.

- [ ] **Step 3: Add the field, capture, and helper**

In `event.rs`, extend `ResultPayload`:

```rust
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
```

In `parse_stream_line`, the `Some("result")` arm, add the `subtype` capture:

```rust
        Some("result") => {
            out.result = Some(ResultPayload {
                num_turns: v.get("num_turns").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
                cost_usd: v.get("total_cost_usd").and_then(|c| c.as_f64()),
                is_error: v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
                result: v.get("result").and_then(|r| r.as_str()).map(String::from),
                subtype: v.get("subtype").and_then(|s| s.as_str()).map(String::from),
            });
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kata-core event:: 2>&1 | tail -20`
Expected: PASS. (The existing `parses_result_payload` test still passes — it asserts fields individually, not full-struct equality.)

- [ ] **Step 5: Clippy + commit**

```bash
cargo clippy -p kata-core --all-targets -- -D warnings
git add crates/kata-core/src/event.rs
git commit -m "feat(event): capture result.subtype + is_budget_exhausted helper"
```

---

### Task 4: Engine exit mapping → 122, + offline `budget` fake

**Files:**
- Modify: `crates/kata-core/src/run.rs` (the `None`-termination branch + the fallback `ResultPayload` literal)
- Modify: `crates/kata-core/src/bin/fake-claude.rs` (new `budget` mode + doc comment)
- Test: `crates/kata-core/tests/run_it.rs`

**Interfaces:**
- Consumes: `ResultPayload::is_budget_exhausted()` (Task 3); `spec.leash.max_budget_usd` (Task 1).
- Produces: a run that hits the ceiling yields `RunOutcome { exit_code: 122 }` and emits `KataEvent::RunError` as its terminal event.

- [ ] **Step 1: Add the offline `budget` fake mode**

In `fake-claude.rs`, update the doc comment on line 4 to append `| "budget"`, and add this arm inside the `match mode.as_str()` (next to `"fail"`):

```rust
        "budget" => {
            // Mirror real claude hitting --max-budget-usd: one assistant turn, then
            // a terminal result tagged error_max_budget_usd with a non-zero spend,
            // and a generic exit 1. The engine must override that 1 to exit 122.
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"working"}}]}}}}"#);
            let _ = writeln!(out, r#"{{"type":"result","subtype":"error_max_budget_usd","is_error":true,"num_turns":1,"total_cost_usd":0.05,"result":null,"errors":["Reached maximum budget ($0.01)"]}}"#);
            let _ = out.flush();
            std::process::exit(1);
        }
```

- [ ] **Step 2: Write the failing integration test**

Add to `run_it.rs`:

```rust
#[test]
#[serial]
fn run_budget_exhausted_reports_122() {
    with_fake("budget");
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.max_budget_usd = Some(0.01);
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, &kata_core::run::AnswerRx::default(), |e| events.push(e)).unwrap();

    assert_eq!(outcome.exit_code, 122, "budget exhaustion must map to exit 122");
    match events.last().unwrap() {
        KataEvent::RunError { message } => assert!(
            message.contains("budget"),
            "terminal RunError should mention the budget, got: {message}"
        ),
        other => panic!("expected RunError terminal event, got {other:?}"),
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p kata-core --test run_it run_budget_exhausted_reports_122 2>&1 | tail -25`
Expected: FAIL — `exit_code` is `1` (claude's generic code) and the terminal event is `RunCompleted`, not `RunError`.

- [ ] **Step 4: Map budget exhaustion to 122 in `run.rs`**

First, the fallback `ResultPayload` literal in the `None` branch must gain the new field. Replace the existing literal:

```rust
            let payload = result.unwrap_or(crate::event::ResultPayload {
                num_turns: turns, cost_usd: None, is_error: code != 0, result: None, subtype: None,
            });
```

Then replace the single `RunCompleted` construction in that branch with a budget check:

```rust
            if payload.is_budget_exhausted() {
                let ceiling = spec.leash.max_budget_usd.unwrap_or(0.0);
                let spent = payload.cost_usd.unwrap_or(0.0);
                (122, KataEvent::RunError {
                    message: format!("budget ceiling ${ceiling:.2} reached; spent ${spent:.2}"),
                })
            } else {
                (code, KataEvent::RunCompleted {
                    exit_code: code,
                    is_error: payload.is_error,
                    num_turns: payload.num_turns,
                    cost_usd: payload.cost_usd,
                    duration_ms: start.elapsed().as_millis() as u64,
                    result: payload.result,
                })
            }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p kata-core --test run_it run_budget_exhausted_reports_122 2>&1 | tail -25`
Expected: PASS.

- [ ] **Step 6: Full engine suite + clippy**

Run: `cargo test -p kata-core 2>&1 | tail -15` (all pass, no regressions)
Run: `cargo clippy -p kata-core --all-targets -- -D warnings`

- [ ] **Step 7: Commit**

```bash
git add crates/kata-core/src/run.rs crates/kata-core/src/bin/fake-claude.rs crates/kata-core/tests/run_it.rs
git commit -m "feat(run): map budget exhaustion to exit 122 + RunError"
```

---

### Task 5: Workbench — budget field in the leash section

**Files:**
- Modify: `app/src/lib/components/ComposePane.svelte` (coercion fn + leash grid field)
- Modify: `app/src/lib/spec.ts` (default spec leash literal)
- Modify: `app/src/lib/mock.ts` (any leash literal in the fixture spec — add `max_budget_usd: null`)

**Interfaces:**
- Consumes: the regenerated `Leash` type (`max_budget_usd?: number | null`) from Task 1.
- Produces: editing the field sets `spec.leash.max_budget_usd` to a positive number, or `null` when blank/invalid. No new event handling — a budget stop arrives as the already-rendered `RunError`.

- [ ] **Step 1: Add the default to `spec.ts`**

In `app/src/lib/spec.ts`, the `emptySpec()` leash literal:

```ts
    leash: { max_turns: 12, timeout_secs: null, max_budget_usd: null, isolation: "none" },
```

- [ ] **Step 2: Update the mock fixture**

Run: `npm --prefix app run check 2>&1 | tail -20` to see if `mock.ts` has a now-incomplete `leash` literal.
If `mock.ts` constructs a `leash` object literal, add `max_budget_usd: null` to it (matching `timeout_secs`). If it spreads/derives from `emptySpec()`, no change is needed.

- [ ] **Step 3: Add the coercion handler in `ComposePane.svelte`**

In the `<script>` block, next to `onTimeout`:

```ts
  // Float-coerce the budget ceiling (null = no ceiling). Reject <= 0.
  function onMaxBudget(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value.trim();
    if (v === "") {
      spec.leash.max_budget_usd = null;
      return;
    }
    const n = Number(v);
    spec.leash.max_budget_usd = Number.isFinite(n) && n > 0 ? n : null;
  }
```

- [ ] **Step 4: Add the field to the leash grid**

In the leash `<section>`, inside the existing `<div class="wb-grid-2">` (so it pairs visually under turns/timeout), add a second row — change the single grid to hold the budget field as well, e.g. add after the Timeout `Field`:

```svelte
      <Field label="Max budget (USD)" key="max_budget_usd" hint="Claude-native ceiling → exit 122 (approximate; checked at turn boundaries).">
        <input class="k-input" type="number" min="0" step="0.01" placeholder="(none)" value={spec.leash.max_budget_usd ?? ""} oninput={onMaxBudget} />
      </Field>
```

(The two-column `wb-grid-2` will flow this onto a second row; no layout/CSS change required.)

- [ ] **Step 5: Type-check + test**

Run: `npm --prefix app run check 2>&1 | tail -20`
Expected: no errors.
Run: `npm --prefix app test 2>&1 | tail -20`
Expected: PASS (update any spec/snapshot test that asserts the full `leash` shape to include `max_budget_usd: null`; `spec.test.ts` is the likely spot).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/components/ComposePane.svelte app/src/lib/spec.ts app/src/lib/mock.ts
git commit -m "feat(workbench): max budget (USD) field in the leash section"
```

---

### Task 6: Docs — exit-code contract + roadmap

**Files:**
- Modify: `CLAUDE.md` (the "Exit-code semantics (the leash)" paragraph)
- Modify: `ROADMAP.md` (Phase 4 item 5)

**Interfaces:** None (documentation only).

- [ ] **Step 1: Update the exit-code semantics in `CLAUDE.md`**

In the "Exit-code semantics (the leash)" section, extend the mapping sentence to include budget, and add a clarifying line. Change:

> The engine maps run outcomes to process exit codes, and the CLI surfaces them: turn cap → **125**, wall-clock timeout → **124**, answer deadline exceeded → **123**, cancel → **130**.

to:

> The engine maps run outcomes to process exit codes, and the CLI surfaces them: turn cap → **125**, wall-clock timeout → **124**, answer deadline exceeded → **123**, budget ceiling reached → **122**, cancel → **130**.

And append to that paragraph:

> Exit 122 is reached only when `leash.max_budget_usd` is set and claude stops on its native `--max-budget-usd` (a post-turn check, so the actual spend can overshoot the ceiling by up to one turn); the engine detects the `error_max_budget_usd` result subtype and overrides claude's generic exit 1.

- [ ] **Step 2: Mark the roadmap item done**

In `ROADMAP.md`, Phase 4, change:

```
- [ ] Cost-ceiling leash (kill on `cost_usd` budget) once cost is reliably present in stream-json.
```

to:

```
- [x] **Cost-ceiling leash.** Per-spec `leash.max_budget_usd`, enforced by claude's native `--max-budget-usd`; the engine maps the `error_max_budget_usd` result subtype to a distinct exit code (**122**) in the leash family. The cap is approximate (post-turn check, overshoots by up to one turn). Workbench leash field included.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md ROADMAP.md
git commit -m "docs: exit 122 budget-ceiling leash in contract + roadmap"
```

---

### Final verification (before PR)

- [ ] `cargo test --workspace 2>&1 | tail -15` — all green.
- [ ] `cargo clippy --all-targets -- -D warnings` — clean.
- [ ] `cargo build --locked` — green.
- [ ] `npm --prefix app run check` and `npm --prefix app test` — green.
- [ ] `git diff --stat main` — confirms only the six areas above changed.
- [ ] Invoke superpowers:requesting-code-review, then superpowers:finishing-a-development-branch to open the PR.

## Notes for the implementer

- **Why exit 122 and not a `Termination` variant:** budget exhaustion is claude-initiated — the child exits on its own and emits a terminal `result`, so it flows through the `None`-termination branch (no `child.kill()`). The other leash codes (124/125/123) are engine-initiated kills in the `Some(term)` branch. Do not add a `Termination::Budget`; detect it from the result payload instead.
- **The cap is approximate by design.** Don't try to make it precise (e.g. by killing mid-turn on a running cost estimate) — that's an explicit non-goal in the spec. claude's post-turn check is the contract.
- **Backward compatibility:** every change keys off `Option` being `Some`; an absent `max_budget_usd` produces byte-for-byte the old invocation and the old exit behavior.
