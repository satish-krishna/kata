//! Declaring a change done: is GitHub reachable and signed in, and one pull request per touched
//! repository, the master last. Every GitHub call goes through the `Gh` trait; Kata keeps no
//! credential, `gh` owns the engineer's sign-in.
use crate::base::{
    base_branch, base_info, base_info_for, commits_ahead_of_local_base, local_base_ref, BaseInfo,
};
use crate::branch::branch_exists;
use crate::changes::{is_change_name, is_safe_system, read_doc};
use crate::commits::{offenders_to, Offender};
use crate::decide::change_scope;
use crate::diff::{changed_files, Part};
use crate::frontmatter;
use crate::git;
use crate::start::BuildError;
use crate::workspace::{self, system_repos};
use serde::{Deserialize, Serialize};
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
        let out = std::process::Command::new("gh")
            .args(args)
            .current_dir(dir)
            .env("GH_PROMPT_DISABLED", "1")
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    GH_MISSING.to_string()
                } else {
                    e.to_string()
                }
            })?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() {
            return Ok(stdout);
        }
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

const GH_MISSING: &str = "gh is not installed";

/// The host of a git remote URL, lowercase and without port or user info. Local paths have none.
pub fn origin_host(url: &str) -> Option<String> {
    let raw = url.trim();
    let authority = if let Some((scheme, rest)) = raw.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        rest.split('/').next().unwrap_or_default()
    } else if is_scp_like(raw) {
        raw.split(':').next().unwrap_or_default()
    } else {
        return None;
    };
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => authority.split(':').next().unwrap_or_default(),
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    match host.as_str() {
        "" => None,
        "ssh.github.com" => Some("github.com".to_string()),
        _ => Some(host),
    }
}

/// `[user@]host:path`, where the colon comes before any slash and the text is not a Windows
/// path. scp syntax never contains a backslash.
fn is_scp_like(raw: &str) -> bool {
    if raw.contains('\\') {
        return false;
    }
    let Some(colon) = raw.find(':') else {
        return false;
    };
    let before_slash = raw.find('/').is_none_or(|slash| colon < slash);
    let drive_letter = colon == 1 && raw.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    before_slash && !drive_letter && !raw.starts_with('/') && !raw.starts_with('.')
}

fn origin_url(path: &Path) -> Option<String> {
    git::run(path, &["remote", "get-url", "origin"])
        .ok()
        .filter(|u| !u.is_empty())
}

/// A repository a change opens a pull request in.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
    if !is_safe_system(master_repo) || !is_safe_system(system) || !is_change_name(change) {
        return Err(BuildError::Refused(format!(
            "invalid master repository, system or change name: {master_repo}, {system}, {change}"
        )));
    }
    let branch = format!("change/{change}");
    let tip = format!("refs/heads/{branch}");
    let scan = workspace::scan(folder)?;
    let mut out = Vec::new();
    for name in system_repos(&scan, system) {
        if name == master_repo || !is_safe_system(&name) || !scan.repos.contains(&name) {
            continue;
        }
        let path = folder.join(&name);
        if !branch_exists(&path, &branch) {
            continue;
        }
        let info = base_info_for(&path, &tip)?;
        // This departs from the literal text of R7.7: the base commits not yet on origin are not
        // build work, so they do not make a repository touched.
        if commits_ahead_of_local_base(&path, &tip)? > 0 {
            out.push(PublishRepo {
                repo: name,
                path: path.to_string_lossy().into_owned(),
                base: info.base,
            });
        }
    }
    let master = folder.join(master_repo);
    let Some(base) = base_branch(&master) else {
        return Err(BuildError::Refused(format!(
            "{master_repo} has no base branch: no origin/HEAD, main or master"
        )));
    };
    out.push(PublishRepo {
        repo: master_repo.to_string(),
        path: master.to_string_lossy().into_owned(),
        base,
    });
    Ok(out)
}

