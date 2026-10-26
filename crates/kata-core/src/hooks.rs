//! Where a repository's hooks live and how one hook is run, and whether an operation needs a
//! program the Workbench cannot start.

use git2::Repository;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
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
        false
    }
}

/// Why a hook stopped the operation. The message is safe to show as is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct HookFailure {
    pub message: String,
}

/// The folder git reads `hook` files from for `repo`.
pub fn hooks_dir(_repo: &Repository) -> PathBuf {
    PathBuf::new()
}

/// How a limit reads in a message: "5 minutes", "1 second".
fn limit_text(_limit: Duration) -> String {
    String::new()
}

/// Runs `hook` for `repo` if the repository has it.
pub fn run_hook(
    repo: &Repository,
    hook: Hook,
    args: &[&str],
    stdin: Option<&[u8]>,
    env: &[(&str, &OsStr)],
) -> Result<(), HookFailure> {
    run_hook_with(repo, hook, args, stdin, env, &git_shell, HOOK_LIMIT)
}

fn run_hook_with(
    _repo: &Repository,
    _hook: Hook,
    _args: &[&str],
    _stdin: Option<&[u8]>,
    _env: &[(&str, &OsStr)],
    _shell: &dyn Fn() -> Option<PathBuf>,
    _limit: Duration,
) -> Result<(), HookFailure> {
    Ok(())
}

/// `<Git for Windows>\bin\sh.exe`, found once per process.
fn git_shell() -> Option<PathBuf> {
    None
}

/// Why `paths` cannot be committed or pushed by the Workbench itself, if they cannot.
pub fn needs_external(_repo: &Repository, _paths: &[&str]) -> Option<String> {
    None
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
        let err = go(
            &repo,
            Hook::PreCommit,
            &real_shell,
            Duration::from_secs(1),
        )
        .unwrap_err();
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
        git(dir.path(), &["commit", "-q", "--allow-empty", "-m", "first"]);
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
                format!("#!/bin/sh\n\"{}\" > \"{}\"\n", slashed(&fake), slashed(&out)).as_bytes(),
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
