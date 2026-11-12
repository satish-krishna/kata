//! Starting a change: the plugin makes the change's branch and its own copy of the master repository,
//! and Kata only asks. Kata never creates a branch or a copy itself; a refusal is the plugin's own reason,
//! sorted by what the engineer can do about it.
use crate::steps::{StepKind, StepTable};
use kata_core::proc::LineSink;
use kata_sdlc::ai_sdlc::{progress_of, HookFailure, Place, Program, StepOutcome};
use kata_sdlc::holds::{ChangeKey, RepoKey};
use kata_sdlc::naming;
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// What a command answers when the change already has a long step running.
pub const STEP_BUSY: &str = "This change already has a step running. Wait for it, or stop it.";

/// What a long call prints: kept, so a stop can show it, and each progress line goes to the page through the
/// step table under the change's key.
pub fn relay(steps: &StepTable, key: &ChangeKey) -> (LineSink, Arc<Mutex<Vec<String>>>) {
    let printed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (steps, key, kept) = (steps.clone(), key.clone(), printed.clone());
    let sink: LineSink = Arc::new(move |line: &str| {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        kept.lock().unwrap().push(line.to_string());
        if let Some(progress) = progress_of(line) {
            steps.label(&key, progress);
        }
    });
    (sink, printed)
}

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
    /// A team hook or the plugin's own step failed. `made` is what the plugin says it made before that
    /// (the branch, the copy), which may still be there; `problems` are its words.
    Failed {
        problems: Vec<String>,
        hook: Option<HookFailure>,
        made: Vec<String>,
    },
    /// This machine could not run the plugin's step; `hook` is the team hook that could not run, if any.
    CouldNotRun {
        reason: String,
        hook: Option<HookFailure>,
    },
    /// The engineer stopped it. `answer` is what the workflow printed before the stop; the start did not
    /// finish, and starting again shows the workflow's own answer, a refusal included.
    Stopped { answer: Vec<String> },
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
/// words, so this reads the prefixes and phrases its `change start` check uses. A name the plugin keeps
/// for itself (`change/pending-`) is taken: the engineer picks another.
fn classify(problems: &[String]) -> StartRefusal {
    let any = |f: &dyn Fn(&str) -> bool| problems.iter().any(|p| f(p));
    if any(&|p| p.starts_with("the scope:")) {
        StartRefusal::Scope
    } else if any(&|p| p.starts_with("the team naming on the base branch")) {
        StartRefusal::Naming
    } else if any(&|p| {
        p.contains(" is taken in ")
            || p.contains(" clashes in ")
            || p.contains("names starting \"change/pending-\" are reserved")
    }) {
        StartRefusal::BranchTaken
    } else if any(&|p| p.contains("a branch name cannot")) {
        StartRefusal::BranchInvalid
    } else {
        StartRefusal::Other
    }
}

