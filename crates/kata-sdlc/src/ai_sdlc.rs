//! The one door to the ai-sdlc program: `node <plugin>/tools/ai-sdlc.ts <command>`.
//!
//! Every call Kata makes to the program goes through [`execute`]: it starts Node.js hidden, with a time
//! limit, and kills the whole process tree on a timeout. [`Program::run`] adds the workspace options and
//! reads the JSON the command prints on its last line.
pub mod state;

use crate::process::CapturedExit;
use kata_core::proc::{run_limited, Limited, Outcome, StartError};
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long [`Program::run`] lets a command run before its process tree is killed.
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
) -> Result<CapturedExit, Failure> {
    let mut argv: Vec<OsString> = vec![entry.into()];
    argv.extend(args.iter().map(OsString::from));
    let outcome = run_limited(&Limited {
        program: node,
        args: argv,
        cwd,
        env: &[],
        stdin: None,
        limit,
        keep_stdout: true,
        engineers_program: false,
    });
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
    /// JSON; `Refused` is for an exit 1 whose output is not JSON. Exit 2 is `CouldNotRun` with stderr.
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

    /// Runs the program with `args` as given, in `cwd`, and reads the answer as `run` does.
    fn call(&self, args: &[&str], cwd: &Path) -> Result<Value, ProgramError> {
        let exit = match execute(&self.node, &self.entry, cwd, args, TIMEOUT) {
            Ok(exit) => exit,
            Err(Failure::NodeMissing) => return Err(could_not_run(NEEDS_NODE)),
            Err(Failure::Other(message)) => return Err(could_not_run(message)),
            Err(Failure::TimedOut { secs }) => {
                return Err(could_not_run(format!(
                    "it did not finish in {secs} seconds"
                )))
            }
        };
        let stdout = String::from_utf8_lossy(&exit.stdout).into_owned();
        match exit.code {
            Some(0 | 1) => {}
            code => {
                let stderr = exit.stderr.trim();
                return Err(could_not_run(if stderr.is_empty() {
                    format!(
                        "exit {}",
                        code.map_or("by signal".into(), |c| c.to_string())
                    )
                } else {
                    stderr.to_string()
                }));
            }
        }
        let last = stdout.lines().rev().find(|l| !l.trim().is_empty());
        match last.map(serde_json::from_str::<Value>) {
            Some(Ok(value)) => Ok(value),
            _ if exit.code == Some(1) => Err(ProgramError::Refused { stdout }),
            _ => Err(could_not_run(format!(
                "it printed something that is not JSON: {}",
                stdout.trim()
            ))),
        }
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
    fn master_and_workspace_are_passed() {
        let (_dir, place) = workspace();
        let found = program().run(&["resolve", "--json"], &place).unwrap();
        assert!(same_path(&found["master"], &place.master), "{found}");
        assert!(same_path(&found["workspace"], &place.workspace), "{found}");
    }
}
