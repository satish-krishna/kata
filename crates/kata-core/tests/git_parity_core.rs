//! The git2 port of the run-mode repository work must give what the git CLI gave. The reference
//! computations below are the old CLI ones, kept in the test; the test code may use the git CLI.

use kata_core::changeset::diff_at;
use kata_core::given::items::nested_claude_files;
use kata_core::worktree::create_in;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn write(dir: &Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

fn init(config: &[(&str, &str)]) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q"]);
    git(d.path(), &["config", "user.email", "t@example.com"]);
    git(d.path(), &["config", "user.name", "t"]);
    for (k, v) in config {
        git(d.path(), &["config", k, v]);
    }
    d
}

fn commit_all(d: &Path) {
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", "c"]);
}

fn lines(n: usize) -> String {
    (0..n).map(|i| format!("line {i}\n")).collect()
}

/// The old computation: `git diff HEAD --numstat` and `--name-status`, then untracked files
/// counted by reading them, in that order.
fn reference(dir: &Path) -> (Vec<(String, String)>, u32, u32) {
    let mut counts: HashMap<String, (u32, u32)> = HashMap::new();
    for line in git(dir, &["diff", "HEAD", "--numstat"]).lines() {
        let mut it = line.split('\t');
        let ins = it.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let del = it.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let path = it.next_back().unwrap_or("").to_string();
        if !path.is_empty() {
            counts.insert(path, (ins, del));
        }
    }
    let (mut files, mut ins_total, mut del_total) = (Vec::new(), 0, 0);
    for line in git(dir, &["diff", "HEAD", "--name-status"]).lines() {
        let mut it = line.split('\t');
        let status = it.next().unwrap_or("");
        let path = it.next_back().unwrap_or("").to_string();
        if status.is_empty() || path.is_empty() {
            continue;
        }
        let (i, d) = counts.get(&path).copied().unwrap_or((0, 0));
        ins_total += i;
        del_total += d;
        files.push((status.chars().next().unwrap().to_string(), path));
    }
    for path in git(dir, &["ls-files", "--others", "--exclude-standard"]).lines() {
        let i = std::fs::read_to_string(dir.join(path))
            .map(|c| c.lines().count() as u32)
            .unwrap_or(0);
        ins_total += i;
        files.push(("A".into(), path.to_string()));
    }
    (files, ins_total, del_total)
}

fn assert_diff_parity(dir: &Path) {
    let (files, ins, del) = reference(dir);
    let status_before = git(dir, &["status", "--porcelain"]);
    let index_before = std::fs::read(dir.join(".git/index")).unwrap();
    let got = diff_at(dir).unwrap();
    let got_files: Vec<(String, String)> = got
        .files
        .iter()
        .map(|f| (f.status.clone(), f.path.clone()))
        .collect();
    assert_eq!(got_files, files, "files");
    assert_eq!((got.insertions, got.deletions), (ins, del), "counts");
    assert_eq!(git(dir, &["status", "--porcelain"]), status_before);
    assert_eq!(
        std::fs::read(dir.join(".git/index")).unwrap(),
        index_before,
        "the index must be left alone"
    );
}

#[test]
fn diff_matches_the_cli_for_edits_deletes_and_untracked() {
    let d = init(&[]);
    write(d.path(), "a.txt", &lines(10));
    write(d.path(), "gone.txt", &lines(4));
    write(d.path(), "dir/b.rs", &lines(3));
    commit_all(d.path());
    write(d.path(), "a.txt", &format!("{}extra\n", &lines(8)));
    std::fs::remove_file(d.path().join("gone.txt")).unwrap();
    write(d.path(), "new/deep/c.txt", &lines(5));
    write(d.path(), "top.md", "x\ny");
    write(d.path(), "bin.dat", "\u{0}\u{0}\u{0}");
    assert_diff_parity(d.path());
}

#[test]
fn diff_matches_the_cli_for_a_staged_rename_with_an_edit() {
    let d = init(&[]);
    write(d.path(), "old.txt", &lines(20));
    commit_all(d.path());
    git(d.path(), &["mv", "old.txt", "renamed.txt"]);
    write(d.path(), "renamed.txt", &format!("{}more\n", lines(20)));
    assert_diff_parity(d.path());
    let got = diff_at(d.path()).unwrap();
    assert!(got
        .files
        .iter()
        .any(|f| f.status == "R" && f.path == "renamed.txt"));
    assert_eq!(got.insertions, 0, "rename line counts stay zero (issue #7)");
}

#[test]
fn diff_matches_the_cli_with_crlf_and_gitattributes() {
    let d = init(&[]);
    write(d.path(), ".gitattributes", "*.txt text eol=crlf\n");
    write(d.path(), "w.txt", "a\nb\nc\n");
    commit_all(d.path());
    write(d.path(), "w.txt", "a\r\nb\r\nc\r\nd\r\n");
    write(d.path(), "u.txt", "p\r\nq\r\n");
    assert_diff_parity(d.path());
}

