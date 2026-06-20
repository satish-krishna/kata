# Contributing to Kata

Thanks for working on Kata. This document is **normative**: the rules below are mandatory for every change, and CI / review will hold you to them. Kata is the single execution path the GUI, the Shokunin orchestrator, and CI all share, so discipline here is not ceremony — a sloppy change breaks consumers in two languages.

Read `CLAUDE.md` (repo-wide engineering notes) and, for any frontend work, `app/CLAUDE.md` (the non-negotiable design system) alongside this file.

## TL;DR — the gate every change must pass

Before you open a PR, all of these must be green, with no warnings:

```sh
cargo fmt --all                              # format your changes (rustfmt defaults)
cargo clippy --all-targets -- -D warnings    # must be clean, no warnings
cargo test --workspace                       # must pass
cargo build --locked                         # must build reproducibly
```

For frontend changes (`app/`), additionally from `app/`:

```sh
npm run check        # svelte-check / type-check
npm test             # Vitest
```

If you changed any `RunSpec` / `KataEvent` / catalog type, regenerate the TypeScript bindings (never hand-edit `app/src/bindings/`):

```sh
cargo test -p kata-core --features ts export_bindings
```

A PR that does not pass the gate is not ready for review.

## Test-Driven Development is mandatory

**No production code without a failing test first.** This is enforced in review, not merely encouraged.

The cycle is **red → green → refactor**:

1. **Red** — write the smallest test that expresses the desired behavior, run it, and *watch it fail* for the expected reason. A test you never saw fail proves nothing.
2. **Green** — write the minimum code to make it pass. No speculative extras (YAGNI).
3. **Refactor** — clean up with the test green; never add behavior in this step.

Rules:

- Every new function, bugfix, and behavior change ships with a test that was written first and observed failing.
- A bug fix begins with a failing test that reproduces the bug; the test stays as a regression guard.
- Tests assert real behavior, not mock behavior. Reach for the offline `fake-claude` harness (`KATA_FAKE_MODE`, see `crates/kata-core/tests/run_it.rs`) instead of mocking the agent loop.
- Test output must be pristine — stray warnings or noise are a review finding.
- The only TDD exceptions are throwaway spikes, generated code, and pure config; if you think you have another, ask in the PR before skipping.

If your work followed a plan under `docs/superpowers/plans/`, the plan's per-task red/green steps are the record reviewers expect to see reflected in your commits.

## Rust guidelines

Standard, boring, idiomatic Rust. Edition 2021, workspace `resolver = "2"`.

- **Formatting:** run `cargo fmt --all` before committing (rustfmt defaults; no custom `rustfmt.toml`). Format your own changes; a `cargo fmt --all --check` gate is the standard planned for CI (see the CI track in `ROADMAP.md`).
- **Lints:** `cargo clippy --all-targets -- -D warnings` must be clean. Fix the lint; do not blanket-`#[allow]` it. A narrowly-scoped `#[allow]` with a one-line justifying comment is acceptable only when clippy is demonstrably wrong.
- **Reproducible builds:** `cargo build --locked` must succeed; commit `Cargo.lock` changes when you add or bump a dependency. Prefer existing `[workspace.dependencies]` over introducing a new crate — justify every new dependency in the PR.
- **Error handling:** return `Result` with `thiserror`-derived error enums (see `spec`, `assemble`, `run`); never `unwrap`/`expect`/`panic!` on a path reachable from input or I/O. `unwrap` is acceptable in tests and on invariants you document.
- **Naming:** names describe what a thing does, not how. Follow the surrounding module's conventions.
- **Public API:** document public items with `///` doc comments, especially anything in the two cross-language contracts.
- **Keep modules focused.** Files that change together live together; split by responsibility, not by layer. If a file you are touching has grown unwieldy, a scoped cleanup is welcome — unrelated refactoring is not.

### Two contracts you must not break casually

`kata-core` is the reference implementation of two stable, language-neutral interfaces (Shokunin is .NET and consumes both):

- **The run-spec** (`spec::RunSpec`) — serialized to TOML/JSON.
- **The event protocol** (`event::KataEvent`) — one JSON object per line.

When you change either: regenerate the TS bindings (above), keep changes backward-compatible where possible (new fields optional via `#[serde(default, skip_serializing_if = ...)]`), and call the change out explicitly in the PR.

**Exit codes are part of the contract** and must be preserved: turn cap → 125, wall-clock timeout → 124, answer deadline → 123, budget ceiling → 122, cancel → 130; CLI validation failure → 1, load/parse error → 2. Do not repurpose these.

### Frontend (`app/`)

SvelteKit SPA + TypeScript + Svelte 5. The frontend stays **presentational** (gate backend calls on `inTauri()`). The design rules in `app/CLAUDE.md` are non-negotiable: style only against CSS custom properties (never hard-code a hex), sentence-case labels, no emoji in the UI. `npm run check` and `npm test` must pass.

## Conventional Commits are mandatory

Every commit message MUST follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <imperative, lower-case summary>

<optional body explaining what and why, not how>

<optional footers / trailers>
```

**Allowed types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`, `style`.

**Scopes** are the area touched, e.g. `engine`, `web`, `bindings`, `spec`, `roadmap`, `cli`. Examples from this repo's history:

```
feat(engine): make leash.max_turns optional (unset = unlimited)
fix(engine): stop interactive retask colliding with identity append
chore(bindings): regenerate Leash for optional max_turns
docs(roadmap): record post-v0.2.0 engine hardening
```

Rules:

- The summary is imperative mood, lower-case, no trailing period, ≤ ~72 chars.
- A breaking contract change uses `!` (e.g. `feat(spec)!: ...`) and a `BREAKING CHANGE:` footer describing the migration.
- Commit in small, logical, frequent units — ideally one red→green→refactor slice per commit. Don't bundle unrelated changes.
- Co-authored or assisted commits keep their trailers, e.g. `Co-Authored-By: ...`.

## Branches and pull requests

- Branch from `main`. Name branches by type: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`. Never commit directly to `main`.
- Keep a PR scoped to one logical change. Open it against `main` with a description of **what** changed and **why**, the verification you ran, and any contract/exit-code/binding impact.
- PRs are reviewed for spec compliance (does it do exactly what was asked — nothing more, nothing less) and code quality. Expect a review loop; address findings and re-request review rather than merging over them.
- Squash-merge is the norm; the PR title should itself be a valid Conventional Commit.

## License

By contributing, you agree your contributions are licensed under the project's MIT license.
