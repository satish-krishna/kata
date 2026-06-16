# Kata M8 — Worktree isolation (design)

Date: 2026-06-16
Milestone: M8 (Phase 3 — Portability and containment)
Status: design approved, pending spec review

## Problem

`Isolation::Worktree` already exists in the `RunSpec` contract and round-trips through TOML/JSON, but the engine only *labels* it: `run.rs` emits `isolation: "worktree"` and then runs the agent directly in `workdir` (see the confessing comment at `run.rs:55`). An agent given a destructive or exploratory task therefore mutates the live working tree even when the operator explicitly asked for a sandbox.

M8 makes the leash real: when `leash.isolation = "worktree"`, the engine creates an ephemeral git worktree off `workdir`, runs the agent there, and surfaces the result as a reviewable diff. The worktree persists on its own branch so the operator can inspect, merge, or discard the actual changed files.

## Decisions (settled in brainstorming)

- **Lifecycle: persist + emit diff.** The worktree is kept on disk on its own branch *and* a diff summary is emitted. The changed files survive review; the diff text is a convenience summary, not the only artifact.
- **Location + cleanup: central `~/.kata/worktrees`, native git cleanup.** Worktrees live under `~/.kata/worktrees/<slug>-<id>` — outside any repo, so the main repo's `git status` stays clean. Cleanup is the operator's job via standard `git worktree remove` / `git worktree prune`. No new `kata` subcommand (YAGNI); the branch is registered in the workdir repo, so `git worktree list` finds every worktree.
- **Missing git: hard error, refuse to run.** If `workdir` is not a git repo (or `git` is missing / there is no resolvable `HEAD`), the engine emits `run.error` and exits non-zero *before* spawning claude. Running un-isolated in the live workdir would be a silent, dangerous downgrade of an explicit request.
- **`run.started` carries the worktree.** `RunStarted` gains optional `worktree` and `branch` fields (null when `isolation = "none"`), so a consumer's status line can show the branch from the first event.
- **Scope: engine + CLI + event protocol + frontend type-tolerance.** The Workbench diff *panel* is deferred to a fast-follow. M8 ships the engine, the `run.diff` protocol, and the minimal `events.ts` change required to keep `npm run check` green; it does not render the diff visually.

## Architecture

### New module: `crates/kata-core/src/worktree.rs`

A small, single-purpose unit — git plumbing only, no knowledge of the agent loop. Cousin to `assemble.rs`, but its handle deliberately does **not** clean up on drop (persistence is the whole point).

```rust
pub struct Worktree {
    pub path: String,    // ~/.kata/worktrees/<slug>-<id>
    pub branch: String,  // kata/<slug>-<id>
}

pub struct DiffSummary {
    pub files: Vec<DiffFile>,
    pub insertions: u32,
    pub deletions: u32,
}

pub struct DiffFile {
    pub status: String,  // "A" | "M" | "D" | "R" ...
    pub path: String,
}

pub enum WorktreeError {
    NotAGitRepo(String),   // workdir is not a repo / no HEAD
    GitMissing,            // `git` not on PATH
    NoHome,                // could not resolve ~/.kata (HOME/USERPROFILE unset)
    Git { cmd: String, status: Option<i32>, stderr: String },
    Io(std::io::Error),
}

pub fn create(workdir: &str, slug: &str) -> Result<Worktree, WorktreeError>;
pub fn diff(wt: &Worktree) -> Result<DiffSummary, WorktreeError>;
```

