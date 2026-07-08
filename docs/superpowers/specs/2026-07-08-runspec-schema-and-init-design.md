# Kata Enhancement — Run-Spec JSON Schema and `kata init`

**Target repository:** `satish-krishna/kata` (`docs/superpowers/specs/`).
**Status:** Proposed. Awaiting review before an implementation plan is written.
**Date:** 2026-07-08.
**Affected crates:** `kata-core` (`crates/kata-core`) — new schema artifact and render/bless plumbing; `kata-cli` (`crates/kata-cli`) — new `init` subcommand. No change to the `KataEvent` protocol, the run-spec *runtime* contract, or exit-code semantics.

## Motivation

A person authoring their first run-spec today has no discovery path. The run-spec is a hand-written TOML file, and the only descriptions of its shape are the prose reference table in `docs/consuming-kata.md`, the `RunSpec` Rust struct, and the ts-rs TypeScript bindings — none of which a hand-author reads while typing. The executable oracle, `kata validate`, tells them *after the fact* that they got a field name wrong; it does not tell them the field exists, what it accepts, or what its default is. This is friction at exactly the moment that decides adoption: the first five minutes with the tool.

The event protocol already solves the mirror-image problem for consumers — "what comes back" is published as a language-neutral JSON Schema at `schema/kata-events.schema.json`, drift-gated in CI. The "what to run" side has no equivalent. This enhancement closes that asymmetry, but for the *authoring* use case rather than machine validation: a JSON Schema exists primarily so editor tooling (VS Code's Even Better TOML / the Taplo LSP) can offer autocomplete on field names, hover documentation, and inline errors while the spec is being typed. A scaffolding command wires that discovery in from the first command so the author never has to find or configure it.

`kata validate` remains the validation backstop and is unchanged. This work is about discovery and first-run ergonomics, not a second validation path.

## Goals

- Publish a language-neutral JSON Schema for the run-spec at `schema/kata-runspec.schema.json`, generated from `RunSpec` via `schemars`, drift-gated in CI exactly like the event schema.
- Make that schema deliver *live editor discovery* — autocomplete, hover docs, inline validation — for anyone authoring a spec in a JSON-Schema-aware TOML editor.
- Add `kata init [NAME]` to scaffold a valid, annotated starter spec that is pre-wired to the schema, so discovery works from the first command with zero editor configuration.
- Keep the schema and the starter honest against the `RunSpec` struct by construction (CI gates, not vigilance).
- Change nothing about the run-spec runtime contract, the event protocol, or exit codes.

## Non-goals

- No schema-driven type generation for other languages. The schema is for validation and editor discovery; consumers that want typed models still hand-write them (or use the existing ts-rs bindings for TypeScript).
- No interactive `init` wizard. `init` writes a file and exits; it does not prompt.
- No editor-settings auto-configuration. The `#:schema` directive embedded in the scaffolded file makes per-editor schema association unnecessary.
- No change to `kata validate`, `kata run`, or any exit code. `run()` continues to validate internally as its first action.
- No `schema` (run-spec format version) bump. This work describes the existing `schema = 1` format; it does not change it.

## Current behavior (as of the reviewed source)

- `RunSpec` (`crates/kata-core/src/spec.rs`) carries `schema: u32`, `name`, `description?`, `task`, `context?`, `workdir`, `identity: Identity`, `skills: Vec<String>`, `plugins: BTreeMap<String, PluginConfig>`, `model: Model`, `leash: Leash`, `auth: Auth`, `interactive: Interactive`, `env: BTreeMap<String, String>`, `env_remove: Vec<String>`.
- The sub-types are `Identity { system_prompt?, mode: IdentityMode }`, `IdentityMode { Append | Replace }`, `PluginConfig { mcp?, env: Vec<String> }`, `Model { id? }`, `Leash { max_turns?, timeout_secs?, max_budget_usd?, isolation: Isolation }`, `Isolation { None | Worktree }`, `Auth { bare, token_env? }`, `Interactive { enabled, answer_timeout_secs? }`.
- Every one of these already derives `ts_rs::TS` behind the `ts` feature; none derives `schemars::JsonSchema`.
- The `schema` Cargo feature already exists on `kata-core` (`schema = ["dep:schemars"]`, `schemars = "1"`). It is currently used only by `KataEvent`.
- `crates/kata-core/src/event.rs` contains the reference pipeline to mirror: `#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]` on the event types; a render function that takes the `schemars::schema_for!` output and stamps a stable root `title`, a `protocolVersion`, and a trailing newline; and a `schema_artifact_is_fresh` test that regenerates the artifact when `KATA_BLESS_SCHEMA` is set and otherwise fails on drift against the committed `schema/kata-events.schema.json`.
- `crates/kata-cli/src/main.rs` has four public subcommands (`validate`, `catalog`, `run`, `bundle`) plus a hidden `mcp-ask`. There is no `init`. Exit codes: 0 ok, 1 validation failure, 2 load/parse or engine error, 70 not-implemented.

## Proposed change

### 1. The run-spec JSON Schema

Add `#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]` to `RunSpec` and all eight sub-types listed above, alongside the existing `ts` cfg_attr lines.

Add a `spec::render_schema()` function modeled on the event renderer:

- Start from `schemars::schema_for!(RunSpec)`.
- Set a stable root `title` — `"Kata run-spec"`.
- Stamp a top-level `specSchemaVersion: 1` so a machine reader can tie the schema document to the run-spec format version.
- Constrain the run-spec `schema` field to `const: 1` in the emitted schema, so an editor flags `schema = 2` (a wrong or future format version) as an error immediately rather than silently accepting it.
- Emit with a trailing newline for a clean diff.

Commit the rendered artifact to `schema/kata-runspec.schema.json`.

Add a `runspec_schema_artifact_is_fresh` test mirroring `schema_artifact_is_fresh`: under `KATA_BLESS_SCHEMA` it rewrites the committed file; otherwise it compares the freshly rendered schema against the committed file and fails on drift, printing the regenerate command. This reuses the existing `KATA_BLESS_SCHEMA` convention, so one blessing run refreshes both schema artifacts.

Because schemars emits each field's `description` from its Rust `///` doc comment, hover-doc quality depends on those comments. Part of this work is auditing `RunSpec` and its sub-types so **every field carries a crisp one-line doc comment** — that text is the hover tooltip an author reads. Fields with weak or missing doc comments get one written as part of this change.

### 2. `kata init [NAME]`

Add an `Init` subcommand to `kata-cli`:

- `kata init` writes `kata.toml` in the current directory.
- `kata init myrun` writes `myrun.toml`.
- The command refuses to overwrite an existing target file and exits non-zero with a clear message unless `--force` is passed.
- `--local` changes the embedded `#:schema` directive from a hosted URL to a repo-relative path (see section 3).

The scaffolded content is a **curated happy-path starter, not an exhaustive field dump**:

- Line 1 is the `#:schema` directive (section 3).
- The three required fields — `name`, `task`, `workdir` — are present and filled with obvious placeholder values.
- A small set of high-value optionals are present with terse inline comments: `leash.max_turns`, `leash.timeout_secs`, `model.id`, and `interactive.enabled`.
- Everything else (skills, plugins, auth, env, env_remove, isolation, budget, identity, etc.) is deliberately omitted from the file and left to editor autocomplete.

This division of labor is intentional and load-bearing: **`init` produces a good default; the schema provides completeness.** It keeps the starter short and readable, and — crucially — means `init` never has to enumerate every field and therefore cannot rot into a wall of commented-out noise as fields are added.

On success, `init` prints the next step to stderr: edit the file, then `kata validate <file>`. Exit 0 on write. The no-overwrite refusal gets its own dedicated exit code — **`73` (`EX_CANTCREAT` from `sysexits.h`, "can't create output file")** — chosen to keep it cleanly distinguishable from a spec load/parse failure (`2`) and to match the CLI's existing `sysexits.h` usage (`70` for not-implemented). It does not collide with any CLI code (`0`/`1`/`2`/`70`) or leash code (`122`–`125`, `130`). Any other IO failure while writing the file remains `2`.

### 3. The `#:schema` directive target

The Taplo TOML toolchain honors a first-line `#:schema <target>` comment and auto-associates the named schema with the file — no editor configuration required. `kata init` embeds this line so discovery is automatic.

**Default (hosted, version-pinned URL):**

```
#:schema https://raw.githubusercontent.com/satish-krishna/kata/v<VERSION>/schema/kata-runspec.schema.json
```

`<VERSION>` is `env!("CARGO_PKG_VERSION")` baked into the binary at build time. A spec scaffolded by kata `0.8.0` therefore points at the `v0.8.0` schema — reproducible, resolvable from any directory, and cached by the editor after first fetch. The repository is public and releases are tagged (`v0.7.0` latest at time of writing), so raw-GitHub URLs resolve for editor tooling.

**`--local` (working-tree-relative path):**

```
#:schema <path-from-spec-to>/schema/kata-runspec.schema.json
```

For authoring a spec inside a kata checkout, offline, or against the working-copy schema rather than a released one. Taplo resolves a relative `#:schema` target against the TOML file's *own* directory, so `init --local` computes the path from the new spec file's location to `schema/kata-runspec.schema.json` in the same working tree — locating the tree root by walking up for the workspace `Cargo.toml`. If the target file is not inside a kata working tree (no root found), `--local` errors with guidance rather than emit a path that will not resolve.

**Honest caveat, to be stated in the docs:** the hosted URL only resolves once that version is tagged and pushed. The release that first introduces the schema is the first release whose scaffolded URL works; dev builds between tags should use `--local`. This is a documentation note, not a code problem.

### 4. Guardrails

- **Schema drift:** the `runspec_schema_artifact_is_fresh` test (section 1) fails CI if the committed `schema/kata-runspec.schema.json` diverges from what `RunSpec` renders.
- **Starter validity:** a test asserts that the exact bytes `kata init` writes parse via `spec::load` and pass `spec::validate`. A field rename or a change to what `validate` requires that breaks the starter fails CI, instead of shipping a broken "getting started" experience. The `#:schema` line is a TOML comment, so `spec::load` ignores it and the test is unaffected by which directive form (`URL` or `--local`) the scaffold emits.

### 5. Documentation

- `docs/consuming-kata.md`: in the run-spec section (recently rewritten), point authors at `kata init` as the front door and note the schema lives at `schema/kata-runspec.schema.json`. State the hosted-URL-versus-`--local` distinction and the tag-must-exist caveat.
- Root `README.md`: mention `kata init` in the authoring/getting-started section.
- `schema/`: if a README is warranted, note that the directory now holds two artifacts — the event protocol schema and the run-spec schema — and how each is regenerated.

## Testing

- `runspec_schema_artifact_is_fresh` — drift gate for the schema artifact, mirroring the event schema test; same `KATA_BLESS_SCHEMA` bless path.
- `init` writes the expected file, refuses to overwrite without `--force`, and honors `--local`.
- The bytes `kata init` emits load and validate cleanly (starter-validity guard).
- Existing tests unchanged; no test touches the event protocol or exit-code contract.

## Contract impact

- **Run-spec runtime contract:** unchanged. This adds a *description* of the existing `schema = 1` format; it does not alter what `RunSpec` accepts or how `validate`/`run` behave.
- **Event protocol and exit codes:** untouched.
- **New public surface:** `schema/kata-runspec.schema.json` (a new, drift-gated artifact) and the `kata init` subcommand. `spec::render_schema` is added to `kata-core`; whether it is `pub` or test-only follows the event renderer's existing visibility.

## Risks and decisions

- **Doc-comment quality is now user-facing.** Field `///` comments become editor hover text. Mitigated by the audit in section 1; the cost is ongoing discipline, same as any doc.
- **Two schema artifacts to keep fresh.** A second drift gate is a second thing that can fail CI on an unrelated struct edit. This is the accepted, already-paid cost of the events schema, extended by one.
- **Hosted-URL coupling to a tag.** Addressed by `--local` and a documented caveat; not a blocker given the public, tagged repo.
- **Decided:** `init` = curated starter, schema = completeness (approved). Version-pinned hosted URL as the default directive, `--local` for relative (approved).

## Out of scope (possible follow-ups, separable)

- Cross-language type generation from the schema.
- An interactive `init` wizard or `init` templates (e.g. `--template brainstorm`).
- A `kata schema` subcommand that prints the schema path or content.
- Editor-settings auto-configuration beyond the `#:schema` directive.
