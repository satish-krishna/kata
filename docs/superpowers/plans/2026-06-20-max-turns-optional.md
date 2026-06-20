# Optional `max_turns` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `leash.max_turns` optional so an unset value means unlimited turns (the new default), bounded only by the wall-clock timeout.

**Architecture:** Change the `RunSpec` contract field `max_turns` from `u32` to `Option<u32>` (mirroring the already-optional `timeout_secs`/`max_budget_usd`), guard the engine's turn-cap check on `Some(cap)`, regenerate the TS bindings, and update the Workbench to treat an empty "Max turns" field as unlimited.

**Tech Stack:** Rust (Cargo workspace: `kata-core`), ts-rs binding generation, SvelteKit + TypeScript + Vitest (`app/`).

## Global Constraints

- TDD throughout: write/adjust the failing test first, watch it fail, then implement. (`CLAUDE.md`)
- `cargo clippy --all-targets -- -D warnings` must stay clean. (`CLAUDE.md`)
- `cargo build --locked` must stay green. (`CLAUDE.md`)
- Never hand-edit `app/src/bindings/` — regenerate with ts-rs. (`CLAUDE.md`)
- Exit-code contract is stable: turn cap → 125, timeout → 124, answer deadline → 123, budget → 122, cancel → 130. After this change, 125 is reachable only when a cap is set. (`CLAUDE.md`)
- Frontend: style only against CSS custom properties, sentence-case labels, literal lowercase spec keys in mono, no emoji. (`app/CLAUDE.md`)
- No migration of existing saved katas: an explicit `max_turns = 12` stays 12.

---

### Task 1: Rust contract + engine — `max_turns: Option<u32>`, conditional cap

This is one atomic task: the Rust type change forces the validation, engine, and all `kata-core` test updates to compile together. A reviewer cannot accept the type change while rejecting the engine change — they are coupled.

**Files:**
- Modify: `crates/kata-core/src/spec.rs` (field, default, validate, tests)
- Modify: `crates/kata-core/src/run.rs:355-364` (turn-cap check), `run.rs:400-402` (MaxTurns message), `run.rs:481` (Termination variant)
- Modify: `crates/kata-core/src/command.rs:109` (test helper)
- Test: `crates/kata-core/tests/run_it.rs:174-187` (update) + new unlimited test

**Interfaces:**
- Produces: `kata_core::spec::Leash { max_turns: Option<u32>, .. }` — `None` = unlimited. `Leash::default()` yields `max_turns: None`.
- Produces: `validate(&RunSpec)` rejects `Some(0)` with `"leash.max_turns must be >= 1 when set"`; accepts `None`.
- Consumes (run.rs): `spec.leash.max_turns: Option<u32>`.

- [ ] **Step 1: Update spec.rs unit tests to express the new contract**

In `crates/kata-core/src/spec.rs`, change the three assertions and the validate-zero setup:

`parses_minimal_spec_with_defaults` (line ~258):
```rust
        assert_eq!(spec.leash.max_turns, None); // default: unlimited
```

`json_parses_same_shape` (line ~319):
```rust
        assert_eq!(spec.leash.max_turns, None);
```

`full_spec` struct literal that builds a `Leash` (line ~392) — change `max_turns: 8` to:
```rust
            leash: Leash { max_turns: Some(8), timeout_secs: Some(600), max_budget_usd: None, isolation: Isolation::Worktree },
```

The validate test `validate_rejects_unknown_schema_and_zero_turns` (line ~334) — change its zero assignment to `Some(0)` (the `schema = 99` and both assertions stay as-is):
```rust
        spec.leash.max_turns = Some(0);
```

Add a new standalone test right after `validate_rejects_unknown_schema_and_zero_turns` (after line ~338) proving an unset cap is valid on an otherwise-valid spec:
```rust
    #[test]
    fn validate_accepts_unset_max_turns() {
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.leash.max_turns = None; // unlimited
        assert!(validate(&spec).is_ok());
    }
```

- [ ] **Step 2: Update command.rs + run_it.rs callers to the new type, and add the unlimited integration test**

In `crates/kata-core/src/command.rs` test helper `spec()` (line ~109):
```rust
        s.leash.max_turns = Some(8);
```

In `crates/kata-core/tests/run_it.rs`, the existing cap test (line ~178):
```rust
    spec.leash.max_turns = Some(2);
```

