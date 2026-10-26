//! Where a repository's hooks live and how one hook is run, and whether an operation needs a
//! program the Workbench cannot start.

use crate::proc::hidden_command;
use git2::{AttrCheckFlags, AttrValue, Repository};
use std::collections::VecDeque;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// How long one hook may run before it is killed.
pub const HOOK_LIMIT: Duration = Duration::from_secs(5 * 60);

const MAX_LINES: usize = 50;
const MAX_BYTES: usize = 64 * 1024;
/// How often the runner checks whether the hook has exited.
const POLL: Duration = Duration::from_millis(20);
/// How long to wait for the output readers after the hook ended, in case a surviving
/// grandchild still holds a pipe open.
const DRAIN: Duration = Duration::from_secs(2);

/// A git hook the Workbench runs itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hook {
    PreCommit,
    PrepareCommitMsg,
    CommitMsg,
    PostCommit,
    PostCheckout,
    PrePush,
}

impl Hook {
    /// The hook's file name in the hooks folder.
    pub fn name(self) -> &'static str {
        match self {
            Hook::PreCommit => "pre-commit",
            Hook::PrepareCommitMsg => "prepare-commit-msg",
            Hook::CommitMsg => "commit-msg",
            Hook::PostCommit => "post-commit",
            Hook::PostCheckout => "post-checkout",
            Hook::PrePush => "pre-push",
        }
    }

    /// Whether a failure of this hook stops the operation (git ignores a failing post hook).
    pub fn blocking(self) -> bool {
        matches!(
            self,
            Hook::PreCommit | Hook::PrepareCommitMsg | Hook::CommitMsg | Hook::PrePush
        )
    }
}

/// Why a hook stopped the operation. The message is safe to show as is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct HookFailure {
    pub message: String,
}

fn failure(message: String) -> HookFailure {
    HookFailure { message }
}

/// The folder git reads hook files from for `repo`: `core.hooksPath` when set (a relative value
/// is relative to the work tree root, as git reads it), otherwise `<common dir>/hooks`, so a
/// linked worktree uses the main repository's hooks.
pub fn hooks_dir(repo: &Repository) -> PathBuf {
    let configured = repo
        .config()
        .ok()
        .and_then(|config| config.get_path("core.hooksPath").ok())
        .filter(|path| !path.as_os_str().is_empty());
    match configured {
        Some(path) if path.is_absolute() => path,
        Some(path) => repo.workdir().unwrap_or_else(|| repo.path()).join(path),
        None => repo.commondir().join("hooks"),
    }
}

/// Runs `hook` for `repo` if the repository has it, in the work tree root and without a console
/// window. A failure of a blocking hook is an `Err` with the reason to show; a post hook never
/// fails the operation.
pub fn run_hook(
    repo: &Repository,
    hook: Hook,
    args: &[&str],
    stdin: Option<&[u8]>,
    env: &[(&str, &OsStr)],
) -> Result<(), HookFailure> {
    run_hook_with(repo, hook, args, stdin, env, &git_shell, HOOK_LIMIT)
}

/// `run_hook` with the shell locator and the limit passed in, so tests can inject both.
fn run_hook_with(
    repo: &Repository,
    hook: Hook,
    args: &[&str],
    stdin: Option<&[u8]>,
    env: &[(&str, &OsStr)],
    shell: &dyn Fn() -> Option<PathBuf>,
    limit: Duration,
) -> Result<(), HookFailure> {
    let path = hooks_dir(repo).join(hook.name());
    if !path.is_file() {
        return Ok(());
    }
    match execute(repo, hook, &path, args, stdin, env, shell, limit) {
        Err(err) if hook.blocking() => Err(err),
        _ => Ok(()),
    }
}