`create`:
1. Verify `git` runs and `workdir` is a repo with a resolvable HEAD (`git -C <workdir> rev-parse --git-dir` and `git -C <workdir> rev-parse --verify HEAD`). On failure → `NotAGitRepo` / `GitMissing`.
2. Resolve a robust kata home: `~/.kata` from `HOME` (Unix) / `USERPROFILE` (Windows). If neither resolves, return `NoHome` — never fall back to `.` (this is the `dirs_home` backlog weakness, fixed in the path that actually cares about it; the catalog's own `dirs_home` is out of scope here).
3. Compute `path = <home>/.kata/worktrees/<slug>-<id>` and `branch = kata/<slug>-<id>`, where `<id>` is a short, monotonic suffix (e.g. millis-since-epoch in base36 plus a process-local counter) so concurrent or repeated runs of the same spec never collide on a branch name. `<slug>` reuses the same sanitizer the CLI applies to spec names (map anything outside `[A-Za-z0-9_-]` to `-`, trim, fall back to `kata`).
4. `git -C <workdir> worktree add -b <branch> <path> HEAD`. On failure → `Git { .. }`.

`diff` (computed **without mutating the index**, so the operator's later `git diff` in the worktree is unsurprised):
- Tracked changes: `git -C <path> diff HEAD --numstat --name-status` → per-file status + insertions/deletions.
- Untracked (newly created) files: `git -C <path> ls-files --others --exclude-standard` → reported as status `A`; their line counts are read directly (insertions = line count, deletions = 0). Binary files (numstat `-`) contribute 0/0 and a file entry.
- `insertions`/`deletions` are the summed totals.

### Wiring into `run.rs`

The single seam is `cwd`. Today `build_invocation` sets `inv.cwd = spec.workdir` and `run` passes it to `Command::current_dir`. M8 inserts one step:

1. `validate` → `assemble` (unchanged).
2. **If `isolation == Worktree`:** `worktree::create(&spec.workdir, &slug(&spec.name))?`, mapping `WorktreeError` to a new `RunError::Worktree(String)`. Override the spawn `cwd` to `wt.path`.
3. Emit `run.started` with `worktree`/`branch` set (or `None` for `Isolation::None`).
4. Spawn + run loop + leash enforcement: **entirely unchanged.**
5. After the loop ends on **any** termination path (completed, cancel, timeout, max-turns, clean error from the child), if a worktree exists, compute `worktree::diff(&wt)` and emit `KataEvent::RunDiff { .. }` *before* the terminal event (`run.completed` / `run.error` / `run.cancelled`). A diff-computation failure degrades to a `log` warning, never masks the run outcome.

The worktree is never removed by the engine; it persists regardless of outcome so the operator can always inspect what the agent did before it was leashed.

### Event protocol change (the cross-language contract)

Additive. `KataEvent` is the reference contract in `kata-core::event`; it is *not* ts-rs–exported (ts-rs mirrors only the `RunSpec`-side types), so the TypeScript mirror in `app/src/lib/events.ts` is updated by hand.

- New variant (serde tag `run.diff`):
  ```rust
  RunDiff {
      worktree: String,
      branch: String,
      files: Vec<DiffFile>,
      insertions: u32,
      deletions: u32,
  }
  ```
  with a serializable `DiffFile { status, path }`.
- `RunStarted` gains `worktree: Option<String>` and `branch: Option<String>` (skipped when `None`).

Frontend (`app/src/lib/events.ts`): add the `run.diff` variant and the two optional `run.started` fields to the `KataEvent` union, and **exclude `run.diff` from `StreamEvent`** (treat it as a meta/terminal-adjacent event, like `run.completed`). This keeps the existing exhaustive `gutterFor`/`variantFor`/`bodyFor` switches and `run.svelte.ts` type-checking green without rendering a panel. No ts-rs regeneration is required (no `RunSpec`-side type changes).

### CLI

`kata run` is unchanged in shape: it streams the new `run.diff` line like any other event and preserves exit codes. A `RunError::Worktree` follows the existing `run() -> Err` path → CLI exit **2** (the same bucket as assemble failures). The leash codes (turn cap 125, timeout 124, cancel 130) and the validation/parse codes (1/2) are preserved exactly.

## Documented behaviors (decisions, not bugs)

- The worktree branches off **HEAD**, so *uncommitted* changes in the live workdir are not carried into the sandbox (standard `git worktree add` semantics).
- Worktrees **persist by design**. Disk accumulates across runs; reaping is the operator's via `git worktree remove <path>` / `git worktree prune`.
- `git` must be on PATH and `workdir` must be a repo — otherwise the run is refused (exit 2), never silently downgraded.

## Testing (TDD, per the roadmap workflow)

`worktree.rs` unit tests against a real temporary repo (`git init` + an initial commit in a `tempfile::tempdir`):
- `create` makes a worktree on a `kata/...` branch off HEAD; the path exists and is a working tree.
- `diff` reports a modified tracked file (insertions/deletions) **and** a newly-created untracked file (status `A`), with no index mutation left behind in the worktree.
- not-a-repo → `WorktreeError::NotAGitRepo`; unresolvable home → `NoHome` (inject via env override in-test).
- branch-name uniqueness across two `create` calls for the same slug.

Engine integration (`crates/kata-core/tests/run_it.rs`, driving `fake-claude` via `KATA_FAKE_MODE`):
- A new fake mode where `fake-claude` writes a file into its `cwd`. A worktree-isolated run asserts: the file landed under the worktree (not the live workdir), `run.started` carried `worktree`/`branch`, and a non-empty `run.diff` was emitted before `run.completed`.
- isolation=worktree against a non-repo workdir → `run.error` and a non-zero outcome; the live workdir is untouched.
- These tests assume `git` on PATH (reasonable for this repo's CI); they create their own throwaway repos and remove the worktrees they make.

Frontend: a `events.test.ts` case (or extension) asserting the union accepts a `run.diff` payload and the `run.started` optional fields, and that `npm run check` stays green.

## Out of scope (fast-follow / later)

- Workbench Observe-pane **diff panel** (file rows with A/M/D + ins/del, branch chip, sumi-ink styling). The protocol and frontend types land in M8 so this is a pure-frontend follow-up.
- A `kata worktree list|remove|prune` ergonomics subcommand. Native git suffices for M8.
- Carrying *uncommitted* workdir changes into the sandbox (stash-and-apply). Not needed; HEAD-based branching is the expected model.
- Hardening the catalog's own `dirs_home` fallback (separate engine-polish backlog item).
