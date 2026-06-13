# Kata Engine (M0–M4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Kata engine: a Rust library (`kata-core`) and CLI (`kata`) that loads a portable run-spec, assembles a disposable plugin-dir, drives `claude -p` to completion under a leash, and streams a normalized JSON-line event protocol. No GUI in this plan.

**Architecture:** One Cargo workspace, two crates. `kata-core` holds all logic (spec, discovery, assembly, command construction, event parsing, run orchestration). `kata-cli` is a thin binary exposing `run`/`validate`/`catalog`. The engine binary is the single execution path the GUI, Shokunin, and CI all call. The real `claude` is never invoked in unit tests; a `fake-claude` helper binary replays recorded `stream-json`, and one opt-in test hits the real CLI.

**Tech Stack:** Rust (edition 2021), serde + toml + serde_json, thiserror, tempfile, clap, ctrlc. No async runtime — std threads + channels.

**Spec:** `docs/superpowers/specs/2026-06-12-kata-launcher-design.md`. Read it before starting.

---

## Environment notes (read first)

- This repo lives on a mount where the agent shell cannot delete/rename files; **run all `git` commands natively in PowerShell** (e.g. `git -C "D:\Repos\kata" ...` or from the repo root). The `git add`/`git commit` lines in steps are the commands to run; run them in PowerShell.
- `cargo` runs fine from the agent shell.
- The engine locates the Claude binary via the `KATA_CLAUDE_BIN` environment variable, defaulting to `claude`. Tests set it to the `fake-claude` helper. This is also a real production escape hatch.

## File structure

```
kata/
  Cargo.toml                          # [workspace] members
  LICENSE                             # MIT
  README.md
  .gitignore
  crates/
    kata-core/
      Cargo.toml                      # lib + [[bin]] fake-claude
      src/
        lib.rs                        # module wiring + re-exports
        spec.rs                       # RunSpec types, load(), validate()
        catalog.rs                    # CatalogEntry, discover()
        command.rs                    # ClaudeInvocation, build_invocation()
        assemble.rs                   # Assembled, assemble()
        event.rs                      # KataEvent, parse_stream_line(), pump()
        run.rs                        # run(), RunOutcome, RunError, CancelToken
        fsutil.rs                     # copy_dir()
        bin/
          fake-claude.rs              # test helper: replays stream-json fixtures
      tests/
        run_it.rs                     # integration: run() vs fake-claude (spawn/cancel/timeout)
    kata-cli/
      Cargo.toml                      # bin "kata"
      src/
        main.rs                       # clap subcommands -> kata-core
      tests/
        cli_it.rs                     # integration: `kata run/validate/catalog`
  docs/superpowers/{specs,plans}/...
```

---

## Task 0: Workspace scaffold + confirm the `claude` flags (M0)

**Files:**
- Create: `Cargo.toml`, `LICENSE`, `README.md`, `.gitignore`
- Create: `crates/kata-core/Cargo.toml`, `crates/kata-core/src/lib.rs`
- Create: `crates/kata-cli/Cargo.toml`, `crates/kata-cli/src/main.rs`

- [ ] **Step 1: Confirm the real CLI flags exist (one-time, before coding)**

Run: `claude --help`
Confirm these flags are present and note exact spellings: `--bare`, `-p/--print`, `--append-system-prompt-file`, `--system-prompt`, `--plugin-dir`, `--model`, `--max-turns`, `--output-format` (accepts `stream-json`), `--dangerously-skip-permissions`.
Also run `claude -p "say hi" --output-format stream-json --max-turns 1` in a scratch dir and **save 3–5 output lines** into `crates/kata-core/tests/fixtures/stream-hello.jsonl` — these become parser fixtures in Task 7.
If any flag name differs, record the correct spelling here in the plan before continuing; it is consumed only in Task 5 (`command.rs`) and Task 0 wiring.

> If `claude` is not installed on this machine, hand-write `stream-hello.jsonl` from the documented `stream-json` shape (objects with a `type` field: `system`/`assistant`/`user`/`result`) and proceed; the opt-in smoke test in Task 10 will catch drift later.

- [ ] **Step 2: Write the workspace root `Cargo.toml`**

```toml
[workspace]
resolver = "2"
members = ["crates/kata-core", "crates/kata-cli"]

[workspace.package]
edition = "2021"
license = "MIT"
version = "0.1.0"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"
thiserror = "1"
tempfile = "3"
clap = { version = "4", features = ["derive"] }
ctrlc = "3"
```

- [ ] **Step 3: Write `crates/kata-core/Cargo.toml`**

```toml
[package]
name = "kata-core"
edition.workspace = true
license.workspace = true
version.workspace = true

[lib]
name = "kata_core"
path = "src/lib.rs"

[[bin]]
name = "fake-claude"
path = "src/bin/fake-claude.rs"

[dependencies]
serde.workspace = true
serde_json.workspace = true
toml.workspace = true
thiserror.workspace = true
tempfile.workspace = true
```

- [ ] **Step 4: Write `crates/kata-cli/Cargo.toml`**

```toml
[package]
name = "kata-cli"
edition.workspace = true
license.workspace = true
version.workspace = true

[[bin]]
name = "kata"
path = "src/main.rs"

[dependencies]
kata-core = { path = "../kata-core" }
serde.workspace = true
serde_json.workspace = true
clap.workspace = true
ctrlc.workspace = true
```

- [ ] **Step 5: Write placeholder `crates/kata-core/src/lib.rs`**

```rust
pub mod assemble;
pub mod catalog;
pub mod command;
pub mod event;
pub mod fsutil;
pub mod run;
pub mod spec;
```

Create empty module files so it compiles: each of `assemble.rs`, `catalog.rs`, `command.rs`, `event.rs`, `fsutil.rs`, `run.rs`, `spec.rs` starts empty (filled in later tasks). Create `src/bin/fake-claude.rs` with `fn main() {}` for now.

- [ ] **Step 6: Write a minimal `crates/kata-cli/src/main.rs`**

```rust
fn main() {
    println!("kata");
}
```

- [ ] **Step 7: Write `LICENSE` (MIT), `README.md`, `.gitignore`**

`.gitignore`:
```
/target
**/*.rs.bk
node_modules/
dist/
.DS_Store
Thumbs.db
```

`README.md` (short):
```markdown
# Kata

Compose a portable run-spec, drive `claude -p` to completion, observe it, check the exit code.
The engine binary is the single execution path shared by the GUI, Shokunin, and CI.

See `docs/superpowers/specs/2026-06-12-kata-launcher-design.md`.
```

`LICENSE`: standard MIT text, copyright holder "SatishKrishna Pilla", year 2026.

- [ ] **Step 8: Verify the workspace builds**

Run: `cargo build`
Expected: compiles, produces `kata` and `fake-claude` binaries, no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold cargo workspace, kata-core + kata-cli, MIT license"
```

---

## Task 1: Run-spec types, load, and validate (M1)

**Files:**
- Modify: `crates/kata-core/src/spec.rs`
- Test: inline `#[cfg(test)]` in `spec.rs`

