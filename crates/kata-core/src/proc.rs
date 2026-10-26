//! How the Workbench and kata start a child process: hidden on Windows, and never `git` or `gh`.

use std::path::Path;
use std::process::Command;

/// The Windows process-creation flag that gives a console program no console window.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A program Kata refuses to start.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Kata does not start {program}; it does this work itself.")]
pub struct SpawnRefused {
    /// The program name as it was asked for.
    pub program: String,
}

/// A `Command` for `program` that opens no console window on Windows.
///
/// Refuses `git` and `gh` on every build, tests included: Kata does that work itself.
pub fn hidden_command(program: impl AsRef<Path>) -> Result<Command, SpawnRefused> {
    let program = program.as_ref();
    if is_refused(program) {
        return Err(SpawnRefused {
            program: program.to_string_lossy().into_owned(),
        });
    }
    #[allow(unused_mut)] // `creation_flags` needs it on Windows
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command)
}

/// Why a child process could not be started.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    /// Kata refuses to start this program.
    #[error(transparent)]
    Refused(#[from] SpawnRefused),
    /// The operating system could not start it.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// One command to run to completion within a time limit; see [`run_limited`].
pub struct Limited<'a> {
    pub program: &'a Path,
    pub args: Vec<std::ffi::OsString>,
    pub cwd: &'a Path,
    pub env: &'a [(&'a str, &'a std::ffi::OsStr)],
    /// Bytes to write to the child's stdin; `None` gives it a null stdin.
    pub stdin: Option<&'a [u8]>,
    pub limit: std::time::Duration,
    /// Keep all of stdout apart (in `Outcome::Exited::stdout`) and let the tail hold stderr only.
    pub keep_stdout: bool,
}

/// How a [`Limited`] command ended.
#[derive(Debug)]
pub enum Outcome {
    /// It exited on its own. `code` is `None` when a signal ended it.
    Exited {
        code: Option<i32>,
        tail: String,
        stdout: Vec<u8>,
    },
    /// It ran past the limit and its whole process tree was killed.
    TimedOut { tail: String },
    /// It could not be started.
    NotStarted(StartError),
    /// It was started but waiting for it failed; its tree was killed.
    WaitFailed(std::io::Error),
}

/// Runs `spec`: starts the program through [`hidden_command`], waits up to the limit, and on a
/// timeout kills the whole process tree. Output is kept as a tail of the last 50 lines (64 KiB),
/// with ANSI sequences stripped.
pub fn run_limited(spec: &Limited) -> Outcome {
    let _ = spec;
    todo!("run_limited")
}

/// Removes ANSI escape sequences from `text`.
fn strip_ansi(text: &str) -> String {
    text.to_string()
}

