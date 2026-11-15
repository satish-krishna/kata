//! What `red show` prints: whether a task's red was observed on this machine and the output the program
//! stored when it ran the task's test. Kata never reads the ledger itself; the program answers.
use super::{Place, Program, ProgramError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The record the program stored when it ran a task's test at the task's test commit.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct StoredRed {
    /// The commit the test ran at, in full.
    pub commit: String,
    /// `failed`, `passed`, `could-not-compile` or `could-not-run`.
    pub outcome: String,
    /// The last lines of the command's output, with terminal color codes removed.
    pub output: String,
}

/// Whether red was observed for a task, why not when it was not, and the stored record behind it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RedRecord {
    pub observed: bool,
    /// None when red was observed.
    pub reason: Option<String>,
    /// None when the program has no record for the task on this machine.
    pub stored: Option<StoredRed>,
}

#[derive(Deserialize)]
struct Shown {
    observed: bool,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    record: Option<Stored>,
}

#[derive(Deserialize)]
struct Stored {
    commit: String,
    outcome: String,
    #[serde(default)]
    output: String,
}

/// Reads the program's `red show --json` answer.
pub fn read_red(answer: Value) -> Result<RedRecord, ProgramError> {
    let shown: Shown = serde_json::from_value(answer).map_err(|e| ProgramError::CouldNotRun {
        message: format!("the red show answer is not what this version reads: {e}"),
    })?;
    Ok(RedRecord {
        observed: shown.observed,
        reason: shown.reason,
        stored: shown.record.map(|r| StoredRed {
            commit: r.commit,
            outcome: r.outcome,
            output: kata_core::proc::strip_ansi(&r.output),
        }),
    })
}

/// The stored red record of `task` in `repo` of `change` (`red show --json`). It runs nothing.
pub fn show(
    program: &Program,
    place: &Place,
    change: &str,
    repo: &str,
    task: &str,
) -> Result<RedRecord, ProgramError> {
    let answer = program.run(
        &[
            "red", "show", "--json", "--change", change, "--repo", repo, "--task", task,
        ],
        place,
    )?;
    read_red(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Layout;
    use std::fs;
    use std::path::{Path, PathBuf};

    const SYS: &str = "kata";
    const CHG: &str = "2026-11-15-red";

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/hoshin-tools/hoshin.ts"),
        }
    }

    fn git(repo: &Path, args: &[&str]) {
        crate::testutil::run(repo, args).unwrap_or_else(|e| panic!("git {args:?}: {e:?}"));
    }

    fn init(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.name", "Test"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
    }

    fn plan() -> String {
        let task = "### T1: Task T1\n\n```yaml\nid: T1\nrepo: kata\ndepends_on: []\nuses: []\nfiles: [src/t1.rs]\ncovers: [R1.1]\ntest: [\"node\", \"-e\", \"console.log('\\\\u001b[31mFAIL\\\\u001b[0m'); process.exit(1)\"]\n```\n\n#### Change\n\nDo it.\n\n#### Tests\n\nTest it.\n\n#### Done when\n\nIt passes.\n\n";
        format!("---\nlayout: 2\nsource_spec: {CHG}/spec.md\nsource_spec_commit: 0123456789abcdef0123456789abcdef01234567\nsystem: kata\ndate: 2026-11-15\nauthor: Test\nstatus: accepted\n---\n\n# Plan: Red\n\n## Tasks\n\n{task}")
    }

    /// A workspace holding a master with the change's plan and a product repository `kata` whose branch
    /// holds one `test` commit of T1.
    fn workspace(tmp: &Path) -> Place {
        let ws = tmp.join("ws");
        let master = ws.join("master");
        init(&master);
        fs::write(
            master.join(".hoshin.json"),
            r#"{"version":1,"systems":{"kata":{"repos":["kata"]}}}"#,
        )
        .unwrap();
        let folder = master.join(format!("intent/{SYS}/{CHG}"));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("plan.md"), plan()).unwrap();
        git(&master, &["add", "."]);
        git(&master, &["commit", "-q", "-m", "master"]);
        let repo: PathBuf = ws.join("kata");
        init(&repo);
        fs::write(repo.join("a.txt"), "a").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "base"]);
        git(&repo, &["checkout", "-q", "-b", "change/x"]);
        fs::write(repo.join("t.txt"), "t").unwrap();
        git(&repo, &["add", "."]);
        git(
            &repo,
            &[
                "commit",
                "-q",
                "-m",
                "test(kata): T1 fails\n\nPlan-Task: T1\nGenerated-By: hoshin",
            ],
        );
        Place {
            layout: Layout::Workspace,
            master,
            workspace: ws,
        }
    }

    #[test]
    fn no_ledger_is_not_observed_with_the_programs_reason() {
        let tmp = tempfile::tempdir().unwrap();
        let place = workspace(tmp.path());
        let got = show(&program(), &place, CHG, "kata", "T1").unwrap();
        assert_eq!(
            got,
            RedRecord {
                observed: false,
                reason: Some("no red recorded for T1 on this machine".into()),
                stored: None,
            }
        );
    }

    #[test]
    fn a_recorded_red_shows_its_outcome_and_output_without_color_codes() {
        let tmp = tempfile::tempdir().unwrap();
        let place = workspace(tmp.path());
        let program = program();
        let record = program
            .run(
                &[
                    "red", "record", "--json", "--change", CHG, "--repo", "kata", "--task", "T1",
                ],
                &place,
            )
            .unwrap();
        assert_eq!(record["outcome"], "failed", "{record}");
        let got = show(&program, &place, CHG, "kata", "T1").unwrap();
        assert!(got.observed, "{got:?}");
        assert_eq!(got.reason, None);
        let stored = got.stored.unwrap();
        assert_eq!(stored.outcome, "failed");
        assert_eq!(stored.commit.len(), 40);
        assert!(stored.output.contains("FAIL"), "{}", stored.output);
        assert!(!stored.output.contains('\u{1b}'), "{:?}", stored.output);
    }
}
