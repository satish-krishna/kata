# AI-SDLC Mode, Part 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI-SDLC mode to the Workbench in which a user adds workspaces of git repos and takes a change through `intent → spec → plan` with the `ai-sdlc` plugin, across sessions, without changing the `kata` engine.

**Architecture:** A new Rust library crate `crates/kata-sdlc` holds all workspace, git, front-matter, branch, snapshot and local-store logic, tested against real temp git repos. `app/src-tauri` exposes it through thin `#[tauri::command]`s. The Angular app adds methods to the existing `KataTransport` seam (Tauri and Mock implementations), root stores for mode and locked work, pure helpers in `lib/sdlc.ts`, presentational `ui/` components, and three routed screens (`/mode`, `/sdlc`, `/sdlc/:system/:change`). Stage runs reuse the existing `RunStore` and `run_spec` sidecar path unchanged.

**Tech Stack:** Rust 2021 (serde, thiserror, ts-rs behind a `ts` feature), git CLI, Tauri v2, Angular 22 (signals, Signal Forms, OnPush default), SpartanNG Helm primitives, Vitest, Playwright gates.

**Spec:** `docs/superpowers/specs/2026-10-18-ai-sdlc-mode-design.md`

## Global Constraints

- `crates/kata-core`, `crates/kata-cli`, the run-spec contract, the event protocol and their schemas must show an empty diff. If a task seems to need a change there, stop and report it.
- The ai-sdlc plugin is not modified. It is found through the existing `catalog` command by the plugin name `ai-sdlc`.
- Local data lives under `<KATA_HOME>/workbench/` (`KATA_HOME` if set and non-empty, else `<HOME or USERPROFILE>/.kata`): `settings.json`, `workspaces.json`, `runs.json`. Plain JSON, no database.
- Change branches: `change/<change-folder>`; pending branch `change/pending-<utc stamp YYYYMMDDTHHMMSSZ>`. Base branch detection: `main` if it exists, else `master`, else the current branch.
- Workbench commit messages: `docs(<system>): accept intent <change>`, `docs(<system>): reject intent <change>`, `docs(<system>): accept spec <change>`, built in exactly one function.
- "Committed" means `git ls-files --error-unmatch -- <file>` succeeds and `git status --porcelain -- <file>` prints nothing.
- Every AI-SDLC run-spec: `workdir` = workspace folder, `plugins` contains `ai-sdlc` (and `superpowers` for plan when the catalog has it), `interactive.answer_timeout_secs = 3600`, `name = sdlc-<system>-<change>-<stage>` (new change: `sdlc-<system>-new-intent`; setup: `sdlc-setup`; context: `sdlc-<system>-context`), permissions mode from settings (default `bypass`).
- Front-matter statuses with meaning: `accepted`, `rejected`, `superseded`. Any other value is shown raw and means "not accepted".
- The Workbench never stashes, never pushes, never discards anything outside the leftover list, and refuses a branch switch on a dirty master working tree.
- Frontend house rules from `app/CLAUDE.md`: tokens only (no hex, no raw px in component CSS), andon colors always with a label, sentence-case copy, no emoji, Lucide icons via `provideIcons`, Helm primitives (ask the spartan MCP before new `hlm-*` markup), MVVM component shape, no `.subscribe()`.
- All docs and comments in US English; Markdown has no hard wraps.

## Review Focus

- A workspace folder whose path contains spaces: scanning, git calls and run `workdir` must work. Test pinned in Task 2.
- A master repo with an unborn `HEAD` (just `git init`, no commits): scan reports "not set up", branch helpers return errors with a message instead of panicking. Test pinned in Task 2 and Task 5.
- A detached `HEAD` in the master repo: current branch is `None`, New change is refused with "the master repo is on a detached HEAD". Test pinned in Task 5.
- Missing or malformed front matter: status reads as `unknown`, the change still lists. Test pinned in Task 3.
- Non-change folders under `intent/<system>/` (`context`, `templates`, anything not matching `YYYY-MM-DD-*`): never listed as changes. Test pinned in Task 3.

---

### Task 1: `kata-sdlc` crate, git helper, local store

**Files:**
- Modify: `Cargo.toml` (add `crates/kata-sdlc` to `members`)
- Create: `crates/kata-sdlc/Cargo.toml`, `crates/kata-sdlc/src/lib.rs`, `crates/kata-sdlc/src/git.rs`, `crates/kata-sdlc/src/store.rs`

**Interfaces:**
- Produces:
  - `git::run(dir: &Path, args: &[&str]) -> Result<String, GitError>` (stdout trimmed of the trailing newline; `GitError { args: String, stderr: String }` displays as `git <args>: <stderr>`).
  - `store::workbench_dir() -> Option<PathBuf>`
  - `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)] struct Settings { mode: Option<Mode>, remember: bool, permission_mode: SdlcPermissionMode }`, `enum Mode { Workbench, Sdlc }` (serde `lowercase`), `enum SdlcPermissionMode { Bypass, Prompt }` (default `Bypass`, serde `lowercase`).
  - `struct WorkspaceEntry { id: String, name: String, folder: String, base_branch: String, last_opened: u64 }`
  - `struct RunLink { workspace_id: String, system: String, change: String, stage: String, run_id: String, started_at: u64 }`
  - `store::load_settings() -> Settings`, `store::save_settings(&Settings) -> Result<(), StoreError>`, `store::load_workspaces() -> Vec<WorkspaceEntry>`, `store::save_workspaces(&[WorkspaceEntry]) -> Result<(), StoreError>`, `store::load_run_links() -> Vec<RunLink>`, `store::append_run_link(RunLink) -> Result<(), StoreError>`.
  - All public structs and enums derive `ts_rs::TS` under `#[cfg_attr(feature = "ts", ...)]` with `export_to = "../../../app/src/bindings/"`, same pattern as `crates/kata-core/src/spec.rs:5-6`.