/// Asks the plugin to start a change named from `date` and the title, and reads its answer through
/// `ai_sdlc::answer_of`. An `Err` is an answer that passed but named no branch or copy.
pub fn start_change(
    program: &Program,
    place: &Place,
    date: &str,
    request: &StartRequest,
    steps: &StepTable,
    workspace: &Path,
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
    let key = ChangeKey {
        workspace: RepoKey::of(workspace),
        system: request.system.to_string(),
        change: change.clone(),
    };
    let Ok(step) = steps.begin(key.clone(), StepKind::Starting) else {
        return Ok(ChangeStart::CouldNotRun {
            reason: STEP_BUSY.to_string(),
            hook: None,
        });
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
    let (sink, printed) = relay(steps, &key);
    let answer = program.step_long(&command, place, step.token(), Some(sink));
    let text = |key: &str| answer.json["details"][key].as_str().map(str::to_string);
    match answer.outcome {
        StepOutcome::Passed { .. } => match (text("branch"), text("copy")) {
            (Some(branch), Some(copy)) => Ok(ChangeStart::Started {
                change,
                branch,
                copy,
            }),
            _ => Err(format!(
                "the plugin started {change} but named no branch or copy"
            )),
        },
        StepOutcome::Refused { problems } => Ok(ChangeStart::Refused {
            kind: classify(&problems),
            problems,
        }),
        StepOutcome::Failed { problems, hook } => Ok(ChangeStart::Failed {
            problems,
            hook,
            made: ["branch", "copy"].into_iter().filter_map(text).collect(),
        }),
        StepOutcome::CouldNotRun { reason, hook, .. } => {
            Ok(ChangeStart::CouldNotRun { reason, hook })
        }
        StepOutcome::Stopped => Ok(ChangeStart::Stopped {
            answer: printed.lock().unwrap().clone(),
        }),
    }
}

/// The change a run started through the plugin, read from the run's own events: the last `change start` answer
/// among its tool results that passed for `system` (the plugin prints it as one JSON object, `event` `change.start`).
/// None when the run started no change of `system`; a change another run made meanwhile is never named.
pub fn started_by_run(events: &[kata_core::event::KataEvent], system: &str) -> Option<String> {
    let started = |text: &str| -> Option<String> {
        let answer: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
        let field = |name: &str| answer.get(name).and_then(serde_json::Value::as_str);
        (field("event") == Some("change.start")
            && field("system") == Some(system)
            && field("outcome") == Some("passed"))
        .then(|| field("change").map(str::to_string))
        .flatten()
    };
    events
        .iter()
        .filter_map(|ev| match ev {
            kata_core::event::KataEvent::ToolResult {
                output: Some(output),
                ..
            } => started(output).or_else(|| output.lines().filter_map(started).next_back()),
            _ => None,
        })
        .next_back()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn tool_result(output: &str) -> kata_core::event::KataEvent {
        kata_core::event::KataEvent::ToolResult {
            name: "Bash".into(),
            ok: true,
            summary: String::new(),
            id: None,
            parent_id: None,
            output: Some(output.into()),
            truncated: false,
        }
    }

    #[test]
    fn the_change_a_triage_started_is_the_one_its_own_change_start_answer_names() {
        let started = r#"{"event":"change.start","system":"commerce","change":"2026-10-18-fix-login","outcome":"passed","details":{"branch":"fix/login","copy":"/ws/.ai-sdlc/copies/2026-10-18-fix-login","created":true}}"#;
        let events = vec![
            tool_result("intent.md written"),
            tool_result(started),
            // Another system's start, a refused start and a step that is not a start name no change of this triage.
            tool_result(
                r#"{"event":"change.start","system":"billing","change":"2026-10-18-other","outcome":"passed"}"#,
            ),
            tool_result(
                r#"{"event":"change.start","system":"commerce","change":"2026-10-18-taken","outcome":"refused"}"#,
            ),
            tool_result(
                r#"{"event":"doc.accept","system":"commerce","change":"2026-10-18-x","outcome":"passed"}"#,
            ),
        ];
        assert_eq!(
            started_by_run(&events, "commerce").as_deref(),
            Some("2026-10-18-fix-login")
        );
        // The answer may follow other output of the same command, one JSON object on its own line.
        let mixed = vec![tool_result(&format!("starting\n{started}\n"))];
        assert_eq!(
            started_by_run(&mixed, "commerce").as_deref(),
            Some("2026-10-18-fix-login")
        );
        // A triage whose run started nothing names no change, whatever else the workspace lists.
        assert_eq!(started_by_run(&events[2..], "commerce"), None);
    }

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

    fn no_steps() -> StepTable {
        StepTable::new(Arc::new(|_| {}))
    }

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
        start_change(
            &program(),
            place,
            DATE,
            &request(scope, branch),
            &no_steps(),
            &place.workspace,
        )
        .unwrap()
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

    /// F21 and R2.2: a branch name the plugin reserves for itself asks the engineer for another name.
    #[test]
    fn a_reserved_branch_name_asks_for_another() {
        let (_dir, place) = workspace(PLAIN);
        match start(&place, "X-1", Some("change/pending-x")) {
            ChangeStart::Refused { kind, problems } => {
                assert_eq!(kind, StartRefusal::BranchTaken, "{problems:?}");
                assert!(
                    problems.iter().any(|p| p.contains("reserved")),
                    "{problems:?}"
                );
            }
            other => panic!("{other:?}"),
        }
    }

    fn with_hook(run: &str) -> String {
        format!(
            r#"{{"version":1,"systems":{{"demo":{{"repos":["app"]}}}},"hooks":{{"change.start":[{{"id":"gate","run":{run}}}]}}}}"#
        )
    }

    /// F10: a team hook on starting fails. The engineer sees the hook's failure and its output, and is
    /// not told the plugin refused.
    #[test]
    fn a_failed_hook_on_starting_shows_its_output() {
        let (_dir, place) = workspace(&with_hook(
            r#"["node","-e","console.log('gate says no');process.exit(1)"]"#,
        ));
        match start(&place, "X-1", None) {
            ChangeStart::Failed {
                hook: Some(hook),
                made,
                ..
            } => {
                assert_eq!(hook.id, "gate");
                assert!(hook.output.contains("gate says no"), "{hook:?}");
                // A blocking before hook stops the start before the plugin makes anything.
                assert_eq!(made, Vec::<String>::new());
            }
            other => panic!("{other:?}"),
        }
    }

    /// F3: a team hook on starting cannot run on this machine. The plugin prints its answer and exits
    /// 2; the engineer is told the machine could not run it, with the hook's own output.
    #[test]
    fn a_hook_that_cannot_run_on_starting_says_why() {
        let (_dir, place) = workspace(&with_hook(r#"["kata-no-such-program-on-this-machine"]"#));
        match start(&place, "X-1", None) {
            ChangeStart::CouldNotRun {
                reason,
                hook: Some(hook),
            } => {
                assert!(reason.contains("gate"), "{reason}");
                assert!(
                    hook.output
                        .contains("cannot start kata-no-such-program-on-this-machine"),
                    "{hook:?}"
                );
            }
            other => panic!("{other:?}"),
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
                &no_steps(),
                &place.workspace,
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

    /// A stand-in for the program: the call prints one progress line, writes a marker and waits to be
    /// stopped. A call nobody stops ends itself after 5 s, so a red test fails instead of hanging.
    fn waiting_program(dir: &Path) -> (Program, PathBuf) {
        let marker = dir.join("waiting.marker");
        let script = format!(
            "import {{ writeFileSync, writeSync }} from 'node:fs';
writeSync(1, JSON.stringify({{ type: 'push', repo: 'app' }}) + '\\n');
writeFileSync({marker:?}, 'x');
setTimeout(() => {{ console.error('the fake was never stopped'); process.exit(3); }}, 5000);
",
            marker = marker.display().to_string()
        );
        let entry = dir.join("waiting.mjs");
        std::fs::write(&entry, script).unwrap();
        (
            Program {
                node: "node".into(),
                entry,
            },
            marker,
        )
    }

    fn capturing_steps() -> (StepTable, Arc<Mutex<Vec<crate::steps::StepEvent>>>) {
        let seen: Arc<Mutex<Vec<crate::steps::StepEvent>>> = Arc::default();
        let sink = seen.clone();
        (
            StepTable::new(Arc::new(move |e| sink.lock().unwrap().push(e))),
            seen,
        )
    }

    fn key_of(place: &Place) -> ChangeKey {
        ChangeKey {
            workspace: RepoKey::of(&place.workspace),
            system: "demo".into(),
            change: CHANGE.into(),
        }
    }

    /// R17.1, R16.1: the engineer stops a start that has printed a line; it answers Stopped with that line,
    /// the change's step is gone, and the stop reached the change's own token.
    #[test]
    fn stopped_outcomes() {
        let dir = tempfile::tempdir().unwrap();
        let (program, _marker) = waiting_program(dir.path());
        let (_ws, place) = workspace(PLAIN);
        let (steps, seen) = capturing_steps();
        let key = key_of(&place);
        let watcher = {
            let (steps, seen, key) = (steps.clone(), seen.clone(), key.clone());
            std::thread::spawn(move || {
                for _ in 0..100 {
                    if !seen.lock().unwrap().is_empty() {
                        return steps.stop(&key);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                false
            })
        };
        let outcome = start_change(
            &program,
            &place,
            DATE,
            &request("", None),
            &steps,
            &place.workspace,
        )
        .unwrap();
        assert!(watcher.join().unwrap(), "the step was not in the table");
        assert_eq!(
            outcome,
            ChangeStart::Stopped {
                answer: vec![r#"{"type":"push","repo":"app"}"#.to_string()]
            }
        );
        assert!(steps.running().is_empty());
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].kind, StepKind::Starting);
        assert_eq!(seen[0].progress.label, "Pushing app");
    }

    /// A change that already has a long step running is not started again, and the program is not asked.
    #[test]
    fn a_busy_change_is_not_started_twice() {
        let dir = tempfile::tempdir().unwrap();
        let (program, marker) = waiting_program(dir.path());
        let (_ws, place) = workspace(PLAIN);
        let (steps, _) = capturing_steps();
        let _running = steps.begin(key_of(&place), StepKind::Renaming).unwrap();
        let outcome = start_change(
            &program,
            &place,
            DATE,
            &request("", None),
            &steps,
            &place.workspace,
        )
        .unwrap();
        assert!(
            matches!(outcome, ChangeStart::CouldNotRun { .. }),
            "{outcome:?}"
        );
        assert!(!marker.exists(), "the program was asked");
    }
}