/// Commits on `change/<change>` of every touched repository that break the commit rules, judged
/// against the change's scope.
pub fn change_offenders(
    folder: &Path,
    master_repo: &str,
    system: &str,
    change: &str,
) -> Result<Vec<Offender>, BuildError> {
    let scope = change_scope(&folder.join(master_repo), system, change);
    let tip = format!("refs/heads/change/{change}");
    let mut out = Vec::new();
    for r in touched_repos(folder, master_repo, system, change)? {
        let path = Path::new(&r.path);
        let from = local_base_ref(path, &tip)?;
        out.extend(offenders_to(path, &r.repo, &from, &tip, &scope)?);
    }
    Ok(out)
}

/// A repository the Changes view lists: the master, or a product repository with a change branch
/// and something changed.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ChangeRepo {
    pub repo: String,
    pub path: String,
    pub branch: String,
    pub base: BaseInfo,
}

/// The master first, then every system repository that has `change/<change>` and any change in
/// the whole-change part of its diff.
pub fn change_repos(
    folder: &Path,
    master_repo: &str,
    system: &str,
    change: &str,
) -> Result<Vec<ChangeRepo>, String> {
    if !is_safe_system(master_repo) || !is_safe_system(system) || !is_change_name(change) {
        return Err(format!(
            "invalid master repository, system or change name: {master_repo}, {system}, {change}"
        ));
    }
    let branch = format!("change/{change}");
    let scan = workspace::scan(folder).map_err(|e| e.to_string())?;
    let entry = |name: &str, path: &Path| -> Result<ChangeRepo, String> {
        Ok(ChangeRepo {
            repo: name.to_string(),
            path: path.to_string_lossy().into_owned(),
            branch: branch.clone(),
            base: base_info(path).map_err(|e| e.to_string())?,
        })
    };
    let master = folder.join(master_repo);
    let mut out = vec![entry(master_repo, &master)?];
    for name in system_repos(&scan, system) {
        if name == master_repo || !is_safe_system(&name) || !scan.repos.contains(&name) {
            continue;
        }
        let path = folder.join(&name);
        if !branch_exists(&path, &branch) {
            continue;
        }
        let changed = changed_files(&path, Part::Whole).map_err(|e| e.to_string())?;
        if !changed.is_empty() {
            out.push(entry(&name, &path)?);
        }
    }
    Ok(out)
}

fn unreachable_text(e: &str) -> bool {
    let e = e.to_lowercase();
    [
        "could not connect",
        "error connecting",
        "timeout",
        "no such host",
    ]
    .iter()
    .any(|p| e.contains(p))
}

fn classify(e: &str, host: &str) -> NotReady {
    if e == GH_MISSING {
        NotReady::GhMissing
    } else if unreachable_text(e) {
        NotReady::Unreachable
    } else {
        NotReady::NotSignedIn(host.to_string())
    }
}

/// Signed in to every distinct host the repositories' origins name; returns the account line.
pub fn signed_in(gh: &dyn Gh, repos: &[PublishRepo]) -> Result<String, NotReady> {
    let mut seen: Vec<String> = Vec::new();
    let mut lines = Vec::new();
    for r in repos {
        let path = Path::new(&r.path);
        let Some(url) = origin_url(path) else {
            continue;
        };
        // A local path or an unparsable remote has no host; `gh` talks to github.com then.
        let host = origin_host(&url).unwrap_or_else(|| "github.com".to_string());
        if seen.contains(&host) {
            continue;
        }
        let out = gh
            .run(path, &["auth", "status", "--hostname", &host])
            .map_err(|e| classify(&e, &host))?;
        let account = out
            .lines()
            .map(str::trim)
            .find(|l| l.contains("Logged in to"))
            .or_else(|| out.lines().map(str::trim).find(|l| !l.is_empty()))
            .map(|l| {
                l.trim_start_matches(|c: char| !c.is_alphanumeric())
                    .to_string()
            })
            .unwrap_or_else(|| host.clone());
        lines.push(account);
        seen.push(host);
    }
    Ok(lines.join("; "))
}

