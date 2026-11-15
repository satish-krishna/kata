//! What `migrate --json` prints: the steps that move a workspace from the names the plugin had before 1.0.0
//! (ai-sdlc) to hoshin's. The program decides whether a folder is such a workspace and what moving it takes;
//! Kata looks for no marker of its own and only shows the plan and starts the write.
use super::{Place, Program, ProgramError, StepOutcome};
use crate::layout::Layout;
use kata_core::proc::CancelToken;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

/// How one step stands.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum StepStatus {
    /// Taken (only with `--write`).
    Done,
    /// Would be taken (only without `--write`).
    Would,
    /// Nothing to do.
    Current,
    /// Left for the engineer; the detail says what to do.
    Manual,
    /// Cannot be taken; nothing is changed until it can.
    Refused,
}

/// One step of the migration: `marker`, `copy`, `state` or `instructions`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct MigrateStep {
    pub step: String,
    pub path: String,
    pub to: Option<String>,
    pub status: StepStatus,
    pub detail: Option<String>,
}

/// The program's `migrate --json` answer.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct MigratePlan {
    pub workspace: String,
    pub master: String,
    /// Whether the plan was taken. False for a dry run, and also for a write asked of a workspace with nothing to
    /// take: the program was not started, and nothing was written.
    pub write: bool,
    pub steps: Vec<MigrateStep>,
    /// Paths left in the old folders.
    #[serde(default)]
    pub kept: Vec<String>,
    /// What the engineer still does by hand.
    #[serde(default)]
    pub manual: Vec<String>,
    #[serde(default)]
    pub problems: Vec<String>,
}

impl MigratePlan {
    /// Whether the migration has work to offer: a step that would be taken, or one the program refuses (the
    /// engineer needs to see why).
    pub fn needed(&self) -> bool {
        self.steps
            .iter()
            .any(|s| matches!(s.status, StepStatus::Would | StepStatus::Refused))
    }
}

fn read_plan(json: Value) -> Result<MigratePlan, ProgramError> {
    serde_json::from_value(json).map_err(|e| ProgramError::CouldNotRun {
        message: format!("the migrate answer is not what this version reads: {e}"),
    })
}

/// The program's `migrate --json` answer for `folder` and the layout it names. A workspace that is a git
/// root needs `--workspace`; a single-repo repository needs none, so the workspace form is asked first.
pub fn dry_run(program: &Program, folder: &Path) -> Result<(MigratePlan, Layout), ProgramError> {
    let ask = |layout| {
        program
            .run_in(&["migrate", "--json"], folder, layout)
            .and_then(|json| {
                let layout = crate::layout::read(&json["layout"])?;
                read_plan(json).map(|plan| (plan, layout))
            })
    };
    match ask(Layout::Workspace) {
        Ok(found) => Ok(found),
        Err(first) => ask(Layout::SingleRepo).map_err(|_| first),
    }
}

/// Takes the migration `plan` (a dry run's answer in `layout`) with `--write`. A plan with nothing to take is
/// returned as it is, with `write` false: nothing was written.
pub fn write(
    program: &Program,
    plan: &MigratePlan,
    layout: Layout,
) -> Result<MigratePlan, ProgramError> {
    if !plan.needed() {
        return Ok(plan.clone());
    }
    let place = Place {
        layout,
        master: plan.master.clone().into(),
        workspace: plan.workspace.clone().into(),
    };
    let answer = program.step_long(
        &["migrate", "--json", "--write"],
        &place,
        &CancelToken::new(),
        None,
    );
    match answer.outcome {
        StepOutcome::CouldNotRun { reason, .. } => {
            Err(ProgramError::CouldNotRun { message: reason })
        }
        StepOutcome::Stopped => Err(ProgramError::CouldNotRun {
            message: "it was stopped".into(),
        }),
        _ if answer.json.is_null() => Err(ProgramError::CouldNotRun {
            message: "the program printed no plan".into(),
        }),
        _ => read_plan(answer.json),
    }
}

/// The migration of the workspace at `folder`: a dry run, or with `write` the migration itself. Exit 1 with
/// `problems` is an answer (a plan with refusals); exit 2 is an error.
pub fn migrate(
    program: &Program,
    folder: &Path,
    write_it: bool,
) -> Result<MigratePlan, ProgramError> {
    let (plan, layout) = dry_run(program, folder)?;
    if write_it {
        write(program, &plan, layout)
    } else {
        Ok(plan)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/hoshin-tools/hoshin.ts"),
        }
    }

    const MARKER: &str = "{\"version\":1,\"systems\":{\"kata\":{\"repos\":[]}}}\n";

    /// A workspace whose master holds a committed marker of `name`.
    fn legacy(tmp: &Path, name: &str) -> std::path::PathBuf {
        let master = testutil::repo(tmp, "hub");
        testutil::commit_msg(
            &master,
            name,
            MARKER,
            "chore: marker\n\nGenerated-By: ai-sdlc\n",
        );
        master
    }

    fn step<'a>(plan: &'a MigratePlan, name: &str) -> &'a MigrateStep {
        plan.steps.iter().find(|s| s.step == name).unwrap()
    }

    #[test]
    fn a_legacy_workspace_is_offered_then_migrated_then_current() {
        let tmp = tempfile::tempdir().unwrap();
        let master = legacy(tmp.path(), ".ai-sdlc.json");
        let dry = migrate(&program(), tmp.path(), false).unwrap();
        assert!(dry.needed(), "{dry:?}");
        assert_eq!(step(&dry, "marker").status, StepStatus::Would);
        assert!(!master.join(".hoshin.json").exists());

        let done = migrate(&program(), tmp.path(), true).unwrap();
        assert!(done.write);
        assert_eq!(step(&done, "marker").status, StepStatus::Done, "{done:?}");
        let tracked = testutil::run(&master, &["ls-files", ".hoshin.json"]).unwrap();
        assert_eq!(tracked, ".hoshin.json");

        let again = migrate(&program(), tmp.path(), false).unwrap();
        assert!(!again.needed(), "{again:?}");
        assert_eq!(step(&again, "marker").status, StepStatus::Current);
    }

    #[test]
    fn both_markers_tracked_is_a_plan_with_a_refusal() {
        let tmp = tempfile::tempdir().unwrap();
        let master = legacy(tmp.path(), ".ai-sdlc.json");
        testutil::commit_file(&master, ".hoshin.json", MARKER, "both");
        let plan = migrate(&program(), tmp.path(), false).unwrap();
        assert!(!plan.problems.is_empty(), "{plan:?}");
        assert_eq!(step(&plan, "marker").status, StepStatus::Refused);
        assert!(plan.needed());
    }

    #[test]
    fn a_folder_with_no_marker_cannot_run() {
        let tmp = tempfile::tempdir().unwrap();
        testutil::repo(tmp.path(), "hub");
        assert!(migrate(&program(), tmp.path(), false).is_err());
    }
}
