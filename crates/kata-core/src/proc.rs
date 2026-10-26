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
pub fn hidden_command(program: impl AsRef<Path>) -> Result<Command, SpawnRefused> {
    Ok(Command::new(program.as_ref()))
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
