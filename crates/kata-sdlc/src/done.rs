//! Declaring a change done is the plugin's step: `run change.done` verifies the change, pushes every
//! touched repository, opens one pull request each (the master's last) and records them in the change.
//! Kata runs it, relays its progress and shows its answer; it adds no check of its own.
use crate::ai_sdlc::{Place, Program};
use crate::plugin::{GhPresence, Readiness};
use crate::pull_requests::{PullRequestSource, RecordedPullRequest};
use kata_core::proc::LineSink;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// What a progress line is about.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum DoneStepKind {
    /// The plugin is verifying the change.
    Verifying,
    /// A team hook is running or has ended.
    Hook,
    /// A repository is being pushed.
    Push,
    /// A pull request is being opened.
    PullRequest,
}

/// A progress line: what the plugin is doing, named for the engineer.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct DoneStep {
    pub kind: DoneStepKind,
    pub label: String,
}

/// Where each progress line goes.
pub type StepSink = Arc<dyn Fn(DoneStep) + Send + Sync>;

/// What declaring a change done came to.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum DeclareView {
    /// Every repository is pushed and every pull request is open, the master's last.
    Done {
        pull_requests: Vec<RecordedPullRequest>,
    },
    /// The plugin refused before pushing anything; each problem is its own sentence.
    NotReady { problems: Vec<String> },
    /// It stopped part way; declaring done again carries on from there.
    Partial {
        pushed: Vec<String>,
        opened: Vec<RecordedPullRequest>,
        failed: Vec<String>,
    },
    /// This machine could not run the step; nothing is claimed as pushed.
    CouldNotRun { message: String },
}

/// The refusal when `gh` is not installed.
pub const GH_MISSING: &str = "Declaring done needs GitHub's command-line tool, gh. Install it from https://cli.github.com and reopen.";

/// How long declaring done may take: it pushes and opens pull requests, and a team's hooks run around it.
const LIMIT: Duration = Duration::from_secs(30 * 60);

