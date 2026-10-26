//! Parity between the typed repository reads in `kata_sdlc::git` and the answers the git command line
//! gives on the same repositories. The command line here is only the oracle: every fixture is built
//! with it and every expected answer is computed with it, the way the Workbench did before it read
//! repositories itself.
use kata_sdlc::branch;
use kata_sdlc::changes::other_change_branches;
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
        let others: Vec<String> = listed
            .lines()
            .map(str::trim)
            .filter(|b| !b.is_empty() && Some(*b) != cur.as_deref())
            .filter_map(|b| b.strip_prefix("change/"))
            .filter(|b| !b.starts_with("pending-"))
            .map(str::to_string)
            .collect();
        assert_eq!(other_change_branches(&fx.path), others, "{name}");
    }
}
