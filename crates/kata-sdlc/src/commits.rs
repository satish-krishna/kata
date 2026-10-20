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

const TYPES: [&str; 11] = [
    "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
];

/// Whether `message` has a `<type>(<scope>)!?: <non-space>` header with exactly `scope`
/// and a later `Generated-By: ai-sdlc` line.
pub fn follows_rules(message: &str, scope: &str) -> bool {
    let mut lines = message
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l));
    let header = lines.next().unwrap_or("");
    header_ok(header, scope) && lines.any(|l| l == "Generated-By: ai-sdlc")
}

fn header_ok(header: &str, scope: &str) -> bool {
    let Some((kind, rest)) = header.split_once('(') else {
        return false;
    };
    if !TYPES.contains(&kind) {
        return false;
    }
    let Some(rest) = rest.strip_prefix(scope).and_then(|r| r.strip_prefix(')')) else {
        return false;
    };
    let rest = rest.strip_prefix('!').unwrap_or(rest);
    rest.strip_prefix(": ")
        .and_then(|r| r.chars().next())
        .is_some_and(|c| !c.is_whitespace())
}

/// Commits in `<merge_base>..HEAD` of `repo_dir` that break the rules.
pub fn offenders(
    repo_dir: &Path,
    repo: &str,
    merge_base: &str,
    scope: &str,
) -> Result<Vec<Offender>, GitError> {
    offenders_to(repo_dir, repo, merge_base, "HEAD", scope)
}

/// Commits in `<merge_base>..<tip>` of `repo_dir` that break the rules.
pub fn offenders_to(
    repo_dir: &Path,
    repo: &str,
    merge_base: &str,
    tip: &str,
    scope: &str,
) -> Result<Vec<Offender>, GitError> {
    let range = format!("{merge_base}..{tip}");
    let log = git::run(repo_dir, &["log", "--format=%h%x1f%B%x1e", range.as_str()])?;
    Ok(log
        .split('\x1e')
        .filter_map(|rec| {
            let (hash, message) = rec.trim_start_matches('\n').split_once('\x1f')?;
            (!follows_rules(message, scope)).then(|| Offender {
                repo: repo.to_string(),
                hash: hash.to_string(),
                subject: message.lines().next().unwrap_or("").trim_end().to_string(),
            })
        })
        .collect())
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
