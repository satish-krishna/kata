//! Parity between the typed repository reads in `kata_sdlc::git` and the answers the git command line
//! gives on the same repositories. The command line here is only the oracle: every fixture is built
//! with it and every expected answer is computed with it, the way the Workbench did before it read
//! repositories itself.
#![allow(clippy::disallowed_methods)]
use kata_sdlc::branch;
use kata_sdlc::changes::{other_change_branches, OtherBranch};
use kata_sdlc::git::{Repo, StatusEntry};
use kata_sdlc::pins;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static CLOCK: AtomicU64 = AtomicU64::new(1_700_000_000);

/// A git command line helper: runs `git -C dir args`, returns stdout, `Err` with stderr on failure.
fn cli(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let when = format!("{} +0000", CLOCK.fetch_add(60, Ordering::SeqCst));
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_DATE", &when)
        .env("GIT_COMMITTER_DATE", &when)
        .output()
        .expect("git is needed to build the fixtures");
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = cli(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"));
    String::from_utf8_lossy(&out).trim().to_string()
}

struct Fx {
    _tmp: tempfile::TempDir,
    path: PathBuf,
}

impl Fx {
    fn new() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("master");
        std::fs::create_dir_all(&path).unwrap();
        git(&path, &["init", "-q", "-b", "main"]);
        git(&path, &["config", "user.name", "Test"]);
        git(&path, &["config", "user.email", "test@example.com"]);
        git(&path, &["config", "commit.gpgsign", "false"]);
        git(&path, &["config", "core.autocrlf", "false"]);
        Fx { _tmp: tmp, path }
    }

    fn write(&self, rel: &str, bytes: &str) {
        let file = self.path.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, bytes).unwrap();
    }

    fn commit(&self, rel: &str, bytes: &str) -> String {
        self.write(rel, bytes);
        git(&self.path, &["add", "--", rel]);
        git(&self.path, &["commit", "-q", "-m", &format!("edit {rel}")]);
        git(&self.path, &["rev-parse", "HEAD"])
    }

    fn head(&self) -> String {
        git(&self.path, &["rev-parse", "HEAD"])
    }

    fn all_commits(&self) -> Vec<String> {
        git(&self.path, &["rev-list", "--all"])
            .lines()
            .map(str::to_string)
            .collect()
    }
}

const D: &str = "intent/s/c";

/// Three documents, one product file, then a mix of edits left in the working tree.
fn plain() -> Fx {
    let fx = Fx::new();
    fx.commit("README.md", "init\n");
    fx.commit(&format!("{D}/intent.md"), "intent\nno newline at the end");
    fx.commit(&format!("{D}/spec.md"), "spec\n");
    fx.commit(&format!("{D}/plan.md"), "plan\n\n");
    fx.commit(&format!("{D}/build/kata.md"), "log\n");
    fx.commit(&format!("{D}/build/review.md"), "review\n");
    fx.commit("src/lib.rs", "fn main() {}\n");
    fx.commit(".ai-sdlc.json", "{}\n");
    fx.commit("dir with space/a b.md", "x\n");
    fx.commit("caf\u{e9}.md", "unicode\n");
    // Edited in the working tree only, staged only, both, deleted, and untracked.
    fx.write(&format!("{D}/intent.md"), "intent edited\n");
    fx.write("staged.md", "staged\n");
    git(&fx.path, &["add", "staged.md"]);
    fx.write(&format!("{D}/spec.md"), "spec staged\n");
    git(&fx.path, &["add", "--", &format!("{D}/spec.md")]);
    fx.write(&format!("{D}/spec.md"), "spec staged and edited\n");
    std::fs::remove_file(fx.path.join(format!("{D}/plan.md"))).unwrap();
    fx.write(&format!("{D}/new.md"), "untracked\n");
    fx.write("untracked dir/deep/one.md", "1\n");
    fx.write("untracked dir/two.md", "2\n");
    fx
}

fn renamed() -> Fx {
    let fx = Fx::new();
    fx.commit("README.md", "init\n");
    fx.commit(
        &format!("{D}/spec.md"),
        "a spec with enough text\nto be recognized\nas a rename\n",
    );
    fx.commit(
        &format!("{D}/plan.md"),
        "a plan with enough text\nto be recognized\nas a rename\n",
    );
    fx.commit("keep.md", "keep\n");
    git(
        &fx.path,
        &["mv", &format!("{D}/spec.md"), &format!("{D}/spec2.md")],
    );
    git(&fx.path, &["commit", "-q", "-m", "rename"]);
    // A staged rename, a staged rename with an edit, and an unstaged move.
    git(
        &fx.path,
        &["mv", &format!("{D}/plan.md"), &format!("{D}/plan2.md")],
    );
    fx.write(
        &format!("{D}/plan2.md"),
        "a plan with enough text\nto be recognized\nas a rename, edited\n",
    );
    std::fs::rename(fx.path.join("keep.md"), fx.path.join("kept.md")).unwrap();
    fx
}

fn crlf_attributes() -> Fx {
    let fx = Fx::new();
    fx.write(".gitattributes", "*.md text eol=crlf\n*.txt text eol=lf\n");
    fx.write(&format!("{D}/intent.md"), "one\r\ntwo\r\n");
    fx.write("notes.txt", "a\nb\n");
    git(&fx.path, &["add", "-A"]);
    git(&fx.path, &["commit", "-q", "-m", "crlf"]);
    fx.write(&format!("{D}/spec.md"), "spec\r\nline\r\n");
    git(&fx.path, &["add", "-A"]);
    git(&fx.path, &["commit", "-q", "-m", "spec"]);
    // One document is edited, the other is rewritten with the same content.
    fx.write(&format!("{D}/intent.md"), "one\r\ntwo\r\nthree\r\n");
    fx.write("notes.txt", "a\nb\n");
    fx
}

fn autocrlf() -> Fx {
    let fx = Fx::new();
    git(&fx.path, &["config", "core.autocrlf", "true"]);
    fx.write(&format!("{D}/intent.md"), "one\r\ntwo\r\n");
    fx.write(&format!("{D}/spec.md"), "spec\nlf only\n");
    git(&fx.path, &["add", "-A"]);
    git(&fx.path, &["commit", "-q", "-m", "crlf"]);
    fx.write(&format!("{D}/plan.md"), "plan\r\n");
    git(&fx.path, &["add", "-A"]);
    git(&fx.path, &["commit", "-q", "-m", "plan"]);
    // The spec gets CRLF line ends only; the plan is edited for real.
    fx.write(&format!("{D}/spec.md"), "spec\r\nlf only\r\n");
    fx.write(&format!("{D}/plan.md"), "plan\r\nmore\r\n");
    fx
}

fn detached() -> Fx {
    let fx = plain();
    git(&fx.path, &["stash", "-q", "-u"]);
    git(&fx.path, &["checkout", "-q", "--detach", "HEAD~2"]);
    fx
}

fn branches() -> Fx {
    let fx = Fx::new();
    fx.commit("README.md", "init\n");
    for name in [
        "change/a",
        "change/2026-10-26-fast",
        "change/pending-20261026",
        "feature/change/x",
        "release/1.0",
    ] {
        git(&fx.path, &["branch", name]);
    }
    git(&fx.path, &["checkout", "-q", "change/a"]);
    fx
}

fn master_branch() -> Fx {
    let fx = Fx::new();
    git(&fx.path, &["branch", "-m", "main", "master"]);
    fx.commit("README.md", "init\n");
    fx
}

fn unborn() -> Fx {
    let fx = Fx::new();
    fx.write("README.md", "init\n");
    fx
}

/// History with merges, for `count_since`. Product changes are `src/*`, the rest is excluded.
fn merges() -> Fx {
    let fx = Fx::new();
    fx.commit("README.md", "init\n");
    fx.commit("intent/s/c/intent.md", "1\n");
    fx.commit("src/a.rs", "a\n");
    git(&fx.path, &["checkout", "-q", "-b", "side", "HEAD~1"]);
    fx.commit("src/b.rs", "b\n");
    fx.commit("intent/s/c/spec.md", "s\n");
    git(&fx.path, &["checkout", "-q", "main"]);
    // A merge that differs from both parents.
    git(
        &fx.path,
        &["merge", "-q", "--no-ff", "-m", "merge side", "side"],
    );
    // A merge that changes nothing the filter sees against its first parent.
    git(&fx.path, &["checkout", "-q", "-b", "docs", "HEAD"]);
    fx.commit("intent/s/c/plan.md", "p\n");
    git(&fx.path, &["checkout", "-q", "main"]);
    fx.commit("src/c.rs", "c\n");
    git(
        &fx.path,
        &["merge", "-q", "--no-ff", "-m", "merge docs", "docs"],
    );
    // A merge whose tree equals its second parent's, built by hand.
    let side_tip = fx.commit("src/d.rs", "d\n");
    fx.commit("src/e.rs", "e\n");
    let main_tip = fx.head();
    let tree = git(&fx.path, &["rev-parse", &format!("{side_tip}^{{tree}}")]);
    let merge = git(
        &fx.path,
        &[
            "commit-tree",
            &tree,
            "-p",
            &main_tip,
            "-p",
            &side_tip,
            "-m",
            "tree of the second parent",
        ],
    );
    git(&fx.path, &["reset", "-q", "--hard", &merge]);
    fx.commit("src/f.rs", "f\n");
    fx.commit("README.md", "changed\n");
    // An empty merge-like commit and a commit that only touches excluded paths.
    fx.commit(".ai-sdlc.json", "{}\n");
    fx
}

