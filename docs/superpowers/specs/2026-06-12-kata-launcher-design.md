# Kata — design

Status: approved design, pre-implementation
Date: 2026-06-12

## What this is

Kata is a launcher for single, headless coding-agent runs. You compose a **run-spec** (a precise, repeatable form for one job), and Kata runs it by driving `claude -p` to completion and observing it. The name is deliberate: a kata is a craftsman's drilled form, and a run-spec is exactly that, one exact, reproducible form for a job that runs identically on your machine, a teammate's, and a CI box.

Kata sits in a small family of tools: **Shokunin** (the craftsman/orchestrator), **Kata** (defines and performs one form), **Andon** (watches the line).

### The thesis it battle-tests

The blog post "Headless, or: Don't Build the Harness" argues that the agent *loop* is plumbing you should rent (via `claude -p`), and the control you actually want lives at the **edges**: what the session starts with and what it leaves behind. Kata is that argument as a product. It never owns a loop. It owns the three decisions plus the leash:

1. **The empty room** — `claude --bare` loads nothing by default.
2. **Tell it what it is** — an appended system prompt retasks the assistant.
3. **A folder of exactly the right skills** — a disposable `--plugin-dir` assembled per run.
4. **The leash** — cap turns/time and contain writes; observe; check the exit code.

A run-spec is those four decisions serialized. Nothing in Kata touches the loop.

## Goals (v1)

- Compose, save, load, and re-run a portable run-spec from a desktop GUI (the Workbench).
- Run a spec **headlessly** with no GUI (`kata run spec.toml`), so CI and Shokunin use the identical path.
- Discover installed skills and plugins; select exactly the ones a job needs.
- Drive `claude -p` to completion and stream a **normalized event protocol** to any caller.
- Observe a run live; cancel it; read a structured summary (exit code, turns, cost, duration, result).
- Export a **self-contained bundle** (spec + vendored skills/plugins) for hand-off.

## Non-goals (v1)

