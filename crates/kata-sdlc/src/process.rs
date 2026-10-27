//! Runs one command to completion with a bounded output tail and a hard timeout, through
//! `kata_core::proc::run_limited`, which kills the whole process tree on a timeout.
use kata_core::proc::{run_limited, Limited, Outcome, StartError};
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

/// How a command could not be run to completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProcessError {
    /// The program could not be started; the message is safe to show as is.
    SpawnFailed(String),
    /// The command ran past its limit and was killed; `tail` is the output captured so far.
    TimedOut { secs: u64, tail: String },
}

/// How a finished process ended, plus the last lines of its combined stdout and stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessExit {
    /// The exit code, or `None` when the process was ended by a signal.
    pub code: Option<i32>,
    /// The last 50 lines (at most 64 KiB) of combined output, lossy UTF-8, ANSI stripped.
    pub tail: String,
}

/// Runs `argv` in `cwd` with a null stdin and the inherited environment. A timeout kills the
/// process tree and returns `TimedOut` with the output captured so far.
pub(crate) fn run(
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
) -> Result<ProcessExit, ProcessError> {
    let (code, tail, _) = run_argv(argv, cwd, timeout, false)?;
    Ok(ProcessExit { code, tail })
}

/// How a finished process ended, with its whole stdout and its stderr kept apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CapturedExit {
    /// The exit code, or `None` when the process was ended by a signal.
    pub code: Option<i32>,
    /// Everything the process wrote to stdout, undecoded.
    pub stdout: Vec<u8>,
    /// The last lines of stderr, lossy UTF-8, ANSI stripped.
    pub stderr: String,
}

/// Like `run`, but keeps all of stdout (a parsed document can be far larger than the 64 KiB tail)
/// and keeps stderr apart from it. A timeout kills the process tree and returns `TimedOut` with
/// the stderr captured so far.
pub(crate) fn run_capture(
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
) -> Result<CapturedExit, ProcessError> {
    let (code, stderr, stdout) = run_argv(argv, cwd, timeout, true)?;
    Ok(CapturedExit {
        code,
        stdout,
        stderr,
    })
}

/// Runs `argv` in `cwd` and returns the exit code, the output tail and the kept stdout.
fn run_argv(
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
    keep_stdout: bool,
) -> Result<(Option<i32>, String, Vec<u8>), ProcessError> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| ProcessError::SpawnFailed("the command is empty".into()))?;
    #[cfg(windows)]
    let resolved = resolve_program(
        program,
        cwd,
        &std::env::var("PATH").unwrap_or_default(),
        std::env::var("PATHEXT").ok().as_deref(),
    )
    .ok_or_else(|| not_found(program))?;
    #[cfg(not(windows))]
    let resolved = std::path::PathBuf::from(program);
    let outcome = run_limited(&Limited {
        program: &resolved,
        args: args.iter().map(OsString::from).collect(),
        cwd,
        env: &[],
        stdin: None,
        limit: timeout,
        keep_stdout,
        engineers_program: false,
    });
    match outcome {
        Outcome::Exited { code, tail, stdout } => Ok((code, tail, stdout)),
        Outcome::TimedOut { tail } => Err(ProcessError::TimedOut {
            secs: timeout.as_secs(),
            tail,
        }),
        Outcome::NotStarted(StartError::Refused(refused)) => {
            Err(ProcessError::SpawnFailed(refused.to_string()))
        }
        Outcome::NotStarted(StartError::Io(_)) => Err(not_found(program)),
        Outcome::WaitFailed(e) => Err(ProcessError::SpawnFailed(format!(
            "{program} could not be waited on: {e}"
        ))),
    }
}

fn not_found(program: &str) -> ProcessError {
    ProcessError::SpawnFailed(format!("{program} was not found on this machine"))
}