/// A history shaped by a fixed pseudo-random sequence: commits on several tips, and merges built by
/// hand from the merged tree, so that merges that change nothing for a path filter occur on either
/// side of every cut-off.
fn random_history(seed: u64) -> Fx {
    let fx = Fx::new();
    fx.commit("README.md", "init\n");
    let first = fx.head();
    let mut tips = vec![first.clone(), first];
    let mut state = seed;
    let mut next = move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as usize
    };
    let files = [
        "src/a.rs",
        "src/b.rs",
        "intent/s/c/x.md",
        "README.md",
        ".ai-sdlc.json",
    ];
    for step in 0..40 {
        let pick = next() % tips.len();
        if next() % 3 != 0 || tips.len() < 2 {
            git(&fx.path, &["checkout", "-q", "--detach", &tips[pick]]);
            let file = files[next() % files.len()];
            let tip = fx.commit(file, &format!("step {step}\n"));
            if next() % 4 == 0 {
                tips.push(tip);
            } else {
                tips[pick] = tip;
            }
        } else {
            let mut other = next() % tips.len();
            if other == pick {
                other = (other + 1) % tips.len();
            }
            let Ok(tree) = cli(
                &fx.path,
                &["merge-tree", "--write-tree", &tips[pick], &tips[other]],
            ) else {
                continue;
            };
            let tree = String::from_utf8_lossy(&tree).trim().to_string();
            let merge = git(
                &fx.path,
                &[
                    "commit-tree",
                    &tree,
                    "-p",
                    &tips[pick],
                    "-p",
                    &tips[other],
                    "-m",
                    "merge",
                ],
            );
            tips[pick] = merge;
            tips.remove(other);
        }
    }
    // Join what is left so that every commit is reachable from HEAD.
    let mut joined = tips[0].clone();
    for tip in &tips[1..] {
        let tree = git(&fx.path, &["rev-parse", &format!("{joined}^{{tree}}")]);
        joined = git(
            &fx.path,
            &["commit-tree", &tree, "-p", &joined, "-p", tip, "-m", "join"],
        );
    }
    git(&fx.path, &["checkout", "-q", "-B", "main", &joined]);
    fx
}

fn all_fixtures() -> Vec<(&'static str, Fx)> {
    vec![
        ("plain", plain()),
        ("renamed", renamed()),
        ("crlf attributes", crlf_attributes()),
        ("autocrlf", autocrlf()),
        ("detached", detached()),
        ("branches", branches()),
        ("master branch", master_branch()),
        ("merges", merges()),
        ("random history 1", random_history(1)),
        ("random history 2", random_history(7)),
        ("random history 3", random_history(42)),
        ("unborn", unborn()),
    ]
}

fn candidate_paths() -> Vec<String> {
    let mut rels: Vec<String> = [
        "README.md",
        "intent/s/c/intent.md",
        "intent/s/c/spec.md",
        "intent/s/c/plan.md",
        "intent/s/c/spec2.md",
        "intent/s/c/plan2.md",
        "intent/s/c/new.md",
        "intent/s/c/build/kata.md",
        "intent/s/c/build/review.md",
        "intent/s/c/missing.md",
        "intent/s/c/build/missing.md",
        "src/lib.rs",
        "src/a.rs",
        "staged.md",
        "keep.md",
        "kept.md",
        "notes.txt",
        ".ai-sdlc.json",
        "dir with space/a b.md",
        "caf\u{e9}.md",
        "untracked dir/two.md",
        "nothing/at/all.md",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    rels.sort();
    rels
}

fn open(fx: &Fx) -> Repo {
    Repo::open(&fx.path).unwrap()
}

#[test]
fn documents_committed_bytes_equal_git_show() {
    for (name, fx) in all_fixtures() {
        let repo = open(&fx);
        for rel in candidate_paths() {
            let want = cli(&fx.path, &["cat-file", "blob", &format!("HEAD:{rel}")]);
            let shown = cli(&fx.path, &["show", &format!("HEAD:{rel}")]);
            let got = repo.committed_bytes(&rel);
            match (&shown, &got) {
                (Ok(shown), Ok(Some(got))) => assert_eq!(shown, got, "{name}: {rel}"),
                (Err(_), Ok(None)) => {
                    assert!(want.is_err(), "{name}: {rel}");
                }
                (Err(_), Err(_)) if name == "unborn" => {}
                other => panic!("{name}: {rel}: git {shown:?} / typed {other:?}"),
            }
        }
    }
}

#[test]
fn documents_tree_names_equal_ls_tree() {
    let dirs = [
        "intent/s/c/",
        "intent/s/c/build/",
        "intent/s/c/missing/",
        "intent/",
        "dir with space/",
        "intent/s/c/spec.md",
        "intent/s/c/nothing.md",
        "src/",
        "caf\u{e9}.md",
    ];
    for (name, fx) in all_fixtures() {
        let repo = open(&fx);
        for dir in dirs {
            let want = cli(
                &fx.path,
                &["ls-tree", "-z", "--name-only", "HEAD", "--", dir],
            );
            let got = repo.tree_names(dir);
            match (want, got) {
                (Ok(out), Ok(names)) => {
                    let want: Vec<String> = out
                        .split(|b| *b == 0)
                        .filter(|p| !p.is_empty())
                        .map(|p| String::from_utf8_lossy(p).into_owned())
                        .collect();
                    assert_eq!(want, names, "{name}: {dir}");
                }
                (Err(_), Err(_)) => {}
                (want, got) => panic!("{name}: {dir}: git {want:?} / typed {got:?}"),
            }
        }
    }
}

#[test]
fn documents_is_committed_equals_ls_files_and_status() {
    for (name, fx) in all_fixtures() {
        let repo = open(&fx);
        for rel in candidate_paths() {
            let tracked = cli(&fx.path, &["ls-files", "--error-unmatch", "--", &rel]).is_ok();
            let clean = cli(&fx.path, &["status", "--porcelain", "--", &rel])
                .map(|out| out.is_empty())
                .unwrap_or(false);
            assert_eq!(repo.is_committed(&rel), tracked && clean, "{name}: {rel}");
        }
    }
}

/// Parses `git status --porcelain=v1 -uall -z`.
fn cli_status(dir: &Path, under: &str) -> Result<Vec<StatusEntry>, String> {
    let mut args = vec!["status", "--porcelain=v1", "-uall", "-z"];
    if !under.is_empty() {
        args.push("--");
        args.push(under);
    }
    let out = cli(dir, &args)?;
    let mut parts = out
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned());
    let mut entries = Vec::new();
    while let Some(entry) = parts.next() {
        let mut chars = entry.chars();
        let index = chars.next().unwrap();
        let worktree = chars.next().unwrap();
        let path: String = entry.chars().skip(3).collect();
        let from = if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
            parts.next()
        } else {
            None
        };
        entries.push(StatusEntry {
            path,
            index,
            worktree,
            from,
        });
    }
    Ok(entries)
}

#[test]
fn documents_status_equals_porcelain() {
    let unders = [
        "",
        "intent/s/c",
        "intent/s/c/",
        "intent",
        "src",
        "untracked dir",
        "nothing",
    ];
    for (name, fx) in all_fixtures() {
        let repo = open(&fx);
        for under in unders {
            let want = cli_status(&fx.path, under);
            let got = repo.status(under);
            match (want, got) {
                (Ok(want), Ok(got)) => assert_eq!(want, got, "{name}: under {under:?}"),
                (Err(_), Err(_)) => {}
                (want, got) => panic!("{name}: {under:?}: git {want:?} / typed {got:?}"),
            }
        }
    }
}

#[test]
fn documents_status_leaves_the_index_alone() {
    let fx = plain();
    let index = fx.path.join(".git/index");
    let before = std::fs::read(&index).unwrap();
    let repo = open(&fx);
    repo.status("").unwrap();
    let _ = repo.is_committed("README.md");
    assert!(!fx.path.join(".git/index.lock").exists());
    assert_eq!(before, std::fs::read(&index).unwrap());
}

#[test]
fn documents_pin_holds_equals_git_diff_quiet() {
    for (name, fx) in all_fixtures() {
        let repo = open(&fx);
        let mut pins_to_try: Vec<String> = fx.all_commits();
        pins_to_try.extend(
            [
                "",
                "-x",
                "--output=pinned.txt",
                "deadbeef",
                "HEAD",
                "main",
                "0000000",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        for pin in &pins_to_try {
            for rel in candidate_paths() {
                let valid = !pin.is_empty() && !pin.starts_with('-');
                let want =
                    valid && cli(&fx.path, &["diff", "--quiet", pin, "HEAD", "--", &rel]).is_ok();
                let got = pins::holds(&repo, Some(pin), &rel);
                assert_eq!(want, got, "{name}: pin {pin:?} {rel}");
            }
        }
        assert!(!pins::holds(&repo, None, "README.md"), "{name}");
        assert!(!fx.path.join("pinned.txt").exists());
    }
}

#[test]
fn documents_count_since_equals_rev_list_count() {
    for (name, fx) in all_fixtures() {
        let repo = open(&fx);
        let mut shas = fx.all_commits();
        shas.push("deadbeef".to_string());
        for sha in &shas {
            let range = format!("{sha}..HEAD");
            let want = cli(
                &fx.path,
                &[
                    "rev-list",
                    "--count",
                    &range,
                    "--",
                    ".",
                    ":(exclude)intent",
                    ":(exclude).ai-sdlc.json",
                ],
            )
            .map(|out| String::from_utf8_lossy(&out).trim().parse::<u32>().unwrap());
            let got = repo.count_since(sha, &["."], &["intent", ".ai-sdlc.json"]);
            match (want, got) {
                (Ok(want), Ok(got)) => assert_eq!(want, got, "{name}: {sha}"),
                (Err(_), Err(_)) => {}
                (want, got) => panic!("{name}: {sha}: git {want:?} / typed {got:?}"),
            }
            // The listing and the count are the same walk.
            if let (Ok(count), Ok(listed)) = (
                repo.count_since(sha, &["src"], &[]),
                repo.commits_since(sha, "src"),
            ) {
                assert_eq!(count as usize, listed.len(), "{name}: {sha}");
                let want = cli(&fx.path, &["rev-list", &range, "--", "src"]).unwrap();
                let want: Vec<String> = String::from_utf8_lossy(&want)
                    .lines()
                    .map(str::to_string)
                    .collect();
                let mut a = want.clone();
                let mut b = listed.clone();
                a.sort();
                b.sort();
                assert_eq!(a, b, "{name}: {sha} listing");
            }
        }
    }
}

#[test]
fn documents_blob_ids_and_head_equal_rev_parse() {
    for (name, fx) in all_fixtures() {
        let repo = open(&fx);
        if name != "unborn" {
            assert_eq!(repo.head_sha().unwrap(), fx.head(), "{name}");
        } else {
            assert!(repo.head_sha().is_err());
        }
        for rev in ["HEAD", "main"] {
            for rel in candidate_paths() {
                let want = cli(&fx.path, &["rev-parse", &format!("{rev}:{rel}")])
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o).trim().to_string());
                let valid = cli(&fx.path, &["rev-parse", "--verify", "-q", rev]).is_ok();
                match repo.blob_id_at(rev, &rel) {
                    Ok(got) => assert_eq!(want, got, "{name}: {rev}:{rel}"),
                    Err(_) => assert!(!valid, "{name}: {rev}:{rel}"),
                }
            }
        }
    }
}

