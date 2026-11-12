//! The one door to the ai-sdlc program: `node <plugin>/tools/ai-sdlc.ts <command>`.
//!
//! Every call Kata makes to the program goes through [`execute`]: it starts Node.js hidden, with a time
//! limit, and kills the whole process tree on a timeout. Every answer is read by [`answer_of`]: a step
//! (an event, a commit, a change command) through [`Program::step`] as a typed [`StepOutcome`], and a
//! read through [`Program::run`] as its JSON.
pub mod list;
pub mod show;
pub mod state;
pub mod status;

use crate::process::CapturedExit;
use kata_core::proc::{
    run_limited, run_limited_streaming, Bound, CancelToken, Limited, LineSink, Outcome, StartError,
};
use serde::Serialize;
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a quick read may run before its process tree is killed.
pub const TIMEOUT: Duration = Duration::from_secs(60);

/// Whether a command is a quick read, which has a time limit, or a long step, which has none and can be
/// stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallKind {
    Quick,
    Long,
}

/// The kind of `command`.
pub fn call_kind(_command: &[&str]) -> CallKind {
    CallKind::Quick
}

/// Why a step has no exit to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecError {
    /// The program could not run; the reason as the engineer reads it.
    Machine(String),
    /// The engineer stopped it.
    Stopped,
}

/// What a missing `node` is reported as.
pub const NEEDS_NODE: &str = "ai-sdlc needs Node.js 22.18 or later";

/// The commands that take `--master` and `--workspace`.
const PLACED: &[&str] = &[
    "resolve",
    "state",
    "list",
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
    /// The engineer stopped it and its tree was killed.
    Stopped,
}

