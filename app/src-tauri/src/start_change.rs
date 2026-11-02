//! Starting a change: the plugin makes the change's branch and its own copy of the master repository,
//! and Kata only asks. Kata never creates a branch or a copy itself; a refusal is the plugin's own reason,
//! sorted by what the engineer can do about it.
use kata_sdlc::ai_sdlc::{Place, Program};
use serde::Serialize;

/// Why the plugin refused to start a change, by what the engineer can change.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum StartRefusal {
    /// The branch name is taken: ask for another one.
    BranchTaken,
    /// The branch name is not usable: ask for another one.
    BranchInvalid,
    /// The team's naming setting is broken: starting is refused until it is fixed.
    Naming,
    /// The scope is not accepted: ask for another one.
    Scope,
    /// Anything else; the problems say what.
    Other,
}

/// What starting a change came to.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ChangeStart {
    /// The change has its branch and its copy, where its documents are written.
    Started {
        change: String,
        branch: String,
        copy: String,
    },
    /// The plugin refused and made nothing; `problems` are its words, as it printed them.
    Refused {
        kind: StartRefusal,
        problems: Vec<String>,
    },
}

/// What the engineer chose for the new change.
pub struct StartRequest<'a> {
    pub system: &'a str,
    pub title: &'a str,
    pub work_type: &'a str,
    /// Empty when the system has no naming setting: the system's own commit scope is used.
    pub scope: &'a str,
    pub branch: Option<&'a str>,
}