- [ ] **Step 1: Write the failing tests** in `store.rs` (`#[cfg(test)]`, `#[serial]`, setting `KATA_HOME` to a `tempfile::tempdir()` and restoring it):
  - `settings_round_trip`: save `Settings { mode: Some(Mode::Sdlc), remember: true, permission_mode: SdlcPermissionMode::Prompt }`, load, assert equal; assert the file is `<KATA_HOME>/workbench/settings.json`.
  - `missing_files_load_defaults`: fresh home → `load_settings() == Settings::default()`, `load_workspaces().is_empty()`, `load_run_links().is_empty()`.
  - `corrupt_settings_load_defaults`: write `not json` to `settings.json` → defaults, no panic.
  - `run_links_append`: append two links, load returns both in order.
  - In `git.rs`: `run_reports_stderr` — `run(tmp, &["rev-parse", "HEAD"])` in a non-repo dir returns `Err` whose `to_string()` starts with `git rev-parse HEAD:`.
- [ ] **Step 2: Run** `cargo test -p kata-sdlc` — expect compile failure / FAIL.
- [ ] **Step 3: Implement.** `Cargo.toml` uses workspace deps (`serde`, `serde_json`, `thiserror`), `ts-rs = { version = "10", optional = true, default-features = false }`, feature `ts = ["dep:ts-rs"]`, dev-deps `tempfile.workspace = true`, `serial_test = "3"`. `workbench_dir` copies the `KATA_HOME` resolution of `kata_core::fsutil::kata_home` (that function is `pub(crate)`; do not change kata-core) and appends `workbench`. Writes create the directory. `git::run` uses `std::process::Command::new("git").arg("-C").arg(dir)`.
- [ ] **Step 4: Run** `cargo test -p kata-sdlc` — PASS; `cargo clippy -p kata-sdlc --all-targets -- -D warnings` and `cargo fmt --all --check` clean.
- [ ] **Step 5: Commit** `feat(sdlc): add kata-sdlc crate with git helper and local store`

### Task 2: Workspace scan and context health

**Files:**
- Create: `crates/kata-sdlc/src/workspace.rs`, `crates/kata-sdlc/src/testutil.rs` (`#[cfg(test)]` helpers)

**Interfaces:**
- Consumes: `git::run`.
- Produces:
  - `struct Marker { version: u32, systems: BTreeMap<String, SystemDef> }`, `struct SystemDef { #[serde(default)] repos: Vec<String> }` (shape from ai-sdlc `references/workspace.md` §3).
  - `enum MasterState { None, One { repo: String, committed: bool }, Many { repos: Vec<String> } }` (serde tag `kind`).
  - `struct WorkspaceScan { folder: String, repos: Vec<String>, master: MasterState, marker: Option<Marker>, marker_error: Option<String> }`
  - `workspace::scan(folder: &Path) -> Result<WorkspaceScan, ScanError>` — repos are immediate child dirs containing `.git` (file or dir), sorted; nothing deeper.
  - `workspace::is_committed(repo: &Path, rel: &str) -> bool` (the Global Constraints definition).
  - `enum ContextState { Fresh, Stale { commits: u32 }, Missing, NotCheckedOut }` (serde tag `kind`).
  - `workspace::system_repos(scan: &WorkspaceScan, system: &str) -> Vec<String>` — the marker's list, or every repo except the master when the list is empty or missing.
  - `workspace::context_health(folder: &Path, master: &str, system: &str, repo: &str) -> ContextState` — `NotCheckedOut` if the repo folder is absent; `Missing` if `intent/<system>/context/<repo>.md` is absent; else reads `source_commit` from its front matter and runs `git rev-list --count <sha>..HEAD -- . ":(exclude)intent" ":(exclude).ai-sdlc.json"` in the repo; an unknown sha counts as `Stale { commits: 0 }`.
  - `testutil::repo(dir: &Path, name: &str) -> PathBuf` (git init with a local `user.name`/`user.email`, one initial commit on `main`), `testutil::commit_file(repo, rel, contents, msg)`.

- [ ] **Step 1: Write the failing tests** in `workspace.rs`:
  - `scan_finds_immediate_repos_only`: workspace with `a/.git`, `b/.git`, `c/deep/.git`, plain `d/` → `repos == ["a","b"]`.
  - `scan_handles_spaces_in_path`: workspace dir named `my work` with one repo → scan succeeds, `repos == ["svc"]`.
  - `master_none_one_many`: no marker → `MasterState::None`; marker committed in `a` → `One { repo: "a", committed: true }`; marker written but not committed → `One { committed: false }`; markers in `a` and `b` → `Many { repos: ["a","b"] }`.
  - `unborn_head_marker_is_not_committed`: `git init` with no commits plus a marker file → `One { committed: false }`, no panic.
  - `malformed_marker_is_reported`: marker `{` → `marker == None`, `marker_error` is `Some`.
  - `system_repos_defaults_to_all_but_master`.
  - `context_states`: `Missing` before any file; commit a context file with the repo's current sha → `Fresh`; add a product commit → `Stale { commits: 1 }`; a commit that only touches `intent/` in a repo listing itself → still `Fresh`; remove the repo folder → `NotCheckedOut`.
- [ ] **Step 2: Run** `cargo test -p kata-sdlc workspace` — FAIL.
- [ ] **Step 3: Implement** the functions above. Front matter for `source_commit` uses the parser from Task 3 if it already exists; otherwise add `frontmatter::field(text: &str, key: &str) -> Option<String>` here in `crates/kata-sdlc/src/frontmatter.rs` (reads the block between the first two `---` lines, `key: value` lines only) and Task 3 reuses it.
- [ ] **Step 4: Run** tests, clippy, fmt — PASS/clean.
- [ ] **Step 5: Commit** `feat(sdlc): scan workspaces and report context health`