- [ ] **Step 1: Write failing tests in `crates/kata-core/src/spec.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_toml() -> &'static str {
        r#"
schema = 1
name = "demo"
task = "do the thing"
workdir = "/tmp/work"
"#
    }

    #[test]
    fn parses_minimal_spec_with_defaults() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert_eq!(spec.name, "demo");
        assert_eq!(spec.task, "do the thing");
        assert_eq!(spec.leash.max_turns, 12); // default
        assert_eq!(spec.leash.isolation, Isolation::None);
        assert_eq!(spec.identity.mode, IdentityMode::Append);
        assert!(spec.skills.is_empty());
        assert!(spec.plugins.is_empty());
        assert!(spec.model.id.is_none());
    }

    #[test]
    fn parses_full_spec_including_plugins_table() {
        let toml = r#"
schema = 1
name = "triage"
task = "triage it"
context = "extra"
workdir = "/repo"
skills = ["triage-flaky-test"]

[identity]
system_prompt = "you triage"
mode = "replace"

[plugins.github-tools]
mcp = true
env = ["GITHUB_TOKEN"]

[plugins.doc-writer]

[model]
id = "claude-sonnet-4-6"

[leash]
max_turns = 8
timeout_secs = 600
isolation = "worktree"
"#;
        let spec: RunSpec = toml::from_str(toml).unwrap();
        assert_eq!(spec.identity.mode, IdentityMode::Replace);
        assert_eq!(spec.skills, vec!["triage-flaky-test"]);
        assert_eq!(spec.plugins.len(), 2);
        assert_eq!(spec.plugins["github-tools"].env, vec!["GITHUB_TOKEN"]);
        assert_eq!(spec.plugins["github-tools"].mcp, Some(true));
        assert!(spec.plugins.contains_key("doc-writer"));
        assert_eq!(spec.model.id.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(spec.leash.isolation, Isolation::Worktree);
        assert_eq!(spec.leash.timeout_secs, Some(600));
    }

    #[test]
    fn toml_round_trips() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        let text = toml::to_string(&spec).unwrap();
        let again: RunSpec = toml::from_str(&text).unwrap();
        assert_eq!(spec, again);
    }

    #[test]
    fn json_parses_same_shape() {
        let json = r#"{"schema":1,"name":"j","task":"t","workdir":"/w"}"#;
        let spec: RunSpec = serde_json::from_str(json).unwrap();
        assert_eq!(spec.name, "j");
        assert_eq!(spec.leash.max_turns, 12);
    }

    #[test]
    fn validate_flags_missing_required_fields() {
        let spec = RunSpec { schema: 1, name: " ".into(), task: "".into(), workdir: "".into(), ..Default::default() };
        let errs = validate(&spec).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("name")));
        assert!(errs.iter().any(|e| e.contains("task")));
        assert!(errs.iter().any(|e| e.contains("workdir")));
    }

    #[test]
    fn validate_rejects_unknown_schema_and_zero_turns() {
        let mut spec = RunSpec { schema: 99, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.leash.max_turns = 0;
        let errs = validate(&spec).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("schema")));
        assert!(errs.iter().any(|e| e.contains("max_turns")));
    }

    #[test]
    fn validate_passes_minimal() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert!(validate(&spec).is_ok());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p kata-core spec::`
Expected: FAIL to compile (types not defined).

- [ ] **Step 3: Implement the types + load + validate at the top of `crates/kata-core/src/spec.rs`**

```rust
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RunSpec {
    pub schema: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    pub workdir: String,
    #[serde(default)]
    pub identity: Identity,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginConfig>,
    #[serde(default)]
    pub model: Model,
    #[serde(default)]
    pub leash: Leash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Identity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub mode: IdentityMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum IdentityMode {
    #[default]
    Append,
    Replace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PluginConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Model {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Leash {
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub isolation: Isolation,
}

impl Default for Leash {
    fn default() -> Self {
        Self { max_turns: default_max_turns(), timeout_secs: None, isolation: Isolation::None }
    }
}

fn default_max_turns() -> u32 { 12 }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Isolation {
    #[default]
    None,
    Worktree,
}

#[derive(Debug, thiserror::Error)]
pub enum SpecError {
    #[error("reading {0}: {1}")]
    Io(String, std::io::Error),
    #[error("parsing TOML: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("parsing JSON: {0}")]
    Json(#[from] serde_json::Error),
}

/// Load a spec from disk. `.json` parses as JSON; anything else as TOML.
pub fn load(path: &Path) -> Result<RunSpec, SpecError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| SpecError::Io(path.display().to_string(), e))?;
    let spec = if path.extension().and_then(|e| e.to_str()) == Some("json") {
        serde_json::from_str(&text)?
    } else {
        toml::from_str(&text)?
    };
    Ok(spec)
}

/// Pure structural validation (no filesystem access).
pub fn validate(spec: &RunSpec) -> Result<(), Vec<String>> {
    let mut errs = Vec::new();
    if spec.schema != 1 {
        errs.push(format!("unsupported schema version {} (expected 1)", spec.schema));
    }
    if spec.name.trim().is_empty() { errs.push("name is required".into()); }
    if spec.task.trim().is_empty() { errs.push("task is required".into()); }
    if spec.workdir.trim().is_empty() { errs.push("workdir is required".into()); }
    if spec.leash.max_turns == 0 { errs.push("leash.max_turns must be >= 1".into()); }
    if errs.is_empty() { Ok(()) } else { Err(errs) }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kata-core spec::`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/kata-core/src/spec.rs
git commit -m "feat(core): run-spec types with TOML/JSON load and validation"
```

---

## Task 2: `kata validate` CLI command (M1)

**Files:**
- Modify: `crates/kata-cli/src/main.rs`
- Test: `crates/kata-cli/tests/cli_it.rs`

- [ ] **Step 1: Write a failing integration test in `crates/kata-cli/tests/cli_it.rs`**

```rust
use std::process::Command;

fn kata() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kata"))
}

fn write(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    p
}

#[test]
fn validate_ok_exits_zero() {
    let tmp = tempfile::tempdir().unwrap();
    let spec = write(tmp.path(), "ok.kata.toml",
        "schema = 1\nname = \"x\"\ntask = \"t\"\nworkdir = \"/w\"\n");
    let out = kata().arg("validate").arg(&spec).output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn validate_bad_exits_nonzero_and_lists_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let spec = write(tmp.path(), "bad.kata.toml",
        "schema = 1\nname = \"\"\ntask = \"\"\nworkdir = \"\"\n");
    let out = kata().arg("validate").arg(&spec).output().unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("name"));
    assert!(err.contains("task"));
}
```

Add `tempfile` as a dev-dependency to `crates/kata-cli/Cargo.toml`:
```toml
[dev-dependencies]
tempfile.workspace = true
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kata-cli --test cli_it validate`
Expected: FAIL (no `validate` subcommand; exits with usage error).

- [ ] **Step 3: Implement clap subcommands in `crates/kata-cli/src/main.rs`**

```rust
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "kata", version, about = "Run a single headless coding-agent kata")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Validate a run-spec file.
    Validate { spec: PathBuf },
    /// List discovered skills and plugins as JSON.
    Catalog,
    /// Run a kata to completion, streaming JSON-line events.
    Run { spec: PathBuf },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Cmd::Validate { spec } => cmd_validate(&spec),
        Cmd::Catalog => cmd_catalog(),
        Cmd::Run { spec } => cmd_run(&spec),
    }
}

fn cmd_validate(path: &std::path::Path) -> ExitCode {
    let spec = match kata_core::spec::load(path) {
        Ok(s) => s,
        Err(e) => { eprintln!("error: {e}"); return ExitCode::from(2); }
    };
    match kata_core::spec::validate(&spec) {
        Ok(()) => { println!("ok: {} valid", path.display()); ExitCode::SUCCESS }
        Err(errs) => {
            for e in errs { eprintln!("error: {e}"); }
            ExitCode::from(1)
        }
    }
}

// Implemented in later tasks:
fn cmd_catalog() -> ExitCode { eprintln!("not implemented"); ExitCode::from(70) }
fn cmd_run(_path: &std::path::Path) -> ExitCode { eprintln!("not implemented"); ExitCode::from(70) }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p kata-cli --test cli_it validate`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/kata-cli
git commit -m "feat(cli): kata validate subcommand"
```

---

## Task 3: Catalog discovery (M2)

**Files:**
- Modify: `crates/kata-core/src/catalog.rs`
- Test: inline `#[cfg(test)]` in `catalog.rs`

