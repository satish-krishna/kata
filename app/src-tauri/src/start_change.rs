//! Starting a change: the plugin makes the change's branch and its own copy of the master repository,
//! and Kata only asks. Kata never creates a branch or a copy itself; a refusal is the plugin's own reason,
//! sorted by what the engineer can do about it.
use kata_sdlc::ai_sdlc::{Place, Program};
use kata_sdlc::naming;
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

/// The date part of a change name for now: today, in UTC, as `YYYY-MM-DD`.
pub fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days since 1970-01-01 as (year, month, day): Howard Hinnant's public-domain `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = yoe as i64 + era * 400;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Sorts the plugin's problems by what the engineer can do about them. The program prints no code, only
/// words, so this reads the prefixes and phrases its `change start` check uses.
fn classify(problems: &[String]) -> StartRefusal {
    let any = |f: &dyn Fn(&str) -> bool| problems.iter().any(|p| f(p));
    if any(&|p| p.starts_with("the scope:")) {
        StartRefusal::Scope
    } else if any(&|p| p.starts_with("the team naming on the base branch")) {
        StartRefusal::Naming
    } else if any(&|p| p.contains(" is taken in ") || p.contains(" clashes in ")) {
        StartRefusal::BranchTaken
    } else if any(&|p| p.contains("a branch name cannot")) {
        StartRefusal::BranchInvalid
    } else {
        StartRefusal::Other
    }
}

/// Asks the plugin to start a change named from `date` and the title. An `Err` is a plugin that could not
/// run at all; a refusal is an answer.
pub fn start_change(
    program: &Program,
    place: &Place,
    date: &str,
    request: &StartRequest,
) -> Result<ChangeStart, String> {
    let title = request
        .title
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let change = naming::change_name(date, title);
    let scope = match request.scope.trim() {
        "" => naming::change_scope(&place.master, request.system, &change),
        typed => typed.to_string(),
    };
    let mut command = vec![
        "change",
        "start",
        "--json",
        "--system",
        request.system,
        "--change",
        &change,
        "--type",
        request.work_type,
        "--scope",
        &scope,
        "--title",
        title,
    ];
    if let Some(branch) = request.branch {
        command.extend(["--branch", branch]);
    }
    let answer = program.run(&command, place).map_err(|e| e.to_string())?;
    let details = &answer["details"];
    if answer["outcome"] == "passed" {
        let text = |key: &str| details[key].as_str().map(str::to_string);
        if let (Some(branch), Some(copy)) = (text("branch"), text("copy")) {
            return Ok(ChangeStart::Started {
                change,
                branch,
                copy,
            });
        }
        return Err(format!(
            "the plugin started {change} but named no branch or copy"
        ));
    }
    let problems: Vec<String> = answer["problems"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(ChangeStart::Refused {
        kind: classify(&problems),
        problems,
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
    fn civil_dates_are_right() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_758), (2026, 11, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
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