/// Every repository has an `origin` that `gh` can see.
pub fn origins(gh: &dyn Gh, repos: &[PublishRepo]) -> Result<(), NotReady> {
    for r in repos {
        let path = Path::new(&r.path);
        let url = origin_url(path).ok_or_else(|| NotReady::NoRemote(r.repo.clone()))?;
        gh.run(path, &["repo", "view", &url, "--json", "url"])
            .map_err(|e| match classify(&e, "") {
                NotReady::NotSignedIn(_) => NotReady::NoRemote(r.repo.clone()),
                other => other,
            })?;
    }
    Ok(())
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
    let branch = format!("change/{change}");
    let title = repos
        .iter()
        .find(|r| r.repo == master)
        .and_then(|r| read_doc(Path::new(&r.path), system, change, "intent"))
        .and_then(|text| frontmatter::field(&text, "title"))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| change.to_string());
    let folder = format!("intent/{system}/{change}");
    let mut results = Vec::new();
    let mut product_urls: Vec<(String, String)> = Vec::new();
    for r in repos {
        let is_master = r.repo == master;
        let body = if is_master {
            let mut b = format!(
                "The intent, spec, plan and the record of finished tasks for this change: `{folder}`.\n\nPull requests:\n"
            );
            for (repo, url) in &product_urls {
                b.push_str(&format!("- {repo}: {url}\n"));
            }
            b
        } else {
            format!(
                "Part of the change `{change}`. Its intent, spec, plan and build record are in the master repository `{master}` under `{folder}`.\n"
            )
        };
        let outcome = if is_change_name(change) {
            open_one(gh, r, is_master, &branch, &title, &body)
        } else {
            PrOutcome::Failed {
                error: format!("invalid change name: {change}"),
            }
        };
        if !is_master {
            if let PrOutcome::Opened { url } | PrOutcome::Reused { url } = &outcome {
                product_urls.push((r.repo.clone(), url.clone()));
            }
        }
        results.push(PrResult {
            repo: r.repo.clone(),
            outcome,
        });
    }
    results
}

fn list_open(gh: &dyn Gh, r: &PublishRepo, branch: &str) -> Result<Option<String>, String> {
    let out = gh.run(
        Path::new(&r.path),
        &[
            "pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url",
        ],
    )?;
    let url = out.trim();
    Ok((!url.is_empty()).then(|| url.to_string()))
}

