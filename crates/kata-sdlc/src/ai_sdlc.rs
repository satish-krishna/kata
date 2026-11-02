//! The one door to the ai-sdlc program: `node <plugin>/tools/ai-sdlc.ts <command>`.
//!
//! Every call Kata makes to the program goes through [`execute`]: it starts Node.js hidden, with a time
//! limit, and kills the whole process tree on a timeout. Every answer is read by [`answer_of`]: a step
//! (an event, a commit, a change command) through [`Program::step`] as a typed [`StepOutcome`], and a
//! read through [`Program::run`] as its JSON.
pub mod show;
pub mod state;
pub mod status;

use crate::process::CapturedExit;
use kata_core::proc::{run_limited, run_limited_streaming, Limited, LineSink, Outcome, StartError};
use serde::Serialize;
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a command may run before its process tree is killed, when it runs no team hook. A step that
/// runs hooks gets this plus the hooks' own time limits (see [`Program::limit_for`]).
pub const TIMEOUT: Duration = Duration::from_secs(60);

/// What a missing `node` is reported as.
pub const NEEDS_NODE: &str = "ai-sdlc needs Node.js 22.18 or later";

/// The commands that take `--master` and `--workspace`.
const PLACED: &[&str] = &[
    "resolve",
    "state",
    "stale",
    "instructions",
    "run",
    "hooks",
    "status",
    "commit",
    "change",
];

/// Where an ai-sdlc command works: the master repository and the workspace around it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub master: PathBuf,
    pub workspace: PathBuf,
}

/// Why the program gave no answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProgramError {
    /// The program could not run: no Node.js, a usage error or crash (exit 2), a timeout, or an answer
    /// that is not JSON.
    #[error("the ai-sdlc program could not run: {message}")]
    CouldNotRun { message: String },
    /// The installed plugin has no program Kata can run; `found` says what is there instead.
    #[error("the installed ai-sdlc plugin is too old: {found}")]
    TooOld { found: String },
    /// The program refused (exit 1) and printed something that is not JSON.
    #[error("the ai-sdlc program refused: {stdout}")]
    Refused { stdout: String },
}

/// Why [`execute`] has no exit to give.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Failure {
    /// `node` is not on this machine.
    NodeMissing,
    /// The process could not be started or waited on.
    Other(String),
    /// It ran past its limit and its tree was killed.
    TimedOut { secs: u64 },
}

/// Runs `node <entry> <args>` in `cwd`, hidden, within `limit`, and returns how it exited.
pub(crate) fn execute(
    node: &Path,
    entry: &Path,
    cwd: &Path,
    args: &[&str],
    limit: Duration,
    on_line: Option<LineSink>,
) -> Result<CapturedExit, Failure> {
    let mut argv: Vec<OsString> = vec![entry.into()];
    argv.extend(args.iter().map(OsString::from));
    let spec = Limited {
        program: node,
        args: argv,
        cwd,
        env: &[],
        stdin: None,
        limit,
        keep_stdout: true,
    };
    let outcome = match on_line {
        Some(on_line) => run_limited_streaming(&spec, on_line),
        None => run_limited(&spec),
    };
    match outcome {
        Outcome::Exited { code, tail, stdout } => Ok(CapturedExit {
            code,
            stdout,
            stderr: tail,
        }),
        Outcome::TimedOut { .. } => Err(Failure::TimedOut {
            secs: limit.as_secs(),
        }),
        Outcome::NotStarted(StartError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(Failure::NodeMissing)
        }
        Outcome::NotStarted(e) => Err(Failure::Other(e.to_string())),
        Outcome::WaitFailed(e) => Err(Failure::Other(format!("could not be waited on: {e}"))),
    }
}

/// How the program exited: its exit code and what it printed. A stand-in for the program in a test hands
/// one back in place of running it, so the test reads it the same way as the real program's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    /// None when it was ended by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Reply {
    /// A reply that prints `json` as its one line and exits with `code`.
    pub fn json(code: i32, json: &Value) -> Reply {
        Reply {
            code: Some(code),
            stdout: format!("{json}\n"),
            stderr: String::new(),
        }
    }
}

