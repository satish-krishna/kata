# Optional `--bare` + referenced auth token — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `--bare` a per-spec toggle (default on) and, when bare, let a spec reference a host env var whose value Kata forwards to claude as `ANTHROPIC_API_KEY`.

**Architecture:** Add an `Auth { bare, token_env }` sub-struct to the `RunSpec` contract. `command.rs` emits `--bare` only when `bare` is true and forwards the resolved token as `ANTHROPIC_API_KEY`. `run.rs` fails fast (before spawn) when a bare run references a token var that is unset. The Workbench compose pane gains an "Environment" section. The secret stays in the environment; the spec carries only the variable name.

**Tech Stack:** Rust (kata-core, ts-rs bindings), SvelteKit 5 + TypeScript (Workbench), Vitest.

## Global Constraints

- TDD: no production code without a failing test first. Watch each test fail before implementing.
- `cargo clippy --all-targets -- -D warnings` must stay clean.
- `cargo build --locked` must stay green.
- Style only against CSS custom properties in Svelte — never hard-code a hex value (`app/CLAUDE.md`).
- Do not hand-edit `app/src/bindings/`; regenerate with `cargo test -p kata-core --features ts export_bindings`.
- The token secret must never be written into the spec — only the variable name.
- `bare` defaults to `true` (preserves today's behavior).
- The forwarded target env var is always `ANTHROPIC_API_KEY`; only the source name is configurable.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work on branch `feat/optional-bare-auth-token` (already created).

---

### Task 1: `Auth` sub-struct on `RunSpec` + bindings

**Files:**
- Modify: `crates/kata-core/src/spec.rs` (add `Auth` struct, `RunSpec.auth` field, `Default`, update `full_spec()` test helper, add unit tests)
- Modify (generated): `app/src/bindings/RunSpec.ts`, `app/src/bindings/Auth.ts`

**Interfaces:**
- Produces: `kata_core::spec::Auth { pub bare: bool, pub token_env: Option<String> }`, `Auth::default()` → `{ bare: true, token_env: None }`, and `RunSpec.auth: Auth`.

- [ ] **Step 1: Write the failing tests + extend the round-trip helper**

In `crates/kata-core/src/spec.rs`, inside `mod tests`, add these three tests next to `validate_passes_minimal`:

```rust
    #[test]
    fn auth_defaults_to_bare_with_no_token() {
        let auth = Auth::default();
        assert!(auth.bare, "bare must default to true (the empty room)");
        assert_eq!(auth.token_env, None);
    }

    #[test]
    fn auth_absent_in_toml_defaults_to_bare() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert!(spec.auth.bare);
        assert_eq!(spec.auth.token_env, None);
    }

    #[test]
    fn auth_parses_explicit_table() {
        let toml = r#"
schema = 1
name = "a"
task = "t"
workdir = "/w"

[auth]
bare = false
token_env = "MY_KEY"
"#;
        let spec: RunSpec = toml::from_str(toml).unwrap();
        assert!(!spec.auth.bare);
        assert_eq!(spec.auth.token_env.as_deref(), Some("MY_KEY"));
    }
```

In the same module, update the `full_spec()` helper so the existing TOML/JSON round-trip tests also cover `auth`. Change its trailing `leash: ...,` line + closing brace from:

```rust
            leash: Leash { max_turns: 8, timeout_secs: Some(600), isolation: Isolation::Worktree },
        }
```

to:

```rust
            leash: Leash { max_turns: 8, timeout_secs: Some(600), isolation: Isolation::Worktree },
            auth: Auth { bare: false, token_env: Some("ANTHROPIC_API_KEY".into()) },
        }
```

- [ ] **Step 2: Add the struct + field with a deliberately-wrong default (to watch RED)**

In `crates/kata-core/src/spec.rs`, add the `auth` field to the `RunSpec` struct, immediately after the `leash` field:

```rust
    #[serde(default)]
    pub leash: Leash,
    #[serde(default)]
    pub auth: Auth,
}
```

Add `auth` to the `RunSpec` `Default` impl, immediately after `leash: Leash::default(),`:

```rust
            leash: Leash::default(),
            auth: Auth::default(),
        }
```

Add the `Auth` struct. Place it immediately after the line `fn default_max_turns() -> u32 { 12 }`:

```rust
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Auth {
    #[serde(default = "default_bare")]
    pub bare: bool,
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_env: Option<String>,
}

impl Default for Auth {
    fn default() -> Self {
        Self { bare: default_bare(), token_env: None }
    }
}

fn default_bare() -> bool { false } // STUB: wrong on purpose to watch RED
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p kata-core --lib auth_`
Expected: `auth_defaults_to_bare_with_no_token` and `auth_absent_in_toml_defaults_to_bare` FAIL with `assertion failed: auth.bare` (left `false`, right `true`). `auth_parses_explicit_table` PASSES.

- [ ] **Step 4: Fix the default**

In `crates/kata-core/src/spec.rs`, change the stub to the real default:

```rust
fn default_bare() -> bool { true }
```

- [ ] **Step 5: Run the spec tests to verify green**

Run: `cargo test -p kata-core --lib spec::`
Expected: PASS, including `auth_*`, `save_then_load_round_trips_toml`, and `save_then_load_round_trips_json`.

- [ ] **Step 6: Regenerate ts-rs bindings**

Run: `cargo test -p kata-core --features ts export_bindings`
Then: `git status --porcelain app/src/bindings/`
Expected: `Auth.ts` created and `RunSpec.ts` modified (now carrying an `auth: Auth` field). Do not hand-edit either file.

- [ ] **Step 7: Commit**

```bash
git add crates/kata-core/src/spec.rs app/src/bindings/Auth.ts app/src/bindings/RunSpec.ts
git commit -m "$(printf 'feat(spec): add Auth { bare, token_env } to RunSpec\n\nbare defaults true (the empty room). token_env names a host env var, not\nthe secret itself; skipped in serialization when unset. ts-rs bindings\nregenerated.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `command.rs` — conditional `--bare` + token forwarding + doc

**Files:**
- Modify: `crates/kata-core/src/command.rs` (`build_invocation` + tests)
- Modify: `CLAUDE.md` (one phrase)

**Interfaces:**
- Consumes: `spec.auth.bare: bool`, `spec.auth.token_env: Option<String>` (from Task 1).
- Produces: `--bare` present in `inv.args` iff `spec.auth.bare`; `("ANTHROPIC_API_KEY", value)` present in `inv.env` iff `bare` and `token_env` names a non-empty host var.

- [ ] **Step 1: Write the failing tests**

In `crates/kata-core/src/command.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn bare_flag_omitted_when_disabled() {
        let mut s = spec();
        s.auth.bare = false;
        let inv = build_invocation(&s, &assembled_with(None, None));
        assert!(!inv.args.contains(&"--bare".to_string()));
    }

    #[test]
    fn forwards_token_env_as_api_key_when_bare() {
        std::env::set_var("KATA_TEST_APIKEY", "sk-test-123");
        let mut s = spec();
        s.auth.bare = true;
        s.auth.token_env = Some("KATA_TEST_APIKEY".into());
        let inv = build_invocation(&s, &assembled_with(None, None));
        assert!(inv.env.iter().any(|(k, v)| k == "ANTHROPIC_API_KEY" && v == "sk-test-123"));
        std::env::remove_var("KATA_TEST_APIKEY");
    }

    #[test]
    fn ignores_token_env_when_not_bare() {
        std::env::set_var("KATA_TEST_APIKEY2", "sk-test-456");
        let mut s = spec();
        s.auth.bare = false;
        s.auth.token_env = Some("KATA_TEST_APIKEY2".into());
        let inv = build_invocation(&s, &assembled_with(None, None));
        assert!(!inv.env.iter().any(|(k, _)| k == "ANTHROPIC_API_KEY"));
        std::env::remove_var("KATA_TEST_APIKEY2");
    }
```

(The existing `base_command_has_bare_print_streamjson_verbose_bypass` already asserts `--bare` is present by default; default `bare == true` keeps it passing.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kata-core bare_flag_omitted_when_disabled forwards_token_env_as_api_key_when_bare ignores_token_env_when_not_bare`
Expected: `bare_flag_omitted_when_disabled` FAILS (`--bare` still always emitted); `forwards_token_env_as_api_key_when_bare` FAILS (no `ANTHROPIC_API_KEY` in env). `ignores_token_env_when_not_bare` PASSES (no forwarding exists yet).

- [ ] **Step 3: Make `--bare` conditional**

In `crates/kata-core/src/command.rs`, replace the args initialization:

```rust
    let mut args: Vec<String> = vec![
        "--bare".into(),
        "-p".into(),
        compose_prompt(spec),
    ];
```

with:

```rust
    let mut args: Vec<String> = Vec::new();
    if spec.auth.bare {
        args.push("--bare".into());
    }
    args.push("-p".into());
    args.push(compose_prompt(spec));
```

- [ ] **Step 4: Forward the token when bare**

In `crates/kata-core/src/command.rs`, find the env-building block:

```rust
    let mut env = Vec::new();
    for cfg in spec.plugins.values() {
        for name in &cfg.env {
            if let Ok(val) = std::env::var(name) {
                env.push((name.clone(), val));
            }
        }
    }
```

Append, immediately after that loop (before `ClaudeInvocation { ... }`):

```rust
    // The empty room has no ambient credentials, so a bare run forwards the API
    // key named by auth.token_env (resolved from the host env) as the standard
    // ANTHROPIC_API_KEY. When not bare, claude uses the user's logged-in session.
    if spec.auth.bare {
        if let Some(name) = spec.auth.token_env.as_ref().filter(|n| !n.trim().is_empty()) {
            if let Ok(val) = std::env::var(name) {
                if !val.trim().is_empty() {
                    env.push(("ANTHROPIC_API_KEY".into(), val));
                }
            }
        }
    }
```

- [ ] **Step 5: Run the command tests to verify green**

Run: `cargo test -p kata-core --lib command::`
Expected: PASS (all command tests, including the three new ones and the existing base/bare test).

- [ ] **Step 6: Update the engine description in CLAUDE.md**

In `CLAUDE.md`, find:

```
controls the edges: the empty room (`--bare`), retasking
```

Replace with:

```
controls the edges: the empty room (`--bare`, default-on but switchable per run), retasking
```

- [ ] **Step 7: Commit**

```bash
git add crates/kata-core/src/command.rs CLAUDE.md
git commit -m "$(printf 'feat(command): emit --bare only when auth.bare; forward token_env as ANTHROPIC_API_KEY\n\nA bare run forwards the host env var named by auth.token_env to claude as\nANTHROPIC_API_KEY; a non-bare run drops --bare and relies on the user'"'"'s\nlogged-in session, ignoring token_env.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: `run.rs` — fail fast on an unresolved token var

**Files:**
- Modify: `crates/kata-core/src/run.rs` (add `RunError::Auth`, pre-spawn guard)
- Modify: `crates/kata-core/tests/run_it.rs` (integration test)

**Interfaces:**
- Consumes: `spec.auth.bare`, `spec.auth.token_env` (Task 1).
- Produces: `RunError::Auth(String)`; a `KataEvent::RunError` and no `RunStarted` when a bare run references an unset/empty token var.

- [ ] **Step 1: Write the failing test**

In `crates/kata-core/tests/run_it.rs`, add next to `run_invalid_spec_errors_before_spawn`:

```rust
#[test]
#[serial]
fn run_refuses_bare_run_with_unresolved_token_env() {
    with_fake("ok");
    std::env::remove_var("KATA_MISSING_TOKEN"); // ensure the referenced var is unset
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.auth.bare = true;
    spec.auth.token_env = Some("KATA_MISSING_TOKEN".into());
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let err = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap_err();

    assert!(matches!(err, RunError::Auth(_)));
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunError { .. })));
    assert!(
        !events.iter().any(|e| matches!(e, KataEvent::RunStarted { .. })),
        "must refuse before run.started"
    );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kata-core --test run_it run_refuses_bare_run_with_unresolved_token_env`
Expected: FAIL to compile first (`RunError::Auth` undefined) — then once the variant exists but the guard does not, FAIL because `run()` spawns the fake and returns `Ok`. (You will confirm the real RED after Step 3 adds the variant; if you prefer a clean assertion RED, add the variant in Step 3 first, then re-run this step.)

- [ ] **Step 3: Add the `RunError::Auth` variant**

In `crates/kata-core/src/run.rs`, add to the `RunError` enum, after the `Worktree` variant:

```rust
    #[error("worktree isolation: {0}")]
    Worktree(String),
    #[error("auth: {0}")]
    Auth(String),
}
```

- [ ] **Step 4: Add the pre-spawn guard**

In `crates/kata-core/src/run.rs`, find:

```rust
    let inv = build_invocation(spec, &assembled);