fn open_one(
    gh: &dyn Gh,
    r: &PublishRepo,
    is_master: bool,
    branch: &str,
    title: &str,
    body: &str,
) -> PrOutcome {
    let failed = |error: String| PrOutcome::Failed { error };
    let path = Path::new(&r.path);
    let existing = match list_open(gh, r, branch) {
        Ok(url) => url,
        Err(e) => return failed(e),
    };
    if let Err(e) = git::run(path, &["push", "-u", "origin", branch]) {
        return failed(e.to_string());
    }
    // A reused pull request keeps its title and, except the master's, its body.
    if let (Some(url), false) = (&existing, is_master) {
        return PrOutcome::Reused { url: url.clone() };
    }
    let file = match tempfile::NamedTempFile::new().and_then(|mut f| {
        f.write_all(body.as_bytes())?;
        f.flush()?;
        Ok(f.into_temp_path())
    }) {
        Ok(f) => f,
        Err(e) => return failed(e.to_string()),
    };
    let file_arg = file.to_string_lossy().into_owned();
    if let Some(url) = existing {
        let edited = gh.run(path, &["pr", "edit", &url, "--body-file", &file_arg]);
        drop(file);
        return match edited {
            Ok(_) => PrOutcome::Reused { url },
            Err(e) => failed(e),
        };
    }
    let created = gh.run(
        path,
        &[
            "pr",
            "create",
            "--base",
            &r.base,
            "--head",
            branch,
            "--title",
            title,
            "--body-file",
            &file_arg,
        ],
    );
    drop(file);
    match created {
        Ok(out) => match out.lines().map(str::trim).rfind(|l| !l.is_empty()) {
            Some(url) => PrOutcome::Opened {
                url: url.to_string(),
            },
            None => failed("gh printed no pull request address".to_string()),
        },
        Err(e) => failed(e),
    }
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
    let branch = format!("change/{change}");
    repos
        .iter()
        .map(|r| {
            Ok(PrState {
                repo: r.repo.clone(),
                url: list_open(gh, r, &branch)?,
            })
        })
        .collect()
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
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "refs/heads/change/2026-10-19-c",
                ],
            )
            .is_ok()
        }
    }

    /// Workspace `m` (master), `app`, `api`, each with a bare origin. `app` carries a commit on
    /// `change/2026-10-19-c`; `api` has the branch but no commit when `api_ahead` is false.
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
            "intent/s/2026-10-19-c/intent.md",
            "---\ntitle: Build the thing\n---\nbody\n",
            "intent",
        );
        bare_origin(&m, None);
        checkout(&m, "change/2026-10-19-c", true);
        commit_file(&m, "intent/s/2026-10-19-c/plan.md", "plan\n", "plan");
        for (name, ahead) in [("app", true), ("api", api_ahead)] {
            let r = repo(dir.path(), name);
            bare_origin(&r, None);
            checkout(&r, "change/2026-10-19-c", true);
            if ahead {
                commit_file(&r, "x.txt", "x\n", "work");
            }
        }
        Fx { dir }
    }

    fn all(fx: &Fx) -> Vec<PublishRepo> {
        touched_repos(fx.dir.path(), "m", "s", "2026-10-19-c").unwrap()
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
    fn touched_repos_ignores_unpushed_base_commits_r10_1() {
        let fx = fixture(false);
        let api = fx.path("api");
        git::run(&api, &["checkout", "-q", "main"]).unwrap();
        commit_file(&api, "mine.txt", "mine\n", "engineer's own work");
        git::run(&api, &["checkout", "-q", "change/2026-10-19-c"]).unwrap();
        git::run(&api, &["reset", "-q", "--hard", "main"]).unwrap();
        let repos = all(&fx);
        let names: Vec<&str> = repos.iter().map(|r| r.repo.as_str()).collect();
        assert_eq!(names, ["app", "m"]);
    }

    #[test]
    fn change_offenders_ignore_unpushed_base_commits_r11_5() {
        let fx = fixture(true);
        let app = fx.path("app");
        git::run(&app, &["checkout", "-q", "main"]).unwrap();
        commit_file(&app, "mine.txt", "mine\n", "engineer's own work");
        git::run(&app, &["checkout", "-q", "change/2026-10-19-c"]).unwrap();
        git::run(&app, &["rebase", "-q", "main"]).unwrap();
        let got = change_offenders(fx.dir.path(), "m", "s", "2026-10-19-c").unwrap();
        let subjects: Vec<&str> = got.iter().map(|o| o.subject.as_str()).collect();
        assert!(subjects.contains(&"work"), "{subjects:?}");
        assert!(!subjects.contains(&"engineer's own work"), "{subjects:?}");
    }

    #[test]
    fn publish_opens_product_then_master_r13_1() {
        let fx = fixture(true);
        let gh = FakeGh::default()
            .answer("app pr create", Ok("https://github.com/o/app/pull/1\n"))
            .answer("api pr create", Ok("https://github.com/o/api/pull/2\n"))
            .answer("m pr create", Ok("https://github.com/o/m/pull/3\n"));
        let results = publish(&gh, "m", "s", "2026-10-19-c", &all(&fx));
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
        assert!(
            gh.body("app").contains("intent/s/2026-10-19-c"),
            "{}",
            gh.body("app")
        );
        let create = gh
            .calls()
            .into_iter()
            .find(|c| c.starts_with("app pr create"))
            .unwrap();
        assert!(create.contains("--title Build the thing"), "{create}");
        assert!(
            create.contains("--base main --head change/2026-10-19-c"),
            "{create}"
        );
    }

    #[test]
    fn publish_continues_after_one_failure_r13_2() {
        let fx = fixture(true);
        let gh = FakeGh::default()
            .answer("app pr create", Ok("https://github.com/o/app/pull/1"))
            .answer("api pr create", Err("GraphQL: forbidden"))
            .answer("m pr create", Ok("https://github.com/o/m/pull/3"));
        let results = publish(&gh, "m", "s", "2026-10-19-c", &all(&fx));
        assert!(matches!(results[0].outcome, PrOutcome::Opened { .. }));
        assert_eq!(
            results[1].outcome,
            PrOutcome::Failed {
                error: "GraphQL: forbidden".into()
            }
        );
        assert!(matches!(results[2].outcome, PrOutcome::Opened { .. }));
        let body = gh.body("m");
        assert!(
            body.contains("- app:") && !body.contains("- api:"),
            "{body}"
        );
    }

    #[test]
    fn publish_reuses_open_pull_request_r13_3() {
        let fx = fixture(true);
        let gh = FakeGh::default()
            .answer("app pr list", Ok("https://github.com/o/app/pull/1\n"))
            .answer("api pr create", Ok("https://github.com/o/api/pull/2"))
            .answer("m pr create", Ok("https://github.com/o/m/pull/3"));
        let results = publish(&gh, "m", "s", "2026-10-19-c", &all(&fx));
        assert_eq!(
            results[0].outcome,
            PrOutcome::Reused {
                url: "https://github.com/o/app/pull/1".into()
            }
        );
        assert_eq!(gh.creates(), ["api", "m"]);
        assert!(gh
            .body("m")
            .contains("- app: https://github.com/o/app/pull/1"));
    }

    #[test]
    fn publish_pushes_new_commits_on_reused_pull_request_r13_3() {
        let fx = fixture(true);
        let gh = FakeGh::default().answer("pr create", Ok("https://github.com/o/x/pull/1"));
        publish(&gh, "m", "s", "2026-10-19-c", &all(&fx));
        commit_file(&fx.path("app"), "more.txt", "more\n", "another round");
        let head = git::run(&fx.path("app"), &["rev-parse", "HEAD"]).unwrap();
        let gh = FakeGh::default()
            .answer("app pr list", Ok("https://github.com/o/app/pull/1\n"))
            .answer("api pr list", Ok("https://github.com/o/api/pull/2\n"))
            .answer("m pr list", Ok("https://github.com/o/m/pull/3\n"));
        let results = publish(&gh, "m", "s", "2026-10-19-c", &all(&fx));
        assert!(matches!(results[0].outcome, PrOutcome::Reused { .. }));
        let pushed = git::run(
            &fx.origin("app"),
            &["rev-parse", "refs/heads/change/2026-10-19-c"],
        )
        .unwrap();
        assert_eq!(pushed, head);
        assert!(gh.creates().is_empty());
    }

    #[test]
    fn publish_updates_reused_master_body_with_full_list_r13_1() {
        let fx = fixture(true);
        let gh = FakeGh::default()
            .answer("app pr list", Ok("https://github.com/o/app/pull/1\n"))
            .answer("m pr list", Ok("https://github.com/o/m/pull/3\n"))
            .answer("api pr create", Ok("https://github.com/o/api/pull/2"));
        let results = publish(&gh, "m", "s", "2026-10-19-c", &all(&fx));
        assert_eq!(
            results[2].outcome,
            PrOutcome::Reused {
                url: "https://github.com/o/m/pull/3".into()
            }
        );
        assert!(gh.creates() == ["api"], "{:?}", gh.creates());
        assert!(
            gh.calls()
                .iter()
                .any(|c| c.starts_with("m pr edit https://github.com/o/m/pull/3 ")),
            "{:?}",
            gh.calls()
        );
        let body = gh.body("m");
        assert!(
            body.contains("- app: https://github.com/o/app/pull/1")
                && body.contains("- api: https://github.com/o/api/pull/2"),
            "{body}"
        );
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
        publish(&gh, "m", "s", "2026-10-19-c", &all(&fx));
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
        let states = open_pull_requests(&gh, &all(&fx), "2026-10-19-c").unwrap();
        assert_eq!(
            states,
            [
                PrState {
                    repo: "app".into(),
                    url: Some("https://github.com/o/app/pull/1".into())
                },
                PrState {
                    repo: "api".into(),
                    url: None
                },
                PrState {
                    repo: "m".into(),
                    url: None
                },
            ]
        );
        let gh = FakeGh::default().answer("pr list", Err("boom"));
        assert_eq!(
            open_pull_requests(&gh, &all(&fx), "2026-10-19-c").unwrap_err(),
            "boom"
        );
    }
}