/// The blocking hook that stopped a step, what it asks for, and its output as the plugin gave it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct HookFailure {
    pub id: String,
    /// `fix` or `stop`; None when the plugin did not say.
    pub on_failure: Option<String>,
    pub output: String,
}

/// What the plugin answered to a step (an event, a commit, a change command), read from its exit code and
/// the JSON it printed. Every caller reads a step through [`answer_of`]; none reads the exit code itself.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum StepOutcome {
    /// Exit 0. `problems` are warnings, such as an after hook that failed (nothing was undone).
    Passed { problems: Vec<String> },
    /// Exit 1 without a failure: the plugin's reasons; it did nothing.
    Refused { problems: Vec<String> },
    /// Exit 1 with `outcome: failed`: a blocking hook or the step's own work failed.
    Failed {
        problems: Vec<String>,
        hook: Option<HookFailure>,
    },
    /// Exit 2, or the program could not be run at all: a fault of the machine, not of the work.
    CouldNotRun {
        reason: String,
        /// The repository the plugin names, when it names one.
        repo: Option<String>,
        hook: Option<HookFailure>,
    },
}

/// A step's outcome with the JSON it came from (`Value::Null` when there was none), for the details a
/// caller shows: the branch a start made, the files a build start found uncommitted.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub outcome: StepOutcome,
    pub json: Value,
}

/// Reads a step's reply, or the reason it could not be run, as the plugin's contract gives it:
///
/// | # | reply | outcome |
/// |---|---|---|
/// | 1 | none (no Node.js, a timeout, ...) | `CouldNotRun` with the reason |
/// | 2 | exit 0, JSON | `Passed`, with its `problems` as warnings |
/// | 3 | exit 1, JSON with `outcome: failed` | `Failed`, with `failed` as the hook and its output |
/// | 4 | exit 1, JSON | `Refused` with its `problems` (its `reason` when it lists none) |
/// | 5 | exit 1, not JSON | `Refused` with what it printed |
/// | 6 | exit 2, JSON | `CouldNotRun`: the problems, the repository it names and the hook that could not run |
/// | 7 | anything else | `CouldNotRun` with stderr, or the exit code |
pub fn answer_of(reply: Result<Reply, String>) -> Answer {
    let machine = |reason: String, json: Value| Answer {
        outcome: StepOutcome::CouldNotRun {
            reason,
            repo: None,
            hook: None,
        },
        json,
    };
    let reply = match reply {
        Ok(reply) => reply,
        Err(reason) => return machine(reason, Value::Null),
    };
    let json = reply
        .stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| serde_json::from_str::<Value>(l).ok())
        .filter(Value::is_object);
    let Some(json) = json else {
        return match reply.code {
            Some(1) => Answer {
                outcome: StepOutcome::Refused {
                    problems: vec![reply.stdout.trim().to_string()],
                },
                json: Value::Null,
            },
            Some(0) => machine(
                format!(
                    "it printed something that is not JSON: {}",
                    reply.stdout.trim()
                ),
                Value::Null,
            ),
            code => machine(stderr_or_code(&reply.stderr, code), Value::Null),
        };
    };
    let problems = strings(&json["problems"]);
    let hook = hook_failure(&json["failed"]);
    let outcome = match reply.code {
        Some(0) => StepOutcome::Passed { problems },
        Some(1) if json["outcome"] == "failed" => StepOutcome::Failed { problems, hook },
        Some(1) => StepOutcome::Refused {
            problems: if problems.is_empty() {
                json["reason"]
                    .as_str()
                    .map(|r| vec![r.to_string()])
                    .unwrap_or_default()
            } else {
                problems
            },
        },
        Some(2) => StepOutcome::CouldNotRun {
            reason: if problems.is_empty() {
                stderr_or_code(&reply.stderr, reply.code)
            } else {
                problems.join("\n")
            },
            repo: named_repo(&json),
            hook,
        },
        code => StepOutcome::CouldNotRun {
            reason: stderr_or_code(&reply.stderr, code),
            repo: None,
            hook: None,
        },
    };
    Answer { outcome, json }
}