- [ ] **Step 1: Write failing tests in `crates/kata-core/src/catalog.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_skill(root: &std::path::Path, name: &str, desc: &str) {
        let dir = root.join("skills").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {desc}\n---\nbody\n")).unwrap();
    }

    fn make_plugin(root: &std::path::Path, name: &str, desc: &str, with_mcp: bool) {
        let dir = root.join("plugins").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plugin.json"),
            format!("{{\"name\":\"{name}\",\"description\":\"{desc}\"}}")).unwrap();
        fs::create_dir_all(dir.join("skills").join("inner")).unwrap();
        fs::write(dir.join("skills").join("inner").join("SKILL.md"),
            "---\nname: inner\ndescription: d\n---\n").unwrap();
        if with_mcp {
            fs::write(dir.join(".mcp.json"),
                "{\"mcpServers\":{\"srv\":{\"command\":\"x\"}}}").unwrap();
        }
    }

    #[test]
    fn discovers_skills_with_source_labels() {
        let user = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        make_skill(user.path(), "triage", "triage flaky tests");
        make_skill(proj.path(), "build", "build the project");

        let roots = DiscoveryRoots {
            user_dir: user.path().to_path_buf(),
            project_dir: proj.path().to_path_buf(),
        };
        let mut entries = discover(&roots);
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(entries.len(), 2);
        let build = entries.iter().find(|e| e.name == "build").unwrap();
        assert_eq!(build.kind, EntryKind::Skill);
        assert_eq!(build.source, "project");
        assert_eq!(build.description, "build the project");
        let triage = entries.iter().find(|e| e.name == "triage").unwrap();
        assert_eq!(triage.source, "user");
    }

    #[test]
    fn discovers_plugins_with_provides_and_mcp() {
        let user = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        make_plugin(user.path(), "github-tools", "gh", true);

        let roots = DiscoveryRoots {
            user_dir: user.path().to_path_buf(),
            project_dir: proj.path().to_path_buf(),
        };
        let entries = discover(&roots);
        let p = entries.iter().find(|e| e.name == "github-tools").unwrap();
        assert_eq!(p.kind, EntryKind::Plugin);
        assert_eq!(p.mcp_servers, vec!["srv"]);
        assert!(p.provides.iter().any(|s| s == "skill:inner"));
    }

    #[test]
    fn missing_roots_yield_empty() {
        let roots = DiscoveryRoots {
            user_dir: "/nonexistent/x".into(),
            project_dir: "/nonexistent/y".into(),
        };
        assert!(discover(&roots).is_empty());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p kata-core catalog::`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `crates/kata-core/src/catalog.rs`**

```rust
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Skill,
    Plugin,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogEntry {
    pub kind: EntryKind,
    pub name: String,
    pub description: String,
    pub source: String, // "user" | "project" | "plugin"
    pub path: PathBuf,
    pub provides: Vec<String>,
    pub mcp_servers: Vec<String>,
}

pub struct DiscoveryRoots {
    /// e.g. ~/.claude
    pub user_dir: PathBuf,
    /// e.g. <project>/.claude
    pub project_dir: PathBuf,
}

impl DiscoveryRoots {
    /// Default roots: $HOME/.claude and <cwd>/.claude.
    pub fn defaults(cwd: &Path) -> Self {
        let home = dirs_home();
        Self {
            user_dir: home.join(".claude"),
            project_dir: cwd.join(".claude"),
        }
    }
}

fn dirs_home() -> PathBuf {
    // Avoid an extra dependency: HOME on unix, USERPROFILE on windows.
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn discover(roots: &DiscoveryRoots) -> Vec<CatalogEntry> {
    let mut out = Vec::new();
    discover_skills(&roots.user_dir, "user", &mut out);
    discover_skills(&roots.project_dir, "project", &mut out);
    discover_plugins(&roots.user_dir, &mut out);
    discover_plugins(&roots.project_dir, &mut out);
    out
}

fn discover_skills(claude_dir: &Path, source: &str, out: &mut Vec<CatalogEntry>) {
    let skills = claude_dir.join("skills");
    let Ok(rd) = std::fs::read_dir(&skills) else { return };
    for entry in rd.flatten() {
        let dir = entry.path();
        let skill_md = dir.join("SKILL.md");
        if !skill_md.is_file() { continue; }
        let (name, description) = read_frontmatter(&skill_md);
        let name = name.unwrap_or_else(|| dir.file_name().unwrap().to_string_lossy().into_owned());
        out.push(CatalogEntry {
            kind: EntryKind::Skill,
            name,
            description: description.unwrap_or_default(),
            source: source.to_string(),
            path: dir,
            provides: vec![],
            mcp_servers: vec![],
        });
    }
}

fn discover_plugins(claude_dir: &Path, out: &mut Vec<CatalogEntry>) {
    let plugins = claude_dir.join("plugins");
    let Ok(rd) = std::fs::read_dir(&plugins) else { return };
    for entry in rd.flatten() {
        let dir = entry.path();
        let manifest = dir.join("plugin.json");
        if !manifest.is_file() { continue; }
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let description = std::fs::read_to_string(&manifest)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("description").and_then(|d| d.as_str()).map(String::from))
            .unwrap_or_default();
        out.push(CatalogEntry {
            kind: EntryKind::Plugin,
            name,
            description,
            source: "plugin".to_string(),
            provides: plugin_provides(&dir),
            mcp_servers: plugin_mcp_servers(&dir),
            path: dir,
        });
    }
}

fn plugin_provides(dir: &Path) -> Vec<String> {
    let mut provides = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir.join("skills")) {
        for e in rd.flatten() {
            if e.path().join("SKILL.md").is_file() {
                provides.push(format!("skill:{}", e.file_name().to_string_lossy()));
            }
        }
    }
    provides.sort();
    provides
}

fn plugin_mcp_servers(dir: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(dir.join(".mcp.json")) else { return vec![] };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![] };
    let mut names: Vec<String> = v.get("mcpServers")
        .and_then(|m| m.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// Minimal YAML-frontmatter reader: pulls `name:` and `description:` from the
/// leading `---` block. Avoids a YAML dependency for two scalar fields.
fn read_frontmatter(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(path) else { return (None, None) };
    let mut lines = text.lines();
    if lines.next().map(|l| l.trim()) != Some("---") {
        return (None, None);
    }
    let (mut name, mut desc) = (None, None);
    for line in lines {
        let t = line.trim();
        if t == "---" { break; }
        if let Some(rest) = t.strip_prefix("name:") {
            name = Some(rest.trim().trim_matches('"').to_string());
        } else if let Some(rest) = t.strip_prefix("description:") {
            desc = Some(rest.trim().trim_matches('"').to_string());
        }
    }
    (name, desc)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kata-core catalog::`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/kata-core/src/catalog.rs