### Task 3: Changes, stage derivation, branch listing

**Files:**
- Create: `crates/kata-sdlc/src/changes.rs` (and `frontmatter.rs` if Task 2 did not)

**Interfaces:**
- Consumes: `frontmatter::field`, `workspace::is_committed`, `git::run`.
- Produces:
  - `enum Stage { IntentInProgress, IntentAwaiting, IntentAcceptedUncommitted, Rejected, SpecReady, SpecAwaiting, SpecAcceptedUncommitted, PlanReady, PlanWritten, PlanSuperseded }` (serde `kebab-case`).
  - `struct DocState { exists: bool, committed: bool, status: Option<String> }` (`status` `Some("unknown")` when the file exists but has no readable `status`).
  - `struct ChangeInfo { system: String, change: String, intent: DocState, spec: DocState, plan: DocState, stage: Stage }`
  - `changes::derive_stage(intent: &DocState, spec: &DocState, plan: &DocState) -> Stage` — exactly the spec's "Stage derivation and actions" table, rows in order; `accepted` on disk but not committed maps to the `*AcceptedUncommitted` variants.
  - `changes::list(master: &Path, system: &str) -> Vec<ChangeInfo>` — folders under `intent/<system>/` whose name matches `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$`, sorted descending by name.
  - `changes::current_branch(master: &Path) -> Option<String>` (`None` on detached or unborn HEAD).
  - `changes::other_change_branches(master: &Path) -> Vec<String>` — `git branch --list "change/*" --format=%(refname:short)` minus the current branch and minus `change/pending-*`, each returned without the `change/` prefix.
  - `changes::read_doc(master: &Path, system: &str, change: &str, doc: &str) -> Option<String>` (`doc` ∈ `intent`, `spec`, `plan`).
  - `struct BranchInfo { current: Option<String>, others: Vec<String>, default_base: Option<String> }` and `changes::branch_info(master: &Path) -> BranchInfo` (uses `branch::default_base` once Task 5 exists; until then `default_base` is computed here and Task 5 moves it).

- [ ] **Step 1: Write the failing tests**:
  - `derive_stage_table`: one assertion per table row, e.g. intent `{exists, committed:false, status:"draft"}` → `IntentInProgress`; intent committed `draft` → `IntentAwaiting`; intent `accepted` not committed → `IntentAcceptedUncommitted`; intent `rejected` → `Rejected`; intent accepted+committed, no spec → `SpecReady`; spec `ready for product owner review` → `SpecAwaiting`; spec accepted+committed, no plan → `PlanReady`; plan `draft` → `PlanWritten`; plan `superseded` → `PlanSuperseded`.
  - `list_skips_non_change_folders`: `intent/claims/context/`, `intent/claims/templates/`, `intent/claims/notes/` and `intent/claims/2026-10-12-fnol-photo-upload/intent.md` → exactly one change.
  - `missing_front_matter_reads_unknown`: `intent.md` without `---` → `status == Some("unknown")`, change listed.
  - `branches`: on `main` with branches `change/a`, `change/b`, `change/pending-20261018T000000Z`, checked out `change/a` → `current_branch == Some("change/a")`, `other_change_branches == ["b"]`.
  - `detached_head_has_no_branch`: `git checkout --detach` → `current_branch == None`.
- [ ] **Step 2: Run** `cargo test -p kata-sdlc changes` — FAIL.
- [ ] **Step 3: Implement.** No regex crate: match the folder name by hand (10-char date with digits and dashes, then `-`, then `[a-z0-9-]+`).
- [ ] **Step 4: Run** tests, clippy, fmt.
- [ ] **Step 5: Commit** `feat(sdlc): list changes and derive their stage`

### Task 4: Run snapshot, leftovers, discard

**Files:**
- Create: `crates/kata-sdlc/src/snapshot.rs`

**Interfaces:**
- Consumes: `git::run`.
- Produces:
  - `struct Snapshot { head: Option<String>, dirty: BTreeMap<String, String> }` — `dirty` maps each path from `git status --porcelain=v1 -uall` to the SHA-1 of its working-tree content (`git hash-object -- <path>`; empty string for a deleted file). Serializable; the frontend holds it between calls.
  - `struct Leftovers { new_commits: Vec<String>, discardable: Vec<String>, touched_dirty: Vec<String>, product_repos_changed: Vec<String> }`
  - `snapshot::take(master: &Path) -> Result<Snapshot, GitError>`
  - `snapshot::leftovers(master: &Path, before: &Snapshot, product_repos: &[PathBuf]) -> Result<Leftovers, GitError>` — `new_commits`: subjects from `git log --format=%s <head>..HEAD` (all of `git log` when `head` was `None`); `discardable`: paths dirty now and absent from `before.dirty`; `touched_dirty`: paths in `before.dirty` whose hash changed; `product_repos_changed`: folder names of product repos whose `git status --porcelain` is non-empty.
  - `snapshot::discard(master: &Path, before: &Snapshot, paths: &[String]) -> Result<(), DiscardError>` — refuses (`DiscardError::NotDiscardable(path)`) any path that is in `before.dirty` or not currently dirty; untracked → delete file; tracked → `git restore --staged --worktree -- <path>`.

- [ ] **Step 1: Write the failing tests**:
  - `leftovers_classify`: pre-dirty `notes.md` (unchanged during run) and `intent.md` (edited during run); run creates `new.md` and commits `c.md` with subject `docs(claims): x` → `discardable == ["new.md"]`, `touched_dirty == ["intent.md"]`, `notes.md` in neither, `new_commits == ["docs(claims): x"]`.
  - `product_repo_change_is_reported`: a change in sibling repo `svc` → `product_repos_changed == ["svc"]`.
  - `discard_restores_and_deletes`: discard `new.md` (untracked, deleted afterwards) and a modified tracked `a.md` (content back to committed).
  - `discard_refuses_pre_dirty_path`: discarding `notes.md` → `Err(NotDiscardable("notes.md"))`, file unchanged.