/// The view of the plugin's `change.done` outcome line, from the first row of this table that matches:
///
/// | # | `outcome` | view |
/// |---|---|---|
/// | 1 | `passed` | `Done`: `details.pullRequests`, the master's last |
/// | 2 | `refused` | `NotReady`: every problem as the plugin wrote it |
/// | 3 | `failed` | `Partial`: `details.pushed`, `details.pullRequests`, the problems and a hook that stopped it |
/// | 4 | `could-not-run`, or anything else | `CouldNotRun`: the problems joined |
pub fn outcome(event: &Value) -> DeclareView {
    let problems: Vec<String> = event["problems"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    match event["outcome"].as_str() {
        Some("passed") => DeclareView::Done {
            pull_requests: pull_requests(event),
        },
        Some("refused") => DeclareView::NotReady { problems },
        Some("failed") => {
            let mut failed = problems;
            if let Some(id) = event["failed"]["id"].as_str() {
                let output = event["failed"]["output"].as_str().unwrap_or("").trim();
                failed.push(format!("The hook {id} stopped it: {output}"));
            }
            DeclareView::Partial {
                pushed: event["details"]["pushed"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|p| p.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                opened: pull_requests(event),
                failed,
            }
        }
        _ => DeclareView::CouldNotRun {
            message: if problems.is_empty() {
                "the plugin gave no answer Kata can read".to_string()
            } else {
                problems.join(" ")
            },
        },
    }
}

/// The pull requests `details` records, in the order the plugin gave them.
fn pull_requests(event: &Value) -> Vec<RecordedPullRequest> {
    event["details"]["pullRequests"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    Some(RecordedPullRequest {
                        repo: p["repo"].as_str()?.to_string(),
                        url: p["url"].as_str()?.to_string(),
                        number: p["number"].as_u64()?,
                        source: PullRequestSource::Plugin,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The progress line a `--stream` line stands for, if it stands for a step: a team hook starting or ending,
/// a repository being pushed, a pull request being opened.
pub fn step_of(line: &str) -> Option<DoneStep> {
    let line: Value = serde_json::from_str(line).ok()?;
    let text = |key: &str| line[key].as_str();
    let (kind, label) = match text("type")? {
        "hook-start" => (
            DoneStepKind::Hook,
            format!(
                "Running the team's hook {} ({})",
                text("id")?,
                text("when")?
            ),
        ),
        "hook-end" => (
            DoneStepKind::Hook,
            format!("The team's hook {} {}", text("id")?, text("outcome")?),
        ),
        "push" => (DoneStepKind::Push, format!("Pushing {}", text("repo")?)),
        "pull-request" => (
            DoneStepKind::PullRequest,
            format!("Opening a pull request in {}", text("repo")?),
        ),
        _ => return None,
    };
    Some(DoneStep { kind, label })
}

/// Declares the change done where the plugin has it (`place`), relaying progress to `on_step`.
///
/// | # | readiness | result |
/// |---|---|---|
/// | 1 | blocked | `CouldNotRun` with the reason; the program is not asked |
/// | 2 | ready, `gh` missing | `NotReady` with [`GH_MISSING`]; the program is not asked |
/// | 3 | ready | the plugin's `change.done` answer, as [`outcome`] reads it |
///
/// A program that cannot be run (no Node.js, a plugin without the program, a crash) is `CouldNotRun`.
pub fn declare(
    program: &Program,
    place: &Place,
    readiness: &Readiness,
    system: &str,
    change: &str,
    on_step: StepSink,
) -> DeclareView {
    match readiness {
        Readiness::Blocked { message, .. } => {
            return DeclareView::CouldNotRun {
                message: message.clone(),
            }
        }
        Readiness::Ready {
            gh: GhPresence::Missing,
            ..
        } => {
            return DeclareView::NotReady {
                problems: vec![GH_MISSING.to_string()],
            }
        }
        Readiness::Ready { .. } => {}
    }
    on_step(DoneStep {
        kind: DoneStepKind::Verifying,
        label: "Declaring done: the plugin is verifying the change".to_string(),
    });
    let relay: LineSink = {
        let on_step = Arc::clone(&on_step);
        Arc::new(move |line: &str| {
            if let Some(step) = step_of(line) {
                on_step(step);
            }
        })
    };
    let command = [
        "run",
        "change.done",
        "--json",
        "--stream",
        "--system",
        system,
        "--change",
        change,
    ];
    match program.run_streaming(&command, place, LIMIT, relay) {
        Ok(answer) => outcome(&answer),
        Err(e) => DeclareView::CouldNotRun {
            message: e.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::{self, BlockReason, GhPresence, Installed, Machine, Plugin};
    use crate::pull_requests::PullRequestSource;
    use crate::testutil;
    use serde_json::json;
    use serial_test::serial;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    const CHANGE: &str = "2026-11-01-greeting";
    const INTENT: &str = "---\ntitle: Greeting\nsystem: demo\nauthor: t\ndate: 2026-11-01\nstatus: accepted\nscope: demo\n---\n\n# Intent: Greeting\n";

    fn vendored() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools")
    }

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: vendored().join("ai-sdlc.ts"),
        }
    }

    fn pr(repo: &str, number: u64) -> RecordedPullRequest {
        RecordedPullRequest {
            repo: repo.into(),
            url: format!("https://github.com/example/{repo}/pull/{number}"),
            number,
            source: PullRequestSource::Plugin,
        }
    }

    fn line(repo: &str, number: u64) -> Value {
        json!({ "repo": repo, "url": format!("https://github.com/example/{repo}/pull/{number}"), "number": number, "pushed": "3f2a9c1" })
    }

    /// R7.1 and its decision table: each outcome line, written as GRAMMAR.md gives it, has one view.
    #[test]
    fn declaring_done_rows() {
        let passed = json!({ "event": "change.done", "outcome": "passed", "problems": [], "hooks": [], "failed": null,
            "details": { "pushed": ["app", "master"], "pullRequests": [line("app", 1), line("master", 2)] } });
        assert_eq!(
            outcome(&passed),
            DeclareView::Done {
                pull_requests: vec![pr("app", 1), pr("master", 2)]
            },
            "1 passed: the master's pull request is last"
        );

        let refused = json!({ "event": "change.done", "outcome": "refused", "hooks": [], "failed": null,
            "problems": ["app has uncommitted files: stray.txt", "the latest review (review 1) has unresolved high findings: F1 (app, hello.txt:1): Lost on retry."] });
        assert_eq!(
            outcome(&refused),
            DeclareView::NotReady {
                problems: vec![
                    "app has uncommitted files: stray.txt".into(),
                    "the latest review (review 1) has unresolved high findings: F1 (app, hello.txt:1): Lost on retry.".into()
                ]
            },
            "2 refused: every problem as it is"
        );

        let failed = json!({ "event": "change.done", "outcome": "failed", "hooks": [], "failed": null,
            "problems": ["opening the pull request in master failed: boom", "pushed so far: app, master; running done again carries on from there"],
            "details": { "pushed": ["app", "master"], "pullRequests": [line("app", 1)] } });
        assert_eq!(
            outcome(&failed),
            DeclareView::Partial {
                pushed: vec!["app".into(), "master".into()],
                opened: vec![pr("app", 1)],
                failed: vec![
                    "opening the pull request in master failed: boom".into(),
                    "pushed so far: app, master; running done again carries on from there".into()
                ]
            },
            "3 failed part way"
        );

        let hook = json!({ "event": "change.done", "outcome": "failed", "problems": [], "hooks": [],
            "failed": { "id": "audit", "onFailure": "stop", "output": "audit refused\n" } });
        assert_eq!(
            outcome(&hook),
            DeclareView::Partial {
                pushed: vec![],
                opened: vec![],
                failed: vec!["The hook audit stopped it: audit refused".into()]
            },
            "3 failed on a team hook, before anything was pushed"
        );

        let could_not = json!({ "event": "change.done", "outcome": "could-not-run", "hooks": [], "failed": null,
            "problems": ["declaring a change done needs the GitHub command-line tool, gh, which is not installed or not on PATH"] });
        assert_eq!(
            outcome(&could_not),
            DeclareView::CouldNotRun {
                message: "declaring a change done needs the GitHub command-line tool, gh, which is not installed or not on PATH".into()
            },
            "4 could not run"
        );
        assert!(matches!(
            outcome(&json!({ "outcome": "something-new" })),
            DeclareView::CouldNotRun { .. }
        ));
    }

    /// A node script standing in for the program.
    fn scripted(dir: &Path, body: &str) -> Program {
        let entry = dir.join("scripted.js");
        std::fs::write(&entry, body).unwrap();
        Program {
            node: "node".into(),
            entry,
        }
    }

    fn ready(gh: GhPresence) -> Readiness {
        Readiness::Ready {
            plugin: Plugin {
                dir: testutil::plugin_dir().to_path_buf(),
                version: "1.1.0".into(),
                layouts: vec![2],
            },
            gh,
        }
    }

    fn here() -> Place {
        Place {
            master: PathBuf::from("."),
            workspace: PathBuf::from("."),
        }
    }

    /// R7.3: a team hook, a push and a pull request each name the step the plugin is on, as it happens. The
    /// scripted program waits, after its first line, for the sink to have seen a step: lines held back until
    /// it exits would starve it.
    #[test]
    fn each_hook_push_and_pull_request_is_a_progress_line() {
        let dir = tempfile::tempdir().unwrap();
        let seen = dir
            .path()
            .join("seen")
            .display()
            .to_string()
            .replace('\\', "/");
        let body = r#"const fs = require('fs');
const say = (o) => fs.writeSync(1, JSON.stringify(o) + '\n');
const seen = 'SEEN';
say({ type: 'hook-start', id: 'audit', when: 'before' });
for (let i = 0; i < 200 && !fs.existsSync(seen); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
if (!fs.existsSync(seen)) { say({ type: 'outcome', outcome: 'could-not-run', problems: ['the progress line was held back'] }); process.exit(2); }
say({ type: 'hook-end', id: 'audit', when: 'before', outcome: 'passed' });
say({ type: 'push', repo: 'app' });
say({ type: 'pull-request', repo: 'app' });
say({ type: 'push', repo: 'master' });
say({ type: 'pull-request', repo: 'master' });
say({ type: 'outcome', outcome: 'passed', problems: [], hooks: [], failed: null, details: { pushed: ['app', 'master'], pullRequests: [{ repo: 'app', url: 'https://github.com/example/app/pull/1', number: 1, pushed: 'abc' }] } });
"#
        .replace("SEEN", &seen);
        let program = scripted(dir.path(), &body);
        let steps: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = {
            let steps = Arc::clone(&steps);
            let seen = dir.path().join("seen");
            Arc::new(move |step: DoneStep| {
                steps.lock().unwrap().push(step.label);
                std::fs::write(&seen, "x").unwrap();
            })
        };
        let view = declare(
            &program,
            &here(),
            &ready(GhPresence::Present),
            "demo",
            CHANGE,
            sink,
        );
        assert_eq!(
            *steps.lock().unwrap(),
            [
                "Declaring done: the plugin is verifying the change",
                "Running the team's hook audit (before)",
                "The team's hook audit passed",
                "Pushing app",
                "Opening a pull request in app",
                "Pushing master",
                "Opening a pull request in master",
            ]
        );
        assert!(matches!(view, DeclareView::Done { .. }), "{view:?}");
    }

    /// Whatever else the program prints is not a step.
    #[test]
    fn only_steps_are_progress_lines() {
        assert_eq!(step_of("not json"), None);
        assert_eq!(step_of(r#"{"type":"outcome","outcome":"passed"}"#), None);
        assert_eq!(step_of(r#"{"type":"something-new"}"#), None);
    }

    /// The fake `gh`: a copy of Node.js named `gh`, which a preloaded script turns into a GitHub that keeps its
    /// pull requests in a file. Made once per test process.
    fn fake_gh_dir() -> &'static Path {
        static DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
        DIR.get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            let path = std::env::var_os("PATH").unwrap_or_default();
            let node = std::env::split_paths(&path)
                .map(|d| d.join(if cfg!(windows) { "node.exe" } else { "node" }))
                .find(|p| p.is_file())
                .expect("node is on PATH");
            let gh = dir.path().join(if cfg!(windows) { "gh.exe" } else { "gh" });
            if std::fs::hard_link(&node, &gh).is_err() {
                std::fs::copy(&node, &gh).unwrap();
            }
            std::fs::write(
                dir.path().join("fake-gh.cjs"),
                include_str!("../tests/fixtures/fake-gh.cjs"),
            )
            .unwrap();
            dir
        })
        .path()
    }

    /// Puts the fake `gh` first on `PATH` for a test, and takes everything it set back afterwards.
    struct FakeGh {
        saved: Vec<(&'static str, Option<OsString>)>,
        state: PathBuf,
        log: PathBuf,
    }

    impl FakeGh {
        fn new(dir: &Path) -> FakeGh {
            let gh = fake_gh_dir();
            let names = [
                "PATH",
                "NODE_OPTIONS",
                "FAKE_GH_STATE",
                "FAKE_GH_LOG",
                "FAKE_GH_AUTH",
                "FAKE_GH_CREATE",
            ];
            let saved = names.map(|n| (n, std::env::var_os(n))).to_vec();
            let mut paths = vec![gh.to_path_buf()];
            paths.extend(std::env::split_paths(
                &std::env::var_os("PATH").unwrap_or_default(),
            ));
            std::env::set_var("PATH", std::env::join_paths(paths).unwrap());
            let preload = gh
                .join("fake-gh.cjs")
                .display()
                .to_string()
                .replace('\\', "/");
            std::env::set_var("NODE_OPTIONS", format!("--require={preload}"));
            let state = dir.join("gh-state.json");
            let log = dir.join("gh-log.jsonl");
            std::env::set_var("FAKE_GH_STATE", &state);
            std::env::set_var("FAKE_GH_LOG", &log);
            std::env::remove_var("FAKE_GH_AUTH");
            std::env::remove_var("FAKE_GH_CREATE");
            FakeGh { saved, state, log }
        }

        fn prs(&self) -> Vec<Value> {
            std::fs::read_to_string(&self.state)
                .ok()
                .map(|t| {
                    serde_json::from_str::<Value>(&t).unwrap()["prs"]
                        .as_array()
                        .unwrap()
                        .clone()
                })
                .unwrap_or_default()
        }

        fn calls(&self) -> usize {
            std::fs::read_to_string(&self.log).map_or(0, |t| t.lines().count())
        }
    }

    impl Drop for FakeGh {
        fn drop(&mut self) {
            for (name, value) in &self.saved {
                match value {
                    Some(v) => std::env::set_var(name, v),
                    None => std::env::remove_var(name),
                }
            }
        }
    }

    /// A change that is built and reviewed: the master and `app` each on the change's branch with a bare
    /// remote, one commit in `app`, every task logged, and a review of `app`'s head.
    struct Fx {
        _dir: tempfile::TempDir,
        ws: PathBuf,
        master: PathBuf,
        app: PathBuf,
        head: String,
        gh: FakeGh,
    }

    impl Fx {
        fn ready() -> Fx {
            let dir = tempfile::tempdir().unwrap();
            let ws = dir.path().to_path_buf();
            let gh = FakeGh::new(&ws);
            let master = testutil::repo(&ws, "master");
            let app = testutil::repo(&ws, "app");
            let folder = format!("intent/demo/{CHANGE}");
            let example = |name: &str| {
                std::fs::read_to_string(vendored().join("examples/change/2/valid").join(name))
                    .unwrap()
            };
            let log: String = ["T1", "T2", "T3"].iter().fold(
                "---\nlayout: 2\n---\n\n# Build log: app\n".to_string(),
                |text, t| {
                    format!("{text}\n### {t}\n\n```yaml\ntask: {t}\ncommits: [\"abc1234\"]\n```\n")
                },
            );
            testutil::commit_file(
                &master,
                ".ai-sdlc.json",
                "{\"version\":1,\"systems\":{\"demo\":{\"repos\":[\"app\"]}}}\n",
                "marker",
            );
            testutil::commit_file(&master, &format!("{folder}/intent.md"), INTENT, "intent");
            testutil::commit_file(
                &master,
                &format!("{folder}/spec.md"),
                &example("spec.md"),
                "spec",
            );
            testutil::commit_file(
                &master,
                &format!("{folder}/plan.md"),
                &example("plan.md"),
                "plan",
            );
            testutil::commit_file(&master, &format!("{folder}/build/app.md"), &log, "log");
            testutil::bare_origin(&master, Some("main"));
            testutil::bare_origin(&app, Some("main"));
            testutil::checkout(&master, &format!("change/{CHANGE}"), true);
            testutil::checkout(&app, &format!("change/{CHANGE}"), true);
            testutil::commit_msg(
                &app,
                "hello.txt",
                "hi\n",
                "feat(demo): say hello\n\nGenerated-By: ai-sdlc",
            );
            let head = testutil::run(&app, &["rev-parse", "HEAD"]).unwrap();
            let fx = Fx {
                _dir: dir,
                ws,
                master,
                app,
                head,
                gh,
            };
            fx.review(&[]);
            fx
        }

        /// Records a review of `app`'s head with a finding of each `(id, severity)`.
        fn review(&self, findings: &[(&str, &str)]) {
            let mut text = format!(
                "---\nlayout: 2\n---\n\n# Review findings\n\n## Review 1\n\n```yaml\nreview: 1\nreviewed_at: 2026-11-01\ncommits: {{ app: {} }}\n```\n",
                &self.head[..7]
            );
            for (id, severity) in findings {
                text.push_str(&format!(
                    "\n### {id}\n\n```yaml\nid: {id}\nseverity: {severity}\nrepo: app\nconcern: bug\nfile: hello.txt\nline: 1\n```\n\nThe greeting is lost on retry ({severity}).\n"
                ));
            }
            testutil::commit_msg(
                &self.master,
                &format!("intent/demo/{CHANGE}/build/review.md"),
                &text,
                &format!("docs(demo): record review 1 of {CHANGE}\n\nGenerated-By: ai-sdlc"),
            );
        }

        fn place(&self) -> Place {
            Place {
                master: self.master.clone(),
                workspace: self.ws.clone(),
            }
        }

        fn declare(&self) -> DeclareView {
            declare(
                &program(),
                &self.place(),
                &ready(GhPresence::Present),
                "demo",
                CHANGE,
                Arc::new(|_| {}),
            )
        }

        /// Whether `repo`'s remote holds the change's branch.
        fn pushed(&self, repo: &Path) -> bool {
            !testutil::run(
                repo,
                &[
                    "ls-remote",
                    "--heads",
                    "origin",
                    &format!("change/{CHANGE}"),
                ],
            )
            .unwrap()
            .is_empty()
        }
    }

    /// R7.1, end to end through the vendored 1.1.0 program, a bare remote and a fake `gh`: the passing,
    /// the refusing and the part-way rows, and the pull requests the change records afterwards.
    #[test]
    #[serial]
    fn declaring_done_end_to_end() {
        // Passes: every pull request, the master's last, and the change records them.
        let fx = Fx::ready();
        let view = fx.declare();
        let DeclareView::Done { pull_requests } = &view else {
            panic!("{view:?}")
        };
        assert_eq!(
            pull_requests
                .iter()
                .map(|p| (p.repo.as_str(), p.number))
                .collect::<Vec<_>>(),
            [("app", 1), ("master", 2)]
        );
        assert_eq!(fx.gh.prs().len(), 2);
        let show = program().change_show(&fx.place(), CHANGE, false).unwrap();
        let recorded = crate::pull_requests::recorded(&show, &[]);
        assert_eq!(
            recorded.iter().map(|p| p.url.as_str()).collect::<Vec<_>>(),
            pull_requests
                .iter()
                .map(|p| p.url.as_str())
                .collect::<Vec<_>>()
        );

        // Refuses: nothing is pushed and the plugin's problems are shown as they are.
        let fx = Fx::ready();
        std::fs::write(fx.app.join("stray.txt"), "x").unwrap();
        let DeclareView::NotReady { problems } = fx.declare() else {
            panic!("expected a refusal")
        };
        assert_eq!(problems, ["app has uncommitted files: stray.txt"]);
        assert!(!fx.pushed(&fx.app) && !fx.pushed(&fx.master));
        assert_eq!(
            fx.gh.calls(),
            0,
            "gh was called before the change was verified"
        );

        // Fails part way: app is pushed, its pull request fails to open, and declaring done again carries on.
        let fx = Fx::ready();
        std::env::set_var("FAKE_GH_CREATE", "fail");
        let DeclareView::Partial {
            pushed,
            opened,
            failed,
        } = fx.declare()
        else {
            panic!("expected a part-way failure")
        };
        assert_eq!(pushed, ["app"]);
        assert!(opened.is_empty());
        assert!(
            failed[0].contains("opening the pull request in app failed"),
            "{failed:?}"
        );
        assert!(
            failed[1].contains("running done again carries on"),
            "{failed:?}"
        );
        assert!(fx.pushed(&fx.app) && !fx.pushed(&fx.master));
        std::env::remove_var("FAKE_GH_CREATE");
        assert!(matches!(fx.declare(), DeclareView::Done { .. }));
        assert_eq!(fx.gh.prs().len(), 2);
    }

    /// R7.1, the machine cannot run the step: Node.js is missing, the plugin has no program, or the mode is
    /// blocked. Nothing is claimed as pushed.
    #[test]
    fn a_machine_that_cannot_run_the_step_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let sink = || -> StepSink { Arc::new(|_| {}) };
        let no_node = Program {
            node: "node-that-is-not-installed".into(),
            entry: vendored().join("ai-sdlc.ts"),
        };
        let DeclareView::CouldNotRun { message } = declare(
            &no_node,
            &here(),
            &ready(GhPresence::Present),
            "demo",
            CHANGE,
            sink(),
        ) else {
            panic!("expected could-not-run")
        };
        assert!(message.contains("Node.js 22.18"), "{message}");
        let no_program = Program {
            node: "node".into(),
            entry: dir.path().join("missing.ts"),
        };
        let view = declare(
            &no_program,
            &here(),
            &ready(GhPresence::Present),
            "demo",
            CHANGE,
            sink(),
        );
        assert!(matches!(view, DeclareView::CouldNotRun { .. }), "{view:?}");
        // The program is not asked at all when the mode cannot run.
        let blocked = Readiness::Blocked {
            reason: BlockReason::GitMissing,
            message: "The AI-SDLC mode needs git.".into(),
        };
        assert_eq!(
            declare(&program(), &here(), &blocked, "demo", CHANGE, sink()),
            DeclareView::CouldNotRun {
                message: "The AI-SDLC mode needs git.".into()
            }
        );
    }

    /// R9.1, one case per Examples row.
    #[test]
    #[serial]
    fn missing_programs_rows() {
        let installed = Some(Installed {
            dir: testutil::plugin_dir().to_path_buf(),
            version: "1.1.0".into(),
        });
        let machine = |node: &str, git: bool, gh: bool| Machine {
            plugin: installed.clone(),
            node: Some(node.into()),
            git,
            gh,
        };
        // git is not installed: the mode says git is needed and how to install it, and offers nothing else.
        let Readiness::Blocked { reason, message } =
            plugin::readiness(&machine("v22.18.0", false, true))
        else {
            panic!("git missing must block the mode")
        };
        assert_eq!(reason, BlockReason::GitMissing);
        assert!(
            message.contains("needs git") && message.contains("https://git-scm.com"),
            "{message}"
        );
        // Node.js older than 22.18: the version it needs and the version found.
        let Readiness::Blocked { reason, message } =
            plugin::readiness(&machine("v22.17.0", true, true))
        else {
            panic!("an old Node.js must block the mode")
        };
        assert_eq!(reason, BlockReason::NodeTooOld);
        assert!(
            message.contains("22.18") && message.contains("22.17.0"),
            "{message}"
        );

        // gh is not installed: every step works but declaring done, which is refused before the event.
        let ran = tempfile::tempdir().unwrap();
        let marker = ran
            .path()
            .join("ran")
            .display()
            .to_string()
            .replace('\\', "/");
        let spy = scripted(
            ran.path(),
            &format!("require('fs').writeFileSync('{marker}', 'x');"),
        );
        let view = declare(
            &spy,
            &here(),
            &plugin::readiness(&machine("v22.18.0", true, false)),
            "demo",
            CHANGE,
            Arc::new(|_| {}),
        );
        assert_eq!(
            view,
            DeclareView::NotReady {
                problems: vec![GH_MISSING.into()]
            }
        );
        assert!(
            !ran.path().join("ran").exists(),
            "the program ran although gh is missing"
        );

        // gh is not signed in: the event refuses with the command that signs in, and nothing is pushed.
        let fx = Fx::ready();
        std::env::set_var("FAKE_GH_AUTH", "fail");
        let DeclareView::NotReady { problems } = fx.declare() else {
            panic!("expected a refusal")
        };
        assert!(
            problems.iter().any(|p| p.contains("run gh auth login")),
            "{problems:?}"
        );
        assert!(!fx.pushed(&fx.app) && !fx.pushed(&fx.master));
    }

    /// R7.5: an unresolved critical or high finding in the latest review stops it before anything is pushed
    /// and is listed; a medium or a low one does not stop it.
    #[test]
    #[serial]
    fn a_serious_finding_stops_declaring_done() {
        // A critical finding: the review format has no `critical` severity, so a review document cannot
        // carry one for the program to refuse on; the refusal it would give is shown as it is (R7.5).
        let refusal = serde_json::json!({ "outcome": "refused", "problems": [
            "the latest review (review 1) has unresolved high findings: F1 (app, hello.txt:1): The greeting is lost on retry (critical)."] });
        let DeclareView::NotReady { problems } = outcome(&refusal) else {
            panic!("a critical finding must be shown as a refusal")
        };
        assert!(
            problems[0].contains("F1 (app, hello.txt:1)"),
            "{problems:?}"
        );
        // A high finding: refused before anything is pushed, and listed.
        let fx = Fx::ready();
        fx.review(&[("F1", "high")]);
        let view = fx.declare();
        let DeclareView::NotReady { problems } = &view else {
            panic!("high: {view:?}")
        };
        assert!(
            problems
                .join(
                    "
"
                )
                .contains("F1 (app, hello.txt:1)"),
            "{problems:?}"
        );
        assert!(
            !fx.pushed(&fx.app) && !fx.pushed(&fx.master),
            "high: something was pushed"
        );
        assert!(fx.gh.prs().is_empty(), "high");
        for severity in ["medium", "low"] {
            let fx = Fx::ready();
            fx.review(&[("F1", severity)]);
            let view = fx.declare();
            assert!(
                matches!(view, DeclareView::Done { .. }),
                "{severity}: {view:?}"
            );
            assert!(fx.pushed(&fx.app) && fx.pushed(&fx.master), "{severity}");
        }
    }
}
