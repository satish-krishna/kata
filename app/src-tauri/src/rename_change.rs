//! Renaming a change's branch: the plugin renames it in the master, the change's copy and every product
//! repository that has it, all or nothing. Kata renames no branch itself; a refusal is the plugin's own
//! reasons, as it printed them.
use kata_sdlc::ai_sdlc::{Place, Program, StepOutcome};
use kata_sdlc::prs::PrEntry;
use kata_sdlc::pull_requests::{recorded, RecordedPullRequest};
use serde::Serialize;

/// What renaming a change's branch came to.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum RenameOutcome {
    /// The plugin moved the branch; `repos` are the repositories it moved it in.
    Renamed {
        from: String,
        to: String,
        repos: Vec<String>,
        /// The change's pull requests, opened from the old name: the engineer closes them by hand.
        old_pull_requests: Vec<RecordedPullRequest>,
    },
    /// The plugin renamed nothing; `problems` are its words.
    Refused { problems: Vec<String> },
}

/// Asks the plugin to rename `change`'s branch to `to`. `legacy` are the pull requests Kata saved before
/// the plugin recorded them. An `Err` is a plugin that could not run at all; a refusal is an answer.
pub fn rename_change(
    program: &Program,
    place: &Place,
    system: &str,
    change: &str,
    to: &str,
    legacy: &[PrEntry],
) -> Result<RenameOutcome, String> {
    // The pull requests are read first: after the rename the engineer is told which were opened from the old name.
    let before = program
        .change_show(place, change, false)
        .map_err(|e| e.to_string())?;
    let old_pull_requests = recorded(&before, legacy);
    let command = [
        "change", "rename", "--json", "--system", system, "--change", change, "--to", to,
    ];
    let answer = program.step(&command, place);
    match answer.outcome {
        StepOutcome::Passed { .. } => {}
        StepOutcome::Refused { problems } | StepOutcome::Failed { problems, .. } => {
            return Ok(RenameOutcome::Refused { problems })
        }
        StepOutcome::CouldNotRun { reason, .. } => return Err(reason),
    }
    let answer = answer.json;
    let text = |key: &str| answer[key].as_str().map(str::to_string);
    let list = |key: &str| -> Vec<String> {
        answer[key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    match (text("from"), text("to")) {
        (Some(from), Some(to)) => Ok(RenameOutcome::Renamed {
            from,
            to,
            repos: list("renamed"),
            old_pull_requests,
        }),
        _ => Err(format!(
            "the plugin renamed {change} but named no branches: {answer}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const SYSTEM: &str = "demo";
    const CHANGE: &str = "2026-11-01-password-reset";
    const MARKER: &str = r#"{"version":1,"systems":{"demo":{"repos":["app"]}}}"#;

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../crates/kata-sdlc/tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A workspace with a master repository and the product repository `app`, and a change started by
    /// the plugin, with its branch in the master, in its copy and in `app`.
    struct Fx {
        _dir: tempfile::TempDir,
        place: Place,
        copy: PathBuf,
        branch: String,
    }

    fn fixture() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_path_buf();
        for name in ["ai-sdlc", "app"] {
            let repo = ws.join(name);
            std::fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init", "-q", "-b", "main"]);
            git(&repo, &["config", "user.name", "Test"]);
            git(&repo, &["config", "user.email", "test@example.com"]);
            git(&repo, &["config", "commit.gpgsign", "false"]);
        }
        let master = ws.join("ai-sdlc");
        std::fs::write(master.join(".ai-sdlc.json"), MARKER).unwrap();
        git(&master, &["add", "."]);
        git(&master, &["commit", "-q", "-m", "marker"]);
        std::fs::write(ws.join("app").join("a.txt"), "a").unwrap();
        git(&ws.join("app"), &["add", "."]);
        git(&ws.join("app"), &["commit", "-q", "-m", "init"]);
        let place = Place {
            master,
            workspace: ws.clone(),
        };
        let started = crate::start_change::start_change(
            &program(),
            &place,
            "2026-11-01",
            &crate::start_change::StartRequest {
                system: SYSTEM,
                title: "Password reset",
                work_type: "feat",
                scope: "X-1",
                branch: None,
            },
        )
        .unwrap();
        let crate::start_change::ChangeStart::Started { branch, copy, .. } = started else {
            panic!("{started:?}");
        };
        // The change's work has begun in the product repository: it has the change's branch too.
        git(&ws.join("app"), &["branch", &branch]);
        Fx {
            _dir: dir,
            place,
            copy: copy.into(),
            branch,
        }
    }

    fn record_file(fx: &Fx) -> PathBuf {
        fx.copy
            .join("intent")
            .join(SYSTEM)
            .join(CHANGE)
            .join("change.yml")
    }

    /// Every branch of the master and of `app`, the branch the copy is on and the copy's record.
    fn standing(fx: &Fx) -> (String, String, String, String) {
        let list = |p: &Path| git(p, &["branch", "--format=%(refname:short)"]);
        (
            list(&fx.place.master),
            list(&fx.place.workspace.join("app")),
            git(&fx.copy, &["branch", "--show-current"]),
            std::fs::read_to_string(record_file(fx)).unwrap(),
        )
    }

    /// The change has opened a pull request from its branch: the plugin's record in the copy says so.
    fn with_recorded_pull_request(fx: &Fx) {
        let file = record_file(fx);
        let mut text = std::fs::read_to_string(&file).unwrap();
        text.push_str("pullRequests:\n  - repo: \"app\"\n    url: \"https://github.com/o/app/pull/7\"\n    number: 7\n    pushed: \"3f2a9c1e4b7d\"\n");
        std::fs::write(&file, text).unwrap();
        git(&fx.copy, &["add", "."]);
        git(&fx.copy, &["commit", "-q", "-m", "record pull requests"]);
    }

    #[test]
    fn renaming_goes_through_the_plugin() {
        // One case per Examples row of R2.3.
        {
            // "renames it in every repository"
            let fx = fixture();
            with_recorded_pull_request(&fx);
            let outcome =
                rename_change(&program(), &fx.place, SYSTEM, CHANGE, "feat/X-1-reset", &[])
                    .unwrap();
            let RenameOutcome::Renamed {
                from,
                to,
                repos,
                old_pull_requests,
            } = outcome
            else {
                panic!("{outcome:?}");
            };
            assert_eq!(from, fx.branch);
            assert_eq!(to, "feat/X-1-reset");
            assert!(
                repos.contains(&"master".to_string()) && repos.contains(&"app".to_string()),
                "{repos:?}"
            );
            // The change shows its new branch name, everywhere the old one was.
            let (master, app, copy_branch, record) = standing(&fx);
            for list in [&master, &app] {
                assert!(list.lines().any(|b| b == "feat/X-1-reset"), "{list}");
                assert!(!list.lines().any(|b| b == fx.branch), "{list}");
            }
            assert_eq!(copy_branch, "feat/X-1-reset");
            assert!(record.contains("branch: \"feat/X-1-reset\""), "{record}");
            let shown = program().change_show(&fx.place, CHANGE, false).unwrap();
            assert_eq!(shown.branch, "feat/X-1-reset");
            // The pull requests opened from the old name are listed to close by hand.
            assert_eq!(old_pull_requests.len(), 1);
            assert_eq!(old_pull_requests[0].repo, "app");
            assert_eq!(old_pull_requests[0].url, "https://github.com/o/app/pull/7");
        }
        {
            // "refuses it, giving its reasons": the new name is taken by a branch of the product repository.
            let fx = fixture();
            let before = standing(&fx);
            let outcome =
                rename_change(&program(), &fx.place, SYSTEM, CHANGE, "main", &[]).unwrap();
            let RenameOutcome::Refused { problems } = outcome else {
                panic!("{outcome:?}");
            };
            // The plugin's reasons, as it printed them.
            assert!(
                problems.iter().any(|p| p.contains("is taken in")),
                "{problems:?}"
            );
            // Nothing is renamed anywhere.
            assert_eq!(standing(&fx), before);
        }
    }
}