git commit -m "feat(core): discover skills and plugins into a catalog"
```

---

## Task 4: `kata catalog` CLI command (M2)

**Files:**
- Modify: `crates/kata-cli/src/main.rs`
- Test: `crates/kata-cli/tests/cli_it.rs`

- [ ] **Step 1: Add a failing test to `crates/kata-cli/tests/cli_it.rs`**

```rust
#[test]
fn catalog_emits_json_array() {
    // Point discovery at an isolated HOME so the test is deterministic.
    let home = tempfile::tempdir().unwrap();
    let skill = home.path().join(".claude").join("skills").join("triage");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"),
        "---\nname: triage\ndescription: triage flaky tests\n---\n").unwrap();

    let work = tempfile::tempdir().unwrap();
    let out = kata()
        .arg("catalog")
        .current_dir(work.path())
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .output()
        .unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));

    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let arr = v.as_array().unwrap();
    assert!(arr.iter().any(|e| e["name"] == "triage" && e["kind"] == "skill"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kata-cli --test cli_it catalog`
Expected: FAIL (`cmd_catalog` returns 70 "not implemented").

- [ ] **Step 3: Implement `cmd_catalog` in `crates/kata-cli/src/main.rs`**

Replace the stub `cmd_catalog`:
```rust
fn cmd_catalog() -> ExitCode {
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let roots = kata_core::catalog::DiscoveryRoots::defaults(&cwd);
    let entries = kata_core::catalog::discover(&roots);
    match serde_json::to_string_pretty(&entries) {
        Ok(json) => { println!("{json}"); ExitCode::SUCCESS }
        Err(e) => { eprintln!("error: {e}"); ExitCode::from(70) }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p kata-cli --test cli_it catalog`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kata-cli/src/main.rs crates/kata-cli/tests/cli_it.rs
git commit -m "feat(cli): kata catalog subcommand"
```

---

## Task 5: Command construction (M3)

**Files:**
- Modify: `crates/kata-core/src/command.rs`
- Test: inline `#[cfg(test)]` in `command.rs`

This is the flag-pinning task. `build_invocation` is a pure function from a spec + assembled paths to the exact `claude` argv.

- [ ] **Step 1: Write failing tests in `crates/kata-core/src/command.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::assemble::Assembled;
    use crate::spec::*;

    fn spec() -> RunSpec {
        let mut s = RunSpec { schema: 1, name: "n".into(), task: "do it".into(), workdir: "/repo".into(), ..Default::default() };
        s.leash.max_turns = 8;
        s
    }

    fn assembled_with(plugin_dir: Option<&str>, sys: Option<&str>) -> Assembled {
        Assembled::for_test(plugin_dir.map(String::from), sys.map(String::from))
    }

    #[test]
    fn base_command_has_bare_print_streamjson_maxturns_bypass() {
        let inv = build_invocation(&spec(), &assembled_with(None, None));
        assert_eq!(inv.cwd, "/repo");
        assert!(inv.args.contains(&"--bare".to_string()));
        assert!(inv.args.contains(&"-p".to_string()));
        assert!(inv.args.windows(2).any(|w| w[0] == "--output-format" && w[1] == "stream-json"));
        assert!(inv.args.windows(2).any(|w| w[0] == "--max-turns" && w[1] == "8"));
        assert!(inv.args.contains(&"--dangerously-skip-permissions".to_string()));
        // no plugin dir, no system prompt, no model
        assert!(!inv.args.iter().any(|a| a == "--plugin-dir"));
        assert!(!inv.args.iter().any(|a| a == "--model"));
        assert!(!inv.args.iter().any(|a| a.starts_with("--append-system-prompt")));
    }

    #[test]
    fn prompt_is_task_then_context() {
        let mut s = spec();
        s.context = Some("background".into());
        let inv = build_invocation(&s, &assembled_with(None, None));
        let p_idx = inv.args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(inv.args[p_idx + 1], "do it\n\nbackground");
    }

    #[test]
    fn append_mode_uses_system_prompt_file() {
        let mut s = spec();
        s.identity.system_prompt = Some("you triage".into());
        s.identity.mode = IdentityMode::Append;
        let inv = build_invocation(&s, &assembled_with(None, Some("/tmp/system.txt")));
        assert!(inv.args.windows(2).any(|w| w[0] == "--append-system-prompt-file" && w[1] == "/tmp/system.txt"));
    }

    #[test]
    fn replace_mode_passes_prompt_inline() {
        let mut s = spec();
        s.identity.system_prompt = Some("be terse".into());
        s.identity.mode = IdentityMode::Replace;
        let inv = build_invocation(&s, &assembled_with(None, None));
        assert!(inv.args.windows(2).any(|w| w[0] == "--system-prompt" && w[1] == "be terse"));
    }

    #[test]
    fn includes_plugin_dir_and_model_when_present() {
        let mut s = spec();
        s.model.id = Some("claude-sonnet-4-6".into());
        let inv = build_invocation(&s, &assembled_with(Some("/tmp/kit"), None));
        assert!(inv.args.windows(2).any(|w| w[0] == "--plugin-dir" && w[1] == "/tmp/kit"));
        assert!(inv.args.windows(2).any(|w| w[0] == "--model" && w[1] == "claude-sonnet-4-6"));
    }

    #[test]
    fn forwards_named_env_vars_when_set() {
        std::env::set_var("KATA_TEST_TOKEN", "secret");
        let mut s = spec();
        let mut cfg = PluginConfig::default();
        cfg.env = vec!["KATA_TEST_TOKEN".into(), "KATA_TEST_ABSENT".into()];
        s.plugins.insert("gh".into(), cfg);
        let inv = build_invocation(&s, &assembled_with(None, None));
        assert!(inv.env.iter().any(|(k, v)| k == "KATA_TEST_TOKEN" && v == "secret"));
        assert!(!inv.env.iter().any(|(k, _)| k == "KATA_TEST_ABSENT"));
        std::env::remove_var("KATA_TEST_TOKEN");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p kata-core command::`
Expected: FAIL to compile (`build_invocation`, `Assembled::for_test` missing).

- [ ] **Step 3: Implement `crates/kata-core/src/command.rs`**

```rust
use crate::assemble::Assembled;
use crate::spec::{IdentityMode, RunSpec};

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeInvocation {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Env vars to set on the child, resolved by name from the current process env.
    pub env: Vec<(String, String)>,
}

pub fn build_invocation(spec: &RunSpec, assembled: &Assembled) -> ClaudeInvocation {
    let program = std::env::var("KATA_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string());

    let mut args: Vec<String> = vec![
        "--bare".into(),
        "-p".into(),
        compose_prompt(spec),
    ];

    if let Some(sp) = spec.identity.system_prompt.as_ref().filter(|s| !s.trim().is_empty()) {
        match spec.identity.mode {
            IdentityMode::Append => {
                if let Some(file) = &assembled.system_prompt_file {
                    args.push("--append-system-prompt-file".into());
                    args.push(file.clone());
                }
            }
            IdentityMode::Replace => {
                args.push("--system-prompt".into());
                args.push(sp.clone());
            }
        }
    }

    if let Some(dir) = &assembled.plugin_dir {
        args.push("--plugin-dir".into());
        args.push(dir.clone());
    }

    if let Some(id) = &spec.model.id {
        args.push("--model".into());
        args.push(id.clone());
    }

    args.push("--max-turns".into());
    args.push(spec.leash.max_turns.to_string());
    args.push("--output-format".into());
    args.push("stream-json".into());
    args.push("--dangerously-skip-permissions".into());

    let mut env = Vec::new();
    for cfg in spec.plugins.values() {
        for name in &cfg.env {
            if let Ok(val) = std::env::var(name) {
                env.push((name.clone(), val));
            }
        }
    }

    ClaudeInvocation { program, args, cwd: spec.workdir.clone(), env }
}

fn compose_prompt(spec: &RunSpec) -> String {
    match spec.context.as_ref().map(|c| c.trim()).filter(|c| !c.is_empty()) {
        Some(ctx) => format!("{}\n\n{}", spec.task.trim(), ctx),
        None => spec.task.trim().to_string(),
    }
}
```

- [ ] **Step 4: Add the `Assembled` type with a test constructor in `crates/kata-core/src/assemble.rs`**

(Full assembly logic comes in Task 6; this defines the struct so Task 5 compiles.)
```rust
use tempfile::TempDir;

#[derive(Debug)]
pub struct Assembled {
    pub plugin_dir: Option<String>,
    pub system_prompt_file: Option<String>,
    // RAII: when dropped, the temp directory and its contents are removed.
    _temp: Option<TempDir>,
}

impl Assembled {
    /// Construct without a backing temp dir, for tests of pure consumers.
    pub fn for_test(plugin_dir: Option<String>, system_prompt_file: Option<String>) -> Self {
        Self { plugin_dir, system_prompt_file, _temp: None }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p kata-core command::`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/kata-core/src/command.rs crates/kata-core/src/assemble.rs
git commit -m "feat(core): pure claude invocation builder pins the flag set"
```

---

## Task 6: Assemble the disposable plugin-dir (M3)

**Files:**
- Modify: `crates/kata-core/src/fsutil.rs`, `crates/kata-core/src/assemble.rs`
- Test: inline `#[cfg(test)]` in both

- [ ] **Step 1: Write a failing test for `copy_dir` in `crates/kata-core/src/fsutil.rs`**

```rust
use std::path::Path;

/// Recursively copy a directory tree from `src` into `dst` (created if absent).
pub fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_nested_tree() {
        let src = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(src.path().join("a")).unwrap();
        std::fs::write(src.path().join("a").join("f.txt"), "hi").unwrap();
        let dst = tempfile::tempdir().unwrap();
        let target = dst.path().join("out");
        copy_dir(src.path(), &target).unwrap();
        assert_eq!(std::fs::read_to_string(target.join("a").join("f.txt")).unwrap(), "hi");
    }
}
```

- [ ] **Step 2: Run test to verify it passes (implementation written alongside)**

Run: `cargo test -p kata-core fsutil::`
Expected: PASS (1 test). (Implementation and test are written together here because `copy_dir` is a trivial leaf utility; the assembly logic that uses it is tested in Step 3.)

- [ ] **Step 3: Write failing tests for `assemble` in `crates/kata-core/src/assemble.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{CatalogEntry, EntryKind};
    use crate::spec::*;
    use std::fs;
    use std::path::PathBuf;

    fn skill_entry(name: &str) -> (CatalogEntry, tempfile::TempDir) {
        let td = tempfile::tempdir().unwrap();
        fs::write(td.path().join("SKILL.md"),
            format!("---\nname: {name}\ndescription: d\n---\nsteps\n")).unwrap();
        let entry = CatalogEntry {
            kind: EntryKind::Skill, name: name.into(), description: "d".into(),
            source: "user".into(), path: td.path().to_path_buf(),
            provides: vec![], mcp_servers: vec![],
        };
        (entry, td)
    }

    #[test]
    fn assembles_selected_skill_into_plugin_dir() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.skills = vec!["triage".into()];

        let a = assemble(&spec, std::slice::from_ref(&entry)).unwrap();
        let dir = PathBuf::from(a.plugin_dir.as_ref().unwrap());
        assert!(dir.join("skills").join("triage").join("SKILL.md").is_file());
        assert!(a.system_prompt_file.is_none());
    }

    #[test]
    fn writes_system_prompt_file_in_append_mode() {
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.identity.system_prompt = Some("you triage".into());
        spec.identity.mode = IdentityMode::Append;

        let a = assemble(&spec, &[]).unwrap();
        let f = a.system_prompt_file.as_ref().unwrap();
        assert_eq!(fs::read_to_string(f).unwrap(), "you triage");
        // no skills selected -> no plugin dir
        assert!(a.plugin_dir.is_none());
    }

    #[test]
    fn replace_mode_writes_no_file() {
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.identity.system_prompt = Some("x".into());
        spec.identity.mode = IdentityMode::Replace;
        let a = assemble(&spec, &[]).unwrap();
        assert!(a.system_prompt_file.is_none());
    }

    #[test]
    fn unknown_skill_is_an_error() {
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.skills = vec!["nope".into()];
        let err = assemble(&spec, &[]).unwrap_err();
        assert!(matches!(err, AssembleError::NotFound(_)));
    }

    #[test]
    fn cleanup_removes_temp_on_drop() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.skills = vec!["triage".into()];
        let dir = {
            let a = assemble(&spec, std::slice::from_ref(&entry)).unwrap();
            PathBuf::from(a.plugin_dir.as_ref().unwrap())
        }; // a dropped here
        assert!(!dir.exists(), "temp plugin dir should be cleaned up on drop");
    }
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cargo test -p kata-core assemble::`
Expected: FAIL to compile (`assemble`, `AssembleError` missing).

- [ ] **Step 5: Implement `assemble` + `AssembleError` in `crates/kata-core/src/assemble.rs`**

Add above the existing `Assembled` definition (keep `for_test`):
```rust
use crate::catalog::{CatalogEntry, EntryKind};
use crate::fsutil::copy_dir;
use crate::spec::{IdentityMode, RunSpec};
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum AssembleError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("not found: {0}")]
    NotFound(String),
}

pub fn assemble(spec: &RunSpec, catalog: &[CatalogEntry]) -> Result<Assembled, AssembleError> {
    let temp = tempfile::tempdir()?;
    let root = temp.path();

    // System prompt file (append mode only; replace passes inline in command.rs).
    let mut system_prompt_file = None;
    if let Some(sp) = spec.identity.system_prompt.as_ref().filter(|s| !s.trim().is_empty()) {
        if spec.identity.mode == IdentityMode::Append {
            let f = root.join("system.txt");
            std::fs::write(&f, sp)?;
            system_prompt_file = Some(f.to_string_lossy().into_owned());
        }
    }

    // Disposable plugin-dir: skills/<name>/ and plugins/<name>/.
    let plugin_root = root.join("plugindir");
    let mut any = false;

    for name in &spec.skills {
        let entry = catalog.iter()
            .find(|e| e.kind == EntryKind::Skill && &e.name == name)
            .ok_or_else(|| AssembleError::NotFound(format!("skill '{name}'")))?;
        copy_dir(&entry.path, &plugin_root.join("skills").join(name))?;
        any = true;
    }
    for name in spec.plugins.keys() {
        let entry = catalog.iter()
            .find(|e| e.kind == EntryKind::Plugin && &e.name == name)
            .ok_or_else(|| AssembleError::NotFound(format!("plugin '{name}'")))?;
        copy_dir(&entry.path, &plugin_root.join("plugins").join(name))?;
        any = true;
    }

    let plugin_dir = if any {
        Some(plugin_root.to_string_lossy().into_owned())
    } else {
        None
    };

    Ok(Assembled { plugin_dir, system_prompt_file, _temp: Some(temp) })
}
```

> **Verification note (M0 finding):** the `skills/<name>/` layout under `--plugin-dir` matches the blog post's working example. Confirm the `plugins/<name>/` layout for whole plugins against `claude`'s plugin-dir loader during the Task 10 smoke test; if it differs, the only change is the `plugin_root.join(...)` path here.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p kata-core assemble::`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add crates/kata-core/src/assemble.rs crates/kata-core/src/fsutil.rs
git commit -m "feat(core): assemble disposable plugin-dir with RAII cleanup"
```

---

## Task 7: Event types + stream-json parser + pump loop (M4)

**Files:**
- Modify: `crates/kata-core/src/event.rs`
- Test: inline `#[cfg(test)]` in `event.rs`

- [ ] **Step 1: Write failing tests in `crates/kata-core/src/event.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_assistant_text_and_marks_message() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#;
        let p = parse_stream_line(line);
        assert!(p.is_assistant_message);
        assert_eq!(p.events, vec![KataEvent::AssistantText { text: "hello".into() }]);
        assert!(p.result.is_none());
    }

    #[test]
    fn parses_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}"#;
        let p = parse_stream_line(line);
        assert_eq!(p.events, vec![KataEvent::ToolUse { name: "Bash".into(), input_summary: "ls -la".into() }]);
    }

    #[test]
    fn parses_tool_result() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"3 failed","is_error":false}]}}"#;
        let p = parse_stream_line(line);
        assert_eq!(p.events, vec![KataEvent::ToolResult { name: String::new(), ok: true, summary: "3 failed".into() }]);
        assert!(!p.is_assistant_message);
    }

    #[test]
    fn parses_result_payload() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"num_turns":6,"total_cost_usd":0.04,"result":"done"}"#;
        let p = parse_stream_line(line);
        let r = p.result.unwrap();
        assert_eq!(r.num_turns, 6);
        assert_eq!(r.cost_usd, Some(0.04));
        assert!(!r.is_error);
        assert_eq!(r.result.as_deref(), Some("done"));
    }

    #[test]
    fn unrecognized_line_yields_no_events() {
        let p = parse_stream_line(r#"{"type":"system","subtype":"init"}"#);
        assert!(p.events.is_empty() || matches!(p.events[0], KataEvent::Log { .. }));
        assert!(p.result.is_none());
    }

    #[test]
    fn malformed_json_does_not_panic() {
        let p = parse_stream_line("not json");
        assert!(p.events.is_empty());
        assert!(p.result.is_none());
    }

    #[test]
    fn pump_emits_turns_and_returns_result() {
        let input = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#, "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"num_turns":2,"total_cost_usd":0.01,"result":"ok"}"#, "\n",
        );
        let mut events = Vec::new();
        let result = pump(Cursor::new(input), &|| false, &mut |e| events.push(e));
        assert_eq!(result.unwrap().num_turns, 2);
        // two assistant messages -> turns 1 and 2
        assert!(events.contains(&KataEvent::Turn { n: 1 }));
        assert!(events.contains(&KataEvent::Turn { n: 2 }));
        assert!(events.contains(&KataEvent::AssistantText { text: "a".into() }));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p kata-core event::`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `crates/kata-core/src/event.rs`**

```rust
use serde::Serialize;
use std::io::BufRead;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum KataEvent {
    #[serde(rename = "run.started")]
    RunStarted { spec: String, model: Option<String>, workdir: String, isolation: String },
    #[serde(rename = "log")]
    Log { level: String, message: String },
    #[serde(rename = "assistant.text")]
    AssistantText { text: String },
    #[serde(rename = "tool.use")]
    ToolUse { name: String, input_summary: String },
    #[serde(rename = "tool.result")]
    ToolResult { name: String, ok: bool, summary: String },
    #[serde(rename = "turn")]
    Turn { n: u32 },
    #[serde(rename = "run.completed")]
    RunCompleted {
        exit_code: i32,
        is_error: bool,
        num_turns: u32,
        cost_usd: Option<f64>,
        duration_ms: u64,
        result: Option<String>,
    },
    #[serde(rename = "run.error")]
    RunError { message: String },
    #[serde(rename = "run.cancelled")]
    RunCancelled,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResultPayload {
    pub num_turns: u32,
    pub cost_usd: Option<f64>,
    pub is_error: bool,
    pub result: Option<String>,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub events: Vec<KataEvent>,
    pub is_assistant_message: bool,
    pub result: Option<ResultPayload>,
}

/// Translate one line of Claude `stream-json` into normalized events.
/// Defensive: unknown shapes and malformed JSON yield an empty `Parsed`.
pub fn parse_stream_line(line: &str) -> Parsed {
    let mut out = Parsed::default();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return out };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => {
            out.is_assistant_message = true;
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for block in content {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                out.events.push(KataEvent::AssistantText { text: t.to_string() });
                            }
                        }
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                            out.events.push(KataEvent::ToolUse { name, input_summary: summarize_input(block.get("input")) });
                        }
                        _ => {}
                    }
                }
            }
        }
        Some("user") => {
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for block in content {
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        let ok = !block.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
                        out.events.push(KataEvent::ToolResult {
                            name: String::new(),
                            ok,
                            summary: summarize_content(block.get("content")),
                        });
                    }
                }
            }
        }
        Some("result") => {
            out.result = Some(ResultPayload {
                num_turns: v.get("num_turns").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
                cost_usd: v.get("total_cost_usd").and_then(|c| c.as_f64()),
                is_error: v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
                result: v.get("result").and_then(|r| r.as_str()).map(String::from),
            });
        }
        _ => {}
    }
    out
}

fn summarize_input(input: Option<&serde_json::Value>) -> String {
    match input {
        Some(v) => v.get("command").and_then(|c| c.as_str())
            .map(String::from)
            .unwrap_or_else(|| truncate(&v.to_string(), 200)),
        None => String::new(),
    }
}

fn summarize_content(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => truncate(s, 200),
        Some(other) => truncate(&other.to_string(), 200),
        None => String::new(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { s.to_string() } else { format!("{}...", &s[..max]) }
}

/// Read `stream-json` lines from `reader`, emit normalized events via `emit`,
/// counting assistant turns. Returns the final result payload if seen.
/// `cancel` is polled between lines; when it returns true, the loop stops early.
pub fn pump<R: BufRead>(
    reader: R,
    cancel: &dyn Fn() -> bool,
    emit: &mut dyn FnMut(KataEvent),
) -> Option<ResultPayload> {
    let mut turns: u32 = 0;
    let mut result = None;
    for line in reader.lines() {
        if cancel() { break; }
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let parsed = parse_stream_line(&line);
        if parsed.is_assistant_message {
            turns += 1;
            emit(KataEvent::Turn { n: turns });
        }
        for e in parsed.events { emit(e); }
        if let Some(r) = parsed.result { result = Some(r); }
    }
    result
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kata-core event::`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/kata-core/src/event.rs
git commit -m "feat(core): normalized event protocol and stream-json pump"
```

---

## Task 8: Run orchestration with spawn/leash/cancel (M4)

**Files:**
- Modify: `crates/kata-core/src/run.rs`
- Create: `crates/kata-core/src/bin/fake-claude.rs`
- Test: `crates/kata-core/tests/run_it.rs`

- [ ] **Step 1: Implement the `fake-claude` helper in `crates/kata-core/src/bin/fake-claude.rs`**

```rust
//! Test stand-in for the real `claude` CLI. Ignores all args except behavior
//! controlled by env vars, and emits canned stream-json on stdout.
//!
//! KATA_FAKE_MODE = "ok" (default) | "sleep" | "fail"
//!   ok    -> emit assistant text + tool use + success result, exit 0
//!   sleep -> emit one line, then sleep 60s (for cancel/timeout tests)
//!   fail  -> emit an error result, exit 1
use std::io::Write;
use std::{thread, time::Duration};

fn main() {
    let mode = std::env::var("KATA_FAKE_MODE").unwrap_or_else(|_| "ok".into());
    let mut out = std::io::stdout();
    let _ = writeln!(out, r#"{{"type":"system","subtype":"init"}}"#);
    let _ = out.flush();

    match mode.as_str() {
        "sleep" => {
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"working"}}]}}}}"#);
            let _ = out.flush();
            thread::sleep(Duration::from_secs(60));
        }
        "fail" => {
            let _ = writeln!(out, r#"{{"type":"result","subtype":"error","is_error":true,"num_turns":1,"total_cost_usd":0.0,"result":"boom"}}"#);
            let _ = out.flush();
            std::process::exit(1);
        }
        _ => {
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"hi"}}]}}}}"#);
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":"echo hi"}}}}]}}}}"#);
            let _ = writeln!(out, r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":2,"total_cost_usd":0.02,"result":"done"}}"#);
            let _ = out.flush();
        }
    }
}
```

- [ ] **Step 2: Write failing integration tests in `crates/kata-core/tests/run_it.rs`**

```rust
use kata_core::catalog::CatalogEntry;
use kata_core::event::KataEvent;
use kata_core::run::{run, CancelToken, RunError};
use kata_core::spec::RunSpec;
use std::sync::atomic::Ordering;
use std::time::Duration;

