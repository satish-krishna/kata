//! Declaring a change done: is GitHub reachable and signed in, and one pull request per touched
//! repository, the master last. Every GitHub call goes through the `Gh` trait; Kata keeps no
//! credential, `gh` owns the engineer's sign-in.
use crate::base::{
    base_branch, base_info, base_info_for, build_work_revs, commits_ahead_of_local_base, BaseInfo,
};
use crate::branch::branch_exists;
use crate::changes::{is_change_name, is_safe_system, read_doc};
use crate::commits::{offenders_to, Offender};
use crate::decide::change_scope;
use crate::diff::{changed_files, Part};
use crate::frontmatter;
use crate::git;
use crate::github::{parse_repo_path, ApiError, GitHub, GitHubHosts};
use crate::start::BuildError;
use crate::workspace::{self, system_repos};
use serde::{Deserialize, Serialize};
use std::path::Path;

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
pub(crate) fn is_scp_like(raw: &str) -> bool {
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
    git::Repo::open(path)
        .ok()?
        .remote_url("origin")
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
    #[error("Not signed in to {0}. Sign in with gh auth login or Git Credential Manager, then declare done again.")]
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
        let revs = build_work_revs(path, &tip)?;
        out.extend(offenders_to(path, &r.repo, &revs, &scope)?);
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

/// A client for `host`, or the plain not-signed-in answer when no sign-in is found.
fn client(hosts: &dyn GitHubHosts, host: &str) -> Result<Box<dyn GitHub>, NotReady> {
    hosts
        .github(host)
        .ok_or_else(|| NotReady::NotSignedIn(host.to_string()))
}

/// What a failed `GET /user` means: a rejected sign-in, or GitHub out of reach.
fn classify_user(e: &ApiError, host: &str) -> NotReady {
    match e {
        ApiError::Status {
            status: 401 | 403, ..
        } => NotReady::NotSignedIn(host.to_string()),
        _ => NotReady::Unreachable,
    }
}

/// Signed in to every distinct host the repositories' origins name; returns the account line.
pub fn signed_in(hosts: &dyn GitHubHosts, repos: &[PublishRepo]) -> Result<String, NotReady> {
    let mut seen: Vec<String> = Vec::new();
    let mut lines = Vec::new();
    for r in repos {
        let Some(url) = origin_url(Path::new(&r.path)) else {
            continue;
        };
        // A local path or an unparsable remote has no host; GitHub's own host is assumed then.
        let host = origin_host(&url).unwrap_or_else(|| "github.com".to_string());
        if seen.contains(&host) {
            continue;
        }
        let login = client(hosts, &host)?
            .user()
            .map_err(|e| classify_user(&e, &host))?;
        lines.push(format!("Logged in to {host} as {login}"));
        seen.push(host);
    }
    Ok(lines.join("; "))
}

/// Every repository has an `origin` GitHub can see.
pub fn origins(hosts: &dyn GitHubHosts, repos: &[PublishRepo]) -> Result<(), NotReady> {
    for r in repos {
        let no_remote = || NotReady::NoRemote(r.repo.clone());
        let url = origin_url(Path::new(&r.path)).ok_or_else(no_remote)?;
        let (owner, name) = parse_repo_path(&url).ok_or_else(no_remote)?;
        let host = origin_host(&url).ok_or_else(no_remote)?;
        match client(hosts, &host)?.repo(&owner, &name) {
            Ok(()) => {}
            Err(ApiError::Status {
                status: 404 | 401 | 403,
                ..
            }) => return Err(no_remote()),
            Err(_) => return Err(NotReady::Unreachable),
        }
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
    hosts: &dyn GitHubHosts,
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
            open_one(hosts, r, is_master, &branch, &title, &body)
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

/// Where a repository's pull requests live: its host, owner and name, from the `origin` URL.
fn github_target(
    hosts: &dyn GitHubHosts,
    r: &PublishRepo,
) -> Result<(Box<dyn GitHub>, String, String), NotReady> {
    let no_remote = || NotReady::NoRemote(r.repo.clone());
    let url = origin_url(Path::new(&r.path)).ok_or_else(no_remote)?;
    let (owner, name) = parse_repo_path(&url).ok_or_else(no_remote)?;
    let host = origin_host(&url).ok_or_else(no_remote)?;
    Ok((client(hosts, &host)?, owner, name))
}

fn open_one(
    hosts: &dyn GitHubHosts,
    r: &PublishRepo,
    is_master: bool,
    branch: &str,
    title: &str,
    body: &str,
) -> PrOutcome {
    let failed = |error: String| PrOutcome::Failed { error };
    let (gh, owner, name) = match github_target(hosts, r) {
        Ok(t) => t,
        Err(e) => return failed(e.to_string()),
    };
    let existing = match gh.open_pull_for_branch(&owner, &name, branch) {
        Ok(pull) => pull,
        Err(e) => return failed(e.to_string()),
    };
    if let Err(e) = push_with_git_cli(Path::new(&r.path), branch) {
        return failed(e.to_string());
    }
    // A reused pull request keeps its title and, except the master's, its body.
    match (existing, is_master) {
        (Some(pull), false) => PrOutcome::Reused { url: pull.url },
        (Some(pull), true) => match gh.edit_pull_body(&owner, &name, pull.number, body) {
            Ok(()) => PrOutcome::Reused { url: pull.url },
            Err(e) => failed(e.to_string()),
        },
        (None, _) => match gh.create_pull(&owner, &name, &r.base, branch, title, body) {
            Ok(pull) => PrOutcome::Opened { url: pull.url },
            Err(e) => failed(e.to_string()),
        },
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
    hosts: &dyn GitHubHosts,
    repos: &[PublishRepo],
    change: &str,
) -> Result<Vec<PrState>, String> {
    let branch = format!("change/{change}");
    repos
        .iter()
        .map(|r| {
            let (gh, owner, name) = github_target(hosts, r).map_err(|e| e.to_string())?;
            let pull = gh
                .open_pull_for_branch(&owner, &name, &branch)
                .map_err(|e| e.to_string())?;
            Ok(PrState {
                repo: r.repo.clone(),
                url: pull.map(|p| p.url),
            })
        })
        .collect()
}

/// `git -C <path> push -u origin <branch>`, the one repository write that still runs the git
/// command line; the push without it replaces this.
fn push_with_git_cli(path: &Path, branch: &str) -> Result<(), git::GitError> {
    let args = ["push", "-u", "origin", branch];
    let fail = |stderr: String| git::GitError {
        args: args.join(" "),
        stderr,
    };
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| fail(e.to_string()))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(fail(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::{ApiError, FakeGitHub};
    use crate::testutil::{bare_origin, checkout, commit_file, repo};
    use serial_test::serial;
    use std::path::PathBuf;

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
    fn a_change_rebased_onto_a_newer_origin_base_is_judged_on_its_own_commits() {
        let fx = fixture(true);
        let app = fx.path("app");
        crate::testutil::advance_origin_only(&app, "main", "others.txt", "someone else's work");
        git::run(&app, &["rebase", "-q", "origin/main"]).unwrap();
        let api = fx.path("api");
        crate::testutil::advance_origin_only(&api, "main", "others.txt", "someone else's work");
        git::run(&api, &["rebase", "-q", "origin/main"]).unwrap();
        let names: Vec<String> = all(&fx).into_iter().map(|r| r.repo).collect();
        assert_eq!(names, ["app", "api", "m"]);
        let got = change_offenders(fx.dir.path(), "m", "s", "2026-10-19-c").unwrap();
        let subjects: Vec<&str> = got.iter().map(|o| o.subject.as_str()).collect();
        assert!(subjects.contains(&"work"), "{subjects:?}");
        assert!(!subjects.contains(&"someone else's work"), "{subjects:?}");
    }

    #[test]
    fn an_empty_branch_rebased_onto_a_newer_origin_base_is_not_touched_r10_1() {
        let fx = fixture(false);
        let api = fx.path("api");
        crate::testutil::advance_origin_only(&api, "main", "others.txt", "someone else's work");
        git::run(&api, &["rebase", "-q", "origin/main"]).unwrap();
        let names: Vec<String> = all(&fx).into_iter().map(|r| r.repo).collect();
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

    /// Points `origin` of every fixture repository at a GitHub address, and sends pushes to the
    /// local bare repository instead, so the API calls see a GitHub remote and the push needs no
    /// network.
    fn on_github(fx: &Fx) {
        for name in ["m", "app", "api"] {
            let url = format!("https://github.com/o/{name}.git");
            let bare = fx.origin(name).to_string_lossy().replace('\\', "/");
            let key = format!("url.{bare}.pushInsteadOf");
            git::run(&fx.path(name), &["config", &key, &url]).unwrap();
            git::run(&fx.path(name), &["remote", "set-url", "origin", &url]).unwrap();
        }
    }

    fn status(code: u16, message: &str) -> ApiError {
        ApiError::Status {
            status: code,
            message: message.to_string(),
        }
    }

    #[test]
    fn readiness_table_r12_1() {
        let fx = fixture(true);
        on_github(&fx);
        let repos = all(&fx);

        let gh = FakeGitHub::default().signed_out_of("github.com");
        let err = signed_in(&gh, &repos).unwrap_err();
        assert!(err.to_string().contains("gh auth login"), "{err}");
        assert_eq!(err, NotReady::NotSignedIn("github.com".into()));

        let gh = FakeGitHub::default().user_answers(Err(status(401, "Bad credentials")));
        assert_eq!(
            signed_in(&gh, &repos).unwrap_err(),
            NotReady::NotSignedIn("github.com".into())
        );
        let gh = FakeGitHub::default().user_answers(Err(status(500, "")));
        assert_eq!(signed_in(&gh, &repos).unwrap_err(), NotReady::Unreachable);
        let gh = FakeGitHub::default().user_answers(Err(ApiError::Unreachable("dns".into())));
        assert_eq!(signed_in(&gh, &repos).unwrap_err(), NotReady::Unreachable);

        let gh = FakeGitHub::default().user_answers(Ok("octo"));
        assert_eq!(
            signed_in(&gh, &repos).unwrap(),
            "Logged in to github.com as octo"
        );
        // One question per host, not per repository.
        assert_eq!(gh.calls(), ["user"]);

        git::run(&fx.path("app"), &["remote", "remove", "origin"]).unwrap();
        let err = origins(&FakeGitHub::default(), &all(&fx)).unwrap_err();
        assert_eq!(err.to_string(), "app has no GitHub remote");

        let fx = fixture(true);
        on_github(&fx);
        let gh = FakeGitHub::default().repo_answers(ApiError::Unreachable("down".into()));
        assert_eq!(origins(&gh, &all(&fx)).unwrap_err(), NotReady::Unreachable);
        let gh = FakeGitHub::default().repo_answers(status(404, "Not Found"));
        assert_eq!(
            origins(&gh, &all(&fx)).unwrap_err(),
            NotReady::NoRemote("app".into())
        );
        assert!(origins(&FakeGitHub::default(), &all(&fx)).is_ok());
    }

    #[test]
    fn publish_opens_product_then_master_r13_1() {
        let fx = fixture(true);
        on_github(&fx);
        let gh = FakeGitHub::default();
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
            .find(|c| c.starts_with("create_pull app"))
            .unwrap();
        assert!(create.contains("title=Build the thing"), "{create}");
        assert!(
            create.contains("base=main head=change/2026-10-19-c"),
            "{create}"
        );
    }

    #[test]
    fn publish_continues_after_one_failure_r13_2() {
        let fx = fixture(true);
        on_github(&fx);
        let gh = FakeGitHub::default().create_fails("api", status(403, "forbidden"));
        let results = publish(&gh, "m", "s", "2026-10-19-c", &all(&fx));
        assert!(matches!(results[0].outcome, PrOutcome::Opened { .. }));
        assert_eq!(
            results[1].outcome,
            PrOutcome::Failed {
                error: "GitHub answered 403: forbidden".into()
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
        on_github(&fx);
        let gh = FakeGitHub::default().open_pull("app", 1);
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
        on_github(&fx);
        publish(&FakeGitHub::default(), "m", "s", "2026-10-19-c", &all(&fx));
        commit_file(&fx.path("app"), "more.txt", "more\n", "another round");
        let head = git::run(&fx.path("app"), &["rev-parse", "HEAD"]).unwrap();
        let gh = FakeGitHub::default()
            .open_pull("app", 1)
            .open_pull("api", 2)
            .open_pull("m", 3);
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
        on_github(&fx);
        let gh = FakeGitHub::default().open_pull("app", 1).open_pull("m", 3);
        let results = publish(&gh, "m", "s", "2026-10-19-c", &all(&fx));
        assert_eq!(
            results[2].outcome,
            PrOutcome::Reused {
                url: "https://github.com/o/m/pull/3".into()
            }
        );
        assert!(gh.creates() == ["api"], "{:?}", gh.creates());
        assert!(
            gh.calls().iter().any(|c| c == "edit_pull_body m 3"),
            "{:?}",
            gh.calls()
        );
        let body = gh.body("m");
        assert!(
            body.contains("- app: https://github.com/o/app/pull/1")
                && body.contains("- api: https://github.com/o/api/pull/1"),
            "{body}"
        );
    }

    #[test]
    #[serial]
    fn publish_stores_no_credentials_r13_4() {
        let fx = fixture(true);
        on_github(&fx);
        let home = tempfile::tempdir().unwrap();
        let old = std::env::var_os("KATA_HOME");
        std::env::set_var("KATA_HOME", home.path());
        let urls: Vec<String> = ["app", "api", "m"]
            .iter()
            .map(|n| git::run(&fx.path(n), &["remote", "get-url", "origin"]).unwrap())
            .collect();
        let gh = FakeGitHub::default();
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
        on_github(&fx);
        let gh = FakeGitHub::default().open_pull("app", 1);
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
        let gh = FakeGitHub::default().list_fails(status(500, "boom"));
        assert_eq!(
            open_pull_requests(&gh, &all(&fx), "2026-10-19-c").unwrap_err(),
            "GitHub answered 500: boom"
        );
    }
}