- [ ] **Step 2: Run** `cargo test -p kata-sdlc snapshot` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, clippy, fmt.
- [ ] **Step 5: Commit** `feat(sdlc): snapshot runs and report leftovers`

### Task 5: Branch lifecycle

**Files:**
- Create: `crates/kata-sdlc/src/branch.rs`

**Interfaces:**
- Consumes: `git::run`, `changes::current_branch`.
- Produces:
  - `branch::default_base(master: &Path) -> Option<String>` (`main`, else `master`, else current).
  - `branch::start_pending(master: &Path, base: &str, now_unix: u64) -> Result<String, BranchError>` — refuses a dirty tree (`BranchError::Dirty(Vec<String>)`) and a detached/unborn HEAD (`BranchError::Detached` with display text `the master repo is on a detached HEAD`); creates and checks out `change/pending-<stamp>` from `base`; returns the branch name.
  - `enum FinishOutcome { Renamed { branch: String, change: String }, Deleted }`
  - `branch::finish_pending(master: &Path, pending: &str, base: &str) -> Result<FinishOutcome, BranchError>` — finds a change folder that exists in the working tree or `git diff --name-only <base>...HEAD` under `intent/*/YYYY-MM-DD-*/` and is absent on `base`; if found, `git branch -m <pending> change/<folder>`; otherwise checks out `base` and `git branch -D <pending>` (only when `rev-list --count base..pending == 0`; otherwise leave it and return `Err(BranchError::PendingHasCommits)`).
  - `branch::checkout(master: &Path, branch: &str) -> Result<(), BranchError>` — refuses dirty with the dirty paths.
  - `BranchError::Dirty` display: `the master repo has uncommitted changes: <paths joined by ", ">`.

- [ ] **Step 1: Write the failing tests**:
  - `default_base_prefers_main_then_master`.
  - `start_pending_names_branch`: `now_unix = 1792368000` → returns `change/pending-20261019T000000Z` (use `utc_stamp` semantics identical to `kata_core::fsutil::utc_stamp`, re-implemented here) and HEAD is on it.
  - `start_refuses_dirty_and_detached`.
  - `start_refuses_unborn_head`: fresh `git init` → `Err(Detached)`.
  - `finish_renames_when_folder_created`: on pending, create and commit `intent/claims/2026-10-18-new-thing/intent.md` → `Renamed { branch: "change/2026-10-18-new-thing", change: "2026-10-18-new-thing" }`.
  - `finish_renames_for_uncommitted_folder`: folder exists only in the working tree → still `Renamed`.
  - `finish_deletes_empty_pending`: nothing created → `Deleted`, current branch is `main`, pending branch gone.
  - `checkout_refuses_dirty`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** tests, clippy, fmt.
- [ ] **Step 5: Commit** `feat(sdlc): manage per-change branches in the master repo`

### Task 6: Human-decision commits

**Files:**
- Create: `crates/kata-sdlc/src/decide.rs`

**Interfaces:**
- Consumes: `git::run`, `frontmatter`, `workspace::is_committed`.
- Produces:
  - `enum Decision { AcceptIntent, RejectIntent, AcceptSpec }`
  - `decide::message(decision: Decision, system: &str, change: &str) -> String` — the only place commit messages are built: `docs(<system>): accept intent <change>` / `reject intent` / `accept spec`.
  - `enum DecideOutcome { Committed, NeedsConfirm { other_edits: bool }, GitFailed { stderr: String } }`
  - `decide::apply(master: &Path, system: &str, change: &str, decision: Decision, confirmed: bool) -> Result<DecideOutcome, DecideError>` — sets the front-matter `status` line to `accepted`/`rejected` (adds the line inside the front matter if missing); if the file had uncommitted changes other than the status line before this call and `confirmed == false`, writes nothing and returns `NeedsConfirm { other_edits: true }`; commits with `git commit -m <message> -- <file>`; a failing commit leaves the edited file in place and returns `GitFailed` with git's stderr verbatim. Never passes `--no-verify`.

- [ ] **Step 1: Write the failing tests**:
  - `message_format`: `message(AcceptIntent, "claims", "2026-10-12-fnol")` == `docs(claims): accept intent 2026-10-12-fnol`; same for the other two.
  - `accept_commits_only_the_file`: another staged file stays staged and uncommitted; `git log -1 --format=%s` == the message; file status is `accepted` and committed.
  - `other_edits_need_confirmation`: body edited, `confirmed=false` → `NeedsConfirm { other_edits: true }` and the file is byte-identical; `confirmed=true` → `Committed`.
  - `already_accepted_uncommitted_commits`: status hand-edited to `accepted` (no other edits) → `Committed` without asking.
  - `hook_failure_is_reported`: a `pre-commit` hook that exits 1 → `GitFailed`, file keeps `status: accepted`, `HEAD` unchanged.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** tests, clippy, fmt.
- [ ] **Step 5: Commit** `feat(sdlc): commit acceptance decisions`

### Task 7: Bindings, Tauri commands, transport