- No HITL / per-tool approvals (observe + cancel only). Runs use bypass permissions.
- No mid-run steering or message injection.
- No inline skill authoring (author `SKILL.md` on disk first, then select it).
- No first-class guard-hook field or MCP config UI; no per-component enable/disable.
- No multi-run orchestration (that is Shokunin's job; Kata runs one form).
- Egress/network control is out of scope (Shokunin's gateway concern).

## Architecture

The defining constraint: **the engine binary is the only thing that ever runs a kata.** The GUI, Shokunin, and CI are all callers of it. One execution path, tested once, identical everywhere — reproducibility enforced by construction, not discipline.

```
kata/                      # this repo, MIT
  Cargo.toml               # workspace
  crates/
    kata-core/             # lib: spec model, discovery, plugin-dir assembly,
                           #      claude invocation, event parsing, leash, cleanup
    kata-cli/              # bin -> `kata`: run / validate / catalog / bundle
  app/
    src/                   # web frontend: the Workbench (two-pane)
    src-tauri/             # Tauri v2 backend; depends on kata-core for the SPEC
                           #   TYPES only, and SPAWNS the kata binary to run
  docs/  LICENSE  README.md
```

**Why the GUI spawns the binary rather than linking the engine to run:** linking would give the GUI a second execution path that Shokunin and CI don't share, and the three could drift. Spawning the one binary means what you watch in the Workbench is byte-for-byte what CI runs. The backend links `kata-core` only for the spec *type definitions*, so the form and the engine cannot disagree about the schema.

**The C# seam:** Shokunin (.NET) can't link a Rust crate, so the contract between them is the **run-spec file format + the `kata` CLI + the event protocol**, all language-neutral and documented here. `kata-core` is the reference implementation of the schema, not a shared dependency.

**Tech:** Tauri v2; frontend in TypeScript + Vite + Svelte; engine and core in Rust; spec files in TOML (canonical, git-diff friendly), JSON also accepted; event protocol is JSON lines.

## The run-spec contract

Canonical format TOML; JSON accepted (same shape). This is what the Workbench writes, what `kata run` reads, and what Shokunin emits.

```toml
schema = 1                       # spec format version (forward-compat)
name = "triage-flaky-test"       # label; saved filename + run-history key
description = "Reproduce and isolate AuthTests.LoginExpiry"   # optional

# --- what to do ---
task = """
Triage the flaky test AuthTests.LoginExpiry. Find the smallest reproduction
and your best guess at the cause.
"""
context = """
.NET 8 xUnit suite. CI flakes ~1 in 30 runs. Don't fix it, just isolate.
"""                              # optional; appended after task

workdir = "D:/Repos/acme-api"    # cwd for claude -p; the agent's file tools resolve here

# --- who it is (decision two) ---
[identity]
system_prompt = """
You reproduce, isolate, and report. You do not change production code.
"""                              # optional; empty = stay the default coding assistant
mode = "append"                  # "append" (keep Claude's safety+tool defaults) | "replace"

# --- the curated kit (decision three) ---
skills  = ["triage-flaky-test"]  # loose SKILL.md units, by name
plugins = ["github-tools"]        # whole plugins, by name

[plugins.github-tools]           # per-plugin config (only MCP needs any)
mcp = true                       # start the plugin's MCP servers (default true if it has any)
env = ["GITHUB_TOKEN", "GH_HOST"] # NAMES forwarded from the runtime env; never values/secrets

[model]
id = "claude-sonnet-4-6"         # optional; omit to use Claude's default

# --- the leash (decision four) ---
[leash]
max_turns = 12
timeout_secs = 900               # optional wall-clock cap (engine-enforced)
isolation = "none"               # "none" | "worktree" (ephemeral git worktree to contain writes)
```

### Field notes

- Each block maps one-to-one onto a decision from the post. The spec contains no loop plumbing.
- **No `allowed_tools` field.** v1 runs bypass permissions (no HITL), so a permission allowlist is dead config ("permission theater"). Containment is real, not a list:
  - **Curation is the allowlist** — the only tools in play are the ones the selected skills/plugins bring. You don't allow-list a tool you didn't put in the room.
  - **The worktree** is the filesystem fence (git-enforced, reviewable as a diff).
  - **The leash** is the runaway fence.
  - **Real per-tool enforcement**, if wanted, is a `PreToolUse` hook (which actually runs), carried by a selected plugin. v1 adds no dedicated guard field, but a plugin-borne hook loads and runs because it is in the room.
- **Secrets never live in the spec.** `env` lists variable *names* forwarded to the Claude child; values come from the runtime environment. Commit the spec freely.

### Skill/plugin portability

Day-to-day a spec references skills/plugins by **name**, resolved from discovered sources at run time. For hand-off, `kata bundle <spec>` produces a self-contained folder: the spec plus a vendored copy of each resolved `SKILL.md`/plugin, so CI needs nothing pre-installed.

## Engine behavior — `kata run <spec>`

1. **Load + validate** the spec (`kata validate` exposes this step alone).
2. **Resolve** skills/plugins by name against discovered sources (`~/.claude/skills`, project `.claude`, installed plugins).
3. **Assemble the disposable plugin-dir** in a temp folder: copy each resolved skill into `skills/<name>/`; add each resolved plugin (its `skills/`, `commands/`, `agents/`, `hooks/`, `.mcp.json`).
4. **Write the system prompt** to a temp file if `[identity].system_prompt` is set.
5. **(If `isolation = "worktree"`)** create an ephemeral git worktree off `workdir` and use it as cwd.
6. **Build + spawn** the command:
   ```
   claude --bare -p "<task + context>" \
     --append-system-prompt-file <tmp/system.txt>   # or --system-prompt if mode=replace
     --plugin-dir <tmp/plugindir> \
     --model <id> \                                  # omitted if unset
     --max-turns <leash.max_turns> \
     --output-format stream-json \
     --dangerously-skip-permissions                  # headless, no HITL
   ```
   with `env` names forwarded into the child environment.
7. **Parse** Claude's `stream-json` line by line, **normalize** into `KataEvent`s, **emit** as JSON lines on stdout.
8. **Enforce the leash:** `max_turns` rides on Claude; `timeout_secs` is the engine's own wall-clock kill.
9. **On completion** emit `run.completed`, then **clean up** the temp plugin-dir and worktree. Process exit code = run outcome.
10. **Cancel** = the caller kills the `kata` process; the engine traps it, kills the Claude child, cleans up, emits `run.cancelled`.

The exact `claude` flag set is pinned by a unit test (command construction as a pure function) so it cannot silently drift. Real-CLI flag semantics are confirmed by one opt-in smoke test.

## Event protocol

JSON lines on stdout — the normalized contract every caller (GUI, Shokunin, CI) reads, so none of them parse Claude's raw `stream-json`.

```jsonc
{"type":"run.started",   "spec":"triage-flaky-test","model":"...","workdir":"...","isolation":"none"}
{"type":"log",           "level":"info","message":"assembled plugin-dir: 1 skill, 1 plugin"}
{"type":"assistant.text","text":"Running the test 20 times..."}
{"type":"tool.use",      "name":"Bash","input_summary":"dotnet test --filter ..."}
{"type":"tool.result",   "name":"Bash","ok":true,"summary":"3 failed / 17 passed"}
{"type":"turn",          "n":3}
{"type":"run.completed", "exit_code":0,"is_error":false,"num_turns":6,"cost_usd":0.04,"duration_ms":48120,"result":"..."}
// terminal alternatives: {"type":"run.error","message":"..."} | {"type":"run.cancelled"}
```

## Catalog — `kata catalog`

Emits a JSON array the Workbench uses to populate its checklist (the GUI does not reimplement discovery):

```jsonc
{"kind":"skill","name":"triage-flaky-test","description":"...","source":"user","path":"...","provides":[],"mcp_servers":[]}
{"kind":"plugin","name":"github-tools","description":"...","source":"plugin","path":"...","provides":["skill:pr-review","skill:issue-triage"],"mcp_servers":["github"]}
```

## The Workbench (GUI, Layout A)

A single two-pane window; left composes the spec, right runs and observes.

- **Left pane (compose the run-spec):** Task → Context → Workdir → Identity (system prompt + append/replace) → **Kit** (searchable catalog checklist; each entry tagged `skill`/`plugin`; ticking a plugin reveals its `provides` line and, for MCP, the env-passthrough names) → Model → Leash (max-turns, timeout, isolation none/worktree) → **Run**. Toolbar: New / Open / Save / Export bundle / spec name.
- **Right pane (observe to completion):** status line (live state + model + isolation badge + **Cancel**), the normalized event stream, and a **Summary** card filled on completion (exit code, turns, cost, duration, result).

The left pane is the spec serialized; the right pane is the event protocol rendered. The "saved katas + run history" rail (Layout C) is a deliberate later extension.

## Testing strategy

Correctness lives in the engine, tested without burning tokens or depending on the real model:

- **`kata-core` unit tests (TDD):** spec parse/validate round-trip (TOML+JSON); discovery against fixture dirs; plugin-dir assembly (right files copied, temp cleaned up); **command construction as a pure function** (given spec → exact `claude` argv — pins the flag choices); `stream-json` → `KataEvent` normalization against recorded fixtures; leash timeout; bundle/vendor output.
- **Fake-`claude` harness:** a stub binary on `PATH` replaying recorded `stream-json` and exiting with a chosen code. Integration-tests the full spawn → parse → normalize → leash → cleanup → exit-code path, including cancel and timeout, offline and deterministic.
- **One opt-in real smoke test:** gated behind an env flag (off in CI); a trivial task against the actual `claude` to catch real-world flag drift.
- **`kata-cli`:** assert JSON-lines output + exit codes for `run`/`validate`/`catalog`/`bundle` against the fake claude.
- **Tauri app:** keep logic out of the webview; the Rust backend ("spawn the kata binary, relay events") is tested against the fake binary; the frontend stays presentational.

## Milestones (vertical slices; the engine ships before the GUI)

- **M0** Workspace scaffold: Cargo workspace (`kata-core`, `kata-cli`), Tauri app skeleton, MIT `LICENSE`, README, fake-claude harness.
- **M1** Spec model + `kata validate` (TOML/JSON round-trip).
- **M2** Discovery + `kata catalog`.
- **M3** Plugin-dir assembly + command construction (pure, no spawn).
- **M4** Spawn + `stream-json` normalization + leash + cleanup → **`kata run`**. *Engine MVP: headless + CI usable; Shokunin can integrate here.*
- **M5** Workbench left pane: compose + save/load specs, populated via `kata catalog`.
- **M6** Workbench right pane: run + observe + cancel + summary. *End-to-end GUI.*
- **M7** `kata bundle` (vendor skills/plugins for portable hand-off).
- **M8** Worktree isolation polish.

The first implementation plan covers **M0–M4** (the engine), the self-contained core the blog post is actually about.

## Open questions / future

- Exact `claude` flag names/semantics confirmed against the installed CLI at M0/M4 (especially `--plugin-dir` plugin-root layout and the bypass flag spelling).
- Cost/`cost_usd` availability in `stream-json` output to confirm at M4.
- Later: saved-katas + run-history rail (Layout C), first-class guard hooks, MCP config UI, named context presets, cost-ceiling leash.