Add this new test immediately after `run_max_turns_kills_child` (after line ~187). `manyturns` drips 10 assistant turns at 200ms each then exits 0 with no result payload; with no cap the engine counts all 10 and completes:
```rust
#[test]
#[serial]
fn run_unlimited_turns_does_not_cap() {
    with_fake("manyturns");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.max_turns = None; // unlimited
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, &kata_core::run::AnswerRx::default(), |e| events.push(e)).unwrap();
    // No turn cap fires: all 10 drip turns are counted, none trips exit 125.
    assert!(!events.iter().any(|e| matches!(e, KataEvent::RunError { exit_code: 125, .. })));
    assert!(events.iter().any(|e| matches!(e, KataEvent::Turn { n: 10 })));
    assert_eq!(outcome.exit_code, 0);
}
```

- [ ] **Step 3: Run the suite to verify it fails (red)**

Run: `cargo test -p kata-core`
Expected: COMPILE FAILURE — the tests assign `None`/`Some(8)`/`Some(2)`/`Some(0)` to `max_turns`, which is still `u32` (`mismatched types: expected u32, found Option<...>`). This is the red state proving the tests bind to the new contract.

- [ ] **Step 4: Change the field, default, and validation in spec.rs**

In `crates/kata-core/src/spec.rs`, replace the field (lines ~103-104):
```rust
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<u32>"))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
```

Replace the `Default` impl body (line ~117) so `max_turns` starts unset:
```rust
        Self { max_turns: None, timeout_secs: None, max_budget_usd: None, isolation: Isolation::None }
```

Delete the now-unused helper (line ~133):
```rust
fn default_max_turns() -> u32 { 12 }
```

Replace the validation line (line ~230):
```rust
    if spec.leash.max_turns == Some(0) { errs.push("leash.max_turns must be >= 1 when set".into()); }
```

- [ ] **Step 5: Make the engine cap conditional in run.rs**

In `crates/kata-core/src/run.rs`, replace the turn-cap block (lines ~355-364):
```rust
                if parsed.is_assistant_message {
                    // Engine-side leash: claude 2.1.x has no --max-turns flag, so the
                    // turn cap is enforced here. `None` means unlimited (bounded only
                    // by the wall-clock timeout); when a cap is set, stop once a turn
                    // beyond it begins and kill the child.
                    if let Some(cap) = spec.leash.max_turns {
                        if turns >= cap {
                            termination = Some(Termination::MaxTurns(cap));
                            break;
                        }
                    }
                    turns += 1;
                    emit(KataEvent::Turn { n: turns });
                }
```

Change the `Termination` enum variant (line ~481) to carry the cap:
```rust
    MaxTurns(u32),
```

Change the terminal match arm (lines ~400-402) to use the carried cap (no longer reads `spec.leash.max_turns`):
```rust
                Termination::MaxTurns(cap) => (125, KataEvent::RunError {
                    message: format!("reached max turns ({cap})"), exit_code: 125,
                }),
```

- [ ] **Step 6: Run the suite to verify it passes (green)**

Run: `cargo test -p kata-core`
Expected: PASS — all `spec`, `command`, and `run_it` tests green, including `run_unlimited_turns_does_not_cap` and `run_max_turns_kills_child`.

- [ ] **Step 7: Clippy + locked build**

Run: `cargo clippy --all-targets -- -D warnings`
Expected: clean (no warnings; confirms `default_max_turns` removal left no dead reference).
Run: `cargo build --locked`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add crates/kata-core/src/spec.rs crates/kata-core/src/run.rs crates/kata-core/src/command.rs crates/kata-core/tests/run_it.rs
git commit -m "feat(engine): make leash.max_turns optional (unset = unlimited)"
```

---

### Task 2: Regenerate TypeScript bindings

**Files:**
- Modify (generated): `app/src/bindings/Leash.ts`

**Interfaces:**
- Consumes: `kata_core::spec::Leash` from Task 1.
- Produces: `Leash.ts` with `max_turns?: number | null`.

- [ ] **Step 1: Regenerate bindings**

Run: `cargo test -p kata-core --features ts export_bindings`
Expected: PASS; `app/src/bindings/Leash.ts` is rewritten.

- [ ] **Step 2: Verify the generated shape**

Run: `git diff app/src/bindings/Leash.ts`
Expected: the `max_turns` member changes from `max_turns: number` to `max_turns?: number | null` (matching `timeout_secs`/`max_budget_usd`).

- [ ] **Step 3: Commit**

```bash
git add app/src/bindings/Leash.ts
git commit -m "chore(bindings): regenerate Leash for optional max_turns"
```

---

### Task 3: Workbench — empty "Max turns" field means unlimited

**Files:**
- Modify: `app/src/lib/spec.ts:36` (defaultSpec)
- Modify: `app/src/lib/components/ComposePane.svelte:69-72` (onMaxTurns), `:213-214` (Field + input)
- Modify: `app/src/lib/mock.ts:87` (browser-only validator)
- Test: `app/src/lib/spec.test.ts:8` (default assertion)

**Interfaces:**
- Consumes: `Leash.max_turns?: number | null` from Task 2.
- Produces: `defaultSpec().leash.max_turns === null`; ComposePane sets `null` for an empty field, an integer ≥ 1 otherwise.

- [ ] **Step 1: Update the frontend default test (red)**

In `app/src/lib/spec.test.ts`, change the default assertion (line ~8):
```ts
    expect(s.leash.max_turns).toBeNull();
