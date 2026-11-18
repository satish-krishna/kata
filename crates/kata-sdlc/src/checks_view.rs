//! What a repository's checks came to, shown from what the plugin recorded. Checks are the team's
//! `build.finish` hooks, committed to the master's base branch and run by the plugin when a repository's
//! build finishes; Kata runs none of them. This module only reads the plugin's ledger and hook list and
//! names the state the page shows, in the words it shows.
use crate::hoshin::status::{Hooks, OnFailure, RunRecord, Status};
use crate::hoshin::{BaselineShow, CheckRun, CheckState};
use crate::hoshin::{Place, Program, ProgramError};
use crate::layout::Layout;
use serde::Serialize;

/// The event whose hooks are a repository's checks.
pub const EVENT: &str = "build.finish";

/// One hook of a passed run.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct HookShown {
    pub id: String,
    pub outcome: String,
}

/// Where a repository's checks stand.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum CheckView {
    /// The team's hook configuration on the master's base branch has problems, so the plugin runs no
    /// check until it is fixed; `output` is the plugin's problems, one a line.
    ConfigBroken { output: String },
    /// No `build.finish` hook is configured for the repository.
    NoChecks,
    /// Checks are configured and have not run.
    NotRunYet,
    /// The checks last ran at an earlier head; `head` is that head, shortened.
    Stale { head: String },
    /// The app was not touched by the change, so `build.finish` passed as a no-op at its head.
    NoChanges,
    /// The checks ran at the head and passed.
    Passed { hooks: Vec<HookShown> },
    /// A check failed at the head and the team marked it to be fixed.
    FailedFix { id: String, output: String },
    /// A check failed at the head and the team marked it to stop.
    FailedStop { id: String, output: String },
    /// A check could not run on this machine: a fault of the machine, not of the code.
    CouldNotRun { id: String, output: String },
}

/// One repository's checks, with the sentence the page shows for them.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RepoCheckView {
    pub repo: String,
    pub view: CheckView,
    pub summary: String,
}

/// The state of `repo`'s checks at `head`, from the first row of this table that matches:
///
/// | # | hooks | latest `build.finish` run | view |
/// |---|---|---|---|
/// | 0 | the configuration has problems | any | `ConfigBroken`: the plugin runs no hook until it is fixed |
/// | 1 | none for the repository | any | `NoChecks` |
/// | 2 | some | none | `NotRunYet` |
/// | 3 | some | at an earlier head | `Stale` |
/// | 4 | some | at the head, passed | `Passed` |
/// | 4b | some | at the head, passed as a no-op for an untouched app | `NoChanges` |
/// | 5 | some | at the head, failed on a check marked to be fixed | `FailedFix` |
/// | 6 | some | at the head, failed on a check marked to stop | `FailedStop` |
/// | 7 | some | at the head, could not run | `CouldNotRun` |
///
/// A run the plugin refused checked nothing, and a failure that names no check has nothing to show; both
/// read as `NotRunYet`.
pub fn of(status: &Status, repo: &str, head: &str, hooks: &Hooks, layout: Layout) -> CheckView {
    if !hooks.problems.is_empty() {
        return CheckView::ConfigBroken {
            output: hooks.problems.join(
                "
",
            ),
        };
    }
    // A hook applies to a repository by its `repos` list in the workspace layout and to an app by its
    // `apps` list in the single-repo layout; no list means every one.
    let configured = hooks.hooks.iter().any(|h| {
        let names = match layout {
            Layout::Workspace => &h.repos,
            Layout::SingleRepo => &h.apps,
        };
        h.event == EVENT
            && names
                .as_ref()
                .is_none_or(|names| names.iter().any(|n| n == repo))
    });
    if !configured {
        return CheckView::NoChecks;
    }
    let latest = status
        .repos
        .iter()
        .filter(|r| r.repo == repo)
        .flat_map(|r| r.runs.iter())
        .rfind(|run| run.event == EVENT);
    let Some(run) = latest else {
        return CheckView::NotRunYet;
    };
    if run.key != head {
        return CheckView::Stale {
            head: run.key.chars().take(7).collect(),
        };
    }
    let output_of = |id: &str| {
        run.hooks
            .iter()
            .find(|h| h.id == id)
            .map(|h| h.output.clone())
            .filter(|o| !o.is_empty())
            .unwrap_or_else(|| {
                run.problems.join(
                    "
",
                )
            })
    };
    match (run.outcome.as_str(), &run.failed) {
        ("passed", _) if run.details.as_ref().is_some_and(|d| d["untouched"] == true) => {
            CheckView::NoChanges
        }
        ("passed", _) => CheckView::Passed {
            hooks: run
                .hooks
                .iter()
                .map(|h| HookShown {
                    id: h.id.clone(),
                    outcome: h.outcome.clone(),
                })
                .collect(),
        },
        ("could-not-run", Some(f)) => CheckView::CouldNotRun {
            id: f.id.clone(),
            output: output_of(&f.id),
        },
        ("failed", Some(f)) if f.on_failure == OnFailure::Fix => CheckView::FailedFix {
            id: f.id.clone(),
            output: output_of(&f.id),
        },
        ("failed", Some(f)) => CheckView::FailedStop {
            id: f.id.clone(),
            output: output_of(&f.id),
        },
        _ => CheckView::NotRunYet,
    }
}

/// The sentence the page shows for a view.
pub fn summary(view: &CheckView) -> String {
    match view {
        CheckView::ConfigBroken { .. } => "The team's check configuration on the base branch has problems. No check runs until it is fixed.".to_string(),
        CheckView::NoChecks => "This repository has no checks.".to_string(),
        CheckView::NotRunYet => "The checks have not run yet.".to_string(),
        CheckView::Stale { head } => format!("Checks last ran at {head}."),
        CheckView::NoChanges => "No changes to check".to_string(),
        CheckView::Passed { .. } => "The checks passed.".to_string(),
        CheckView::FailedFix { id, .. } => {
            format!("{id} failed. The agent is sent back to fix it, up to the team's retry limit.")
        }
        CheckView::FailedStop { id, .. } => format!("{id} failed. The build stopped here."),
        CheckView::CouldNotRun { id, .. } => format!(
            "{id} could not run on this machine. That is a fault of the machine, not of the code."
        ),
    }
}

