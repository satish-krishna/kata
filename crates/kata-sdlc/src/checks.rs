//! The checks file: the commands that judge a system's repositories when a change is declared
//! done. One TOML file per system under the Workbench's `checks` folder, kept outside every
//! workspace so no agent can edit the checks it is judged by.
use crate::process::{self, ProcessError};
use crate::store;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Upper bound on a check's timeout (24 hours).
const MAX_TIMEOUT_SECS: i64 = 86_400;

/// One command that must pass for a repository.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct CheckSpec {
    pub repo: String,
    pub name: String,
    pub argv: Vec<String>,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub timeout_secs: u64,
}

/// A system's checks as read from its file.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ChecksPlan {
    /// The file the checks are read from, whether or not it exists.
    pub path: String,
    pub exists: bool,
    pub checks: Vec<CheckSpec>,
}

/// Why a checks file cannot be used. Every message names the file and is safe to show as is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChecksError {
    #[error("{0}")]
    Parse(String),
    #[error("{0}")]
    Invalid(String),
    #[error("The checks folder {folder} and the workspace {workspace} contain one another. Keep the checks outside the workspace the agents work in.")]
    InsideWorkspace { folder: String, workspace: String },
    #[error("The checks file {path} cannot be read: {reason}")]
    Unreadable { path: String, reason: String },
    #[error("The checks folder cannot be located: neither KATA_HOME nor a home directory is set.")]
    NoHome,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChecksFile {
    #[serde(default)]
    checks: Vec<CheckEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckEntry {
    repo: String,
    name: Option<String>,
    argv: Vec<String>,
    timeout_secs: i64,
}

/// `<workbench>/checks`.
pub fn checks_dir() -> Option<PathBuf> {
    store::workbench_dir().map(|d| d.join("checks"))
}

/// Reads the checks file of `system`, `<checks folder>/<system>.toml`. Refuses before reading
/// when the checks folder and the workspace contain one another. A missing file is a plan with
/// no checks; `allowed_repos` are the system's repositories plus the master.
pub fn load(
    system: &str,
    workspace_folder: &Path,
    allowed_repos: &[String],
) -> Result<ChecksPlan, ChecksError> {
    let dir = checks_dir().ok_or(ChecksError::NoHome)?;
    let folder = canonical_lenient(&dir);
    let root = canonical_lenient(workspace_folder);
    if folder.starts_with(&root) || root.starts_with(&folder) {
        return Err(ChecksError::InsideWorkspace {
            folder: dir.display().to_string(),
            workspace: workspace_folder.display().to_string(),
        });
    }
    let file = dir.join(format!("{system}.toml"));
    let path = file.display().to_string();
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ChecksPlan {
                path,
                exists: false,
                checks: Vec::new(),
            })
        }
        Err(e) => {
            return Err(ChecksError::Unreadable {
                path,
                reason: e.to_string(),
            })
        }
    };
    let text = String::from_utf8(bytes).map_err(|_| ChecksError::Unreadable {
        path: path.clone(),
        reason: "the file is not valid UTF-8".into(),
    })?;
    let checks = parse(&path, &text, allowed_repos)?;
    Ok(ChecksPlan {
        path,
        exists: true,
        checks,
    })
}

/// The checks that apply to `repo`, in file order.
pub fn for_repo(plan: &ChecksPlan, repo: &str) -> Vec<CheckSpec> {
    plan.checks
        .iter()
        .filter(|c| c.repo == repo)
        .cloned()
        .collect()
}

/// How one check ended.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum CheckOutcome {
    Passed,
    /// The command ran and exited non-zero (`exit: None`: it was ended without an exit code).
    Failed {
        exit: Option<i32>,
    },
    /// The command could not be run to a verdict: a fault of the machine, not of the code.
    CouldNotRun {
        reason: String,
    },
}

/// The result of one check, with the last lines of its output.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct CheckResult {
    pub name: String,
    pub argv: Vec<String>,
    pub outcome: CheckOutcome,
    /// The last 50 lines (at most 64 KiB) of output.
    pub tail: String,
}

/// The checks of one repository, run in file order up to the first that did not pass.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RepoChecks {
    pub repo: String,
    pub results: Vec<CheckResult>,
    /// True when the repository has no checks at all.
    pub none: bool,
}