/// Asks the plugin to start a change named from `date` and the title. An `Err` is a plugin that could not
/// run at all; a refusal is an answer.
pub fn start_change(
    program: &Program,
    place: &Place,
    date: &str,
    request: &StartRequest,
) -> Result<ChangeStart, String> {
    let _ = (program, place, date, request);
    Ok(ChangeStart::Refused {
        kind: StartRefusal::Other,
        problems: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const DATE: &str = "2026-11-01";
    const CHANGE: &str = "2026-11-01-password-reset";

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

    /// A workspace with a master repository holding `marker` and a product repository `app`.
    fn workspace(marker: &str) -> (tempfile::TempDir, Place) {
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
        std::fs::write(master.join(".ai-sdlc.json"), marker).unwrap();
        git(&master, &["add", "."]);
        git(&master, &["commit", "-q", "-m", "marker"]);
        std::fs::write(ws.join("app").join("a.txt"), "a").unwrap();
        git(&ws.join("app"), &["add", "."]);
        git(&ws.join("app"), &["commit", "-q", "-m", "init"]);
        (
            dir,
            Place {
                master,
                workspace: ws,
            },
        )
    }

    const PLAIN: &str = r#"{"version":1,"systems":{"demo":{"repos":["app"]}}}"#;
    const NAMED: &str = r#"{"version":1,"systems":{"demo":{"repos":["app"],"naming":{"branch":"{type}/{scope}-{slug}","pullRequestTitle":"{type}({scope}): {title}"}}}}"#;
    const BROKEN: &str = r#"{"version":1,"systems":{"demo":{"repos":["app"],"naming":{"branch":"{type}/{scope}-{slug}"}}}}"#;

    fn request<'a>(scope: &'a str, branch: Option<&'a str>) -> StartRequest<'a> {
        StartRequest {
            system: "demo",
            title: "Password reset",
            work_type: "feat",
            scope,
            branch,
        }
    }

    fn start(place: &Place, scope: &str, branch: Option<&str>) -> ChangeStart {
        start_change(&program(), place, DATE, &request(scope, branch)).unwrap()
    }

    fn started(outcome: ChangeStart) -> (String, String, PathBuf) {
        match outcome {
            ChangeStart::Started {
                change,
                branch,
                copy,
            } => (change, branch, PathBuf::from(copy)),
            other => panic!("{other:?}"),
        }
    }

    /// Everything about the engineer's checkout of the master that a start could disturb.
    fn checkout_state(place: &Place) -> (String, String, String) {
        (
            git(&place.master, &["branch", "--show-current"]),
            git(&place.master, &["status", "--porcelain"]),
            git(&place.master, &["rev-parse", "HEAD"]),
        )
    }

    fn branches(place: &Place) -> String {
        git(&place.master, &["branch", "--format=%(refname:short)"])
    }

    #[test]
    fn a_new_change_starts_with_the_plugins_branch_and_copy() {
        for (label, marker) in [("no naming", PLAIN), ("the team's naming", NAMED)] {
            let (_dir, place) = workspace(marker);
            let before = checkout_state(&place);
            let (change, branch, copy) = started(start(&place, "X-1", None));
            assert_eq!(change, CHANGE, "{label}");
            if marker == PLAIN {
                assert_eq!(branch, format!("change/{CHANGE}"), "{label}");
            } else {
                assert!(branch.starts_with("feat/X-1"), "{label}: {branch}");
            }
            // The copy exists, is on the branch, and holds the change's record, committed.
            assert!(copy.is_dir(), "{label}: {}", copy.display());
            assert_eq!(git(&copy, &["branch", "--show-current"]), branch, "{label}");
            let record = format!("HEAD:intent/demo/{CHANGE}/change.yml");
            assert!(git(&copy, &["show", &record]).contains(&branch), "{label}");
            assert_eq!(git(&copy, &["status", "--porcelain"]), "", "{label}");
            // The engineer's own checkout is where it was, with the same files.
            assert_eq!(checkout_state(&place), before, "{label}");
            assert!(!place.master.join("intent").exists(), "{label}");
        }
    }

    #[test]
    fn an_empty_scope_is_the_systems_own() {
        let (_dir, place) = workspace(PLAIN);
        let (_, branch, copy) = started(start(&place, "", None));
        assert_eq!(branch, format!("change/{CHANGE}"));
        let record = format!("HEAD:intent/demo/{CHANGE}/change.yml");
        assert!(git(&copy, &["show", &record]).contains("scope: \"demo\""));
    }

    #[test]
    fn starting_a_change_the_plugin_refuses() {
        // One case per Examples row of R2.2.
        type Row = (
            &'static str,
            &'static str,
            &'static str,
            Option<&'static str>,
            StartRefusal,
            &'static str,
        );
        let rows: [Row; 4] = [
            (
                "the branch name is already taken",
                PLAIN,
                "X-1",
                Some("main"),
                StartRefusal::BranchTaken,
                "is taken in master by the branch main",
            ),
            (
                "the branch name is invalid",
                PLAIN,
                "X-1",
                Some("bad name"),
                StartRefusal::BranchInvalid,
                "a branch name cannot contain a space",
            ),
            (
                "the team's naming setting is broken",
                BROKEN,
                "X-1",
                None,
                StartRefusal::Naming,
                "the team naming on the base branch",
            ),
            (
                "the scope is not accepted",
                PLAIN,
                "bad scope",
                None,
                StartRefusal::Scope,
                "the scope: a scope cannot contain a space",
            ),
        ];
        for (label, marker, scope, branch, want_kind, want_text) in rows {
            let (_dir, place) = workspace(marker);
            let before = (checkout_state(&place), branches(&place));
            match start(&place, scope, branch) {
                ChangeStart::Refused { kind, problems } => {
                    assert_eq!(kind, want_kind, "{label}: {problems:?}");
                    // The plugin's reason, as it printed it.
                    assert!(
                        problems.iter().any(|p| p.contains(want_text)),
                        "{label}: {problems:?}"
                    );
                }
                other => panic!("{label}: {other:?}"),
            }
            // Nothing is made: no branch, no copy, and the checkout is untouched.
            assert_eq!(
                (checkout_state(&place), branches(&place)),
                before,
                "{label}"
            );
            assert!(
                !place
                    .workspace
                    .join(".ai-sdlc/copies")
                    .join(CHANGE)
                    .exists(),
                "{label}"
            );
        }
    }

    #[test]
    fn a_refused_branch_name_can_be_replaced_and_the_change_started_again() {
        let (_dir, place) = workspace(PLAIN);
        let (_, branch, _) = started(start(&place, "X-1", None));
        // Another change whose engineer picks the branch the first one has.
        let other = |branch: &str| {
            start_change(
                &program(),
                &place,
                "2026-11-02",
                &request("X-1", Some(branch)),
            )
            .unwrap()
        };
        match other(&branch) {
            ChangeStart::Refused { kind, problems } => {
                assert_eq!(kind, StartRefusal::BranchTaken);
                assert!(problems.iter().any(|p| p.contains(&branch)), "{problems:?}");
            }
            other => panic!("{other:?}"),
        }
        let (change, branch, _) = started(other("feat/other"));
        assert_eq!(change, "2026-11-02-password-reset");
        assert_eq!(branch, "feat/other");
    }
}