fn base_spec(workdir: &str) -> RunSpec {
    RunSpec { schema: 1, name: "it".into(), task: "do".into(), workdir: workdir.into(), ..Default::default() }
}

fn with_fake(mode: &str) {
    std::env::set_var("KATA_CLAUDE_BIN", env!("CARGO_BIN_EXE_fake-claude"));
    std::env::set_var("KATA_FAKE_MODE", mode);
}

#[test]
fn run_ok_streams_events_and_completes_zero() {
    with_fake("ok");
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(&base_spec(&work.path().to_string_lossy()), &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();

    assert_eq!(outcome.exit_code, 0);
    assert!(matches!(events.first(), Some(KataEvent::RunStarted { .. })));
    assert!(events.iter().any(|e| matches!(e, KataEvent::AssistantText { .. })));
    assert!(events.iter().any(|e| matches!(e, KataEvent::ToolUse { .. })));
    match events.last().unwrap() {
        KataEvent::RunCompleted { exit_code, num_turns, is_error, .. } => {
            assert_eq!(*exit_code, 0);
            assert_eq!(*num_turns, 2);
            assert!(!*is_error);
        }
        other => panic!("expected RunCompleted, got {other:?}"),
    }
}

#[test]
fn run_invalid_spec_errors_before_spawn() {
    with_fake("ok");
    let mut spec = base_spec("/w");
    spec.task = "".into();
    let cancel = CancelToken::new();
    let err = run(&spec, &[] as &[CatalogEntry], &cancel, |_| {}).unwrap_err();
    assert!(matches!(err, RunError::Invalid(_)));
}

#[test]
fn run_timeout_kills_child_and_reports_error() {
    with_fake("sleep");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.timeout_secs = Some(1);
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();
    assert_eq!(outcome.exit_code, 124);
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunError { .. })));
}

