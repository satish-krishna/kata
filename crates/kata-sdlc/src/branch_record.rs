//! The change's branch record: the one branch name a change uses in every repository it touches.
//!
//! The record lives in `intent/<system>/<change>/branch.md` of the master repository. A change that
//! has none uses `change/<change>`. This module reads and writes the record and checks a proposed
//! name against the branches already on the machine; it never fetches.
use crate::workspace::ScanError;
use std::path::Path;

/// What `branch.md` holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchRecord {
    pub branch: String,
    pub work_type: Option<String>,
}

/// Whether a record is made for the first time or replaces an earlier one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordVerb {
    Name,
    Rename,
}

#[derive(Debug, thiserror::Error)]
pub enum RecordError {
    #[error("{0}")]
    Invalid(String),
    #[error("cannot read or write the branch record: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Git(String),
}

/// A branch already on the machine that a proposed name clashes with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clash {
    pub repo: String,
    pub existing: String,
}

pub fn change_branch(master: &Path, system: &str, change: &str) -> Result<String, RecordError> {
    let _ = (master, system, change);
    todo!()
}

pub fn write(
    master: &Path,
    system: &str,
    change: &str,
    record: &BranchRecord,
    verb: RecordVerb,
) -> Result<(), RecordError> {
    let _ = (master, system, change, record, verb);
    todo!()
}

