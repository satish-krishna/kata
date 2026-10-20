//! The checks file: the commands that judge a system's repositories when a change is declared
//! done. One TOML file per system under the Workbench's `checks` folder, kept outside every
//! workspace so no agent can edit the checks it is judged by.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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

/// `<workbench>/checks`.
pub fn checks_dir() -> Option<PathBuf> {
    todo!()
}

/// Reads the checks file of `system`.
pub fn load(
    system: &str,
    workspace_folder: &Path,
    allowed_repos: &[String],
) -> Result<ChecksPlan, ChecksError> {
    let _ = (system, workspace_folder, allowed_repos);
    todo!()
}

/// The checks that apply to `repo`, in file order.
pub fn for_repo(plan: &ChecksPlan, repo: &str) -> Vec<CheckSpec> {
    let _ = (plan, repo);
    todo!()
}

fn parse(label: &str, text: &str, allowed_repos: &[String]) -> Result<Vec<CheckSpec>, ChecksError> {
    let _ = (label, text, allowed_repos, MAX_TIMEOUT_SECS);
    todo!()
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
}
