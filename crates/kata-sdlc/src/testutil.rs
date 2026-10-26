//! Git fixtures for tests.
use crate::git::{self, GitError};
use std::path::{Path, PathBuf};

fn exec(dir: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    let fail = |stderr: String| GitError {
        args: args.join(" "),
        stderr,
    };
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    let out = cmd.output().map_err(|e| fail(e.to_string()))?;
    if !out.status.success() {
        return Err(fail(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(out.stdout)
}

/// Run `git -C <dir> <args>` and return stdout without its trailing newline.
pub fn run(dir: &Path, args: &[&str]) -> Result<String, GitError> {
    exec(dir, args).map(|out| git::trimmed_text(&out))
}

/// Run `git -C <dir> <args>` and return stdout untouched, byte for byte.
pub fn run_bytes(dir: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    exec(dir, args)
}

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

/// A stand-in for the ai-sdlc plugin folder: its `format/` is the vendored copy of the plugin's
/// format program, and its version is the first one that supports the light track. Made once per test process.
pub fn plugin_dir() -> &'static Path {
    static DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        fn copy(from: &Path, to: &Path) {
            std::fs::create_dir_all(to).unwrap();
            for entry in std::fs::read_dir(from).unwrap().flatten() {
                let target = to.join(entry.file_name());
                if entry.path().is_dir() {
                    copy(&entry.path(), &target);
                } else {
                    std::fs::copy(entry.path(), target).unwrap();
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let vendored = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-format");
        copy(&vendored, &dir.path().join("format"));
        let meta = dir.path().join(".claude-plugin");
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("plugin.json"),
            format!(
                r#"{{"name":"ai-sdlc","version":"{}"}}"#,
                crate::plugin::LIGHT_TRACK_VERSION
            ),
        )
        .unwrap();
        dir
    })
    .path()
}

/// A stand-in plugin at `dir` whose `format/check.mjs` answers `fix-state --json <folder>...` without
/// git: a folder named with `row7` or `row9` stands at that row, one named with `broken` gets an `error`
/// entry, any other stands at row 6. Every call appends a line to `format/calls.log`, so a test counts
/// the processes a scan started. Returns the plugin folder.
#[allow(dead_code)]
pub fn fake_fix_plugin(dir: &Path, version: &str) -> PathBuf {
    let format = dir.join("format");
    std::fs::create_dir_all(&format).unwrap();
    std::fs::create_dir_all(dir.join(".claude-plugin")).unwrap();
    std::fs::write(
        dir.join(".claude-plugin").join("plugin.json"),
        format!(r#"{{"name":"ai-sdlc","version":"{version}"}}"#),
    )
    .unwrap();
    std::fs::write(
        format.join("check.mjs"),
        r#"import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [, , command, , ...folders] = process.argv;
appendFileSync(fileURLToPath(new URL('calls.log', import.meta.url)), `${command} ${folders.length}\n`);
const doc = { inHead: true, headStatus: 'draft', workingStatus: 'draft' };
const facts = { intent: doc, spec: doc, plan: doc, unrecorded: [], ownLinesOnly: false, accepted: 'none', acceptanceLast: false, built: false };
const rowOf = (folder) => (folder.includes('row9') ? 9 : folder.includes('row7') ? 7 : 6);
console.log(JSON.stringify(folders.map((folder) => folder.includes('broken')
  ? { folder, error: `${folder}: git failed` }
  : { folder, result: { row: rowOf(folder), facts } })));
"#,
    )
    .unwrap();
    dir.to_path_buf()
}
