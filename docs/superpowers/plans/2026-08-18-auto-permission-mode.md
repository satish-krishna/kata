# Auto Permission Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third run-spec permission mode, `auto`, that runs Claude Code's classifier-gated autonomy with operator checkpoints routed through Kata's existing `approve_tool` bridge via a new `permissions.ask` rule list.

**Architecture:** `PermissionMode` gains an `Auto` variant; `Permissions` gains an `ask: Vec<String>` rule list honored under both `prompt` and `auto`. `auto` emits `--permission-mode auto` plus `--permission-prompt-tool`; the classifier auto-approves routine work and blocks the destructive, while `deny` rules block before it and `ask` rules force the operator prompt. `unmatched` is meaningless under `auto` (the classifier is the unmatched handler) and is rejected there.

**Tech Stack:** Rust (`kata-core`, `kata-cli`), TypeScript/Svelte 5 (Tauri Workbench), ts-rs + schemars for the cross-language contract.

**Spec:** `docs/superpowers/specs/2026-08-18-auto-permission-mode-design.md`

## Global Constraints

- US English only in all code, comments, and docs. No exceptions.
- Markdown files use no hard word wraps: one line per paragraph/bullet.
- TDD: write the failing test first, watch it fail, then implement.
- `cargo fmt --all --check` and `cargo clippy --all-targets -- -D warnings` must be clean before any commit.
- Engine tests run with `cargo test -p kata-core -p kata-cli` (no sidecar staging needed).
- After any `RunSpec` type change, regenerate BOTH the TS bindings AND the run-spec JSON schema; CI fails on drift in either.
- Behavior baseline: real `claude` 2.1.235, whose `--permission-mode` accepts `auto`. Do not hand-edit `app/src/bindings/` or `schema/*.json`.
- Frequent commits: one per task, after its tests pass.

---

### Task 1: Types, flag emission, and contract regeneration

**Files:**
- Modify: `crates/kata-core/src/spec.rs` (the `PermissionMode` enum ~264-275, the `Permissions` struct ~237-256)
- Modify: `crates/kata-core/src/command.rs` (the `match spec.permissions.mode` at ~71-77)
- Regenerate: `app/src/bindings/` (ts-rs), `schema/kata-runspec.schema.json` (schemars)

**Interfaces:**
- Produces: `PermissionMode::Auto` (serde `"auto"`); `Permissions.ask: Vec<String>`. Later tasks rely on both names exactly.

- [ ] **Step 1: Write the failing round-trip test**

Add to `spec.rs` tests (near `permissions_round_trips_through_toml_and_json`):

```rust
#[test]
fn auto_mode_and_ask_rules_round_trip() {
    let mut spec = RunSpec {
        schema: 1,
        name: "n".into(),
        task: "t".into(),
        workdir: "/w".into(),
        ..Default::default()
    };
    spec.permissions.mode = PermissionMode::Auto;
    spec.permissions.ask.push("Bash(git push *)".into());
    let toml = to_toml_string(&spec).unwrap();
    let back = load_from_str(&toml).unwrap();
    assert_eq!(back.permissions.mode, PermissionMode::Auto);
    assert_eq!(back.permissions.ask, vec!["Bash(git push *)"]);
}
```