#[test]
fn run_cancel_kills_child() {
    with_fake("sleep");
    let work = tempfile::tempdir().unwrap();
    let spec = base_spec(&work.path().to_string_lossy());
    let cancel = CancelToken::new();
    let flag = cancel.flag();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        flag.store(true, Ordering::SeqCst);
    });
    let mut events = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();
    assert_eq!(outcome.exit_code, 130);
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunCancelled)));
}
```

Add dev-dependency to `crates/kata-core/Cargo.toml`:
```toml
[dev-dependencies]
tempfile.workspace = true
```
(tempfile is already a normal dependency; this line is harmless but optional. Skip if it causes a duplicate-key error.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p kata-core --test run_it`
Expected: FAIL to compile (`run`, `CancelToken`, `RunError`, `RunOutcome` missing).

- [ ] **Step 4: Implement `crates/kata-core/src/run.rs`**

```rust
use crate::assemble::{assemble, AssembleError};
use crate::catalog::CatalogEntry;
use crate::command::build_invocation;
use crate::event::{pump, KataEvent};
use crate::spec::{validate, Isolation, RunSpec};
use std::io::BufReader;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct RunOutcome {
    pub exit_code: i32,
}

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("invalid spec: {0:?}")]
    Invalid(Vec<String>),
    #[error("assembling kit: {0}")]
    Assemble(#[from] AssembleError),
    #[error("spawning claude: {0}")]
    Spawn(String),
}

/// Cooperative cancellation shared with the run loop.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self { Self(Arc::new(AtomicBool::new(false))) }
    pub fn cancel(&self) { self.0.store(true, Ordering::SeqCst); }
    pub fn is_cancelled(&self) -> bool { self.0.load(Ordering::SeqCst) }
    /// Share the underlying flag (e.g. with a Ctrl-C handler).
    pub fn flag(&self) -> Arc<AtomicBool> { self.0.clone() }
}

const POLL: Duration = Duration::from_millis(100);

pub fn run<F: FnMut(KataEvent)>(
    spec: &RunSpec,
    catalog: &[CatalogEntry],
    cancel: &CancelToken,
    mut emit: F,
) -> Result<RunOutcome, RunError> {
    validate(spec).map_err(RunError::Invalid)?;
    let assembled = assemble(spec, catalog)?;
    let inv = build_invocation(spec, &assembled);

    let isolation = match spec.leash.isolation {
        Isolation::None => "none",
        Isolation::Worktree => "worktree", // worktree creation lands in M8; cwd is workdir for now
    };
    emit(KataEvent::RunStarted {
        spec: spec.name.clone(),
        model: spec.model.id.clone(),
        workdir: spec.workdir.clone(),
        isolation: isolation.to_string(),
    });
    emit(KataEvent::Log {
        level: "info".into(),
        message: format!("assembled kit: {} skill(s), {} plugin(s)", spec.skills.len(), spec.plugins.len()),
    });

    let start = Instant::now();
    let mut cmd = Command::new(&inv.program);
    cmd.args(&inv.args)
        .current_dir(&inv.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("KATA_FAKE_MODE", std::env::var("KATA_FAKE_MODE").unwrap_or_default());
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| RunError::Spawn(e.to_string()))?;
    let stdout = child.stdout.take().expect("piped stdout");

    // Reader thread -> channel of lines.
    let (tx, rx) = mpsc::channel::<String>();
    let reader_handle = thread::spawn(move || {
        use std::io::BufRead;
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => { if tx.send(l).is_err() { break; } }
                Err(_) => break,
            }
        }
    });

    // Main loop: pull lines, enforce leash + cancel.
    let deadline = spec.leash.timeout_secs.map(|s| start + Duration::from_secs(s));
    let mut turns: u32 = 0;
    let mut result = None;
    let mut termination: Option<Termination> = None;

    loop {
        if cancel.is_cancelled() {
            termination = Some(Termination::Cancelled);
            break;
        }
        if let Some(d) = deadline {
            if Instant::now() >= d {
                termination = Some(Termination::TimedOut);
                break;
            }
        }
        match rx.recv_timeout(POLL) {
            Ok(line) => {
                if line.trim().is_empty() { continue; }
                let parsed = crate::event::parse_stream_line(&line);
                if parsed.is_assistant_message {
                    turns += 1;
                    emit(KataEvent::Turn { n: turns });
                }
                for e in parsed.events { emit(e); }
                if let Some(r) = parsed.result { result = Some(r); }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break, // child closed stdout
        }
    }

    // Resolve the child + exit code.
    let exit_code = match termination {
        Some(term) => {
            let _ = child.kill();
            let _ = child.wait();
            match term {
                Termination::Cancelled => {
                    emit(KataEvent::RunCancelled);
                    130
                }
                Termination::TimedOut => {
                    emit(KataEvent::RunError { message: format!("timed out after {}s", spec.leash.timeout_secs.unwrap_or(0)) });
                    124
                }
            }
        }
        None => {
            let status = child.wait().map_err(|e| RunError::Spawn(e.to_string()))?;
            let code = status.code().unwrap_or(1);
            let payload = result.unwrap_or(crate::event::ResultPayload {
                num_turns: turns, cost_usd: None, is_error: code != 0, result: None,
            });
            emit(KataEvent::RunCompleted {
                exit_code: code,
                is_error: payload.is_error,
                num_turns: payload.num_turns,
                cost_usd: payload.cost_usd,
                duration_ms: start.elapsed().as_millis() as u64,
                result: payload.result,
            });
            code
        }
    };

    let _ = reader_handle.join();
    // `assembled` drops here -> temp dir cleaned up.
    Ok(RunOutcome { exit_code })
}

enum Termination {
    Cancelled,
    TimedOut,
}
```

