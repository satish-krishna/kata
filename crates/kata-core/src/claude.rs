//! The installed Claude Code: which program Kata runs and whether its version is new enough.

use std::fmt;
use std::path::Path;
use std::time::Duration;

use crate::proc::{run_limited, Limited, Outcome};

/// The oldest Claude Code Kata will run a job on (pinned from the 2026-10-27 trial).
pub const MIN_VERSION: &str = "2.1.311";

/// The program Kata starts: `KATA_CLAUDE_BIN`, or else `claude`.
pub fn program() -> String {
    std::env::var("KATA_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
}

/// A Claude Code version as `--version` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// A pre-release suffix such as `-beta.1`; it sorts below its release.
    pub pre_release: bool,
    /// The version text as read, for messages.
    pub text: String,
}

/// Why the installed Claude Code cannot run a job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionRefusal {
    TooOld { installed: String, minimum: String },
    Unreadable { detail: String },
}

impl fmt::Display for VersionRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VersionRefusal::TooOld { installed, minimum } => write!(
                f,
                "Claude Code {installed} is installed; Kata needs {minimum} or later to run a job. Update Claude Code and try again."
            ),
            VersionRefusal::Unreadable { detail } => write!(
                f,
                "Kata could not read the installed Claude Code's version ({detail}); it needs {MIN_VERSION} or later."
            ),
        }
    }
}

impl std::error::Error for VersionRefusal {}

/// Reads the leading `major.minor.patch` of the first line (`2.1.311 (Claude Code)`).
pub fn parse_version(output: &str) -> Option<ClaudeVersion> {
    let token = output.lines().next()?.split_whitespace().next()?;
    let (core, pre_release) = match token.find(['-', '+']) {
        Some(at) => (&token[..at], token[at..].starts_with('-')),
        None => (token, false),
    };
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let major = parts.next()??;
    let minor = parts.next()??;
    let patch = parts.next()??;
    if parts.next().is_some() {
        return None;
    }
    Some(ClaudeVersion {
        major,
        minor,
        patch,
        pre_release,
        text: token.to_string(),
    })
}

/// Parses `output` and compares it with [`MIN_VERSION`].
pub fn judge(output: &str) -> Result<ClaudeVersion, VersionRefusal> {
    let Some(version) = parse_version(output) else {
        let line = output.lines().next().unwrap_or("").trim();
        let detail: String = line.chars().take(80).collect();
        return Err(VersionRefusal::Unreadable {
            detail: if detail.is_empty() {
                "no output".to_string()
            } else {
                detail
            },
        });
    };
    let minimum = parse_version(MIN_VERSION).expect("MIN_VERSION is a valid version");
    // A pre-release sorts below its release, so `false` (a release) is the larger.
    let key = |v: &ClaudeVersion| (v.major, v.minor, v.patch, !v.pre_release);
    if key(&version) < key(&minimum) {
        return Err(VersionRefusal::TooOld {
            installed: version.text,
            minimum: MIN_VERSION.to_string(),
        });
    }
    Ok(version)
}

/// Runs `<program> --version` and checks the answer against [`MIN_VERSION`].
pub fn check_installed(program: &str) -> Result<ClaudeVersion, VersionRefusal> {
    check_with_limit(program, Duration::from_secs(10))
}

fn check_with_limit(program: &str, limit: Duration) -> Result<ClaudeVersion, VersionRefusal> {
    let cwd = std::env::temp_dir();
    let outcome = run_limited(&Limited {
        program: Path::new(program),
        args: vec!["--version".into()],
        cwd: &cwd,
        env: &[],
        stdin: None,
        limit,
        keep_stdout: true,
        engineers_program: false,
    });
    let unreadable = |detail: String| Err(VersionRefusal::Unreadable { detail });
    match outcome {
        Outcome::NotStarted(e) => unreadable(e.to_string()),
        Outcome::WaitFailed(e) => unreadable(e.to_string()),
        Outcome::TimedOut { .. } => unreadable("timed out".to_string()),
        Outcome::Exited { code, stdout, .. } => match code {
            Some(0) => judge(&String::from_utf8_lossy(&stdout)),
            Some(code) => unreadable(format!("exit code {code}")),
            None => unreadable("ended by a signal".to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn fake_claude() -> String {
        // The test binary lives in target/<profile>/deps; fake-claude one level up.
        let exe = std::env::current_exe().unwrap();
        exe.parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(format!("fake-claude{}", std::env::consts::EXE_SUFFIX))
            .to_string_lossy()
            .into_owned()
    }

    fn with_version(value: &str) -> Result<ClaudeVersion, VersionRefusal> {
        std::env::set_var("KATA_FAKE_CLAUDE_VERSION", value);
        let got = check_with_limit(&fake_claude(), Duration::from_secs(5));
        std::env::remove_var("KATA_FAKE_CLAUDE_VERSION");
        got
    }

    fn unreadable(got: Result<ClaudeVersion, VersionRefusal>) -> String {
        match got {
            Err(VersionRefusal::Unreadable { detail }) => detail,
            other => panic!("expected Unreadable, got {other:?}"),
        }
    }

    #[test]
    #[serial]
    fn version_check_table() {
        // Row 1: no program -> Unreadable with the spawn error.
        let detail = unreadable(check_with_limit(
            "definitely-not-a-claude-program",
            Duration::from_secs(5),
        ));
        assert!(!detail.is_empty());

        // Row 2: non-zero exit -> Unreadable with the exit code.
        let detail = unreadable(with_version("fail"));
        assert!(detail.contains('3'), "exit code missing: {detail}");

        // Row 3: timeout -> Unreadable "timed out".
        std::env::set_var("KATA_FAKE_CLAUDE_VERSION", "sleep");
        let got = check_with_limit(&fake_claude(), Duration::from_millis(500));
        std::env::remove_var("KATA_FAKE_CLAUDE_VERSION");
        assert_eq!(unreadable(got), "timed out");

        // Row 4: zero exit, unparsable first line -> Unreadable with that line, capped at 80.
        assert_eq!(unreadable(with_version("garbage")), "garbage");
        let long = "x".repeat(200);
        assert_eq!(unreadable(with_version(&long)).chars().count(), 80);

        // Row 5: below the minimum, including a pre-release of it -> TooOld.
        assert_eq!(
            judge("2.1.310 (Claude Code)"),
            Err(VersionRefusal::TooOld {
                installed: "2.1.310".into(),
                minimum: "2.1.311".into()
            })
        );
        assert_eq!(
            judge("2.1.311-beta.1"),
            Err(VersionRefusal::TooOld {
                installed: "2.1.311-beta.1".into(),
                minimum: "2.1.311".into()
            })
        );

        // Row 6: equal -> Ok.
        let v = judge("2.1.311 (Claude Code)").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (2, 1, 311));

        // Row 7: above -> Ok.
        assert!(judge("2.2.0").is_ok());
        assert!(judge("10.0.0 (Claude Code)").is_ok());

        // End to end through the fake: a version at the minimum passes.
        assert!(with_version("2.1.311 (Claude Code)").is_ok());
    }

    #[test]
    fn messages_are_plain() {
        let old = judge("2.0.1 (Claude Code)").unwrap_err().to_string();
        assert_eq!(
            old,
            "Claude Code 2.0.1 is installed; Kata needs 2.1.311 or later to run a job. Update Claude Code and try again."
        );
        let bad = judge("garbage").unwrap_err().to_string();
        assert_eq!(
            bad,
            "Kata could not read the installed Claude Code's version (garbage); it needs 2.1.311 or later."
        );
    }
}