/// Whether the file name of `program`, without its extension, is `git` or `gh` (any case).
fn is_refused(program: &Path) -> bool {
    let name = program.to_string_lossy();
    // Split by hand: `Path` treats `\` as a separator only on Windows, and the rule is the same everywhere.
    let file = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let stem = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
    stem.eq_ignore_ascii_case("git") || stem.eq_ignore_ascii_case("gh")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn fake_claude() -> std::path::PathBuf {
        // The test binary lives in target/<profile>/deps; fake-claude one level up.
        let exe = std::env::current_exe().unwrap();
        exe.parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("fake-claude.exe")
    }

    /// Starts `fake-claude` as a relay with no console of its own (DETACHED_PROCESS), so a child
    /// it starts without `CREATE_NO_WINDOW` is given a console window of its own, whatever
    /// console the test process has (a CI or agent session often has a windowless one). The
    /// relay starts the probe plainly or through `hidden_command`, and passes its output on.
    #[cfg(windows)]
    fn relayed_probe(hidden: bool) -> Vec<String> {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        // Test code: the relay itself is a plain, console-less Command.
        #[allow(clippy::disallowed_methods)]
        let mut relay = Command::new(fake_claude());
        relay
            .env("KATA_FAKE_MODE", "consoleprobe-relay")
            .creation_flags(DETACHED_PROCESS)
            .stdin(std::process::Stdio::null());
        if hidden {
            relay.env("KATA_RELAY_HIDDEN", "1");
        } else {
            relay.env_remove("KATA_RELAY_HIDDEN");
        }
        let out = relay.output().unwrap();
        assert!(out.status.success(), "relay failed: {:?}", out.status);
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[cfg(windows)]
    #[test]
    fn hidden_child_has_no_console_window() {
        // Control: a plain child of a console-less parent gets a console window. Without this,
        // `window=0` could just mean the probe cannot see one.
        let plain = relayed_probe(false);
        assert!(
            plain.iter().any(|l| l == "window=1"),
            "control: a plain child must see a console window, got {plain:?}"
        );
        let lines = relayed_probe(true);
        assert!(lines.iter().any(|l| l == "window=0"), "got {lines:?}");
    }

    #[cfg(windows)]
    #[test]
    fn grandchild_inherits_the_hidden_console() {
        let plain = relayed_probe(false);
        assert!(
            plain.iter().any(|l| l == "child-window=1"),
            "control: got {plain:?}"
        );
        let lines = relayed_probe(true);
        assert!(lines.iter().any(|l| l == "child-window=0"), "got {lines:?}");
    }

    mod limited {
        use super::*;
        use std::ffi::OsString;
        use std::time::{Duration, Instant};

        fn script(windows: &str, unix: &str) -> (&'static str, Vec<OsString>) {
            if cfg!(windows) {
                ("cmd", vec!["/C".into(), windows.into()])
            } else {
                ("sh", vec!["-c".into(), unix.into()])
            }
        }

        fn spec<'a>(
            program: &'a str,
            args: Vec<OsString>,
            cwd: &'a Path,
            limit_secs: u64,
        ) -> Limited<'a> {
            Limited {
                program: Path::new(program),
                args,
                cwd,
                env: &[],
                stdin: None,
                limit: Duration::from_secs(limit_secs),
                keep_stdout: false,
            }
        }

        #[test]
        fn exit_code_and_combined_tail() {
            let dir = tempfile::tempdir().unwrap();
            let (program, args) = script(
                "echo out& echo err 1>&2& exit 3",
                "echo out; echo err 1>&2; exit 3",
            );
            match run_limited(&spec(program, args, dir.path(), 10)) {
                Outcome::Exited { code, tail, stdout } => {
                    assert_eq!(code, Some(3));
                    assert!(tail.contains("out") && tail.contains("err"), "{tail:?}");
                    assert!(stdout.is_empty());
                }
                other => panic!("{other:?}"),
            }
        }

        #[test]
        fn keeps_the_last_50_lines_and_strips_ansi() {
            let dir = tempfile::tempdir().unwrap();
            let (program, args) = script(
                "for /L %i in (1,1,200) do @echo %i",
                "i=1; while [ $i -le 200 ]; do echo $i; i=$((i+1)); done",
            );
            let Outcome::Exited { tail, .. } = run_limited(&spec(program, args, dir.path(), 30))
            else {
                panic!("expected Exited")
            };
            let lines: Vec<&str> = tail.lines().collect();
            assert_eq!(lines.len(), 50, "{tail:?}");
            assert_eq!(lines[0], "151");
            assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m"), "red");
        }

        #[test]
        fn sets_env_and_cwd() {
            let dir = tempfile::tempdir().unwrap();
            let (program, args) = script("echo %KATA_T%& cd", "echo $KATA_T; pwd");
            let mut run = spec(program, args, dir.path(), 10);
            let env = [("KATA_T", std::ffi::OsStr::new("from-env"))];
            run.env = &env;
            let Outcome::Exited { tail, .. } = run_limited(&run) else {
                panic!("expected Exited")
            };
            let name = dir
                .path()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();
            assert!(tail.contains("from-env"), "{tail:?}");
            assert!(tail.contains(&name), "{tail:?}");
        }

        #[test]
        fn stdin_bytes_reach_the_child() {
            let dir = tempfile::tempdir().unwrap();
            let program = if cfg!(windows) { "sort" } else { "cat" };
            let mut run = spec(program, Vec::new(), dir.path(), 10);
            run.stdin = Some(b"from-stdin\r\n");
            let Outcome::Exited { tail, .. } = run_limited(&run) else {
                panic!("expected Exited")
            };
            assert!(tail.contains("from-stdin"), "{tail:?}");
        }

        #[test]
        fn keep_stdout_holds_it_whole_and_the_tail_is_stderr() {
            let dir = tempfile::tempdir().unwrap();
            let (program, args) = script("echo out& echo err 1>&2", "echo out; echo err 1>&2");
            let mut run = spec(program, args, dir.path(), 10);
            run.keep_stdout = true;
            let Outcome::Exited { tail, stdout, .. } = run_limited(&run) else {
                panic!("expected Exited")
            };
            assert!(String::from_utf8_lossy(&stdout).contains("out"));
            assert!(tail.contains("err") && !tail.contains("out"), "{tail:?}");
        }

        #[test]
        fn a_timeout_kills_the_whole_tree() {
            let dir = tempfile::tempdir().unwrap();
            let started = Instant::now();
            let (program, args) = script(
                "echo before& ping -n 4 127.0.0.1 >NUL& echo late> late.txt",
                "echo before; sleep 3; touch late.txt",
            );
            match run_limited(&spec(program, args, dir.path(), 1)) {
                Outcome::TimedOut { tail } => assert!(tail.contains("before"), "{tail:?}"),
                other => panic!("expected TimedOut, got {other:?}"),
            }
            assert!(started.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_secs(5));
            assert!(
                !dir.path().join("late.txt").exists(),
                "a child survived the timeout"
            );
        }

        #[test]
        fn a_program_that_cannot_start_or_is_refused() {
            let dir = tempfile::tempdir().unwrap();
            let missing = spec("kata-no-such-binary", Vec::new(), dir.path(), 5);
            assert!(matches!(
                run_limited(&missing),
                Outcome::NotStarted(StartError::Io(_))
            ));
            let refused = spec("git", Vec::new(), dir.path(), 5);
            assert!(matches!(
                run_limited(&refused),
                Outcome::NotStarted(StartError::Refused(_))
            ));
        }
    }

    #[test]
    fn refuses_git_and_gh() {
        for p in ["git", "GIT.EXE", r"C:\x\gh.exe", "gh.cmd"] {
            let err = hidden_command(p).unwrap_err();
            assert_eq!(err.program, p);
            assert!(err.to_string().contains("does this work itself"));
        }
        for p in ["node", "github-helper"] {
            assert!(hidden_command(p).is_ok(), "{p}");
        }
    }
}
