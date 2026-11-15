//! The layout of the folder Kata is opened on, and the answers only the single-repo layout has: its apps
//! and their context, and the instructions in the repository's root file. Every answer is the ai-sdlc
//! program's; this module types it and decides nothing.
use crate::ai_sdlc::{Place, Program, ProgramError};
use crate::workspace::InstructionsState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// How a folder holds its system: a master repository beside product repositories, or one repository that
/// is its own master and holds the system's apps in folders.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Layout {
    #[default]
    Workspace,
    SingleRepo,
}

/// How current an app's context file is, as the program's `stale` answer gives it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ContextHealth {
    Current,
    Behind { commits: u32 },
    Missing,
    NoSourceCommit,
    UnknownCommit,
}

/// One app of a single-repo system: its name, its folder in the repository and its context file's health.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct AppHealth {
    pub name: String,
    pub folder: String,
    pub context: ContextHealth,
    /// The context action the row offers: build a missing file, refresh any other.
    pub action: AppContextAction,
    /// Whether there is a context file to read.
    pub can_view: bool,
}

/// The context action an app's row offers.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum AppContextAction {
    Build,
    Refresh,
}

impl AppHealth {
    /// An app with the action and the view its context health calls for.
    pub fn new(name: String, folder: String, context: ContextHealth) -> Self {
        let missing = context == ContextHealth::Missing;
        AppHealth {
            name,
            folder,
            context,
            action: if missing {
                AppContextAction::Build
            } else {
                AppContextAction::Refresh
            },
            can_view: !missing,
        }
    }
}

/// The folder the Workbench works from once a folder is opened: the repository or workspace root, the
/// folder the program names as the workspace, and the layout.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opened {
    pub root: PathBuf,
    pub workspace: PathBuf,
    pub layout: Layout,
}

/// Why a folder did not open.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpenError {
    /// The program refused to place the folder; these are its problems, as it printed them.
    #[error("{}", .0.join(" "))]
    Refused(Vec<String>),
    #[error(transparent)]
    Program(#[from] ProgramError),
}

