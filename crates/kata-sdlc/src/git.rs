use std::ffi::OsStr;
use std::path::Path;

/// A failed git invocation: the argument list and git's stderr.
#[derive(Debug, thiserror::Error)]
#[error("git {args}: {stderr}")]
pub struct GitError {
    pub args: String,
    pub stderr: String,
}

impl GitError {
    /// A libgit2 failure reported the way a failed git command was: `action` names the command the
    /// operation replaces and `stderr` is libgit2's message.
    pub fn from_git2(action: &str, e: git2::Error) -> GitError {
        GitError {
            args: action.to_string(),
            stderr: e.message().to_string(),
        }
    }
}

/// One line of `git status --porcelain=v1`: the path, the index and work tree codes, and the
/// source of a rename.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    pub index: char,
    pub worktree: char,
    pub from: Option<String>,
}

/// A repository opened for reading.
pub struct Repo {
    inner: git2::Repository,
}

impl Repo {
    pub fn open(path: &Path) -> Result<Repo, GitError> {
        git2::Repository::open(path)
            .map(|inner| Repo { inner })
            .map_err(|e| GitError::from_git2(&format!("-C {} rev-parse", path.display()), e))
    }

    pub fn head_sha(&self) -> Result<String, GitError> {
        let _ = &self.inner;
        todo!("head_sha")
    }

    pub fn committed_bytes(&self, _rel: &str) -> Result<Option<Vec<u8>>, GitError> {
        todo!("committed_bytes")
    }

    pub fn tree_names(&self, _dir: &str) -> Result<Vec<String>, GitError> {
        todo!("tree_names")
    }

    pub fn is_committed(&self, _rel: &str) -> bool {
        false
    }

    pub fn status(&self, _under: &str) -> Result<Vec<StatusEntry>, GitError> {
        todo!("status")
    }

    pub fn blob_id_at(&self, _rev: &str, _rel: &str) -> Result<Option<String>, GitError> {
        todo!("blob_id_at")
    }

    pub fn commits_since(&self, _rev: &str, _pathspec: &str) -> Result<Vec<String>, GitError> {
        todo!("commits_since")
    }

    pub fn count_since(
        &self,
        _rev: &str,
        _include: &[&str],
        _exclude: &[&str],
    ) -> Result<u32, GitError> {
        todo!("count_since")
    }
}

fn exec(dir: &Path, args: &[&str], env: &[(&str, &OsStr)]) -> Result<Vec<u8>, GitError> {
    let fail = |stderr: String| GitError {
        args: args.join(" "),
        stderr,
    };
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    for (key, value) in env {
        cmd.env(key, value);
    }
    let out = cmd.output().map_err(|e| fail(e.to_string()))?;
    if !out.status.success() {
        return Err(fail(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(out.stdout)
}

fn trimmed(stdout: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout);
    let stdout = stdout.strip_suffix('\n').unwrap_or(&stdout);
    stdout.strip_suffix('\r').unwrap_or(stdout).to_string()
}

/// Run `git -C <dir> <args>` and return stdout without its trailing newline.
pub fn run(dir: &Path, args: &[&str]) -> Result<String, GitError> {
    exec(dir, args, &[]).map(|out| trimmed(&out))
}

/// Run `git -C <dir> <args>` and return stdout untouched, byte for byte. `run` strips the
/// trailing newline, which would show a phantom last-line change in a file's content.
pub fn run_bytes(dir: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    exec(dir, args, &[])
}

/// Like `run_bytes`, with extra environment variables for the child, such as `GIT_INDEX_FILE`.
pub fn run_env(dir: &Path, args: &[&str], env: &[(&str, &OsStr)]) -> Result<Vec<u8>, GitError> {
    exec(dir, args, env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_reports_stderr() {
        let tmp = tempfile::tempdir().unwrap();
        let err = run(tmp.path(), &["rev-parse", "HEAD"]).unwrap_err();
        assert!(
            err.to_string().starts_with("git rev-parse HEAD:"),
            "got: {err}"
        );
    }
}
