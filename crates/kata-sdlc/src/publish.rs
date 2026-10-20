//! Declaring a change done: is GitHub reachable and signed in, and one pull request per touched
//! repository, the master last. Every GitHub call goes through the `Gh` trait; Kata keeps no
//! credential, `gh` owns the engineer's sign-in.
use crate::base::{base_branch, base_info_for};
use crate::branch::branch_exists;
use crate::build;
use crate::changes::{is_change_name, is_safe_system, read_doc};
use crate::frontmatter;
use crate::git;
use crate::start::BuildError;
use crate::workspace::{self, system_repos};
use serde::Serialize;
use std::io::Write;
use std::path::Path;

/// Runs the GitHub CLI. `Err` carries the text a person can read.
pub trait Gh {
    fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String>;
}

/// The real `gh`, never prompting.
pub struct GhCli;

impl Gh for GhCli {
    fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        todo!("{dir:?} {args:?}")
    }
}

/// The host of a git remote URL, lowercase and without port or user info. Local paths have none.
pub fn origin_host(url: &str) -> Option<String> {
    todo!("{url}")
}

/// A repository a change opens a pull request in.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PublishRepo {
    pub repo: String,
    pub path: String,
    pub base: String,
}

/// Why a change cannot be declared done yet.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum NotReady {
    #[error("Install the GitHub CLI (gh), run gh auth login, then declare done again.")]
    GhMissing,
    #[error("Not signed in to {0}. Run gh auth login, then declare done again.")]
    NotSignedIn(String),
    #[error("{0} has no GitHub remote")]
    NoRemote(String),
    #[error("GitHub could not be reached. Try again later.")]
    Unreachable,
}

/// The product repositories carrying commits on `change/<change>`, then the master.
pub fn touched_repos(
    folder: &Path,
    master_repo: &str,
    system: &str,
    change: &str,
) -> Result<Vec<PublishRepo>, BuildError> {
    todo!("{folder:?} {master_repo} {system} {change}")
}

/// Signed in to every distinct host the repositories' origins name; returns the account line.
pub fn signed_in(gh: &dyn Gh, repos: &[PublishRepo]) -> Result<String, NotReady> {
    todo!("{}", repos.len())
}