/// The checks of each of `repos` in `change`, read from the plugin: its ledger of what ran on this machine
/// and the hooks the team committed to the master's base branch. Nothing here depends on this machine's
/// Kata settings, so two machines with the same master and the same runs show the same view.
pub fn for_change(
    program: &Program,
    place: &Place,
    system: &str,
    change: &str,
    repos: &[String],
) -> Result<Vec<RepoCheckView>, ProgramError> {
    let status = program.status(place, change)?;
    let hooks = program.hooks(place, system, Some(EVENT))?;
    // In the single-repo layout an app's head is the one the change's `apps` give.
    let app_heads = match place.layout {
        Layout::SingleRepo => {
            crate::hoshin::state::one(program, place, system, change)?
                .ok_or_else(|| ProgramError::CouldNotRun {
                    message: format!("the state answer has no change {change}"),
                })?
                .apps
        }
        Layout::Workspace => None,
    };
    Ok(repos
        .iter()
        .map(|repo| {
            let head = match &app_heads {
                Some(apps) => apps.get(repo).and_then(|a| a.head.clone()),
                None => status
                    .repos
                    .iter()
                    .find(|r| &r.repo == repo)
                    .and_then(|r| r.head.clone()),
            }
            .unwrap_or_default();
            let view = of(&status, repo, &head, &hooks, place.layout);
            RepoCheckView {
                repo: repo.clone(),
                summary: summary(&view),
                view,
            }
        })
        .collect())
}

/// Where one check stands on the base.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum BaseCheckState {
    /// Started and not ended, and the program running it is still there.
    Running,
    /// Ended and passed.
    Passed,
    /// Ended and failed, or could not run.
    Failed,
    /// Started and the program running it ended without a result; hoshin decides this, Kata never does.
    CutOff,
    /// A check of the hook list with no event in the latest run on the base.
    NotRun,
}

/// One check of a repository on the base commit.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BaseCheck {
    pub check: String,
    pub state: BaseCheckState,
    pub exit_code: Option<i32>,
    /// The stored last 200 lines of the check's output.
    pub output: String,
    pub line_count: u32,
    /// True only for a check that failed without saying what failed and is not accepted yet (R5.5).
    pub can_accept: bool,
    /// True for a check accepted for this change at the current base commit.
    pub accepted: bool,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

/// What the Build tab shows for a repository's start (the decision table of R8.1).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum StartShown {
    /// No start was recorded: no failure, the build can be started.
    Startable,
    /// The start stopped on checks failing on the base, and some still need a decision.
    BaseFailure,
    /// The start stopped on checks failing on the base and every one that needed a decision is accepted.
    AllAccepted,
    /// The start stopped on checks failing on the base, and the base commit moved since.
    BaseMoved,
    /// The start was refused, a check could not run, or a step failed: the plugin's reason, once.
    OtherReason {
        reason: String,
        /// The step or check the plugin names, when it names one.
        step: Option<String>,
        output: String,
    },
    /// The build started and no finish is recorded after it.
    UnderWay,
    /// The build started and the repository's finish passed.
    Finished,
    /// The build started and the repository's finish failed; the detail is `StartChecks::finish`.
    FinishFailure,
}

/// How a check that failed at finish stood on the base.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum FinishBase {
    /// The check passed on the base, so the build broke it.
    Passed,
    /// The check failed on the base, so it failed at finish naming failures this build added.
    AddedFailures,
}

/// What happened after a check failed at finish, from the hook's `onFailure`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum FinishNext {
    /// The agent was sent back to fix it and did not get it to pass.
    SentBackNotFixed,
    /// The build stopped here.
    Stopped,
}

/// The failure of a repository's finish.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct FinishFailure {
    pub check: String,
    pub base: FinishBase,
    pub output: String,
    /// How many other checks passed at finish (R7.3), shown folded.
    pub passed: u32,
    pub next: FinishNext,
    /// Always false: a failure at finish can be run again, never accepted (D4).
    pub can_accept: bool,
}

/// What the Build tab shows for one repository's start and its checks on the base.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct StartChecks {
    pub repo: String,
    pub shown: StartShown,
    /// The base commit the checks ran on, empty when no baseline was read.
    pub base: String,
    /// Every check of the repository in the hook list's order, with its state in the latest run on the base.
    pub checks: Vec<BaseCheck>,
    /// How many of `checks` passed.
    pub passed: u32,
    /// Three or more checks failed without saying what failed (R4.3).
    pub setup_hint: bool,
    /// Why starting the build is not offered as ready (R6.2).
    pub start_held: Option<String>,
    pub finish: Option<FinishFailure>,
}

/// The reason Start is off while a failing check is not accepted (R6.2).
const HELD: &str = "Accept or fix the failing checks first.";

/// Three or more checks failing together without saying what failed point at the setup (R4.3).
const SETUP_HINT_AT: usize = 3;

/// The ids of the checks that apply to `repo`: the blocking `before` hooks of `build.finish`, in the hook
/// list's order.
fn check_ids(hooks: &Hooks, repo: &str, layout: Layout) -> Vec<String> {
    hooks
        .hooks
        .iter()
        .filter(|h| h.event == EVENT && h.when == "before" && h.blocking)
        .filter(|h| {
            let names = match layout {
                Layout::Workspace => &h.repos,
                Layout::SingleRepo => &h.apps,
            };
            names
                .as_ref()
                .is_none_or(|names| names.iter().any(|n| n == repo))
        })
        .map(|h| h.id.clone())
        .collect()
}

