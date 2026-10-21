use std::ffi::OsStr;
use std::path::Path;

/// A failed git invocation: the argument list and git's stderr.
#[derive(Debug, thiserror::Error)]
#[error("git {args}: {stderr}")]
pub struct GitError {
    pub args: String,
    pub stderr: String,
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