> Note: the `pump` function from Task 7 is the unit-tested twin of this loop's line-handling; the loop here re-implements the same handling around process control so it can interleave cancel/timeout polling. `pump` stays exercised by its own unit tests and documents the parsing contract. (If you prefer zero duplication, refactor the per-line block into a shared `fn handle_line(...)` and call it from both — optional cleanup, keep behavior identical.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p kata-core --test run_it`
Expected: PASS (4 tests). The timeout test takes ~1s; the cancel test ~0.3s.

- [ ] **Step 6: Commit**

```bash
git add crates/kata-core/src/run.rs crates/kata-core/src/bin/fake-claude.rs crates/kata-core/tests/run_it.rs crates/kata-core/Cargo.toml
git commit -m "feat(core): run orchestration with leash, cancel, and cleanup"
```

---

## Task 9: `kata run` CLI command with Ctrl-C cancel (M4)

**Files:**
- Modify: `crates/kata-cli/src/main.rs`
- Test: `crates/kata-cli/tests/cli_it.rs`

- [ ] **Step 1: Add a failing test to `crates/kata-cli/tests/cli_it.rs`**

```rust
#[test]
fn run_streams_jsonl_events_and_exits_zero() {
    let work = tempfile::tempdir().unwrap();
    let spec = write(work.path(), "r.kata.toml",
        &format!("schema = 1\nname = \"r\"\ntask = \"t\"\nworkdir = \"{}\"\n",
            work.path().to_string_lossy().replace('\\', "/")));

    let fake = env!("CARGO_BIN_EXE_fake-claude");
    let out = kata()
        .arg("run").arg(&spec)
        .env("KATA_CLAUDE_BIN", fake)
        .env("KATA_FAKE_MODE", "ok")
        .output()
        .unwrap();

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8(out.stdout).unwrap();
    // Each line is a JSON event; first is run.started, last is run.completed.
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    let first: serde_json::Value = serde_json::from_str(lines.first().unwrap()).unwrap();
    let last: serde_json::Value = serde_json::from_str(lines.last().unwrap()).unwrap();
    assert_eq!(first["type"], "run.started");
    assert_eq!(last["type"], "run.completed");
    assert_eq!(last["exit_code"], 0);
}
```