fn stderr_or_code(stderr: &str, code: Option<i32>) -> String {
    match stderr.trim() {
        "" => format!(
            "exit {}",
            code.map_or("by signal".into(), |c| c.to_string())
        ),
        text => text.to_string(),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The blocking hook an answer's `failed` names, with its output.
fn hook_failure(failed: &Value) -> Option<HookFailure> {
    Some(HookFailure {
        id: failed["id"].as_str()?.to_string(),
        on_failure: failed["onFailure"].as_str().map(str::to_string),
        output: failed["output"].as_str().unwrap_or_default().to_string(),
    })
}

/// The repository a could-not-run answer is about: the event's `repo`, or with `--check` the first of
/// `repos` that could not run.
fn named_repo(json: &Value) -> Option<String> {
    let named = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    named(&json["repo"]).or_else(|| {
        json["repos"]
            .as_array()?
            .iter()
            .find(|r| r["outcome"] == "could-not-run")
            .and_then(|r| named(&r["repo"]))
    })
}

/// The ai-sdlc program: the Node.js executable and the entry file it runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Program {
    pub node: PathBuf,
    pub entry: PathBuf,
}

impl Program {
    /// The program of the plugin installed at `plugin`: `node` from `PATH` and `<plugin>/tools/ai-sdlc.ts`.
    pub fn locate(plugin: &Path) -> Program {
        Program {
            node: "node".into(),
            entry: plugin.join("tools").join("ai-sdlc.ts"),
        }
    }

    /// Runs `command` (for example `["resolve", "--json"]`) in `place` and returns the JSON on its last
    /// stdout line. Exit 0 and exit 1 are answers (exit 1 is one such as `refused`), so both return the
    /// JSON; `Refused` is for an exit 1 whose output is not JSON. Exit 2 is `CouldNotRun` with the
    /// plugin's reason: its problems when it printed JSON, else stderr. A step uses [`Program::step`].
    pub fn run(&self, command: &[&str], place: &Place) -> Result<Value, ProgramError> {
        if !self.entry.is_file() {
            return Err(ProgramError::TooOld {
                found: format!("{} does not exist", self.entry.display()),
            });
        }
        let master = place.master.display().to_string();
        let workspace = place.workspace.display().to_string();
        let args = with_place(command, &master, &workspace);
        self.call(&args, &place.workspace)
    }

    /// Runs a step (`command`) in `place` and reads its answer through [`answer_of`].
    pub fn step(&self, command: &[&str], place: &Place) -> Answer {
        answer_of(self.exec(command, place))
    }

    /// [`Program::step`] that hands each whole stdout line to `on_line` while it runs (`--stream`).
    pub fn step_streaming(&self, command: &[&str], place: &Place, on_line: LineSink) -> Answer {
        answer_of(self.exec_within(command, place, base_limit(command), Some(on_line)))
    }

    /// Runs `command` in `place` and returns how it exited, within the time limit chosen for it.
    pub fn exec(&self, command: &[&str], place: &Place) -> Result<Reply, String> {
        self.exec_within(command, place, base_limit(command), None)
    }

    /// [`Program::exec`] with `base` as the limit before the time limits of the team's hooks are added.
    pub fn exec_within(
        &self,
        command: &[&str],
        place: &Place,
        base: Duration,
        on_line: Option<LineSink>,
    ) -> Result<Reply, String> {
        if !self.entry.is_file() {
            return Err(ProgramError::TooOld {
                found: format!("{} does not exist", self.entry.display()),
            }
            .to_string());
        }
        let limit = self.limit_for(command, place, base);
        let master = place.master.display().to_string();
        let workspace = place.workspace.display().to_string();
        let args = with_place(command, &master, &workspace);
        match execute(
            &self.node,
            &self.entry,
            &place.workspace,
            &args,
            limit,
            on_line,
        ) {
            Ok(exit) => Ok(Reply {
                code: exit.code,
                stdout: String::from_utf8_lossy(&exit.stdout).into_owned(),
                stderr: exit.stderr,
            }),
            Err(failure) => Err(failure.reason()),
        }
    }

    /// How long `command` may run in `place`: `base`, plus the time limits of the team's hooks it runs.
    /// Only an event that runs hooks (`run <event>` without `--check`, and `change start`, which runs
    /// `change.start`) gets more; every hook of the event is counted, as the plugin runs them one after
    /// another. When the hooks cannot be read the plugin will not run them either, and `base` stands.
    pub fn limit_for(&self, command: &[&str], place: &Place, base: Duration) -> Duration {
        let (Some(event), Some(system)) = (hook_event(command), option(command, "--system")) else {
            return base;
        };
        match self.hooks(place, system, Some(event)) {
            Ok(hooks) => {
                base + Duration::from_secs(hooks.hooks.iter().map(|h| h.timeout).sum::<u64>())
            }
            Err(_) => base,
        }
    }

    /// Finds the master repository of `workspace` as the program's `resolve` does, with no master given.
    /// A workspace with no master, or with several, is `CouldNotRun` with the program's reason.
    pub fn resolve(&self, workspace: &Path) -> Result<Place, ProgramError> {
        let ws = workspace.display().to_string();
        let found = self.call(&["resolve", "--json", "--workspace", &ws], workspace)?;
        let path = |key: &str| {
            found[key]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
        };
        match (path("master"), path("workspace")) {
            (Some(master), Some(workspace)) => Ok(Place { master, workspace }),
            _ => {
                let problems: Vec<&str> = found["problems"]
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                Err(could_not_run(if problems.is_empty() {
                    "the program found no master repository".to_string()
                } else {
                    problems.join(" ")
                }))
            }
        }
    }

    /// Runs the program with `args` as given, in `cwd`, within [`TIMEOUT`], and reads the answer as
    /// `run` does.
    fn call(&self, args: &[&str], cwd: &Path) -> Result<Value, ProgramError> {
        let reply = match execute(&self.node, &self.entry, cwd, args, TIMEOUT, None) {
            Ok(exit) => Ok(Reply {
                code: exit.code,
                stdout: String::from_utf8_lossy(&exit.stdout).into_owned(),
                stderr: exit.stderr,
            }),
            Err(failure) => Err(failure.reason()),
        };
        read_value(reply)
    }
}

impl Failure {
    /// What the engineer is told when a command could not be run.
    fn reason(self) -> String {
        match self {
            Failure::NodeMissing => NEEDS_NODE.to_string(),
            Failure::Other(message) => message,
            Failure::TimedOut { secs } => format!("it did not finish in {secs} seconds"),
        }
    }
}

/// A read's answer: the JSON of exit 0 and exit 1 (an answer such as `refused` is still an answer), read
/// through [`answer_of`] like every step's, so an exit 2 is the plugin's own reason.
fn read_value(reply: Result<Reply, String>) -> Result<Value, ProgramError> {
    let code = reply.as_ref().ok().and_then(|r| r.code);
    let stdout = reply.as_ref().map(|r| r.stdout.clone()).unwrap_or_default();
    let answer = answer_of(reply);
    match (code, answer.outcome) {
        (Some(0 | 1), _) if !answer.json.is_null() => Ok(answer.json),
        (_, StepOutcome::CouldNotRun { reason, .. }) => Err(could_not_run(reason)),
        _ => Err(ProgramError::Refused { stdout }),
    }
}

/// The time limit a command starts from, before the team's hooks are added: declaring done pushes and
/// opens pull requests, and a commit runs the repository's own git hooks, which the plugin does not limit.
fn base_limit(command: &[&str]) -> Duration {
    match (command.first().copied(), hook_event(command)) {
        (_, Some("change.done")) => Duration::from_secs(30 * 60),
        (Some("commit"), _) => Duration::from_secs(10 * 60),
        _ => TIMEOUT,
    }
}

/// The event whose team hooks `command` runs: `run <event>` without `--check`, or `change start`.
fn hook_event<'a>(command: &[&'a str]) -> Option<&'a str> {
    match command {
        ["run", event, rest @ ..] if !rest.contains(&"--check") => Some(event),
        ["change", "start", ..] => Some("change.start"),
        _ => None,
    }
}