/// Windows only: the full path to spawn for `argv0`. Rust's `Command` appends only `.exe` and
/// resolves relative paths against Kata's own directory, so this does what a shell would:
/// a relative path with a separator is joined to the repository root `cwd`, and a bare name
/// without an extension is searched along `path_var` trying each `pathext_var` extension
/// (default `.COM;.EXE;.BAT;.CMD`). A bare name that is not found yields `None`.
#[cfg(windows)]
fn resolve_program(
    argv0: &str,
    cwd: &Path,
    path_var: &str,
    pathext_var: Option<&str>,
) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    let exts: Vec<String> = pathext_var
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .filter(|e| !e.is_empty())
        .map(str::to_string)
        .collect();
    let with_exts = |base: PathBuf| -> Option<PathBuf> {
        if base.is_file() {
            return Some(base);
        }
        exts.iter()
            .map(|e| PathBuf::from(format!("{}{e}", base.display())))
            .find(|c| c.is_file())
    };
    let given = Path::new(argv0);
    if argv0.contains(['/', '\\']) {
        let full = if given.is_absolute() {
            given.to_path_buf()
        } else {
            cwd.join(given)
        };
        if given.extension().is_some() {
            return Some(full);
        }
        return Some(with_exts(full.clone()).unwrap_or(full));
    }
    if given.extension().is_some() {
        return Some(given.to_path_buf());
    }
    std::env::split_paths(path_var).find_map(|dir| {
        exts.iter()
            .map(|e| dir.join(format!("{argv0}{e}")))
            .find(|c| c.is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn script(windows: &str, unix: &str) -> Vec<String> {
        if cfg!(windows) {
            vec!["cmd".into(), "/C".into(), windows.into()]
        } else {
            vec!["sh".into(), "-c".into(), unix.into()]
        }
    }

    fn powershell(command: &str) -> Vec<String> {
        vec![
            "powershell".into(),
            "-NoProfile".into(),
            "-Command".into(),
            command.into(),
        ]
    }

    fn run_in_temp(argv: Vec<String>, timeout_secs: u64) -> Result<ProcessExit, ProcessError> {
        let dir = tempfile::tempdir().unwrap();
        run(&argv, dir.path(), Duration::from_secs(timeout_secs))
    }

    #[test]
    fn captures_the_exit_code_and_output() {
        let exit = run_in_temp(script("echo hello&& exit 3", "echo hello; exit 3"), 10).unwrap();
        assert_eq!(exit.code, Some(3));
        assert!(exit.tail.contains("hello"), "{:?}", exit.tail);
    }

    #[test]
    fn keeps_only_the_last_50_lines() {
        let exit = run_in_temp(
            script(
                "for /L %i in (1,1,200) do @echo %i",
                "i=1; while [ $i -le 200 ]; do echo $i; i=$((i+1)); done",
            ),
            30,
        )
        .unwrap();
        let lines: Vec<&str> = exit.tail.lines().collect();
        assert_eq!(lines.len(), 50, "{:?}", exit.tail);
        assert_eq!(lines[0], "151");
        assert_eq!(lines[49], "200");
    }

    #[test]
    fn huge_output_stays_under_64_kib() {
        let hundred = "x".repeat(100);
        let exit = run_in_temp(
            script(
                &format!("for /L %i in (1,1,100000) do @echo {hundred}"),
                &format!("yes {hundred} | head -n 100000"),
            ),
            120,
        )
        .unwrap();
        assert!(exit.tail.len() <= 64 * 1024, "{}", exit.tail.len());
        assert!(!exit.tail.is_empty());
    }

    #[test]
    fn one_enormous_line_keeps_only_its_last_64_kib() {
        let argv = if cfg!(windows) {
            powershell("[Console]::Out.Write(('a' * 200000) + 'END')")
        } else {
            script("", "head -c 200000 /dev/zero | tr '\\0' a; printf END")
        };
        let exit = run_in_temp(argv, 30).unwrap();
        assert!(exit.tail.len() <= 64 * 1024, "{}", exit.tail.len());
        assert!(exit.tail.ends_with("END"));
    }

    #[test]
    fn stderr_is_captured_too() {
        let exit = run_in_temp(script("echo oops 1>&2", "echo oops 1>&2"), 10).unwrap();
        assert!(exit.tail.contains("oops"), "{:?}", exit.tail);
    }

    #[test]
    fn non_utf8_output_decodes_lossily() {
        let argv = if cfg!(windows) {
            powershell("[Console]::OpenStandardOutput().WriteByte(255)")
        } else {
            script("", "printf '\\377'")
        };
        let exit = run_in_temp(argv, 30).unwrap();
        assert!(exit.tail.contains('\u{FFFD}'), "{:?}", exit.tail);
    }

    #[test]
    fn ansi_sequences_are_stripped() {
        let argv = if cfg!(windows) {
            powershell("[Console]::Out.Write([char]27 + '[31mred' + [char]27 + '[0m')")
        } else {
            script("", "printf '\\033[31mred\\033[0m'")
        };
        let exit = run_in_temp(argv, 30).unwrap();
        assert_eq!(exit.tail, "red");
    }

    #[test]
    fn stdin_is_null_so_a_prompt_does_not_hang() {
        let started = Instant::now();
        let _ = run_in_temp(script("set /p x=", "read x"), 10);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_missing_binary_is_spawn_failed() {
        let result = run_in_temp(vec!["kata-no-such-binary".into()], 5);
        assert!(
            matches!(result, Err(ProcessError::SpawnFailed(_))),
            "{result:?}"
        );
    }

    #[test]
    fn an_empty_argv_is_spawn_failed() {
        let result = run_in_temp(Vec::new(), 5);
        assert!(
            matches!(result, Err(ProcessError::SpawnFailed(_))),
            "{result:?}"
        );
    }

    #[test]
    fn a_timeout_kills_and_reports_timed_out() {
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        // The command writes `late.txt` after the limit; a surviving child would leave it behind.
        let argv = script(
            "echo before& ping -n 4 127.0.0.1 >NUL& echo late> late.txt",
            "echo before; sleep 3; touch late.txt",
        );
        let result = run(&argv, dir.path(), Duration::from_secs(1));
        match result {
            Err(ProcessError::TimedOut { secs: 1, tail }) => {
                assert!(tail.contains("before"), "{tail:?}")
            }
            other => panic!("expected TimedOut, got {other:?}"),
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        std::thread::sleep(Duration::from_secs(5));
        assert!(
            !dir.path().join("late.txt").exists(),
            "a child survived the timeout"
        );
    }

    #[test]
    fn runs_in_the_given_directory() {
        let dir = tempfile::tempdir().unwrap();
        let exit = run(&script("cd", "pwd"), dir.path(), Duration::from_secs(10)).unwrap();
        let name = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(exit.tail.contains(&name), "{:?}", exit.tail);
    }

    #[cfg(windows)]
    mod windows_resolution {
        use super::*;

        fn touch(dir: &Path, name: &str) -> std::path::PathBuf {
            let path = dir.join(name);
            std::fs::write(&path, "@echo off\r\necho tool-ran\r\n").unwrap();
            path
        }

        /// Windows paths compare case-insensitively; PATHEXT supplies upper-case extensions.
        fn assert_same_path(found: Option<std::path::PathBuf>, expected: &Path) {
            let found = found.expect("a path").display().to_string().to_lowercase();
            assert_eq!(found, expected.display().to_string().to_lowercase());
        }

        #[test]
        fn a_bare_name_resolves_through_pathext_on_the_path() {
            let bin = tempfile::tempdir().unwrap();
            let cmd = touch(bin.path(), "mytool.cmd");
            let cwd = tempfile::tempdir().unwrap();
            let found = resolve_program(
                "mytool",
                cwd.path(),
                &bin.path().display().to_string(),
                Some(".EXE;.CMD"),
            );
            assert_same_path(found, &cmd);
        }

        #[test]
        fn the_default_pathext_applies_when_the_variable_is_missing() {
            let bin = tempfile::tempdir().unwrap();
            let cmd = touch(bin.path(), "mytool.cmd");
            let cwd = tempfile::tempdir().unwrap();
            assert_same_path(
                resolve_program(
                    "mytool",
                    cwd.path(),
                    &bin.path().display().to_string(),
                    None,
                ),
                &cmd,
            );
        }

        #[test]
        fn a_bare_name_that_is_nowhere_on_the_path_is_none() {
            let bin = tempfile::tempdir().unwrap();
            let cwd = tempfile::tempdir().unwrap();
            assert_eq!(
                resolve_program(
                    "mytool",
                    cwd.path(),
                    &bin.path().display().to_string(),
                    None
                ),
                None
            );
        }

        #[test]
        fn a_relative_path_resolves_against_the_repository_root() {
            let repo = tempfile::tempdir().unwrap();
            assert_eq!(
                resolve_program(".\\tool.cmd", repo.path(), "", None),
                Some(repo.path().join(".\\tool.cmd"))
            );
            let other = touch(repo.path(), "other.cmd");
            assert_same_path(
                resolve_program("./other", repo.path(), "", None),
                &repo.path().join("./other.cmd"),
            );
            assert!(other.is_file());
        }

        #[test]
        fn a_repo_relative_cmd_runs_end_to_end() {
            let repo = tempfile::tempdir().unwrap();
            touch(repo.path(), "tool.cmd");
            let exit = run(
                &[".\\tool.cmd".to_string()],
                repo.path(),
                Duration::from_secs(10),
            )
            .unwrap();
            assert_eq!(exit.code, Some(0));
            assert!(exit.tail.contains("tool-ran"), "{:?}", exit.tail);
        }
    }
}