```

Insert immediately after it:

```rust

    // Fail fast: a bare run that references a token var it cannot resolve would
    // reach the API unauthenticated. Refuse before creating a worktree or spawning.
    if spec.auth.bare {
        if let Some(name) = spec.auth.token_env.as_ref().filter(|n| !n.trim().is_empty()) {
            let resolved = std::env::var(name).ok().filter(|v| !v.trim().is_empty());
            if resolved.is_none() {
                let message = format!(
                    "auth.token_env names '{name}', but it is unset or empty in the environment"
                );
                emit(KataEvent::RunError { message: message.clone() });
                return Err(RunError::Auth(message));
            }
        }
    }
```

- [ ] **Step 5: Run the test to verify green**

Run: `cargo test -p kata-core --test run_it run_refuses_bare_run_with_unresolved_token_env`
Expected: PASS.

- [ ] **Step 6: Run the full engine test suite (no regressions)**

Run: `cargo test -p kata-core --test run_it`
Expected: PASS (all existing run_it tests + the new one). Note: the CLI already maps every `RunError` to exit 2 via its generic `Err(e) => ExitCode::from(2)` arm, so no kata-cli change is needed.

- [ ] **Step 7: Commit**

```bash
git add crates/kata-core/src/run.rs crates/kata-core/tests/run_it.rs
git commit -m "$(printf 'feat(run): refuse a bare run whose auth.token_env is unset before spawning\n\nEmits run.error and returns RunError::Auth (CLI exit 2) instead of\nlaunching an unauthenticated claude.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Workbench — Environment section in the compose pane