#[allow(clippy::too_many_arguments)]
fn execute(
    repo: &Repository,
    hook: Hook,
    path: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    env: &[(&str, &OsStr)],
    shell: &dyn Fn() -> Option<PathBuf>,
    limit: Duration,
) -> Result<(), HookFailure> {
    let name = hook.name();
    let mut command = if cfg!(windows) && starts_with_shebang(path) {
        let Some(shell) = shell() else {
            return Err(failure(format!(
                "This repository's {name} check needs Git for Windows' shell, which is not installed."
            )));
        };
        let mut command = hidden_command(shell).map_err(|e| not_started(name, &e))?;
        // The shell reads a Windows path with backslashes as escapes; forward slashes are safe.
        command.arg(path.to_string_lossy().replace('\\', "/"));
        command
    } else {
        hidden_command(path).map_err(|e| not_started(name, &e))?
    };
    let root = repo.workdir().unwrap_or_else(|| repo.path());
    command
        .args(args)
        .current_dir(root)
        .env("GIT_DIR", repo.path())
        .env("GIT_EDITOR", ":")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }

    let mut child = Running::start(command).map_err(|e| not_started(name, &e))?;

    if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin().take()) {
        let bytes = bytes.to_vec();
        // A hook may exit without reading its input; a broken pipe is not an error.
        thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }
    let tail = Arc::new(Mutex::new(Tail::default()));
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout().take() {
        readers.push(spawn_reader(stdout, Arc::clone(&tail)));
    }
    if let Some(stderr) = child.stderr().take() {
        readers.push(spawn_reader(stderr, Arc::clone(&tail)));
    }

    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => break None,
            Ok(None) => thread::sleep(POLL),
            Err(e) => {
                child.kill_tree();
                return Err(failure(format!(
                    "This repository's {name} check could not be waited on: {e}"
                )));
            }
        }
    };
    if status.is_none() {
        // Killing the job object / process group ends the whole tree and closes the pipes.
        child.kill_tree();
    }
    drain(readers);
    let tail = tail.lock().unwrap_or_else(|e| e.into_inner()).render();
    match status {
        None => Err(failure(format!(
            "This repository's {name} check did not finish in {}.",
            limit_text(limit)
        ))),
        Some(status) if status.success() => Ok(()),
        Some(_) if !tail.trim().is_empty() => Err(failure(tail)),
        Some(status) => Err(failure(match status.code() {
            Some(code) => format!("This repository's {name} check failed with exit code {code}."),
            None => format!("This repository's {name} check was ended before it finished."),
        })),
    }
}

/// A started hook and its process tree, so a timeout can end all of it.
///
/// On Windows the tree is a job object that the process is put into right after it starts. The
/// job is made here and not by `process-wrap`: its job object starts the process suspended, and
/// from a process with no console of its own (the Workbench is a GUI program) that start hangs.
#[cfg(windows)]
struct Running {
    child: std::process::Child,
    job: Option<windows_sys::Win32::Foundation::HANDLE>,
}