#[test]
fn documents_branch_reads_equal_the_cli() {
    for (name, fx) in all_fixtures() {
        let cur = cli(&fx.path, &["rev-parse", "--verify", "-q", "HEAD"])
            .ok()
            .and_then(|_| cli(&fx.path, &["symbolic-ref", "--short", "-q", "HEAD"]).ok())
            .map(|o| String::from_utf8_lossy(&o).trim().to_string())
            .filter(|b| !b.is_empty());
        assert_eq!(branch::current_branch(&fx.path), cur, "{name}");
        for b in [
            "main",
            "master",
            "change/a",
            "change/",
            "nope",
            "feature/change/x",
        ] {
            let want = cli(
                &fx.path,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{b}"),
                ],
            )
            .is_ok();
            assert_eq!(branch::branch_exists(&fx.path, b), want, "{name}: {b}");
        }
        let default = ["main", "master"]
            .into_iter()
            .find(|b| {
                cli(
                    &fx.path,
                    &[
                        "rev-parse",
                        "--verify",
                        "--quiet",
                        &format!("refs/heads/{b}"),
                    ],
                )
                .is_ok()
            })
            .map(str::to_string)
            .or(cur.clone());
        assert_eq!(branch::default_base(&fx.path), default, "{name}");
        let listed = cli(
            &fx.path,
            &["branch", "--list", "change/*", "--format=%(refname:short)"],
        )
        .map(|o| String::from_utf8_lossy(&o).into_owned())
        .unwrap_or_default();
        let others: Vec<OtherBranch> = listed
            .lines()
            .map(str::trim)
            .filter(|b| !b.is_empty() && Some(*b) != cur.as_deref())
            .filter_map(|b| b.strip_prefix("change/"))
            .filter(|b| !b.starts_with("pending-"))
            .map(|c| OtherBranch {
                branch: format!("change/{c}"),
                change: c.to_string(),
                needs_name: false,
            })
            .collect();
        assert_eq!(other_change_branches(&fx.path), others, "{name}");
    }
}

// ---------------------------------------------------------------------------------------------
// Comparisons: what changed on a change branch, which commits break the commit rules, the base
// branch of each repository, which repositories a change touched. The expected answers are
// computed with the command line the way the Workbench did before it read repositories itself.
// ---------------------------------------------------------------------------------------------

use kata_sdlc::base::{self, BaseError};
use kata_sdlc::commits;
use kata_sdlc::diff::{self, ChangeStatus, ChangedFile, FilePair, Part};
use kata_sdlc::publish;
use kata_sdlc::snapshot;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches(['\n', '\r'])
        .to_string()
}

