# Recipe: add a feature

Most changes to Kata are one of four shapes, and each has a regeneration chain that CI gates. Getting the chain wrong is the common failure: the code compiles, the tests pass locally, and CI fails on artifact drift.

Read [`CONTRACTS.md`](../CONTRACTS.md) first if your change touches `RunSpec`, `KataEvent`, an exit code, or the CLI's stdin/stdout behavior. Those are frozen surfaces and the drift gates do **not** catch a semantic break.

Work test-first. TDD is the workflow, not a suggestion.

## Pick your shape

| You are adding | Go to |
|---|---|
| A run-spec field | [A](#a-add-a-run-spec-field) |
| An event type or an event field | [B](#b-add-an-event-type-or-field) |
| A CLI subcommand or flag | [C](#c-add-a-cli-subcommand-or-flag) |
| A Workbench pane or control | [D](#d-add-a-workbench-pane-or-control) |

---

## A. Add a run-spec field

1. **Add the field** to the relevant type in `crates/kata-core/src/spec.rs`. Make it **optional with a default** that preserves current behavior when absent — an existing valid spec must keep loading and keep meaning the same thing. That is what makes the change minor rather than major.

2. **Extend `validate`** if the field has structural rules. Validation is pure and side-effect free; it must not touch the filesystem.

3. **Use it** in `crates/kata-core/src/command.rs` (if it changes the claude invocation) or `run.rs` (if it changes the leash or orchestration).

4. **Regenerate both artifacts:**

   ```console
   cargo test -p kata-core --features ts export_bindings
   KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema runspec_schema_artifact_is_fresh
   ```

   The first writes the TypeScript bindings in `app/src/bindings/`. The second writes `schema/kata-runspec.schema.json`. Never hand-edit either.

5. **Mirror any numeric bounds** into the schema so editor validation matches runtime validation.

6. **Check `CONTRACTS.md`.** A new optional field with a behavior-preserving default is additive and minor. Renaming a field, changing a default's meaning, or tightening `validate` so a previously valid spec is rejected is a **major** break, and nothing in CI will tell you.

## B. Add an event type or field

1. **Add it** to `KataEvent` in `crates/kata-core/src/event.rs`. New fields on an existing event carry `#[serde(default)]` so transcripts written before the change still deserialize — otherwise old runs vanish from the Workbench history.

2. **Emit it** from `crates/kata-core/src/run.rs`. Note the ordering rule: `run.diff` is emitted *before* the terminal event, so a consumer sees what changed paired with how it ended.

3. **Regenerate the schema, then the TypeScript:**

   ```console
   KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema schema_artifact_is_fresh
   cd app && npm run gen:events
   ```

   Order matters. The schema is generated from Rust; `app/src/bindings/kata-events.ts` is generated from the **schema**, not from Rust. `app/src/lib/events.ts` re-exports it and adds hand-written render helpers — put display logic there, never in the generated file.

4. **Leave `protocolVersion` at 1** for an additive change. Bump it only on a breaking one.

5. **Check `CONTRACTS.md`.** A new event type or a new optional field is minor. Renaming an event, removing a field, or changing what a field *means* is major, and passes every gate green.

## C. Add a CLI subcommand or flag

1. **Add the variant** to the `Cmd` enum in `crates/kata-cli/src/main.rs` (clap `Subcommand`).

2. **Keep the CLI thin.** It parses arguments, calls `kata_core`, and maps the outcome to an exit code. Behavior belongs in the engine, where the GUI and orchestrators also reach it.

3. **Do not reuse an exit code.** Each leash outcome owns one, and consumers branch on them. A new condition gets a new, previously-unused code; reassigning an existing one is a major break. See the table in [`CONTRACTS.md`](../CONTRACTS.md).

4. **Add an integration test** in `crates/kata-cli/tests/cli_it.rs`.

## D. Add a Workbench pane or control

1. **Backend command** in `app/src-tauri/src/lib.rs`. Follow the existing split: link `kata-core` in-process for cheap pure operations (`catalog`, `load_spec`, `save_spec`, `validate_spec`), and **spawn the `kata` sidecar for anything that runs a kata**. Do not add a second execution path — that is the one rule the Workbench exists to respect.

2. **Register it** in the `tauri::generate_handler![...]` list.

3. **Frontend** in `app/src/lib/components/`, using the generated types from `app/src/bindings/`. Never hand-write a type that already exists there.

4. **Respect the design system.** Rules are in `app/CLAUDE.md` and are non-negotiable: style only against CSS custom properties, never a literal hex. The pixel references in `design/prototype/` are HTML and React — recreate in Svelte, never copy.

5. **Keep `api.ts` gated.** Every backend call goes through `inTauri()` so the browser dev path keeps working against fixtures.

---

## Testing

```console
cargo test --workspace
cd app && npm test
```

Engine integration tests drive the offline `fake-claude` binary through `KATA_FAKE_MODE`. If your change needs a new child behavior — a new failure mode, a new timing — add a mode to `crates/kata-core/src/bin/fake-claude.rs` rather than reaching for a real `claude`.

Those tests mutate process-global environment and are marked `#[serial]`. Do not remove that.

The real-claude smoke test runs only when `KATA_SMOKE_REAL` is set and needs an authenticated `claude` on PATH.

## Gates before the PR

```console
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo build --locked
```

`cargo fmt` is workspace-wide, so it can surface pre-existing drift in files you did not touch.

## The check no tool performs

Run through [`CONTRACTS.md`](../CONTRACTS.md) by hand. The schema freshness tests and the ts-rs bindings check catch **shape** drift — a type whose generated artifact no longer matches. They catch **semantic** breaks not at all: rename an event, repurpose an exit code, or change what a field means, regenerate, and every gate goes green while every existing consumer breaks.

The test to apply: *would existing, correct consumer code or an existing valid run-spec break?* If yes, it is a major version bump regardless of what CI says.