**Files:**
- Modify: `app/src/lib/components/Segmented.svelte` (add optional `onChange`)
- Modify: `app/src/lib/spec.ts` (`defaultSpec`, `draftFrom`, `normalize`)
- Modify: `app/src/lib/mock.ts` (`seedSpec`)
- Modify: `app/src/lib/components/ComposePane.svelte` (new section)
- Modify: `app/src/lib/spec.test.ts` (tests for the spec-helper changes)

**Interfaces:**
- Consumes: the regenerated `RunSpec`/`Auth` TS types (Task 1) — `spec.auth: { bare: boolean; token_env?: string | null }`.
- Produces: `defaultSpec().auth === { bare: true, token_env: null }`; `Segmented` accepts an optional `onChange?: (v: T) => void`.

- [ ] **Step 1: Write the failing frontend tests**

In `app/src/lib/spec.test.ts`, add inside the `describe("spec helpers", ...)` block:

```typescript
  it("defaultSpec carries a bare auth with no token", () => {
    const s = defaultSpec();
    expect(s.auth.bare).toBe(true);
    expect(s.auth.token_env).toBeNull();
  });

  it("normalize converts a blank token_env to null", () => {
    const s = defaultSpec();
    s.auth.token_env = "   ";
    expect(normalize(s).auth.token_env).toBeNull();
  });
```

