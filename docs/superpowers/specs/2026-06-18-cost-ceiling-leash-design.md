# Cost-ceiling leash — design

Phase 4, item 1 (the roadmap's "Cost-ceiling leash (kill on `cost_usd` budget)").

## Problem

The leash today caps a run on *turns* (exit 125), *wall-clock time* (exit 124), and *answer deadline* (exit 123). It cannot cap *money*. A run that loops on an expensive model can burn an unbounded dollar amount before the turn or time cap trips. CI and Shokunin have no way to say "stop this run once it has spent $N."

The roadmap parked this behind "once cost is reliably present in stream-json," anticipating an engine-side approach: watch `total_cost_usd` in the result stream and kill the child when it crosses a budget. That approach is unnecessary — claude 2.1.x ships a native `--max-budget-usd <amount>` flag that enforces the ceiling itself. Kata passes the flag and maps the outcome into its leash contract.

## What claude actually does (empirical)

Probed against real claude 2.1.181 (`--max-budget-usd 0.0001` on a multi-turn task):

- claude runs the in-flight turn to completion, then on the *next* turn boundary sees the budget is crossed and stops.
- It emits a terminal `result` event with `"subtype": "error_max_budget_usd"`, `"is_error": true`, `"errors": ["Reached maximum budget ($0.0001)"]`, and the real `"total_cost_usd"`.
- The process exits **1** (not a distinct code).

Two consequences drive the design:

1. **The marker is `result.subtype == "error_max_budget_usd"`.** That is the unambiguous, parseable signal — not the exit code (which is a generic `1`), not the human `errors` string.
2. **The ceiling is approximate, enforced at turn boundaries.** The `$0.0001` probe actually spent **`$0.134683`** — claude overshoots by up to one turn because the check is post-turn, not real-time. This is a soft budget, and the UI and docs must say so. It is a guardrail against runaway cost, not a precise spend cap.

## Goals

- A per-spec dollar ceiling, enforced by claude's native `--max-budget-usd`.
- Map a budget stop to a **distinct Kata exit code (122)**, so CI/Shokunin can tell "too expensive" from "too slow" (124) or "too many turns" (125).
- Surface the control in the Workbench compose pane, with the approximate-cap caveat stated in the hint.
- Fully backward-compatible: an absent field means no ceiling; existing specs are unchanged.

## Non-goals

- Engine-side stream-watching cost kill. The native flag replaces it; Kata does not second-guess claude's accounting.
- A hard, real-time, cent-precise cap. `--max-budget-usd` is a post-turn check and overshoots by up to one turn; Kata inherits that semantics and does not try to improve on it.
- Per-model or per-turn sub-budgets. One ceiling per run.

## The contract — `RunSpec` (`Leash`)

A new optional field on the existing `leash` table.

```toml
[leash]
max_turns = 12
timeout_secs = 600
max_budget_usd = 5.00   # new — omit for no ceiling
isolation = "none"
```

```rust
pub struct Leash {
    pub max_turns: u32,
    pub timeout_secs: Option<u64>,
    pub max_budget_usd: Option<f64>,  // None = no ceiling (today's behavior)
    pub isolation: Isolation,
}
```

`max_budget_usd` defaults to `None` and is skipped in serialization when unset, so existing specs round-trip unchanged. The struct derives `ts_rs::TS`; `app/src/bindings/Leash.ts` is regenerated (not hand-edited).

**Validation** (`spec::validate`): if `Some(b)`, require `b > 0.0`. A zero or negative ceiling is a spec error (`"leash.max_budget_usd must be > 0"`), consistent with the existing `max_turns >= 1` rule. `None` is always valid.

## Engine behavior

### `command.rs` (`build_invocation`)

When `leash.max_budget_usd` is `Some(b)`, push `--max-budget-usd` followed by the formatted amount. When `None`, emit nothing — current invocations are byte-for-byte unchanged. The flag is independent of `--bare`, model, and interactivity.

### `event.rs` (detection)

`ResultPayload` gains `subtype: Option<String>`, captured from `result.subtype` in `parse_stream_line`. A helper:

```rust
impl ResultPayload {
    pub fn is_budget_exhausted(&self) -> bool {
        self.subtype.as_deref() == Some("error_max_budget_usd")
    }
}
```

This is additive; all existing `ResultPayload` consumers ignore the new field.

### `run.rs` (exit mapping)

A budget stop is **claude-initiated**: the child self-exits and emits its terminal `result`, so it arrives through the existing `None`-termination branch (the engine does not kill it — claude already stopped). After the payload is built:

- If `payload.is_budget_exhausted()`, override the outcome to **exit 122** and emit `RunError { message }`, where `message` names both the configured ceiling (from `spec.leash.max_budget_usd`) and the actual spend (from `payload.cost_usd`) — e.g. `"budget ceiling $5.00 reached; spent $5.37"`.
- Otherwise, behavior is exactly as today (`RunCompleted` with claude's native exit code).

This models budget exhaustion as a member of the **leash family** alongside timeout and max-turns, which also emit `RunError` with a distinct code. (The terminal-event choice — `RunError` over a `RunCompleted` carrying the partial cost — was a deliberate decision for leash-family consistency; the GUI shows a leash-trip error banner, not the normal cost/turns summary card.)

## Exit-code semantics (the leash)

Add 122 to the family, slotting below the existing codes:

| code | meaning |
|------|---------|
| 130  | cancel |
| 125  | turn cap |
| 124  | wall-clock timeout |
| 123  | answer deadline (interactive only) |
| **122** | **budget ceiling reached** |

Document in `CLAUDE.md` ("Exit-code semantics (the leash)") and `ROADMAP.md` (mark the Phase 4 item done). The CLI already passes `outcome.exit_code` straight through (`main.rs`), so no CLI change is needed beyond the value flowing.

## Workbench (compose pane)

`ComposePane.svelte`, leash section. Add a "Max budget (USD)" field beside "Max turns" / "Timeout":

- `type="number"`, `min` positive, `step="0.01"`, `placeholder="(none)"`.
- Blank → `spec.leash.max_budget_usd = null`; a value is coerced to a positive float (mirroring the integer coercion already used for turns/timeout), `null` when not finite or `<= 0`.
- Hint: **"Claude-native ceiling → exit 122 (approximate; checked at turn boundaries)."**

Touch-ups: `spec.ts` default spec (leave `max_budget_usd` unset/`null`), and any leash fixture in `mock.ts`.

## Testing (TDD)

- **`spec.rs`** — parse a spec with `max_budget_usd`; round-trip TOML+JSON; `validate` rejects `<= 0` and accepts `None` and a positive value.
- **`command.rs`** — `Some` emits `--max-budget-usd <amount>`; `None` emits no such flag (and the base-command test still asserts the byte-for-byte flag set).
- **`event.rs`** — `parse_stream_line` captures `subtype`; `is_budget_exhausted()` is true for `error_max_budget_usd`, false for `success`/`error`.
- **`fake-claude`** — new `KATA_FAKE_MODE = "budget"` emitting an assistant turn then a `result` with `subtype:"error_max_budget_usd"`, `is_error:true`, a non-zero `total_cost_usd`, exiting 1 (mirrors real claude).
- **`run_it.rs`** (`#[serial]`) — drive the `budget` fake; assert the run reports **exit 122** and emits a `RunError` whose message mentions the budget. Confirms the engine overrides claude's generic exit 1.

## Sequencing

First of Phase 4's cycles, run on its own `feat/cost-ceiling-leash` branch: TDD per change, `cargo clippy --all-targets -D warnings` clean, `cargo build --locked` green, TS bindings regenerated, frequent commits, PR + review before merge. Remaining Phase 4 order after this merges: (2) saved-katas + run-history **+ context presets** as one combined cycle — the home for the run-time task-override "reusable agent" idea; (3) guard-hooks (`PreToolUse`); (4) MCP configuration surface.