#[test]
fn diff_matches_the_cli_with_autocrlf() {
    let d = init(&[("core.autocrlf", "true")]);
    write(d.path(), "w.txt", "a\r\nb\r\nc\r\n");
    commit_all(d.path());
    write(d.path(), "w.txt", "a\r\nb\r\nc\r\nd\r\ne\r\n");
    write(d.path(), "u.txt", "p\r\nq\r\n");
    assert_diff_parity(d.path());
}

#[test]
fn diff_matches_the_cli_with_ignored_files_a_detached_head_and_a_slash_branch() {
    let d = init(&[]);
    write(d.path(), ".gitignore", "ignored/\n*.log\n");
    write(d.path(), "k.txt", &lines(2));
    commit_all(d.path());
    git(d.path(), &["checkout", "-q", "-b", "feature/x/y"]);
    write(d.path(), "ignored/i.txt", "no\n");
    write(d.path(), "run.log", "no\n");
    write(d.path(), "k.txt", &lines(3));
    assert_diff_parity(d.path());
    git(d.path(), &["checkout", "-q", "--detach"]);
    assert_diff_parity(d.path());
}

#[test]
fn diff_leaves_staged_state_alone() {
    let d = init(&[]);
    write(d.path(), "a.txt", &lines(3));
    commit_all(d.path());
    write(d.path(), "a.txt", &lines(4));
    write(d.path(), "staged.txt", "s\n");
    git(d.path(), &["add", "staged.txt"]);
    assert_diff_parity(d.path());
}

fn reference_nested(dir: &Path) -> Vec<String> {
    let out = git(
        dir,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    );
    let mut found: Vec<String> = out
        .split('\0')
        .filter(|p| p.rsplit('/').next() == Some("CLAUDE.md"))
        .map(String::from)
        .collect();
    found.retain(|p| p != "CLAUDE.md" && p != ".claude/CLAUDE.md" && dir.join(p).is_file());
    found.sort();
    found.dedup();
    found
}

#[test]
fn nested_claude_files_match_git_ls_files() {
    let d = init(&[]);
    write(d.path(), ".gitignore", "ignored/\n");
    write(d.path(), "CLAUDE.md", "root");
    write(d.path(), "tracked/CLAUDE.md", "t");
    write(d.path(), "tracked/deeper/CLAUDE.md", "t");
    write(d.path(), ".claude/CLAUDE.md", "own");
    write(d.path(), "other.txt", "x");
    commit_all(d.path());
    write(d.path(), "fresh/CLAUDE.md", "untracked");
    write(d.path(), "fresh/more/CLAUDE.md", "untracked");
    write(d.path(), "ignored/CLAUDE.md", "ignored");
    write(d.path(), ".hidden/CLAUDE.md", "hidden");
    write(d.path(), "staged/CLAUDE.md", "staged");
    git(d.path(), &["add", "staged/CLAUDE.md"]);
    std::fs::remove_file(d.path().join("tracked/deeper/CLAUDE.md")).unwrap();
    let want = reference_nested(d.path());
    assert!(want.contains(&"fresh/CLAUDE.md".to_string()));
    assert!(!want.contains(&"ignored/CLAUDE.md".to_string()));
    assert_eq!(nested_claude_files(d.path()), want);
}

#[test]
fn worktree_is_a_separate_copy_on_its_own_branch_and_is_kept() {
    for detach in [false, true] {
        let d = init(&[]);
        write(d.path(), "k.txt", "one\n");
        commit_all(d.path());
        git(d.path(), &["checkout", "-q", "-b", "feature/a/b"]);
        if detach {
            git(d.path(), &["checkout", "-q", "--detach"]);
        }
        let root = tempfile::tempdir().unwrap();
        let wt = create_in(&d.path().to_string_lossy(), "my spec!", root.path()).unwrap();
        assert!(wt.branch.starts_with("kata/my-spec-"), "{}", wt.branch);
        let path = Path::new(&wt.path);
        assert!(path.join("k.txt").is_file());
        assert_eq!(
            git(path, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
            wt.branch
        );
        assert_eq!(
            git(path, &["rev-parse", "HEAD"]),
            git(d.path(), &["rev-parse", "HEAD"])
        );
        let list = git(d.path(), &["worktree", "list", "--porcelain"]);
        assert!(list.contains(&wt.branch), "{list}");
        assert!(git(d.path(), &["branch", "--list", &wt.branch]).contains(&wt.branch));
        // Nothing removes it: it is still there once the call has returned.
        assert!(path.is_dir());
    }
}
