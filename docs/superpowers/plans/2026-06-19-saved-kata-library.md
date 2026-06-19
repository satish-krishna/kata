# Saved-kata Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist saved katas in a managed `~/.kata/katas` library, make the Library's Saved-katas rail live (joined with run-history), wire the four actions (New / Re-run with per-run task override / Open-in-compose / Export bundle), and add a copy-in context-preset library.

**Architecture:** Two `kata-core` CRUD modules (`katas`, `presets`) over the existing TOML `spec::save/load`, exposed via six Tauri commands. The frontend gains gated `api.ts` wrappers, a pure join/helper module (`lib/katas.ts`), a one-shot cross-route handoff (`lib/launch.ts`), a `TaskEditor` dialog, the live Library rail, compose Save→library + Export wiring, and a presets menu in the Task section.

**Tech Stack:** Rust (Cargo workspace: `kata-core`), ts-rs, SvelteKit/TypeScript (Svelte 5) + Tauri v2.

## Global Constraints

- Built on `main` after PR #14 + #15 merged (branch `feat/saved-kata-library`, already off merged main).
- TDD: failing test first, watch it fail, implement.
- `cargo clippy --all-targets -- -D warnings` clean; `cargo build --locked` green.
- Do not hand-edit `app/src/bindings/`; regenerate with `cargo test -p kata-core --features ts export_bindings`.
- kata-core tests that set `KATA_HOME` (process-global) are `#[serial]` (`use serial_test::serial;`).
- Persistence reuses `spec::save`/`spec::load` (TOML) and `fsutil::slug` (the traversal-safe path-segment sanitizer). No `RunSpec`/`KataEvent` contract changes. Context presets are **copy-in** (text inserted into `spec.context`).
- Frontend: style only against existing CSS custom properties / `.k-*` primitives; no hard-coded hex; no new colours. `api.ts` calls gate on `inTauri()` with a browser fixture/fallback.
- Out of scope: deleting katas; reference-style presets; a CLI surface for katas/presets.
- Frequent commits, one per task.

---

### Task 1: `fsutil` dirs + `kata-core::katas` module

**Files:**
- Modify: `crates/kata-core/src/fsutil.rs` (add `katas_dir`, `presets_dir`)
- Create: `crates/kata-core/src/katas.rs`
- Modify: `crates/kata-core/src/lib.rs` (`pub mod katas;`)
- Test: in-module `#[cfg(test)]`

**Interfaces:**
- Consumes: `spec::{RunSpec, save, load, validate}`, `fsutil::{katas_dir, slug}`.
- Produces: `fsutil::katas_dir() -> Option<PathBuf>`, `fsutil::presets_dir() -> Option<PathBuf>`; `kata_core::katas::{KataError, save_kata, list_katas, load_kata}`. Task 3 (Tauri) and Task 2 (`presets_dir`) consume these.

- [ ] **Step 1: Add the dirs to `fsutil`**

After `runs_dir`:

```rust
/// `<kata-home>/katas`, the saved-kata library. `None` when no home.
pub fn katas_dir() -> Option<PathBuf> { kata_home().map(|h| h.join("katas")) }

/// `<kata-home>/presets`, the context-preset library. `None` when no home.
pub fn presets_dir() -> Option<PathBuf> { kata_home().map(|h| h.join("presets")) }
```

- [ ] **Step 2: Write the failing `katas` tests**

Create `crates/kata-core/src/katas.rs` with the test module (and `pub mod katas;` in `lib.rs` so it compiles):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::RunSpec;
    use serial_test::serial;

    fn kata(name: &str) -> RunSpec {
        RunSpec { schema: 1, name: name.into(), task: "do it".into(), workdir: "/w".into(), ..Default::default() }
    }
    fn with_home() -> tempfile::TempDir {
        let h = tempfile::tempdir().unwrap();
        std::env::set_var("KATA_HOME", h.path());
        h
    }

    #[test]
    #[serial]
    fn save_list_load_round_trip() {
        let _h = with_home();
        save_kata(&kata("triage-flaky-test")).unwrap();
        save_kata(&kata("release-notes")).unwrap();
        let all = list_katas();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "release-notes"); // sorted by name
        assert_eq!(all[1].name, "triage-flaky-test");
        let one = load_kata("triage-flaky-test").unwrap();
        assert_eq!(one.task, "do it");
    }

    #[test]
    #[serial]
    fn load_unknown_is_not_found() {
        let _h = with_home();
        assert!(matches!(load_kata("nope"), Err(KataError::NotFound)));
    }

    #[test]
    #[serial]
    fn save_rejects_nameless_and_invalid() {
        let _h = with_home();
        // A name with no alphanumerics has no usable slug.
        assert!(matches!(save_kata(&kata("!!!")), Err(KataError::InvalidName)));
        // An invalid spec (empty task) is refused.
        let mut bad = kata("ok-name"); bad.task = "".into();
        assert!(matches!(save_kata(&bad), Err(KataError::Invalid(_))));
    }

    #[test]
    #[serial]
    fn list_skips_malformed() {
        let _h = with_home();
        save_kata(&kata("good")).unwrap();
        let dir = crate::fsutil::katas_dir().unwrap();
        std::fs::write(dir.join("broken.toml"), "this = is = not = toml").unwrap();
        let all = list_katas();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "good");
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p kata-core katas:: 2>&1 | tail -20`
Expected: compile error — `save_kata`/`list_katas`/`load_kata`/`KataError` not defined.

- [ ] **Step 4: Implement the module**

Above the test module in `katas.rs`:

```rust
//! The saved-kata library: named run-specs persisted under `~/.kata/katas`.
use crate::fsutil;
use crate::spec::{self, validate, RunSpec};
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum KataError {
    #[error("kata not found")]
    NotFound,
    #[error("kata name has no usable slug")]
    InvalidName,
    #[error("invalid spec: {0:?}")]
    Invalid(Vec<String>),
    #[error("{0}")]
    Io(String),
}