And inside the `describe("draftFrom", ...)` block:

```typescript
  it("defaults auth when the loaded spec omits it", () => {
    const loaded = { schema: 1, name: "x", task: "t", workdir: "/w", identity: { mode: "append" }, skills: [], plugins: {}, model: {}, leash: { max_turns: 8, isolation: "none" } } as any;
    const draft = draftFrom(loaded);
    expect(draft.auth.bare).toBe(true);
    expect(draft.auth.token_env).toBeNull();
  });

  it("preserves a loaded auth block", () => {
    const loaded = { ...defaultSpec(), auth: { bare: false, token_env: "MY_KEY" } } as any;
    const draft = draftFrom(loaded);
    expect(draft.auth.bare).toBe(false);
    expect(draft.auth.token_env).toBe("MY_KEY");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `app/`): `npm test -- spec.test`
Expected: FAIL — `defaultSpec().auth` is `undefined` (and a TypeScript error that `auth` is missing on the returned `RunSpec`, since the regenerated type now requires it).

- [ ] **Step 3: Add `auth` to the spec helpers**

In `app/src/lib/spec.ts`, in `defaultSpec()`, add `auth` after the `leash` line:

```typescript
    leash: { max_turns: 12, timeout_secs: null, isolation: "none" },
    auth: { bare: true, token_env: null },
  };