/// Runs the checks of `repo` in file order inside `repo_dir`, stopping at the first one that
/// fails or could not run.
pub fn run_repo(plan: &ChecksPlan, repo: &str, repo_dir: &Path) -> RepoChecks {
    let specs = for_repo(plan, repo);
    let mut results = Vec::with_capacity(specs.len());
    for spec in &specs {
        let (outcome, tail) =
            match process::run(&spec.argv, repo_dir, Duration::from_secs(spec.timeout_secs)) {
                Ok(exit) => {
                    let outcome = match exit.code {
                        Some(0) => CheckOutcome::Passed,
                        code => CheckOutcome::Failed { exit: code },
                    };
                    (outcome, exit.tail)
                }
                Err(ProcessError::SpawnFailed(reason)) => {
                    (CheckOutcome::CouldNotRun { reason }, String::new())
                }
                Err(ProcessError::TimedOut { secs, tail }) => (
                    CheckOutcome::CouldNotRun {
                        reason: format!("ran past its time limit of {secs}s"),
                    },
                    tail,
                ),
            };
        let stop = outcome != CheckOutcome::Passed;
        results.push(CheckResult {
            name: spec.name.clone(),
            argv: spec.argv.clone(),
            outcome,
            tail,
        });
        if stop {
            break;
        }
    }
    RepoChecks {
        repo: repo.to_string(),
        none: specs.is_empty(),
        results,
    }
}

fn parse(label: &str, text: &str, allowed_repos: &[String]) -> Result<Vec<CheckSpec>, ChecksError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let file: ChecksFile =
        toml::from_str(text).map_err(|e| ChecksError::Parse(parse_message(label, text, &e)))?;
    let mut checks = Vec::with_capacity(file.checks.len());
    for (i, entry) in file.checks.into_iter().enumerate() {
        let invalid =
            |problem: String| ChecksError::Invalid(format!("{label}: check {}: {problem}", i + 1));
        if !allowed_repos.contains(&entry.repo) {
            return Err(invalid(format!(
                "repo `{}` is not part of this system (repositories: {})",
                entry.repo,
                allowed_repos.join(", ")
            )));
        }
        if entry.argv.first().is_none_or(|p| p.trim().is_empty()) {
            return Err(invalid(
                "`argv` must have at least one element, the program to run".into(),
            ));
        }
        if entry.timeout_secs < 1 {
            return Err(invalid(format!(
                "`timeout_secs` must be at least 1, got {}",
                entry.timeout_secs
            )));
        }
        if entry.timeout_secs > MAX_TIMEOUT_SECS {
            return Err(invalid(format!(
                "`timeout_secs` must be at most {MAX_TIMEOUT_SECS} (24 hours), got {}",
                entry.timeout_secs
            )));
        }
        let name = entry.name.unwrap_or_else(|| entry.argv.join(" "));
        checks.push(CheckSpec {
            repo: entry.repo,
            name,
            argv: entry.argv,
            timeout_secs: entry.timeout_secs as u64,
        });
    }
    Ok(checks)
}

/// `file:line:col: message` from the toml error span, or `file: message` without one.
fn parse_message(label: &str, text: &str, e: &toml::de::Error) -> String {
    match e.span() {
        Some(span) => {
            let before = &text[..span.start.min(text.len())];
            let line = before.matches('\n').count() + 1;
            let column = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
            format!("{label}:{line}:{column}: {}", e.message())
        }
        None => format!("{label}: {}", e.message()),
    }
}