/// Each of `ids` with its state in `latest`, the latest run on the base, and what `baseline` stored for it. An
/// event of the run decides the state; a check with no event takes its stored result, else it is not run.
fn base_checks(
    ids: &[String],
    latest: Option<&CheckRun>,
    baseline: Option<&BaselineShow>,
) -> Vec<BaseCheck> {
    ids.iter()
        .map(|id| {
            let event = latest.and_then(|run| run.checks.iter().find(|c| &c.check == id));
            let stored = baseline.and_then(|b| b.hooks.iter().find(|h| &h.id == id));
            let state = match (event, stored) {
                (Some(e), _) => match e.state {
                    CheckState::Running => BaseCheckState::Running,
                    CheckState::Abandoned => BaseCheckState::CutOff,
                    CheckState::Ended if e.outcome.as_deref() == Some("passed") => {
                        BaseCheckState::Passed
                    }
                    CheckState::Ended => BaseCheckState::Failed,
                },
                (None, Some(h)) if h.outcome == "passed" => BaseCheckState::Passed,
                (None, Some(_)) => BaseCheckState::Failed,
                (None, None) => BaseCheckState::NotRun,
            };
            let output = stored.map(|h| h.output.clone()).unwrap_or_default();
            BaseCheck {
                check: id.clone(),
                state,
                exit_code: stored.and_then(|h| h.exit_code),
                line_count: output.lines().count() as u32,
                output,
                can_accept: baseline.is_some_and(|b| b.needs_approval.contains(id)),
                accepted: baseline.is_some_and(|b| b.approved.contains(id)),
                started_at: event.and_then(|e| e.started_at.clone()),
                ended_at: event.and_then(|e| e.ended_at.clone()),
            }
        })
        .collect()
}

/// The plugin's reason for a start that stopped for something other than a check failing on the base.
fn other_reason(start: &RunRecord) -> StartShown {
    let reason = if start.problems.is_empty() {
        format!("The build start ended as {}.", start.outcome)
    } else {
        start.problems.join("\n")
    };
    let step = start.failed.as_ref().map(|f| f.id.clone());
    let output = step
        .as_ref()
        .and_then(|id| start.hooks.iter().find(|h| &h.id == id))
        .map(|h| h.output.clone())
        .unwrap_or_default();
    StartShown::OtherReason {
        reason,
        step,
        output,
    }
}

