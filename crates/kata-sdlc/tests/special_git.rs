//! R21.1: a workspace whose repositories sign every commit, or pass files through a clean/smudge filter (as Git
//! LFS does), goes through every step of a change: start, accept the documents, build, declare done. The plugin
//! does all the git work with the real `git`, so nothing in Kata refuses such a repository.
//!
//! The signing is a fake `gpg.program` (`fixtures/fake-gpg.mjs`) and the filter is a pair of `sed` commands; GitHub
//! is a fake `gh` (`fixtures/fake-gh.cjs`, a copy of Node.js named `gh` with the script preloaded through
//! `NODE_OPTIONS`) over local bare remotes. R21.2 (the isolated copy of a Workbench run still refuses a signing
//! repository) stays covered by the `kata_core::worktree` test `refuses_a_repository_that_signs_every_commit`.
//!
//! These tests run the vendored copy of the plugin's program in `tests/ai-sdlc-tools/`, and need `git`, `sed` and
//! Node.js on `PATH`.
#![allow(clippy::disallowed_methods)]
use kata_sdlc::accept::{self, AcceptOutcome, ChangeDocument};
use kata_sdlc::ai_sdlc::state;
use kata_sdlc::ai_sdlc::{Place, Program};
use kata_sdlc::done::{self, DeclareView};
use kata_sdlc::plugin::{GhPresence, Plugin, Readiness};
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

const SYSTEM: &str = "demo";
const CHANGE: &str = "2026-11-01-greeting";
const MARKER: &str = r#"{"version":1,"systems":{"demo":{"repos":["kata"]}}}"#;
const INTENT: &str = "---\ntitle: Greeting\nsystem: demo\nauthor: t\ndate: 2026-11-01\nstatus: draft\nscope: demo\n---\n\n# Intent: Greeting\n";
const FAKE_SIGNATURE: &str = "FAKE-SIGNATURE";

