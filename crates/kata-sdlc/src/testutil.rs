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