/// What the Build tab shows for each of `repos`, in order, from the first row of this table that matches
/// (R8.1). The latest `build.start` record of the repository decides; a `build.finish` record counts only
/// when it comes after that start.
///
/// | # | latest `build.start` | still needing | latest finish | shown |
/// |---|---|---|---|---|
/// | 1 | none | | | `Startable` |
/// | 2 | passed | | none or refused | `UnderWay` |
/// | 3 | passed | | passed | `Finished` |
/// | 4 | passed | | failed or could not run | `FinishFailure` |
/// | 5 | not passed, base results recorded with failing checks | the base commit moved | | `BaseMoved` |
/// | 6 | same | some | | `BaseFailure` |
/// | 7 | same | none | | `AllAccepted` |
/// | 8 | not passed, no base results recorded (a build started before hoshin kept them) or none failing | | | `OtherReason` |
///
/// `baseline show` is read only for rows 5 to 7. The checks are those of the hook list, each in the state
/// the latest `baseline` run of `checks` gives it, except for `BaseMoved`, where the results belong to a
/// base commit that is gone and none are shown.
pub fn start_checks(
    program: &Program,
    place: &Place,
    system: &str,
    change: &str,
    repos: &[String],
) -> Result<Vec<StartChecks>, ProgramError> {
    let status = program.status(place, change)?;
    let hooks = program.hooks(place, system, Some(EVENT))?;
    repos
        .iter()
        .map(|repo| {
            let runs: &[RunRecord] = status
                .repos
                .iter()
                .find(|r| &r.repo == repo)
                .map_or(&[], |r| r.runs.as_slice());
            let start_at = runs.iter().rposition(|r| r.event == "build.start");
            let ids = check_ids(&hooks, repo, place.layout);
            let answer = program.checks(place, change, repo)?;
            let latest = answer
                .runs
                .iter()
                .rfind(|run| run.phase == "baseline" && run.repo == *repo);
            let of = |shown, base: String, baseline: Option<&BaselineShow>| {
                let checks = base_checks(&ids, latest, baseline);
                let passed = checks
                    .iter()
                    .filter(|c| c.state == BaseCheckState::Passed)
                    .count() as u32;
                StartChecks {
                    repo: repo.clone(),
                    shown,
                    base,
                    checks,
                    passed,
                    setup_hint: false,
                    start_held: None,
                    finish: None,
                }
            };
            let Some(start_at) = start_at else {
                return Ok(of(StartShown::Startable, String::new(), None));
            };
            let start = &runs[start_at];
            if start.outcome == "passed" {
                let finish = runs[start_at + 1..]
                    .iter()
                    .rfind(|r| r.event == "build.finish");
                let shown = match finish.map(|f| f.outcome.as_str()) {
                    Some("passed") => StartShown::Finished,
                    Some("failed" | "could-not-run") => StartShown::FinishFailure,
                    _ => StartShown::UnderWay,
                };
                return Ok(of(shown, String::new(), None));
            }
            let recorded = start
                .details
                .as_ref()
                .map(|d| &d["baseline"])
                .filter(|b| b["failing"].as_array().is_some_and(|f| !f.is_empty()));
            let Some(recorded) = recorded else {
                return Ok(of(other_reason(start), String::new(), None));
            };
            let show = program.baseline_show(place, change, repo)?;
            if recorded["base"].as_str() != Some(show.base.as_str()) {
                return Ok(StartChecks {
                    checks: Vec::new(),
                    passed: 0,
                    ..of(StartShown::BaseMoved, show.base.clone(), None)
                });
            }
            let mut shown = of(StartShown::AllAccepted, show.base.clone(), Some(&show));
            if !show.needs_approval.is_empty() {
                let unnamed = shown
                    .checks
                    .iter()
                    .filter(|c| c.can_accept || c.accepted)
                    .count();
                shown.shown = StartShown::BaseFailure;
                shown.setup_hint = unnamed >= SETUP_HINT_AT;
                shown.start_held = Some(HELD.to_string());
            }
            Ok(shown)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use serde_json::{json, Value};
    use serial_test::serial;
    use std::path::{Path, PathBuf};

    const SYSTEM: &str = "demo";
    const CHANGE: &str = "2026-11-01-greeting";
    const OTHER_HEAD: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/hoshin-tools/hoshin.ts"),
        }
    }

    /// A workspace with a master that commits the team's hooks (or none), a product repository "app" and a
    /// change the plugin started.
    struct Fx {
        _dir: tempfile::TempDir,
        ws: PathBuf,
        master: PathBuf,
        head: String,
    }

    impl Fx {
        fn new(with_hooks: bool) -> Fx {
            let dir = tempfile::tempdir().unwrap();
            let ws = dir.path().to_path_buf();
            let master = testutil::repo(&ws, "hub");
            let marker = if with_hooks {
                json!({"version": 1, "systems": {"demo": {"repos": ["app"]}},
                    "hooks": {"build.finish": [{"id": "unit", "run": ["node", "-v"], "repos": ["app"]}]}})
            } else {
                json!({"version": 1, "systems": {"demo": {"repos": ["app"]}}})
            };
            testutil::commit_file(&master, ".hoshin.json", &marker.to_string(), "marker");
            let app = testutil::repo(&ws, "app");
            let head = testutil::run(&app, &["rev-parse", "HEAD"]).unwrap();
            let fx = Fx {
                _dir: dir,
                ws,
                master,
                head,
            };
            let started = program()
                .step_long(
                    &[
                        "change", "start", "--json", "--system", SYSTEM, "--change", CHANGE,
                        "--type", "feat", "--scope", "demo", "--title", "Greeting",
                    ],
                    &fx.place(),
                    &kata_core::proc::CancelToken::new(),
                    None,
                )
                .json;
            assert_eq!(started["outcome"], "passed", "{started}");
            fx
        }

        fn place(&self) -> Place {
            Place {
                layout: crate::layout::Layout::Workspace,
                master: self.master.clone(),
                workspace: self.ws.clone(),
            }
        }

        /// The ledger of "app" as the plugin writes it, in the master's git folder.
        fn ledger(&self, runs: Vec<Value>) {
            let folder = self
                .master
                .join(".git")
                .join("hoshin")
                .join(SYSTEM)
                .join(CHANGE);
            std::fs::create_dir_all(&folder).unwrap();
            let ledger = json!({"version": 1, "system": SYSTEM, "change": CHANGE, "repo": "app",
                "path": self.ws.join("app"), "runs": runs, "gateBlocks": {}});
            std::fs::write(folder.join("app.json"), ledger.to_string()).unwrap();
        }

        fn view(&self) -> RepoCheckView {
            for_change(
                &program(),
                &self.place(),
                SYSTEM,
                CHANGE,
                &["app".to_string()],
            )
            .unwrap()
            .remove(0)
        }
    }

    fn run(event: &str, key: &str, outcome: &str, hooks: Value, failed: Value) -> Value {
        json!({"event": event, "repo": "app", "key": key, "subject": null, "outcome": outcome,
            "at": "2026-11-01T10:00:00.000Z", "hooks": hooks, "problems": [], "failed": failed})
    }

    fn hook(outcome: &str, output: &str) -> Value {
        json!({"id": "unit", "when": "before", "outcome": outcome,
            "exitCode": if outcome == "passed" { json!(0) } else { json!(1) }, "output": output})
    }

    type Ran = (&'static str, &'static str, &'static str, Value, Value);

    struct Case {
        row: &'static str,
        hooks: bool,
        /// The ledger's runs; "HEAD" in a key stands for the repository's head.
        runs: Vec<Ran>,
        expect: CheckView,
        says: &'static str,
    }

    fn failing(outcome: &'static str, on_failure: &'static str) -> Ran {
        let hook_outcome = if outcome == "failed" {
            "failed"
        } else {
            "could-not-run"
        };
        (
            "build.finish",
            "HEAD",
            outcome,
            json!([hook(hook_outcome, "2 tests failed")]),
            json!({"id": "unit", "onFailure": on_failure}),
        )
    }

    const FIX_SAYS: &str =
        "unit failed. The agent is sent back to fix it, up to the team's retry limit.";

    #[test]
    fn a_repositorys_build_finish_rows() {
        let failed_output = "2 tests failed".to_string();
        let cases = vec![
            Case {
                row: "1 no hooks (R5.1 are not set)",
                hooks: false,
                runs: vec![("build.finish", "HEAD", "passed", json!([]), Value::Null)],
                expect: CheckView::NoChecks,
                says: "This repository has no checks.",
            },
            Case {
                row: "2 no run yet (a task.done run is not a check)",
                hooks: true,
                runs: vec![("task.done", "HEAD", "passed", json!([hook("passed", "")]), Value::Null)],
                expect: CheckView::NotRunYet,
                says: "The checks have not run yet.",
            },
            Case {
                row: "3 ran at an earlier head",
                hooks: true,
                runs: vec![("build.finish", OTHER_HEAD, "passed", json!([hook("passed", "")]), Value::Null)],
                expect: CheckView::Stale { head: "eeeeeee".into() },
                says: "Checks last ran at eeeeeee.",
            },
            Case {
                row: "4 passed at the head (R5.1 pass)",
                hooks: true,
                runs: vec![("build.finish", "HEAD", "passed", json!([hook("passed", "ok")]), Value::Null)],
                expect: CheckView::Passed {
                    hooks: vec![HookShown { id: "unit".into(), outcome: "passed".into() }],
                },
                says: "The checks passed.",
            },
            Case {
                row: "5 failed, marked to be fixed (R5.1)",
                hooks: true,
                runs: vec![failing("failed", "fix")],
                expect: CheckView::FailedFix { id: "unit".into(), output: failed_output.clone() },
                says: FIX_SAYS,
            },
            Case {
                row: "6 failed, marked to stop (R5.1)",
                hooks: true,
                runs: vec![failing("failed", "stop")],
                expect: CheckView::FailedStop { id: "unit".into(), output: failed_output.clone() },
                says: "unit failed. The build stopped here.",
            },
            Case {
                row: "7 could not run (R5.1)",
                hooks: true,
                runs: vec![failing("could-not-run", "fix")],
                expect: CheckView::CouldNotRun { id: "unit".into(), output: failed_output.clone() },
                says: "unit could not run on this machine. That is a fault of the machine, not of the code.",
            },
            Case {
                row: "latest run wins: a pass, then a failure at the same head",
                hooks: true,
                runs: vec![
                    ("build.finish", "HEAD", "passed", json!([hook("passed", "")]), Value::Null),
                    failing("failed", "fix"),
                ],
                expect: CheckView::FailedFix { id: "unit".into(), output: failed_output },
                says: FIX_SAYS,
            },
            Case {
                row: "a refused run checked nothing",
                hooks: true,
                runs: vec![("build.finish", "HEAD", "refused", json!([]), Value::Null)],
                expect: CheckView::NotRunYet,
                says: "The checks have not run yet.",
            },
        ];
        for case in cases {
            let fx = Fx::new(case.hooks);
            let runs = case
                .runs
                .into_iter()
                .map(|(event, key, outcome, hooks, failed)| {
                    run(
                        event,
                        if key == "HEAD" { &fx.head } else { key },
                        outcome,
                        hooks,
                        failed,
                    )
                })
                .collect();
            fx.ledger(runs);
            let got = fx.view();
            assert_eq!(got.repo, "app", "{}", case.row);
            assert_eq!(got.view, case.expect, "{}", case.row);
            assert_eq!(got.summary, case.says, "{}", case.row);
        }
    }

    /// F20: a broken hook configuration is shown with the checks, with the plugin's problems, rather
    /// than "not run yet" for ever.
    #[test]
    fn a_broken_hook_configuration_is_shown_with_the_checks() {
        let fx = Fx::new(true);
        // Broken after the change started: the plugin will run no check until it is fixed.
        let marker = json!({"version": 1, "systems": {"demo": {"repos": ["app"]}},
            "hooks": {"build.finish": [{"id": "unit", "run": ["node", "-v"], "repos": ["app"], "timeout": "soon"}]}});
        testutil::commit_file(&fx.master, ".hoshin.json", &marker.to_string(), "broken");
        let got = fx.view();
        let CheckView::ConfigBroken { output } = &got.view else {
            panic!("{got:?}");
        };
        assert!(output.contains("timeout must be"), "{output}");
        assert_eq!(
            got.summary,
            "The team's check configuration on the base branch has problems. No check runs until it is fixed."
        );
    }

    #[test]
    fn no_ledger_at_all_is_not_run_yet() {
        let fx = Fx::new(true);
        assert_eq!(fx.view().view, CheckView::NotRunYet);
    }

    #[test]
    #[serial]
    fn checks_come_from_the_master_not_this_machine() {
        let fx = Fx::new(true);
        fx.ledger(vec![run(
            "build.finish",
            &fx.head,
            "passed",
            json!([hook("passed", "ok")]),
            Value::Null,
        )]);
        let view_in = |home: &Path| {
            let old = std::env::var_os("KATA_HOME");
            std::env::set_var("KATA_HOME", home);
            let got = fx.view();
            match old {
                Some(v) => std::env::set_var("KATA_HOME", v),
                None => std::env::remove_var("KATA_HOME"),
            }
            got
        };
        let plain = tempfile::tempdir().unwrap();
        let with_old = tempfile::tempdir().unwrap();
        let checks = with_old.path().join("workbench").join("checks");
        std::fs::create_dir_all(&checks).unwrap();
        std::fs::write(
            checks.join("demo.toml"),
            "[[check]]\nrepo = \"app\"\nname = \"never\"\nargv = [\"false\"]\n",
        )
        .unwrap();
        let a = view_in(plain.path());
        let b = view_in(with_old.path());
        assert_eq!(a, b, "two machines, one master, one view");
        assert!(matches!(a.view, CheckView::Passed { .. }));
    }

    /// R5.2: in the single-repo layout each app's checks are read at the app's own head, a hook applies
    /// when its `apps` list names the app or is null, and an untouched app's no-op reads "No changes".
    #[test]
    fn single_repo_checks_are_read_per_app() {
        let dir = tempfile::tempdir().unwrap();
        let root = testutil::single_repo(
            dir.path(),
            "kata",
            &[
                ("engine", "crates/engine"),
                ("workbench", "app"),
                ("docs", "docs"),
                ("cli", "cli"),
            ],
        );
        let marker = json!({"version": 1, "layout": "single-repo",
        "systems": {"kata": {"apps": {"engine": "crates/engine", "workbench": "app", "docs": "docs", "cli": "cli"}}},
        "hooks": {"build.finish": [
            {"id": "unit", "run": ["node", "-v"], "apps": ["engine", "workbench"]},
            {"id": "lint", "run": ["node", "-v"], "apps": ["docs"]}
        ]}});
        testutil::commit_file(&root, ".hoshin.json", &marker.to_string(), "hooks");
        let place = Place {
            layout: crate::layout::Layout::SingleRepo,
            master: root.clone(),
            workspace: dir.path().to_path_buf(),
        };
        let started = program()
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
        // The change holds its intent in its copy, which is what makes `state` find it.
        let doc = std::path::PathBuf::from(started["details"]["copy"].as_str().unwrap())
            .join("intent/kata")
            .join(CHANGE);
        std::fs::create_dir_all(&doc).unwrap();
        std::fs::write(doc.join("intent.md"), "# Greeting\n").unwrap();
        let state = crate::hoshin::state::one(&program(), &place, "kata", CHANGE)
            .unwrap()
            .unwrap();
        let head_of = |app: &str| state.apps.as_ref().unwrap()[app].head.clone().unwrap();
        let write = |app: &str, key: &str, outcome: &str, extra: Value| {
            let mut entry = run("build.finish", key, outcome, json!([]), Value::Null);
            entry["repo"] = json!(app);
            for (k, v) in extra.as_object().unwrap() {
                entry[k] = v.clone();
            }
            let folder = root.join(".git").join("hoshin").join("kata").join(CHANGE);
            std::fs::create_dir_all(&folder).unwrap();
            let ledger = json!({"version": 1, "system": "kata", "change": CHANGE, "repo": app,
                "path": root, "runs": [entry], "gateBlocks": {}});
            std::fs::write(folder.join(format!("{app}.json")), ledger.to_string()).unwrap();
        };
        write(
            "engine",
            &head_of("engine"),
            "passed",
            json!({"hooks": [hook("passed", "ok")]}),
        );
        write(
            "workbench",
            &head_of("workbench"),
            "failed",
            json!({"hooks": [hook("failed", "2 tests failed")],
                "failed": {"id": "unit", "onFailure": "fix"}}),
        );
        write(
            "docs",
            &head_of("docs"),
            "passed",
            json!({"details": {"untouched": true}}),
        );
        let views = for_change(
            &program(),
            &place,
            "kata",
            CHANGE,
            &["engine", "workbench", "docs", "cli"].map(String::from),
        )
        .unwrap();
        let by = |app: &str| views.iter().find(|v| v.repo == app).unwrap().clone();
        assert_eq!(
            by("engine").view,
            CheckView::Passed {
                hooks: vec![HookShown {
                    id: "unit".into(),
                    outcome: "passed".into()
                }]
            }
        );
        assert_eq!(
            by("workbench").view,
            CheckView::FailedFix {
                id: "unit".into(),
                output: "2 tests failed".into()
            }
        );
        assert_eq!(by("docs").view, CheckView::NoChanges);
        assert_eq!(by("docs").summary, "No changes to check");
        assert_eq!(by("cli").view, CheckView::NoChecks);
    }

    /// A node script standing in for the program: it prints, for `status`, `baseline show`, `checks` and
    /// `hooks`, the answer scripted for that command, and `null` for one that was not scripted.
    struct Scripted {
        _dir: tempfile::TempDir,
        program: Program,
        place: Place,
    }

    fn scripted(answers: Value) -> Scripted {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("answers.json"), answers.to_string()).unwrap();
        let entry = dir.path().join("scripted.js");
        std::fs::write(
            &entry,
            "const a = require('./answers.json'); const args = process.argv.slice(2);\n\
             const key = args[0] === 'baseline' ? 'baseline ' + args[1] : args[0];\n\
             process.stdout.write(JSON.stringify(a[key] === undefined ? null : a[key]) + '\\n');",
        )
        .unwrap();
        let place = Place {
            layout: Layout::Workspace,
            master: dir.path().to_path_buf(),
            workspace: dir.path().to_path_buf(),
        };
        Scripted {
            program: Program {
                node: "node".into(),
                entry,
            },
            place,
            _dir: dir,
        }
    }

    fn hook_list(ids: &[&str]) -> Value {
        let hooks: Vec<Value> = ids
            .iter()
            .map(|id| json!({"id": id, "event": "build.finish", "when": "before", "blocking": true,
                "onFailure": "stop", "timeout": 600, "repos": ["app"]}))
            .chain([
                json!({"id": "elsewhere", "event": "build.finish", "when": "before", "blocking": true,
                    "onFailure": "stop", "timeout": 600, "repos": ["other"]}),
            ])
            .collect();
        json!({"hooks": hooks, "problems": []})
    }

    fn start_run(outcome: &str, baseline: Option<Value>, problems: &[&str]) -> Value {
        let mut run = json!({"event": "build.start", "key": "h1", "outcome": outcome,
            "problems": problems, "hooks": []});
        if let Some(b) = baseline {
            run["details"] = json!({ "baseline": b });
        }
        run
    }

    fn finish_run(outcome: &str) -> Value {
        json!({"event": "build.finish", "key": "h1", "outcome": outcome, "hooks": [], "problems": []})
    }

    fn ledger_of(runs: Vec<Value>) -> Value {
        json!({"repos": [{"repo": "app", "head": "h1", "runs": runs}]})
    }

    fn failing_base(base: &str, ids: &[&str]) -> Value {
        let failing: Vec<Value> = ids.iter().map(|i| json!({"id": i, "ids": null})).collect();
        json!({"base": base, "reused": false, "failing": failing, "approved": []})
    }

    fn base_hook(id: &str, outcome: &str, ids: Value, output: &str) -> Value {
        json!({"id": id, "outcome": outcome, "exitCode": if outcome == "passed" { 0 } else { 1 },
            "ids": ids, "output": output})
    }

    fn baseline_of(base: &str, hooks: Vec<Value>, needs: &[&str], approved: &[&str]) -> Value {
        json!({"base": base, "hooks": hooks, "needsApproval": needs, "approved": approved})
    }

    fn event(check: &str, state: &str, outcome: Value) -> Value {
        json!({"check": check, "state": state, "startedAt": "2026-11-16T10:00:00.000Z",
            "endedAt": if state == "ended" { json!("2026-11-16T10:00:05.000Z") } else { Value::Null },
            "timeout": 600, "outcome": outcome, "ids": null, "blocks": null})
    }

    fn base_run(run: &str, phase: &str, checks: Vec<Value>) -> Value {
        json!({"run": run, "event": "build.finish", "repo": "app", "phase": phase, "checks": checks})
    }

    fn checks_answer(runs: Vec<Value>) -> Value {
        json!({"system": "demo", "change": "c", "runs": runs})
    }

    fn read(s: &Scripted) -> StartChecks {
        start_checks(&s.program, &s.place, "demo", "c", &["app".to_string()])
            .unwrap()
            .remove(0)
    }

    fn check_of<'a>(checks: &'a [BaseCheck], id: &str) -> &'a BaseCheck {
        checks.iter().find(|c| c.check == id).unwrap()
    }

    /// R8.1: each row of the decision table, from the workflow's answers.
    #[test]
    fn start_checks_shows_the_record_r8_1() {
        let unit_fails = |needs: &[&str], approved: &[&str], base: &str| {
            baseline_of(
                base,
                vec![
                    base_hook("unit", "failed", Value::Null, "a\nb"),
                    base_hook("lint", "passed", Value::Null, ""),
                ],
                needs,
                approved,
            )
        };
        let stopped = || {
            ledger_of(vec![start_run(
                "failed",
                Some(failing_base("b1", &["unit"])),
                &["unit failed on the base"],
            )])
        };
        let rows: Vec<(&str, Value, Value, StartShown)> = vec![
            (
                "none",
                ledger_of(vec![]),
                Value::Null,
                StartShown::Startable,
            ),
            (
                "stopped, some need a decision",
                stopped(),
                unit_fails(&["unit"], &[], "b1"),
                StartShown::BaseFailure,
            ),
            (
                "stopped, all accepted",
                stopped(),
                unit_fails(&[], &["unit"], "b1"),
                StartShown::AllAccepted,
            ),
            (
                "stopped, the base moved",
                stopped(),
                baseline_of("b2", vec![], &[], &[]),
                StartShown::BaseMoved,
            ),
            (
                "refused",
                ledger_of(vec![start_run(
                    "refused",
                    None,
                    &["build.start is refused: no plan"],
                )]),
                Value::Null,
                StartShown::OtherReason {
                    reason: "build.start is refused: no plan".into(),
                    step: None,
                    output: String::new(),
                },
            ),
            (
                "started",
                ledger_of(vec![start_run(
                    "passed",
                    Some(failing_base("b1", &[])),
                    &[],
                )]),
                Value::Null,
                StartShown::UnderWay,
            ),
            (
                "started and finished",
                ledger_of(vec![
                    start_run("passed", Some(failing_base("b1", &[])), &[]),
                    finish_run("passed"),
                ]),
                Value::Null,
                StartShown::Finished,
            ),
            (
                "started and the finish failed",
                ledger_of(vec![
                    start_run("passed", Some(failing_base("b1", &[])), &[]),
                    finish_run("failed"),
                ]),
                Value::Null,
                StartShown::FinishFailure,
            ),
        ];
        for (row, ledger, baseline, expected) in rows {
            let s = scripted(json!({"status": ledger, "baseline show": baseline,
                "checks": checks_answer(vec![]), "hooks": hook_list(&["unit", "lint"])}));
            let got = read(&s);
            assert_eq!(got.shown, expected, "{row}");
            assert_eq!(got.repo, "app", "{row}");
        }
        // The failure row carries the check, its output, the folded count and why Start is held.
        let s = scripted(
            json!({"status": stopped(), "baseline show": unit_fails(&["unit"], &[], "b1"),
            "checks": checks_answer(vec![]), "hooks": hook_list(&["unit", "lint"])}),
        );
        let got = read(&s);
        assert_eq!(got.base, "b1");
        assert_eq!(got.passed, 1);
        assert_eq!(
            got.start_held.as_deref(),
            Some("Accept or fix the failing checks first.")
        );
        let unit = check_of(&got.checks, "unit");
        assert_eq!(unit.state, BaseCheckState::Failed);
        assert_eq!(
            (unit.exit_code, unit.output.as_str(), unit.line_count),
            (Some(1), "a\nb", 2)
        );
        assert!(unit.can_accept && !unit.accepted);
        assert_eq!(check_of(&got.checks, "lint").state, BaseCheckState::Passed);
        assert_eq!(
            got.checks.len(),
            2,
            "a hook of another repository is not listed"
        );
    }

    /// R7.1 and R7.3: a failure at finish says which check, how it stood on the base, its output, what
    /// happened next and how many other checks passed; it is never accepted.
    #[test]
    fn finish_failure_says_what_happens_next_r7_1() {
        let rows = [
            (
                "app-speed",
                "fix",
                "passed",
                FinishBase::Passed,
                FinishNext::SentBackNotFixed,
            ),
            (
                "rust-test",
                "stop",
                "passed",
                FinishBase::Passed,
                FinishNext::Stopped,
            ),
            (
                "app-lint",
                "fix",
                "failed",
                FinishBase::AddedFailures,
                FinishNext::SentBackNotFixed,
            ),
        ];
        for (check, on_failure, base_outcome, base, next) in rows {
            let mut hooks: Vec<Value> = ["a-ok", "b-ok"]
                .iter()
                .map(|id| json!({"id": id, "outcome": "passed", "output": ""}))
                .collect();
            hooks.push(json!({"id": check, "outcome": "failed", "output": "it broke"}));
            let mut finish = finish_run("failed");
            finish["hooks"] = json!(hooks);
            finish["failed"] = json!({"id": check, "onFailure": on_failure});
            let s = scripted(json!({
                "status": ledger_of(vec![
                    start_run("passed", Some(failing_base("b1", &[])), &[]),
                    finish,
                ]),
                "checks": checks_answer(vec![base_run(
                    "r1",
                    "baseline",
                    vec![event(check, "ended", json!(base_outcome))],
                )]),
                "hooks": hook_list(&[check, "a-ok", "b-ok"])}));
            let got = read(&s);
            assert_eq!(got.shown, StartShown::FinishFailure, "{check}");
            assert_eq!(
                got.finish,
                Some(FinishFailure {
                    check: check.into(),
                    base,
                    output: "it broke".into(),
                    passed: 2,
                    next,
                    can_accept: false,
                }),
                "{check}"
            );
        }
    }

    /// R5.5: a check that names its failures cannot be accepted and does not stop the build.
    #[test]
    fn only_unnamed_failures_can_be_accepted_r5_5() {
        let ledger = || {
            ledger_of(vec![start_run(
                "failed",
                Some(failing_base("b1", &["unit", "lint"])),
                &["lint needs a decision"],
            )])
        };
        let hooks = || {
            vec![
                base_hook("unit", "failed", json!(["t1"]), "t1 failed"),
                base_hook("lint", "failed", Value::Null, "boom"),
            ]
        };
        let s = scripted(json!({"status": ledger(),
            "baseline show": baseline_of("b1", hooks(), &["lint"], &[]),
            "checks": checks_answer(vec![]), "hooks": hook_list(&["unit", "lint"])}));
        let got = read(&s);
        assert_eq!(got.shown, StartShown::BaseFailure);
        assert!(!check_of(&got.checks, "unit").can_accept);
        assert!(check_of(&got.checks, "lint").can_accept);
        // Once the unnamed one is accepted nothing is left, though the named one still fails.
        let s = scripted(json!({"status": ledger(),
            "baseline show": baseline_of("b1", hooks(), &[], &["lint"]),
            "checks": checks_answer(vec![]), "hooks": hook_list(&["unit", "lint"])}));
        let got = read(&s);
        assert_eq!(got.shown, StartShown::AllAccepted);
        let (unit, lint) = (check_of(&got.checks, "unit"), check_of(&got.checks, "lint"));
        assert!(!unit.can_accept && !unit.accepted);
        assert!(lint.accepted && !lint.can_accept);
        assert_eq!(got.start_held, None);
    }

    /// R11.2: a start recorded before hoshin kept base results shows its reason once and offers no accept.
    #[test]
    fn older_build_shows_its_reason_once_r11_2() {
        let mut run = start_run("failed", None, &["unit failed on the base"]);
        run["failed"] = json!({"id": "unit", "onFailure": "stop"});
        run["hooks"] = json!([{"id": "unit", "outcome": "failed", "output": "boom"}]);
        // No `baseline show` is scripted: reading it would be an error.
        let s = scripted(json!({"status": ledger_of(vec![run]),
            "checks": checks_answer(vec![]), "hooks": hook_list(&["unit"])}));
        let got = read(&s);
        assert_eq!(
            got.shown,
            StartShown::OtherReason {
                reason: "unit failed on the base".into(),
                step: Some("unit".into()),
                output: "boom".into()
            }
        );
        assert!(got.checks.iter().all(|c| !c.can_accept));
        assert_eq!(got.start_held, None);
    }

    /// R4.3: the setup hint shows from three checks failing without saying what failed.
    #[test]
    fn setup_hint_at_three_or_more_r4_3() {
        for (count, hint) in [(1usize, false), (2, false), (3, true), (9, true)] {
            let ids: Vec<String> = (1..=count).map(|n| format!("c{n}")).collect();
            let names: Vec<&str> = ids.iter().map(String::as_str).collect();
            let hooks = ids
                .iter()
                .map(|id| base_hook(id, "failed", Value::Null, "x"))
                .collect();
            let s = scripted(json!({
                "status": ledger_of(vec![start_run("failed", Some(failing_base("b1", &names)), &["x"])]),
                "baseline show": baseline_of("b1", hooks, &names, &[]),
                "checks": checks_answer(vec![]),
                "hooks": hook_list(&names)}));
            let got = read(&s);
            assert_eq!(got.shown, StartShown::BaseFailure, "{count}");
            assert_eq!(got.setup_hint, hint, "{count}");
        }
    }

    /// R2.4 and R2.5: the latest run on the base decides each check's state; hoshin's `abandoned` is cut
    /// off, and a check of the hook list with no event in that run is not run.
    #[test]
    fn cut_off_and_elsewhere_rows_r2_4_r2_5() {
        let old = base_run(
            "r1",
            "baseline",
            vec![
                event("a", "ended", json!("passed")),
                event("b", "ended", json!("passed")),
                event("c", "ended", json!("passed")),
            ],
        );
        let head = base_run("r2", "head", vec![event("a", "ended", json!("failed"))]);
        for (second, expected) in [
            ("abandoned", BaseCheckState::CutOff),
            ("running", BaseCheckState::Running),
        ] {
            let latest = base_run(
                "r3",
                "baseline",
                vec![
                    event("a", "ended", json!("passed")),
                    event("b", second, Value::Null),
                ],
            );
            let s = scripted(json!({"status": ledger_of(vec![]),
                "checks": checks_answer(vec![old.clone(), head.clone(), latest]),
                "hooks": hook_list(&["a", "b", "c"])}));
            let got = read(&s);
            assert_eq!(got.shown, StartShown::Startable);
            let states: Vec<_> = got
                .checks
                .iter()
                .map(|c| (c.check.as_str(), c.state))
                .collect();
            assert_eq!(
                states,
                [
                    ("a", BaseCheckState::Passed),
                    ("b", expected),
                    ("c", BaseCheckState::NotRun)
                ]
            );
            assert_eq!(
                check_of(&got.checks, "b").started_at.as_deref(),
                Some("2026-11-16T10:00:00.000Z")
            );
            assert_eq!(check_of(&got.checks, "b").ended_at, None);
            assert_eq!(got.passed, 1);
        }
    }
}