(If the local helpers are named differently, match the sibling round-trip test's serialization calls exactly.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p kata-core auto_mode_and_ask_rules_round_trip`
Expected: FAIL — `PermissionMode` has no `Auto`, `Permissions` has no `ask`.

- [ ] **Step 3: Add the `Auto` variant**

In `spec.rs`, after the `Prompt` variant of `PermissionMode`:

```rust
    /// Pass `--permission-mode auto` alongside `--permission-prompt-tool`.
    /// Claude routes each call through its classifier — auto-approving routine
    /// work, blocking the irreversible or the exfiltrating — and consults the
    /// prompt tool only for a call a `permissions.ask` rule forces to the
    /// operator. `permissions.deny` still blocks before the classifier, and
    /// `unmatched` has no meaning here: the classifier is the unmatched handler.
    Auto,
```

- [ ] **Step 4: Add the `ask` field**

In `Permissions`, after `deny` and before `unmatched`:

```rust
    /// Rules that force the operator prompt under `mode = "prompt"` or `"auto"`.
    /// Same claude syntax as `allow`/`deny` (`Tool` or `Tool(specifier)`, `*`
    /// wildcard). A matching call is routed to Kata's `approve_tool` and pauses
    /// on the operator, so a non-empty list requires `[interactive] enabled = true`.
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<Vec<String>>"))]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ask: Vec<String>,
```

- [ ] **Step 5: Add the `command.rs` `Auto` arm and a minimal `validate` arm**

In `command.rs`, extend the `match spec.permissions.mode`:

```rust
        PermissionMode::Auto => {
            // Two flags together, deliberately: `auto` runs the classifier, and
            // the prompt tool keeps a route for a `permissions.ask` rule to reach
            // the operator. Drop either and the ask-rule checkpoint silently
            // evaporates. Do not "simplify" this arm.
            args.push("--permission-mode".into());
            args.push("auto".into());
            args.push("--permission-prompt-tool".into());
            args.push(crate::ask::PERMISSION_PROMPT_TOOL.into());
        }
```

In `spec.rs::validate`, add a placeholder arm so the match stays exhaustive (real rules land in Task 2):

```rust
        PermissionMode::Auto => {}
```

- [ ] **Step 6: Write the failing command test**

Add to `command.rs` tests:

```rust
#[test]
fn auto_mode_emits_permission_mode_and_the_prompt_tool() {
    let mut s = spec();
    s.permissions.mode = PermissionMode::Auto;
    let inv = build_invocation(&s, &assembled_with(None, None));
    assert!(inv
        .args
        .windows(2)
        .any(|w| w[0] == "--permission-mode" && w[1] == "auto"));
    assert_eq!(
        flag_value(&inv, "--permission-prompt-tool"),
        Some(crate::ask::PERMISSION_PROMPT_TOOL)
    );
    assert!(!inv
        .args
        .contains(&"--dangerously-skip-permissions".to_string()));
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test -p kata-core auto_mode_and_ask_rules_round_trip auto_mode_emits_permission_mode_and_the_prompt_tool`
Expected: PASS (both).

- [ ] **Step 8: Regenerate the contract artifacts**

Run:
```bash
cargo test -p kata-core --features ts export_bindings
KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema runspec_schema_artifact_is_fresh
```
Expected: `app/src/bindings/*` and `schema/kata-runspec.schema.json` now carry `auto` and `ask`.

- [ ] **Step 9: Verify clean and commit**

Run: `cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test -p kata-core`

```bash
git add crates/kata-core/src/spec.rs crates/kata-core/src/command.rs app/src/bindings schema/kata-runspec.schema.json
git commit -m "feat: add PermissionMode::Auto and permissions.ask (types + flags)"
```

---

### Task 2: Validation rules

**Files:**
- Modify: `crates/kata-core/src/spec.rs` (the `validate` permission block ~485-517)
- Test: `crates/kata-core/src/spec.rs` tests

**Interfaces:**
- Consumes: `PermissionMode::Auto`, `Permissions.ask`, `UnmatchedPolicy`.
- Produces: the validated combinations later UI/mirror tasks assert against.

- [ ] **Step 1: Write the failing validation tests**

Add to `spec.rs` tests:

```rust
#[test]
fn auto_rejects_an_explicit_unmatched_policy() {
    let mut s = valid_spec();
    s.permissions.mode = PermissionMode::Auto;
    s.permissions.unmatched = UnmatchedPolicy::Deny;
    let errs = validate(&s).unwrap_err();
    assert!(
        errs.iter().any(|e| e.contains("unmatched") && e.contains("auto")),
        "auto must reject a set unmatched policy: {errs:?}"
    );
}

#[test]
fn ask_rules_require_interactive() {
    for mode in [PermissionMode::Prompt, PermissionMode::Auto] {
        let mut s = valid_spec();
        s.permissions.mode = mode;
        s.permissions.unmatched = UnmatchedPolicy::Deny; // keep prompt otherwise valid
        s.permissions.ask.push("Bash(git push *)".into());
        s.interactive.enabled = false;
        let errs = validate(&s).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("permissions.ask")),
            "ask rules need interactive ({mode:?}): {errs:?}"
        );
    }
}

#[test]
fn bypass_rejects_ask_rules() {
    let mut s = valid_spec();
    s.permissions.mode = PermissionMode::Bypass;
    s.permissions.ask.push("Bash(git push *)".into());
    let errs = validate(&s).unwrap_err();
    assert!(errs.iter().any(|e| e.contains("ask")), "{errs:?}");
}

#[test]
fn auto_with_ask_and_interactive_is_valid() {
    let mut s = valid_spec();
    s.permissions.mode = PermissionMode::Auto;
    s.permissions.ask.push("Bash(git push *)".into());
    s.interactive.enabled = true;
    assert!(validate(&s).is_ok());
}

#[test]
fn malformed_ask_rule_is_rejected() {
    let mut s = valid_spec();
    s.permissions.mode = PermissionMode::Auto;
    s.interactive.enabled = true;
    s.permissions.ask.push("Bash(unclosed".into());
    let errs = validate(&s).unwrap_err();
    assert!(errs.iter().any(|e| e.contains("permissions.ask")), "{errs:?}");
}
```

(Use whatever the existing valid-spec helper is called; the permission tests around line 1148 show the local construction pattern. If none exists, build the spec inline as those tests do.)

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p kata-core auto_rejects_an_explicit_unmatched_policy ask_rules_require_interactive bypass_rejects_ask_rules auto_with_ask_and_interactive_is_valid malformed_ask_rule_is_rejected`
Expected: FAIL (the minimal `Auto => {}` arm permits everything; `ask` is not yet in the rule loop).

- [ ] **Step 3: Implement the validation rules**

Replace the permission `match` block and the rule-syntax loop in `validate`:

```rust
    match spec.permissions.mode {
        PermissionMode::Bypass => {
            if !spec.permissions.allow.is_empty()
                || !spec.permissions.deny.is_empty()
                || !spec.permissions.ask.is_empty()
            {
                errs.push(
                    "permissions.allow/deny/ask are only consulted under permissions.mode = \
                     \"prompt\" or \"auto\"; under \"bypass\" claude never asks, so the rules \
                     would be ignored"
                        .into(),
                );
            }
        }
        PermissionMode::Prompt => {
            if spec.permissions.unmatched == UnmatchedPolicy::Ask && !spec.interactive.enabled {
                errs.push(
                    "permissions.unmatched = \"ask\" needs an operator to ask: set \
                     [interactive] enabled = true, or choose unmatched = \"deny\" / \"allow\" \
                     for a headless run"
                        .into(),
                );
            }
        }
        PermissionMode::Auto => {
            if spec.permissions.unmatched != UnmatchedPolicy::default() {
                errs.push(
                    "permissions.unmatched has no meaning under permissions.mode = \"auto\": \
                     claude's classifier decides every call no rule matched. Remove it, or use \
                     mode = \"prompt\" to route unmatched calls to the operator."
                        .into(),
                );
            }
        }
    }
    // ask rules pause on the operator, so someone must be there to answer. This
    // holds under both prompt and auto; bypass already rejected them above.
    if !spec.permissions.ask.is_empty()
        && spec.permissions.mode != PermissionMode::Bypass
        && !spec.interactive.enabled
    {
        errs.push(
            "permissions.ask rules pause on the operator: set [interactive] enabled = true, \
             or remove them"
                .into(),
        );
    }
    for (field, rules) in [
        ("permissions.allow", &spec.permissions.allow),
        ("permissions.deny", &spec.permissions.deny),
        ("permissions.ask", &spec.permissions.ask),
    ] {
        for raw in rules {
            if crate::permission::parse_rule(raw).is_none() {
                errs.push(format!(
                    "{field} has a malformed rule '{raw}'; expected 'Tool' or 'Tool(specifier)'"
                ));
            }
        }
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test -p kata-core spec::` (all spec tests, to confirm no existing validation test regressed).
Expected: PASS.

- [ ] **Step 5: Verify clean and commit**

Run: `cargo fmt --all --check && cargo clippy --all-targets -- -D warnings`

```bash
git add crates/kata-core/src/spec.rs
git commit -m "feat: validate auto mode and ask rules"
```

---

### Task 3: Settings generation and bridge gate

**Files:**
- Modify: `crates/kata-core/src/run.rs` (the bridge gate ~275, the settings body ~338-353)
- Test: `crates/kata-core/tests/run_it.rs`

**Interfaces:**
- Consumes: `PermissionMode::Auto`, `Permissions.ask`.
- Produces: an `auto` run advertises `approve_tool` and writes a settings file whose `permissions` object carries `allow`/`deny`/`ask`.

- [ ] **Step 1: Update the existing settings test and add the auto one**

In `run_it.rs`, the existing `prompt_mode_writes_a_settings_file_with_the_spec_rules_verbatim` expects `{allow, deny}`. The settings body will now always include `ask`, so update its `expected` (add `"ask": []`), then add a new auto test below it:

```rust
// (in the existing test, change the expected object to:)
    let expected = serde_json::json!({
        "permissions": {
            "allow": ["Bash(git *)", "Read(*)"],
            "deny": ["Bash(rm *)"],
            "ask": [],
        }
    });
```

```rust
#[test]
#[serial]
fn auto_mode_writes_ask_rules_into_the_settings_file() {
    with_fake("settingsecho");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.permissions.mode = kata_core::spec::PermissionMode::Auto;
    spec.interactive.enabled = true;
    spec.permissions.deny.push("Bash(rm *)".into());
    spec.permissions.ask.push("Bash(git push *)".into());
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);
    let text = assistant_texts(&events)
        .into_iter()
        .find(|t| t.starts_with("SETTINGS "))
        .expect("auto mode must write a --settings file");
    let actual: serde_json::Value =
        serde_json::from_str(text.trim_start_matches("SETTINGS ")).unwrap();
    let expected = serde_json::json!({
        "permissions": {
            "allow": [],
            "deny": ["Bash(rm *)"],
            "ask": ["Bash(git push *)"],
        }
    });
    assert_eq!(actual, expected);
}
```

- [ ] **Step 2: Run to verify the new test fails**

Run: `cargo test -p kata-core --test run_it auto_mode_writes_ask_rules_into_the_settings_file`
Expected: FAIL — auto writes no settings file yet (gate is `== Prompt`).

- [ ] **Step 3: Widen the gate and add `ask` to the settings body**

In `run.rs`, replace the gate at ~275:

```rust
    let permissions_bridge = matches!(
        spec.permissions.mode,
        PermissionMode::Prompt | PermissionMode::Auto
    );
```

Replace both `prompt_permissions` uses (the `approve_tool:` field ~278 and the `if prompt_permissions` at ~339) with `permissions_bridge`. Add `ask` to the settings body ~342:

```rust
        let body = serde_json::json!({
            "permissions": {
                "allow": spec.permissions.allow,
                "deny": spec.permissions.deny,
                "ask": spec.permissions.ask,
            }
        })
        .to_string();
```

- [ ] **Step 4: Run to verify both settings tests pass**

Run: `cargo test -p kata-core --test run_it settings_file` (both the updated prompt test and the new auto test).
Expected: PASS.

- [ ] **Step 5: Verify clean and commit**

Run: `cargo fmt --all --check && cargo clippy --all-targets -- -D warnings`

```bash
git add crates/kata-core/src/run.rs crates/kata-core/tests/run_it.rs
git commit -m "feat: auto mode wires the approve_tool bridge and writes ask rules"
```

---

### Task 4: Auto operator-decision path

**Files:**
- Modify: `crates/kata-core/src/run.rs` (the `settled` decision at ~550-570)
- Test: `crates/kata-core/tests/run_it.rs`

**Interfaces:**
- Consumes: `PermissionMode::Auto`.
- Produces: under `auto`, any call reaching `approve_tool` pauses on the operator (`decided_by == "operator"`), never consulting `unmatched`.

- [ ] **Step 1: Write the failing pause test**

Add to `run_it.rs` (mirrors `prompt_mode_ask_pauses_until_the_operator_decides`):

```rust
#[test]
#[serial]
fn auto_mode_routes_a_reaching_call_to_the_operator() {
    with_fake("approve");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.permissions.mode = kata_core::spec::PermissionMode::Auto;
    spec.interactive.enabled = true;
    spec.permissions.ask.push("Bash(*)".into());
    // Deny is what `unmatched` would do under prompt. Under auto the decision
    // path must IGNORE unmatched and route to the operator anyway. This is the
    // fail-first lever: before the auto branch exists, this call is auto-denied
    // by the unmatched match (decided_by = "unmatched-policy", allow = false);
    // after, it pauses on the operator. `validate` rejects this combo, but
    // `run()` does not call `validate`, so the decision path is exercised directly.
    spec.permissions.unmatched = kata_core::spec::UnmatchedPolicy::Deny;
    let cancel = CancelToken::new();
    let (decision_tx, decisions) = kata_core::run::decision_channel();
    let mut events: Vec<KataEvent> = Vec::new();
    let tx = decision_tx.clone();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &decisions,
        |e| {
            if let KataEvent::PermissionRequested { id, .. } = &e {
                tx.send(kata_core::run::Decision {
                    id: id.clone(),
                    allow: true,
                    message: None,
                })
                .unwrap();
            }
            events.push(e);
        },
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, KataEvent::PermissionRequested { .. })),
        "under auto, a call reaching approve_tool must pause on the operator"
    );
    let (allow, by, _msg) = decision(&events);
    assert!(allow);
    assert_eq!(by, "operator");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kata-core --test run_it auto_mode_routes_a_reaching_call_to_the_operator`
Expected: FAIL — without the auto branch the call hits the `unmatched = Deny` arm and is auto-denied (`decided_by = "unmatched-policy"`, `allow = false`), so no `PermissionRequested` fires and the `by == "operator"` assertion fails.

- [ ] **Step 3: Add the auto branch to the decision**

In `run.rs`, extend the `settled` expression:

```rust
                            let settled = if crate::event::is_bridge_tool(&tool) {
                                Some((true, "engine", None))
                            } else if spec.permissions.mode == PermissionMode::Auto {
                                // Under auto a call only reaches this tool because
                                // a `permissions.ask` rule matched it — an explicit
                                // request for the operator. Route it there; the
                                // classifier already handled everything unruled, so
                                // `unmatched` does not apply. `validate` guarantees
                                // interactive is on when ask rules exist.
                                None
                            } else {
                                match spec.permissions.unmatched {
                                    UnmatchedPolicy::Deny => Some((
                                        false,
                                        "unmatched-policy",
                                        Some(DENY_BY_POLICY.to_string()),
                                    )),
                                    UnmatchedPolicy::Allow => {
                                        Some((true, "unmatched-policy", None))
                                    }
                                    UnmatchedPolicy::Ask => None,
                                }
                            };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p kata-core --test run_it auto_mode_routes_a_reaching_call_to_the_operator`
Expected: PASS.

- [ ] **Step 5: Verify clean and commit**

Run: `cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test -p kata-core -p kata-cli`

```bash
git add crates/kata-core/src/run.rs crates/kata-core/tests/run_it.rs
git commit -m "feat: auto mode routes ask-matched calls to the operator"
```

---

### Task 5: Browser validation mirror

**Files:**
- Modify: `app/src/lib/mock.ts` (the `validateLocal` permission block ~127-148)
- Test: `app/src/lib/spec.test.ts` (or the existing mock/validation test file)

**Interfaces:**
- Consumes: the run-spec TS binding (now carrying `auto` and `ask`).
- Produces: browser validation that matches `spec::validate` verbatim, per the "change one, change the other" rule in `spec.rs:481`.

- [ ] **Step 1: Write the failing TS tests**

Add to the validation test file (match the existing permission test style):

```ts
it("rejects ask rules under bypass", () => {
  const spec = { ...baseSpec(), permissions: { mode: "bypass", ask: ["Bash(git push *)"] } };
  expect(validateLocal(spec).some((e) => e.includes("ask"))).toBe(true);
});

