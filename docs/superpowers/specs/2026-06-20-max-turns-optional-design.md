# Optional `max_turns` — unset means unlimited

## Problem

`leash.max_turns` is a required `u32` that defaults to `12` when omitted (`spec.rs::default_max_turns`). There is no way to express "no turn cap": `validate` rejects `0`, and an omitted value silently becomes 12. Operators who want a run to go as long as it needs (bounded only by the wall-clock timeout) cannot say so, and the Workbench's "Max turns" field always shows a number, implying a cap is mandatory.

## Goal

Make `max_turns` optional. Unset means **unlimited turns**, and unset is the new default for fresh katas. The wall-clock `timeout_secs` (default 1800s, never unbounded) remains the always-on backstop, so "unlimited turns" is never "unlimited wall-clock." The turn cap becomes an opt-in tightener, behaving exactly like the other two optional leash knobs (`timeout_secs`, `max_budget_usd`).

## Non-goals

- No migration of existing saved katas. A kata with an explicit `max_turns = 12` keeps it and stays capped until the operator edits it. There is no way to distinguish a deliberate 12 from a defaulted one, so we do not guess.
- No "unlimited" sentinel value (e.g. `0` or `-1`) and no per-scope configuration. `Option` is the whole mechanism.

## The contract change (`kata-core::spec`)

`Leash.max_turns` changes from `u32` to `Option<u32>`, serialized like its siblings:

```rust
#[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<u32>"))]
#[serde(default, skip_serializing_if = "Option::is_none")]
pub max_turns: Option<u32>,
```

- `default_max_turns()` is removed. `Leash::default()` sets `max_turns: None`.
- `validate()`: `None` is valid (unlimited). `Some(0)` is the only error: `"leash.max_turns must be >= 1 when set"`. This mirrors how `max_budget_usd` is validated only when present.

This is a stable cross-language contract (`RunSpec` → ts-rs bindings → the .NET Shokunin consumer). After the type change, regenerate bindings: `cargo test -p kata-core --features ts export_bindings`. `Leash.ts` becomes `max_turns?: number | null`.

## The engine (`kata-core::run`)

The turn-cap leash is enforced engine-side because claude 2.1.x has no `--max-turns` flag. Today (`run.rs`):

```rust
if turns >= spec.leash.max_turns { termination = Some(Termination::MaxTurns); break; }
turns += 1;
```

It becomes conditional on a cap being set:

```rust
if let Some(cap) = spec.leash.max_turns {
    if turns >= cap { termination = Some(Termination::MaxTurns); break; }
}
turns += 1;
```

When `max_turns` is `None`, turns are uncapped and the run ends naturally — or via the rails that remain fully armed: wall-clock timeout (exit **124**), budget ceiling (**122**), cancel (**130**). The `MaxTurns` termination still maps to exit **125**; its message formats the actual cap (only reachable when `Some(cap)`).

### Exit-code semantics

Exit **125** (turn cap) becomes conditional on a cap being set — exactly parallel to **122** (only when `max_budget_usd` set) and **123** (only when interactive + `answer_timeout_secs` set). No exit code is repurposed; the leash's other guarantees are unchanged.

## The Workbench (`app`)

`ComposePane.svelte` already treats `timeout_secs` and `max_budget_usd` as "empty = unbounded." `max_turns` joins them:

- `onMaxTurns` mirrors `onTimeout`: empty input → `null` (unlimited); otherwise an integer ≥ 1, else `null`.
- The input renders empty when `null`, gets `placeholder="unlimited"`, and the Field hint reads `empty = unlimited · engine cap → exit 125 when set` (sentence-case, literal mono spec key, no emoji — per `app/CLAUDE.md`).
- `spec.ts::defaultSpec()` leash sets `max_turns: null` (was `12`). `draftFrom`/`normalize`/`specEquals` need no change — spreads carry `null` through, and `specEquals` already compares the field structurally.

`mock.ts` / `library.ts` fixtures keep whatever explicit value they carry (still valid as `Some(n)`); no behavioral change required there beyond type-checking.

## Testing (TDD)

Rust (`kata-core`):

- `spec.rs`: an omitted `max_turns` parses to `None` (not 12); `Some(0)` fails validation with the new message; `None` passes. Update existing assertions that expect `12`.
- `run.rs` / `run_it.rs` (fake-claude): a run with `max_turns: None` streams past more than the old default of assistant messages without a `MaxTurns` kill and completes (exit 0); a run with `Some(n)` still caps at the n-th turn boundary (exit 125). The fake-claude harness drives this offline via `KATA_FAKE_MODE` (serial tests).
- `command.rs`: update the test that sets `max_turns = 8` to `Some(8)`. No invocation arg changes (still no `--max-turns` flag).

Frontend (`app`):

- `spec.test.ts`: `defaultSpec()` leaves `max_turns` unset/unlimited.
- ComposePane: an empty "Max turns" field sets `max_turns` to `null`; a value ≥ 1 sets the integer.

Docs:

- `CLAUDE.md` exit-code note: phrase 125 as reachable "when a turn cap is set," matching the 122/123 wording. Touch `README.md`/`ROADMAP.md` only if they assert a fixed default.

## Components, at a glance

| Unit | Change | Depends on |
| --- | --- | --- |
| `spec::Leash` | `max_turns: Option<u32>`, default `None`, validate `Some(0)` only | — |
| ts bindings | regenerate `Leash.ts` | `spec::Leash` |
| `run` turn loop | cap check guarded by `Some(cap)` | `spec::Leash` |
| `spec.ts` | `defaultSpec` `max_turns: null` | `Leash.ts` |
| `ComposePane` | `onMaxTurns` = empty→null; placeholder + hint | `spec.ts` |