#[cfg(windows)]
impl Running {
    fn start(mut command: std::process::Command) -> std::io::Result<Self> {
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

    /// Ends the hook and everything it started, and reaps it.
    fn kill_tree(&mut self) {
        if let Some(job) = self.job {
            // SAFETY: `job` is the live handle created in `start`.
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 1) };
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
impl Drop for Running {
    fn drop(&mut self) {
        if let Some(job) = self.job {
            // SAFETY: `job` is the live handle created in `start`; closing it also ends any
            // process still in the job (KILL_ON_JOB_CLOSE).
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
        }
    }
}

/// A started hook and its process tree: its own process group, so a timeout can end all of it.
#[cfg(unix)]
struct Running {
    child: Box<dyn process_wrap::std::ChildWrapper>,
}

#[cfg(unix)]
impl Running {
    fn start(command: std::process::Command) -> std::io::Result<Self> {
        let mut wrapped = CommandWrap::from(command);
        wrapped.wrap(ProcessGroup::leader());
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

    /// Ends the hook and everything it started, and reaps it.
    fn kill_tree(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn not_started(name: &str, reason: &dyn std::fmt::Display) -> HookFailure {
    failure(format!(
        "This repository's {name} check could not be started: {reason}"
    ))
}

/// Whether the file starts with `#!`; a file that cannot be read does not.
fn starts_with_shebang(path: &Path) -> bool {
    let mut first = [0u8; 2];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut first))
        .is_ok()
        && first == *b"#!"
}

/// How a limit reads in a message: "5 minutes", "1 second".
fn limit_text(limit: Duration) -> String {
    let secs = limit.as_secs();
    let (count, unit) = if secs >= 60 && secs.is_multiple_of(60) {
        (secs / 60, "minute")
    } else {
        (secs, "second")
    };
    format!("{count} {unit}{}", if count == 1 { "" } else { "s" })
}

/// `<Git for Windows>\bin\sh.exe`, found once per process from the registry (machine first, then
/// user). `None` where Git for Windows is not installed, and on other platforms.
fn git_shell() -> Option<PathBuf> {
    static SHELL: OnceLock<Option<PathBuf>> = OnceLock::new();
    SHELL.get_or_init(find_git_shell).clone()
}

#[cfg(windows)]
fn find_git_shell() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER]
        .into_iter()
        .filter_map(install_path)
        .map(|install| install.join("bin").join("sh.exe"))
        .find(|shell| shell.is_file())
}

#[cfg(not(windows))]
fn find_git_shell() -> Option<PathBuf> {
    None
}

/// `HKEY\SOFTWARE\GitForWindows` value `InstallPath`.
#[cfg(windows)]
fn install_path(root: windows_sys::Win32::System::Registry::HKEY) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};
    let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let key = wide(r"SOFTWARE\GitForWindows");
    let value = wide("InstallPath");
    let mut bytes: u32 = 0;
    // SAFETY: both names are NUL-terminated and outlive the call; a null data pointer asks only
    // for the size.
    let status = unsafe {
        RegGetValueW(
            root,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut bytes,
        )
    };
    if status != 0 || bytes == 0 {
        return None;
    }
    let mut buffer = vec![0u16; bytes as usize / 2 + 1];
    let mut capacity = (buffer.len() * 2) as u32;
    // SAFETY: `buffer` holds `capacity` bytes and outlives the call.
    let status = unsafe {
        RegGetValueW(
            root,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut capacity,
        )
    };
    if status != 0 {
        return None;
    }
    let units = (capacity as usize / 2).min(buffer.len());
    let text = &buffer[..units];
    let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
    (end > 0).then(|| PathBuf::from(std::ffi::OsString::from_wide(&text[..end])))
}

/// Why the Workbench cannot commit `paths` (relative to the work tree root) itself, if it
/// cannot: the repository signs every commit, or a path goes through a filter such as Git LFS.
/// Call it before writing anything.
pub fn needs_external(repo: &Repository, paths: &[&str]) -> Option<String> {
    let signs = repo
        .config()
        .ok()
        .and_then(|config| config.get_bool("commit.gpgsign").ok())
        .unwrap_or(false);
    if signs {
        return Some(
            "This repository signs every commit (commit.gpgsign), which Kata cannot do. Commit it yourself with git."
                .into(),
        );
    }
    paths.iter().find_map(|path| {
        let value = repo
            .get_attr(Path::new(path), "filter", AttrCheckFlags::FILE_THEN_INDEX)
            .ok()?;
        let filter = match AttrValue::from_string(value) {
            AttrValue::String(name) => name.to_owned(),
            AttrValue::True => "configured".to_owned(),
            _ => return None,
        };
        Some(format!(
            "{path} uses the {filter} filter (for example Git LFS), which Kata cannot run. Commit it yourself with git."
        ))
    })
}

/// Waits for the reader threads to reach end of stream, giving up after `DRAIN` overall.
fn drain(readers: Vec<Receiver<()>>) {
    let deadline = Instant::now() + DRAIN;
    for done in readers {
        let _ = done.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    }
}

/// Reads `source` to the end on its own thread, feeding whole lines into `tail`.
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