**Files:**
- Modify: `app/src-tauri/Cargo.toml` (dep `kata-sdlc = { path = "../../crates/kata-sdlc" }`), `app/src-tauri/src/lib.rs`
- Create: generated `app/src/bindings/*.ts` for the kata-sdlc types (via the command below), `app/src/app/lib/sdlc-mock.ts`
- Modify: `app/src/app/core/transport/kata-transport.ts`, `tauri-transport.ts`, `mock-transport.ts`, `tauri-transport.spec.ts`, `mock-transport.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces (Tauri command → `KataTransport` method, argument names exactly as listed):

| Tauri command | Transport method |
|---|---|
| `sdlc_settings` | `sdlcSettings(): Promise<Settings>` |
| `sdlc_save_settings(settings)` | `sdlcSaveSettings(settings: Settings): Promise<void>` |
| `sdlc_workspaces` | `sdlcWorkspaces(): Promise<WorkspaceEntry[]>` |
| `sdlc_save_workspaces(workspaces)` | `sdlcSaveWorkspaces(workspaces: WorkspaceEntry[]): Promise<void>` |
| `sdlc_scan(folder)` | `sdlcScan(folder: string): Promise<WorkspaceScan>` |
| `sdlc_context_health(folder, master, system, repo)` | `sdlcContextHealth(...): Promise<ContextState>` |
| `sdlc_changes(master, system)` | `sdlcChanges(master: string, system: string): Promise<ChangeInfo[]>` |
| `sdlc_branches(master)` | `sdlcBranches(master: string): Promise<BranchInfo>` (Task 3's `changes::branch_info`) |
| `sdlc_read_doc(master, system, change, doc)` | `sdlcReadDoc(...): Promise<string \| null>` |
| `sdlc_snapshot(master)` | `sdlcSnapshot(master: string): Promise<Snapshot>` |
| `sdlc_leftovers(master, before, productRepos)` | `sdlcLeftovers(master: string, before: Snapshot, productRepos: string[]): Promise<Leftovers>` |
| `sdlc_discard(master, before, paths)` | `sdlcDiscard(...): Promise<void>` |
| `sdlc_start_change(master, base)` | `sdlcStartChange(master: string, base: string): Promise<string>` (now = system time, in Rust) |
| `sdlc_finish_change(master, pending, base)` | `sdlcFinishChange(...): Promise<FinishOutcome>` |
| `sdlc_checkout(master, branch)` | `sdlcCheckout(master: string, branch: string): Promise<void>` |
| `sdlc_decide(master, system, change, decision, confirmed)` | `sdlcDecide(...): Promise<DecideOutcome>` |
| `sdlc_run_links` / `sdlc_link_run(link)` | `sdlcRunLinks(): Promise<RunLink[]>` / `sdlcLinkRun(link: RunLink): Promise<void>` |

  `master` is the absolute path of the master repo; errors map to `String` with `to_string()`. Commands are registered in `generate_handler!`. `MockTransport` serves fixtures from `lib/sdlc-mock.ts`: workspace `acme-claims` at `D:/Work/acme-claims` (repos `claims-intent` master, `claims-core` fresh, `customer-portal` stale 14, `billing-api` not checked out), system `claims`, changes `2026-10-16-fraud-flag` (intent awaiting), `2026-10-12-fnol-photo-upload` (spec awaiting), `2026-10-09-adjuster-reassign` (plan written), other branch `2026-10-17-claim-notes`, and fixture Markdown for each doc. Mutating mock methods update the in-memory fixture so the browser demo reflects decisions.

- [ ] **Step 1:** Regenerate bindings: `cargo test -p kata-sdlc --features ts export_bindings` — new files appear in `app/src/bindings/`.
- [ ] **Step 2: Write the failing tests:** add one row per new method to the `rows` table in `tauri-transport.spec.ts` (command name and payload exactly as in the table); in `mock-transport.spec.ts`, `sdlcDecide` on the fnol change with `AcceptSpec` makes the next `sdlcChanges` return its stage as `plan-ready`.
- [ ] **Step 3: Run** `npm test -- --watch=false` (in `app/`) — FAIL.
- [ ] **Step 4: Implement** the commands, the abstract methods, both transports and the fixtures.
- [ ] **Step 5: Run** `npm test -- --watch=false`, `npm run lint`, `node scripts/stage-sidecar.mjs && cargo build --locked -p kata-app`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all --check` — all green.
- [ ] **Step 6: Commit** `feat(sdlc): expose workspace operations over the transport`

### Task 8: Mode choice, routing, toast success

**Files:**
- Create: `app/src/app/core/mode/mode.store.ts` (+ spec), `app/src/app/core/mode/mode.guard.ts` (+ spec), `app/src/app/sdlc/mode/mode-screen.ts`, `mode-screen.view-model.ts` (+ spec)
- Modify: `app/src/app/app.routes.ts`, `app/src/app/core/toast/toast.store.ts` (+ spec), `app/src/app/ui/toolbar.ts` (+ spec)

**Interfaces:**
- Consumes: `sdlcSettings`, `sdlcSaveSettings`.
- Produces:
  - `ModeStore` (`providedIn: 'root'`): `settings: Signal<Settings | null>`, `load(): Promise<Settings>`, `choose(mode: Mode, remember: boolean): Promise<void>`, `switchTo(mode: Mode): Promise<void>` (navigates to `/` or `/sdlc` and persists when `remember` is on).
  - `modeGuard: CanActivateFn` on `''`: loads settings once; `mode == null` → `/mode`; `remember && mode == 'sdlc'` → `/sdlc`; else allow.
  - Route `{ path: 'mode' }` → `ModeScreen`, and `canActivate: [modeGuard]` on `''`. Task 11 adds `sdlc` and Task 12 adds `sdlc/:system/:change`; until Task 11 lands, choosing AI-SDLC navigates to `/sdlc`, which falls through to the router's default (acceptable between tasks on the feature branch).
  - `ToastStore.success(message: string)` (`toast.success`, same TTL).
  - `Toolbar` gains `input()` `modeSwitchDisabled = input(false)` and `output()` `switchMode`, rendered as a mono `workbench` badge button left of the Library link, disabled while `running()` or `modeSwitchDisabled()`.
  - Mode screen copy (exact): eyebrow `kata`, heading `How are you working today?`; card 1 eyebrow `workbench`, title `Compose a run`, body `Write one run-spec, launch it, watch it.`; card 2 eyebrow `ai-sdlc`, title `Work a change`, body `Take a change through intent → spec → plan in a workspace of repos, across as many sessions as it needs.`; checkbox `Remember this · switch any time from the toolbar` (checked by default); button `Open`.
