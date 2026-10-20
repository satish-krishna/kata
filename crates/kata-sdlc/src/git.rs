use std::path::Path;

/// A failed git invocation: the argument list and git's stderr.
#[derive(Debug, thiserror::Error)]
#[error("git {args}: {stderr}")]
pub struct GitError {
    pub args: String,
    pub stderr: String,
}

/// Run `git -C <dir> <args>` and return stdout without its trailing newline.
pub fn run(dir: &Path, args: &[&str]) -> Result<String, GitError> {
    let fail = |stderr: String| GitError {
        args: args.join(" "),
        stderr,
    };
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| fail(e.to_string()))?;
    if !out.status.success() {
        return Err(fail(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stdout = stdout.strip_suffix('\n').unwrap_or(&stdout);
    Ok(stdout.strip_suffix('\r').unwrap_or(stdout).to_string())
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
