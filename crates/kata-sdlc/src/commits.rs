//! The commit rules for a change branch: the change's scope and the ai-sdlc trailer.
use crate::git::{self, GitError};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A commit on a change branch that breaks the commit rules.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Offender {
    pub repo: String,
    pub hash: String,
    pub subject: String,
}

/// Whether `message` has a `<type>(<scope>)!?: <non-space>` header with exactly `scope`
/// and a later `Generated-By: ai-sdlc` line.
pub fn follows_rules(_message: &str, _scope: &str) -> bool {
    todo!()
}

/// Commits in `<merge_base>..HEAD` of `repo_dir` that break the rules.
pub fn offenders(
    _repo_dir: &Path,
    _repo: &str,
    _merge_base: &str,
    _scope: &str,
) -> Result<Vec<Offender>, GitError> {
    let _ = git::run;
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    #[test]
    fn follows_rules_table() {
        let t = "Generated-By: ai-sdlc";
        assert!(follows_rules(&format!("feat(sdlc): x\n\n{t}\n"), "sdlc"));
        assert!(follows_rules(
            &format!("fix(sdlc)!: y\r\n\r\n{t}\r\n"),
            "sdlc"
        ));
        assert!(!follows_rules(&format!("feat(other): x\n\n{t}\n"), "sdlc"));
        assert!(!follows_rules("feat(sdlc): x\n\nbody\n", "sdlc"));
        assert!(!follows_rules(&format!("wip(sdlc): x\n\n{t}\n"), "sdlc"));
        assert!(!follows_rules(&format!("feat(sdlc):x\n\n{t}\n"), "sdlc"));
    }

    #[test]
    fn offenders_lists_commits_without_scope_or_trailer_r11_5() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "app");
        let base = git::run(&repo, &["rev-parse", "HEAD"]).unwrap();
        testutil::commit_msg(
            &repo,
            "a.txt",
            "a",
            "feat(sdlc): good\n\nGenerated-By: ai-sdlc",
        );
        testutil::commit_msg(&repo, "b.txt", "b", "fix: tweak");
        let got = offenders(&repo, "app", &base, "sdlc").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].repo, "app");
        assert_eq!(got[0].subject, "fix: tweak");
    }
}
