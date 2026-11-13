//! The layout of the folder Kata is opened on, and the answers only the single-repo layout has: its apps
//! and their context, and the instructions in the repository's root file. Every answer is the ai-sdlc
//! program's; this module types it and decides nothing.
use crate::ai_sdlc::{Place, Program, ProgramError};
use crate::workspace::InstructionsState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

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
    Ok(AppHealth {
        name: name.to_string(),
        folder: folder_in(root, path),
        context,
    })
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

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts"),
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
        let app = |name: &str, folder: &str, context: ContextHealth| AppHealth {
            name: name.into(),
            folder: folder.into(),
            context,
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
            .run(
                &[
                    "change", "start", "--json", "--system", "kata", "--change", CHANGE, "--type",
                    "feat", "--scope", "demo", "--title", "Greeting",
                ],
                &place,
            )
            .unwrap();
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
            program.step(
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
}