`fake-claude` is a kata-core bin, but `CARGO_BIN_EXE_fake-claude` is only defined for kata-core's own tests. To reference it from kata-cli, add a build-time passthrough: in `crates/kata-cli/Cargo.toml` add the fake binary as a dev path is not possible across crates. Instead, locate it relative to the kata binary:
```rust
// In the test, derive the fake-claude path from the kata binary's directory.
fn fake_claude() -> std::path::PathBuf {
    let kata = std::path::PathBuf::from(env!("CARGO_BIN_EXE_kata"));
    let dir = kata.parent().unwrap();
    let name = if cfg!(windows) { "fake-claude.exe" } else { "fake-claude" };
    dir.join(name)
}
```
Replace `let fake = env!("CARGO_BIN_EXE_fake-claude");` with `let fake = fake_claude();` and `.env("KATA_CLAUDE_BIN", &fake)`. Both `kata` and `fake-claude` build into the same `target/debug` directory, so this resolves. Ensure a build has produced `fake-claude` (the workspace `cargo test` builds all bins).

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo build` then `cargo test -p kata-cli --test cli_it run_streams`
Expected: FAIL (`cmd_run` returns 70 "not implemented").

- [ ] **Step 3: Implement `cmd_run` in `crates/kata-cli/src/main.rs`**

Add imports at the top:
```rust
use std::sync::atomic::Ordering;
```
Replace the stub `cmd_run`:
```rust
fn cmd_run(path: &std::path::Path) -> ExitCode {
    let spec = match kata_core::spec::load(path) {
        Ok(s) => s,
        Err(e) => { eprintln!("error: {e}"); return ExitCode::from(2); }
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let roots = kata_core::catalog::DiscoveryRoots::defaults(&cwd);
    let catalog = kata_core::catalog::discover(&roots);

    let cancel = kata_core::run::CancelToken::new();
    let flag = cancel.flag();
    // Best-effort Ctrl-C -> cancel. Ignore error if a handler is already set.
    let _ = ctrlc::set_handler(move || flag.store(true, Ordering::SeqCst));

    let emit = |event: kata_core::event::KataEvent| {
        // One JSON object per line on stdout.
        if let Ok(line) = serde_json::to_string(&event) {
            println!("{line}");
        }
    };

    match kata_core::run::run(&spec, &catalog, &cancel, emit) {
        Ok(outcome) => {
            // Map the run's exit code into the process exit code.
            match u8::try_from(outcome.exit_code) {
                Ok(c) => ExitCode::from(c),
                Err(_) => ExitCode::FAILURE,
            }
        }
        Err(e) => { eprintln!("error: {e}"); ExitCode::from(2) }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p kata-cli --test cli_it run_streams`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `cargo test`
Expected: all tests PASS across both crates.

- [ ] **Step 6: Commit**

```bash
git add crates/kata-cli/src/main.rs crates/kata-cli/tests/cli_it.rs
git commit -m "feat(cli): kata run streams JSON-line events with Ctrl-C cancel"
```

---

## Task 10: Opt-in real-claude smoke test (M4)

**Files:**
- Create: `crates/kata-cli/tests/smoke_real_claude.rs`

- [ ] **Step 1: Write the gated smoke test in `crates/kata-cli/tests/smoke_real_claude.rs`**

```rust
//! Opt-in: only runs when KATA_SMOKE_REAL=1 and a real `claude` is on PATH.
//! Catches drift between our flag set and the actual CLI. Costs tokens.
use std::process::Command;

#[test]
fn real_claude_trivial_run_completes() {
    if std::env::var("KATA_SMOKE_REAL").as_deref() != Ok("1") {
        eprintln!("skipping real-claude smoke test (set KATA_SMOKE_REAL=1 to enable)");
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let spec_path = work.path().join("smoke.kata.toml");
    std::fs::write(&spec_path, format!(
        "schema = 1\nname = \"smoke\"\ntask = \"Reply with the single word: pong\"\nworkdir = \"{}\"\n\n[leash]\nmax_turns = 1\n",
        work.path().to_string_lossy().replace('\\', "/"))).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_kata"))
        .arg("run").arg(&spec_path)
        // KATA_CLAUDE_BIN unset -> uses the real `claude` on PATH.
        .output()
        .unwrap();

    let stdout = String::from_utf8_lossy(&out.stdout);
    let last = stdout.lines().filter(|l| !l.trim().is_empty()).last().unwrap();
    let v: serde_json::Value = serde_json::from_str(last).unwrap();
    assert_eq!(v["type"], "run.completed", "last event should be run.completed; stderr: {}", String::from_utf8_lossy(&out.stderr));
}
```

- [ ] **Step 2: Verify it skips cleanly by default**

Run: `cargo test -p kata-cli --test smoke_real_claude`
Expected: PASS (prints the skip message; does not call claude).

- [ ] **Step 3: (Manual, when `claude` is installed) run it for real**

Run: `KATA_SMOKE_REAL=1 cargo test -p kata-cli --test smoke_real_claude -- --nocapture`
(PowerShell: `$env:KATA_SMOKE_REAL=1; cargo test -p kata-cli --test smoke_real_claude -- --nocapture`)
Expected: PASS. If it fails on an unknown flag, fix the flag in `command.rs` (Task 5) and the plugin-dir layout in `assemble.rs` (Task 6), then re-run.

- [ ] **Step 4: Commit**

```bash
git add crates/kata-cli/tests/smoke_real_claude.rs
git commit -m "test(cli): opt-in real-claude smoke test guards against flag drift"
```

---

## Self-review

**Spec coverage:**
- Run-spec contract (all fields, TOML+JSON) → Task 1. ✓
- `kata validate` → Task 2. ✓
- Catalog discovery (skills + plugins, provides, mcp_servers, source) → Task 3; `kata catalog` → Task 4. ✓
- Curated kit / disposable plugin-dir assembly + system-prompt file + RAII cleanup → Task 6. ✓
- Command construction pinning `--bare`/`-p`/`--plugin-dir`/`--append-system-prompt-file`/`--system-prompt`/`--model`/`--max-turns`/`stream-json`/bypass + env passthrough by name → Task 5. ✓
- Event protocol (all `KataEvent` variants) + stream-json normalization → Task 7. ✓
- Run orchestration: spawn, leash (`max_turns` via flag, `timeout_secs` via engine kill), cancel, cleanup, exit codes → Task 8; `kata run` + Ctrl-C → Task 9. ✓
- Testing strategy: fake-claude harness (Task 8), pure-function/command tests (Tasks 1,5,7), opt-in real smoke (Task 10). ✓
- Out of M0–M4 by design and NOT in this plan: worktree creation (M8 — `run.rs` currently keeps cwd = workdir and only labels isolation), `kata bundle` (M7), GUI (M5–M6). Tracked in the spec's milestones.

**Placeholder scan:** No TBD/TODO/"handle errors appropriately"; every code step shows complete code; every command shows expected output.

**Type consistency:** `RunSpec`, `Identity`, `IdentityMode`, `PluginConfig`, `Model`, `Leash`, `Isolation` (Task 1) are reused verbatim in Tasks 5/6/8. `Assembled` defined in Task 5 (with `for_test`) and extended in Task 6 (`assemble` returns it with `_temp: Some`). `CatalogEntry`/`EntryKind` (Task 3) consumed in Task 6. `KataEvent`/`ResultPayload`/`Parsed`/`pump`/`parse_stream_line` (Task 7) consumed in Task 8. `CancelToken`/`RunError`/`RunOutcome`/`run` (Task 8) consumed in Task 9. Method/field names match across tasks.

**Known verification points (flagged inline, isolated to one edit each):** exact `claude` flag spellings and the whole-plugin `--plugin-dir` layout — both confirmed by Task 10's real smoke test, each fixable in a single location (`command.rs` / `assemble.rs`).