fn here() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn forward(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

fn program() -> Program {
    Program {
        node: "node".into(),
        entry: here().join("tests/ai-sdlc-tools/ai-sdlc.ts"),
    }
}

/// Runs `git -C <dir> <args>`, which must succeed, and returns its stdout without the trailing newline.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

fn plugin(place: &Place, args: &[&str]) -> Value {
    match kata_sdlc::ai_sdlc::call_kind(args) {
        kata_sdlc::ai_sdlc::CallKind::Long => {
            program()
                .step_long(args, place, &kata_core::proc::CancelToken::new(), None)
                .json
        }
        kata_sdlc::ai_sdlc::CallKind::Quick => program().run(args, place).unwrap(),
    }
}

/// A fake `gh` first on `PATH`, a fake `gpg` for git, and everything put back afterwards.
struct Fakes {
    saved: Vec<(&'static str, Option<OsString>)>,
    _dir: tempfile::TempDir,
    gpg: PathBuf,
    state: PathBuf,
}

impl Fakes {
    fn new(ws: &Path) -> Fakes {
        let names = ["PATH", "NODE_OPTIONS", "FAKE_GH_STATE", "FAKE_GH_LOG"];
        let saved = names.map(|n| (n, std::env::var_os(n))).to_vec();
        let dir = tempfile::tempdir().unwrap();
        let path = std::env::var_os("PATH").unwrap_or_default();
        let node = std::env::split_paths(&path)
            .map(|d| d.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|p| p.is_file())
            .expect("node is on PATH");
        let gh = dir.path().join(if cfg!(windows) { "gh.exe" } else { "gh" });
        if std::fs::hard_link(&node, &gh).is_err() {
            std::fs::copy(&node, &gh).unwrap();
        }
        // git starts `gpg.program` as a program of its own, with options Node.js would take for itself, so a
        // script with a shebang line (which git for Windows also starts) hands them to the fake.
        let gpg = dir.path().join("fake-gpg");
        std::fs::write(
            &gpg,
            format!(
                "#!/bin/sh\nexec node \"{}\" \"$@\"\n",
                forward(&here().join("tests/fixtures/fake-gpg.mjs"))
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&gpg, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut paths = vec![dir.path().to_path_buf()];
        paths.extend(std::env::split_paths(&path));
        std::env::set_var("PATH", std::env::join_paths(paths).unwrap());
        std::env::set_var(
            "NODE_OPTIONS",
            format!(
                "--require={}",
                forward(&here().join("tests/fixtures/fake-gh.cjs"))
            ),
        );
        let state = ws.join("gh-state.json");
        std::env::set_var("FAKE_GH_STATE", &state);
        std::env::set_var("FAKE_GH_LOG", ws.join("gh-log.jsonl"));
        Fakes {
            saved,
            gpg,
            state,
            _dir: dir,
        }
    }

    fn prs(&self) -> Vec<Value> {
        let text = std::fs::read_to_string(&self.state).unwrap_or_default();
        serde_json::from_str::<Value>(&text).map_or_else(
            |_| Vec::new(),
            |v| v["prs"].as_array().cloned().unwrap_or_default(),
        )
    }
}

impl Drop for Fakes {
    fn drop(&mut self) {
        for (name, value) in &self.saved {
            match value {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Need {
    MasterSigns,
    KataSigns,
    KataFilters,
}

/// A repository with an identity, signing or a filter when asked, one commit on `main`, and a bare remote.
fn repo(ws: &Path, name: &str, signs: Option<&Path>, filters: bool) -> PathBuf {
    let path = ws.join(name);
    std::fs::create_dir_all(&path).unwrap();
    git(&path, &["init", "-q", "-b", "main"]);
    git(&path, &["config", "user.name", "Test"]);
    git(&path, &["config", "user.email", "test@example.com"]);
    git(&path, &["config", "core.autocrlf", "false"]);
    match signs {
        Some(gpg) => {
            git(&path, &["config", "commit.gpgsign", "true"]);
            git(&path, &["config", "gpg.program", &forward(gpg)]);
        }
        None => {
            git(&path, &["config", "commit.gpgsign", "false"]);
        }
    }
    if filters {
        git(
            &path,
            &["config", "filter.kata-test.clean", "sed s/^/LFS:/"],
        );
        git(
            &path,
            &["config", "filter.kata-test.smudge", "sed s/^LFS://"],
        );
        std::fs::write(path.join(".gitattributes"), "*.dat filter=kata-test\n").unwrap();
        std::fs::write(path.join("data.dat"), "payload 0\n").unwrap();
        git(&path, &["add", ".gitattributes", "data.dat"]);
    }
    std::fs::write(path.join("README.md"), "init\n").unwrap();
    git(&path, &["add", "README.md"]);
    git(&path, &["commit", "-q", "-m", "init"]);
    let bare = ws.join(format!("{name}-origin.git"));
    git(ws, &["init", "-q", "--bare", &forward(&bare)]);
    git(&path, &["remote", "add", "origin", &forward(&bare)]);
    git(&path, &["push", "-q", "origin", "main"]);
    git(&path, &["fetch", "-q", "origin"]);
    git(&path, &["remote", "set-head", "origin", "main"]);
    path
}

/// Every commit of `branch` beyond `main` in `dir`, as `git cat-file commit` prints it.
fn commits_of(dir: &Path, branch: &str) -> Vec<String> {
    git(dir, &["rev-list", &format!("main..{branch}")])
        .lines()
        .map(|sha| git(dir, &["cat-file", "commit", sha]))
        .collect()
}

fn assert_signed(what: &str, commits: &[String]) {
    assert!(!commits.is_empty(), "{what}: no commits to look at");
    for commit in commits {
        assert!(
            commit.contains("gpgsig") && commit.contains(FAKE_SIGNATURE),
            "{what}: a commit is not signed:\n{commit}"
        );
    }
}

fn expect_committed(answer: &Value) {
    assert!(answer["committed"] == true, "{answer}");
}

#[test]
fn a_signing_and_filtering_workspace_goes_through_every_step() {
    for need in [Need::MasterSigns, Need::KataSigns, Need::KataFilters] {
        goes_through_every_step(need);
    }
}

fn goes_through_every_step(need: Need) {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().to_path_buf();
    let fakes = Fakes::new(&ws);
    let say = |what: &str| format!("{need:?}: {what}");
    let master = repo(
        &ws,
        "ai-sdlc",
        (need == Need::MasterSigns).then_some(fakes.gpg.as_path()),
        false,
    );
    let kata = repo(
        &ws,
        "kata",
        (need == Need::KataSigns).then_some(fakes.gpg.as_path()),
        need == Need::KataFilters,
    );
    std::fs::write(master.join(".ai-sdlc.json"), MARKER).unwrap();
    git(&master, &["add", ".ai-sdlc.json"]);
    git(&master, &["commit", "-q", "-m", "marker"]);
    git(&master, &["push", "-q", "origin", "main"]);

    // The change starts: its branch and its copy of the master.
    let place = Place {
        master: master.clone(),
        workspace: ws.clone(),
    };
    let started = plugin(
        &place,
        &[
            "change", "start", "--json", "--system", SYSTEM, "--change", CHANGE, "--type", "feat",
            "--scope", "demo", "--title", "Greeting",
        ],
    );
    assert_eq!(
        started["outcome"],
        "passed",
        "{}",
        say(&started.to_string())
    );
    let copy = ws.join(".ai-sdlc").join("copies").join(CHANGE);
    let at = Place {
        master: copy.clone(),
        workspace: ws.clone(),
    };
    let folder = copy.join("intent").join(SYSTEM).join(CHANGE);
    let branch = format!("change/{CHANGE}");

    // The documents are written, committed and accepted in order.
    let example = |name: &str| {
        std::fs::read_to_string(
            here()
                .join("tests/ai-sdlc-tools/examples/change/2/valid")
                .join(name),
        )
        .unwrap()
    };
    let documents = [
        (
            "intent.md",
            INTENT.to_string(),
            "intent-draft",
            ChangeDocument::Intent,
        ),
        ("spec.md", example("spec.md"), "spec", ChangeDocument::Spec),
        (
            "plan.md",
            example("plan.md").replace("repo: app", "repo: kata"),
            "plan",
            ChangeDocument::Plan,
        ),
    ];
    for (file, text, kind, doc) in documents {
        std::fs::write(folder.join(file), text.replace("\r\n", "\n")).unwrap();
        let path = folder.join(file).display().to_string();
        let answer = plugin(
            &at,
            &[
                "commit", "--json", "--kind", kind, "--system", SYSTEM, "--change", CHANGE, "--",
                &path,
            ],
        );
        expect_committed(&answer);
        let change = state::state(&program(), &ws, SYSTEM, Some(CHANGE))
            .unwrap()
            .changes
            .into_iter()
            .next()
            .expect("the change is listed");
        let outcome = accept::apply(&program(), &place, SYSTEM, &change, doc);
        assert_eq!(
            outcome,
            AcceptOutcome::Accepted { warnings: vec![] },
            "{}",
            say(file)
        );
    }

    // build.start puts the product repository on the change's branch.
    let started = plugin(
        &at,
        &[
            "run",
            "build.start",
            "--json",
            "--system",
            SYSTEM,
            "--change",
            CHANGE,
            "--repo",
            "kata",
        ],
    );
    assert_eq!(
        started["outcome"],
        "passed",
        "{}",
        say(&started.to_string())
    );
    assert_eq!(git(&kata, &["rev-parse", "--abbrev-ref", "HEAD"]), branch);

    // Each task's work is committed through the plugin, then logged.
    let mut log = "---\nlayout: 2\n---\n\n# Build log: kata\n".to_string();
    for task in ["T1", "T2", "T3"] {
        let file = if need == Need::KataFilters {
            "data.dat"
        } else {
            "hello.txt"
        };
        std::fs::write(kata.join(file), format!("payload {task}\n")).unwrap();
        let answer = plugin(
            &at,
            &[
                "commit",
                "--json",
                "--kind",
                "work",
                "--system",
                SYSTEM,
                "--change",
                CHANGE,
                "--repo",
                "kata",
                "--task",
                task,
                "--type",
                "feat",
                "--subject",
                "say hello",
                "--",
                file,
            ],
        );
        expect_committed(&answer);
        let sha = git(&kata, &["rev-parse", "--short=7", "HEAD"]);
        log.push_str(&format!(
            "\n### {task}\n\n```yaml\ntask: {task}\ncommits: [{sha}]\n```\n"
        ));
        let done = plugin(
            &at,
            &[
                "run",
                "task.done",
                "--json",
                "--system",
                SYSTEM,
                "--change",
                CHANGE,
                "--repo",
                "kata",
                "--task",
                task,
            ],
        );
        assert_eq!(done["outcome"], "passed", "{}", say(&done.to_string()));
    }
    std::fs::create_dir_all(folder.join("build")).unwrap();
    let head = git(&kata, &["rev-parse", "--short=7", "HEAD"]);
    let review = format!(
        "---\nlayout: 2\n---\n\n# Review findings\n\n## Review 1\n\n```yaml\nreview: 1\nreviewed_at: 2026-11-01\ncommits: {{ kata: {head} }}\n```\n"
    );
    for (name, text, kind) in [
        ("kata.md", log, "build-log"),
        ("review.md", review, "review"),
    ] {
        let file = folder.join("build").join(name);
        std::fs::write(&file, text).unwrap();
        let answer = plugin(
            &at,
            &[
                "commit",
                "--json",
                "--kind",
                kind,
                "--system",
                SYSTEM,
                "--change",
                CHANGE,
                "--",
                &file.display().to_string(),
            ],
        );
        expect_committed(&answer);
    }

    // Declaring done pushes both repositories to their remotes and opens a pull request in each.
    let readiness = Readiness::Ready {
        plugin: Plugin {
            dir: here(),
            version: "1.1.0".into(),
            layouts: vec![2],
        },
        gh: GhPresence::Present,
    };
    let view = done::declare(
        &program(),
        &at,
        &readiness,
        SYSTEM,
        CHANGE,
        Arc::new(|_| {}),
    );
    match &view {
        DeclareView::Done { pull_requests, .. } => {
            let repos: Vec<&str> = pull_requests.iter().map(|p| p.repo.as_str()).collect();
            assert_eq!(repos, ["kata", "master"], "{}", say("the master's last"));
        }
        other => panic!("{}", say(&format!("nothing refused or stopped: {other:?}"))),
    }
    assert_eq!(fakes.prs().len(), 2, "{}", say("a pull request each"));
    for remote in ["kata-origin.git", "ai-sdlc-origin.git"] {
        let pushed = git(&ws.join(remote), &["branch", "--list", &branch]);
        assert!(
            pushed.contains(&branch),
            "{}",
            say(&format!("{remote} has {branch}"))
        );
    }

    // What the need asked for happened to every commit and file the steps made.
    match need {
        Need::MasterSigns => {
            assert_signed(&say("the master's commits"), &commits_of(&copy, &branch))
        }
        Need::KataSigns => assert_signed(&say("kata's commits"), &commits_of(&kata, &branch)),
        Need::KataFilters => {
            let stored = git(&kata, &["show", &format!("{branch}:data.dat")]);
            assert_eq!(stored, "LFS:payload T3", "{}", say("stored cleaned"));
            std::fs::remove_file(kata.join("data.dat")).unwrap();
            git(&kata, &["checkout", "--", "data.dat"]);
            assert_eq!(
                std::fs::read_to_string(kata.join("data.dat"))
                    .unwrap()
                    .replace("\r\n", "\n"),
                "payload T3\n",
                "{}",
                say("checked out smudged, the file as it was written")
            );
            assert_eq!(
                git(&kata, &["status", "--porcelain"]),
                "",
                "{}",
                say("clean")
            );
        }
    }
}