```

In `draftFrom()`, add an `auth` line after the `plugins:` line:

```typescript
    skills: loaded.skills ?? [],
    plugins: loaded.plugins ?? {},
    auth: { bare: loaded.auth?.bare ?? true, token_env: loaded.auth?.token_env ?? null },
  };
```

In `normalize()`, add a line after `c.model.id = blankToNull(c.model.id);`:

```typescript
  c.model.id = blankToNull(c.model.id);
  c.auth.token_env = blankToNull(c.auth.token_env);
  return c;
```

- [ ] **Step 4: Add `auth` to the browser fixture**

In `app/src/lib/mock.ts`, in `seedSpec()`, add `auth` after the `leash` line:

```typescript
    leash: { max_turns: 12, timeout_secs: 900, isolation: "worktree" },
    auth: { bare: true, token_env: null },
  };
```

- [ ] **Step 5: Run the tests to verify green**

Run (from `app/`): `npm test -- spec.test`
Expected: PASS (all spec-helper tests, including the four new ones).

- [ ] **Step 6: Add the optional `onChange` to `Segmented`**

In `app/src/lib/components/Segmented.svelte`, replace the `$props()` block:

```svelte
  let {
    options,
    value = $bindable(),
    ariaLabel,
  }: {
    options: readonly T[];
    value: T;
    ariaLabel?: string;
  } = $props();
```

with:

```svelte
  let {
    options,
    value = $bindable(),
    ariaLabel,
    onChange,
  }: {
    options: readonly T[];
    value: T;
    ariaLabel?: string;
    onChange?: (v: T) => void;
  } = $props();
```

and change the click handler:

```svelte
      onclick={() => (value = opt)}
```

to:

```svelte
      onclick={() => { value = opt; onChange?.(opt); }}
```

(Existing `bind:value` usages are unaffected — `onChange` is undefined for them.)

- [ ] **Step 7: Add the Environment section to the compose pane**

In `app/src/lib/components/ComposePane.svelte`, find the Leash section opener:

```svelte
  <section class="wb-section">
    <div class="wb-section__head">
      <span class="wb-section__num">04 · THE LEASH</span>
