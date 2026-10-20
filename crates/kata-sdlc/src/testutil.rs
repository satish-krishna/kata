//! Git fixtures for tests.
use crate::git;
use std::path::{Path, PathBuf};

/// Create `<dir>/<name>` as a git repo with a local identity and one commit on `main`.
pub fn repo(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::create_dir_all(&path).unwrap();
    git::run(&path, &["init", "-q", "-b", "main"]).unwrap();
    git::run(&path, &["config", "user.name", "Test"]).unwrap();
    git::run(&path, &["config", "user.email", "test@example.com"]).unwrap();
    git::run(&path, &["config", "commit.gpgsign", "false"]).unwrap();
    commit_file(&path, "README.md", "init\n", "init");
    path
}

/// Write `rel` (creating parents), stage it, and commit.
pub fn commit_file(repo: &Path, rel: &str, contents: &str, msg: &str) {
    let file = repo.join(rel);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&file, contents).unwrap();
    git::run(repo, &["add", "--", rel]).unwrap();
    git::run(repo, &["commit", "-q", "-m", msg]).unwrap();
}

/// Like `commit_file`, but with a multi-line commit message taken verbatim.
pub fn commit_msg(repo: &Path, rel: &str, contents: &str, message: &str) {
    let file = repo.join(rel);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&file, contents).unwrap();
    git::run(repo, &["add", "--", rel]).unwrap();
    git::run(repo, &["commit", "-q", "--cleanup=verbatim", "-m", message]).unwrap();
}

/// Write `rel` (creating parents) without staging it.
#[allow(dead_code)]
pub fn write(repo: &Path, rel: &str, contents: &str) {
    let file = repo.join(rel);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(file, contents).unwrap();
}

/// Delete `rel` from the working tree.
#[allow(dead_code)]
pub fn remove(repo: &Path, rel: &str) {
    std::fs::remove_file(repo.join(rel)).unwrap();
}

/// Rename `from` to `to` in the working tree.
#[allow(dead_code)]
pub fn rename(repo: &Path, from: &str, to: &str) {
    std::fs::rename(repo.join(from), repo.join(to)).unwrap();
}

/// `git add -- rel`.
#[allow(dead_code)]
pub fn stage(repo: &Path, rel: &str) {
    git::run(repo, &["add", "--", rel]).unwrap();
}

/// `git checkout <name>`; with `create`, `git checkout -b <name>`.
pub fn checkout(repo: &Path, name: &str, create: bool) {
    if create {
        git::run(repo, &["checkout", "-q", "-b", name]).unwrap();
    } else {
        git::run(repo, &["checkout", "-q", name]).unwrap();
    }
}

/// A bare clone beside `repo`, set as `origin`, holding the current branch pushed under its own
/// name. With `origin_head = Some(b)` the current branch is also pushed as `b`, fetched, and
/// `refs/remotes/origin/HEAD` set to `origin/b`. Without it, origin/HEAD does not exist.
pub fn bare_origin(repo: &Path, origin_head: Option<&str>) -> PathBuf {
    let name = repo.file_name().unwrap().to_string_lossy().to_string();
    let bare = repo.with_file_name(format!("{name}-origin.git"));
    git::run(
        repo.parent().unwrap(),
        &["init", "-q", "--bare", bare.to_str().unwrap()],
    )
    .unwrap();
    git::run(repo, &["remote", "add", "origin", bare.to_str().unwrap()]).unwrap();
    let current = git::run(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
    git::run(repo, &["push", "-q", "origin", &current]).unwrap();
    if let Some(b) = origin_head {
        git::run(
            repo,
            &["push", "-q", "origin", &format!("{current}:refs/heads/{b}")],
        )
        .unwrap();
        git::run(repo, &["fetch", "-q", "origin"]).unwrap();
        git::run(repo, &["remote", "set-head", "origin", b]).unwrap();
    }
    bare
}

/// Commit `rel` as someone else's work that reached `origin/<branch>` while local `<branch>`
/// stayed behind: commit on `branch`, push it, move local `branch` back, then return to the
/// branch that was checked out. Leaves `origin/<branch>` one commit ahead of local `<branch>`.
#[allow(dead_code)]
pub fn advance_origin_only(repo: &Path, branch: &str, rel: &str, msg: &str) {
    let back = git::run(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
    checkout(repo, branch, false);
    commit_file(repo, rel, "others\n", msg);
    git::run(repo, &["push", "-q", "origin", branch]).unwrap();
    git::run(repo, &["reset", "-q", "--hard", "HEAD~1"]).unwrap();
    checkout(repo, &back, false);
}
