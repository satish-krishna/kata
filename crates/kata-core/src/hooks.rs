//! Where a repository's hooks live and how one hook is run, and whether an operation needs a
//! program the Workbench cannot start.

use crate::proc::{run_limited, Limited, Outcome};
use git2::{AttrCheckFlags, AttrValue, Repository};
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// How long one hook may run before it is killed.
pub const HOOK_LIMIT: Duration = Duration::from_secs(5 * 60);

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
    let (program, mut argv): (PathBuf, Vec<OsString>) = if cfg!(windows)
        && starts_with_shebang(path)
    {
        let Some(shell) = shell() else {
            return Err(failure(format!(
                    "This repository's {name} check needs Git for Windows' shell, which is not installed."
                )));
        };
        // The shell reads a Windows path with backslashes as escapes; forward slashes are safe.
        let script = path.to_string_lossy().replace('\\', "/");
        (shell, vec![script.into()])
    } else {
        (path.to_path_buf(), Vec::new())
    };
    argv.extend(args.iter().map(OsString::from));
    let root = repo.workdir().unwrap_or_else(|| repo.path());
    let mut vars: Vec<(&str, &OsStr)> = vec![
        ("GIT_DIR", repo.path().as_os_str()),
        ("GIT_EDITOR", OsStr::new(":")),
    ];
    vars.extend_from_slice(env);

    let outcome = run_limited(&Limited {
        program: &program,
        args: argv,
        cwd: root,
        env: &vars,
        stdin,
        limit,
        keep_stdout: false,
    });
    match outcome {
        Outcome::NotStarted(e) => Err(not_started(name, &e)),
        Outcome::WaitFailed(e) => Err(failure(format!(
            "This repository's {name} check could not be waited on: {e}"
        ))),
        Outcome::TimedOut { .. } => Err(failure(format!(
            "This repository's {name} check did not finish in {}.",
            limit_text(limit)
        ))),
        Outcome::Exited { code: Some(0), .. } => Ok(()),
        Outcome::Exited { tail, .. } if !tail.trim().is_empty() => Err(failure(tail)),
        Outcome::Exited { code, .. } => Err(failure(match code {
            Some(code) => format!("This repository's {name} check failed with exit code {code}."),
            None => format!("This repository's {name} check was ended before it finished."),
        })),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Instant;

    /// A plain git run for building fixtures (test code only; `hidden_command` refuses git).
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