```

Insert this new section immediately **before** it:

```svelte
  <section class="wb-section">
    <div class="wb-section__head">
      <span class="wb-section__title">Environment</span>
      <span class="wb-section__sub">the room claude runs in</span>
    </div>
    <Field label="Room" key="auth.bare" hint="bare = the empty room (curated kit only). full = your real claude config, plugins, and login.">
      <Segmented
        options={["bare", "full"] as const}
        value={spec.auth.bare ? "bare" : "full"}
        onChange={(v) => (spec.auth.bare = v === "bare")}
        ariaLabel="Environment"
      />
    </Field>
    {#if spec.auth.bare}
      <Field label="Token env var" key="auth.token_env" hint="Name of an env var holding your API key — not the key itself.">
        <input class="k-input k-input--mono" placeholder="ANTHROPIC_API_KEY" bind:value={spec.auth.token_env} />
      </Field>
    {/if}
  </section>

```

- [ ] **Step 8: Type-check and run the full frontend suite**

Run (from `app/`): `npm run check`
Expected: 0 errors (confirms every `RunSpec` literal now carries `auth`, and the new template type-checks).
Run (from `app/`): `npm test`
Expected: PASS (all Vitest suites).

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/components/Segmented.svelte app/src/lib/components/ComposePane.svelte app/src/lib/spec.ts app/src/lib/mock.ts app/src/lib/spec.test.ts
git commit -m "$(printf 'feat(workbench): Environment section — bare/full toggle + token_env field\n\nSegmented gains an optional onChange so the bool auth.bare maps cleanly to\na bare/full segment; the token_env field shows only when bare. spec\nhelpers and the browser fixture carry the new auth block.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Full-gate verification

**Files:** none (verification only).

- [ ] **Step 1: Rust gate**

Run: `cargo clippy --all-targets -- -D warnings`
Expected: clean (no warnings).
Run: `cargo build --locked`
Expected: green.
Run: `cargo test --workspace`
Expected: all suites PASS.

- [ ] **Step 2: Confirm bindings are in sync**

Run: `cargo test -p kata-core --features ts export_bindings`
Then: `git status --porcelain app/src/bindings/`
Expected: empty (bindings already committed in Task 1; no drift).

- [ ] **Step 3: Frontend gate**

Run (from `app/`): `npm run check`
Expected: 0 errors.
Run (from `app/`): `npm test`
Expected: PASS.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/optional-bare-auth-token
gh pr create --base main --head feat/optional-bare-auth-token --title "feat: optional --bare with referenced auth token" --body-file docs/superpowers/specs/2026-06-17-optional-bare-auth-token-design.md
```

---

## Self-Review

**Spec coverage:**
- RunSpec `Auth { bare, token_env }`, default bare true, token_env skipped when None → Task 1. ✅
- ts-rs bindings regenerated → Task 1 Step 6. ✅
- `--bare` only when `auth.bare` → Task 2 Step 3. ✅
- Forward `token_env` as `ANTHROPIC_API_KEY` when bare; ignore when non-bare → Task 2 Steps 4 + tests. ✅
- `--dangerously-skip-permissions` stays unconditional → untouched in Task 2 (left as-is). ✅
- Fail-fast on unresolved token var, no spawn → Task 3. ✅
- CLI maps it like other refusals → confirmed no change needed (Task 3 Step 6 note). ✅
- Workbench Environment section: bare/full toggle + conditional token_env field → Task 4 Steps 6–7. ✅
- `mock.ts` fixtures gain `auth` → Task 4 Step 4. ✅
- CLAUDE.md tweak → Task 2 Step 6. ✅
- Tests: command (bare on/off, forward, ignore), run (missing var), spec (default, round-trip), frontend (helpers) → Tasks 1–4. ✅
- Full gate (clippy, build --locked, workspace, npm check/test, export test) → Task 5. ✅

**Placeholder scan:** No TBD/TODO; every code step shows the exact code. ✅

**Type consistency:** `Auth { bare: bool, token_env: Option<String> }` used identically across spec.rs, command.rs, run.rs; TS `auth: { bare: boolean; token_env?: string | null }` used in spec.ts/mock.ts/ComposePane. `RunError::Auth(String)` defined (Task 3 Step 3) before use. `Segmented` `onChange?: (v: T) => void` defined (Task 4 Step 6) before use in ComposePane (Step 7). ✅