/// The most recent whole lines of output, bounded by line count and total size. The same
/// 50 lines / 64 KiB bound as the checks runner in `kata-sdlc`, which this crate cannot depend on.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Instant;

    /// A plain git run for building fixtures (test code only; `hidden_command` refuses git).
    #[allow(clippy::disallowed_methods)]
    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    fn fresh() -> (tempfile::TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        let repo = Repository::open(dir.path()).unwrap();
        (dir, repo)
    }

    fn write_hook_in(folder: &Path, name: &str, content: &[u8]) {
        std::fs::create_dir_all(folder).unwrap();
        let path = folder.join(name);
        std::fs::write(&path, content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn write_hook(repo: &Repository, hook: Hook, content: &[u8]) {
        write_hook_in(&repo.path().join("hooks"), hook.name(), content);
    }

    fn real_shell() -> Option<PathBuf> {
        git_shell()
    }

    fn go(
        repo: &Repository,
        hook: Hook,
        shell: &dyn Fn() -> Option<PathBuf>,
        limit: Duration,
    ) -> Result<(), HookFailure> {
        run_hook_with(repo, hook, &[], None, &[], shell, limit)
    }

    fn ran(repo: &Repository) -> bool {
        repo.workdir().unwrap().join("ran").exists()
    }

    const LONG: Duration = Duration::from_secs(60);

    #[test]
    fn outcome_table() {
        // Row 1: no hook file; nothing runs, whatever else is true.
        let (_d, repo) = fresh();
        assert_eq!(go(&repo, Hook::PreCommit, &|| None, LONG), Ok(()));

        // Row 2: a script hook, no shell, blocking: refused with a plain message.
        // Row 3: the same for a hook git ignores the failure of: Ok, nothing runs.
        // (Windows only: elsewhere a script runs directly and needs no shell.)
        #[cfg(windows)]
        {
            let (_d, repo) = fresh();
            write_hook(&repo, Hook::PreCommit, b"#!/bin/sh\ntouch ran\n");
            let err = go(&repo, Hook::PreCommit, &|| None, LONG).unwrap_err();
            assert_eq!(
                err.to_string(),
                "This repository's pre-commit check needs Git for Windows' shell, which is not installed."
            );
            assert!(!ran(&repo));

            let (_d, repo) = fresh();
            write_hook(&repo, Hook::PostCommit, b"#!/bin/sh\ntouch ran\n");
            assert_eq!(go(&repo, Hook::PostCommit, &|| None, LONG), Ok(()));
            assert!(!ran(&repo));
        }

        // Row 4: exit 0 is Ok, and the hook did run.
        let (_d, repo) = fresh();
        write_hook(&repo, Hook::PreCommit, b"#!/bin/sh\ntouch ran\nexit 0\n");
        assert_eq!(go(&repo, Hook::PreCommit, &real_shell, LONG), Ok(()));
        assert!(ran(&repo));

        // Row 4, no shebang (a program run directly): only where a file can be run as is.
        #[cfg(unix)]
        {
            let (_d, repo) = fresh();
            let exe = std::env::current_exe().unwrap();
            let fake = exe.parent().unwrap().parent().unwrap().join("fake-claude");
            write_hook(&repo, Hook::PreCommit, &std::fs::read(fake).unwrap());
            assert_eq!(go(&repo, Hook::PreCommit, &|| None, LONG), Ok(()));
        }

        // Row 5: a non-zero exit, blocking: the output tail is the reason.
        let (_d, repo) = fresh();
        write_hook(
            &repo,
            Hook::PreCommit,
            b"#!/bin/sh\necho boom\necho 'bad subject' >&2\nexit 3\n",
        );
        let err = go(&repo, Hook::PreCommit, &real_shell, LONG).unwrap_err();
        assert!(err.message.contains("boom"), "{err:?}");
        assert!(err.message.contains("bad subject"), "{err:?}");

        // Row 6: past the limit, blocking: the message says so and the tree is killed.
        let (_d, repo) = fresh();
        write_hook(&repo, Hook::PreCommit, b"#!/bin/sh\nsleep 30\n");
        let started = Instant::now();
        let err = go(&repo, Hook::PreCommit, &real_shell, Duration::from_secs(1)).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(20), "not killed");
        assert_eq!(
            err.to_string(),
            "This repository's pre-commit check did not finish in 1 second."
        );
        assert_eq!(
            limit_text(HOOK_LIMIT),
            "5 minutes",
            "the real limit reads as in the spec"
        );

        // Row 7: no shebang and not startable (an empty file), blocking.
        let (_d, repo) = fresh();
        write_hook(&repo, Hook::PreCommit, b"");
        let err = go(&repo, Hook::PreCommit, &real_shell, LONG).unwrap_err();
        assert!(
            err.message
                .starts_with("This repository's pre-commit check could not be started: "),
            "{err:?}"
        );

        // Row 8: a script hook whose shell is found but cannot be started, blocking.
        let (_d, repo) = fresh();
        write_hook(&repo, Hook::PreCommit, b"#!/bin/sh\nexit 0\n");
        let missing = repo.path().join("no-such-shell");
        let err = go(&repo, Hook::PreCommit, &|| Some(missing.clone()), LONG);
        // Elsewhere the script runs directly, so this row has the shell only on Windows.
        if cfg!(windows) {
            let err = err.unwrap_err();
            assert!(
                err.message
                    .starts_with("This repository's pre-commit check could not be started: "),
                "{err:?}"
            );
        }

        // Row 9: a hook git ignores the failure of: non-zero, past the limit and not startable
        // are all Ok.
        let (_d, repo) = fresh();
        write_hook(&repo, Hook::PostCommit, b"#!/bin/sh\nexit 3\n");
        assert_eq!(go(&repo, Hook::PostCommit, &real_shell, LONG), Ok(()));
        write_hook(&repo, Hook::PostCommit, b"#!/bin/sh\nsleep 30\n");
        assert_eq!(
            go(&repo, Hook::PostCommit, &real_shell, Duration::from_secs(1)),
            Ok(())
        );
        write_hook(&repo, Hook::PostCommit, b"");
        assert_eq!(go(&repo, Hook::PostCommit, &real_shell, LONG), Ok(()));

        // Which hooks block.
        for hook in [
            Hook::PreCommit,
            Hook::PrepareCommitMsg,
            Hook::CommitMsg,
            Hook::PrePush,
        ] {
            assert!(hook.blocking(), "{hook:?}");
        }
        for hook in [Hook::PostCommit, Hook::PostCheckout] {
            assert!(!hook.blocking(), "{hook:?}");
        }
    }

    #[test]
    fn hooks_path_and_common_dir() {
        let script = b"#!/bin/sh\ntouch ran\n";

        // Default: <common dir>/hooks.
        let (_d, repo) = fresh();
        assert_eq!(hooks_dir(&repo), repo.path().join("hooks"));

        // A relative core.hooksPath is relative to the work tree root.
        repo.config()
            .unwrap()
            .set_str("core.hooksPath", ".husky")
            .unwrap();
        let root = repo.workdir().unwrap().to_path_buf();
        assert_eq!(hooks_dir(&repo), root.join(".husky"));
        write_hook_in(&root.join(".husky"), "pre-commit", script);
        assert_eq!(go(&repo, Hook::PreCommit, &real_shell, LONG), Ok(()));
        assert!(ran(&repo));

        // An absolute core.hooksPath is used as is.
        let elsewhere = tempfile::tempdir().unwrap();
        repo.config()
            .unwrap()
            .set_str("core.hooksPath", elsewhere.path().to_str().unwrap())
            .unwrap();
        assert_eq!(hooks_dir(&repo), elsewhere.path());

        // A linked worktree finds the main repository's hooks.
        let (dir, main) = fresh();
        git(
            dir.path(),
            &["commit", "-q", "--allow-empty", "-m", "first"],
        );
        let linked_parent = tempfile::tempdir().unwrap();
        let linked_root = linked_parent.path().join("wt");
        git(
            dir.path(),
            &["worktree", "add", "-q", linked_root.to_str().unwrap()],
        );
        write_hook(&main, Hook::PreCommit, script);
        let linked = Repository::open(&linked_root).unwrap();
        assert_eq!(
            hooks_dir(&linked).canonicalize().unwrap(),
            main.path().join("hooks").canonicalize().unwrap()
        );
        assert_eq!(go(&linked, Hook::PreCommit, &real_shell, LONG), Ok(()));
        assert!(
            linked_root.join("ran").exists(),
            "the hook runs in the linked work tree root"
        );
    }

    #[cfg(windows)]
    #[test]
    fn hook_runs_without_a_console_window() {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        let shell = real_shell().expect("needs Git for Windows' shell, as CI's runner has");
        let exe = std::env::current_exe().unwrap();
        let fake = exe
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("fake-claude.exe");

        // The relay has no console of its own (DETACHED_PROCESS), so a console program it starts
        // without CREATE_NO_WINDOW gets a console window, whatever console this test has.
        let probe = |hidden: bool| -> Vec<String> {
            let (_d, repo) = fresh();
            let out = repo.workdir().unwrap().join("out.txt");
            let slashed = |p: &Path| p.to_string_lossy().replace('\\', "/");
            write_hook(
                &repo,
                Hook::PreCommit,
                format!(
                    "#!/bin/sh\n\"{}\" > \"{}\"\n",
                    slashed(&fake),
                    slashed(&out)
                )
                .as_bytes(),
            );
            #[allow(clippy::disallowed_methods)]
            let mut relay = Command::new(&fake);
            relay
                .env("KATA_FAKE_MODE", "hook-relay")
                .env("KATA_RELAY_REPO", repo.workdir().unwrap())
                .env("KATA_RELAY_SHELL", &shell)
                .creation_flags(DETACHED_PROCESS)
                .stdin(std::process::Stdio::null());
            if hidden {
                relay.env("KATA_RELAY_HIDDEN", "1");
            } else {
                relay.env_remove("KATA_RELAY_HIDDEN");
            }
            let result = relay.output().unwrap();
            assert!(result.status.success(), "relay failed: {result:?}");
            std::fs::read_to_string(&out)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        };

        // Control: a plain shell started by a console-less parent shows a console window.
        let plain = probe(false);
        assert!(
            plain.iter().any(|l| l == "window=1"),
            "control: got {plain:?}"
        );
        let hidden = probe(true);
        assert!(hidden.iter().any(|l| l == "window=0"), "got {hidden:?}");
    }

    #[test]
    fn needs_external_signing_and_filters() {
        // A plain repository needs nothing.
        let (_d, repo) = fresh();
        assert_eq!(needs_external(&repo, &["a.txt", "docs/b.md"]), None);

        // A filter attribute on a path.
        let root = repo.workdir().unwrap().to_path_buf();
        std::fs::write(root.join(".gitattributes"), "*.bin filter=lfs diff=lfs\n").unwrap();
        assert_eq!(needs_external(&repo, &["a.txt"]), None);
        assert_eq!(
            needs_external(&repo, &["a.txt", "assets/big.bin"]).as_deref(),
            Some("assets/big.bin uses the lfs filter (for example Git LFS), which Kata cannot run. Commit it yourself with git.")
        );

        // Signing wins over a filter.
        repo.config()
            .unwrap()
            .set_bool("commit.gpgsign", true)
            .unwrap();
        let expected = "This repository signs every commit (commit.gpgsign), which Kata cannot do. Commit it yourself with git.";
        assert_eq!(needs_external(&repo, &["a.txt"]).as_deref(), Some(expected));
        assert_eq!(
            needs_external(&repo, &["assets/big.bin"]).as_deref(),
            Some(expected)
        );
    }
}