/// Canonicalizes the longest existing ancestor and re-appends the rest, so a folder that
/// does not exist yet is still compared by its real location.
fn canonical_lenient(path: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        if let Ok(real) = current.canonicalize() {
            return missing.iter().rev().fold(real, |acc, part| acc.join(part));
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_owned());
                current = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn repos() -> Vec<String> {
        vec!["api".into(), "master".into()]
    }

    fn one_check(body: &str) -> String {
        format!("[[checks]]\n{body}\n")
    }

    fn invalid(text: &str) -> String {
        match parse("c.toml", text, &repos()) {
            Err(ChecksError::Invalid(m)) => m,
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    fn parse_err(text: &str) -> String {
        match parse("c.toml", text, &repos()) {
            Err(ChecksError::Parse(m)) => m,
            other => panic!("expected Parse, got {other:?}"),
        }
    }

    struct HomeGuard {
        _temp: tempfile::TempDir,
        prev: Option<std::ffi::OsString>,
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var("KATA_HOME", v),
                None => std::env::remove_var("KATA_HOME"),
            }
        }
    }

    fn with_home() -> (HomeGuard, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("KATA_HOME");
        std::env::set_var("KATA_HOME", temp.path());
        let home = temp.path().to_path_buf();
        (HomeGuard { _temp: temp, prev }, home)
    }

    fn write_checks(home: &Path, system: &str, bytes: &[u8]) -> PathBuf {
        let dir = home.join("workbench").join("checks");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{system}.toml"));
        std::fs::write(&file, bytes).unwrap();
        file
    }

    #[test]
    fn a_shell_check_defaults_its_name_to_the_joined_argv() {
        let text = one_check(
            "repo = \"api\"\nargv = [\"cargo\", \"test\"]\ntimeout_secs = 600\n\n[[checks]]\nname = \"lint\"\nrepo = \"api\"\nargv = [\"x\"]\ntimeout_secs = 5",
        );
        let checks = parse("c.toml", &text, &repos()).unwrap();
        assert_eq!(checks[0].name, "cargo test");
        assert_eq!(checks[0].timeout_secs, 600);
        assert_eq!(checks[1].name, "lint");
    }

    #[test]
    fn unknown_top_level_key_is_a_parse_error_with_line_and_column() {
        let m = parse_err("chekcs = 1\n");
        assert!(m.starts_with("c.toml:1:1:"), "{m}");
        let m = parse_err("\n\nchekcs = 1\n");
        assert!(m.starts_with("c.toml:3:"), "{m}");
    }

    #[test]
    fn unknown_key_in_a_check_is_a_parse_error_with_a_line() {
        let m = parse_err(&one_check(
            "repo = \"api\"\nargv = [\"x\"]\ntimeout_secs = 5\ntimout_secs = 5",
        ));
        assert!(m.starts_with("c.toml:5:"), "{m}");
    }

    #[test]
    fn timeout_above_24_hours_is_invalid_and_24_hours_is_accepted() {
        let shell = |secs: u32| {
            one_check(&format!(
                "repo = \"api\"\nargv = [\"x\"]\ntimeout_secs = {secs}"
            ))
        };
        let m = invalid(&shell(86401));
        assert!(
            m.starts_with("c.toml: check 1: ")
                && m.contains("`timeout_secs`")
                && m.contains("86400"),
            "{m}"
        );
        assert!(parse("c.toml", &shell(86400), &repos()).is_ok());
    }

    #[test]
    fn unknown_repo_is_invalid() {
        let m = invalid(&one_check(
            "repo = \"nope\"\nargv = [\"x\"]\ntimeout_secs = 5",
        ));
        assert!(m.starts_with("c.toml: check 1: "), "{m}");
        assert!(m.contains("nope"), "{m}");
    }

    #[test]
    fn empty_argv_is_invalid() {
        let m = invalid(&one_check("repo = \"api\"\nargv = []\ntimeout_secs = 5"));
        assert!(
            m.starts_with("c.toml: check 1: ") && m.contains("`argv`"),
            "{m}"
        );
        let m = invalid(&one_check(
            "repo = \"api\"\nargv = [\"  \"]\ntimeout_secs = 5",
        ));
        assert!(m.contains("`argv`"), "{m}");
    }

    #[test]
    fn zero_timeout_is_invalid() {
        let m = invalid(&one_check(
            "repo = \"api\"\nargv = [\"x\"]\ntimeout_secs = 0",
        ));
        assert!(
            m.starts_with("c.toml: check 1: ") && m.contains("`timeout_secs`"),
            "{m}"
        );
    }

    #[test]
    fn a_bom_and_crlf_file_loads() {
        let text = format!(
            "\u{feff}{}",
            "[[checks]]\nrepo = \"api\"\nargv = [\"x\"]\ntimeout_secs = 5\n\n[[checks]]\nrepo = \"master\"\nargv = [\"y\"]\ntimeout_secs = 6\n"
                .replace('\n', "\r\n")
        );
        assert_eq!(parse("c.toml", &text, &repos()).unwrap().len(), 2);
    }

    #[test]
    #[serial]
    fn load_refuses_a_folder_inside_the_workspace() {
        let (_g, home) = with_home();
        write_checks(&home, "claims", b"");
        let ws = home.join("workbench");
        let err = load("claims", &ws, &repos()).unwrap_err();
        assert!(
            matches!(err, ChecksError::InsideWorkspace { .. }),
            "{err:?}"
        );
    }

    #[test]
    #[serial]
    fn load_refuses_a_workspace_inside_the_folder() {
        let (_g, home) = with_home();
        write_checks(&home, "claims", b"");
        let ws = home.join("workbench").join("checks").join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let err = load("claims", &ws, &repos()).unwrap_err();
        assert!(
            matches!(err, ChecksError::InsideWorkspace { .. }),
            "{err:?}"
        );
    }

    #[test]
    #[serial]
    fn checks_run_in_file_order_and_unnamed_repos_have_none_r16_1() {
        let (_g, home) = with_home();
        let file = write_checks(
            &home,
            "claims",
            b"[[checks]]\nrepo = \"master\"\nargv = [\"b\"]\ntimeout_secs = 5\n\n[[checks]]\nrepo = \"api\"\nargv = [\"a\"]\ntimeout_secs = 5\n\n[[checks]]\nrepo = \"master\"\nargv = [\"c\"]\ntimeout_secs = 5\n",
        );
        let other = tempfile::tempdir().unwrap();
        let repos = vec!["api".to_string(), "web".to_string(), "master".to_string()];
        let plan = load("claims", other.path(), &repos).unwrap();
        assert!(plan.exists);
        assert_eq!(plan.path, file.display().to_string());
        let names = |r: &str| {
            for_repo(&plan, r)
                .into_iter()
                .map(|c| c.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(names("master"), vec!["b", "c"]);
        assert_eq!(names("api"), vec!["a"]);
        assert!(names("web").is_empty());
    }

    #[test]
    #[serial]
    fn checks_file_mistakes_r16_2() {
        let (_g, home) = with_home();
        let other = tempfile::tempdir().unwrap();

        let file = write_checks(
            &home,
            "claims",
            b"[[checks]]\nrepo = \"api\"\nargv = [\"x\"]\n",
        );
        let err = load("claims", other.path(), &repos()).unwrap_err();
        let msg = err.to_string();
        assert!(matches!(err, ChecksError::Parse(_)), "{msg}");
        assert!(msg.contains(&file.display().to_string()), "{msg}");
        assert!(msg.contains("timeout_secs"), "{msg}");
        assert!(msg.contains(":1:") || msg.contains(":2:"), "{msg}");

        write_checks(
            &home,
            "claims",
            b"[[checks]]\nrepo = \"billing\"\nargv = [\"x\"]\ntimeout_secs = 5\n",
        );
        let msg = load("claims", other.path(), &repos())
            .unwrap_err()
            .to_string();
        assert!(
            msg.contains(&file.display().to_string()) && msg.contains("billing"),
            "{msg}"
        );

        let inside = home.join("workbench");
        let msg = load("claims", &inside, &repos()).unwrap_err().to_string();
        assert!(msg.contains(&inside.display().to_string()), "{msg}");
        assert!(msg.contains("checks"), "{msg}");

        write_checks(&home, "claims", &[0xff, 0xfe, 0x41]);
        let err = load("claims", other.path(), &repos()).unwrap_err();
        let msg = err.to_string();
        assert!(matches!(err, ChecksError::Unreadable { .. }), "{msg}");
        assert!(msg.contains(&file.display().to_string()), "{msg}");
    }

    #[test]
    #[serial]
    fn a_missing_file_means_no_checks_r11_3() {
        let (_g, home) = with_home();
        let other = tempfile::tempdir().unwrap();
        let plan = load("claims", other.path(), &repos()).unwrap();
        assert!(!plan.exists);
        assert!(plan.checks.is_empty());
        assert!(plan.path.ends_with("claims.toml"), "{}", plan.path);
        assert!(plan.path.starts_with(&home.display().to_string()));
        assert!(for_repo(&plan, "api").is_empty());
    }

    fn sh(windows: &str, unix: &str) -> Vec<String> {
        if cfg!(windows) {
            vec!["cmd".into(), "/C".into(), windows.into()]
        } else {
            vec!["sh".into(), "-c".into(), unix.into()]
        }
    }

    fn spec(name: &str, argv: Vec<String>, timeout_secs: u64) -> CheckSpec {
        CheckSpec {
            repo: "api".into(),
            name: name.into(),
            argv,
            timeout_secs,
        }
    }

    fn plan_of(checks: Vec<CheckSpec>) -> ChecksPlan {
        ChecksPlan {
            path: "claims.toml".into(),
            exists: true,
            checks,
        }
    }

    #[test]
    fn exit_zero_passes() {
        let dir = tempfile::tempdir().unwrap();
        let plan = plan_of(vec![spec("ok", sh("exit 0", "exit 0"), 10)]);
        let run = run_repo(&plan, "api", dir.path());
        assert!(!run.none);
        assert_eq!(run.results.len(), 1);
        assert_eq!(run.results[0].outcome, CheckOutcome::Passed);
        assert_eq!(run.results[0].name, "ok");
    }

    #[test]
    fn non_zero_fails_with_the_tail_as_detail() {
        let dir = tempfile::tempdir().unwrap();
        let plan = plan_of(vec![spec(
            "bad",
            sh("echo boom&& exit 2", "echo boom; exit 2"),
            10,
        )]);
        let run = run_repo(&plan, "api", dir.path());
        assert_eq!(
            run.results[0].outcome,
            CheckOutcome::Failed { exit: Some(2) }
        );
        assert!(run.results[0].tail.contains("boom"));
    }

    #[test]
    fn runs_in_the_repository_root() {
        let dir = tempfile::tempdir().unwrap();
        let plan = plan_of(vec![spec("where", sh("cd", "pwd"), 10)]);
        let run = run_repo(&plan, "api", dir.path());
        assert_eq!(run.results[0].outcome, CheckOutcome::Passed);
        let name = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(run.results[0].tail.contains(&name), "{:?}", run.results[0]);
    }

    #[test]
    fn no_checks_for_a_repository_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_repo(&plan_of(vec![]), "api", dir.path());
        assert!(run.none);
        assert!(run.results.is_empty());
        assert_eq!(run.repo, "api");
    }

    #[test]
    fn run_repo_stops_at_first_failure_r11_2() {
        let dir = tempfile::tempdir().unwrap();
        let plan = plan_of(vec![
            spec("bad", vec!["node".into(), "not-a-command".into()], 30),
            spec("never", vec!["node".into(), "--version".into()], 30),
        ]);
        let run = run_repo(&plan, "api", dir.path());
        assert_eq!(run.results.len(), 1, "{run:?}");
        assert!(matches!(
            run.results[0].outcome,
            CheckOutcome::Failed { exit: Some(_) }
        ));
        assert!(
            run.results[0].tail.contains("not-a-command"),
            "{:?}",
            run.results[0].tail
        );
    }

    #[test]
    fn a_git_or_gh_check_runs_and_passes_r1_1() {
        let dir = tempfile::tempdir().unwrap();
        let (name, body) = if cfg!(windows) {
            ("gh.cmd", "@echo gh stand-in ran\r\n@exit /b 0\r\n")
        } else {
            ("gh", "#!/bin/sh\necho gh stand-in ran\nexit 0\n")
        };
        let stand_in = dir.path().join(name);
        std::fs::write(&stand_in, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stand_in, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let rows = [
            (
                "git",
                vec!["git".to_string(), "--version".to_string()],
                "git version",
            ),
            ("gh", vec![format!("./{name}")], "gh stand-in ran"),
        ];
        // Run both rows before asserting so a failing row cannot hide the other one.
        let runs: Vec<_> = rows
            .iter()
            .map(|(row, argv, _)| {
                let plan = plan_of(vec![spec(row, argv.clone(), 30)]);
                run_repo(&plan, "api", dir.path())
            })
            .collect();
        let mut failures = Vec::new();
        for ((row, _, expected), run) in rows.iter().zip(&runs) {
            let result = &run.results[0];
            if result.outcome != CheckOutcome::Passed || !result.tail.contains(expected) {
                failures.push(format!("row {row}: {result:?}"));
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn could_not_run_is_not_failed_r11_6() {
        let dir = tempfile::tempdir().unwrap();
        let slow = sh("ping -n 30 127.0.0.1 >NUL", "echo waiting; sleep 30");
        let run = run_repo(&plan_of(vec![spec("slow", slow, 1)]), "api", dir.path());
        match &run.results[0].outcome {
            CheckOutcome::CouldNotRun { reason } => {
                assert_eq!(reason, "ran past its time limit of 1s")
            }
            other => panic!("expected CouldNotRun, got {other:?}"),
        }
        if !cfg!(windows) {
            assert!(run.results[0].tail.contains("waiting"));
        }

        let missing = vec!["kata-no-such-binary".to_string()];
        let run = run_repo(&plan_of(vec![spec("gone", missing, 5)]), "api", dir.path());
        assert_eq!(
            run.results[0].outcome,
            CheckOutcome::CouldNotRun {
                reason: "kata-no-such-binary was not found on this machine".into()
            }
        );
        assert_eq!(run.results[0].tail, "");
    }
}
