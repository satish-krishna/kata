//! Starting a build: one `change/<change>` branch in every repository an unfinished task names,
//! checked before anything is created or switched, and the cleanup of branches that stayed empty.
use crate::base::BaseError;
use crate::git::GitError;
use crate::workspace::ScanError;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

/// One repository of a started build and the branch it works on.
#[derive(Serialize, Clone, Debug, PartialEq)]
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

#[derive(Serialize, Clone, Debug, PartialEq)]
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
    Ready { start: BuildStart },
    NeedsConfirm { leftovers: Vec<RepoFiles> },
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

pub fn prepare(
    _folder: &Path,
    _master_repo: &str,
    _system: &str,
    _change: &str,
    _continue_with_leftovers: bool,
) -> Result<PrepareOutcome, BuildError> {
    todo!()
}

pub fn settle(_start: &BuildStart) -> Result<Vec<String>, BuildError> {
    todo!()
}

pub fn heads(
    _folder: &Path,
    _repos: &[String],
    _change: &str,
) -> Result<BTreeMap<String, String>, BuildError> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git;
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

    fn prep(fx: &Fx, go: bool) -> Result<PrepareOutcome, BuildError> {
        prepare(&fx.folder, "m", S, C, go)
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
                    repo: "m".into(),
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
    fn prepare_refuses_unsafe_repo_names() {
        let fx = fixture_with(&[("T1", "app"), ("T2", "..")], &["app", ".."], &["app"]);
        let msg = refusal(prep(&fx, false));
        assert!(msg.contains(".."), "{msg}");
        assert_eq!(branch_of(&fx.repo("app")), "main");
        assert!(matches!(
            prepare(&fx.folder, "../m", S, C, false),
            Err(BuildError::Refused(_))
        ));
        assert!(matches!(
            prepare(&fx.folder, "m", "../s", C, false),
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
    fn settle_keeps_a_dirty_empty_branch() {
        let fx = fixture();
        let start = ready(prep(&fx, false));
        testutil::write(&fx.repo("api"), "scratch.txt", "x");
        let gone = settle(&start).unwrap();
        assert_eq!(gone, ["app"]);
        assert!(has_branch(&fx.repo("api")));
    }
}