it("rejects an explicit unmatched under auto", () => {
  const spec = { ...baseSpec(), permissions: { mode: "auto", unmatched: "deny" } };
  expect(validateLocal(spec).some((e) => e.includes("auto"))).toBe(true);
});

it("requires interactive for ask rules under auto", () => {
  const spec = { ...baseSpec(), interactive: { enabled: false }, permissions: { mode: "auto", ask: ["Bash(git push *)"] } };
  expect(validateLocal(spec).some((e) => e.includes("permissions.ask"))).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npm test -- spec` (or the relevant test file)
Expected: FAIL.

- [ ] **Step 3: Mirror the engine rules in `validateLocal`**

Update the permission block in `mock.ts` to match `spec::validate` (verbatim error strings):

```ts
  const p = spec.permissions;
  const allow = p.allow ?? [];
  const deny = p.deny ?? [];
  const ask = p.ask ?? [];
  if (p.mode === "bypass") {
    if (allow.length > 0 || deny.length > 0 || ask.length > 0) {
      errors.push(
        'permissions.allow/deny/ask are only consulted under permissions.mode = "prompt" or "auto"; ' +
          'under "bypass" claude never asks, so the rules would be ignored',
      );
    }
  } else if (p.mode === "prompt") {
    if (p.unmatched === "ask" && !spec.interactive.enabled) {
      errors.push(
        'permissions.unmatched = "ask" needs an operator to ask: set [interactive] enabled = true, ' +
          'or choose unmatched = "deny" / "allow" for a headless run',
      );
    }
  } else if (p.mode === "auto") {
    if (p.unmatched && p.unmatched !== "ask") {
      errors.push(
        'permissions.unmatched has no meaning under permissions.mode = "auto": ' +
          "claude's classifier decides every call no rule matched. Remove it, or use " +
          'mode = "prompt" to route unmatched calls to the operator.',
      );
    }
  }
  if (ask.length > 0 && p.mode !== "bypass" && !spec.interactive.enabled) {
    errors.push(
      "permissions.ask rules pause on the operator: set [interactive] enabled = true, or remove them",
    );
  }
  for (const [field, rules] of [
    ["permissions.allow", allow],
    ["permissions.deny", deny],
    ["permissions.ask", ask],
  ] as const) {
    for (const raw of rules) {
      if (!ruleIsWellFormed(raw)) {
        errors.push(`${field} has a malformed rule '${raw}'; expected 'Tool' or 'Tool(specifier)'`);
      }
    }
  }
```

(Adapt `errors`/`push` names to the file's actual accumulator.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd app && npm test -- spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/mock.ts app/src/lib/spec.test.ts
git commit -m "feat: mirror auto/ask validation in the browser fallback"
```

---

### Task 6: Workbench compose control

**Files:**
- Modify: `app/src/lib/components/ComposePane.svelte` (permission mode control ~290-345, `onPermissionMode` ~116-121)
- Test: `app/src/lib/components/ComposePane.test.ts`

**Interfaces:**
- Consumes: the run-spec store (now with `auto` and `ask`).
- Produces: the operator can select `auto`, edit an `ask` list, and the pane self-heals rules on a `→ bypass` transition.

- [ ] **Step 1: Write the failing component tests**

Add to `ComposePane.test.ts` (mirror the existing allow/deny coverage):

```ts
it("offers auto as a third permission mode", () => {
  const { getByLabelText } = render(ComposePane, { props: { spec: seed() } });
  // The Segmented for permission mode now includes "auto".
  expect(getByLabelText("Permission mode")).toBeTruthy();
  // (assert the "auto" option is present per the Segmented test pattern)
});

it("shows the ask editor under auto and hides unmatched", () => {
  const spec = seed();
  spec.permissions.mode = "auto";
  const { queryByKey } = render(ComposePane, { props: { spec } });
  expect(queryByKey("permissions.ask")).toBeTruthy();
  expect(queryByKey("permissions.unmatched")).toBeFalsy();
});

it("clears allow/deny/ask when switching to bypass", () => {
  const spec = seed();
  spec.permissions.mode = "prompt";
  spec.permissions.allow = ["Read"];
  spec.permissions.ask = ["Bash(git push *)"];
  // drive onPermissionMode("bypass")
  // assert allow/deny/ask are emptied
});
```

(Match the file's actual render/query helpers; the existing permission tests referenced in the 2026-08-08 spec show the patterns.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npm test -- ComposePane`
Expected: FAIL.

- [ ] **Step 3: Implement the control changes**

In `ComposePane.svelte`:

- Widen the mode `Segmented` options at ~297 to `["bypass", "prompt", "auto"] as const` and update the hint to name auto ("auto runs claude's classifier — routine work auto-approved, destructive or external calls blocked; ask rules still pause on you").
- Change `onPermissionMode` to accept `"bypass" | "prompt" | "auto"` and clear `allow`/`deny`/`ask` on the `bypass` branch:

```ts
  function onPermissionMode(mode: "bypass" | "prompt" | "auto") {
    spec.permissions.mode = mode;
    if (mode === "bypass") {
      spec.permissions.allow = [];
      spec.permissions.deny = [];
      spec.permissions.ask = [];
    }
  }
```

- Gate the allow/deny/ask editors on `mode === "prompt" || mode === "auto"`, and gate the `Unmatched` field on `mode === "prompt"` only (it is rejected under auto).
- Add an `Ask` editor mirroring the `Allow`/`Deny` `Field` + textarea (`rulesText`/`parseRules` on `spec.permissions.ask`), with the hint: "one rule per line; a match pauses on you. needs interactive on."
- Reuse the existing `ask`-needs-interactive warning pattern (the `--warning` dot + Enable interactive button) so a non-empty `ask` list with interactive off shows it.

- [ ] **Step 4: Run to verify they pass**

Run: `cd app && npm test -- ComposePane && npm run check`
Expected: PASS, and Svelte type-check clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/components/ComposePane.svelte app/src/lib/components/ComposePane.test.ts
git commit -m "feat: compose pane gains auto mode and the ask editor"
```

---

### Task 7: Real-claude smoke test

**Files:**
- Modify: `crates/kata-core/tests/run_it.rs` (the `KATA_SMOKE_REAL` smoke section)

**Interfaces:**
- Consumes: an authenticated real `claude` on PATH; runs only when `KATA_SMOKE_REAL` is set.

- [ ] **Step 1: Add the smoke test**

Guard it like the existing real-claude smoke test (skip unless `KATA_SMOKE_REAL` is set). It runs a real `auto` spec in a temp git repo with `deny = ["Bash(rm *)"]`, `ask = ["Bash(curl *)"]`, interactive on, and a task that writes a file, curls a public URL, and tries `rm`. Assert: the run completes; a `permission.requested` fired for the curl (ask rule → operator); the `rm` produced a failed `tool.result` (deny); the write succeeded. This pins the composition the probes proved so a future claude release cannot regress it silently.

```rust
#[test]
#[serial]
fn smoke_real_auto_mode_gates_by_classifier_deny_and_ask() {
    if std::env::var("KATA_SMOKE_REAL").is_err() {
        return; // opt-in only
    }
    // build an auto spec: deny rm, ask on curl, interactive on; auto-allow the
    // curl at the operator; drive the task described above and assert the three
    // outcomes. Follow the existing smoke test's run harness and git-init setup.
}
```

- [ ] **Step 2: Run it opt-in to confirm it passes against real claude**

Run: `KATA_SMOKE_REAL=1 cargo test -p kata-core --test run_it smoke_real_auto_mode -- --nocapture`
Expected: PASS (requires authenticated claude). Without the env var, the test returns early.

- [ ] **Step 3: Commit**

```bash
git add crates/kata-core/tests/run_it.rs
git commit -m "test: real-claude smoke pins auto mode deny/ask/classifier composition"
```

---

### Task 8: Docs — init scaffold and CLAUDE.md

**Files:**
- Modify: `crates/kata-core/src/spec.rs` (the `[permissions]` scaffold in `kata init` output ~437-444)
- Modify: `CLAUDE.md` (the Permissions section)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the `kata init` scaffold**

Replace the `[permissions]` scaffold block so it names `auto` and `ask`:

```rust
         [permissions]\n\
         # \"bypass\" (default) passes --dangerously-skip-permissions. \"prompt\"\n\
         # writes allow/deny into claude's settings and routes unmatched calls\n\
         # to you (unmatched = \"deny\"/\"ask\"). \"auto\" runs claude's classifier —\n\
         # routine work auto-approved, destructive or external calls blocked —\n\
         # with deny as a hard block and ask rules pausing on you.\n\
         # mode = \"auto\"\n\
         # deny = [\"Bash(rm *)\"]\n\
         # ask = [\"Bash(git push *)\"]  # needs [interactive] enabled = true\n"
```

- [ ] **Step 2: Update `CLAUDE.md` Permissions section**

Extend the Permissions section (one line per paragraph, US English) to describe `auto`: the classifier gate, `deny` blocking before it, `ask` rules as the operator's only entry point, and that `unmatched` is rejected under auto. Note `autoMode.environment` tuning is out of scope for now.

- [ ] **Step 3: Verify and commit**

Run: `cargo test -p kata-core -p kata-cli` (confirms the `kata init` output still parses as a valid spec).

```bash
git add crates/kata-core/src/spec.rs CLAUDE.md
git commit -m "docs: document auto permission mode in init scaffold and CLAUDE.md"
```

---

## Final verification

Run the full engine suite plus the contract gates and formatting, and confirm each is green before claiming completion:

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test -p kata-core -p kata-cli
cargo test -p kata-core --features ts export_bindings
KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema runspec_schema_artifact_is_fresh
cd app && npm test && npm run check
```

Evidence before any completion claim: paste the passing output, do not assert it.
