//! What changed in one repository, read with the git CLI and never written. A port of mekiki's
//! diff behavior: the three parts of a change, their files with line counts, the two sides of a
//! file for the diff editor, and line counts grouped by file type.

use crate::base::{self, BaseError};
use crate::git::{self, GitError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Which part of a change to look at.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Part {
    /// The merge base to the working tree: everything the change touched.
    Whole,
    /// The merge base to `HEAD`: what the change's commits carry.
    Committed,
    /// `HEAD` to the working tree: edits not yet committed.
    Uncommitted,
}

/// How a file changed.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

/// One file in a diff, with its line counts.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ChangedFile {
    /// Repository-relative path, forward slashes. For a deletion, the path that was deleted.
    pub path: String,
    /// The path before a rename; `null` otherwise.
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    pub binary: bool,
    pub added: u32,
    pub removed: u32,
    /// The file has edits that are not committed yet.
    pub uncommitted: bool,
}

impl ChangedFile {
    /// Lowercase extension of the path, or `(none)`. Dotfiles such as `.gitignore` have none.
    pub fn file_type(&self) -> String {
        Path::new(&self.path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| NO_EXTENSION.to_string())
    }
}

/// One commit on the change branch and the files it touched.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct CommitFiles {
    /// The full 40-character hash.
    pub sha: String,
    /// Repository-relative paths, forward slashes, sorted.
    pub files: Vec<String>,
}

/// The commits since the merge base, oldest first, each with the files it touched.
///
/// It takes the left side as `left_side(repo, Part::Committed)` does, so the commits agree with the
/// Committed and Whole parts of the diff. A rename lists as a delete and an add; a merge commit
/// lists no files. It never fetches and never writes.
pub fn commit_files(repo: &Path) -> Result<Vec<CommitFiles>, DiffError> {
    let left = left_side(repo, Part::Committed)?;
    let range = format!("{left}..HEAD");
    let out = git::run_bytes(
        repo,
        &[
            "--no-optional-locks",
            "log",
            "--reverse",
            "--no-renames",
            "--format=%x00%H",
            "--name-only",
            "-z",
            &range,
        ],
    )?;
    Ok(parse_commit_files(&out))
}

/// Parse `log --format=%x00%H --name-only -z`: each commit is an empty token, its hash, then its
/// paths. A path is never empty, so an empty token marks the start of a commit. Git puts a newline
/// between the hash and the first path.
fn parse_commit_files(out: &[u8]) -> Vec<CommitFiles> {
    let mut commits: Vec<CommitFiles> = Vec::new();
    let mut next_is_sha = false;
    let mut after_sha = false;
    for token in out.split(|b| *b == 0) {
        let token = String::from_utf8_lossy(token);
        if token.is_empty() {
            next_is_sha = true;
            after_sha = false;
        } else if next_is_sha {
            commits.push(CommitFiles {
                sha: token.trim().to_string(),
                files: Vec::new(),
            });
            next_is_sha = false;
            after_sha = true;
        } else if let Some(commit) = commits.last_mut() {
            let path = if after_sha {
                token.strip_prefix('\n').unwrap_or(&token)
            } else {
                &token
            };
            after_sha = false;
            if !path.is_empty() {
                commit.files.push(path.to_string());
            }
        }
    }
    for commit in &mut commits {
        commit.files.sort();
        commit.files.dedup();
    }
    commits
}

/// Both sides of one file, for the diff editor. A missing side is an empty string; a binary file
/// carries `binary: true` and no content.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct FilePair {
    pub original: String,
    pub modified: String,
    /// A Monaco language id derived from the file extension, `plaintext` when unknown.
    pub language_hint: String,
    pub binary: bool,
}

/// Lines added and removed across all changed text files of one type.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct FileTypeStats {
    /// Lowercase extension without the dot, or `(none)`.
    pub extension: String,
    pub files: u32,
    pub added: u32,
    pub removed: u32,
}

const NO_EXTENSION: &str = "(none)";

