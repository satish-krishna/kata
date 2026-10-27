//! How the Workbench and kata start a child process: hidden on Windows, and never `git` or `gh`.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
    #[allow(clippy::disallowed_methods)] // the one place a child process is started
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
    pub limit: Duration,
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
/// timeout kills the whole process tree (a Windows job object, a process group elsewhere).
/// Output is kept as a tail of the last 50 lines (64 KiB), with ANSI sequences stripped.
pub fn run_limited(spec: &Limited) -> Outcome {
    let mut command = match hidden_command(spec.program) {
        Ok(command) => command,
        Err(refused) => return Outcome::NotStarted(refused.into()),
    };
    command
        .args(&spec.args)
        .current_dir(spec.cwd)
        .stdin(if spec.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in spec.env {
        command.env(key, value);
    }
    let mut tree = match Tree::start(command) {
        Ok(tree) => tree,
        Err(e) => return Outcome::NotStarted(e.into()),
    };

    if let (Some(bytes), Some(mut pipe)) = (spec.stdin, tree.stdin().take()) {
        let bytes = bytes.to_vec();
        // A child may exit without reading its input; a broken pipe is not an error.
        thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }
    let tail = Arc::new(Mutex::new(Tail::default()));
    let kept = Arc::new(Mutex::new(Vec::new()));
    let mut readers = Vec::new();
    if let Some(stdout) = tree.stdout().take() {
        readers.push(if spec.keep_stdout {
            spawn_collector(stdout, Arc::clone(&kept))
        } else {
            spawn_reader(stdout, Arc::clone(&tail))
        });
    }
    if let Some(stderr) = tree.stderr().take() {
        readers.push(spawn_reader(stderr, Arc::clone(&tail)));
    }

    let deadline = Instant::now() + spec.limit;
    let status = loop {
        match tree.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => break None,
            Ok(None) => thread::sleep(POLL),
            Err(e) => {
                tree.kill();
                return Outcome::WaitFailed(e);
            }
        }
    };
    if status.is_none() {
        // Killing the job object / process group ends the whole tree and closes the pipes.
        tree.kill();
    }
    drain(readers);
    let tail = tail.lock().unwrap_or_else(|e| e.into_inner()).render();
    match status {
        Some(status) => Outcome::Exited {
            code: status.code(),
            tail,
            stdout: std::mem::take(&mut *kept.lock().unwrap_or_else(|e| e.into_inner())),
        },
        None => Outcome::TimedOut { tail },
    }
}

const MAX_LINES: usize = 50;
const MAX_BYTES: usize = 64 * 1024;
/// How often the runner checks whether the child has exited.
const POLL: Duration = Duration::from_millis(20);
/// How long to wait for the output readers after the child ended, in case a surviving
/// grandchild still holds a pipe open.
const DRAIN: Duration = Duration::from_secs(2);

/// A started child and its process tree, so a timeout can end all of it.
///
/// On Windows the tree is a job object (kill on close) that the process is put into right after
/// it starts. The job is made here and not by `process-wrap`: its job object starts the process
/// suspended, and from a process with no console of its own (the Workbench is a GUI program) that
/// start hangs.
#[cfg(windows)]
struct Tree {
    child: std::process::Child,
    job: Option<windows_sys::Win32::Foundation::HANDLE>,
}