/// Runs `node <entry> <args>` in `cwd`, hidden, within `limit`, and returns how it exited.
pub(crate) fn execute(
    node: &Path,
    entry: &Path,
    cwd: &Path,
    args: &[&str],
    bound: Bound,
    on_line: Option<LineSink>,
) -> Result<CapturedExit, Failure> {
    let secs = bound.limit().map_or(0, |l| l.as_secs());
    let mut argv: Vec<OsString> = vec![entry.into()];
    argv.extend(args.iter().map(OsString::from));
    let spec = Limited {
        program: node,
        args: argv,
        cwd,
        env: &[],
        stdin: None,
        bound,
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
        Outcome::TimedOut { .. } => Err(Failure::TimedOut { secs }),
        Outcome::Cancelled { .. } => Err(Failure::Stopped),
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
    /// The engineer stopped the step.
    Stopped,
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
pub fn answer_of(reply: Result<Reply, ExecError>) -> Answer {
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
        Err(ExecError::Machine(reason)) => return machine(reason, Value::Null),
        Err(ExecError::Stopped) => return machine("stub".to_string(), Value::Null),
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

    /// Runs `command` in `workspace` with no master given, so the program finds the master in process as
    /// `resolve` does: one Node start where [`Program::resolve`] then [`Program::run`] takes two. For a command
    /// that takes `--workspace` (`list`, `state`); the answer is read as `run` reads it.
    pub fn run_in(&self, command: &[&str], workspace: &Path) -> Result<Value, ProgramError> {
        if !self.entry.is_file() {
            return Err(ProgramError::TooOld {
                found: format!("{} does not exist", self.entry.display()),
            });
        }
        let ws = workspace.display().to_string();
        let mut args = command.to_vec();
        args.extend(["--workspace", &ws]);
        self.call(&args, workspace)
    }

    /// Runs a step (`command`) in `place` and reads its answer through [`answer_of`].
    pub fn step(&self, command: &[&str], place: &Place) -> Answer {
        answer_of(self.exec(command, place))
    }

    /// Runs a long step: no time limit, ended when the plugin answers or `token` is cancelled. Adds
    /// `--stream` to an event when `on_line` is given.
    pub fn step_long(
        &self,
        _command: &[&str],
        _place: &Place,
        _token: &CancelToken,
        _on_line: Option<LineSink>,
    ) -> Answer {
        unimplemented!("step_long")
    }

    /// [`Program::step`] that hands each whole stdout line to `on_line` while it runs (`--stream`).
    pub fn step_streaming(&self, command: &[&str], place: &Place, on_line: LineSink) -> Answer {
        answer_of(self.exec_bound(command, place, Bound::Within(TIMEOUT), Some(on_line)))
    }

    /// Runs `command` in `place` and returns how it exited, within [`TIMEOUT`].
    pub fn exec(&self, command: &[&str], place: &Place) -> Result<Reply, ExecError> {
        self.exec_within(command, place, TIMEOUT)
    }

    /// [`Program::exec`] with `limit` as the time limit.
    pub(crate) fn exec_within(
        &self,
        command: &[&str],
        place: &Place,
        limit: Duration,
    ) -> Result<Reply, ExecError> {
        self.exec_bound(command, place, Bound::Within(limit), None)
    }

    fn exec_bound(
        &self,
        command: &[&str],
        place: &Place,
        bound: Bound,
        on_line: Option<LineSink>,
    ) -> Result<Reply, ExecError> {
        if !self.entry.is_file() {
            return Err(ExecError::Machine(
                ProgramError::TooOld {
                    found: format!("{} does not exist", self.entry.display()),
                }
                .to_string(),
            ));
        }
        let master = place.master.display().to_string();
        let workspace = place.workspace.display().to_string();
        let args = with_place(command, &master, &workspace);
        match execute(
            &self.node,
            &self.entry,
            &place.workspace,
            &args,
            bound,
            on_line,
        ) {
            Ok(exit) => Ok(Reply {
                code: exit.code,
                stdout: String::from_utf8_lossy(&exit.stdout).into_owned(),
                stderr: exit.stderr,
            }),
            Err(Failure::Stopped) => Err(ExecError::Stopped),
            Err(failure) => Err(ExecError::Machine(failure.reason())),
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
        let bound = Bound::Within(TIMEOUT);
        let reply = match execute(&self.node, &self.entry, cwd, args, bound, None) {
            Ok(exit) => Ok(Reply {
                code: exit.code,
                stdout: String::from_utf8_lossy(&exit.stdout).into_owned(),
                stderr: exit.stderr,
            }),
            Err(Failure::Stopped) => Err(ExecError::Stopped),
            Err(failure) => Err(ExecError::Machine(failure.reason())),
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
            Failure::Stopped => "it was stopped".to_string(),
        }
    }
}

/// A read's answer: the JSON of exit 0 and exit 1 (an answer such as `refused` is still an answer), read
/// through [`answer_of`] like every step's, so an exit 2 is the plugin's own reason.
fn read_value(reply: Result<Reply, ExecError>) -> Result<Value, ProgramError> {
    let code = reply.as_ref().ok().and_then(|r| r.code);
    let stdout = reply.as_ref().map(|r| r.stdout.clone()).unwrap_or_default();
    let answer = answer_of(reply);
    match (code, answer.outcome) {
        (Some(0 | 1), _) if !answer.json.is_null() => Ok(answer.json),
        (_, StepOutcome::CouldNotRun { reason, .. }) => Err(could_not_run(reason)),
        (_, StepOutcome::Stopped) => Err(could_not_run("it was stopped")),
        _ => Err(ProgramError::Refused { stdout }),
    }
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

    /// Whether `value` names the folder `expected`, whatever form either path takes: an 8.3
    /// short name, a different case, a verbatim prefix or the slash direction.
    fn same_path(value: &Value, expected: &Path) -> bool {
        let norm = |p: &Path| {
            let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
            let text = resolved.display().to_string().replace('\\', "/");
            text.trim_start_matches("//?/").to_lowercase()
        };
        value
            .as_str()
            .is_some_and(|s| norm(Path::new(s)) == norm(expected))
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
            answer_of(Err(ExecError::Machine(NEEDS_NODE.into()))).outcome,
            StepOutcome::CouldNotRun {
                reason: NEEDS_NODE.into(),
                repo: None,
                hook: None
            }
        );
    }

    /// The commands each action of the Workbench sends, and what kind each is.
    #[test]
    fn call_kind_table() {
        let long: &[&[&str]] = &[
            &["change", "start", "--json", "--system", "demo"],
            &["change", "rename", "--json", "--change", "a"],
            &["change", "remove", "--json", "--change", "a"],
            &["commit", "--json", "--kind", "work"],
            &["run", "build.start", "--json", "--check"],
            &["run", "build.start", "--json", "--repo", "kata"],
            &["run", "build.start", "--json"],
            &["run", "doc.accept", "--json"],
            &["run", "doc.reject", "--json"],
            &["run", "change.done", "--json", "--stream"],
            &["run", "review.start", "--json"],
        ];
        for command in long {
            assert_eq!(call_kind(command), CallKind::Long, "{command:?}");
        }
        let quick: &[&[&str]] = &[
            &["change", "show", "--json", "--change", "a"],
            &["resolve", "--json"],
            &["state", "--json"],
            &["list", "--json"],
            &["stale", "--json"],
            &["instructions", "--json"],
            &["hooks", "--json"],
            &["status", "--json"],
            &["scope", "--json"],
            &["naming", "--json"],
            &["branch-name", "--json"],
            &["read", "plan.md"],
            &["check", "--json"],
            &["baseline", "show", "--json"],
        ];
        for command in quick {
            assert_eq!(call_kind(command), CallKind::Quick, "{command:?}");
        }
    }

    #[test]
    fn a_quick_read_may_run_five_minutes() {
        assert_eq!(TIMEOUT, Duration::from_secs(300));
        // The format program's reads use the same limit, with no limit of their own.
        let format = include_str!("format.rs");
        assert!(format.contains("ai_sdlc::TIMEOUT"));
        assert!(!format.contains("const TIMEOUT"));
    }

    #[test]
    fn a_hung_quick_read_ends_at_its_limit() {
        let dir = tempfile::tempdir().unwrap();
        let (program, place) = scripted(dir.path(), "setTimeout(() => {}, 60000);");
        let started = std::time::Instant::now();
        let reply = program.exec_within(&["state", "--json"], &place, Duration::from_secs(1));
        assert!(started.elapsed() < Duration::from_secs(30));
        let Err(ExecError::Machine(message)) = &reply else {
            panic!("{reply:?}");
        };
        assert!(message.contains("1 seconds"), "{message}");
        assert!(matches!(
            answer_of(reply).outcome,
            StepOutcome::CouldNotRun { .. }
        ));
    }

    /// R14.2: the team's hook limits add up to 1 second, the step takes 3, and it is not cut off.
    #[test]
    fn a_long_call_has_no_limit_from_its_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let master = testutil::repo(dir.path(), "ai-sdlc");
        let marker = serde_json::json!({"version": 1, "systems": {"demo": {"repos": []}},
            "hooks": {"build.start": [{"id": "quick", "run": ["node", "-e", "0"], "timeout": 1}]}});
        testutil::commit_file(&master, ".ai-sdlc.json", &marker.to_string(), "marker");
        let (program, mut place) = scripted(
            dir.path(),
            "setTimeout(() => { process.stdout.write(JSON.stringify({outcome: 'passed', problems: []}) + '\n'); }, 3000);",
        );
        place.master = master;
        let answer = program.step_long(
            &["run", "build.start", "--json", "--system", "demo"],
            &place,
            &CancelToken::new(),
            None,
        );
        assert_eq!(answer.outcome, StepOutcome::Passed { problems: vec![] });
    }

    /// R14.1: a hook that ran past its own limit is the plugin's could-not-run answer, in its words.
    #[test]
    fn a_hook_past_its_own_limit_reads_as_could_not_run() {
        let event = serde_json::json!({"event": "build.start", "repo": "kata", "outcome": "could-not-run",
            "problems": ["hook base-tests ran past its time limit of 600 seconds and was stopped"],
            "hooks": [],
            "failed": {"id": "base-tests", "onFailure": "stop", "output": ""}});
        assert_eq!(
            answer_of(Ok(Reply::json(2, &event))).outcome,
            StepOutcome::CouldNotRun {
                reason: "hook base-tests ran past its time limit of 600 seconds and was stopped"
                    .into(),
                repo: Some("kata".into()),
                hook: Some(HookFailure {
                    id: "base-tests".into(),
                    on_failure: Some("stop".into()),
                    output: String::new(),
                }),
            }
        );
    }

    #[test]
    fn a_long_command_through_exec_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (program, place) = answering(
            dir.path(),
            0,
            &serde_json::json!({"outcome": "passed", "problems": []}),
        );
        let command = ["run", "build.start", "--json"];
        match program.exec(&command, &place) {
            Err(ExecError::Machine(message)) => {
                assert!(message.contains("step_long"), "{message}")
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            program.step(&command, &place).outcome,
            StepOutcome::CouldNotRun { .. }
        ));
    }

    #[test]
    fn stopping_a_long_call_reads_as_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let (program, place) = scripted(dir.path(), "setTimeout(() => {}, 60000);");
        let token = CancelToken::new();
        let stopper = {
            let token = token.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(700));
                token.cancel();
            })
        };
        let started = std::time::Instant::now();
        let answer = program.step_long(&["run", "build.start", "--json"], &place, &token, None);
        stopper.join().unwrap();
        assert_eq!(answer.outcome, StepOutcome::Stopped);
        assert!(started.elapsed() < Duration::from_secs(30));
    }

    #[test]
    fn master_and_workspace_are_passed() {
        let (_dir, place) = workspace();
        let found = program().run(&["resolve", "--json"], &place).unwrap();
        assert!(same_path(&found["master"], &place.master), "{found}");
        assert!(same_path(&found["workspace"], &place.workspace), "{found}");
    }
}