pub fn clashes(
    folder: &Path,
    master_repo: &str,
    system: &str,
    name: &str,
    own: Option<&str>,
) -> Result<Vec<Clash>, ScanError> {
    let _ = (folder, master_repo, system, name, own);
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{git, testutil};
    use std::path::PathBuf;

    const SYSTEM: &str = "kata";
    const CHANGE: &str = "2026-11-02-password-reset";

    /// A workspace folder with the master `ai-sdlc` and the product repository `kata`.
    fn workspace(tmp: &Path) -> (PathBuf, PathBuf) {
        let master = testutil::repo(tmp, "ai-sdlc");
        testutil::commit_file(
            &master,
            ".ai-sdlc.json",
            r#"{"version":1,"systems":{"kata":{"repos":["kata"]}}}"#,
            "marker",
        );
        let kata = testutil::repo(tmp, "kata");
        (master, kata)
    }

    fn local(repo: &Path, name: &str) {
        git::run(repo, &["branch", name]).unwrap();
    }

    fn remote(repo: &Path, name: &str) {
        let has_origin = git::run(repo, &["remote"]).unwrap().contains("origin");
        if !has_origin {
            git::run(repo, &["remote", "add", "origin", "/nowhere/origin.git"]).unwrap();
        }
        git::run(
            repo,
            &["update-ref", &format!("refs/remotes/origin/{name}"), "HEAD"],
        )
        .unwrap();
    }

    fn clash(repo: &str, existing: &str) -> Clash {
        Clash {
            repo: repo.to_string(),
            existing: existing.to_string(),
        }
    }

    /// One row of the table: the repository, whether the ref is remote-tracking, the existing name,
    /// the proposed name, the change's own branch, and the clash expected.
    type Case = (
        &'static str,
        &'static str,
        bool,
        &'static str,
        &'static str,
        Option<&'static str>,
        Option<(&'static str, &'static str)>,
    );

    #[test]
    fn clashes_follow_the_table_r6_3() {
        let cases: [Case; 17] = [
            // Row 1: the change's own branch, local or pushed, never a clash.
            (
                "1 local",
                "kata",
                false,
                "feat/a",
                "feat/a",
                Some("feat/a"),
                None,
            ),
            (
                "1 remote",
                "kata",
                true,
                "feat/a",
                "feat/a",
                Some("feat/a"),
                None,
            ),
            (
                "1 beats 3",
                "kata",
                false,
                "feat/a",
                "feat/A",
                Some("feat/a"),
                None,
            ),
            (
                "1 beats 7",
                "kata",
                true,
                "feat/a",
                "feat/a/b",
                Some("feat/a"),
                None,
            ),
            // Rows 2 to 4: local branches.
            (
                "2",
                "kata",
                false,
                "feat/a",
                "feat/a",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "3",
                "kata",
                false,
                "feat/a",
                "feat/A",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "4 existing is folder",
                "kata",
                false,
                "feat/a",
                "feat/a/b",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "4 name is folder",
                "kata",
                false,
                "feat/a/b",
                "feat/a",
                None,
                Some(("kata", "feat/a/b")),
            ),
            (
                "4 ignoring case",
                "kata",
                false,
                "feat/A",
                "feat/a/b",
                None,
                Some(("kata", "feat/A")),
            ),
            // Rows 5 to 7: remote-tracking branches, reported with the remote name stripped.
            (
                "5",
                "kata",
                true,
                "feat/a",
                "feat/a",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "6",
                "kata",
                true,
                "feat/a",
                "feat/A",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "7 existing is folder",
                "kata",
                true,
                "feat/a",
                "feat/a/b",
                None,
                Some(("kata", "feat/a")),
            ),
            (
                "7 name is folder",
                "kata",
                true,
                "feat/a/b",
                "feat/a",
                None,
                Some(("kata", "feat/a/b")),
            ),
            // Row 8: unrelated, including a shared prefix that is not a folder.
            ("8 unrelated", "kata", false, "feat/b", "feat/a", None, None),
            (
                "8 prefix only",
                "kata",
                true,
                "feat/a",
                "feat/ab",
                None,
                None,
            ),
            // The master is looked at too.
            (
                "master",
                "ai-sdlc",
                false,
                "feat/a",
                "feat/a",
                None,
                Some(("ai-sdlc", "feat/a")),
            ),
            // Row 1 compares exactly: a different case is not the change's own branch.
            (
                "own differs by case",
                "kata",
                false,
                "feat/A",
                "feat/a",
                Some("feat/a"),
                Some(("kata", "feat/A")),
            ),
        ];
        for (row, repo, is_remote, existing, name, own, expected) in cases {
            let tmp = tempfile::tempdir().unwrap();
            workspace(tmp.path());
            let path = tmp.path().join(repo);
            if is_remote {
                remote(&path, existing);
            } else {
                local(&path, existing);
            }
            let got = clashes(tmp.path(), "ai-sdlc", SYSTEM, name, own).unwrap();
            let want: Vec<Clash> = expected.map(|(r, e)| clash(r, e)).into_iter().collect();
            assert_eq!(got, want, "row {row}");
        }
    }

    #[test]
    fn clashes_cover_the_six_examples_of_r6_3() {
        // (repo, existing as created, remote-tracking, name, existing as reported)
        let examples = [
            (
                "ai-sdlc",
                "feat/PROJ-123-reset",
                false,
                "feat/PROJ-123-reset",
                "feat/PROJ-123-reset",
            ),
            (
                "kata",
                "feat/PROJ-123-reset",
                false,
                "feat/PROJ-123-reset",
                "feat/PROJ-123-reset",
            ),
            (
                "kata",
                "feat/proj-123-reset",
                false,
                "feat/PROJ-123-reset",
                "feat/proj-123-reset",
            ),
            (
                "kata",
                "feat/PROJ-123",
                false,
                "feat/PROJ-123/reset",
                "feat/PROJ-123",
            ),
            (
                "kata",
                "feat/PROJ-123/reset",
                false,
                "feat/PROJ-123",
                "feat/PROJ-123/reset",
            ),
            (
                "kata",
                "feat/PROJ-123-reset",
                true,
                "feat/PROJ-123-reset",
                "feat/PROJ-123-reset",
            ),
        ];
        for (repo, existing, is_remote, name, reported) in examples {
            let tmp = tempfile::tempdir().unwrap();
            workspace(tmp.path());
            let path = tmp.path().join(repo);
            if is_remote {
                remote(&path, existing);
            } else {
                local(&path, existing);
            }
            let got = clashes(tmp.path(), "ai-sdlc", SYSTEM, name, None).unwrap();
            assert_eq!(got, vec![clash(repo, reported)], "{repo} {existing} {name}");
        }
    }

    #[test]
    fn a_symbolic_remote_head_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, kata) = workspace(tmp.path());
        remote(&kata, "main");
        git::run(
            &kata,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .unwrap();
        let got = clashes(tmp.path(), "ai-sdlc", SYSTEM, "HEAD", None).unwrap();
        assert_eq!(got, vec![]);
    }

    #[test]
    fn clash_check_never_fetches_r6_4() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, kata) = workspace(tmp.path());
        testutil::bare_origin(&kata, None);
        // A teammate pushed after this clone last fetched: origin has it, the clone does not know.
        local(&kata, "feat/PROJ-123-reset");
        git::run(&kata, &["push", "-q", "origin", "feat/PROJ-123-reset"]).unwrap();
        git::run(&kata, &["branch", "-D", "feat/PROJ-123-reset"]).unwrap();
        git::run(
            &kata,
            &[
                "update-ref",
                "-d",
                "refs/remotes/origin/feat/PROJ-123-reset",
            ],
        )
        .unwrap();
        let refs = || git::run(&kata, &["for-each-ref", "refs/remotes"]).unwrap();
        let before = refs();
        let got = clashes(tmp.path(), "ai-sdlc", SYSTEM, "feat/PROJ-123-reset", None).unwrap();
        assert_eq!(got, vec![]);
        assert_eq!(refs(), before);
    }

    #[test]
    fn absent_record_gives_the_default_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, _) = workspace(tmp.path());
        assert_eq!(
            change_branch(&master, SYSTEM, CHANGE).unwrap(),
            format!("change/{CHANGE}")
        );
    }

    #[test]
    fn record_round_trips_and_commits_with_the_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let (master, _) = workspace(tmp.path());
        testutil::commit_file(
            &master,
            &format!("intent/{SYSTEM}/{CHANGE}/intent.md"),
            "---\nstatus: accepted\nscope: PROJ-123\n---\nbody\n",
            "intent",
        );
        // Another staged file must stay out of the commit.
        testutil::write(&master, "other.txt", "x\n");
        testutil::stage(&master, "other.txt");
        let record = BranchRecord {
            branch: "feat/PROJ-123-password-reset".to_string(),
            work_type: Some("feat".to_string()),
        };
        write(&master, SYSTEM, CHANGE, &record, RecordVerb::Name).unwrap();
        assert_eq!(
            change_branch(&master, SYSTEM, CHANGE).unwrap(),
            "feat/PROJ-123-password-reset"
        );
        let text =
            std::fs::read_to_string(master.join(format!("intent/{SYSTEM}/{CHANGE}/branch.md")))
                .unwrap();
        assert!(text.starts_with(
            "---\nbranch: feat/PROJ-123-password-reset\ntype: feat\n---\n\nThe branch this change uses in every repository it touches. Kata writes this file; rename the branch through Kata, not by editing it.\n"
        ), "{text}");
        let message = git::run(&master, &["log", "-1", "--format=%B"]).unwrap();
        assert_eq!(
            message,
            format!("docs(PROJ-123): name branch {CHANGE}\n\nGenerated-By: ai-sdlc")
        );
        let files = git::run(&master, &["show", "--name-only", "--format=", "HEAD"]).unwrap();
        assert_eq!(files, format!("intent/{SYSTEM}/{CHANGE}/branch.md"));

        let renamed = BranchRecord {
            branch: "feat/PROJ-123-reset".to_string(),
            work_type: None,
        };
        write(&master, SYSTEM, CHANGE, &renamed, RecordVerb::Rename).unwrap();
        let subject = git::run(&master, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(subject, format!("docs(PROJ-123): rename branch {CHANGE}"));
        assert_eq!(
            change_branch(&master, SYSTEM, CHANGE).unwrap(),
            "feat/PROJ-123-reset"
        );
    }

    #[test]
    fn invalid_record_is_refused() {
        let rel = format!("intent/{SYSTEM}/{CHANGE}/branch.md");
        let bodies = [
            "---\nbranch: -D\n---\n\ntext\n",
            "---\ntype: feat\n---\n\ntext\n",
            "---\nbranch: feat/a..b\n---\n\ntext\n",
            "---\nbranch: \"\"\n---\n\ntext\n",
        ];
        for body in bodies {
            let tmp = tempfile::tempdir().unwrap();
            let (master, _) = workspace(tmp.path());
            testutil::write(&master, &rel, body);
            match change_branch(&master, SYSTEM, CHANGE) {
                Err(RecordError::Invalid(msg)) => assert!(msg.contains("branch.md"), "{msg}"),
                other => panic!("{body:?} gave {other:?}"),
            }
        }
    }
}