- [ ] **Step 1: Write the failing tests**: guard redirects (three cases above); `ModeScreenViewModel.open()` calls `choose('sdlc', true)` when the second card is selected and remember is left on; `ToastStore.success` calls `toast.success` with `duration: 6000`; toolbar badge emits `switchMode` and is disabled while running.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (spartan MCP for the checkbox and card/radio-group composition). **Step 4: Run** `npm test -- --watch=false`, `npm run lint`, `npm run check:wiring`.
- [ ] **Step 5: Commit** `feat(sdlc): choose a mode at launch`

### Task 9: Locked work

**Files:**
- Create: `app/src/app/core/lock/lock.store.ts` (+ spec), `app/src/app/ui/lock-panel.ts` (+ spec)
- Modify: `app/src/styles/kata/components.css` (scrim and panel classes, tokens only)

**Interfaces:**
- Consumes: `RunStore` (state, events, asks, permissions, startRun, cancelRun, submitAnswer, submitDecision), `ToastStore`.
- Produces:
  - `type StepState = 'pending' | 'running' | 'done' | 'failed'`; `type LockStep = { label: string; state: StepState; detail: string | null }`.
  - `LockStore` (`providedIn: 'root'`): `active: Signal<LockView | null>` where `LockView = { kind: 'steps'; title: string; steps: LockStep[] } | { kind: 'run'; title: string }`; `runSteps<T>(title: string, steps: { label: string; run: () => Promise<string | null> }[]): Promise<'done' | 'cancelled' | 'failed'>` (each step's resolved string becomes its `detail`; cancel stops before the next step); `runAgent(title: string, spec: RunSpec): Promise<RunState>` (starts via `RunStore.startRun`, resolves with the terminal `RunState`); `cancel(): void`; `elapsedSecs: Signal<number>`.
  - `LockPanel` (`ui/`): inputs `view: LockView`, `elapsed: number`, `steps` progress label `"<done> / <total>"`, run activity line built from the last `tool.use` event (`lastTool: string | null`), `turn: number | null`, `model: string | null`, `ask: AskRecord | null`, `permission: PermissionRecord | null`, `deadlineSecs: number | null`; outputs `cancel`, `answer`, `decide`. Renders the existing `app-ask-panel` and `app-permission-panel` inside the panel. Footer for a pending ask: `exits 123 if unanswered in <mm:ss>`. Never renders a percentage.
  - The scrim is a full-viewport overlay with `role="dialog"`, `aria-modal="true"`, focus trapped in the panel; only Cancel and the question card are interactive.
- [ ] **Step 1: Write the failing tests**: `runSteps` marks steps `running` then `done` with details, and stops after cancel with the remaining steps `pending`; a throwing step marks it `failed` and resolves `'failed'`; `runAgent` resolves `'success'` after the mock run completes; `LockPanel` shows `3 / 5` for three done of five, shows the ask card when `ask` is set, and contains no `%` character in any state.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (spartan MCP before any overlay markup; the house-style skill for the CSS). **Step 4: Run** tests, lint, `npx stylelint "src/**/*.css"`, `check:wiring`.
- [ ] **Step 5: Commit** `feat(sdlc): lock the screen during long work with honest progress`

### Task 10: Pure stage logic

**Files:**
- Create: `app/src/app/lib/sdlc.ts` (+ `sdlc.spec.ts`)

**Interfaces:**
- Consumes: generated `Stage`, `ChangeInfo`, `Settings`, `RunSpec`, `CatalogEntry`, `KataEvent`.
- Produces:
  - `type StageAction = 'continue-intent' | 'accept-intent' | 'reject-intent' | 'commit-acceptance' | 'start-spec' | 'continue-spec' | 'accept-spec' | 'start-plan' | 'rerun-plan' | 'reopen-intent'`
  - `actionsFor(stage: Stage): StageAction[]` — the spec table's Actions column, in that order.
  - `stageLabel(stage: Stage): { step: 'intent' | 'spec' | 'plan' | 'closed'; text: string; tone: 'success' | 'warning' | 'muted' | 'error' }`.
  - `type RunContext = { folder: string; system: string; change: string | null; idea?: string; repos?: string[] }`
  - `specFor(kind: 'setup' | 'context' | 'intent' | 'spec' | 'plan', action: StageAction | null, ctx: RunContext, settings: Settings, catalog: CatalogEntry[]): RunSpec` — starts from `defaultSpec()`; applies the Global Constraints values; `permissions.mode` from settings (`prompt` sets `interactive.enabled = true` and `unmatched = 'ask'`); task text:
    - setup: `Use the ai-sdlc setup skill.` plus `System: <system>` when given.
    - context: `Use the ai-sdlc context skill for system <system>, repositories: <repos joined ", ">.`
    - intent (new): `Use the ai-sdlc intent skill for system <system>. The idea: <idea>`
    - intent (continue): `Use the ai-sdlc intent skill for system <system> on the existing change folder <change>. Resume the draft.`
    - intent (reopen): same as continue plus `The user has already confirmed reopening this accepted intent; do not ask again.`
    - spec: `Use the ai-sdlc spec skill for system <system> on change folder <change>.`
    - plan: `Use the ai-sdlc plan skill for system <system> on change folder <change>.`, plus ` --standalone` when the catalog has no `superpowers` plugin, plus `The user has already confirmed replacing the existing plan; do not ask again.` for `rerun-plan`.
  - `transcriptRunId(events: readonly KataEvent[]): string | null` — from the first `log` event whose message starts with `transcript: `, the file stem of the path (handles `\` and `/`).
  - `hasAiSdlcPlugin(catalog: CatalogEntry[]): boolean`.
- [ ] **Step 1: Write the failing tests**: `actionsFor` for every `Stage`; `specFor` for each kind asserts `name`, `workdir`, `plugins` keys, `interactive.answer_timeout_secs === 3600`, and the exact task string; prompt-mode settings flips `interactive.enabled`; `transcriptRunId` on `transcript: C:\Users\x\.kata\runs\sdlc-claims-x-spec-20261018T101500Z.jsonl` returns `sdlc-claims-x-spec-20261018T101500Z`, and on no such event returns `null`; every spec returned passes `validateLocal` from `lib/mock.ts`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** tests, lint.
- [ ] **Step 5: Commit** `feat(sdlc): build stage run-specs and actions`

### Task 11: Workspace home

**Files:**
- Create: `app/src/app/sdlc/home/sdlc-home.ts`, `sdlc-home.html`, `sdlc-home.view-model.ts` (+ spec); `app/src/app/ui/sdlc-toolbar.ts`, `workspace-switcher.ts`, `add-workspace-dialog.ts`, `changes-table.ts`, `repos-table.ts`, `new-change-dialog.ts`, `leftover-dialog.ts`, `sdlc-settings-dialog.ts` (each + spec)
- Modify: `app/src/app/app.routes.ts` (add `sdlc`)

**Interfaces:**
- Consumes: Tasks 7–10, `ModeStore`, `LockStore`, `ToastStore`, `RunStore`.
- Produces:
  - `SdlcHomeViewModel`: `workspaces`, `current: Signal<WorkspaceEntry | null>`, `scan`, `branches`, `changes: Signal<ChangeInfo[]>`, `contexts: Signal<Record<string, ContextState>>`, `pluginMissing: Signal<boolean>`; `init()`, `selectWorkspace(id)`, `addWorkspace()` (pick folder → `LockStore.runSteps('Checking workspace', …)` with exactly the five step labels `Scan folder for repos`, `Find master repo`, `Read .ai-sdlc.json`, `Check context staleness`, `List changes` → if not set up, `runAgent('Running setup', specFor('setup', …))` → on success rescan and save the entry with `base_branch = default_base` → otherwise open the leftover dialog), `removeWorkspace(id)`, `runContext(repo)`, `addSystem()`, `newChange(system, idea)` (Task 12's flow helper, shared), `openChange(system, change)`, `openOtherBranch(change)` (`sdlcCheckout` then navigate; a dirty refusal shows git's message in an error toast), `finishRun(...)` (snapshot/leftovers/link/notification, shared with Task 12).
  - Every run: `sdlcSnapshot` before, `sdlcLinkRun` once `transcriptRunId` resolves, `sdlcLeftovers` after a non-success terminal state; leftovers non-empty → `LeftoverDialog`; success → `ToastStore.success('<Title> finished · <result>')`; cancel/failure → error toast naming committed and uncommitted counts.
  - Setup and context check the master's current branch first and, if it is not the base branch, open a confirm `Switch claims-intent to main first?` before running.
  - States rendered: plugin missing (blocking empty state naming where kata looked: `~/.claude`, the workspace `.claude`, installed marketplace plugins), workspace folder missing, master gone, more than one master (lists them), no workspaces yet (Add workspace call to action).
  - `SdlcToolbar` (`ui/`): seal, `ai-sdlc` mode badge button (output `switchMode`, disabled while locked), the workspace switcher, breadcrumb, the master's current branch in mono, a settings icon button, and a projected primary action.
  - `SdlcSettingsDialog` (`ui/`): inputs `settings: Settings`, `workspace: WorkspaceEntry | null`; a segmented control for permission mode (`bypass` / `prompt`) and a text input for the workspace's base branch; output `save: { settings: Settings; baseBranch: string | null }`. The VM persists with `sdlcSaveSettings` and `sdlcSaveWorkspaces`.
  - `LeftoverDialog`: inputs `leftovers: Leftovers`, outputs `discard: string[]`, `close`; `intent.md`/`spec.md` paths never pre-checked; `touched_dirty` listed as `changed before and during this run` without a checkbox; `product_repos_changed` as a warning line `the run changed files in <repo>; ai-sdlc should not write there`.
- [ ] **Step 1: Write the failing tests** (VM with `MockTransport`; components with inputs): add-workspace on a set-up fixture saves the entry with `base_branch: 'main'` and never starts a run; on a not-set-up fixture it starts exactly one run whose spec `name` is `sdlc-setup`; `runContext('customer-portal')` starts a run named `sdlc-claims-context`; cancelled setup opens the leftover dialog; saving the settings dialog with `prompt` persists `permission_mode: 'prompt'`; switcher lists `folder missing` for a nonexistent folder; changes table renders the other-branches group without a stage; plugin-missing state hides all workspace actions; leftover dialog never pre-checks `intent.md`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (spartan MCP for dropdown-menu, dialog, table, checkbox; house-style skill for layout). **Step 4: Run** tests, lint, stylelint, `check:wiring`.
- [ ] **Step 5: Commit** `feat(sdlc): workspace home with changes and repository context`

### Task 12: Change page and new-change flow

**Files:**
- Create: `app/src/app/sdlc/change/change-page.ts`, `change-page.html`, `change-page.view-model.ts` (+ spec); `app/src/app/ui/stage-stepper.ts`, `doc-view.ts` (each + spec)
- Modify: `app/src/app/app.routes.ts` (add `sdlc/:system/:change`)

**Interfaces:**
- Consumes: Tasks 7–11; `ui/markdown-body.ts` for rendering; `ui/confirm-dialog.ts`.
- Produces:
  - `ChangePageViewModel`: route params via `toSignal`, `change: Signal<ChangeInfo | null>`, `doc: Signal<string | null>` (current stage's document), `actions = computed(() => actionsFor(stage))`, `runCounts: Signal<Record<'intent' | 'spec' | 'plan', number>>` from `sdlcRunLinks`, plus `listRuns` records whose `kata` equals the stage's deterministic spec name and whose id is not already linked (the spec's best-effort fallback for runs without a transcript); `act(action: StageAction)`: run actions go through `LockStore.runAgent` with `specFor`; `accept-*`/`reject-intent`/`commit-acceptance` call `sdlcDecide`, and `NeedsConfirm` opens the confirm dialog with copy `intent.md has other uncommitted edits; accepting commits them too.` (`spec.md` for spec); `GitFailed` shows git's stderr verbatim in an error toast; after any action, reload the change.
  - New change (started from the home screen): `sdlcStartChange(master, base)` → `runAgent('Starting change', specFor('intent', null, { idea }))` → `sdlcFinishChange(master, pending, base)` regardless of outcome → `Renamed` navigates to the change page, `Deleted` returns home with an info toast `No change was created.`
  - `StageStepper` (`ui/`): inputs `stage: Stage`, `counts`; three steps Intent/Spec/Plan, each with an andon tag (dot + label) from `stageLabel`, the current step marked with `aria-current="step"`.
  - `DocView` (`ui/`): inputs `name: string`, `frontMatter: string | null`, `body: string`; front matter shown as one mono line.
  - Toolbar breadcrumb `<workspace> / <change>` and the master's current branch in mono.
- [ ] **Step 1: Write the failing tests**: for each fixture change, the toolbar actions equal `actionsFor`; `accept-spec` on fnol calls `sdlcDecide` with `AcceptSpec` and the reloaded stage is `plan-ready`; a `NeedsConfirm` outcome opens the confirm and confirming calls `sdlcDecide` with `confirmed: true`; reopen starts a run whose task contains `already confirmed reopening`; new-change with a `Deleted` finish navigates to `/sdlc`; stepper marks exactly one `aria-current`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** tests, lint, stylelint, `check:wiring`.
- [ ] **Step 5: Commit** `feat(sdlc): change page with stage actions and acceptance`

### Task 13: Demo run, gates, screenshots, docs

**Files:**
- Modify: `app/src/app/lib/sdlc-mock.ts` (scripted runs), `app/src/app/sdlc/home/sdlc-home.view-model.ts` and `change-page.view-model.ts` (demo hook), `app/package.json` (`check:boot` and `check:interaction` routes), `app/parity/capture.mjs` and `app/scripts/screenshots.mjs` (new views), `app/parity/baseline/*.png` (new baselines), `CLAUDE.md`, `README.md`, `app/CLAUDE.md`
- Create: `docs/images/sdlc-*.png` (generated)

**Interfaces:**
- Produces:
  - `?demo=sdlc` (browser only, never under Tauri, same guard as `?demo=run`): on `/sdlc/claims/2026-10-12-fnol-photo-upload` the view model starts `continue-spec`; `MockTransport.runSpec` plays a scripted `spec` run (log `transcript: …`, two `tool.use`/`tool.result` pairs, an `ask.requested` with the question `If an upload fails midway, should the claim still be filed without the photos?`, then after the answer a `run.completed` exit 0) whenever the spec `name` starts with `sdlc-`; `?demo=sdlc-setup` on `/sdlc` opens the add-workspace flow against an un-set-up fixture folder and plays a setup run that pauses on `Which repo should hold the intent artifacts?`.
  - `check:boot` and `check:interaction` routes: `""`, `library`, `mode`, `sdlc`, `sdlc/claims/2026-10-12-fnol-photo-upload`.
  - Parity and screenshot views: `sdlc-mode`, `sdlc-home`, `sdlc-switcher-open`, `sdlc-add-workspace-steps`, `sdlc-lock-ask`, `sdlc-leftovers`, `sdlc-change-spec`, `sdlc-change-plan`.
- [ ] **Step 1: Write the failing tests**: mock-transport spec — a run whose spec name starts with `sdlc-` emits the scripted `ask.requested` and, after `submitAnswer`, a `run.completed` with exit 0; `transcriptRunId` over the scripted events returns the scripted id.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the scripts and demo hooks; extend the gate route lists and capture views.
- [ ] **Step 4: Run every gate** in `app/`: `npm run lint`, `npx stylelint "src/**/*.css"`, `npm test -- --watch=false`, `npm run build`, `npm run check:boot`, `npm run check:interaction`, `npm run check:responsive`, `npm run check:wiring`; then `npm run check:parity` (new baselines written for the new views, existing views unchanged) and `npm run screenshots` (writes `docs/images/sdlc-*.png`). At the repo root: `node app/scripts/stage-sidecar.mjs`, `cargo test --workspace`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all --check`, `cargo build --locked`. Confirm `git diff main -- crates/kata-core crates/kata-cli schema` is empty.
- [ ] **Step 5: Docs.** Root `CLAUDE.md`: add `crates/kata-sdlc` to Layout, the `/mode`, `/sdlc` routes to the Workbench section, and the regeneration command `cargo test -p kata-sdlc --features ts export_bindings`. `app/CLAUDE.md`: `?demo=sdlc` next to `?demo=run`. `README.md`: one short AI-SDLC mode section with two of the screenshots.
- [ ] **Step 6: Commit** `feat(sdlc): demo run, gates and screenshots for AI-SDLC mode`