/// Opens `folder` as the program places it, in the form of its saved layout ([`placed`]).
///
/// A folder whose layout is not known is the program's to place, so the repository folder, a folder inside it
/// and the parent of a single-repo repository all find the same master, and a workspace folder that is a git
/// root opens as a workspace. A single-repo master is the root and the program's workspace is the folder
/// around it; a workspace's root is its workspace.
pub fn open(program: &Program, folder: &Path) -> Result<Opened, OpenError> {
    let (found, layout) = placed(program, folder)?;
    let path = |key: &str| {
        found[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    };
    let (Some(master), Some(workspace)) = (path("master"), path("workspace")) else {
        let problems: Vec<String> = found["problems"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        return Err(OpenError::Refused(if problems.is_empty() {
            vec!["the program found no master repository".into()]
        } else {
            problems
        }));
    };
    Ok(match layout {
        Layout::SingleRepo => Opened {
            root: master,
            workspace,
            layout,
        },
        Layout::Workspace => Opened {
            root: workspace.clone(),
            workspace,
            layout,
        },
    })
}

/// The layout every program call for `folder` takes its form from: the saved entry's, read with no Node start;
/// else, for a saved entry whose layout is not known yet or a folder that is not saved, the program's answer,
/// which [`placed`] stores in the entry.
pub fn for_folder(program: &Program, folder: &Path) -> Result<Layout, ProgramError> {
    match saved(folder) {
        Some(layout) => Ok(layout),
        None => placed(program, folder).map(|(_, layout)| layout),
    }
}

/// The saved entry's layout for `folder`; `None` when the folder is not saved or its layout is not known yet.
fn saved(folder: &Path) -> Option<Layout> {
    crate::store::saved_entry(folder).and_then(|w| w.layout)
}

/// The program's `resolve --json` answer for `folder` and the folder's layout: the one place the saved layout is
/// read and one not known yet is filled. A saved layout is the answer, whatever the program says, and the
/// program is asked in its form. Otherwise the program's answer names the layout (a program before 1.4.0 prints
/// none; then, and only then, the marker's `layout` field says it), and a saved entry that has none stores it
/// once, when the program placed the folder.
pub(crate) fn placed(program: &Program, folder: &Path) -> Result<(Value, Layout), ProgramError> {
    let saved = saved(folder);
    let found = program.resolve_from(folder, saved)?;
    if let Some(layout) = saved {
        return Ok((found, layout));
    }
    let master = found["master"].as_str().filter(|s| !s.is_empty());
    let layout = match master {
        // A refusal places nothing, so its layout is never used.
        None => Layout::default(),
        Some(master) if found["layout"].is_null() => marker_layout(Path::new(master))
            .or_else(|| repository_root(folder).and_then(|r| marker_layout(&r)))
            .unwrap_or_default(),
        Some(_) => read(&found["layout"])?,
    };
    if master.is_some() {
        // The saved list cannot be written: the layout is asked again next time, and nothing else changes.
        let _ = crate::store::fill_layout(folder, layout);
    }
    Ok((found, layout))
}

/// The `layout` field of the marker in `dir`, when there is a marker that has one.
fn marker_layout(dir: &Path) -> Option<Layout> {
    let text = std::fs::read_to_string(dir.join(crate::workspace::MARKER)).ok()?;
    let marker: Value = serde_json::from_str(&text).ok()?;
    read(&marker["layout"]).ok()
}

/// The folder holding `.git` that `folder` is, or is inside.
fn repository_root(folder: &Path) -> Option<PathBuf> {
    folder
        .ancestors()
        .find(|d| d.join(".git").exists())
        .map(Path::to_path_buf)
}

/// The layout `resolve --json` names. A plugin before 1.4.0 prints none, which reads as the workspace layout.
pub(crate) fn read(layout: &Value) -> Result<Layout, ProgramError> {
    if layout.is_null() {
        return Ok(Layout::Workspace);
    }
    serde_json::from_value(layout.clone()).map_err(|_| ProgramError::CouldNotRun {
        message: format!("the program names a layout this version does not know: {layout}"),
    })
}

/// The apps of `system`, in the order the program's `stale --json` lists them, with their context
/// health. Only the single-repo layout has apps; the workspace layout reads repositories instead.
pub fn apps(
    program: &Program,
    place: &Place,
    system: &str,
) -> Result<Vec<AppHealth>, ProgramError> {
    let answer = program.run(&["stale", "--json", "--system", system], place)?;
    let entries = answer["repos"]
        .as_array()
        .ok_or_else(|| ProgramError::CouldNotRun {
            message: "the stale answer lists no repos".into(),
        })?;
    entries.iter().map(|e| app_of(e, &place.master)).collect()
}

fn app_of(entry: &Value, root: &Path) -> Result<AppHealth, ProgramError> {
    let bad = |what: &str| ProgramError::CouldNotRun {
        message: format!("the stale answer has {what}: {entry}"),
    };
    let name = entry["repo"].as_str().ok_or_else(|| bad("no repo"))?;
    let path = entry["path"].as_str().ok_or_else(|| bad("no path"))?;
    let context = match entry["reason"].as_str() {
        Some("current") => ContextHealth::Current,
        Some("behind") => ContextHealth::Behind {
            commits: entry["behind"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| bad("no count of commits behind"))?,
        },
        Some("missing") => ContextHealth::Missing,
        Some("no-source-commit") => ContextHealth::NoSourceCommit,
        Some("unknown-commit") => ContextHealth::UnknownCommit,
        _ => return Err(bad("a reason this version does not read")),
    };
    Ok(AppHealth::new(
        name.to_string(),
        folder_in(root, path),
        context,
    ))
}

/// `path` relative to `root` with `/` separators; `.` for the root itself.
fn folder_in(root: &Path, path: &str) -> String {
    let relative = Path::new(path)
        .strip_prefix(root)
        .unwrap_or(Path::new(path));
    let text = relative.to_string_lossy().replace('\\', "/");
    if text.is_empty() {
        ".".into()
    } else {
        text
    }
}

/// Whether the instructions in the repository's root file are current: the two states of
/// `instructions --json` read by the rules of the workspace reference. A missing `workspaceMd` is
/// `Missing`; else a `claudeMd` that is `missing`, `stale` or `bad-markers` is `OutOfDate`; `current`
/// and `home-folder` are `Current`.
pub fn instructions(program: &Program, place: &Place) -> Result<InstructionsState, ProgramError> {
    let answer = program.run(&["instructions", "--json"], place)?;
    let state = |key: &str| answer[key].as_str().map(str::to_string);
    let (Some(workspace_md), Some(claude_md)) = (state("workspaceMd"), state("claudeMd")) else {
        return Err(ProgramError::CouldNotRun {
            message: format!("the instructions answer has no workspaceMd and claudeMd: {answer}"),
        });
    };
    Ok(match (workspace_md.as_str(), claude_md.as_str()) {
        ("missing", _) => InstructionsState::Missing,
        (_, "missing" | "stale" | "bad-markers") => InstructionsState::OutOfDate,
        (_, "current" | "home-folder") => InstructionsState::Current,
        _ => {
            return Err(ProgramError::CouldNotRun {
                message: format!("the instructions answer is not one this version reads: {answer}"),
            })
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_sdlc::state::{self, AppFacts};
    use crate::ai_sdlc::StepOutcome;
    use crate::testutil;
    use std::path::Path;

    const CHANGE: &str = "2026-11-12-greeting";

    /// Compared resolved when both exist: a temp folder can be spelled with an 8.3 short name (CI's
    /// `RUNNER~1`) that the program answers in its long form.
    fn same(a: &Path, b: &Path) -> bool {
        if let (Ok(a), Ok(b)) = (a.canonicalize(), b.canonicalize()) {
            return a == b;
        }
        let norm = |p: &Path| p.display().to_string().replace('\\', "/").to_lowercase();
        norm(a) == norm(b)
    }

    fn assert_opened(got: Result<Opened, OpenError>, root: &Path, workspace: &Path, l: Layout) {
        let got = got.unwrap();
        assert!(same(&got.root, root), "root {:?} is not {root:?}", got.root);
        assert!(
            same(&got.workspace, workspace),
            "workspace {:?} is not {workspace:?}",
            got.workspace
        );
        assert_eq!(got.layout, l);
    }

    #[test]
    fn open_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().to_path_buf();
        let root = testutil::single_repo(&parent, "kata", &[("engine", "engine")]);
        let program = program();

        // The repository folder itself, an app folder inside it, and the parent that holds no master.
        for folder in [root.clone(), root.join("engine"), parent.clone()] {
            let got = open(&program, &folder);
            assert_opened(got, &root, &parent, Layout::SingleRepo);
        }

        // A workspace folder of a master and a product repository, as today.
        let ws = parent.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let master = testutil::repo(&ws, "m");
        testutil::commit_file(
            &master,
            ".ai-sdlc.json",
            "{\"version\":1,\"systems\":{}}\n",
            "marker",
        );
        testutil::repo(&ws, "app");
        assert_opened(open(&program, &ws), &ws, &ws, Layout::Workspace);
    }

    #[test]
    fn open_reads_the_marker_only_for_an_old_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().to_path_buf();
        let root = testutil::single_repo(&parent, "kata", &[("engine", "engine")]);
        // A program of an older plugin: it names the master and the workspace and prints no layout.
        let entry = parent.join("old-program.mjs");
        let answer = serde_json::json!({
            "workspace": parent.display().to_string(),
            "master": root.display().to_string(),
            "masterIsCopy": false,
            "problems": [],
        });
        std::fs::write(&entry, format!("console.log(JSON.stringify({answer}));\n")).unwrap();
        let old = Program {
            node: "node".into(),
            entry,
        };
        assert_opened(open(&old, &root), &root, &parent, Layout::SingleRepo);
    }

    /// Points `KATA_HOME` at an empty folder while held, so the saved workspace list is the test's own.
    struct Home {
        dir: tempfile::TempDir,
        prev: Option<std::ffi::OsString>,
    }

    impl Home {
        fn new() -> Home {
            let dir = tempfile::tempdir().unwrap();
            let prev = std::env::var_os("KATA_HOME");
            std::env::set_var("KATA_HOME", dir.path());
            Home { dir, prev }
        }

        /// Writes the saved workspace list as given, the way an earlier Workbench left it.
        fn saved(&self, json: &str) {
            let dir = self.dir.path().join("workbench");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("workspaces.json"), json).unwrap();
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var("KATA_HOME", v),
                None => std::env::remove_var("KATA_HOME"),
            }
        }
    }

    fn saved_layouts() -> Vec<Option<Layout>> {
        crate::store::load_workspaces()
            .iter()
            .map(|w| w.layout)
            .collect()
    }

    fn entry_json(folder: &Path, layout: &str) -> String {
        let folder = serde_json::to_string(&folder.display().to_string()).unwrap();
        format!(r#"[{{"id":"w","name":"w","folder":{folder},"last_opened":1{layout}}}]"#)
    }

    /// A program that logs each call's arguments to `calls.log` beside it and answers as a workspace would.
    fn recording(dir: &Path) -> Program {
        let entry = dir.join("ai-sdlc.mjs");
        let script = r#"import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(here, 'calls.log'), args.join(' ') + '\n');
if (args[0] === 'resolve') {
  console.log(JSON.stringify({ master: here, workspace: here, problems: [], layout: 'workspace' }));
} else {
  console.log(JSON.stringify({ system: 'kata', changes: [], problems: [] }));
}
"#;
        std::fs::write(&entry, script).unwrap();
        Program {
            node: "node".into(),
            entry,
        }
    }

    fn calls(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// An entry saved before the field existed is a workspace: the home reads it in the workspace form, with no
    /// Node start to learn the layout, and the folder is placed in that form too.
    #[test]
    #[serial_test::serial]
    fn an_entry_saved_without_a_layout_is_read_as_a_workspace() {
        let home = Home::new();
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path();
        home.saved(&entry_json(folder, ""));
        assert_eq!(saved_layouts(), [Some(Layout::Workspace)]);

        let program = recording(folder);
        let layout = for_folder(&program, folder).unwrap();
        assert_eq!(layout, Layout::Workspace);
        assert!(calls(folder).is_empty(), "{:?}", calls(folder));

        let named = folder.display().to_string();
        program
            .run_in(&["list", "--json", "--system", "kata"], folder, layout)
            .unwrap();
        assert_eq!(
            calls(folder),
            [format!("list --json --system kata --workspace {named}")]
        );

        program.resolve(folder).unwrap();
        assert_eq!(
            calls(folder)[1..],
            [format!("resolve --json --workspace {named}")]
        );
        assert_eq!(saved_layouts(), [Some(Layout::Workspace)]);
    }

    /// A saved layout is never replaced: a single-repo repository saved as a workspace stays one, and is
    /// called in the workspace form, whatever the program says about it.
    #[test]
    #[serial_test::serial]
    fn a_saved_layout_is_never_overwritten_by_the_program() {
        let home = Home::new();
        let tmp = tempfile::tempdir().unwrap();
        let root = testutil::single_repo(tmp.path(), "kata", &[("engine", "engine")]);
        home.saved(&entry_json(&root, r#","layout":"workspace""#));
        let program = program();

        assert_eq!(open(&program, &root).unwrap().layout, Layout::Workspace);
        let place = program.resolve(&root).unwrap();
        assert_eq!(place.layout, Layout::Workspace);
        assert!(same(&place.workspace, &root), "{:?}", place.workspace);
        assert_eq!(for_folder(&program, &root).unwrap(), Layout::Workspace);
        assert_eq!(saved_layouts(), [Some(Layout::Workspace)]);
    }

    /// A saved folder whose layout is not known yet takes the program's first answer, once; a folder that is
    /// not saved is answered the same way and nothing is written.
    #[test]
    #[serial_test::serial]
    fn the_first_answer_fills_a_layout_that_is_not_known() {
        let home = Home::new();
        let tmp = tempfile::tempdir().unwrap();
        let root = testutil::single_repo(tmp.path(), "kata", &[("engine", "engine")]);
        home.saved(&entry_json(&root, r#","layout":null"#));
        let program = program();

        assert_eq!(saved_layouts(), [None]);
        assert_opened(open(&program, &root), &root, tmp.path(), Layout::SingleRepo);
        assert_eq!(saved_layouts(), [Some(Layout::SingleRepo)]);
        assert_eq!(for_folder(&program, &root).unwrap(), Layout::SingleRepo);

        let other = tempfile::tempdir().unwrap();
        let elsewhere = testutil::single_repo(other.path(), "kata", &[("engine", "engine")]);
        assert_eq!(
            for_folder(&program, &elsewhere).unwrap(),
            Layout::SingleRepo
        );
        assert_eq!(crate::store::load_workspaces().len(), 1);
    }

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    #[test]
    fn a_missing_context_offers_build_and_no_view_and_every_other_state_offers_refresh_and_view() {
        let of = |context| AppHealth::new("a".into(), "a".into(), context);
        let missing = of(ContextHealth::Missing);
        assert_eq!(missing.action, AppContextAction::Build);
        assert!(!missing.can_view);
        for context in [
            ContextHealth::Current,
            ContextHealth::Behind { commits: 2 },
            ContextHealth::NoSourceCommit,
            ContextHealth::UnknownCommit,
        ] {
            let app = of(context);
            assert_eq!(app.action, AppContextAction::Refresh, "{context:?}");
            assert!(app.can_view, "{context:?}");
        }
    }

    #[test]
    fn layout_facts_come_from_the_program() {
        let tmp = tempfile::tempdir().unwrap();
        let root = testutil::single_repo(
            tmp.path(),
            "kata",
            &[("engine", "engine"), ("workbench", "app")],
        );
        let program = program();

        // The layout of the opened folder.
        let place = program.resolve(tmp.path()).unwrap();
        assert_eq!(place.layout, Layout::SingleRepo);

        // Which apps the system has and their folders; neither has a context file yet.
        let app = |name: &str, folder: &str, context: ContextHealth| {
            AppHealth::new(name.into(), folder.into(), context)
        };
        assert_eq!(
            apps(&program, &place, "kata").unwrap(),
            vec![
                app("engine", "engine", ContextHealth::Missing),
                app("workbench", "app", ContextHealth::Missing),
            ]
        );

        // Whether an app's context file is out of date: engine's was written at the commit before a
        // commit that touches engine/, workbench has none.
        let before = testutil::run(&root, &["rev-parse", "HEAD"]).unwrap();
        testutil::commit_file(
            &root,
            "intent/kata/context/engine.md",
            &format!("---\nsource_commit: {before}\n---\n# engine\n"),
            "engine context",
        );
        testutil::commit_file(&root, "engine/lib.txt", "more\n", "engine work");
        assert_eq!(
            apps(&program, &place, "kata").unwrap(),
            vec![
                app("engine", "engine", ContextHealth::Behind { commits: 1 }),
                app("workbench", "app", ContextHealth::Missing),
            ]
        );

        // Which apps a change touched, and each app's head.
        let base = testutil::run(&root, &["rev-parse", "HEAD"]).unwrap();
        let started = program
            .step_long(
                &[
                    "change", "start", "--json", "--system", "kata", "--change", CHANGE, "--type",
                    "feat", "--scope", "demo", "--title", "Greeting",
                ],
                &place,
                &kata_core::proc::CancelToken::new(),
                None,
            )
            .json;
        assert_eq!(started["outcome"], "passed", "{started}");
        let copy = tmp.path().join(".ai-sdlc").join("copies").join(CHANGE);
        testutil::commit_file(
            &copy,
            &format!("intent/kata/{CHANGE}/intent.md"),
            "---\nstatus: accepted\n---\n# Intent\n",
            "intent",
        );
        testutil::commit_file(&copy, "engine/greeting.txt", "hello\n", "engine greeting");
        let engine_head = testutil::run(&copy, &["rev-parse", "HEAD"]).unwrap();
        let change = state::one(&program, &place, "kata", CHANGE)
            .unwrap()
            .unwrap();
        let facts = change.apps.expect("a single-repo change reports its apps");
        assert_eq!(
            facts.get("engine"),
            Some(&AppFacts {
                folder: "engine".into(),
                touched: true,
                head: Some(engine_head),
            })
        );
        // The program heads an untouched app at the merge base, not at nothing.
        assert_eq!(
            facts.get("workbench"),
            Some(&AppFacts {
                folder: "app".into(),
                touched: false,
                head: Some(base),
            })
        );

        // Whether the instructions in the root file are current.
        assert_eq!(
            instructions(&program, &place).unwrap(),
            InstructionsState::Missing
        );
        let written = program
            .run(&["instructions", "--json", "--write"], &place)
            .unwrap();
        assert_eq!(written["claudeMd"], "created", "{written}");
        assert_eq!(
            instructions(&program, &place).unwrap(),
            InstructionsState::Current
        );

        // Whether an app may start building now: the program refuses a second app.
        let build = |app: &str| {
            program.step_long(
                &[
                    "run",
                    "build.start",
                    "--json",
                    "--system",
                    "kata",
                    "--change",
                    CHANGE,
                    "--repo",
                    app,
                ],
                &place,
                &kata_core::proc::CancelToken::new(),
                None,
            )
        };
        assert_eq!(
            build("engine").outcome,
            StepOutcome::Passed { problems: vec![] }
        );
        assert_eq!(
            build("workbench").outcome,
            StepOutcome::Refused {
                problems: vec![
                    "`engine` is being built in this copy; build one app at a time".into()
                ]
            }
        );
    }

    /// R8.1: a workspace of a master `m` and products `app` and `api` keeps every answer it had before
    /// the layout existed.
    #[test]
    fn a_workspace_keeps_every_answer() {
        use crate::branch;
        use crate::coordinator::{
            BuildChoices, BuildFacts, BuildReadiness, Command, Coordinator, Input, RepoReadiness,
            TaskFact,
        };
        use crate::holds::{keys_for, RepoKey};
        use crate::permissions::fixtures::place;
        use crate::permissions::RunKind;
        use crate::plugin::{self, GhPresence, Plugin, Readiness};
        use crate::review::ReviewCurrency;
        use crate::runspec::build_workdir;
        use std::collections::BTreeMap;

        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_path_buf();
        let master = testutil::repo(&ws, "m");
        testutil::commit_file(
            &master,
            ".ai-sdlc.json",
            "{\"version\":1,\"systems\":{}}\n",
            "marker",
        );
        testutil::repo(&ws, "app");
        testutil::repo(&ws, "api");

        // The layout of the opened folder and the repository it opens as.
        assert_opened(open(&program(), &ws), &ws, &ws, Layout::Workspace);

        // The readiness comes back unchanged on 1.1.0.
        let ready = Readiness::Ready {
            plugin: Plugin {
                dir: ws.join("plugin"),
                version: "1.1.0".into(),
                layouts: vec![1],
            },
            gh: GhPresence::Present,
        };
        assert_eq!(plugin::for_layout(&ready, Layout::Workspace), ready);

        // The master checkout can be switched.
        assert!(branch::switchable(Layout::Workspace));

        // A build or review holds one key per product repository.
        let repos = vec!["app".to_string(), "api".to_string()];
        assert_eq!(
            keys_for(Layout::Workspace, &master, &ws, &repos),
            vec![RepoKey::of(&ws.join("app")), RepoKey::of(&ws.join("api"))]
        );

        // A run of a repository works in `<ws>/<repo>`.
        let mut at = place(RunKind::Build { repo: "app".into() });
        at.workspace = ws.clone();
        assert_eq!(build_workdir(&at, "app"), ws.join("app"));
        assert_eq!(build_workdir(&at, "api"), ws.join("api"));

        // Both ready repositories launch in one look.
        let mut co = Coordinator::new(ReviewCurrency::None, BTreeMap::new(), false);
        let choices = BuildChoices {
            timeout_secs: 3600,
            instructions: None,
            continue_on_leftovers: false,
        };
        let asked = co.step(Input::Begin {
            timeout_secs: 3600,
            rounds: Vec::new(),
            choices,
        });
        assert_eq!(asked, vec![Command::ReadStatus]);
        let facts = BuildFacts {
            has_tasks: true,
            repos: ["app", "api"]
                .iter()
                .map(|r| RepoReadiness {
                    repo: r.to_string(),
                    state: BuildReadiness::Ready,
                })
                .collect(),
            tasks: [("T1", "app"), ("T2", "api")]
                .iter()
                .map(|(id, r)| TaskFact {
                    id: id.to_string(),
                    repo: r.to_string(),
                    logged: false,
                })
                .collect(),
        };
        let launched: Vec<String> = co
            .step(Input::Status(facts))
            .into_iter()
            .filter_map(|c| match c {
                Command::Launch { key, .. } => Some(key),
                _ => None,
            })
            .collect();
        assert_eq!(launched, vec!["app".to_string(), "api".to_string()]);
    }
}
