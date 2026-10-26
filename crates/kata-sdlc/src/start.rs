//! Starting a build: one `change/<change>` branch in every repository an unfinished task names,
//! checked before anything is created or switched, and the cleanup of branches that stayed empty.
use crate::base::{base_branch, build_work_revs, commits_ahead_of_local_base, BaseError};
use crate::branch::{branch_exists, current_branch};
use crate::build::{self, BuildAction, Gate, RepoState};
use crate::changes::{is_change_name, is_safe_system};
use crate::commits::offenders_to;
use crate::decide::change_scope;
use crate::format::Problem;
use crate::git::{self, GitError};
use crate::participants;
use crate::plugin;
use crate::snapshot::dirty_files;
use crate::workspace::ScanError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// One repository of a started build and the branch it works on.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RepoStart {
    pub repo: String,
    pub path: String,
    pub base: String,
    pub branch: String,
    /// Whether this start created the branch.
    pub created: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildStart {
    pub master: RepoStart,
    pub repos: Vec<RepoStart>,
}

/// Uncommitted files a repository holds.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RepoFiles {
    pub repo: String,
    pub files: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum PrepareOutcome {
    Ready {
        start: BuildStart,
    },
    NeedsConfirm {
        leftovers: Vec<RepoFiles>,
    },
    /// The plugin, the plan or a build log stops the build (the build gate): nothing was created.
    Refused {
        message: String,
        problems: Vec<Problem>,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    /// The build does not start; the message tells the engineer why.
    #[error("{0}")]
    Refused(String),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Base(#[from] BaseError),
    #[error(transparent)]
    Scan(#[from] ScanError),
}

pub(crate) fn refuse<T>(message: impl Into<String>) -> Result<T, BuildError> {
    Err(BuildError::Refused(message.into()))
}

enum Action {
    Create,
    Checkout,
    Continue,
}

struct Classified {
    repo: String,
    path: PathBuf,
    base: String,
    action: Action,
}

/// Where one product repository stands, per the start table. Changes nothing. `dirty` is what the
/// participants model read in its working tree.
fn classify(
    path: &Path,
    repo: &str,
    branch: &str,
    scope: &str,
    dirty: &[String],
) -> Result<(Classified, Option<RepoFiles>), BuildError> {
    let Some(base) = base_branch(path) else {
        return refuse(format!(
            "{repo} has no base branch: no origin/HEAD, main or master"
        ));
    };
    let exists = branch_exists(path, branch);
    if exists {
        let tip = format!("refs/heads/{branch}");
        let revs = build_work_revs(path, &tip)?;
        if !offenders_to(path, repo, &revs, scope)?.is_empty() {
            return refuse(format!(
                "{repo} already has a branch {branch} holding work from outside this change"
            ));
        }
    }
    let current = current_branch(path);
    let done = |action, leftovers| {
        (
            Classified {
                repo: repo.to_string(),
                path: path.to_path_buf(),
                base: base.clone(),
                action,
            },
            leftovers,
        )
    };
    match current.as_deref() {
        Some(c) if c == branch => {
            let leftovers = (!dirty.is_empty()).then(|| RepoFiles {
                repo: repo.to_string(),
                files: dirty.to_vec(),
            });
            Ok(done(Action::Continue, leftovers))
        }
        Some(c) if c == base => {
            if !dirty.is_empty() {
                return refuse(format!(
                    "{repo} has uncommitted files: {}",
                    dirty.join(", ")
                ));
            }
            let action = if exists {
                Action::Checkout
            } else {
                Action::Create
            };
            Ok(done(action, None))
        }
        other => refuse(format!(
            "{repo} is on branch {}; switch it to {base} first",
            other.unwrap_or("(detached HEAD)")
        )),
    }
}

/// Check the build gate and every other precondition of a build, then create or check out `change/<change>` in the master
/// and in every product repository an unfinished task names, or that `pending` names. Nothing is
/// touched until all pass.
///
/// `pending` is the repository a run is about to start in on the engineer's ask: a round, or
/// Continue. Its uncommitted files are leftovers to confirm, whether it is a finished product
/// repository (skipped otherwise) or the master (whose uncommitted files refuse a fresh start, R3.2).
#[allow(clippy::too_many_arguments)]
pub fn prepare(
    plugin: &Path,
    folder: &Path,
    master_repo: &str,
    system: &str,
    change: &str,
    action: BuildAction,
    continue_with_leftovers: bool,
    pending: Option<&str>,
) -> Result<PrepareOutcome, BuildError> {
    if !is_safe_system(master_repo) || !is_safe_system(system) || !is_change_name(change) {
        return refuse(format!(
            "invalid master repository, system or change name: {master_repo}, {system}, {change}"
        ));
    }
    let master = folder.join(master_repo);
    let branch = format!("change/{change}");
    if !branch_exists(&master, &branch) {
        return refuse(format!("the master repo has no branch {branch}"));
    }
    if let Gate::Refuse { message, problems } = build::gate(
        &plugin::readiness(Some(plugin)),
        &master,
        system,
        change,
        action,
    )? {
        return Ok(PrepareOutcome::Refused { message, problems });
    }

    let (parts, status) =
        participants::model(plugin, folder, master_repo, system, change, pending)?;
    // A log is a leftover to save only when it is new or only gained rows; any other edit to one is
    // an uncommitted file like any other.
    let saved: Vec<String> = build::unsaved_rows(plugin, &master, system, change)
        .map(|rows| {
            rows.iter()
                .map(|u| format!("intent/{system}/{change}/build/{}.md", u.repo))
                .collect()
        })
        .unwrap_or_default();
    let (saved_rows, edited_rows): (Vec<String>, Vec<String>) = parts
        .iter()
        .flat_map(|p| p.rows.iter().cloned())
        .partition(|r| saved.contains(r));
    let mut refused = edited_rows;
    let master_part = &parts[0];
    if pending != Some(master_repo) {
        refused.splice(0..0, master_part.files.iter().cloned());
    }
    if !refused.is_empty() {
        return refuse(format!(
            "the master repo has uncommitted files: {}",
            refused.join(", ")
        ));
    }

    let mut leftovers = Vec::new();
    let mut take = |repo: &str, mut files: Vec<String>| {
        files.extend(
            parts
                .iter()
                .find(|p| p.repo == repo)
                .map(|p| {
                    p.rows
                        .iter()
                        .filter(|r| saved_rows.contains(r))
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
        );
        if !files.is_empty() {
            leftovers.push(RepoFiles {
                repo: repo.to_string(),
                files,
            });
        }
    };
    take(
        master_repo,
        if pending == Some(master_repo) {
            master_part.files.clone()
        } else {
            Vec::new()
        },
    );

    let scope = change_scope(&master, system, change);
    let mut classified = Vec::new();
    for p in &parts[1..] {
        let finished = status
            .repos
            .iter()
            .any(|r| r.repo == p.repo && r.state == RepoState::Done);
        if finished && pending != Some(p.repo.as_str()) {
            take(&p.repo, Vec::new());
            continue;
        }
        let (c, files) = classify(Path::new(&p.path), &p.repo, &branch, &scope, &p.files)?;
        take(&p.repo, files.map(|f| f.files).unwrap_or_default());
        classified.push(c);
    }
    if !leftovers.is_empty() && !continue_with_leftovers {
        return Ok(PrepareOutcome::NeedsConfirm { leftovers });
    }

    if current_branch(&master).as_deref() != Some(branch.as_str()) {
        git::legacy_cli::run(&master, &["checkout", "-q", &branch, "--"])?;
    }
    let mut repos = Vec::new();
    for c in classified {
        let created = matches!(c.action, Action::Create);
        match c.action {
            Action::Create => {
                let from = if branch_exists(&c.path, &c.base) {
                    c.base.clone()
                } else {
                    format!("origin/{}", c.base)
                };
                git::legacy_cli::run(&c.path, &["checkout", "-q", "-b", &branch, &from])?;
            }
            Action::Checkout => {
                git::legacy_cli::run(&c.path, &["checkout", "-q", &branch, "--"])?;
            }
            Action::Continue => {}
        }
        repos.push(RepoStart {
            repo: c.repo,
            path: c.path.to_string_lossy().into_owned(),
            base: c.base,
            branch: branch.clone(),
            created,
        });
    }
    Ok(PrepareOutcome::Ready {
        start: BuildStart {
            master: RepoStart {
                repo: master_repo.to_string(),
                path: master.to_string_lossy().into_owned(),
                base: base_branch(&master).unwrap_or_default(),
                branch,
                created: false,
            },
            repos,
        },
    })
}

/// Put every product repository whose change branch stayed empty (no commits past the merge
/// base, clean tree) back on its base and delete the branch. Returns those repositories. A
/// branch with commits is never deleted.
pub fn settle(start: &BuildStart) -> Result<Vec<String>, BuildError> {
    let mut gone = Vec::new();
    for r in &start.repos {
        let path = Path::new(&r.path);
        if current_branch(path).as_deref() != Some(r.branch.as_str())
            || commits_ahead_of_local_base(path, "HEAD")? != 0
            || !dirty_files(path)?.is_empty()
        {
            continue;
        }
        git::legacy_cli::run(path, &["checkout", "-q", &r.base, "--"])?;
        git::legacy_cli::run(path, &["branch", "-D", &r.branch])?;
        gone.push(r.repo.clone());
    }
    Ok(gone)
}

/// The commit each repository's `change/<change>` points at. A repository without that branch
/// is left out.
pub fn heads(
    folder: &Path,
    repos: &[String],
    change: &str,
) -> Result<BTreeMap<String, String>, BuildError> {
    if !is_change_name(change) {
        return refuse(format!("invalid change name: {change}"));
    }
    let mut out = BTreeMap::new();
    for repo in repos {
        if !is_safe_system(repo) {
            return refuse(format!("invalid repository name: {repo}"));
        }
        let path = folder.join(repo);
        // settle removed the branch of a repository the build never changed (R10.1).
        if !branch_exists(&path, &format!("change/{change}")) {
            continue;
        }
        let head = git::Repo::open(&path)?.resolve(&format!("refs/heads/change/{change}"))?;
        out.insert(repo.clone(), head);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git;
    use crate::participants::{participants, Participant};
    use crate::testutil;
    use std::path::PathBuf;

    const S: &str = "s";
    const C: &str = "2026-10-19-c";
    const OWN: &str = "feat(s): own work\n\nGenerated-By: ai-sdlc";

    struct Fx {
        _dir: tempfile::TempDir,
        folder: PathBuf,
        master: PathBuf,
    }

    impl Fx {
        fn repo(&self, name: &str) -> PathBuf {
            self.folder.join(name)
        }
    }

    fn plan(tasks: &[(&str, &str)]) -> String {
        let mut out = String::from("---\nstatus: accepted\n---\n\n# Plan: c\n\n## Tasks\n\n");
        for (id, repo) in tasks {
            out.push_str(&format!(
                "### {id}: Do {id} (`{repo}`)\n\n- **Depends on:** none\n- **Change:** x\n\n"
            ));
        }
        out
    }

    /// Master `m` on `change/<C>` holding the marker and an accepted plan; the repos in
    /// `checked_out` exist beside it.
    fn fixture_with(tasks: &[(&str, &str)], marker: &[&str], checked_out: &[&str]) -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_path_buf();
        let master = testutil::repo(&folder, "m");
        let repos = marker
            .iter()
            .map(|r| format!("\"{r}\""))
            .collect::<Vec<_>>()
            .join(",");
        testutil::commit_file(
            &master,
            ".ai-sdlc.json",
            &format!("{{\"version\":1,\"systems\":{{\"{S}\":{{\"repos\":[{repos}]}}}}}}"),
            "marker",
        );
        testutil::checkout(&master, &format!("change/{C}"), true);
        testutil::commit_file(
            &master,
            &format!("intent/{S}/{C}/plan.md"),
            &plan(tasks),
            "plan",
        );
        for r in checked_out {
            testutil::repo(&folder, r);
        }
        Fx {
            _dir: dir,
            folder,
            master,
        }
    }

    fn fixture() -> Fx {
        fixture_with(
            &[("T1", "app"), ("T2", "api"), ("T3", "m")],
            &["app", "api"],
            &["app", "api"],
        )
    }

    fn prep_pending(
        fx: &Fx,
        go: bool,
        pending: Option<&str>,
    ) -> Result<PrepareOutcome, BuildError> {
        prepare(
            testutil::plugin_dir(),
            &fx.folder,
            "m",
            S,
            C,
            BuildAction::Start,
            go,
            pending,
        )
    }

    fn prep(fx: &Fx, go: bool) -> Result<PrepareOutcome, BuildError> {
        prepare(
            testutil::plugin_dir(),
            &fx.folder,
            "m",
            S,
            C,
            BuildAction::Start,
            go,
            None,
        )
    }

    fn ready(out: Result<PrepareOutcome, BuildError>) -> BuildStart {
        match out.unwrap() {
            PrepareOutcome::Ready { start } => start,
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    fn refusal(out: Result<PrepareOutcome, BuildError>) -> String {
        match out {
            Err(BuildError::Refused(m)) => m,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    fn branch_of(repo: &Path) -> String {
        git::run(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap()
    }

    fn state(fx: &Fx) -> Vec<(String, String, String)> {
        ["m", "app", "api"]
            .iter()
            .map(|r| {
                let p = fx.repo(r);
                (
                    r.to_string(),
                    branch_of(&p),
                    git::run(&p, &["status", "--porcelain", "-uall"]).unwrap(),
                )
            })
            .collect()
    }

    fn has_branch(repo: &Path) -> bool {
        git::run(
            repo,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/change/{C}"),
            ],
        )
        .is_ok()
    }

    #[test]
    fn prepare_creates_change_branch_per_plan_repo_r2_1() {
        let fx = fixture();
        let start = ready(prep(&fx, false));
        let names: Vec<&str> = start.repos.iter().map(|r| r.repo.as_str()).collect();
        assert_eq!(names, ["app", "api"]);
        for r in &start.repos {
            assert!(r.created, "{}", r.repo);
            assert_eq!(r.base, "main");
            assert_eq!(r.branch, format!("change/{C}"));
            assert_eq!(branch_of(&fx.repo(&r.repo)), format!("change/{C}"));
        }
        assert!(!start.master.created);
        assert_eq!(start.master.repo, "m");
        assert_eq!(branch_of(&fx.master), format!("change/{C}"));
    }

    #[test]
    fn prepare_refuses_repo_outside_system_r2_4() {
        let fx = fixture_with(
            &[("T1", "app"), ("T2", "web")],
            &["app", "api"],
            &["app", "api", "web"],
        );
        let before = state(&fx);
        assert_eq!(
            refusal(prep(&fx, false)),
            "the plan names web, which is not in system s"
        );
        assert_eq!(state(&fx), before);
    }

    #[test]
    fn prepare_refuses_repo_not_checked_out_r2_4() {
        let fx = fixture_with(&[("T1", "app"), ("T2", "web")], &["app", "web"], &["app"]);
        assert_eq!(
            refusal(prep(&fx, false)),
            "the plan names web, which is not checked out in this workspace"
        );
        assert_eq!(branch_of(&fx.repo("app")), "main");
    }

    #[test]
    fn prepare_state_table_r3_1() {
        // api is the second repository; a partial start would have branched app first.
        let own = |fx: &Fx| {
            let api = fx.repo("api");
            testutil::checkout(&api, &format!("change/{C}"), true);
            testutil::commit_msg(&api, "own.txt", "x\n", OWN);
            testutil::checkout(&api, "main", false);
        };
        let someone_else = |fx: &Fx| {
            let api = fx.repo("api");
            testutil::checkout(&api, &format!("change/{C}"), true);
            testutil::commit_file(&api, "theirs.txt", "x\n", "wip: my own thing");
            testutil::checkout(&api, "main", false);
        };

        // clean on base: created
        let fx = fixture();
        assert!(ready(prep(&fx, false)).repos.iter().all(|r| r.created));

        // dirty on base
        let fx = fixture();
        testutil::write(&fx.repo("api"), "x.txt", "x");
        let before = state(&fx);
        assert_eq!(
            refusal(prep(&fx, false)),
            "api has uncommitted files: x.txt"
        );
        assert_eq!(state(&fx), before);

        // some other branch
        let fx = fixture();
        testutil::checkout(&fx.repo("api"), "other", true);
        let before = state(&fx);
        assert_eq!(
            refusal(prep(&fx, false)),
            "api is on branch other; switch it to main first"
        );
        assert_eq!(state(&fx), before);

        // this change's branch holding only this change's work: continued
        let fx = fixture();
        own(&fx);
        let start = ready(prep(&fx, false));
        let api = start.repos.iter().find(|r| r.repo == "api").unwrap();
        assert!(!api.created);
        assert_eq!(branch_of(&fx.repo("api")), format!("change/{C}"));

        // someone else's work, not checked out
        let fx = fixture();
        someone_else(&fx);
        let before = state(&fx);
        let msg = refusal(prep(&fx, false));
        assert_eq!(
            msg,
            format!("api already has a branch change/{C} holding work from outside this change")
        );
        assert_eq!(state(&fx), before);

        // someone else's work, checked out
        let fx = fixture();
        someone_else(&fx);
        testutil::checkout(&fx.repo("api"), &format!("change/{C}"), false);
        let before = state(&fx);
        assert!(refusal(prep(&fx, false)).contains("holding work from outside this change"));
        assert_eq!(state(&fx), before);
    }

    #[test]
    fn prepare_refuses_dirty_master_r3_2() {
        let fx = fixture();
        testutil::write(&fx.master, "stray.txt", "x");
        let before = state(&fx);
        let msg = refusal(prep(&fx, false));
        assert!(msg.contains("stray.txt"), "{msg}");
        assert_eq!(state(&fx), before);
    }

    #[test]
    fn prepare_asks_before_continuing_on_leftovers_r6_4() {
        let fx = fixture();
        testutil::checkout(&fx.repo("app"), &format!("change/{C}"), true);
        testutil::write(&fx.repo("app"), "src/new.rs", "fn main() {}\n");
        let before = state(&fx);
        match prep(&fx, false).unwrap() {
            PrepareOutcome::NeedsConfirm { leftovers } => assert_eq!(
                leftovers,
                [RepoFiles {
                    repo: "app".into(),
                    files: vec!["src/new.rs".into()]
                }]
            ),
            other => panic!("expected NeedsConfirm, got {other:?}"),
        }
        assert_eq!(state(&fx), before);
        let start = ready(prep(&fx, true));
        assert!(!start.repos[0].created);
        assert!(fx.repo("app").join("src/new.rs").is_file());
        assert_eq!(branch_of(&fx.repo("api")), format!("change/{C}"));
    }

    #[test]
    fn prepare_offers_to_continue_on_an_unsaved_log_row_r6_6() {
        let fx = fixture();
        let log = format!("intent/{S}/{C}/build/app.md");
        let text = "# Build log: app\n\n| Task | Commits | Departure |\n|---|---|---|\n| T1 | `abc1234` | none |\n";
        testutil::write(&fx.master, &log, text);
        match prep(&fx, false).unwrap() {
            PrepareOutcome::NeedsConfirm { leftovers } => assert_eq!(
                leftovers,
                [RepoFiles {
                    repo: "app".into(),
                    files: vec![log.clone()]
                }]
            ),
            other => panic!("expected NeedsConfirm, got {other:?}"),
        }
        assert_eq!(branch_of(&fx.repo("api")), "main");

        // An edited existing row is dirty, not a leftover.
        let fx = fixture();
        testutil::commit_file(&fx.master, &log, text, "log");
        testutil::write(&fx.master, &log, &text.replace("abc1234", "fff9999"));
        let msg = refusal(prep(&fx, true));
        assert!(msg.contains("app.md"), "{msg}");
    }

    #[test]
    fn prepare_asks_before_continuing_a_master_round_on_its_leftovers_r6_4() {
        let fx = fixture();
        testutil::write(&fx.master, "src/half.rs", "fn half() {}\n");
        let before = state(&fx);
        // A fresh start, and a run in another repository, still refuse a dirty master (R3.2).
        for pending in [None, Some("app")] {
            let msg = refusal(prep_pending(&fx, false, pending));
            assert!(msg.contains("src/half.rs"), "{msg}");
        }
        // A run in the master itself continues on top of what its previous run left, like any repository.
        match prep_pending(&fx, false, Some("m")).unwrap() {
            PrepareOutcome::NeedsConfirm { leftovers } => assert_eq!(
                leftovers,
                [RepoFiles {
                    repo: "m".into(),
                    files: vec!["src/half.rs".into()]
                }]
            ),
            other => panic!("expected NeedsConfirm, got {other:?}"),
        }
        assert_eq!(state(&fx), before);
        let start = ready(prep_pending(&fx, true, Some("m")));
        assert_eq!(start.master.repo, "m");
        assert!(fx.master.join("src/half.rs").is_file());
        assert_eq!(branch_of(&fx.repo("api")), format!("change/{C}"));
    }

    #[test]
    fn prepare_asks_about_a_finished_repos_leftovers_when_a_round_names_it_r6_4() {
        let fx = fixture();
        testutil::commit_file(
            &fx.master,
            &format!("intent/{S}/{C}/build/api.md"),
            "# Build log: api\n\n| Task | Commits | Departure |\n|---|---|---|\n| T2 | `abc1234` | none |\n",
            "log",
        );
        let api = fx.repo("api");
        testutil::checkout(&api, &format!("change/{C}"), true);
        testutil::commit_msg(&api, "own.txt", "x\n", OWN);
        testutil::write(&api, "src/half.rs", "fn half() {}\n");
        let before = state(&fx);
        match prep_pending(&fx, false, Some("api")).unwrap() {
            PrepareOutcome::NeedsConfirm { leftovers } => assert_eq!(
                leftovers,
                [RepoFiles {
                    repo: "api".into(),
                    files: vec!["src/half.rs".into()]
                }]
            ),
            other => panic!("expected NeedsConfirm, got {other:?}"),
        }
        assert_eq!(state(&fx), before);
        // Without a round on it a finished repository is left alone, edits and all.
        let names = |s: &BuildStart| s.repos.iter().map(|r| r.repo.clone()).collect::<Vec<_>>();
        assert_eq!(names(&ready(prep_pending(&fx, false, None))), ["app"]);
        let start = ready(prep_pending(&fx, true, Some("api")));
        assert_eq!(names(&start), ["app", "api"]);
        assert!(api.join("src/half.rs").is_file());
    }

    fn part(fx: &Fx, repo: &str, files: &[&str], rows: &[&str]) -> Participant {
        Participant {
            repo: repo.into(),
            path: fx.repo(repo).to_string_lossy().into_owned(),
            master: repo == "m",
            files: files.iter().map(|f| f.to_string()).collect(),
            rows: rows.iter().map(|f| f.to_string()).collect(),
        }
    }

    #[test]
    fn participants_say_where_each_repo_is_and_who_owns_which_file() {
        let fx = fixture();
        let row = |r: &str| format!("intent/{S}/{C}/build/{r}.md");
        let text = "# Build log\n\n| Task | Commits | Departure |\n|---|---|---|\n| T1 | `abc1234` | none |\n";
        testutil::write(&fx.master, "stray.txt", "x");
        testutil::write(&fx.master, &row("api"), text);
        testutil::write(&fx.master, &row("m"), text);
        testutil::write(&fx.repo("app"), "a.rs", "x");
        let got = participants(testutil::plugin_dir(), &fx.folder, "m", S, C, None).unwrap();
        // A build log row is owned by its repository, never by the master that happens to hold the file.
        assert_eq!(
            got,
            [
                part(&fx, "m", &["stray.txt"], &[&row("m")]),
                part(&fx, "app", &["a.rs"], &[]),
                part(&fx, "api", &[], &[&row("api")]),
            ]
        );
    }

    #[test]
    fn participants_list_another_change_s_build_log_row_among_the_master_s_ordinary_files() {
        let fx = fixture();
        let other = format!("intent/{S}/2026-01-01-other/build/api.md");
        let elsewhere = "intent/other-system/2026-01-01-other/build/m.md".to_string();
        let text = "# Build log
";
        testutil::write(&fx.master, "stray.txt", "x");
        testutil::write(&fx.master, &other, text);
        testutil::write(&fx.master, &elsewhere, text);
        let got = participants(testutil::plugin_dir(), &fx.folder, "m", S, C, None).unwrap();
        // Only this change's rows are build log data: another change's row is an ordinary file of
        // the master, whichever repository its name matches.
        let mut files = vec![other.as_str(), elsewhere.as_str(), "stray.txt"];
        files.sort();
        assert_eq!(
            got,
            [
                part(&fx, "m", &files, &[]),
                part(&fx, "app", &[], &[]),
                part(&fx, "api", &[], &[]),
            ]
        );
    }

    #[test]
    fn participants_include_a_round_s_repo_outside_the_plan_and_refuse_a_stranger() {
        let fx = fixture_with(&[("T1", "app")], &["app", "api"], &["app", "api"]);
        let names = |p: Vec<Participant>| p.into_iter().map(|p| p.repo).collect::<Vec<_>>();
        assert_eq!(
            names(participants(testutil::plugin_dir(), &fx.folder, "m", S, C, None).unwrap()),
            ["m", "app"]
        );
        assert_eq!(
            names(
                participants(testutil::plugin_dir(), &fx.folder, "m", S, C, Some("api")).unwrap()
            ),
            ["m", "app", "api"]
        );
        let out = participants(
            testutil::plugin_dir(),
            &fx.folder,
            "m",
            S,
            C,
            Some("nowhere"),
        );
        assert!(matches!(out, Err(BuildError::Refused(_))), "{out:?}");
    }

    #[test]
    fn missing_change_branches_names_each_product_repo_without_the_change_branch() {
        let fx = fixture();
        testutil::checkout(&fx.repo("app"), &format!("change/{C}"), true);
        // The master is never named: it holds the change's documents whatever branch it is on.
        assert_eq!(
            crate::participants::missing_change_branches(
                testutil::plugin_dir(),
                &fx.folder,
                "m",
                S,
                C
            )
            .unwrap(),
            ["api"]
        );
        testutil::checkout(&fx.repo("api"), &format!("change/{C}"), true);
        assert!(crate::participants::missing_change_branches(
            testutil::plugin_dir(),
            &fx.folder,
            "m",
            S,
            C
        )
        .unwrap()
        .is_empty());
    }

    /// A fixture whose repository "api" has all its tasks finished and is not checked out.
    fn finished_api_missing() -> Fx {
        let fx = fixture_with(&[("T1", "app"), ("T2", "api")], &["app", "api"], &["app"]);
        testutil::commit_file(
            &fx.master,
            &format!("intent/{S}/{C}/build/api.md"),
            "# Build log: api\n\n| Task | Commits | Departure |\n|---|---|---|\n| T2 | `abc1234` | none |\n",
            "log",
        );
        fx
    }

    #[test]
    fn participants_skip_a_finished_repo_that_is_not_checked_out_unless_a_round_names_it_r2_4() {
        let fx = finished_api_missing();
        let names = |p: Vec<Participant>| p.into_iter().map(|p| p.repo).collect::<Vec<_>>();
        assert_eq!(
            names(participants(testutil::plugin_dir(), &fx.folder, "m", S, C, None).unwrap()),
            ["m", "app"]
        );
        let out = participants(testutil::plugin_dir(), &fx.folder, "m", S, C, Some("api"));
        let Err(BuildError::Refused(msg)) = out else {
            panic!("a round aimed at a repository that is not checked out must be refused: {out:?}")
        };
        assert!(msg.contains("api"), "{msg}");
    }

    #[test]
    fn prepare_refuses_a_round_aimed_at_a_finished_repo_that_is_not_checked_out_r2_4() {
        let fx = finished_api_missing();
        let start = ready(prep_pending(&fx, false, None));
        let names: Vec<&str> = start.repos.iter().map(|r| r.repo.as_str()).collect();
        assert_eq!(names, ["app"]);
        let msg = refusal(prep_pending(&fx, false, Some("api")));
        assert!(msg.contains("api"), "{msg}");
    }

    #[test]
    fn prepare_skips_repos_whose_tasks_are_all_finished() {
        let fx = fixture();
        testutil::commit_file(
            &fx.master,
            &format!("intent/{S}/{C}/build/api.md"),
            "# Build log: api\n\n| Task | Commits | Departure |\n|---|---|---|\n| T2 | `abc1234` | none |\n",
            "log",
        );
        let start = ready(prep(&fx, false));
        let names: Vec<&str> = start.repos.iter().map(|r| r.repo.as_str()).collect();
        assert_eq!(names, ["app"]);
        assert_eq!(branch_of(&fx.repo("api")), "main");
        assert!(!has_branch(&fx.repo("api")));
    }

    #[test]
    fn prepare_refuses_a_failing_build_log_and_creates_nothing_r8_1() {
        let fx = fixture();
        testutil::commit_file(
            &fx.master,
            &format!("intent/{S}/{C}/build/app.md"),
            "# Build log: app

| Task | Commits | Departure |
|---|---|---|
| T1 | `abc1234` | none |
| T1 | `def5678` | none |
",
            "log",
        );
        let before = state(&fx);
        for action in [
            BuildAction::Start,
            BuildAction::Continue,
            BuildAction::Round,
        ] {
            let out = prepare(
                testutil::plugin_dir(),
                &fx.folder,
                "m",
                S,
                C,
                action,
                false,
                None,
            )
            .unwrap();
            match out {
                PrepareOutcome::Refused { message, problems } => {
                    assert_eq!(message, "A build log does not pass the check");
                    assert_eq!(problems.len(), 1, "{problems:?}");
                    assert_eq!(problems[0].file, "build/app.md");
                }
                other => panic!("expected Refused, got {other:?}"),
            }
        }
        assert_eq!(state(&fx), before);
        assert!(!has_branch(&fx.repo("app")));
    }

    #[test]
    fn prepare_refuses_unsafe_repo_names() {
        let fx = fixture_with(&[("T1", "app"), ("T2", "..")], &["app", ".."], &["app"]);
        let msg = refusal(prep(&fx, false));
        assert!(msg.contains(".."), "{msg}");
        assert_eq!(branch_of(&fx.repo("app")), "main");
        assert!(matches!(
            prepare(
                testutil::plugin_dir(),
                &fx.folder,
                "../m",
                S,
                C,
                BuildAction::Start,
                false,
                None
            ),
            Err(BuildError::Refused(_))
        ));
        assert!(matches!(
            prepare(
                testutil::plugin_dir(),
                &fx.folder,
                "m",
                "../s",
                C,
                BuildAction::Start,
                false,
                None
            ),
            Err(BuildError::Refused(_))
        ));
    }

    #[test]
    fn heads_reads_each_change_branch() {
        let fx = fixture();
        ready(prep(&fx, false));
        testutil::commit_msg(&fx.repo("app"), "a.txt", "a\n", OWN);
        let got = heads(&fx.folder, &["app".into(), "api".into()], C).unwrap();
        for r in ["app", "api"] {
            let want = git::run(&fx.repo(r), &["rev-parse", &format!("change/{C}")]).unwrap();
            assert_eq!(got[r], want);
        }
        assert_ne!(got["app"], got["api"]);
        assert!(heads(&fx.folder, &["../x".into()], C).is_err());
    }

    #[test]
    fn settle_removes_empty_branch_r10_1() {
        let fx = fixture();
        let start = ready(prep(&fx, false));
        testutil::commit_msg(&fx.repo("app"), "a.txt", "a\n", OWN);
        let gone = settle(&start).unwrap();
        assert_eq!(gone, ["api"]);
        assert_eq!(branch_of(&fx.repo("api")), "main");
        assert!(!has_branch(&fx.repo("api")));
        // A branch with commits is never deleted.
        assert!(has_branch(&fx.repo("app")));
        assert_eq!(branch_of(&fx.repo("app")), format!("change/{C}"));
    }

    #[test]
    fn settle_ignores_unpushed_base_commits_r10_1() {
        let fx = fixture();
        testutil::bare_origin(&fx.repo("api"), None);
        testutil::commit_msg(&fx.repo("api"), "mine.txt", "m\n", OWN);
        let start = ready(prep(&fx, false));
        testutil::commit_msg(&fx.repo("app"), "a.txt", "a\n", OWN);
        let gone = settle(&start).unwrap();
        assert_eq!(gone, ["api"]);
        assert!(!has_branch(&fx.repo("api")));
        assert_eq!(branch_of(&fx.repo("api")), "main");
    }

    #[test]
    fn continue_is_not_blocked_by_unpushed_base_commits_r3_1() {
        let fx = fixture();
        testutil::bare_origin(&fx.repo("api"), None);
        testutil::commit_msg(
            &fx.repo("api"),
            "mine.txt",
            "m\n",
            "fix: engineer's own work",
        );
        ready(prep(&fx, false));
        testutil::commit_msg(&fx.repo("api"), "a.txt", "a\n", OWN);
        let again = prep(&fx, false);
        assert!(
            matches!(again, Ok(PrepareOutcome::Ready { .. })),
            "got: {again:?}"
        );
    }

    #[test]
    fn continue_is_not_blocked_by_a_newer_origin_base_r3_1() {
        let fx = fixture();
        testutil::bare_origin(&fx.repo("api"), None);
        ready(prep(&fx, false));
        testutil::commit_msg(
            &fx.repo("api"),
            "a.txt",
            "a
",
            OWN,
        );
        testutil::advance_origin_only(&fx.repo("api"), "main", "others.txt", "fix: someone else");
        git::run(&fx.repo("api"), &["rebase", "-q", "origin/main"]).unwrap();
        let again = prep(&fx, false);
        assert!(
            matches!(again, Ok(PrepareOutcome::Ready { .. })),
            "got: {again:?}"
        );
    }

    #[test]
    fn settle_removes_an_empty_branch_rebased_onto_a_newer_origin_base_r10_1() {
        let fx = fixture();
        testutil::bare_origin(&fx.repo("api"), None);
        let start = ready(prep(&fx, false));
        testutil::commit_msg(
            &fx.repo("app"),
            "a.txt",
            "a
",
            OWN,
        );
        testutil::advance_origin_only(&fx.repo("api"), "main", "others.txt", "fix: someone else");
        git::run(&fx.repo("api"), &["rebase", "-q", "origin/main"]).unwrap();
        let gone = settle(&start).unwrap();
        assert_eq!(gone, ["api"]);
        assert!(!has_branch(&fx.repo("api")));
    }

    #[test]
    fn heads_after_settle_skips_repos_without_the_branch() {
        let fx = fixture();
        let start = ready(prep(&fx, false));
        testutil::commit_msg(&fx.repo("app"), "a.txt", "a\n", OWN);
        assert_eq!(settle(&start).unwrap(), ["api"]);
        let got = heads(&fx.folder, &["app".into(), "api".into()], C).unwrap();
        let want = git::run(&fx.repo("app"), &["rev-parse", &format!("change/{C}")]).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got["app"], want);
    }

    #[test]
    fn settle_keeps_a_dirty_empty_branch() {
        let fx = fixture();
        let start = ready(prep(&fx, false));
        testutil::write(&fx.repo("api"), "scratch.txt", "x");
        let gone = settle(&start).unwrap();
        assert_eq!(gone, ["app"]);
        assert!(has_branch(&fx.repo("api")));
    }
}