fn has_slug(name: &str) -> bool {
    name.chars().any(|c| c.is_ascii_alphanumeric())
}

/// Persist a spec to the library as `<slug(name)>.toml` (overwrites a
/// same-named kata). Validates first; refuses a name with no usable slug.
pub fn save_kata(spec: &RunSpec) -> Result<PathBuf, KataError> {
    validate(spec).map_err(KataError::Invalid)?;
    if !has_slug(&spec.name) { return Err(KataError::InvalidName); }
    let dir = fsutil::katas_dir().ok_or_else(|| KataError::Io("no home directory for ~/.kata".into()))?;
    std::fs::create_dir_all(&dir).map_err(|e| KataError::Io(e.to_string()))?;
    let path = dir.join(format!("{}.toml", fsutil::slug(&spec.name)));
    spec::save(&path, spec).map_err(|e| KataError::Io(e.to_string()))?;
    Ok(path)
}

/// All saved katas, sorted by name. Best-effort: a malformed/unreadable
/// `*.toml` is skipped. Empty when there is no home.
pub fn list_katas() -> Vec<RunSpec> {
    let Some(dir) = fsutil::katas_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<RunSpec> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("toml"))
        .filter_map(|p| spec::load(&p).ok())
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Load one kata by name (slugged). `NotFound` if absent.
pub fn load_kata(name: &str) -> Result<RunSpec, KataError> {
    if !has_slug(name) { return Err(KataError::InvalidName); }
    let dir = fsutil::katas_dir().ok_or(KataError::NotFound)?;
    let path = dir.join(format!("{}.toml", fsutil::slug(name)));
    if !path.exists() { return Err(KataError::NotFound); }
    spec::load(&path).map_err(|e| KataError::Io(e.to_string()))
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p kata-core katas:: 2>&1 | tail -20`
Expected: PASS (4 tests).

- [ ] **Step 6: Clippy + commit**

```bash
cargo clippy -p kata-core --all-targets -- -D warnings
git add crates/kata-core/src/fsutil.rs crates/kata-core/src/katas.rs crates/kata-core/src/lib.rs
git commit -m "feat(katas): managed ~/.kata/katas library (save/list/load) + fsutil dirs"
```

---

### Task 2: `kata-core::presets` module + `Preset` binding

**Files:**
- Create: `crates/kata-core/src/presets.rs`
- Modify: `crates/kata-core/src/lib.rs` (`pub mod presets;`)
- Test: in-module `#[cfg(test)]`
- Regenerate: `app/src/bindings/Preset.ts`

**Interfaces:**
- Consumes: `fsutil::{presets_dir, slug}` (Task 1).
- Produces: `kata_core::presets::{Preset, PresetError, list_presets, save_preset}`; ts-rs `Preset { name: string, body: string }`. Task 3 + frontend consume these.

- [ ] **Step 1: Write the failing tests**

Create `crates/kata-core/src/presets.rs` test module (and register `pub mod presets;`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn with_home() -> tempfile::TempDir {
        let h = tempfile::tempdir().unwrap();
        std::env::set_var("KATA_HOME", h.path());
        h
    }

    #[test]
    #[serial]
    fn save_then_list_round_trip() {
        let _h = with_home();
        save_preset(&Preset { name: "dotnet repro".into(), body: "Use dotnet test --filter.".into() }).unwrap();
        save_preset(&Preset { name: "azure ctx".into(), body: "Target the staging slot.".into() }).unwrap();
        let all = list_presets();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "azure ctx"); // sorted by name
        assert_eq!(all[1].body, "Use dotnet test --filter.");
    }

    #[test]
    #[serial]
    fn rejects_nameless_preset() {
        let _h = with_home();
        assert!(matches!(save_preset(&Preset { name: "  ".into(), body: "x".into() }), Err(PresetError::InvalidName)));
    }

    #[test]
    #[serial]
    fn list_skips_malformed() {
        let _h = with_home();
        save_preset(&Preset { name: "good".into(), body: "b".into() }).unwrap();
        let dir = crate::fsutil::presets_dir().unwrap();
        std::fs::write(dir.join("broken.toml"), "= = =").unwrap();
        assert_eq!(list_presets().len(), 1);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kata-core presets:: 2>&1 | tail -20`
Expected: compile error — `Preset`/`save_preset`/`list_presets`/`PresetError` not defined.

- [ ] **Step 3: Implement the module**

```rust
//! The context-preset library: named reusable text blocks under `~/.kata/presets`.
use crate::fsutil;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub body: String,
}

#[derive(Debug, thiserror::Error)]
pub enum PresetError {
    #[error("preset name has no usable slug")]
    InvalidName,
    #[error("serializing preset: {0}")]
    Ser(String),
    #[error("{0}")]
    Io(String),
}

/// All presets, sorted by name. Best-effort (malformed files skipped).
pub fn list_presets() -> Vec<Preset> {
    let Some(dir) = fsutil::presets_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<Preset> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("toml"))
        .filter_map(|p| std::fs::read_to_string(&p).ok().and_then(|t| toml::from_str::<Preset>(&t).ok()))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Persist a preset as `<slug(name)>.toml` (overwrites same-named).
pub fn save_preset(preset: &Preset) -> Result<PathBuf, PresetError> {
    if !preset.name.chars().any(|c| c.is_ascii_alphanumeric()) { return Err(PresetError::InvalidName); }
    let dir = fsutil::presets_dir().ok_or_else(|| PresetError::Io("no home directory for ~/.kata".into()))?;
    std::fs::create_dir_all(&dir).map_err(|e| PresetError::Io(e.to_string()))?;
    let path = dir.join(format!("{}.toml", fsutil::slug(&preset.name)));
    let text = toml::to_string(preset).map_err(|e| PresetError::Ser(e.to_string()))?;
    std::fs::write(&path, text).map_err(|e| PresetError::Io(e.to_string()))?;
    Ok(path)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p kata-core presets:: 2>&1 | tail -20`
Expected: PASS (3 tests).

- [ ] **Step 5: Regenerate the binding + verify**

Run: `cargo test -p kata-core --features ts export_bindings`
Confirm `app/src/bindings/Preset.ts` reads `export type Preset = { name: string, body: string, };`.

- [ ] **Step 6: Clippy + commit**

```bash
cargo clippy -p kata-core --all-targets -- -D warnings
git add crates/kata-core/src/presets.rs crates/kata-core/src/lib.rs app/src/bindings/Preset.ts
git commit -m "feat(presets): ~/.kata/presets library (list/save) + Preset binding"
```

---

### Task 3: Tauri commands

**Files:**
- Modify: `app/src-tauri/src/lib.rs` (six `#[tauri::command]` fns + registration)

**Interfaces:**
- Consumes: `kata_core::katas::{save_kata, list_katas, load_kata}`, `kata_core::presets::{Preset, list_presets, save_preset}`, `kata_core::{bundle, catalog}`, `kata_core::spec::RunSpec`.
- Produces: Tauri commands `save_kata`, `list_katas`, `load_kata`, `list_presets`, `save_preset`, `export_bundle`. Task 4's `api.ts` invokes them.

- [ ] **Step 1: Add the commands**

Next to the other in-process one-liners:

```rust
#[tauri::command]
fn save_kata(spec: kata_core::spec::RunSpec) -> Result<(), String> {
    kata_core::katas::save_kata(&spec).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_katas() -> Result<Vec<kata_core::spec::RunSpec>, String> {
    Ok(kata_core::katas::list_katas())
}

#[tauri::command]
fn load_kata(name: String) -> Result<kata_core::spec::RunSpec, String> {
    kata_core::katas::load_kata(&name).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_presets() -> Result<Vec<kata_core::presets::Preset>, String> {
    Ok(kata_core::presets::list_presets())
}

#[tauri::command]
fn save_preset(name: String, body: String) -> Result<(), String> {
    kata_core::presets::save_preset(&kata_core::presets::Preset { name, body })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn export_bundle(spec: kata_core::spec::RunSpec, out: String) -> Result<(), String> {
    let workdir = std::path::PathBuf::from(&spec.workdir);
    let roots = kata_core::catalog::DiscoveryRoots::defaults(&workdir);
    let catalog = kata_core::catalog::discover(&roots);
    kata_core::bundle::bundle(&spec, &catalog, std::path::Path::new(&out), false).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register them**

Append to the `tauri::generate_handler![ ... ]` list:

```rust
            save_kata,
            list_katas,
            load_kata,
            list_presets,
            save_preset,
            export_bundle
```

(add a trailing comma after the previous last entry, `load_run,`).

- [ ] **Step 3: Verify it compiles + clippy**

Run: `cargo build -p kata-app --locked 2>&1 | tail -5` → builds clean.
Run: `cargo clippy -p kata-app --all-targets -- -D warnings 2>&1 | tail -3` → clean.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/lib.rs
git commit -m "feat(app): kata library + presets + export_bundle Tauri commands"
```

---

### Task 4: Frontend data layer — `api.ts` wrappers, fixtures, join helper

**Files:**
- Modify: `app/src/lib/api.ts` (six gated wrappers)
- Modify: `app/src/lib/library.ts` (add `katasFixture: RunSpec[]`, `presetsFixture: Preset[]`; keep existing exports)
- Create: `app/src/lib/katas.ts` (pure helpers: `kataViews`, `withTask`, `appendContext`)
- Test: `app/src/lib/katas.test.ts`

**Interfaces:**
- Consumes: `inTauri()`; `RunSpec`, `Preset` bindings; `RunRecord`/`statusForExit`/`RunState` from `events`.
- Produces: `api.{listKatas, loadKata, saveKata, listPresets, savePreset, exportBundle}`; `katas.{KataView, kataViews(katas, runs), withTask(spec, task), appendContext(current, body)}`. Tasks 5–8 consume these.

- [ ] **Step 1: Write the failing helper tests**

Create `app/src/lib/katas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { kataViews, withTask, appendContext } from "./katas";
import type { RunSpec } from "../bindings/RunSpec";
import type { RunRecord } from "./events";

const spec = (name: string, over: Partial<RunSpec> = {}): RunSpec => ({
  schema: 1, name, task: "t", workdir: "/w",
  identity: { mode: "append" }, skills: [], plugins: {}, model: {},
  leash: { max_turns: 12, isolation: "none" }, auth: { bare: true }, interactive: { enabled: false },
  ...over,
} as RunSpec);

const rec = (kata: string, exit: number | null): RunRecord => ({
  id: `${kata}-x`, kata, started_at: 1, isolation: "none", exit, turns: null, cost_usd: null, duration_ms: null, result: null,
});

describe("kataViews", () => {
  it("joins katas with run aggregates", () => {
    const katas = [spec("a", { skills: ["s1"], plugins: { p1: {} } as RunSpec["plugins"], description: "desc-a", leash: { max_turns: 12, isolation: "worktree" } }), spec("b")];
    // runs newest-first (as list_runs returns)
    const runs = [rec("a", 0), rec("a", 125), rec("b", 1)];
    const views = kataViews(katas, runs);
    const a = views.find((v) => v.name === "a")!;
    expect(a.kit).toBe(2);          // 1 skill + 1 plugin
    expect(a.isolation).toBe("worktree");
    expect(a.description).toBe("desc-a");
    expect(a.runs).toBe(2);
    expect(a.lastState).toBe("success"); // newest a-run exit 0
    expect(a.lastExit).toBe(0);
    const b = views.find((v) => v.name === "b")!;
    expect(b.runs).toBe(1);
    expect(b.lastState).toBe("error");
  });
  it("a kata with no runs has null last outcome", () => {
    const views = kataViews([spec("lonely")], []);
    expect(views[0].runs).toBe(0);
    expect(views[0].lastState).toBeNull();
    expect(views[0].lastExit).toBeNull();
  });
});

describe("withTask", () => {
  it("returns a copy with the task overridden", () => {
    const s = spec("a");
    const out = withTask(s, "new task");
    expect(out.task).toBe("new task");
    expect(s.task).toBe("t"); // original untouched
  });
});

describe("appendContext", () => {
  it("appends with a blank-line separator, or sets when empty", () => {
    expect(appendContext("", "body")).toBe("body");
    expect(appendContext(null, "body")).toBe("body");
    expect(appendContext("existing", "body")).toBe("existing\n\nbody");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix app test -- katas.test 2>&1 | tail -20`
Expected: FAIL — `./katas` module / exports not found.

- [ ] **Step 3: Implement `lib/katas.ts`**

```ts
import type { RunSpec } from "../bindings/RunSpec";
import type { RunRecord, RunState } from "./events";
import { statusForExit } from "./events";

/** A Saved-katas rail row: the persisted spec's static fields + run aggregates. */
export type KataView = {
  name: string;
  description: string;
  isolation: string;
  kit: number;
  runs: number;
  lastState: RunState | null;
  lastExit: number | null;
};

/** Join the kata library with run history (runs newest-first per `list_runs`). */
export function kataViews(katas: RunSpec[], runs: RunRecord[]): KataView[] {
  return katas.map((k) => {
    const mine = runs.filter((r) => r.kata === k.name);
    const latest = mine[0] ?? null;
    return {
      name: k.name,
      description: k.description ?? "",
      isolation: k.leash.isolation,
      kit: k.skills.length + Object.keys(k.plugins).length,
      runs: mine.length,
      lastState: latest ? statusForExit(latest.exit ?? null) : null,
      lastExit: latest ? latest.exit ?? null : null,
    };
  });
}

/** A copy of `spec` with `task` overridden (the reusable-agent per-run param). */
export function withTask(spec: RunSpec, task: string): RunSpec {
  return { ...structuredClone(spec), task };
}

/** Append a preset body to existing context (blank-line separated; set if empty). */
export function appendContext(current: string | null | undefined, body: string): string {
  return current && current.trim() !== "" ? `${current}\n\n${body}` : body;
}
```

- [ ] **Step 4: Add fixtures to `library.ts`**

Add (keep all existing exports — `savedKatas` stays until Task 7):

```ts
import type { RunSpec } from "../bindings/RunSpec";
import type { Preset } from "../bindings/Preset";

const fixtureSpec = (name: string, description: string, isolation: "none" | "worktree", skills: string[], plugins: string[]): RunSpec => ({
  schema: 1, name, description, task: "Do the kata.", workdir: "/repo",
  identity: { mode: "append" }, skills, plugins: Object.fromEntries(plugins.map((p) => [p, {}])) as RunSpec["plugins"],
  model: {}, leash: { max_turns: 12, isolation }, auth: { bare: true }, interactive: { enabled: false },
} as RunSpec);

export const katasFixture: RunSpec[] = [
  fixtureSpec("triage-flaky-test", "Reproduce & isolate AuthTests.LoginExpiry", "worktree", ["triage-flaky-test"], ["github-tools"]),
  fixtureSpec("release-notes", "Draft notes from the merged PRs since last tag", "none", ["release-notes"], ["github-tools"]),
  fixtureSpec("audit-deps", "List risky dependencies & propose pins", "none", ["audit", "deps"], ["github-tools"]),
];

export const presetsFixture: Preset[] = [
  { name: "dotnet repro", body: "Use `dotnet test --filter` to run a single test in a tight loop." },
  { name: "staging slot", body: "Target the staging deployment slot, never production." },
];
```

- [ ] **Step 5: Add the gated wrappers to `api.ts`**

```ts
import type { Preset } from "../bindings/Preset";
import { katasFixture, presetsFixture } from "$lib/library";

export const listKatas = (): Promise<RunSpec[]> =>
  inTauri() ? invoke<RunSpec[]>("list_katas") : Promise.resolve(katasFixture);

export const loadKata = (name: string): Promise<RunSpec> =>
  inTauri() ? invoke<RunSpec>("load_kata", { name }) : Promise.resolve(katasFixture.find((k) => k.name === name) ?? katasFixture[0]);

export const saveKata = (spec: RunSpec): Promise<void> =>
  inTauri() ? invoke<void>("save_kata", { spec }) : Promise.resolve();

export const listPresets = (): Promise<Preset[]> =>
  inTauri() ? invoke<Preset[]>("list_presets") : Promise.resolve(presetsFixture);

export const savePreset = (name: string, body: string): Promise<void> =>
  inTauri() ? invoke<void>("save_preset", { name, body }) : Promise.resolve();

export const exportBundle = (spec: RunSpec, out: string): Promise<void> =>
  inTauri() ? invoke<void>("export_bundle", { spec, out }) : Promise.reject(new Error(NO_BACKEND));
```

(`invoke`, `inTauri`, `RunSpec`, `NO_BACKEND` are already in `api.ts`.)

- [ ] **Step 6: Run tests + type-check**

Run: `npm --prefix app test 2>&1 | tail -8` → PASS (incl. katas.test).
Run: `npm --prefix app run check 2>&1 | tail -6` → no new errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/library.ts app/src/lib/katas.ts app/src/lib/katas.test.ts
git commit -m "feat(web): kata/preset api wrappers, fixtures, and pure join/helper module"
```

---

### Task 5: Handoff store + `TaskEditor` dialog

**Files:**
- Create: `app/src/lib/launch.ts` (one-shot cross-route handoff)
- Create: `app/src/lib/components/TaskEditor.svelte` (the Re-run task dialog)
- Test: `app/src/lib/launch.test.ts`

**Interfaces:**
- Consumes: `RunSpec` binding.
- Produces: `launch.{setLaunch(payload), takeLaunch()}` where payload is `{ spec: RunSpec; autorun: boolean }`; `TaskEditor.svelte` with props `{ task: string; onRun: (task: string) => void; onCancel: () => void }`. Task 6 consumes `takeLaunch`; Task 7 consumes `setLaunch` + `TaskEditor`.

- [ ] **Step 1: Write the failing handoff test**

Create `app/src/lib/launch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { setLaunch, takeLaunch } from "./launch";
import type { RunSpec } from "../bindings/RunSpec";

const s = { schema: 1, name: "k", task: "t", workdir: "/w" } as RunSpec;

describe("launch handoff", () => {
  it("take returns the set payload once, then null", () => {
    expect(takeLaunch()).toBeNull();
    setLaunch({ spec: s, autorun: true });
    const got = takeLaunch();
    expect(got?.spec.name).toBe("k");
    expect(got?.autorun).toBe(true);
    expect(takeLaunch()).toBeNull(); // consumed
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix app test -- launch.test 2>&1 | tail -15`
Expected: FAIL — `./launch` not found.

- [ ] **Step 3: Implement `lib/launch.ts`**

```ts
import type { RunSpec } from "../bindings/RunSpec";

/** One-shot handoff from the Library route to Compose. Plain module state (not
 *  reactive): the value is set just before navigation and consumed once on the
 *  compose route's mount. */
export type LaunchPayload = { spec: RunSpec; autorun: boolean };

let pending: LaunchPayload | null = null;

export function setLaunch(payload: LaunchPayload): void {
  pending = payload;
}

/** Return the pending launch (if any) and clear it. */
export function takeLaunch(): LaunchPayload | null {
  const v = pending;
  pending = null;
  return v;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix app test -- launch.test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Implement `TaskEditor.svelte`**

Create `app/src/lib/components/TaskEditor.svelte` (floating dialog; reuses tokens + `.k-*` classes; one azure primary action):

```svelte
<script lang="ts">
  import Play from "@lucide/svelte/icons/play";
  let { task, onRun, onCancel }: { task: string; onRun: (task: string) => void; onCancel: () => void } = $props();
  let draft = $state(task);
  function key(e: KeyboardEvent) {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onRun(draft);
  }
</script>

<div class="k-dialog__scrim" role="presentation" onclick={onCancel}></div>
<div class="k-dialog" role="dialog" aria-modal="true" aria-label="Re-run with a new task" onkeydown={key}>
  <div class="k-dialog__head">Re-run · new task</div>
  <textarea class="k-textarea" rows="4" bind:value={draft} aria-label="Task"></textarea>
  <div class="k-dialog__actions">
    <button class="k-btn k-btn--ghost k-btn--sm" onclick={onCancel}>Cancel</button>
    <button class="k-btn k-btn--primary k-btn--sm" onclick={() => onRun(draft)}><Play size={13} />Run</button>
  </div>
</div>
```

If `.k-dialog*` classes do not exist in `components.css`, add minimal rules there using existing tokens only (surface-card/-inset, border, radius, shadow tokens) — a centered fixed card over a scrim. Do not hard-code colours; reference `--surface-*`, `--border-*`, `--shadow-*` custom properties already defined.

- [ ] **Step 6: Type-check + commit**

Run: `npm --prefix app run check 2>&1 | tail -6` → no new errors.

```bash
git add app/src/lib/launch.ts app/src/lib/launch.test.ts app/src/lib/components/TaskEditor.svelte
# plus app/src/styles/components/components.css if dialog rules were added
git commit -m "feat(web): one-shot launch handoff store + TaskEditor dialog"
```

---

### Task 6: Compose route — consume launch, Save→library, wire Export

**Files:**
- Modify: `app/src/routes/+page.svelte`

**Interfaces:**
- Consumes: `api.{saveKata, exportBundle, pickDirectory}` (Task 4 + existing), `launch.takeLaunch` (Task 5), `draftFrom`/`normalize` (existing), `startRun` (existing).

- [ ] **Step 1: Consume the launch handoff on mount**

In the `onMount` of `app/src/routes/+page.svelte`, before/after the existing demo handling, add (import `takeLaunch` from `$lib/launch`):

```ts
    const handoff = takeLaunch();
    if (handoff) {
      spec = draftFrom(handoff.spec);
      saved = $state.snapshot(spec) as RunSpec;
      currentPath = null;
      if (handoff.autorun && errors.length === 0) {
        startRun(normalize($state.snapshot(spec) as RunSpec));
      }
    }
```

(If `errors` is computed by an effect that hasn't run yet at mount, gate on `validateLocal`/the existing validation path instead; the existing route already computes `errors` — call the same validation it uses before `startRun`, mirroring `onRun`.)

- [ ] **Step 2: Save → library by name**

Replace `onSave` so it persists to the library (no file dialog):

```ts
  async function onSave() {
    try {
      await api.saveKata(normalize($state.snapshot(spec) as RunSpec));
      saved = $state.snapshot(spec) as RunSpec;
    } catch (e) {
      alert(`Failed to save kata: ${e}`);
    }
  }
```

(Leave `onOpen` — the file-dialog import path — unchanged. `writeTo`/`pickSaveSpec` are no longer used by `onSave`; remove `writeTo` if nothing else references it.)

- [ ] **Step 3: Wire Export → bundle**

Add an `onExport` handler and pass it to the `<Toolbar>`:

```ts
  async function onExport() {
    const dir = await api.pickDirectory();
    if (!dir) return;
    try {
      await api.exportBundle(normalize($state.snapshot(spec) as RunSpec), dir);
    } catch (e) {
      alert(`Failed to export bundle: ${e}`);
    }
  }
```

In the `<Toolbar ... />` usage, add `{onExport}` to the props.

- [ ] **Step 4: Type-check**

Run: `npm --prefix app run check 2>&1 | tail -6` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/+page.svelte
git commit -m "feat(web): compose consumes launch handoff; Save→library; Export→bundle"
```

---

### Task 7: Library route — live Saved-katas rail + wire the actions

**Files:**
- Modify: `app/src/routes/library/+page.svelte`
- Modify: `app/src/lib/library.ts` (remove the now-unused `savedKatas` + `SavedKata`)

**Interfaces:**
- Consumes: `api.{listKatas, loadKata, exportBundle, pickDirectory}`, `kataViews` (Task 4), `setLaunch` (Task 5), `TaskEditor` (Task 5), `goto` from `$app/navigation`.

- [ ] **Step 1: Load katas + build the live rail view**

In the route `<script>`: import `listKatas`/`loadKata`/`exportBundle`/`pickDirectory` from `$lib/api`, `kataViews` (+ `type KataView`) from `$lib/katas`, `setLaunch` from `$lib/launch`, `withTask` from `$lib/katas`, `TaskEditor` from `$lib/components/TaskEditor.svelte`, and `goto` from `$app/navigation`. Replace the `savedKatas` import. Add state + load in `onMount`:

```ts
  let katas = $state<RunSpec[]>([]);
  let editing = $state<{ kata: RunSpec } | null>(null);
  // ...in onMount, alongside the existing listRuns():
  katas = await listKatas();
  // derived rail rows:
  let kataRows = $derived(kataViews(katas, runs));
  const hasKata = (name: string) => katas.some((k) => k.name === name);
```

(import `RunSpec` from `../bindings/RunSpec`.)

- [ ] **Step 2: Render the Saved-katas rail from `kataRows`**

Replace the `{#each savedKatas as k (k.name)}` block to iterate `kataRows`, mapping fields to the new `KataView` shape:

```svelte
        <div class="wb-rail__section">
          <div class="wb-rail__label">Saved katas<span class="wb-rail__count">{kataRows.length}</span></div>
          {#each kataRows as k (k.name)}
            <div class="wb-kata" class:wb-kata--active={selKata === k.name} role="button" tabindex="0"
              onclick={() => selectKata(k.name)} onkeydown={onKey(() => selectKata(k.name))}>
              <div class="wb-kata__top">
                <span class="wb-kata__name">{k.name}</span>
                <span class="wb-kata__dot dot-{k.lastState ?? 'idle'}"></span>
              </div>
              <div class="wb-kata__desc">{k.description}</div>
              <div class="wb-kata__meta">
                {#if k.isolation === "worktree"}<span><GitBranch />worktree</span>{/if}
                <span><Package />{k.kit} kit</span>
                <span><Hash />{k.runs} runs</span>
              </div>
            </div>
          {/each}
        </div>
```

(`dot-idle` must exist in the andon dot styles; if not, use `dot-{k.lastState ?? 'success'}` only when non-null and render a neutral class otherwise — check `colors.css`/`components.css` for an existing idle/neutral dot and use it.)

- [ ] **Step 3: Wire the three run-detail actions**

Replace the inert action row. Each button disables when the selected run's kata isn't in the library:

```svelte
          <div class="wb-detail__actions">
            <button class="k-btn k-btn--primary k-btn--sm" disabled={!run || !hasKata(run.kata)} onclick={onReRun}><Play size={13} />Re-run</button>
            <button class="k-btn k-btn--secondary k-btn--sm" disabled={!run || !hasKata(run.kata)} onclick={onOpenInCompose}><FolderOpen size={14} />Open in compose</button>
            <button class="k-btn k-btn--ghost k-btn--sm" disabled={!run || !hasKata(run.kata)} onclick={onExportBundle}><Package size={14} />Export bundle</button>
          </div>
```

Handlers:

```ts
  async function onReRun() {
    if (!run) return;
    editing = { kata: await loadKata(run.kata) };
  }
  function confirmReRun(task: string) {
    if (!editing) return;
    setLaunch({ spec: withTask(editing.kata, task), autorun: true });
    editing = null;
    goto("/");
  }
  async function onOpenInCompose() {
    if (!run) return;
    setLaunch({ spec: await loadKata(run.kata), autorun: false });
    goto("/");
  }
  async function onExportBundle() {
    if (!run) return;
    const dir = await pickDirectory();
    if (!dir) return;
    try { await exportBundle(await loadKata(run.kata), dir); }
    catch (e) { alert(`Failed to export bundle: ${e}`); }
  }
```

Render the dialog when editing (after the detail markup, inside the route):

```svelte
{#if editing}
  <TaskEditor task={editing.kata.task} onRun={confirmReRun} onCancel={() => (editing = null)} />
{/if}
```

The **New kata** rail button stays an `<a href="/">` (compose opens blank when there is no pending launch).

- [ ] **Step 4: Remove the dead fixture**

In `library.ts`, delete the `SavedKata` interface and the `savedKatas` array (now unused — the rail derives `KataView`s live; the browser fallback is `katasFixture` via `listKatas`). Keep `history`, `runStreams`, `runDetailFixture`, `katasFixture`, `presetsFixture`. Update the footer count in the route if it referenced `savedKatas.length` → `kataRows.length`.

- [ ] **Step 5: Type-check + test + build**

Run: `npm --prefix app run check 2>&1 | tail -6` → no new errors.
Run: `npm --prefix app test 2>&1 | tail -6` → PASS.
Run: `npm --prefix app run build 2>&1 | tail -4` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/library/+page.svelte app/src/lib/library.ts
git commit -m "feat(web): live Saved-katas rail + wire Re-run/Open/Export actions"
```

---

### Task 8: Context presets in the compose Task section

**Files:**
- Modify: `app/src/lib/components/ComposePane.svelte` (presets menu + save-as-preset in the Task section)
- Modify: `app/src/routes/+page.svelte` (load presets; pass `presets` + `onSavePreset` to ComposePane)

**Interfaces:**
- Consumes: `appendContext` (Task 4), `api.{listPresets, savePreset}` (Task 4), `Preset` binding.

- [ ] **Step 1: Pass presets from the compose route**

In `app/src/routes/+page.svelte`: load presets and define a save handler.

```ts
  import type { Preset } from "../bindings/Preset";
  let presets = $state<Preset[]>([]);
  // in onMount:
  presets = await api.listPresets();
  async function onSavePreset(name: string, body: string) {
    try { await api.savePreset(name, body); presets = await api.listPresets(); }
    catch (e) { alert(`Failed to save preset: ${e}`); }
  }
```

Update the usage: `<ComposePane {spec} {entries} {onPickWorkdir} {presets} {onSavePreset} />`.

- [ ] **Step 2: Extend ComposePane props + presets UI**

In `app/src/lib/components/ComposePane.svelte`, extend the `$props()` destructure/type and add the controls in the Task section under the Context field. Import `appendContext` from `$lib/katas` and `Preset` from `../../bindings/Preset`.

```ts
  let { spec, entries, onPickWorkdir, presets, onSavePreset }:
    { spec: RunSpec; entries: CatalogEntry[]; onPickWorkdir: () => void; presets: Preset[]; onSavePreset: (name: string, body: string) => void } = $props();

  function onPickPreset(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    const p = presets.find((x) => x.name === sel.value);
    if (p) spec.context = appendContext(spec.context, p.body);
    sel.value = ""; // reset to placeholder
  }
  function onSaveAsPreset() {
    const body = (spec.context ?? "").trim();
    if (body === "") return;
    const name = prompt("Preset name?");
    if (name && name.trim() !== "") onSavePreset(name.trim(), spec.context ?? "");
  }
```

In the Context `Field` area (after the context textarea, line ~80):

```svelte
    <div class="wb-presets">
      <select class="k-input" onchange={onPickPreset} aria-label="Insert context preset">
        <option value="">Insert preset…</option>
        {#each presets as p (p.name)}<option value={p.name}>{p.name}</option>{/each}
      </select>
      <button class="k-btn k-btn--ghost k-btn--sm" type="button" disabled={!(spec.context ?? "").trim()} onclick={onSaveAsPreset}>Save as preset</button>
    </div>
```

If `.wb-presets` needs layout (a flex row with a small gap), add a minimal rule in `components.css`/`workbench.css` using spacing tokens only — no colours.

- [ ] **Step 3: Type-check + build**

Run: `npm --prefix app run check 2>&1 | tail -6` → no new errors.
Run: `npm --prefix app run build 2>&1 | tail -4` → succeeds.
(`appendContext` is already unit-tested in Task 4; the menu/save wiring is presentational.)

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/components/ComposePane.svelte app/src/routes/+page.svelte
# plus components.css/workbench.css if a layout rule was added
git commit -m "feat(web): context-preset menu + save-as-preset in the Task section"
```

---

### Final verification (before PR)

- [ ] `cargo test --workspace 2>&1 | tail -15` — all green (incl. katas + presets tests).
- [ ] `cargo clippy --all-targets -- -D warnings` — clean.
- [ ] `cargo build --locked` — green.
- [ ] `cargo test -p kata-core --features ts export_bindings` then `git diff --stat app/src/bindings/` — no drift (Preset.ts committed).
- [ ] `npm --prefix app run check` (no new errors; the 2 pre-existing AskPanel warnings are unrelated) and `npm --prefix app test` — green.
- [ ] `npm --prefix app run build` — succeeds.
- [ ] `git diff --stat main` — only the files named across Tasks 1–8 changed.
- [ ] Invoke superpowers:requesting-code-review, then superpowers:finishing-a-development-branch to open the PR.

## Notes for the implementer

- **Persistence is by name.** `save_kata` overwrites the same-named kata (`<slug>.toml`); that is the intended "save my kata" semantics. `load_kata`/`save_kata` reject names with no alphanumeric (the slug would collapse).
- **Presets are copy-in.** Dropping a preset inserts its text into `spec.context`; nothing references the preset afterward. The resulting spec is plain text and bundle-safe.
- **The launch handoff is one-shot and non-reactive** (`lib/launch.ts`, plain module state): the Library sets it and navigates; Compose consumes it once on mount and clears it. Do not make it `$state` — it is not a reactive UI value.
- **Actions resolve `run.kata`.** The three run-detail actions act on the kata named by the selected run; they are disabled when that kata is not in the library (`hasKata`), since a historical run may reference a kata that was never saved.
- **Scope:** no delete, no reference-style presets, no CLI. Saved-katas browser fallback is `katasFixture`; `savedKatas` is removed in Task 7 once the rail is live.