/// The value given for `name` in `command`, before a `--` that starts paths.
fn option<'a>(command: &[&'a str], name: &str) -> Option<&'a str> {
    command
        .iter()
        .take_while(|a| **a != "--")
        .position(|a| *a == name)
        .and_then(|i| command.get(i + 1).copied())
}

fn could_not_run(message: impl Into<String>) -> ProgramError {
    ProgramError::CouldNotRun {
        message: message.into(),
    }
}

/// `command` with `--master` and `--workspace` added where the command takes them: before a `--` that
/// starts the paths, and not when the caller gave them already.
fn with_place<'a>(command: &[&'a str], master: &'a str, workspace: &'a str) -> Vec<&'a str> {
    let takes = command.first().is_some_and(|c| PLACED.contains(c));
    if !takes {
        return command.to_vec();
    }
    let split = command
        .iter()
        .position(|a| *a == "--")
        .unwrap_or(command.len());
    let (head, tail) = command.split_at(split);
    let mut args = head.to_vec();
    if !head.contains(&"--master") {
        args.extend(["--master", master]);
    }
    if !head.contains(&"--workspace") {
        args.extend(["--workspace", workspace]);
    }
    args.extend(tail);
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use std::path::Path;

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    /// A workspace holding a master repository with a marker.
    fn workspace() -> (tempfile::TempDir, Place) {
        let dir = tempfile::tempdir().unwrap();
        let master = testutil::repo(dir.path(), "ai-sdlc");
        testutil::commit_file(&master, ".ai-sdlc.json", "{}\n", "marker");
        let place = Place {
            master,
            workspace: dir.path().to_path_buf(),
        };
        (dir, place)
    }

    fn same_path(value: &Value, expected: &Path) -> bool {
        let norm = |s: &str| s.replace('\\', "/").to_lowercase();
        value
            .as_str()
            .is_some_and(|s| norm(s) == norm(&expected.display().to_string()))
    }

    #[test]
    fn run_returns_the_json_of_exit_0_and_1() {
        let (_dir, place) = workspace();
        let found = program().run(&["resolve", "--json"], &place).unwrap();
        assert_eq!(found["problems"], serde_json::json!([]));

        let nowhere = Place {
            master: place.workspace.join("missing"),
            workspace: place.workspace.clone(),
        };
        let refused = program().run(&["resolve", "--json"], &nowhere).unwrap();
        assert!(!refused["problems"].as_array().unwrap().is_empty());
    }

    #[test]
    fn exit_2_is_could_not_run_with_stderr() {
        let (_dir, place) = workspace();
        match program().run(&["resolve"], &place) {
            Err(ProgramError::CouldNotRun { message }) => assert!(!message.is_empty()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn change_commands_get_the_master_and_the_workspace() {
        let args = with_place(
            &["change", "start", "--json", "--system", "demo"],
            "/m",
            "/w",
        );
        assert_eq!(
            args,
            [
                "change",
                "start",
                "--json",
                "--system",
                "demo",
                "--master",
                "/m",
                "--workspace",
                "/w"
            ]
        );
        // The caller's own placement is kept, and a command that takes none is left alone.
        let given = with_place(&["change", "show", "--master", "/x"], "/m", "/w");
        assert_eq!(
            given,
            ["change", "show", "--master", "/x", "--workspace", "/w"]
        );
        assert_eq!(
            with_place(&["naming", "--json"], "/m", "/w"),
            ["naming", "--json"]
        );
    }

    /// A node script standing in for the program, in a folder of its own that is also its workspace.
    fn scripted(dir: &Path, body: &str) -> (Program, Place) {
        let entry = dir.join("scripted.js");
        std::fs::write(&entry, body).unwrap();
        let place = Place {
            master: dir.to_path_buf(),
            workspace: dir.to_path_buf(),
        };
        (
            Program {
                node: "node".into(),
                entry,
            },
            place,
        )
    }

    /// A program that prints `json` as its one line and exits with `code`, with nothing on stderr.
    fn answering(dir: &Path, code: i32, json: &Value) -> (Program, Place) {
        let line = serde_json::to_string(&json.to_string()).unwrap();
        scripted(
            dir,
            &format!("process.stdout.write({line} + '\\n'); process.exitCode = {code};"),
        )
    }

    /// F3: `run` and `change start` print their whole answer and exit 2 when they could not run, with
    /// nothing on stderr. The engineer is told the plugin's reason and the repository, not "exit 2".
    #[test]
    fn a_could_not_run_answer_on_exit_2_keeps_its_reason_and_repository() {
        let dir = tempfile::tempdir().unwrap();
        let event = serde_json::json!({"event": "build.start", "repo": "bob", "outcome": "could-not-run",
            "problems": ["hook prep could not run"], "hooks": [],
            "failed": {"id": "prep", "onFailure": "stop", "output": "spawn prep ENOENT"}});
        let (program, place) = answering(dir.path(), 2, &event);
        let answer = program.step(&["run", "build.start", "--json"], &place);
        assert_eq!(
            answer.outcome,
            StepOutcome::CouldNotRun {
                reason: "hook prep could not run".into(),
                repo: Some("bob".into()),
                hook: Some(HookFailure {
                    id: "prep".into(),
                    on_failure: Some("stop".into()),
                    output: "spawn prep ENOENT".into()
                }),
            }
        );
        assert_eq!(answer.json, event);

        // `--check` names the repository among `repos`.
        let dir = tempfile::tempdir().unwrap();
        let check = serde_json::json!({"event": "build.start", "check": true, "outcome": "could-not-run",
            "problems": ["the hook configuration on the base branch: bad"], "refusing": [],
            "repos": [{"repo": "kata", "outcome": "passed", "problems": []},
                      {"repo": "bob", "outcome": "could-not-run", "problems": ["the hook configuration on the base branch: bad"]}]});
        let (program, place) = answering(dir.path(), 2, &check);
        assert_eq!(
            program
                .step(&["run", "build.start", "--json"], &place)
                .outcome,
            StepOutcome::CouldNotRun {
                reason: "the hook configuration on the base branch: bad".into(),
                repo: Some("bob".into()),
                hook: None,
            }
        );
    }

    /// F10: a blocking hook that failed is a failure of the work, with the hook and its output.
    #[test]
    fn a_failed_step_carries_the_hook_and_its_output() {
        let dir = tempfile::tempdir().unwrap();
        let event = serde_json::json!({"event": "build.start", "repo": "kata", "outcome": "failed",
            "problems": ["hook lint failed with exit code 1"], "hooks": [],
            "failed": {"id": "lint", "onFailure": "fix", "output": "src/a.rs: unused import\n"}});
        let (program, place) = answering(dir.path(), 1, &event);
        assert_eq!(
            program
                .step(&["run", "build.start", "--json"], &place)
                .outcome,
            StepOutcome::Failed {
                problems: vec!["hook lint failed with exit code 1".into()],
                hook: Some(HookFailure {
                    id: "lint".into(),
                    on_failure: Some("fix".into()),
                    output: "src/a.rs: unused import\n".into()
                }),
            }
        );
    }

    /// F22: a step that passed keeps the plugin's warnings, such as an after hook that failed.
    #[test]
    fn a_passed_step_keeps_its_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let event = serde_json::json!({"event": "doc.accept", "repo": "master", "outcome": "passed",
            "problems": ["after hook notify failed with exit code 1; nothing was undone"], "hooks": [], "failed": null});
        let (program, place) = answering(dir.path(), 0, &event);
        assert_eq!(
            program
                .step(&["run", "doc.accept", "--json"], &place)
                .outcome,
            StepOutcome::Passed {
                problems: vec![
                    "after hook notify failed with exit code 1; nothing was undone".into()
                ]
            }
        );
    }

    /// A refusal is the plugin's reasons; a commit that lists none gives its `reason`; an exit 1 that is
    /// not JSON is what it printed; a crash is its stderr.
    #[test]
    fn refusals_and_crashes_read_as_the_plugin_gave_them() {
        let refused = |json: Value| answer_of(Ok(Reply::json(1, &json))).outcome;
        assert_eq!(
            refused(serde_json::json!({"outcome": "refused", "problems": ["bob is dirty"]})),
            StepOutcome::Refused {
                problems: vec!["bob is dirty".into()]
            }
        );
        assert_eq!(
            refused(
                serde_json::json!({"committed": false, "reason": "git refused", "problems": []})
            ),
            StepOutcome::Refused {
                problems: vec!["git refused".into()]
            }
        );
        let plain = Reply {
            code: Some(1),
            stdout: "no\n".into(),
            stderr: String::new(),
        };
        assert_eq!(
            answer_of(Ok(plain)).outcome,
            StepOutcome::Refused {
                problems: vec!["no".into()]
            }
        );
        let crash = Reply {
            code: Some(2),
            stdout: String::new(),
            stderr: "internal error: boom\n".into(),
        };
        assert_eq!(
            answer_of(Ok(crash)).outcome,
            StepOutcome::CouldNotRun {
                reason: "internal error: boom".into(),
                repo: None,
                hook: None
            }
        );
        assert_eq!(
            answer_of(Err(NEEDS_NODE.into())).outcome,
            StepOutcome::CouldNotRun {
                reason: NEEDS_NODE.into(),
                repo: None,
                hook: None
            }
        );
    }

    /// F2: a step that runs the team's hooks may take as long as their own time limits allow. The base
    /// limit here is 3 seconds and the hook takes 6, within its own limit of 30: it is not killed.
    #[test]
    fn a_hook_is_limited_by_its_own_time_limit_not_the_base_one() {
        let dir = tempfile::tempdir().unwrap();
        let master = testutil::repo(dir.path(), "ai-sdlc");
        testutil::repo(dir.path(), "app");
        let marker = serde_json::json!({"version": 1, "systems": {"demo": {"repos": ["app"]}},
            "hooks": {"change.start": [{"id": "slow", "run": ["node", "-e", "setTimeout(() => {}, 6000)"], "timeout": 30}]}});
        testutil::commit_file(&master, ".ai-sdlc.json", &marker.to_string(), "marker");
        let place = Place {
            master,
            workspace: dir.path().to_path_buf(),
        };
        let command = [
            "change",
            "start",
            "--json",
            "--system",
            "demo",
            "--change",
            "2026-11-01-slow",
            "--type",
            "feat",
            "--scope",
            "demo",
        ];
        let answer =
            answer_of(program().exec_within(&command, &place, Duration::from_secs(3), None));
        assert_eq!(
            answer.outcome,
            StepOutcome::Passed { problems: vec![] },
            "{:?}",
            answer.json
        );
        // Plain reads keep the base limit; an event checked with `--check` runs no hook.
        let base = Duration::from_secs(3);
        assert_eq!(
            program().limit_for(&["state", "--json"], &place, base),
            base
        );
        assert!(program().limit_for(&command, &place, base) >= Duration::from_secs(33));
    }

    #[test]
    fn master_and_workspace_are_passed() {
        let (_dir, place) = workspace();
        let found = program().run(&["resolve", "--json"], &place).unwrap();
        assert!(same_path(&found["master"], &place.master), "{found}");
        assert!(same_path(&found["workspace"], &place.workspace), "{found}");
    }
}
