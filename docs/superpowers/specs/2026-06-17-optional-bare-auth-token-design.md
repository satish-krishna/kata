# Optional `--bare` + referenced auth token — design

## Problem

Kata always invokes claude with `--bare` (hardcoded in `command.rs`), so every run is "the empty room": no user config, plugins, MCP, or `CLAUDE.md`. The bare room also has no ambient credentials, which is the root of the silent "Not logged in" failure we debugged — a bare run cannot reach the API unless the host already exported a key.

Two things are missing: the user cannot choose to run with their full real environment instead of the empty room, and a bare run has no first-class way to supply credentials. This design makes `--bare` a per-spec choice and, when bare is on, lets a spec name an environment variable holding the API key.

## Goals

- Make `--bare` a per-spec toggle, defaulting to today's behavior (bare on).
- When bare is on, let a spec reference a host environment variable whose value Kata forwards to claude as the API key.
- Keep the secret out of the spec file: the spec carries the variable *name*, never the value. This stays safe in git, logs, and M7 portable bundles.
- Surface both controls in the Workbench compose pane.

## Non-goals

- Storing or encrypting secret values anywhere in Kata. The token lives in the environment; Kata only references it.
- A runtime prompt for the token. Headless and CI runs cannot prompt, so the env-reference model is the single mechanism.
- Per-run choice of the *target* variable. claude authenticates via `ANTHROPIC_API_KEY`; Kata always sets that on the child. Only the *source* variable name is configurable.

## The contract — `RunSpec`

A new `auth` sub-table, nested like `identity` / `model` / `leash`.

```toml
[auth]
bare = true                      # default — the empty room (today's behavior)
token_env = "ANTHROPIC_API_KEY"  # only meaningful when bare; names a host env var
```

```rust
#[serde(default)]
pub auth: Auth,

pub struct Auth {
    pub bare: bool,                // default true
    pub token_env: Option<String>, // None = rely on ambient credentials
}
```

`bare` defaults to `true` so existing specs and current behavior are unchanged. `token_env` defaults to `None` and is skipped in serialization when unset. The secret never enters the struct — only the variable name.

The struct derives `ts_rs::TS` and exports to `app/src/bindings/Auth.ts`; `RunSpec.ts` gains the required `auth` field. Bindings are regenerated, not hand-edited.

## Engine behavior

### `command.rs` (`build_invocation`)

- Emit `--bare` only when `spec.auth.bare == true`. When false, claude runs with the user's full real config.
- Token forwarding: when `bare && token_env == Some(name)`, resolve `name` from the process environment and, if present and non-empty, push `("ANTHROPIC_API_KEY", value)` onto `inv.env`. The source variable name is configurable; the target is always `ANTHROPIC_API_KEY`.
- `token_env` is ignored when `bare == false` — claude uses the user's logged-in session instead.
- `--dangerously-skip-permissions` stays unconditional. It governs headless non-interactivity, not the empty room, so it is independent of `bare`.

### `run.rs` (pre-spawn guard)

Before spawning, if `bare && token_env == Some(name)` and `name` resolves to an unset or empty variable, emit a clear `run.error` and refuse to spawn — the same fail-fast pattern as the worktree-non-repo guard. This prevents a doomed run and pairs with the now-visible child stderr. A new `RunError` variant carries the message; the CLI maps it like other pre-spawn refusals.

## Workbench (compose pane)

A new "Environment" section in `ComposePane.svelte`:

- A `Segmented` toggle: `bare` / `full`, bound to `spec.auth.bare`.
- Shown only when bare is on: a mono `Field` for `spec.auth.token_env`, with hint text "name of an env var holding your API key — not the key itself".

Built from the existing `Field` / `Segmented` primitives, styled only against CSS custom properties per `app/CLAUDE.md`. The `mock.ts` fixtures gain the new `auth` field so the browser-only fallback keeps type-checking.

## Testing (TDD)

- `command.rs`: `bare = true` emits `--bare`; `bare = false` omits it. With `bare` and `token_env` naming a present variable, `inv.env` contains `ANTHROPIC_API_KEY` with that value. With `bare = false`, `token_env` is ignored even when the variable is set.
- `run.rs`: `bare` with `token_env` naming an unset variable produces a `run.error` and no spawn (deterministic — fails before claude launches, no fake needed).
- `spec.rs`: `Auth::default()` has `bare == true` and `token_env == None`; TOML and JSON round-trip.
- Frontend (Vitest): the `token_env` field renders only when bare is on.
- Full gate: `cargo clippy --all-targets -- -D warnings`, `cargo build --locked`, `cargo test --workspace`, `npm run check` and `npm test`, and the ts-rs export test.

## Docs

Update `CLAUDE.md` so the engine description reads that `--bare` is the *default* empty room rather than unconditional.

## Out of scope / follow-ups

- A `[plugins]`-style mechanism for forwarding additional secrets is unchanged; only the API key gets first-class treatment here.
- If a future need arises for a non-`ANTHROPIC_API_KEY` target (e.g. a gateway), that becomes a separate field, not a change to this one.