fn cli_env(dir: &Path, args: &[&str], env: &[(&str, &OsStr)]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("git is needed for the oracle");
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn cli_ok(dir: &Path, rev: &str) -> bool {
    cli(dir, &["rev-parse", "--verify", "--quiet", rev]).is_ok()
}

/// A bare origin beside the repository, with the current branch pushed; `head` also sets
/// `refs/remotes/origin/HEAD`.
fn add_origin(fx: &Fx, head: bool) {
    let bare = fx.path.with_file_name(format!(
        "{}-origin.git",
        fx.path.file_name().unwrap().to_string_lossy()
    ));
    let parent = fx.path.parent().unwrap();
    git(parent, &["init", "-q", "--bare", bare.to_str().unwrap()]);
    git(
        &fx.path,
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    let current = git(&fx.path, &["rev-parse", "--abbrev-ref", "HEAD"]);
    git(&fx.path, &["push", "-q", "origin", &current]);
    git(&fx.path, &["fetch", "-q", "origin"]);
    if head {
        git(&fx.path, &["remote", "set-head", "origin", &current]);
    }
}

/// The base of a repository as the old code worked it out: `(base, reference, merge base)`.
fn cli_base(dir: &Path, rev: &str) -> Option<(String, String, String)> {
    let from_origin = cli(
        dir,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .and_then(|t| {
        text(&t)
            .strip_prefix("refs/remotes/origin/")
            .map(str::to_string)
    });
    let base = from_origin
        .into_iter()
        .chain(["main", "master"].map(String::from))
        .find(|b| {
            cli_ok(dir, &format!("refs/heads/{b}"))
                || cli_ok(dir, &format!("refs/remotes/origin/{b}"))
        })?;
    let remote = format!("origin/{base}");
    let reference = if cli_ok(dir, &format!("refs/remotes/{remote}")) {
        remote
    } else {
        base.clone()
    };
    let merge_base = text(&cli(dir, &["merge-base", rev, &reference]).ok()?);
    Some((base, reference, merge_base))
}

/// Revision arguments naming the work on a change branch, the old way.
fn cli_work_revs(dir: &Path, rev: &str) -> Option<Vec<String>> {
    let (base, ..) = cli_base(dir, rev)?;
    let mut revs = vec![rev.to_string()];
    if cli_ok(dir, &format!("refs/heads/{base}")) {
        revs.push(format!("^{base}"));
    }
    if cli_ok(dir, &format!("refs/remotes/origin/{base}")) {
        revs.push(format!("^origin/{base}"));
    }
    Some(revs)
}

fn cli_count(dir: &Path, revs: &[String]) -> u32 {
    let mut args = vec!["rev-list", "--count"];
    args.extend(revs.iter().map(String::as_str));
    text(&cli(dir, &args).unwrap()).parse().unwrap()
}

/// Fixtures with a remote added in each way, for the base branch.
fn base_fixtures() -> Vec<(String, Fx)> {
    let mut all: Vec<(String, Fx)> = all_fixtures()
        .into_iter()
        .map(|(n, f)| (n.to_string(), f))
        .collect();
    for (name, head) in [("origin with head", true), ("origin without head", false)] {
        let fx = Fx::new();
        fx.commit("README.md", "init\n");
        add_origin(&fx, head);
        git(&fx.path, &["checkout", "-q", "-b", "change/x"]);
        fx.commit("a.txt", "a\n");
        fx.commit("b.txt", "b\n");
        git(&fx.path, &["checkout", "-q", "main"]);
        fx.commit("local-only.txt", "l\n");
        git(&fx.path, &["checkout", "-q", "change/x"]);
        all.push((name.to_string(), fx));
    }
    // origin/HEAD naming a branch that is not main or master.
    let fx = Fx::new();
    fx.commit("README.md", "init\n");
    git(&fx.path, &["branch", "-m", "main", "trunk"]);
    add_origin(&fx, true);
    git(&fx.path, &["checkout", "-q", "-b", "change/x"]);
    fx.commit("a.txt", "a\n");
    all.push(("trunk".to_string(), fx));
    // Others' commits reached origin/main and the change was rebased onto them.
    let fx = Fx::new();
    fx.commit("README.md", "init\n");
    add_origin(&fx, false);
    git(&fx.path, &["checkout", "-q", "-b", "change/x"]);
    fx.commit("c.txt", "c\n");
    git(&fx.path, &["checkout", "-q", "main"]);
    fx.commit("others.txt", "o\n");
    git(&fx.path, &["push", "-q", "origin", "main"]);
    git(&fx.path, &["reset", "-q", "--hard", "HEAD~1"]);
    git(&fx.path, &["checkout", "-q", "change/x"]);
    git(&fx.path, &["rebase", "-q", "origin/main"]);
    all.push(("rebased".to_string(), fx));
    all
}

#[test]
fn comparisons_git_reads_equal_the_cli() {
    for (name, fx) in base_fixtures() {
        let repo = open(&fx);
        let dir = &fx.path;
        let symbolic = cli(
            dir,
            &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        )
        .ok()
        .map(|o| text(&o));
        assert_eq!(
            repo.symbolic_target("refs/remotes/origin/HEAD"),
            symbolic,
            "{name}: symbolic_target"
        );
        assert_eq!(repo.symbolic_target("refs/heads/main"), None, "{name}");
        for rev in [
            "HEAD",
            "main",
            "master",
            "trunk",
            "origin/main",
            "refs/heads/main",
            "refs/remotes/origin/main",
            "refs/remotes/origin/trunk",
            "change/x",
            "nope",
        ] {
            assert_eq!(repo.rev_exists(rev), cli_ok(dir, rev), "{name}: {rev}");
            let want = cli(dir, &["rev-parse", rev]).ok().map(|o| text(&o));
            assert_eq!(repo.resolve(rev).ok(), want, "{name}: resolve {rev}");
        }
        for other in [
            "main",
            "master",
            "trunk",
            "origin/main",
            "refs/heads/change/x",
        ] {
            let want = cli(dir, &["merge-base", "HEAD", other])
                .ok()
                .map(|o| text(&o));
            assert_eq!(
                repo.merge_base("HEAD", other).ok(),
                want,
                "{name}: merge-base HEAD {other}"
            );
            if let Some(mb) = want {
                let range = format!("{mb}..HEAD");
                let listed: Vec<String> = text(&cli(dir, &["rev-list", &range]).unwrap())
                    .lines()
                    .map(str::to_string)
                    .collect();
                assert_eq!(
                    repo.revs_between(&mb, "HEAD").unwrap(),
                    listed,
                    "{name}: {range}"
                );
            }
        }
        if cli_ok(dir, "HEAD") {
            for revs in [
                vec!["HEAD".to_string()],
                vec!["HEAD".into(), "^main".into()],
                vec!["HEAD".into(), "^HEAD~1".into()],
                vec!["HEAD~1..HEAD".into()],
            ] {
                let mut args = vec!["rev-list"];
                args.extend(revs.iter().map(String::as_str));
                let Ok(out) = cli(dir, &args) else {
                    assert!(repo.rev_list(&revs).is_err(), "{name}: {revs:?}");
                    continue;
                };
                let want: Vec<String> = text(&out).lines().map(str::to_string).collect();
                assert_eq!(repo.rev_list(&revs).unwrap(), want, "{name}: {revs:?}");
                // log_messages: the short id and the message, commit by commit.
                let mut args = vec!["log", "--format=%h%x1f%B%x1e"];
                args.extend(revs.iter().map(String::as_str));
                let log = text(&cli(dir, &args).unwrap());
                let want: Vec<(String, String)> = log
                    .split('\x1e')
                    .filter_map(|rec| {
                        let (hash, message) = rec.trim_start_matches('\n').split_once('\x1f')?;
                        Some((hash.to_string(), message.trim_end().to_string()))
                    })
                    .collect();
                let got: Vec<(String, String)> = repo
                    .log_messages(&revs)
                    .unwrap()
                    .into_iter()
                    .map(|e| (e.short, e.message.trim_end().to_string()))
                    .collect();
                assert_eq!(got, want, "{name}: log {revs:?}");
                // commit_files: each commit's files, oldest first, one diff-tree per commit.
                let mut args = vec!["rev-list", "--reverse"];
                args.extend(revs.iter().map(String::as_str));
                let shas: Vec<String> = text(&cli(dir, &args).unwrap())
                    .lines()
                    .map(str::to_string)
                    .collect();
                let want: Vec<(String, Vec<String>)> = shas
                    .iter()
                    .map(|sha| {
                        let out = cli(
                            dir,
                            &[
                                "diff-tree",
                                "--root",
                                "--no-commit-id",
                                "--name-only",
                                "-r",
                                "--no-renames",
                                "-z",
                                sha,
                            ],
                        )
                        .unwrap();
                        let mut files: Vec<String> = out
                            .split(|b| *b == 0)
                            .filter(|t| !t.is_empty())
                            .map(|t| String::from_utf8_lossy(t).into_owned())
                            .collect();
                        files.sort();
                        files.dedup();
                        (sha.clone(), files)
                    })
                    .collect();
                assert_eq!(
                    repo.commit_files(&revs).unwrap(),
                    want,
                    "{name}: files {revs:?}"
                );
            }
        }
        let url = cli(dir, &["remote", "get-url", "origin"])
            .ok()
            .map(|o| text(&o));
        assert_eq!(repo.remote_url("origin"), url, "{name}: remote_url");
    }
}

#[test]
fn comparisons_remote_url_applies_url_rewrites() {
    let fx = Fx::new();
    fx.commit("README.md", "init\n");
    git(&fx.path, &["remote", "add", "origin", "gh:acme/app.git"]);
    git(
        &fx.path,
        &["config", "url.https://github.com/.insteadOf", "gh:"],
    );
    git(
        &fx.path,
        &[
            "config",
            "url.ssh://push/.pushInsteadOf",
            "https://github.com/",
        ],
    );
    let want = text(&cli(&fx.path, &["remote", "get-url", "origin"]).unwrap());
    assert_eq!(want, "https://github.com/acme/app.git");
    assert_eq!(
        open(&fx).remote_url("origin").as_deref(),
        Some(want.as_str())
    );
    assert_eq!(open(&fx).remote_url("nope"), None);
}

#[test]
fn comparisons_hash_of_equals_hash_object() {
    for (name, fx) in all_fixtures() {
        let repo = open(&fx);
        for rel in candidate_paths() {
            let on_disk = fx.path.join(&rel).is_file();
            let want = cli(&fx.path, &["hash-object", "--", &rel])
                .ok()
                .map(|o| text(&o));
            assert_eq!(on_disk, want.is_some(), "{name}: {rel}");
            assert_eq!(repo.hash_file(&rel).ok(), want, "{name}: hash_file {rel}");
            let expected = want.clone().unwrap_or_default();
            assert_eq!(
                snapshot::hash_of(&fx.path, &rel).unwrap(),
                expected,
                "{name}: hash_of {rel}"
            );
        }
    }
    // Content with CRLF under each way a clean filter is chosen.
    for mode in ["true", "input", "false"] {
        let fx = Fx::new();
        git(&fx.path, &["config", "core.autocrlf", mode]);
        fx.write("crlf.txt", "a\r\nb\r\n");
        fx.write("lf.txt", "a\nb\n");
        fx.write("mixed.txt", "a\r\nb\nc\r\n");
        fx.write("bin.dat", "a\0b\r\n");
        for rel in ["crlf.txt", "lf.txt", "mixed.txt", "bin.dat"] {
            let want = text(&cli(&fx.path, &["hash-object", "--", rel]).unwrap());
            assert_eq!(
                snapshot::hash_of(&fx.path, rel).unwrap(),
                want,
                "autocrlf={mode}: {rel}"
            );
        }
    }
    let fx = Fx::new();
    fx.write(
        ".gitattributes",
        "*.a text eol=crlf\n*.b text eol=lf\n*.c -text\n*.d binary\n",
    );
    for rel in ["x.a", "x.b", "x.c", "x.d"] {
        fx.write(rel, "one\r\ntwo\nthree\r\n");
        let want = text(&cli(&fx.path, &["hash-object", "--", rel]).unwrap());
        assert_eq!(
            snapshot::hash_of(&fx.path, rel).unwrap(),
            want,
            "attributes: {rel}"
        );
    }
}

#[test]
fn comparisons_base_branch_and_commits_ahead() {
    for (name, fx) in base_fixtures() {
        let dir = &fx.path;
        let want = cli_base(dir, "HEAD");
        match base::base_info(dir) {
            Ok(info) => {
                let (b, r, m) = want
                    .clone()
                    .unwrap_or_else(|| panic!("{name}: typed ok, cli not"));
                assert_eq!(
                    (info.base, info.reference, info.merge_base),
                    (b, r, m),
                    "{name}"
                );
            }
            Err(e) => assert!(want.is_none(), "{name}: typed {e}, cli {want:?}"),
        }
        if let Some((b, ..)) = &want {
            assert_eq!(base::base_branch(dir).as_ref(), Some(b), "{name}");
        }
        match (&want, base::commits_ahead(dir)) {
            (Some((_, _, mb)), Ok(n)) => {
                assert_eq!(n, cli_count(dir, &[format!("{mb}..HEAD")]), "{name}: ahead");
            }
            (None, Err(_)) => {}
            (w, g) => panic!("{name}: commits_ahead cli {w:?} typed {g:?}"),
        }
        if let Some(revs) = cli_work_revs(dir, "HEAD") {
            assert_eq!(
                base::build_work_revs(dir, "HEAD").unwrap(),
                revs,
                "{name}: work revs"
            );
            assert_eq!(
                base::commits_ahead_of_local_base(dir, "HEAD").unwrap(),
                cli_count(dir, &revs),
                "{name}: ahead of local base"
            );
        } else {
            assert!(
                base::commits_ahead_of_local_base(dir, "HEAD").is_err(),
                "{name}"
            );
        }
    }
    let _ = BaseError::Unresolved(String::new());
}

// ---- what changed on a change branch ----

/// A repository on `change/x` with every kind of change in all three parts.
fn change_branch(origin: bool, autocrlf: bool) -> Fx {
    let fx = Fx::new();
    fx.write(".gitignore", "*.log\n");
    fx.write("a.txt", "one\ntwo\nthree\nfour\nfive\n");
    fx.write("mod.txt", "m1\nm2\nm3\nm4\n");
    fx.write("del.txt", "gone\nsoon\n");
    fx.write("keepdel.txt", "keep\n");
    fx.write("empty.txt", "");
    fx.write("ren_src.md", "r1\nr2\nr3\nr4\nr5\nr6\nr7\nr8\n");
    fx.write("mv_src.md", "v1\nv2\nv3\nv4\nv5\nv6\nv7\nv8\n");
    fx.write("bin.dat", "bin\0one\n");
    fx.write("crlf.txt", "c1\r\nc2\r\nc3\r\n");
    fx.write("sp ace/\u{e9}.md", "u1\nu2\n");
    git(&fx.path, &["add", "-A"]);
    git(&fx.path, &["commit", "-q", "-m", "base"]);
    if origin {
        add_origin(&fx, true);
    }
    git(&fx.path, &["checkout", "-q", "-b", "change/x"]);
    fx.commit("mod.txt", "m1\nm2 changed\nm3\nm4\nm5\n");
    fx.commit("new.txt", "n1\nn2\n");
    fx.commit("bin2.dat", "\0\0\0");
    fx.commit("bin.dat", "bin\0two\nmore\n");
    fx.commit("crlf.txt", "c1\r\nc2 edit\r\nc3\r\n");
    fx.commit("sp ace/\u{e9}.md", "u1\nu2\nu3\n");
    git(&fx.path, &["rm", "-q", "del.txt"]);
    git(&fx.path, &["mv", "ren_src.md", "ren_dst.md"]);
    fx.write("ren_dst.md", "r1\nr2\nr3\nr4\nr5\nr6\nr7\nr8 edited\n");
    git(&fx.path, &["add", "-A"]);
    git(&fx.path, &["commit", "-q", "-m", "delete and rename"]);
    // main moves on, so the merge base is not main's tip.
    git(&fx.path, &["checkout", "-q", "main"]);
    fx.commit("main_only.txt", "main\n");
    git(&fx.path, &["checkout", "-q", "change/x"]);
    if autocrlf {
        git(&fx.path, &["config", "core.autocrlf", "true"]);
    }
    // Working tree: committed and edited again, edited only, staged only, untracked (text, binary,
    // empty, nested, ignored), deleted, a staged rename, an unstaged move.
    fx.write("mod.txt", "m1\nm2 changed\nm3\nm4\nm5\nm6\n");
    fx.write("a.txt", "one\ntwo changed\nthree\nfour\nfive\nsix\n");
    fx.write("staged.txt", "s1\ns2\n");
    git(&fx.path, &["add", "staged.txt"]);
    fx.write("u.txt", "u1\nu2\nu3\n");
    fx.write("ub.bin", "x\0y");
    fx.write("empty_new.txt", "");
    fx.write("deep/er/f.md", "deep\n");
    fx.write("skip.log", "ignored\n");
    std::fs::remove_file(fx.path.join("keepdel.txt")).unwrap();
    std::fs::rename(fx.path.join("mv_src.md"), fx.path.join("mv_dst.md")).unwrap();
    fx.write("crlf.txt", "c1\r\nc2 edit\r\nc3\r\nc4\r\n");
    git(&fx.path, &["mv", "empty.txt", "moved_empty.txt"]);
    fx
}

fn diff_fixtures() -> Vec<(&'static str, Fx)> {
    let mut all = vec![
        ("local base", change_branch(false, false)),
        ("origin base", change_branch(true, false)),
        ("autocrlf", change_branch(false, true)),
        ("clean", {
            let fx = change_branch(false, false);
            git(&fx.path, &["add", "-A"]);
            git(&fx.path, &["commit", "-q", "-m", "all in"]);
            fx
        }),
    ];
    // Nothing changed at all, and a history with no merge base.
    let fx = Fx::new();
    fx.commit("README.md", "init\n");
    all.push(("no change", fx));
    let fx = Fx::new();
    fx.commit("README.md", "init\n");
    git(&fx.path, &["checkout", "-q", "--orphan", "other"]);
    fx.commit("x.md", "x\n");
    all.push(("unrelated history", fx));
    all.push(("unborn", unborn()));
    all
}

fn left_of(dir: &Path, part: Part) -> Option<String> {
    match part {
        Part::Uncommitted => Some("HEAD".to_string()),
        _ => cli_base(dir, "HEAD").map(|(_, _, mb)| mb),
    }
}

fn oracle_parse(
    numstat: &[u8],
    name_status: &[u8],
    untracked: &BTreeSet<String>,
) -> Vec<ChangedFile> {
    let lossy = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
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

/// One part of a change the old way: `git diff -M` with `--numstat` and `--name-status`, against a
/// copy of the index in which the untracked files are marked intent-to-add.
fn oracle_list(dir: &Path, part: Part) -> Option<Vec<ChangedFile>> {
    let left = left_of(dir, part)?;
    let base_args = |format: &'static str| {
        [
            "--no-optional-locks",
            "diff",
            "--no-ext-diff",
            "-M",
            format,
            "-z",
        ]
    };
    let mut files = if part == Part::Committed {
        let run = |format| {
            let mut args = base_args(format).to_vec();
            args.extend([left.as_str(), "HEAD"]);
            cli(dir, &args).ok()
        };
        oracle_parse(&run("--numstat")?, &run("--name-status")?, &BTreeSet::new())
    } else {
        let real = dir.join(text(&cli(dir, &["rev-parse", "--git-path", "index"]).ok()?));
        let temp = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        if real.exists() {
            std::fs::copy(&real, &temp).unwrap();
        }
        let env = [("GIT_INDEX_FILE", temp.as_os_str())];
        let listing = cli(dir, &["ls-files", "--others", "--exclude-standard", "-z"]).ok()?;
        let untracked: Vec<String> = listing
            .split(|b| *b == 0)
            .filter(|t| !t.is_empty())
            .map(|t| String::from_utf8_lossy(t).into_owned())
            .collect();
        for path in &untracked {
            cli_env(dir, &["--literal-pathspecs", "add", "-N", "--", path], &env).ok()?;
        }
        let run = |format| {
            let mut args = base_args(format).to_vec();
            args.push(left.as_str());
            cli_env(dir, &args, &env).ok()
        };
        oracle_parse(
            &run("--numstat")?,
            &run("--name-status")?,
            &untracked.iter().cloned().collect(),
        )
    };
    files.sort_by(|a, b| a.path.cmp(&b.path));
    if part == Part::Uncommitted {
        files.iter_mut().for_each(|f| f.uncommitted = true);
    } else {
        let dirty: BTreeSet<String> = oracle_list(dir, Part::Uncommitted)?
            .into_iter()
            .map(|f| f.path)
            .collect();
        for f in &mut files {
            f.uncommitted = dirty.contains(&f.path);
        }
    }
    Some(files)
}

fn oracle_pair(dir: &Path, part: Part, file: &ChangedFile) -> FilePair {
    let hint = diff::language_for(&file.path).to_string();
    if file.binary {
        return FilePair {
            original: String::new(),
            modified: String::new(),
            language_hint: hint,
            binary: true,
        };
    }
    let left = left_of(dir, part).unwrap();
    let show = |object: String| {
        String::from_utf8_lossy(&cli(dir, &["show", &object]).unwrap()).into_owned()
    };
    let original = match file.status {
        ChangeStatus::Added | ChangeStatus::Untracked => String::new(),
        _ => show(format!(
            "{left}:{}",
            file.old_path.as_deref().unwrap_or(&file.path)
        )),
    };
    let modified = match (file.status, part) {
        (ChangeStatus::Deleted, _) => String::new(),
        (_, Part::Committed) => show(format!("HEAD:{}", file.path)),
        _ => String::from_utf8_lossy(&std::fs::read(dir.join(&file.path)).unwrap()).into_owned(),
    };
    FilePair {
        original,
        modified,
        language_hint: hint,
        binary: false,
    }
}

#[test]
fn comparisons_changed_files_and_file_pair_equal_the_cli() {
    for (name, fx) in diff_fixtures() {
        let before = std::fs::read(fx.path.join(".git/index")).ok();
        for part in [Part::Whole, Part::Committed, Part::Uncommitted] {
            let want = oracle_list(&fx.path, part);
            let got = diff::changed_files(&fx.path, part);
            match (&want, &got) {
                (Some(want), Ok(got)) => {
                    assert_eq!(got, want, "{name}: {part:?}");
                    for file in want {
                        assert_eq!(
                            diff::file_pair(&fx.path, part, &file.path).unwrap(),
                            oracle_pair(&fx.path, part, file),
                            "{name}: {part:?}: {}",
                            file.path
                        );
                    }
                    assert!(matches!(
                        diff::file_pair(&fx.path, part, "not/in/the/change.md"),
                        Err(diff::DiffError::FileNotChanged(_))
                    ));
                }
                (None, Err(_)) => {}
                _ => panic!("{name}: {part:?}: cli {want:?} typed {got:?}"),
            }
        }
        // Reading a change never writes the repository's index.
        assert_eq!(
            std::fs::read(fx.path.join(".git/index")).ok(),
            before,
            "{name}"
        );
    }
}

#[test]
fn comparisons_commit_files_equal_git_log() {
    for (name, fx) in diff_fixtures() {
        let Some(left) = left_of(&fx.path, Part::Committed) else {
            assert!(diff::commit_files(&fx.path).is_err(), "{name}");
            continue;
        };
        let range = format!("{left}..HEAD");
        let shas: Vec<String> = text(&cli(&fx.path, &["rev-list", "--reverse", &range]).unwrap())
            .lines()
            .map(str::to_string)
            .collect();
        let want: Vec<(String, Vec<String>)> = shas
            .iter()
            .map(|sha| {
                let out = cli(
                    &fx.path,
                    &[
                        "log",
                        "-1",
                        "--no-renames",
                        "--format=",
                        "--name-only",
                        "-z",
                        sha,
                    ],
                )
                .unwrap();
                let mut files: Vec<String> = out
                    .split(|b| *b == 0)
                    .map(|t| String::from_utf8_lossy(t).trim_matches('\n').to_string())
                    .filter(|t| !t.is_empty())
                    .collect();
                files.sort();
                files.dedup();
                (sha.clone(), files)
            })
            .collect();
        let got: Vec<(String, Vec<String>)> = diff::commit_files(&fx.path)
            .unwrap()
            .into_iter()
            .map(|c| (c.sha, c.files))
            .collect();
        assert_eq!(got, want, "{name}");
    }
}

// ---- which commits break the commit rules, which repositories a change touched ----

const CHANGE: &str = "2026-10-19-c";
const GOOD: &str = "feat(s): good\n\nGenerated-By: ai-sdlc";

struct Workspace {
    _tmp: tempfile::TempDir,
    folder: PathBuf,
}

impl Workspace {
    fn repo(&self, name: &str) -> Fx {
        let path = self.folder.join(name);
        std::fs::create_dir_all(&path).unwrap();
        git(&path, &["init", "-q", "-b", "main"]);
        git(&path, &["config", "user.name", "Test"]);
        git(&path, &["config", "user.email", "test@example.com"]);
        git(&path, &["config", "commit.gpgsign", "false"]);
        git(&path, &["config", "core.autocrlf", "false"]);
        Fx {
            _tmp: tempfile::tempdir().unwrap(),
            path,
        }
    }
}

fn commit_with(fx: &Fx, rel: &str, message: &str) {
    fx.write(rel, &format!("{message}\n"));
    git(&fx.path, &["add", "--", rel]);
    git(
        &fx.path,
        &["commit", "-q", "--cleanup=verbatim", "-m", message],
    );
}

fn workspace() -> Workspace {
    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().to_path_buf();
    let ws = Workspace { _tmp: tmp, folder };
    let branch = format!("change/{CHANGE}");
    let m = ws.repo("m");
    m.commit(
        ".ai-sdlc.json",
        "{\"version\":1,\"systems\":{\"s\":{\"repos\":[\"app\",\"api\",\"lib\",\"solo\",\"rebased\"]}}}\n",
    );
    m.commit(
        &format!("intent/s/{CHANGE}/intent.md"),
        "---\ntitle: T\n---\nbody\n",
    );
    add_origin(&m, false);
    git(&m.path, &["checkout", "-q", "-b", &branch]);
    commit_with(&m, &format!("intent/s/{CHANGE}/plan.md"), GOOD);

    // Commits, some breaking the rules, and origin/HEAD set.
    let app = ws.repo("app");
    app.commit("README.md", "init\n");
    add_origin(&app, true);
    git(&app.path, &["checkout", "-q", "-b", &branch]);
    commit_with(&app, "a.txt", GOOD);
    commit_with(&app, "b.txt", "fix: tweak");
    commit_with(
        &app,
        "c.txt",
        "feat(other): wrong scope\n\nGenerated-By: ai-sdlc",
    );
    commit_with(&app, "d.txt", "feat(s): no trailer\n\nbody");

    // A branch without a commit of its own.
    let api = ws.repo("api");
    api.commit("README.md", "init\n");
    add_origin(&api, false);
    git(&api.path, &["checkout", "-q", "-b", &branch]);

    // No change branch at all.
    let lib = ws.repo("lib");
    lib.commit("README.md", "init\n");

    // No remote; local main moved on after branching.
    let solo = ws.repo("solo");
    solo.commit("README.md", "init\n");
    git(&solo.path, &["checkout", "-q", "-b", &branch]);
    commit_with(&solo, "s.txt", "chore(s): ok\n\nGenerated-By: ai-sdlc");
    git(&solo.path, &["checkout", "-q", "main"]);
    solo.commit("later.txt", "later\n");
    git(&solo.path, &["checkout", "-q", &branch]);

    // Rebased onto commits others pushed to origin/main.
    let rebased = ws.repo("rebased");
    rebased.commit("README.md", "init\n");
    add_origin(&rebased, false);
    git(&rebased.path, &["checkout", "-q", "-b", &branch]);
    commit_with(&rebased, "r.txt", "docs: loose");
    git(&rebased.path, &["checkout", "-q", "main"]);
    rebased.commit("others.txt", "o\n");
    git(&rebased.path, &["push", "-q", "origin", "main"]);
    git(&rebased.path, &["reset", "-q", "--hard", "HEAD~1"]);
    git(&rebased.path, &["checkout", "-q", &branch]);
    git(&rebased.path, &["rebase", "-q", "origin/main"]);
    ws
}

/// The touched repositories as the old code listed them: `(repo, base)`.
fn oracle_touched(folder: &Path) -> Vec<(String, String)> {
    let tip = format!("refs/heads/change/{CHANGE}");
    let mut out = Vec::new();
    for name in ["app", "api", "lib", "solo", "rebased"] {
        let dir = folder.join(name);
        if !cli_ok(&dir, &tip) {
            continue;
        }
        let (base, ..) = cli_base(&dir, &tip).unwrap();
        if cli_count(&dir, &cli_work_revs(&dir, &tip).unwrap()) > 0 {
            out.push((name.to_string(), base));
        }
    }
    let (base, ..) = cli_base(&folder.join("m"), "HEAD").unwrap();
    out.push(("m".to_string(), base));
    out
}

#[test]
fn comparisons_touched_repos_and_offenders_equal_the_cli() {
    let ws = workspace();
    let want = oracle_touched(&ws.folder);
    assert_eq!(
        want.iter().map(|(r, _)| r.as_str()).collect::<Vec<_>>(),
        ["app", "solo", "rebased", "m"]
    );
    let got = publish::touched_repos(&ws.folder, "m", "s", CHANGE).unwrap();
    assert_eq!(
        got.iter()
            .map(|r| (r.repo.clone(), r.base.clone()))
            .collect::<Vec<_>>(),
        want
    );
    for r in &got {
        assert_eq!(Path::new(&r.path), ws.folder.join(&r.repo));
    }

    let tip = format!("refs/heads/change/{CHANGE}");
    let mut oracle = Vec::new();
    for (repo, _) in &want {
        let dir = ws.folder.join(repo);
        let mut args = vec!["log".to_string(), "--format=%h%x1f%B%x1e".to_string()];
        args.extend(cli_work_revs(&dir, &tip).unwrap());
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let log = text(&cli(&dir, &args).unwrap());
        for rec in log.split('\x1e') {
            let Some((hash, message)) = rec.trim_start_matches('\n').split_once('\x1f') else {
                continue;
            };
            if !commits::follows_rules(message, "s") {
                oracle.push(commits::Offender {
                    repo: repo.clone(),
                    hash: hash.to_string(),
                    subject: message.lines().next().unwrap_or("").trim_end().to_string(),
                });
            }
        }
    }
    assert_eq!(oracle.len(), 4, "the fixture breaks the rules four times");
    assert_eq!(
        publish::change_offenders(&ws.folder, "m", "s", CHANGE).unwrap(),
        oracle
    );

    // The commits of a merge base range, the way a caller with a base commit asks.
    let app = ws.folder.join("app");
    let (_, _, mb) = cli_base(&app, &tip).unwrap();
    let range = format!("{mb}..{tip}");
    let log = text(&cli(&app, &["log", "--format=%h", &range]).unwrap());
    let got = commits::offenders_to(&app, "app", &[range], "s").unwrap();
    assert_eq!(got.len(), 3);
    assert!(got.iter().all(|o| log.lines().any(|h| h == o.hash)));
}

// ---- commits without git (T6) ----

const DOC: &str = "intent/s/c/intent.md";

/// Builds one twin of a commit fixture: the document `DOC` committed as a draft (unless the kind
/// is a new or deleted document) and a working tree edit that accepts it.
fn commit_fixture(kind: &str) -> Fx {
    let fx = Fx::new();
    let draft = "---\nstatus: draft\n---\nbody\n";
    let accepted = "---\nstatus: accepted\n---\nbody\n";
    fx.commit("README.md", "init\n");
    match kind {
        "plain" => {
            fx.commit(DOC, draft);
            fx.write(DOC, accepted);
        }
        "other staged" => {
            fx.commit(DOC, draft);
            fx.write(DOC, accepted);
            fx.write("other.txt", "staged\n");
            git(&fx.path, &["add", "other.txt"]);
            fx.write("src/other.rs", "x\n");
            git(&fx.path, &["add", "src/other.rs"]);
        }
        "doc staged differently" => {
            fx.commit(DOC, draft);
            fx.write(DOC, "---\nstatus: draft\n---\nstaged body\n");
            git(&fx.path, &["add", "--", DOC]);
            fx.write(DOC, accepted);
        }
        "crlf with autocrlf" => {
            git(&fx.path, &["config", "core.autocrlf", "true"]);
            fx.commit(DOC, "---\r\nstatus: draft\r\n---\r\nbody\r\n");
            fx.write(DOC, "---\r\nstatus: accepted\r\n---\r\nbody\r\n");
        }
        "gitattributes eol lf" => {
            fx.commit(".gitattributes", "*.md text eol=lf\n");
            fx.commit(DOC, draft);
            fx.write(DOC, "---\r\nstatus: accepted\r\n---\r\nbody\r\n");
        }
        "gitattributes binary" => {
            fx.commit(".gitattributes", "*.md -text\n");
            fx.commit(DOC, "---\r\nstatus: draft\r\n---\r\n");
            fx.write(DOC, "---\r\nstatus: accepted\r\n---\r\n");
        }
        "new document" => {
            fx.write(DOC, draft);
        }
        "new document already staged" => {
            fx.write(DOC, draft);
            git(&fx.path, &["add", "--", DOC]);
            fx.write(DOC, accepted);
        }
        "deleted document" => {
            fx.commit(DOC, draft);
            std::fs::remove_file(fx.path.join(DOC)).unwrap();
        }
        "executable document" => {
            fx.commit(DOC, draft);
            git(&fx.path, &["update-index", "--chmod=+x", "--", DOC]);
            git(&fx.path, &["commit", "-q", "-m", "mode"]);
            fx.write(DOC, accepted);
        }
        other => panic!("unknown fixture {other}"),
    }
    fx
}

const COMMIT_KINDS: [&str; 10] = [
    "plain",
    "other staged",
    "doc staged differently",
    "crlf with autocrlf",
    "gitattributes eol lf",
    "gitattributes binary",
    "new document",
    "new document already staged",
    "deleted document",
    "executable document",
];

/// Every file under the work tree except `.git`, keyed by relative path.
fn work_files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let rel = path.strip_prefix(root).unwrap();
                out.insert(
                    rel.to_string_lossy().replace('\\', "/"),
                    std::fs::read(&path).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// Everything a commit leaves behind that two repositories must agree on.
fn commit_state(fx: &Fx) -> Vec<String> {
    let dir = &fx.path;
    vec![
        git(dir, &["rev-parse", "HEAD^{tree}"]),
        git(dir, &["rev-list", "--count", "HEAD"]),
        git(dir, &["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"]),
        text(&cli(dir, &["log", "-1", "--format=%B"]).unwrap()),
        git(dir, &["ls-files", "-s"]),
        git(dir, &["status", "--porcelain"]),
        git(dir, &["reflog", "-1", "--format=%gs"]),
        format!("{:?}", work_files(dir)),
    ]
}

fn cli_commit_only(fx: &Fx, rel: &str, message: &str) -> Result<(), String> {
    cli(&fx.path, &["add", "--", rel])?;
    cli(
        &fx.path,
        &["commit", "-q", "-m", message, "--only", "--", rel],
    )
    .map(|_| ())
}

#[test]
fn commits_equal_git_add_and_commit_only() {
    let message = "docs(s): accept intent c\n\nGenerated-By: ai-sdlc";
    for kind in COMMIT_KINDS {
        let (oracle, ours) = (commit_fixture(kind), commit_fixture(kind));
        cli_commit_only(&oracle, DOC, message).unwrap_or_else(|e| panic!("{kind}: {e}"));
        let outcome = Repo::open(&ours.path)
            .unwrap()
            .commit_only(DOC, message)
            .unwrap_or_else(|e| panic!("{kind}: {e}"));
        assert_eq!(outcome.sha, ours.head(), "{kind}");
        assert_eq!(commit_state(&oracle), commit_state(&ours), "{kind}");
    }
}

#[test]
fn commits_clean_the_message_as_git_does_for_m() {
    let messages = [
        "plain subject",
        "subject with trailing spaces   \n\nbody line  \t\n",
        "\n\n  leading blank lines\n",
        "subject\n\n\n\n\nthree blank lines collapse\n\n\n\n",
        "# a comment line is kept\n\nbody\n",
        "subject\r\n\r\nwindows line ends\r\n",
        "no newline at the end",
        "  indented subject\n    indented body\n",
        "subject\n\n\ttab indented\n\n\n",
    ];
    for message in messages {
        let (oracle, ours) = (commit_fixture("plain"), commit_fixture("plain"));
        cli_commit_only(&oracle, DOC, message).unwrap();
        Repo::open(&ours.path)
            .unwrap()
            .commit_only(DOC, message)
            .unwrap();
        let body = |fx: &Fx| {
            let raw = cli(&fx.path, &["cat-file", "commit", "HEAD"]).unwrap();
            let raw = String::from_utf8_lossy(&raw).into_owned();
            raw.split_once("\n\n").map(|(_, m)| m.to_string())
        };
        assert_eq!(body(&oracle), body(&ours), "{message:?}");
    }
}

#[test]
fn commits_with_nothing_to_say_are_refused_as_git_refuses() {
    for message in ["", "   \n\n", "\n"] {
        let (oracle, ours) = (commit_fixture("plain"), commit_fixture("plain"));
        assert!(cli_commit_only(&oracle, DOC, message).is_err());
        let before = ours.head();
        let err = Repo::open(&ours.path)
            .unwrap()
            .commit_only(DOC, message)
            .unwrap_err();
        assert!(err.to_string().contains("empty commit message"), "{err}");
        assert_eq!(ours.head(), before);
        assert_eq!(git(&ours.path, &["diff", "--cached", "--name-only"]), "");
    }
}

#[test]
fn commits_hook_rows_decide_as_the_cli_does() {
    // (hook, script, whether the commit is made, text the failure shows)
    let rows = [
        ("commit-msg", "grep -q accept \"$1\"", true, ""),
        (
            "commit-msg",
            "echo 'rule says no' >&2; exit 1",
            false,
            "rule says no",
        ),
        ("pre-commit", "exit 0", true, ""),
        (
            "pre-commit",
            "echo 'check says no' >&2; exit 1",
            false,
            "check says no",
        ),
        (
            "prepare-commit-msg",
            "echo 'prepared by hook' > \"$1\"",
            true,
            "",
        ),
        ("commit-msg", "echo 'Edited-by: hook' >> \"$1\"", true, ""),
        ("post-commit", "exit 1", true, ""),
        ("pre-push", "exit 1", true, ""),
    ];
    for (name, script, made, shown) in rows {
        let (oracle, ours) = (
            commit_fixture("other staged"),
            commit_fixture("other staged"),
        );
        for fx in [&oracle, &ours] {
            let hook = fx.path.join(".git/hooks").join(name);
            std::fs::write(&hook, format!("#!/bin/sh\n{script}\n")).unwrap();
        }
        // A tracked document needs no `git add`: `--only` commits the working file, and a refused
        // commit then leaves the index as it was.
        let expected = cli(
            &oracle.path,
            &[
                "commit",
                "-q",
                "-m",
                "docs(s): accept intent c",
                "--only",
                "--",
                DOC,
            ],
        )
        .map(|_| ());
        let got = Repo::open(&ours.path)
            .unwrap()
            .commit_only(DOC, "docs(s): accept intent c");
        assert_eq!(expected.is_ok(), made, "{name} {script}: {expected:?}");
        assert_eq!(got.is_ok(), made, "{name} {script}: {got:?}");
        if let Err(message) = got {
            assert!(message.to_string().contains(shown), "{name}: {message}");
        }
        assert_eq!(
            commit_state(&oracle),
            commit_state(&ours),
            "{name} {script}"
        );
    }
}

#[test]
fn commits_take_the_tree_a_pre_commit_hook_restages() {
    // A formatter hook: rewrites the document in the work tree and stages it, so the commit holds
    // what the hook left in the index it was given.
    let message = "docs(s): accept intent c\n\nGenerated-By: ai-sdlc";
    for kind in ["plain", "other staged", "doc staged differently"] {
        let (oracle, ours) = (commit_fixture(kind), commit_fixture(kind));
        for fx in [&oracle, &ours] {
            std::fs::write(
                fx.path.join(".git/hooks/pre-commit"),
                format!("#!/bin/sh\necho formatted >> {DOC}\ngit add -- {DOC}\n"),
            )
            .unwrap();
        }
        cli_commit_only(&oracle, DOC, message).unwrap_or_else(|e| panic!("{kind}: {e}"));
        let outcome = Repo::open(&ours.path)
            .unwrap()
            .commit_only(DOC, message)
            .unwrap_or_else(|e| panic!("{kind}: {e}"));
        assert_eq!(outcome.sha, ours.head(), "{kind}");
        assert_eq!(commit_state(&oracle), commit_state(&ours), "{kind}");
    }
}

#[test]
fn commits_leave_the_index_and_document_alone_on_a_hook_failure() {
    let fx = commit_fixture("doc staged differently");
    std::fs::write(
        fx.path.join(".git/hooks/pre-commit"),
        "#!/bin/sh\necho refused by hook >&2\nexit 1\n",
    )
    .unwrap();
    let state = |fx: &Fx| {
        (
            git(&fx.path, &["ls-files", "-s"]),
            work_files(&fx.path),
            fx.head(),
        )
    };
    let before = state(&fx);
    let err = Repo::open(&fx.path)
        .unwrap()
        .commit_only(DOC, "docs(s): accept")
        .unwrap_err();
    assert!(err.to_string().contains("refused by hook"), "{err}");
    assert_eq!(before, state(&fx));
    let leftovers: Vec<_> = std::fs::read_dir(fx.path.join(".git"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("lock") || n.starts_with("next-index"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

// ---- branch operations and putting back stray edits (R9.2) ----

/// Everything a branch operation leaves behind that two repositories must agree on.
fn branch_state(fx: &Fx) -> Vec<String> {
    let dir = &fx.path;
    vec![
        git(dir, &["rev-parse", "HEAD^{tree}"]),
        text(&cli(dir, &["symbolic-ref", "-q", "HEAD"]).unwrap_or_default()),
        git(
            dir,
            &["for-each-ref", "--format=%(refname) %(tree) %(subject)"],
        ),
        git(dir, &["ls-files", "-s"]),
        git(dir, &["status", "--porcelain"]),
        git(dir, &["reflog", "-1", "--format=%gs"]),
        text(&cli(dir, &["config", "--get-regexp", "^branch\\."]).unwrap_or_default()),
        format!("{:?}", work_files(dir)),
    ]
}

/// A repository on `main` whose branch `other` differs from it in `a.txt`, `dir/b.txt` (removed)
/// and a file only it has, then a local state set by `variant`.
fn switching(variant: &str) -> Fx {
    let fx = Fx::new();
    if variant == "autocrlf" {
        git(&fx.path, &["config", "core.autocrlf", "true"]);
    }
    fx.commit("README.md", "init\n");
    fx.commit("a.txt", "base\r\nline\r\n");
    fx.commit("dir/b.txt", "b\n");
    fx.commit("same.txt", "same\n");
    git(&fx.path, &["checkout", "-q", "-b", "other"]);
    fx.commit("a.txt", "other\r\nline\r\n");
    fx.commit("only-other.txt", "only\n");
    git(&fx.path, &["rm", "-q", "--", "dir/b.txt"]);
    git(&fx.path, &["commit", "-q", "-m", "drop b"]);
    git(&fx.path, &["checkout", "-q", "main"]);
    git(&fx.path, &["branch", "side/slashed"]);
    match variant {
        "clean" | "autocrlf" => {}
        "edit both branches share" => fx.write("same.txt", "edited\n"),
        "staged elsewhere" => {
            fx.write("new.txt", "staged\n");
            git(&fx.path, &["add", "new.txt"]);
        }
        "untracked elsewhere" => fx.write("scratch/notes.txt", "x\n"),
        "edit a differing file" => fx.write("a.txt", "local edit\r\n"),
        "staged edit of a differing file" => {
            fx.write("a.txt", "local edit\r\n");
            git(&fx.path, &["add", "a.txt"]);
        }
        "untracked in the way" => fx.write("only-other.txt", "mine\n"),
        "removed file the other branch also removes" => {
            std::fs::remove_file(fx.path.join("dir/b.txt")).unwrap()
        }
        other => panic!("unknown variant {other}"),
    }
    fx
}

#[test]
fn branches_switch_equals_checkout() {
    for variant in [
        "clean",
        "autocrlf",
        "edit both branches share",
        "staged elsewhere",
        "untracked elsewhere",
        "removed file the other branch also removes",
    ] {
        for target in ["other", "side/slashed"] {
            let (oracle, ours) = (switching(variant), switching(variant));
            cli(&oracle.path, &["checkout", "-q", target, "--"])
                .unwrap_or_else(|e| panic!("{variant} {target}: {e}"));
            Repo::open(&ours.path)
                .unwrap()
                .checkout_branch(target)
                .unwrap_or_else(|e| panic!("{variant} {target}: {e}"));
            assert_eq!(
                branch_state(&oracle),
                branch_state(&ours),
                "{variant} {target}"
            );
        }
    }
}

#[test]
fn branches_refused_switch_gives_gits_message_and_changes_nothing() {
    for variant in [
        "edit a differing file",
        "staged edit of a differing file",
        "untracked in the way",
    ] {
        let (oracle, ours) = (switching(variant), switching(variant));
        let before = branch_state(&ours);
        let expected = cli(&oracle.path, &["checkout", "-q", "other", "--"]).unwrap_err();
        let err = Repo::open(&ours.path)
            .unwrap()
            .checkout_branch("other")
            .unwrap_err();
        assert_eq!(err.stderr, expected.trim(), "{variant}");
        assert!(err.stderr.contains("would be overwritten"), "{variant}");
        assert_eq!(err.args, "checkout -q other --", "{variant}");
        assert_eq!(branch_state(&oracle), branch_state(&ours), "{variant}");
        assert_eq!(before, branch_state(&ours), "{variant}");
    }
}

#[test]
fn branches_create_equals_checkout_b() {
    for variant in ["clean", "staged elsewhere", "edit a differing file"] {
        for at in ["main", "other", "origin/main", "HEAD"] {
            let (oracle, ours) = (switching(variant), switching(variant));
            for fx in [&oracle, &ours] {
                add_origin(fx, true);
            }
            let expected = cli(&oracle.path, &["checkout", "-q", "-b", "change/new", at]);
            let got = Repo::open(&ours.path)
                .unwrap()
                .create_branch("change/new", at);
            assert_eq!(expected.is_ok(), got.is_ok(), "{variant} {at}: {got:?}");
            assert_eq!(branch_state(&oracle), branch_state(&ours), "{variant} {at}");
        }
    }
}

#[test]
fn branches_create_refuses_what_git_refuses() {
    for (name, at) in [
        ("main", "other"),
        ("side/slashed", "main"),
        ("change/new", "no-such-rev"),
        ("bad..name", "main"),
        ("side", "main"),
    ] {
        let (oracle, ours) = (switching("clean"), switching("clean"));
        let expected = cli(&oracle.path, &["checkout", "-q", "-b", name, at]);
        let got = Repo::open(&ours.path).unwrap().create_branch(name, at);
        assert!(expected.is_err(), "{name} {at}");
        assert!(got.is_err(), "{name} {at}");
        assert_eq!(branch_state(&oracle), branch_state(&ours), "{name} {at}");
    }
}

#[test]
fn branches_rename_and_delete_equal_the_cli() {
    // (the operation, its arguments)
    let rows: [(&str, &str, &str); 9] = [
        ("rename", "other", "change/renamed"),
        ("rename", "main", "trunk"),
        ("rename", "other", "main"),
        ("rename", "no-such", "x"),
        ("delete", "other", ""),
        ("delete", "side/slashed", ""),
        ("delete", "main", ""),
        ("delete", "no-such", ""),
        ("rename", "side/slashed", "side-flat"),
    ];
    for (op, one, two) in rows {
        let (oracle, ours) = (switching("clean"), switching("clean"));
        let repo = Repo::open(&ours.path).unwrap();
        let (expected, got) = if op == "rename" {
            (
                cli(&oracle.path, &["branch", "-m", one, two]),
                repo.rename_branch(one, two),
            )
        } else {
            (
                cli(&oracle.path, &["branch", "-D", one]),
                repo.delete_branch(one),
            )
        };
        assert_eq!(expected.is_ok(), got.is_ok(), "{op} {one} {two}: {got:?}");
        assert_eq!(
            branch_state(&oracle),
            branch_state(&ours),
            "{op} {one} {two}"
        );
    }
}

/// Dirty states a run can leave: every kind a discard restores or removes.
fn stray(autocrlf: bool) -> Fx {
    let fx = Fx::new();
    if autocrlf {
        git(&fx.path, &["config", "core.autocrlf", "true"]);
    }
    fx.commit("README.md", "init\n");
    for name in ["a", "b", "c", "d", "e", "g", "keep"] {
        fx.commit(&format!("docs/{name}.md"), &format!("{name}\r\nline\r\n"));
    }
    fx.write("docs/a.md", "a edited\r\n");
    fx.write("docs/b.md", "b staged\r\n");
    git(&fx.path, &["add", "--", "docs/b.md"]);
    fx.write("docs/c.md", "c staged\r\n");
    git(&fx.path, &["add", "--", "docs/c.md"]);
    fx.write("docs/c.md", "c staged then edited\r\n");
    std::fs::remove_file(fx.path.join("docs/d.md")).unwrap();
    git(&fx.path, &["rm", "-q", "--", "docs/e.md"]);
    git(&fx.path, &["mv", "docs/g.md", "docs/g2.md"]);
    fx.write("docs/keep.md", "keep edited\r\n");
    fx.write("fresh/deep/n.md", "staged new\n");
    git(&fx.path, &["add", "--", "fresh/deep/n.md"]);
    fx.write("fresh/deep/untracked.md", "x\n");
    fx
}

#[test]
fn branches_restore_and_remove_equal_restore_and_rm() {
    for autocrlf in [false, true] {
        let (oracle, ours) = (stray(autocrlf), stray(autocrlf));
        let restore = [
            "docs/a.md",
            "docs/b.md",
            "docs/c.md",
            "docs/d.md",
            "docs/e.md",
        ];
        for p in restore {
            cli(
                &oracle.path,
                &["restore", "--staged", "--worktree", "--", p],
            )
            .unwrap();
        }
        let repo = Repo::open(&ours.path).unwrap();
        repo.restore_paths(&restore).unwrap();
        assert_eq!(
            branch_state(&oracle),
            branch_state(&ours),
            "restore {autocrlf}"
        );
        for p in ["fresh/deep/n.md", "docs/g2.md"] {
            cli(&oracle.path, &["rm", "-f", "-q", "--", p]).unwrap();
        }
        repo.remove_paths(&["fresh/deep/n.md", "docs/g2.md"])
            .unwrap();
        assert_eq!(
            branch_state(&oracle),
            branch_state(&ours),
            "remove {autocrlf}"
        );
        // The file nobody asked about is untouched.
        assert_eq!(
            std::fs::read(ours.path.join("docs/keep.md")).unwrap(),
            b"keep edited\r\n"
        );
    }
}

#[test]
fn branches_restore_and_remove_refuse_what_git_refuses() {
    let (oracle, ours) = (stray(false), stray(false));
    let repo = Repo::open(&ours.path).unwrap();
    assert!(cli(
        &oracle.path,
        &["restore", "--staged", "--worktree", "--", "nope.md"]
    )
    .is_err());
    assert!(repo.restore_paths(&["nope.md"]).is_err());
    assert!(cli(&oracle.path, &["rm", "-f", "-q", "--", "nope.md"]).is_err());
    assert!(repo.remove_paths(&["nope.md"]).is_err());
    assert_eq!(branch_state(&oracle), branch_state(&ours));
}

/// The R9.2 row "how to put back a run's stray document edits": what a run left is put back, and
/// what was dirty before the run is left alone.
#[test]
fn branches_discard_puts_back_a_runs_stray_edits() {
    for autocrlf in [false, true] {
        let build = || {
            let fx = Fx::new();
            if autocrlf {
                git(&fx.path, &["config", "core.autocrlf", "true"]);
            }
            fx.commit("README.md", "init\n");
            for name in ["a", "b", "c", "e", "g", "dirty"] {
                fx.commit(&format!("docs/{name}.md"), &format!("{name}\r\nline\r\n"));
            }
            fx.write("docs/dirty.md", "was dirty before the run\r\n");
            fx.write("untouched.md", "was untracked before\n");
            fx
        };
        let (oracle, ours) = (build(), build());
        let before = snapshot::take(&ours.path).unwrap();
        for fx in [&oracle, &ours] {
            fx.write("docs/a.md", "a edited\r\n");
            fx.write("docs/b.md", "b staged\r\n");
            git(&fx.path, &["add", "--", "docs/b.md"]);
            std::fs::remove_file(fx.path.join("docs/c.md")).unwrap();
            git(&fx.path, &["rm", "-q", "--", "docs/e.md"]);
            git(&fx.path, &["mv", "docs/g.md", "docs/g2.md"]);
            fx.write("fresh/deep/n.md", "staged new\n");
            git(&fx.path, &["add", "--", "fresh/deep/n.md"]);
            fx.write("fresh/untracked.md", "x\n");
        }
        let paths: Vec<String> = [
            "docs/a.md",
            "docs/b.md",
            "docs/c.md",
            "docs/e.md",
            "docs/g2.md",
            "fresh/deep/n.md",
            "fresh/untracked.md",
        ]
        .map(str::to_string)
        .to_vec();
        // The old procedure, one git command per path, is the oracle.
        for entry in Repo::open(&oracle.path).unwrap().status("").unwrap() {
            if !paths.contains(&entry.path) {
                continue;
            }
            let xy = format!("{}{}", entry.index, entry.worktree);
            if xy == "??" {
                std::fs::remove_file(oracle.path.join(&entry.path)).unwrap();
            } else if ["A", "R", "C"].iter().any(|c| xy.starts_with(c)) {
                git(&oracle.path, &["rm", "-f", "-q", "--", &entry.path]);
            } else {
                git(
                    &oracle.path,
                    &["restore", "--staged", "--worktree", "--", &entry.path],
                );
            }
        }
        snapshot::discard(&ours.path, &before, &paths, None).unwrap();
        assert_eq!(
            branch_state(&oracle),
            branch_state(&ours),
            "discard {autocrlf}"
        );
        assert_eq!(
            std::fs::read(ours.path.join("docs/dirty.md")).unwrap(),
            b"was dirty before the run\r\n"
        );
    }
}

/// Sets the modification time of `path` to `when`.
fn set_mtime(path: &Path, when: std::time::SystemTime) {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

/// A file staged in the same second as the previous index write and then edited to the same size
/// within that second is racily clean: its size and time alone cannot tell it from the staged
/// file. Git settles that when it writes the index; the write of a commit must too, or the edit is
/// never seen again once the new index is older than the file.
#[test]
fn commits_keep_a_same_size_edit_of_another_file_visible() {
    let fx = Fx::new();
    // The change time of a file is not what hides the edit here; its size and modification time
    // are.
    git(&fx.path, &["config", "core.trustctime", "false"]);
    fx.commit("README.md", "init\n");
    fx.commit(DOC, "---\nstatus: draft\n---\nbody\n");
    fx.commit("other.txt", "aaaa\n");

    // The previous index write and the staging of other.txt happened in the same past second.
    let past = std::time::SystemTime::now() - std::time::Duration::from_secs(30);
    let since = past.duration_since(std::time::UNIX_EPOCH).unwrap();
    let stamp = git2::IndexTime::new(since.as_secs() as i32, since.subsec_nanos());
    {
        let repo = git2::Repository::open(&fx.path).unwrap();
        let mut index = repo.index().unwrap();
        let mut entry = index.get_path(Path::new("other.txt"), 0).unwrap();
        entry.mtime = stamp;
        entry.ctime = stamp;
        index.add(&entry).unwrap();
        index.write().unwrap();
    }
    set_mtime(&fx.path.join(".git/index"), past);

    // The run edits other.txt to the same size in that second, and the document is accepted.
    fx.write("other.txt", "bbbb\n");
    set_mtime(&fx.path.join("other.txt"), past);
    fx.write(DOC, "---\nstatus: accepted\n---\nbody\n");

    Repo::open(&fx.path)
        .unwrap()
        .commit_only(DOC, "docs(s): accept intent c")
        .unwrap();

    let status = git(&fx.path, &["status", "--porcelain"]);
    assert!(
        status.contains("other.txt"),
        "the same-size edit of other.txt is lost, status:\n{status}"
    );
}