#[derive(Debug, thiserror::Error)]
pub enum DiffError {
    #[error("{0} is not part of the change")]
    FileNotChanged(String),
    #[error(transparent)]
    Base(#[from] BaseError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Maps a file name to a Monaco language id.
pub fn language_for(path: &str) -> &'static str {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name == "dockerfile" {
        return "dockerfile";
    }
    let extension = Path::new(&name)
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    match extension.as_str() {
        "rs" => "rust",
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "json" => "json",
        "md" | "markdown" => "markdown",
        "cs" => "csharp",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "rb" => "ruby",
        "php" => "php",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "cpp",
        "sql" => "sql",
        "xml" | "csproj" | "props" | "targets" => "xml",
        "yml" | "yaml" => "yaml",
        "sh" | "bash" | "zsh" => "shell",
        "ps1" | "psm1" => "powershell",
        "swift" => "swift",
        "toml" | "ini" => "ini",
        _ => "plaintext",
    }
}

fn binary_pair(path: &str) -> FilePair {
    FilePair {
        original: String::new(),
        modified: String::new(),
        language_hint: language_for(path).to_string(),
        binary: true,
    }
}

/// The files of one part of a change and their line counts by file type.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct DiffListing {
    pub files: Vec<ChangedFile>,
    pub loc: Vec<FileTypeStats>,
}

/// Groups changed text files by file type, largest change first. Binaries are excluded.
pub fn loc_by_file_type(files: &[ChangedFile]) -> Vec<FileTypeStats> {
    let mut by_type: BTreeMap<String, FileTypeStats> = BTreeMap::new();
    for file in files.iter().filter(|f| !f.binary) {
        let extension = file.file_type();
        let stats = by_type.entry(extension.clone()).or_insert(FileTypeStats {
            extension,
            files: 0,
            added: 0,
            removed: 0,
        });
        stats.files += 1;
        stats.added += file.added;
        stats.removed += file.removed;
    }
    let mut all: Vec<FileTypeStats> = by_type.into_values().collect();
    all.sort_by(|a, b| {
        (b.added + b.removed)
            .cmp(&(a.added + a.removed))
            .then_with(|| a.extension.cmp(&b.extension))
    });
    all
}

/// The files of one part of the change, sorted by path.
pub fn changed_files(repo: &Path, part: Part) -> Result<Vec<ChangedFile>, DiffError> {
    let mut files = list(repo, part)?;
    match part {
        Part::Uncommitted => files.iter_mut().for_each(|f| f.uncommitted = true),
        Part::Whole | Part::Committed => {
            let dirty: BTreeSet<String> = list(repo, Part::Uncommitted)?
                .into_iter()
                .map(|f| f.path)
                .collect();
            for f in &mut files {
                f.uncommitted = dirty.contains(&f.path);
            }
        }
    }
    Ok(files)
}