#[cfg(windows)]
impl Tree {
    fn start(mut command: Command) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let child = command.spawn()?;
        // SAFETY: plain Win32 calls on a handle created here and a live child handle; the limit
        // structure is zero-initialized (all-zero is valid for it) and passed with its own size.
        let job = unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                None
            } else {
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                let assigned = AssignProcessToJobObject(job, child.as_raw_handle().cast());
                if set != 0 && assigned != 0 {
                    Some(job)
                } else {
                    windows_sys::Win32::Foundation::CloseHandle(job);
                    None
                }
            }
        };
        Ok(Self { child, job })
    }

    fn stdin(&mut self) -> &mut Option<std::process::ChildStdin> {
        &mut self.child.stdin
    }

    fn stdout(&mut self) -> &mut Option<std::process::ChildStdout> {
        &mut self.child.stdout
    }

    fn stderr(&mut self) -> &mut Option<std::process::ChildStderr> {
        &mut self.child.stderr
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    /// Ends the child and everything it started, and reaps it.
    fn kill(&mut self) {
        if let Some(job) = self.job {
            // SAFETY: `job` is the live handle created in `start`.
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 1) };
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
impl Drop for Tree {
    fn drop(&mut self) {
        if let Some(job) = self.job {
            // SAFETY: `job` is the live handle created in `start`; closing it also ends any
            // process still in the job (KILL_ON_JOB_CLOSE).
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
        }
    }
}

/// A started child and its process tree: its own process group, so a timeout can end all of it.
#[cfg(unix)]
struct Tree {
    child: Box<dyn process_wrap::std::ChildWrapper>,
}

#[cfg(unix)]
impl Tree {
    fn start(command: Command) -> std::io::Result<Self> {
        let mut wrapped = process_wrap::std::CommandWrap::from(command);
        wrapped.wrap(process_wrap::std::ProcessGroup::leader());
        Ok(Self {
            child: wrapped.spawn()?,
        })
    }

    fn stdin(&mut self) -> &mut Option<std::process::ChildStdin> {
        self.child.stdin()
    }

    fn stdout(&mut self) -> &mut Option<std::process::ChildStdout> {
        self.child.stdout()
    }

    fn stderr(&mut self) -> &mut Option<std::process::ChildStderr> {
        self.child.stderr()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    /// Ends the child and everything it started, and reaps it.
    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Waits for the reader threads to reach end of stream, giving up after `DRAIN` overall.
fn drain(readers: Vec<Receiver<()>>) {
    let deadline = Instant::now() + DRAIN;
    for done in readers {
        let _ = done.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    }
}

/// Reads `source` to the end on its own thread, appending every byte to `sink`.
fn spawn_collector(
    mut source: impl Read + Send + 'static,
    sink: Arc<Mutex<Vec<u8>>>,
) -> Receiver<()> {
    let (finished, done) = mpsc::channel();
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = source.read(&mut chunk) {
            if n == 0 {
                break;
            }
            sink.lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend_from_slice(&chunk[..n]);
        }
        let _ = finished.send(());
    });
    done
}

/// Reads `source` to the end on its own thread, feeding whole lines into `tail`.
/// The returned receiver yields (or disconnects) once the thread is finished.
fn spawn_reader(mut source: impl Read + Send + 'static, tail: Arc<Mutex<Tail>>) -> Receiver<()> {
    let (finished, done) = mpsc::channel();
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        let mut line: Vec<u8> = Vec::new();
        loop {
            let read = match source.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for &byte in &chunk[..read] {
                if byte == b'\n' {
                    push_line(&tail, &line);
                    line.clear();
                } else {
                    line.push(byte);
                    if line.len() > 2 * MAX_BYTES {
                        line.drain(..line.len() - MAX_BYTES);
                    }
                }
            }
        }
        if !line.is_empty() {
            push_line(&tail, &line);
        }
        let _ = finished.send(());
    });
    done
}

fn push_line(tail: &Mutex<Tail>, raw: &[u8]) {
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    let text = strip_ansi(&String::from_utf8_lossy(raw));
    tail.lock().unwrap_or_else(|e| e.into_inner()).push(text);
}

/// The most recent whole lines of output, bounded by line count and total size.
#[derive(Default)]
struct Tail {
    lines: VecDeque<String>,
    /// Length of the lines joined with newlines.
    bytes: usize,
}

impl Tail {
    fn push(&mut self, mut line: String) {
        if line.len() > MAX_BYTES {
            let mut cut = line.len() - MAX_BYTES;
            while !line.is_char_boundary(cut) {
                cut += 1;
            }
            line.drain(..cut);
        }
        self.bytes += line.len() + usize::from(!self.lines.is_empty());
        self.lines.push_back(line);
        while self.lines.len() > MAX_LINES || (self.bytes > MAX_BYTES && self.lines.len() > 1) {
            if let Some(oldest) = self.lines.pop_front() {
                self.bytes -= oldest.len() + 1;
            }
        }
    }

    fn render(&self) -> String {
        self.lines
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Removes CSI sequences (`ESC [ ... final byte`), OSC sequences (`ESC ] ... BEL` or `ESC \`),
/// and other two-character escapes.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\u{7}' || (next == '\u{1b}' && chars.next() == Some('\\')) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
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

    /// A program name that is `AsRef<OsStr>` but not `AsRef<Path>`.
    struct Name(&'static str);

    impl AsRef<std::ffi::OsStr> for Name {
        fn as_ref(&self) -> &std::ffi::OsStr {
            std::ffi::OsStr::new(self.0)
        }
    }

    #[test]
    fn hidden_command_takes_any_os_str_and_still_refuses_git() {
        assert!(hidden_command(Name("git")).is_err());
        assert!(hidden_command(Name("node")).is_ok());
    }

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

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[31;1mred\u{1b}[0m done"), "red done");
    }

    #[test]
    fn strip_ansi_removes_an_osc_ended_by_bel() {
        assert_eq!(strip_ansi("\u{1b}]0;title\u{7}after"), "after");
    }

    #[test]
    fn strip_ansi_removes_an_osc_ended_by_st_and_keeps_the_text() {
        let linked = "\u{1b}]8;;http://x\u{1b}\\error text\u{1b}]8;;\u{1b}\\ tail";
        assert_eq!(strip_ansi(linked), "error text tail");
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