```

- [ ] **Step 2: Run the frontend test to verify it fails (red)**

Run (from `app/`): `npm test -- spec.test.ts`
Expected: FAIL — `defaultSpec()` still returns `max_turns: 12`, so `toBeNull()` fails with `expected 12 to be null`.

- [ ] **Step 3: Update defaultSpec**

In `app/src/lib/spec.ts`, change the leash default (line ~36):
```ts
    leash: { max_turns: null, timeout_secs: null, max_budget_usd: null, isolation: "none" },
```

- [ ] **Step 4: Update the ComposePane input handler and markup**

In `app/src/lib/components/ComposePane.svelte`, replace `onMaxTurns` (lines ~69-72) to mirror `onTimeout` (empty = unlimited):
```ts
  // Integer-coerce the turn cap (null = unlimited; mirrors kata-core's Option<u32>).
  function onMaxTurns(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value.trim();
    if (v === "") {
      spec.leash.max_turns = null;
      return;
    }
    const n = Math.trunc(Number(v));
    spec.leash.max_turns = Number.isFinite(n) && n >= 1 ? n : null;
  }
```

Replace the Field + input (lines ~213-214):
```svelte
      <Field label="Max turns" key="max_turns" hint="empty = unlimited · engine cap → exit 125 when set">
        <input class="k-input" type="number" min="1" step="1" placeholder="unlimited" value={spec.leash.max_turns ?? ""} oninput={onMaxTurns} />
      </Field>
```

- [ ] **Step 5: Update the browser-only mock validator**

In `app/src/lib/mock.ts`, replace the turn-cap check (line ~87) so an unset cap is valid:
```ts
  if (spec.leash.max_turns != null && spec.leash.max_turns < 1) errs.push("leash.max_turns must be >= 1");
```

- [ ] **Step 6: Run frontend checks (green)**

Run (from `app/`): `npm test`
Expected: PASS — `spec.test.ts` green; existing fixtures in `katas.test.ts`/`run.test.ts` keep explicit numeric `max_turns` and remain valid.
Run (from `app/`): `npm run check`
Expected: PASS — no type errors against the regenerated `Leash` (`number | null`).

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/spec.ts app/src/lib/components/ComposePane.svelte app/src/lib/mock.ts app/src/lib/spec.test.ts
git commit -m "feat(web): empty max turns field means unlimited"
```

---

### Task 4: Docs + full-workspace verification

**Files:**
- Modify: `CLAUDE.md` (exit-code semantics note)

**Interfaces:**
- Consumes: behavior from Tasks 1-3. Produces: no code, just documentation + a green workspace gate.

- [ ] **Step 1: Clarify the exit-code note**

In `CLAUDE.md`, in the "Exit-code semantics (the leash)" section, add a sentence after the existing exit-122 explanation:
```markdown
Exit 125 is only reachable when `leash.max_turns` is set; an unset cap means unlimited turns, bounded only by the wall-clock timeout (exit 124).
```

- [ ] **Step 2: Full workspace test**

Run: `cargo test --workspace`
Expected: PASS — all crates green.

- [ ] **Step 3: Full clippy + locked build**

Run: `cargo clippy --all-targets -- -D warnings`
Expected: clean.
Run: `cargo build --locked`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note exit 125 is conditional on a turn cap"
```

---

## Self-Review

**Spec coverage:**
- Contract change (`Option<u32>`, default `None`, validate `Some(0)`) → Task 1, Steps 4 + 1.
- Engine conditional cap + exit-125-when-set + `None` runs uncapped → Task 1, Steps 5 + 2.
- Regenerate bindings → Task 2.
- `defaultSpec` unlimited + ComposePane empty=unlimited + placeholder/hint + mock validator → Task 3.
- Exit-code doc clarification → Task 4, Step 1.
- No migration of existing katas → honored: no task rewrites stored specs; fixtures keep their explicit values.

**Placeholder scan:** No TBD/TODO; every code step shows the exact code; commands carry expected output.

**Type consistency:** `max_turns: Option<u32>` (Rust) ↔ `max_turns?: number | null` (TS). `Termination::MaxTurns(u32)` carries the cap used by the message arm. `validate` message `"leash.max_turns must be >= 1 when set"` is referenced consistently. `onMaxTurns` sets `number | null`, matching `defaultSpec`'s `max_turns: null`.