/// The two sides of `path`, which must be one of the part's changed files.
pub fn file_pair(repo: &Path, part: Part, path: &str) -> Result<FilePair, DiffError> {
    let file = changed_files(repo, part)?
        .into_iter()
        .find(|f| f.path == path)
        .ok_or_else(|| DiffError::FileNotChanged(path.to_string()))?;
    if file.binary {
        return Ok(binary_pair(path));
    }
    let left = left_side(repo, part)?;
    let original = match file.status {
        ChangeStatus::Added | ChangeStatus::Untracked => String::new(),
        _ => {
            let old = file.old_path.as_deref().unwrap_or(path);
            show(repo, &format!("{left}:{old}"))?
        }
    };
    let modified = match (file.status, part) {
        (ChangeStatus::Deleted, _) => String::new(),
        (_, Part::Committed) => show(repo, &format!("HEAD:{path}"))?,
        _ => lossy(&std::fs::read(repo.join(path))?),
    };
    Ok(FilePair {
        original,
        modified,
        language_hint: language_for(path).to_string(),
        binary: false,
    })
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn show(repo: &Path, object: &str) -> Result<String, GitError> {
    Ok(lossy(&git::run_bytes(repo, &["show", object])?))
}

/// The revision the part's diff starts from.
fn left_side(repo: &Path, part: Part) -> Result<String, DiffError> {
    Ok(match part {
        Part::Uncommitted => "HEAD".to_string(),
        Part::Whole | Part::Committed => base::base_info(repo)?.merge_base,
    })
}

fn list(repo: &Path, part: Part) -> Result<Vec<ChangedFile>, DiffError> {
    let left = left_side(repo, part)?;
    let mut files = match part {
        Part::Committed => {
            let numstat = diff_output(repo, "--numstat", &[&left, "HEAD"], None)?;
            let status = diff_output(repo, "--name-status", &[&left, "HEAD"], None)?;
            parse(&numstat, &status, &BTreeSet::new())
        }
        Part::Whole | Part::Uncommitted => with_throwaway_index(repo, |index, untracked| {
            let numstat = diff_output(repo, "--numstat", &[&left], Some(index))?;
            let status = diff_output(repo, "--name-status", &[&left], Some(index))?;
            Ok(parse(&numstat, &status, untracked))
        })?,
    };
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn diff_output(
    repo: &Path,
    format: &str,
    revs: &[&str],
    index: Option<&Path>,
) -> Result<Vec<u8>, GitError> {
    let mut args = vec![
        "--no-optional-locks",
        "diff",
        "--no-ext-diff",
        "-M",
        format,
        "-z",
    ];
    args.extend_from_slice(revs);
    match index {
        Some(index) => git::run_env(repo, &args, &[("GIT_INDEX_FILE", index.as_os_str())]),
        None => git::run_bytes(repo, &args),
    }
}

/// Copy the repository's index to a temp file, mark the untracked non-ignored files in the copy
/// as intent-to-add, and hand the copy and the untracked paths to `body`. The repository's own
/// index is never written; the copy is deleted afterwards.
fn with_throwaway_index<T>(
    repo: &Path,
    body: impl FnOnce(&Path, &BTreeSet<String>) -> Result<T, DiffError>,
) -> Result<T, DiffError> {
    let real = git::run(repo, &["rev-parse", "--git-path", "index"])?;
    let real = repo.join(real);
    let temp = tempfile::Builder::new()
        .prefix("kata-index-")
        .tempfile()?
        .into_temp_path();
    if real.exists() {
        std::fs::copy(&real, &temp)?;
    }
    let result = prepare_and_run(repo, &temp, body);
    let _ = temp.close();
    result
}

fn prepare_and_run<T>(
    repo: &Path,
    temp: &Path,
    body: impl FnOnce(&Path, &BTreeSet<String>) -> Result<T, DiffError>,
) -> Result<T, DiffError> {
    let listing = git::run_bytes(
        repo,
        &[
            "--no-optional-locks",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?;
    let untracked: Vec<String> = listing
        .split(|b| *b == 0)
        .filter(|t| !t.is_empty())
        .map(lossy)
        .collect();
    let env = [("GIT_INDEX_FILE", temp.as_os_str())];
    let mut chunk: Vec<&str> = Vec::new();
    let mut size = 0;
    let flush = |chunk: &mut Vec<&str>| -> Result<(), GitError> {
        if chunk.is_empty() {
            return Ok(());
        }
        let mut args = vec!["--literal-pathspecs", "add", "-N", "--"];
        args.append(chunk);
        git::run_env(repo, &args, &env).map(|_| ())
    };
    for path in &untracked {
        if size + path.len() > 16_000 {
            flush(&mut chunk)?;
            size = 0;
        }
        size += path.len() + 1;
        chunk.push(path);
    }
    flush(&mut chunk)?;
    body(temp, &untracked.iter().cloned().collect())
}

/// Combine `--name-status -z` (status and paths) with `--numstat -z` (counts and binary flag).
fn parse(numstat: &[u8], name_status: &[u8], untracked: &BTreeSet<String>) -> Vec<ChangedFile> {
    let tokens = |b: &[u8]| -> Vec<String> { b.split(|c| *c == 0).map(lossy).collect() };
    let mut counts: BTreeMap<String, (u32, u32, bool)> = BTreeMap::new();
    let toks = tokens(numstat);
    let mut i = 0;
    while i < toks.len() {
        let mut parts = toks[i].splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            i += 1;
            continue;
        };
        let entry = (a.parse().unwrap_or(0), r.parse().unwrap_or(0), a == "-");
        if path.is_empty() {
            if let Some(new) = toks.get(i + 2) {
                counts.insert(new.clone(), entry);
            }
            i += 3;
        } else {
            counts.insert(path.to_string(), entry);
            i += 1;
        }
    }
    let mut files = Vec::new();
    let toks = tokens(name_status);
    let mut i = 0;
    while i < toks.len() {
        let Some(code) = toks[i].chars().next() else {
            i += 1;
            continue;
        };
        let two = matches!(code, 'R' | 'C');
        let Some(first) = toks.get(i + 1) else { break };
        let second = toks.get(i + 2);
        i += if two { 3 } else { 2 };
        let (path, old_path) = match (two, second) {
            (true, Some(new)) => (new.clone(), (code == 'R').then(|| first.clone())),
            _ => (first.clone(), None),
        };
        let status = match code {
            'A' if untracked.contains(&path) => ChangeStatus::Untracked,
            'A' | 'C' => ChangeStatus::Added,
            'D' => ChangeStatus::Deleted,
            'R' => ChangeStatus::Renamed,
            _ => ChangeStatus::Modified,
        };
        let (added, removed, binary) = counts.get(&path).copied().unwrap_or((0, 0, false));
        files.push(ChangedFile {
            path,
            old_path,
            status,
            binary,
            added: if binary { 0 } else { added },
            removed: if binary { 0 } else { removed },
            uncommitted: false,
        });
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{checkout, commit_file, remove, rename, repo, stage, write};
    use std::path::PathBuf;

    /// A repository on `main` with `modified.txt` and `deleted.txt` committed.
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = repo(d.path(), "app");
        // Line endings are not under test; keep a global autocrlf from rewriting checkouts.
        git::run(&r, &["config", "core.autocrlf", "false"]).unwrap();
        commit_file(&r, "modified.txt", "one\ntwo\nthree\n", "files");
        commit_file(&r, "deleted.txt", "gone\n", "more");
        (d, r)
    }

    fn file<'a>(files: &'a [ChangedFile], path: &str) -> &'a ChangedFile {
        files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("{path} not in {files:?}"))
    }

    fn paths(files: &[ChangedFile]) -> Vec<&str> {
        files.iter().map(|f| f.path.as_str()).collect()
    }

    fn png(r: &Path, rel: &str) {
        std::fs::write(r.join(rel), [0x89, b'P', b'N', b'G', 0, 1, 2, 3]).unwrap();
    }

    #[test]
    fn commit_files_lists_each_commit_since_the_merge_base_with_the_paths_it_touched() {
        let (_d, r) = fixture();
        checkout(&r, "change/x", true);
        commit_file(&r, "a.rs", "one\n", "first");
        let first = git::run(&r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        write(&r, "a.rs", "two\n");
        write(
            &r,
            "b/c.rs",
            "content long enough to be a rename\nline\nline\n",
        );
        stage(&r, "a.rs");
        stage(&r, "b/c.rs");
        git::run(&r, &["commit", "-q", "-m", "second"]).unwrap();
        let second = git::run(&r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        git::run(&r, &["mv", "b/c.rs", "d.rs"]).unwrap();
        git::run(&r, &["commit", "-q", "-m", "third"]).unwrap();
        let third = git::run(&r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        write(&r, "e.rs", "uncommitted\n");

        let commits = commit_files(&r).unwrap();

        let expected = vec![
            CommitFiles {
                sha: first,
                files: vec!["a.rs".into()],
            },
            CommitFiles {
                sha: second,
                files: vec!["a.rs".into(), "b/c.rs".into()],
            },
            CommitFiles {
                sha: third,
                files: vec!["b/c.rs".into(), "d.rs".into()],
            },
        ];
        assert_eq!(commits, expected);
        assert!(commits.iter().all(|c| c.sha.len() == 40));
    }

    #[test]
    fn a_clean_repository_has_no_working_tree_changes() {
        let (_d, r) = fixture();
        assert!(changed_files(&r, Part::Uncommitted).unwrap().is_empty());
        assert!(changed_files(&r, Part::Whole).unwrap().is_empty());
    }

    #[test]
    fn working_tree_reports_each_change_status() {
        let (_d, r) = fixture();
        write(&r, "modified.txt", "one\nTWO\nthree\n");
        remove(&r, "deleted.txt");
        write(&r, "added.txt", "staged\n");
        stage(&r, "added.txt");
        write(&r, "untracked.txt", "a\nb\n");

        let files = changed_files(&r, Part::Uncommitted).unwrap();

        let m = file(&files, "modified.txt");
        assert_eq!(m.status, ChangeStatus::Modified);
        assert_eq!((m.added, m.removed), (1, 1));
        let d = file(&files, "deleted.txt");
        assert_eq!(d.status, ChangeStatus::Deleted);
        assert_eq!(d.removed, 1);
        assert_eq!(file(&files, "added.txt").status, ChangeStatus::Added);
        let u = file(&files, "untracked.txt");
        assert_eq!(u.status, ChangeStatus::Untracked);
        assert_eq!(u.added, 2);
        assert_eq!(files.len(), 4);
    }

    #[test]
    fn untracked_files_in_new_folders_are_listed_individually() {
        let (_d, r) = fixture();
        write(&r, "new/dir/one.rs", "fn a() {}\n");
        write(&r, "new/dir/two.rs", "fn b() {}\n");

        let files = changed_files(&r, Part::Uncommitted).unwrap();

        assert_eq!(paths(&files), vec!["new/dir/one.rs", "new/dir/two.rs"]);
    }

    #[test]
    fn a_staged_rename_reports_the_old_path() {
        let (_d, r) = fixture();
        rename(&r, "modified.txt", "renamed.txt");
        stage(&r, "modified.txt");
        stage(&r, "renamed.txt");

        let files = changed_files(&r, Part::Uncommitted).unwrap();

        let renamed = file(&files, "renamed.txt");
        assert_eq!(renamed.status, ChangeStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("modified.txt"));
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn an_unstaged_move_is_detected_as_a_rename() {
        let (_d, r) = fixture();
        rename(&r, "modified.txt", "moved.txt");

        let files = changed_files(&r, Part::Uncommitted).unwrap();

        assert_eq!(file(&files, "moved.txt").status, ChangeStatus::Renamed);
        assert_eq!(
            file(&files, "moved.txt").old_path.as_deref(),
            Some("modified.txt")
        );
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn binary_files_are_flagged_without_line_counts() {
        let (_d, r) = fixture();
        png(&r, "logo.png");

        let files = changed_files(&r, Part::Uncommitted).unwrap();

        let logo = file(&files, "logo.png");
        assert!(logo.binary);
        assert_eq!((logo.added, logo.removed), (0, 0));
        let pair = file_pair(&r, Part::Uncommitted, "logo.png").unwrap();
        assert_eq!(pair, binary_pair("logo.png"));
        assert!(pair.original.is_empty() && pair.modified.is_empty());
    }

    #[test]
    fn file_pair_returns_both_sides_with_an_empty_missing_side() {
        let (_d, r) = fixture();
        write(&r, "modified.txt", "one\nTWO\nthree\n");
        remove(&r, "deleted.txt");
        write(&r, "new.rs", "fn main() {}\n");

        let modified = file_pair(&r, Part::Uncommitted, "modified.txt").unwrap();
        assert_eq!(
            (modified.original.as_str(), modified.modified.as_str()),
            ("one\ntwo\nthree\n", "one\nTWO\nthree\n")
        );
        let deleted = file_pair(&r, Part::Uncommitted, "deleted.txt").unwrap();
        assert_eq!(
            (deleted.original.as_str(), deleted.modified.as_str()),
            ("gone\n", "")
        );
        let added = file_pair(&r, Part::Uncommitted, "new.rs").unwrap();
        assert_eq!(
            (
                added.original.as_str(),
                added.modified.as_str(),
                added.language_hint.as_str()
            ),
            ("", "fn main() {}\n", "rust")
        );
    }

    #[test]
    fn file_pair_of_an_unchanged_file_is_an_error() {
        let (_d, r) = fixture();
        let err = file_pair(&r, Part::Uncommitted, "modified.txt").unwrap_err();
        assert!(matches!(err, DiffError::FileNotChanged(p) if p == "modified.txt"));
    }

    #[test]
    fn branch_mode_diffs_against_the_merge_base_not_the_base_tip() {
        let (_d, r) = fixture();
        checkout(&r, "feature", true);
        commit_file(&r, "feature.rs", "fn f() {}\n", "feature work");
        checkout(&r, "main", false);
        commit_file(&r, "main-only.txt", "moved on\n", "main moved on");
        checkout(&r, "feature", false);

        for part in [Part::Committed, Part::Whole] {
            let files = changed_files(&r, part).unwrap();
            assert_eq!(
                paths(&files),
                vec!["feature.rs"],
                "main's later commit must not appear as a deletion ({part:?})"
            );
            let pair = file_pair(&r, part, "feature.rs").unwrap();
            assert_eq!(
                (pair.original.as_str(), pair.modified.as_str()),
                ("", "fn f() {}\n")
            );
        }
    }

    #[test]
    fn branch_mode_ignores_uncommitted_changes() {
        let (_d, r) = fixture();
        checkout(&r, "feature", true);
        write(&r, "scratch.txt", "not committed\n");

        assert!(changed_files(&r, Part::Committed).unwrap().is_empty());
        assert!(!changed_files(&r, Part::Uncommitted).unwrap().is_empty());
    }

    #[test]
    fn loc_by_file_type_groups_patch_line_stats() {
        let (_d, r) = fixture();
        write(&r, "a.rs", "1\n2\n");
        write(&r, "b.RS", "1\n");
        write(&r, "modified.txt", "one\n");
        std::fs::write(r.join("blob.bin"), [0, 1, 2]).unwrap();

        let stats = loc_by_file_type(&changed_files(&r, Part::Uncommitted).unwrap());

        assert_eq!(
            stats,
            vec![
                FileTypeStats {
                    extension: "rs".into(),
                    files: 2,
                    added: 3,
                    removed: 0
                },
                FileTypeStats {
                    extension: "txt".into(),
                    files: 1,
                    added: 0,
                    removed: 2
                },
            ]
        );
    }

    fn changed(path: &str, binary: bool, added: u32, removed: u32) -> ChangedFile {
        ChangedFile {
            path: path.into(),
            old_path: None,
            status: ChangeStatus::Modified,
            binary,
            added,
            removed,
            uncommitted: false,
        }
    }

    #[test]
    fn groups_by_lowercase_extension_and_excludes_binaries() {
        let files = [
            changed("src/a.rs", false, 10, 2),
            changed("src/B.RS", false, 1, 1),
            changed("README.md", false, 3, 0),
            changed("Makefile", false, 1, 0),
            changed(".gitignore", false, 1, 0),
            changed("logo.png", true, 0, 0),
        ];
        assert_eq!(
            loc_by_file_type(&files),
            vec![
                FileTypeStats {
                    extension: "rs".into(),
                    files: 2,
                    added: 11,
                    removed: 3
                },
                FileTypeStats {
                    extension: "md".into(),
                    files: 1,
                    added: 3,
                    removed: 0
                },
                FileTypeStats {
                    extension: "(none)".into(),
                    files: 2,
                    added: 2,
                    removed: 0
                },
            ]
        );
    }

    #[test]
    fn language_hint_follows_the_extension() {
        assert_eq!(language_for("src/main.rs"), "rust");
        assert_eq!(language_for("app/App.TSX"), "typescript");
        assert_eq!(language_for("Dockerfile"), "dockerfile");
        assert_eq!(language_for("notes"), "plaintext");
    }

    #[test]
    fn whole_change_lists_files_and_line_counts_r7_1() {
        let (_d, r) = fixture();
        checkout(&r, "change/x", true);
        commit_file(&r, "src/a.rs", "1\n2\n3\n", "add");
        commit_file(&r, "modified.txt", "one\nTWO\nthree\nfour\n", "edit");

        let files = changed_files(&r, Part::Whole).unwrap();

        assert_eq!(paths(&files), vec!["modified.txt", "src/a.rs"]);
        let a = file(&files, "src/a.rs");
        assert_eq!((a.added, a.removed), (3, 0));
        let m = file(&files, "modified.txt");
        assert_eq!((m.added, m.removed), (2, 1));
        let pair = file_pair(&r, Part::Whole, "modified.txt").unwrap();
        assert_eq!(pair.original, "one\ntwo\nthree\n");
        assert_eq!(pair.modified, "one\nTWO\nthree\nfour\n");
    }

    #[test]
    fn whole_change_marks_uncommitted_files_r7_2() {
        let (_d, r) = fixture();
        checkout(&r, "change/x", true);
        commit_file(&r, "committed.rs", "fn a() {}\n", "add");
        write(&r, "modified.txt", "one\nTWO\nthree\n");
        write(&r, "fresh.rs", "fn b() {}\n");

        let files = changed_files(&r, Part::Whole).unwrap();

        assert_eq!(
            paths(&files),
            vec!["committed.rs", "fresh.rs", "modified.txt"]
        );
        assert!(!file(&files, "committed.rs").uncommitted);
        assert!(file(&files, "fresh.rs").uncommitted);
        assert!(file(&files, "modified.txt").uncommitted);
        for f in changed_files(&r, Part::Uncommitted).unwrap() {
            assert!(f.uncommitted, "{}", f.path);
        }
    }

    fn snapshot(r: &Path) -> (Vec<u8>, String, String, String) {
        (
            std::fs::read(r.join(".git/index")).unwrap(),
            git::run(r, &["rev-parse", "HEAD"]).unwrap(),
            git::run(r, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(),
            git::run(
                r,
                &["--no-optional-locks", "status", "--porcelain=v1", "-uall"],
            )
            .unwrap(),
        )
    }

    #[test]
    fn diff_calls_leave_the_index_byte_identical_r7_3() {
        let (_d, r) = fixture();
        checkout(&r, "change/x", true);
        commit_file(&r, "committed.rs", "fn a() {}\n", "add");
        write(&r, "modified.txt", "one\nTWO\nthree\n");
        write(&r, "fresh/new.rs", "fn b() {}\n");
        write(&r, "staged.rs", "fn c() {}\n");
        stage(&r, "staged.rs");
        rename(&r, "deleted.txt", "moved.txt");
        let before = snapshot(&r);

        for part in [Part::Whole, Part::Committed, Part::Uncommitted] {
            let files = changed_files(&r, part).unwrap();
            assert_eq!(snapshot(&r), before, "after changed_files({part:?})");
            for f in files.iter().filter(|f| !f.binary) {
                file_pair(&r, part, &f.path).unwrap();
                assert_eq!(
                    snapshot(&r),
                    before,
                    "after file_pair({part:?}, {})",
                    f.path
                );
            }
        }
        assert!(before.3.contains("?? fresh/new.rs"));
    }

    #[test]
    fn each_kind_of_file_change_is_shown_for_what_it_is_r7_5() {
        let (_d, r) = fixture();
        checkout(&r, "change/x", true);
        commit_file(&r, "added.rs", "fn a() {}\nfn b() {}\n", "add");
        remove(&r, "deleted.txt");
        rename(&r, "modified.txt", "moved.txt");
        write(&r, "moved.txt", "one\ntwo\nthree\nfour\n");
        png(&r, "logo.png");
        git::run(&r, &["add", "-A"]).unwrap();
        git::run(&r, &["commit", "-q", "-m", "rest"]).unwrap();
        write(&r, "fresh.rs", "fn c() {}\n");

        let files = changed_files(&r, Part::Whole).unwrap();

        assert_eq!(file(&files, "added.rs").status, ChangeStatus::Added);
        let pair = file_pair(&r, Part::Whole, "added.rs").unwrap();
        assert_eq!(
            (pair.original.as_str(), pair.modified.as_str()),
            ("", "fn a() {}\nfn b() {}\n")
        );
        assert_eq!(file(&files, "deleted.txt").status, ChangeStatus::Deleted);
        let pair = file_pair(&r, Part::Whole, "deleted.txt").unwrap();
        assert_eq!(
            (pair.original.as_str(), pair.modified.as_str()),
            ("gone\n", "")
        );
        let moved = file(&files, "moved.txt");
        assert_eq!(moved.status, ChangeStatus::Renamed);
        assert_eq!(moved.old_path.as_deref(), Some("modified.txt"));
        assert_eq!((moved.added, moved.removed), (1, 0));
        let pair = file_pair(&r, Part::Whole, "moved.txt").unwrap();
        assert_eq!(pair.original, "one\ntwo\nthree\n");
        assert_eq!(pair.modified, "one\ntwo\nthree\nfour\n");
        let fresh = file(&files, "fresh.rs");
        assert_eq!(fresh.status, ChangeStatus::Untracked);
        assert!(fresh.uncommitted);
        let pair = file_pair(&r, Part::Whole, "fresh.rs").unwrap();
        assert_eq!(
            (pair.original.as_str(), pair.modified.as_str()),
            ("", "fn c() {}\n")
        );
        let logo = file(&files, "logo.png");
        assert!(logo.binary);
        assert_eq!((logo.added, logo.removed), (0, 0));
        assert!(file_pair(&r, Part::Whole, "logo.png").unwrap().binary);
    }

    #[test]
    fn the_three_parts_select_their_files_r7_6() {
        let (_d, r) = fixture();
        checkout(&r, "change/x", true);
        commit_file(&r, "committed.rs", "fn a() {}\n", "add");
        write(&r, "modified.txt", "one\nTWO\nthree\n");

        let whole = changed_files(&r, Part::Whole).unwrap();
        let committed = changed_files(&r, Part::Committed).unwrap();
        let uncommitted = changed_files(&r, Part::Uncommitted).unwrap();

        assert_eq!(paths(&whole), vec!["committed.rs", "modified.txt"]);
        assert_eq!(paths(&committed), vec!["committed.rs"]);
        assert_eq!(paths(&uncommitted), vec!["modified.txt"]);
    }

    #[test]
    fn non_utf8_text_is_listed_and_opened_as_text() {
        let (_d, r) = fixture();
        std::fs::write(r.join("latin.txt"), b"caf\xe9\nbar\n").unwrap();

        let files = changed_files(&r, Part::Uncommitted).unwrap();

        let f = file(&files, "latin.txt");
        assert!(!f.binary);
        assert_eq!(f.added, 2);
        let pair = file_pair(&r, Part::Uncommitted, "latin.txt").unwrap();
        assert!(!pair.binary);
        assert_eq!(pair.modified, "caf\u{fffd}\nbar\n");
    }

    #[test]
    fn file_pair_keeps_trailing_newlines() {
        let (_d, r) = fixture();
        checkout(&r, "change/x", true);
        commit_file(&r, "modified.txt", "one\ntwo\nthree\n\n\n", "blank lines");
        write(&r, "modified.txt", "one\ntwo\nthree\n\n\n\n");

        let committed = file_pair(&r, Part::Committed, "modified.txt").unwrap();
        assert_eq!(committed.original, "one\ntwo\nthree\n");
        assert_eq!(committed.modified, "one\ntwo\nthree\n\n\n");
        let dirty = file_pair(&r, Part::Uncommitted, "modified.txt").unwrap();
        assert_eq!(dirty.original, "one\ntwo\nthree\n\n\n");
        assert_eq!(dirty.modified, "one\ntwo\nthree\n\n\n\n");
        let files = changed_files(&r, Part::Uncommitted).unwrap();
        assert_eq!(file(&files, "modified.txt").added, 1);
    }

    #[test]
    fn paths_with_spaces_and_non_ascii_round_trip() {
        let (_d, r) = fixture();
        checkout(&r, "change/x", true);
        commit_file(
            &r,
            "dir with space/h\u{e9}llo w\u{f6}rld.txt",
            "hi\n",
            "add",
        );
        write(&r, "d\u{fc}r/na\u{ef}ve file.rs", "fn n() {}\n");

        let files = changed_files(&r, Part::Whole).unwrap();

        assert_eq!(
            paths(&files),
            vec![
                "dir with space/h\u{e9}llo w\u{f6}rld.txt",
                "d\u{fc}r/na\u{ef}ve file.rs"
            ]
        );
        for f in &files {
            let pair = file_pair(&r, Part::Whole, &f.path).unwrap();
            assert!(!pair.modified.is_empty(), "{}", f.path);
        }
    }
}
