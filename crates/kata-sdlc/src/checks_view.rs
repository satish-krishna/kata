//! What a repository's checks came to, shown from what the plugin recorded. Checks are the team's
//! `build.finish` hooks, committed to the master's base branch and run by the plugin when a repository's
//! build finishes; Kata runs none of them. This module only reads the plugin's ledger and hook list and
//! names the state the page shows, in the words it shows.
use crate::ai_sdlc::status::{Hooks, OnFailure, Status};
use crate::ai_sdlc::{Place, Program, ProgramError};
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
    /// No `build.finish` hook is configured for the repository.
    NoChecks,
    /// Checks are configured and have not run.
    NotRunYet,
    /// The checks last ran at an earlier head; `head` is that head, shortened.
    Stale { head: String },
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

/// The state of `repo`'s checks at `head`.
pub fn of(_status: &Status, _repo: &str, _head: &str, _hooks: &Hooks) -> CheckView {
    CheckView::NoChecks
}

/// The sentence the page shows for a view.
pub fn summary(_view: &CheckView) -> String {
    String::new()
}

/// The checks of each of `repos` in `change`, read from the plugin.
pub fn for_change(
    _program: &Program,
    _place: &Place,
    _system: &str,
    _change: &str,
    _repos: &[String],
) -> Result<Vec<RepoCheckView>, ProgramError> {
    Err(ProgramError::CouldNotRun {
        message: "not built".into(),
    })
}

#[allow(unused)]
fn _uses(_: OnFailure) {}

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
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts"),
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
            let master = testutil::repo(&ws, "ai-sdlc");
            let marker = if with_hooks {
                json!({"version": 1, "systems": {"demo": {"repos": ["app"]}},
                    "hooks": {"build.finish": [{"id": "unit", "run": ["node", "-v"], "repos": ["app"]}]}})
            } else {
                json!({"version": 1, "systems": {"demo": {"repos": ["app"]}}})
            };
            testutil::commit_file(&master, ".ai-sdlc.json", &marker.to_string(), "marker");
            let app = testutil::repo(&ws, "app");
            let head = testutil::run(&app, &["rev-parse", "HEAD"]).unwrap();
            let fx = Fx {
                _dir: dir,
                ws,
                master,
                head,
            };
            let started = program()
                .run(
                    &[
                        "change", "start", "--json", "--system", SYSTEM, "--change", CHANGE,
                        "--type", "feat", "--scope", "demo", "--title", "Greeting",
                    ],
                    &fx.place(),
                )
                .unwrap();
            assert_eq!(started["outcome"], "passed", "{started}");
            fx
        }

        fn place(&self) -> Place {
            Place {
                master: self.master.clone(),
                workspace: self.ws.clone(),
            }
        }

        /// The ledger of "app" as the plugin writes it, in the master's git folder.
        fn ledger(&self, runs: Vec<Value>) {
            let folder = self
                .master
                .join(".git")
                .join("ai-sdlc")
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
}