/// Every repository has an `origin` that `gh` can see.
pub fn origins(gh: &dyn Gh, repos: &[PublishRepo]) -> Result<(), NotReady> {
    todo!("{}", repos.len())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum PrOutcome {
    Opened { url: String },
    Reused { url: String },
    Failed { error: String },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PrResult {
    pub repo: String,
    pub outcome: PrOutcome,
}

/// Open (or reuse) one pull request per repository, in order; `master` names the one last.
pub fn publish(
    gh: &dyn Gh,
    master: &str,
    system: &str,
    change: &str,
    repos: &[PublishRepo],
) -> Vec<PrResult> {
    todo!("{master} {system} {change} {}", repos.len())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PrState {
    pub repo: String,
    pub url: Option<String>,
}

/// The open pull request of the change in each repository, if any.
pub fn open_pull_requests(
    gh: &dyn Gh,
    repos: &[PublishRepo],
    change: &str,
) -> Result<Vec<PrState>, String> {
    todo!("{} {change}", repos.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{bare_origin, checkout, commit_file, repo};
    use serial_test::serial;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Records every call and answers from a table: the first entry whose needle occurs in
    /// `"<repo dir> <args>"` wins; anything else answers an empty success.
    #[derive(Default)]
    struct FakeGh {
        table: Vec<(String, Result<String, String>)>,
        calls: Mutex<Vec<String>>,
        bodies: Mutex<Vec<(String, String)>>,
    }

    impl FakeGh {
        fn answer(mut self, needle: &str, result: Result<&str, &str>) -> Self {
            self.table.push((
                needle.to_string(),
                result.map(String::from).map_err(String::from),
            ));
            self
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        fn creates(&self) -> Vec<String> {
            self.calls()
                .into_iter()
                .filter(|c| c.contains(" pr create "))
                .map(|c| c.split(' ').next().unwrap().to_string())
                .collect()
        }
        fn body(&self, repo: &str) -> String {
            self.bodies
                .lock()
                .unwrap()
                .iter()
                .find(|(r, _)| r == repo)
                .map(|(_, b)| b.clone())
                .unwrap_or_default()
        }
    }

    impl Gh for FakeGh {
        fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
            let name = dir.file_name().unwrap().to_string_lossy().to_string();
            let line = format!("{name} {}", args.join(" "));
            if let Some(i) = args.iter().position(|a| *a == "--body-file") {
                let body = std::fs::read_to_string(args[i + 1]).unwrap();
                self.bodies.lock().unwrap().push((name, body));
            }
            self.calls.lock().unwrap().push(line.clone());
            self.table
                .iter()
                .find(|(needle, _)| line.contains(needle.as_str()))
                .map(|(_, r)| r.clone())
                .unwrap_or_else(|| Ok(String::new()))
        }
    }

    struct Fx {
        dir: tempfile::TempDir,
    }

    impl Fx {
        fn path(&self, name: &str) -> PathBuf {
            self.dir.path().join(name)
        }
        fn origin(&self, name: &str) -> PathBuf {
            self.dir.path().join(format!("{name}-origin.git"))
        }
        fn pushed(&self, name: &str) -> bool {
            git::run(
                &self.origin(name),
                &["rev-parse", "--verify", "--quiet", "refs/heads/change/c"],
            )
            .is_ok()
        }
    }

    /// Workspace `m` (master), `app`, `api`, each with a bare origin. `app` carries a commit on
    /// `change/c`; `api` has the branch but no commit when `api_ahead` is false.
    fn fixture(api_ahead: bool) -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let m = repo(dir.path(), "m");
        commit_file(
            &m,
            ".ai-sdlc.json",
            "{\"version\":1,\"systems\":{\"s\":{\"repos\":[\"app\",\"api\"]}}}\n",
            "marker",
        );
        commit_file(
            &m,
            "intent/s/c/intent.md",
            "---\ntitle: Build the thing\n---\nbody\n",
            "intent",
        );
        bare_origin(&m, None);
        checkout(&m, "change/c", true);
        commit_file(&m, "intent/s/c/plan.md", "plan\n", "plan");
        for (name, ahead) in [("app", true), ("api", api_ahead)] {
            let r = repo(dir.path(), name);
            bare_origin(&r, None);
            checkout(&r, "change/c", true);
            if ahead {
                commit_file(&r, "x.txt", "x\n", "work");
            }
        }
        Fx { dir }
    }

    fn all(fx: &Fx) -> Vec<PublishRepo> {
        touched_repos(fx.dir.path(), "m", "s", "c").unwrap()
    }

    #[test]
    fn readiness_table_r12_1() {
        let fx = fixture(true);
        let repos = all(&fx);

        let gh = FakeGh::default().answer("auth status", Err("You are not logged into any hosts"));
        let err = signed_in(&gh, &repos).unwrap_err();
        assert!(err.to_string().contains("gh auth login"), "{err}");
        assert!(matches!(err, NotReady::NotSignedIn(_)), "{err:?}");

        let gh = FakeGh::default().answer("auth status", Err("gh is not installed"));
        assert_eq!(signed_in(&gh, &repos).unwrap_err(), NotReady::GhMissing);

        let gh = FakeGh::default().answer(
            "auth status",
            Ok("github.com\n  Logged in to github.com account octo (keyring)"),
        );
        assert_eq!(
            signed_in(&gh, &repos).unwrap(),
            "Logged in to github.com account octo (keyring)"
        );

        git::run(&fx.path("app"), &["remote", "remove", "origin"]).unwrap();
        let err = origins(&FakeGh::default(), &all(&fx)).unwrap_err();
        assert_eq!(err.to_string(), "app has no GitHub remote");

        let fx = fixture(true);
        let gh = FakeGh::default().answer("repo view", Err("error connecting to api.github.com"));
        assert_eq!(origins(&gh, &all(&fx)).unwrap_err(), NotReady::Unreachable);
        let gh = FakeGh::default().answer("auth status", Err("dial tcp: no such host"));
        assert_eq!(
            signed_in(&gh, &all(&fx)).unwrap_err(),
            NotReady::Unreachable
        );
        assert!(origins(&FakeGh::default(), &all(&fx)).is_ok());
    }

    #[test]
    fn origin_host_forms() {
        let host = |u: &str| origin_host(u);
        assert_eq!(
            host("https://github.com/acme/app.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            host("https://bot:s3cret@GHE.Example.com:8443/acme/app.git").as_deref(),
            Some("ghe.example.com")
        );
        assert_eq!(
            host("git@ghe.example.com:acme/app.git").as_deref(),
            Some("ghe.example.com")
        );
        assert_eq!(
            host("ssh://git@github.com:22/acme/app.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            host("ssh://git@ssh.github.com:443/acme/app.git").as_deref(),
            Some("github.com")
        );
        for raw in [
            "/srv/git/app.git",
            "../origin.git",
            "file:///srv/git/app.git",
            "C:\\repos\\app.git",
            "C:/repos/app.git",
            r"\\?\C:\repos\app.git",
            r"\\server\share\app.git",
        ] {
            assert_eq!(host(raw), None, "{raw}");
        }
    }

    #[test]
    fn touched_repos_skips_repo_without_commits_r10_1() {
        let fx = fixture(false);
        let repos = all(&fx);
        let names: Vec<&str> = repos.iter().map(|r| r.repo.as_str()).collect();
        assert_eq!(names, ["app", "m"]);
        assert_eq!(repos[0].base, "main");
    }

    #[test]
    fn publish_opens_product_then_master_r13_1() {
        let fx = fixture(true);
        let gh = FakeGh::default()
            .answer("app pr create", Ok("https://github.com/o/app/pull/1\n"))
            .answer("api pr create", Ok("https://github.com/o/api/pull/2\n"))
            .answer("m pr create", Ok("https://github.com/o/m/pull/3\n"));
        let results = publish(&gh, "m", "s", "c", &all(&fx));
        assert_eq!(gh.creates(), ["app", "api", "m"]);
        assert!(fx.pushed("app") && fx.pushed("api") && fx.pushed("m"));
        assert_eq!(
            results[2].outcome,
            PrOutcome::Opened {
                url: "https://github.com/o/m/pull/3".into()
            }
        );
        let body = gh.body("m");
        assert!(
            body.contains("- app: https://github.com/o/app/pull/1"),
            "{body}"
        );
        assert!(
            body.contains("- api: https://github.com/o/api/pull/2"),
            "{body}"
        );
        assert!(gh.body("app").contains("intent/s/c"), "{}", gh.body("app"));
        let create = gh
            .calls()
            .into_iter()
            .find(|c| c.starts_with("app pr create"))
            .unwrap();
        assert!(create.contains("--title Build the thing"), "{create}");
        assert!(create.contains("--base main --head change/c"), "{create}");
    }

    #[test]
    fn publish_continues_after_one_failure_r13_2() {
        let fx = fixture(true);
        let gh = FakeGh::default()
            .answer("app pr create", Ok("https://github.com/o/app/pull/1"))
            .answer("api pr create", Err("GraphQL: forbidden"))
            .answer("m pr create", Ok("https://github.com/o/m/pull/3"));
        let results = publish(&gh, "m", "s", "c", &all(&fx));
        assert!(matches!(results[0].outcome, PrOutcome::Opened { .. }));
        assert_eq!(
            results[1].outcome,
            PrOutcome::Failed {
                error: "GraphQL: forbidden".into()
            }
        );
        assert!(matches!(results[2].outcome, PrOutcome::Opened { .. }));
        let body = gh.body("m");
        assert!(body.contains("- app:") && !body.contains("- api:"), "{body}");
    }

    #[test]
    fn publish_reuses_open_pull_request_r13_3() {
        let fx = fixture(true);
        let gh = FakeGh::default()
            .answer("app pr list", Ok("https://github.com/o/app/pull/1\n"))
            .answer("api pr create", Ok("https://github.com/o/api/pull/2"))
            .answer("m pr create", Ok("https://github.com/o/m/pull/3"));
        let results = publish(&gh, "m", "s", "c", &all(&fx));
        assert_eq!(
            results[0].outcome,
            PrOutcome::Reused {
                url: "https://github.com/o/app/pull/1".into()
            }
        );
        assert_eq!(gh.creates(), ["api", "m"]);
        assert!(!fx.pushed("app"));
        assert!(gh
            .body("m")
            .contains("- app: https://github.com/o/app/pull/1"));
    }

    #[test]
    #[serial]
    fn publish_stores_no_credentials_r13_4() {
        let fx = fixture(true);
        let home = tempfile::tempdir().unwrap();
        let old = std::env::var_os("KATA_HOME");
        std::env::set_var("KATA_HOME", home.path());
        let urls: Vec<String> = ["app", "api", "m"]
            .iter()
            .map(|n| git::run(&fx.path(n), &["remote", "get-url", "origin"]).unwrap())
            .collect();
        let gh = FakeGh::default().answer("pr create", Ok("https://github.com/o/x/pull/1"));
        publish(&gh, "m", "s", "c", &all(&fx));
        match old {
            Some(v) => std::env::set_var("KATA_HOME", v),
            None => std::env::remove_var("KATA_HOME"),
        }
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
        for (n, url) in ["app", "api", "m"].iter().zip(&urls) {
            let cfg = git::run(
                &fx.path(n),
                &[
                    "config",
                    "--local",
                    "--get-regexp",
                    "credential|token|password",
                ],
            );
            assert!(cfg.map(|c| c.is_empty()).unwrap_or(true), "{n}");
            assert_eq!(
                &git::run(&fx.path(n), &["remote", "get-url", "origin"]).unwrap(),
                url
            );
        }
        for call in gh.calls() {
            let l = call.to_lowercase();
            assert!(
                !l.contains("token") && !l.contains("ghp_") && !l.contains("password"),
                "{call}"
            );
        }
    }

    #[test]
    fn open_pull_requests_reports_each_repo() {
        let fx = fixture(true);
        let gh = FakeGh::default().answer("app pr list", Ok("https://github.com/o/app/pull/1\n"));
        let states = open_pull_requests(&gh, &all(&fx), "c").unwrap();
        assert_eq!(
            states,
            [
                PrState {
                    repo: "app".into(),
                    url: Some("https://github.com/o/app/pull/1".into())
                },
                PrState {
                    repo: "m".into(),
                    url: None
                },
            ]
        );
        let gh = FakeGh::default().answer("pr list", Err("boom"));
        assert_eq!(open_pull_requests(&gh, &all(&fx), "c").unwrap_err(), "boom");
    }
}
