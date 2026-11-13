//! R9.1, R9.2 and R9.3: Kata's own work starts no git or GitHub program. The fixtures are built with the git
//! CLI by absolute path; then `PATH` holds a copy of `node` (and, for a Workbench-mode run, the kata
//! binaries) and nothing else, so a flow that still starts `git` or `gh` by name fails, and
//! `kata_core::proc::SpawnLog` records every program Kata starts, so a flow that starts one by full path is
//! caught too. The plugin's own flows start `node`, which may start git itself (D1). Test code may use the
//! git CLI, so the lint is off for this file.
#![allow(clippy::disallowed_methods)]

use kata_core::proc::SpawnLog;
use kata_sdlc::ai_sdlc::{state, Program};
use kata_sdlc::diff::{self, Part};
use kata_sdlc::snapshot::{self, BuildScope};
use kata_sdlc::{branch, build, changes, review};
use serial_test::serial;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const SYS: &str = "s";
const CHG: &str = "2026-10-19-c";
const DRAFT: &str = "2026-10-20-d";

const SPEC: &str = "layout: 2\nsystem: s\nstatus: accepted\nsource_intent_commit: INTENT\n---\n\n# Spec\n\n```gherkin\nFeature: Demo\n  @R1 @from:outcome-1 @from:D2\n  Rule: The engineer sees what changed\n    @R1.1\n    Scenario: What changed after a build\n      Given a build\n      When it ends\n      Then the engineer sees the diff\n```\n";

const PLAN: &str = "layout: 2\nsystem: s\nstatus: accepted\nsource_spec_commit: SPEC\n---\n\n# Plan: c\n\n## Tasks\n\n### T1: First task\n\n```yaml\nid: T1\nrepo: app\ndepends_on: []\nfiles: [x.txt]\ncovers: [R1.1]\n```\n\n#### Change\n\nWrite it.\n\n#### Tests\n\nTest it first.\n\n#### Done when\n\nIt passes.\n\n### T2: Second task\n\n```yaml\nid: T2\nrepo: app\ndepends_on: [T1]\nsupports: [R1.1]\n```\n\n#### Change\n\nUse it.\n\n#### Tests\n\nTest it too.\n\n#### Done when\n\nIt passes.\n\n### T3: Third task\n\n```yaml\nid: T3\nrepo: api\ndepends_on: []\nsupports: [R1.1]\n```\n\n#### Change\n\nUse it.\n\n#### Tests\n\nTest it too.\n\n#### Done when\n\nIt passes.\n";

const REVIEW: &str = "---\nlayout: 2\n---\n\n# Review findings\n\n## Review 1\n\n```yaml\nreview: 1\nreviewed_at: 2026-10-22\ncommits: { app: 840fa0c }\n```\n";

/// The first match of `program` on the real `PATH`, found before the test changes it.
fn find_program(program: &str) -> PathBuf {
    let finder = if cfg!(windows) { "where" } else { "which" };
    let out = Command::new(finder).arg(program).output().unwrap();
    assert!(out.status.success(), "{program} is not on PATH");
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    PathBuf::from(text.lines().next().unwrap().trim())
}

/// Replaces `PATH` for the guard's lifetime and puts it back afterwards.
struct PathOnly {
    old: Option<OsString>,
}

impl PathOnly {
    fn new(dir: &Path) -> Self {
        let old = std::env::var_os("PATH");
        std::env::set_var("PATH", dir);
        PathOnly { old }
    }
}

impl Drop for PathOnly {
    fn drop(&mut self) {
        match &self.old {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
    }
}

/// Points `KATA_HOME` at a folder for the guard's lifetime.
struct KataHome {
    old: Option<OsString>,
}

impl KataHome {
    fn new(dir: &Path) -> Self {
        let old = std::env::var_os("KATA_HOME");
        std::env::set_var("KATA_HOME", dir);
        KataHome { old }
    }
}

impl Drop for KataHome {
    fn drop(&mut self) {
        match &self.old {
            Some(v) => std::env::set_var("KATA_HOME", v),
            None => std::env::remove_var("KATA_HOME"),
        }
    }
}

struct Fx {
    _dir: tempfile::TempDir,
    folder: PathBuf,
    plugin: PathBuf,
    git: PathBuf,
    /// A folder holding a copy of `node` and nothing else.
    only_node: PathBuf,
    home: PathBuf,
}

impl Fx {
    fn repo(&self, name: &str) -> PathBuf {
        self.folder.join(name)
    }

    fn git(&self, repo: &Path, args: &[&str]) -> String {
        let out = Command::new(&self.git)
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn write(&self, repo: &str, rel: &str, text: &str) {
        let file = self.repo(repo).join(rel);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }

    fn commit(&self, repo: &str, rel: &str, text: &str, message: &str) -> String {
        self.write(repo, rel, text);
        let path = self.repo(repo);
        self.git(&path, &["add", "--", rel]);
        self.git(&path, &["commit", "-q", "-m", message]);
        self.git(&path, &["rev-parse", "HEAD"])
    }

    fn init(&self, name: &str) {
        let path = self.repo(name);
        fs::create_dir_all(&path).unwrap();
        self.git(&path, &["init", "-q", "-b", "main"]);
        self.git(&path, &["config", "user.name", "Test"]);
        self.git(&path, &["config", "user.email", "test@example.com"]);
        self.git(&path, &["config", "commit.gpgsign", "false"]);
    }

    /// A bare `origin` beside the repository, with `main` pushed and `origin/HEAD` set; the remote URL
    /// reads as GitHub, and a push to it lands in the bare folder.
    fn origin(&self, name: &str) -> PathBuf {
        let path = self.repo(name);
        let bare = self.folder.join(format!("{name}-origin.git"));
        self.git(
            &self.folder,
            &["init", "-q", "--bare", bare.to_str().unwrap()],
        );
        self.git(&path, &["remote", "add", "origin", bare.to_str().unwrap()]);
        self.git(&path, &["push", "-q", "origin", "main"]);
        self.git(&path, &["fetch", "-q", "origin"]);
        self.git(&path, &["remote", "set-head", "origin", "main"]);
        let url = format!("https://github.com/o/{name}.git");
        let key = format!(
            "url.{}.pushInsteadOf",
            bare.to_string_lossy().replace('\\', "/")
        );
        self.git(&path, &["config", &key, &url]);
        self.git(&path, &["remote", "set-url", "origin", &url]);
        bare
    }
}

/// A workspace with a master `m` on `change/<CHG>` (an accepted intent, spec and plan, a build log for `app`
/// and a review document; a second change with a draft intent), and product repositories `app` (the
/// change branch with one commit) and `api` (no change branch), each with a bare `origin`.
fn fixture() -> Fx {
    fixture_on(&format!("change/{CHG}"), false)
}

/// The same workspace with the change on `branch`; with `record` the master commits a `branch.md`
/// naming it first.
fn fixture_on(branch: &str, record: bool) -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let node = find_program("node");
    let only_node = dir.path().join("only-node");
    fs::create_dir_all(&only_node).unwrap();
    fs::copy(&node, only_node.join(node.file_name().unwrap())).unwrap();
    let home = dir.path().join("kata-home");
    fs::create_dir_all(&home).unwrap();
    let fx = Fx {
        folder: dir.path().join("ws"),
        plugin: dir.path().join("plugin"),
        git: find_program("git"),
        only_node,
        home,
        _dir: dir,
    };
    fs::create_dir_all(&fx.folder).unwrap();
    copy_dir(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools"),
        &fx.plugin.join("tools"),
    );
    fs::create_dir_all(fx.plugin.join(".claude-plugin")).unwrap();
    fs::write(
        fx.plugin.join(".claude-plugin/plugin.json"),
        format!(
            r#"{{"name":"ai-sdlc","version":"{}"}}"#,
            kata_sdlc::plugin::MIN_VERSION
        ),
    )
    .unwrap();

    for name in ["m", "app", "api"] {
        fx.init(name);
        fx.commit(name, "README.md", "init\n", "init");
    }
    fx.commit(
        "m",
        ".ai-sdlc.json",
        "{\"version\":1,\"systems\":{\"s\":{\"repos\":[\"app\",\"api\"]}}}\n",
        "marker",
    );
    let dir = format!("intent/{SYS}/{CHG}");
    let intent = fx.commit(
        "m",
        &format!("{dir}/intent.md"),
        "---\nstatus: accepted\ntitle: Build the thing\n---\nbody\n",
        "docs(s): accept intent",
    );
    let spec = fx.commit(
        "m",
        &format!("{dir}/spec.md"),
        &format!("---\n{}", SPEC.replace("INTENT", &intent)),
        "docs(s): accept spec",
    );
    fx.commit(
        "m",
        &format!("intent/{SYS}/{DRAFT}/intent.md"),
        "---\nstatus: draft\n---\nbody\n",
        "docs(s): draft intent",
    );
    if record {
        fx.commit(
            "m",
            &format!("{dir}/branch.md"),
            &format!(
                "---
branch: {branch}
type: feat
---

Kata writes this file.
"
            ),
            "docs(s): name branch

Generated-By: ai-sdlc",
        );
    }
    for name in ["m", "app", "api"] {
        fx.origin(name);
    }
    let master = fx.repo("m");
    fx.git(&master, &["checkout", "-q", "-b", branch]);
    fx.commit(
        "m",
        &format!("{dir}/plan.md"),
        &format!("---\n{}", PLAN.replace("SPEC", &spec)),
        "docs(s): accept plan

Generated-By: ai-sdlc",
    );
    let app = fx.repo("app");
    fx.git(&app, &["checkout", "-q", "-b", branch]);
    let work = fx.commit(
        "app",
        "x.txt",
        "x\n",
        "feat(s): own work\n\nGenerated-By: ai-sdlc\nPlan-Task: T1",
    );
    let short = &work[..7];
    fx.commit(
        "m",
        &format!("{dir}/build/app.md"),
        &format!(
            "---\nlayout: 2\n---\n\n# Build log: app\n\n### T1\n\n```yaml\ntask: T1\ncommits: [{short}]\n```\n"
        ),
        "docs(s): record T1

Generated-By: ai-sdlc",
    );
    fx.commit(
        "m",
        &format!("{dir}/build/review.md"),
        REVIEW,
        "docs(s): review

Generated-By: ai-sdlc",
    );
    fx
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// The programs Kata started while the log was open, each once, sorted.
fn started(log: &SpawnLog) -> Vec<String> {
    let mut programs = log.programs();
    programs.sort();
    programs.dedup();
    programs
}

#[test]
#[serial]
fn kata_starts_no_git_or_gh_itself() {
    kata_flows(&format!("change/{CHG}"), false);
}

#[test]
#[serial]
fn kata_starts_no_git_or_gh_itself_with_a_recorded_branch() {
    kata_flows("feat/PROJ-123-password-reset", true);
}

/// Every flow the AI-SDLC mode still runs itself, with `PATH` holding only `node`: each one works, and the
/// only program any of them starts is `node` (the plugin's format program). Then the plugin's own `state`,
/// which starts git itself (D1), with git's folder added: Kata still starts only `node`.
fn kata_flows(branch_name: &str, record: bool) {
    let fx = fixture_on(branch_name, record);
    let _home = KataHome::new(&fx.home);
    let master = fx.repo("m");
    let app = fx.repo("app");
    let path = PathOnly::new(&fx.only_node);
    let log = SpawnLog::open();

    // The home page and the change page: the branches and the documents.
    let branches = branch::branch_info(&master);
    assert_eq!(branches.current.as_deref(), Some(branch_name));
    assert!(changes::read_doc(&master, SYS, CHG, "intent")
        .unwrap()
        .contains("Build the thing"));
    let parsed = changes::read_parsed(&fx.plugin, &master, SYS, CHG, "plan").unwrap();
    assert!(parsed.is_some());

    // The build page: the rows, the review, the heads of the change branches.
    let status = build::status(&fx.plugin, &master, SYS, CHG).unwrap();
    assert!(
        status.tasks.iter().any(|t| t.id == "T1" && t.row.is_some()),
        "{status:?}"
    );
    let record = review::record(&fx.plugin, &master, SYS, CHG)
        .unwrap()
        .expect("the review document is there");
    assert_eq!(record.reviews.len(), 1);
    let heads = branch::heads(
        &fx.folder,
        &master,
        "m",
        SYS,
        &["app".to_string(), "api".to_string()],
        CHG,
    )
    .unwrap();
    assert_eq!(heads.keys().collect::<Vec<_>>(), ["app"]);

    // What changed: the repositories, their files, the commits and the base.
    let repos = diff::change_repos(&fx.folder, &master, "m", SYS, CHG).unwrap();
    let listed: Vec<&str> = repos.iter().map(|r| r.repo.as_str()).collect();
    assert_eq!(listed, ["m", "app"]);
    let missing =
        branch::missing_change_branches(&fx.plugin, &fx.folder, &master, "m", SYS, CHG).unwrap();
    assert_eq!(missing, ["api"]);
    let files = diff::changed_files(&app, Part::Whole).unwrap();
    assert!(files.iter().any(|f| f.path == "x.txt"), "{files:?}");
    let pair = diff::file_pair(&app, Part::Whole, "x.txt").unwrap();
    assert_eq!(pair.modified.trim(), "x");
    assert_eq!(diff::commit_files(&app).unwrap().len(), 1);
    assert_eq!(diff::base_info(&app).unwrap().base, "main");

    // Stray document edits are put back.
    let before = snapshot::take(&master).unwrap();
    let plan_rel = format!("intent/{SYS}/{CHG}/plan.md");
    let committed = fs::read_to_string(master.join(&plan_rel)).unwrap();
    fs::write(master.join(&plan_rel), format!("{committed}\nstray\n")).unwrap();
    let scope = BuildScope {
        system: SYS.into(),
        change: CHG.into(),
    };
    let left =
        snapshot::leftovers(&master, &before, std::slice::from_ref(&app), Some(&scope)).unwrap();
    assert!(left.discardable.iter().any(|f| f == &plan_rel), "{left:?}");
    snapshot::discard(
        &master,
        &before,
        std::slice::from_ref(&plan_rel),
        Some(&scope),
    )
    .unwrap();
    // Line endings follow the machine's autocrlf, as a git checkout does.
    let restored = fs::read_to_string(master.join(&plan_rel)).unwrap();
    assert_eq!(
        restored.replace("\r\n", "\n"),
        committed.replace("\r\n", "\n")
    );

    // The home page's switch to another change's branch.
    branch::checkout(&master, "main").unwrap();
    assert_eq!(
        branch::branch_info(&master).current.as_deref(),
        Some("main")
    );

    // Run mode: an isolated copy for a run-spec and the summary of what a run changed.
    let root = fx.folder.join("worktrees");
    let wt = kata_core::worktree::create_in(app.to_str().unwrap(), "run", &root).unwrap();
    fs::write(Path::new(&wt.path).join("new.txt"), "n\n").unwrap();
    let summary = kata_core::changeset::diff_at(Path::new(&wt.path)).unwrap();
    assert_eq!(summary.files.len(), 1);
    assert_eq!(started(&log), ["node"]);

    // The plugin's state, which the home page and the change page read: node, which starts git itself.
    drop(path);
    let git_dir = fx.git.parent().unwrap().to_path_buf();
    let joined = std::env::join_paths([&fx.only_node, &git_dir]).unwrap();
    let _path = PathOnly::new(Path::new(&joined));
    let program = Program::locate(&fx.plugin);
    let system = state::state(&program, &fx.folder, SYS, None).unwrap();
    let names: Vec<&str> = system.changes.iter().map(|c| c.change.as_str()).collect();
    assert!(names.contains(&CHG) && names.contains(&DRAFT), "{names:?}");
    assert_eq!(started(&log), ["node"]);
}

#[test]
#[serial]
fn home_and_change_page_read_without_git() {
    let fx = fixture();
    let master = fx.repo("m");
    let read = |fx: &Fx| {
        (
            serde_json::to_value(
                changes::read_parsed(&fx.plugin, &master, SYS, CHG, "spec").unwrap(),
            )
            .unwrap(),
            serde_json::to_value(branch::branch_info(&master)).unwrap(),
            changes::read_doc(&master, SYS, CHG, "spec"),
        )
    };
    let with_git = read(&fx);
    assert!(!with_git.0.is_null());
    let without_git = {
        let _path = PathOnly::new(&fx.only_node);
        read(&fx)
    };
    assert_eq!(with_git, without_git);
}

/// The target folder the test binaries are built into: `kata` and `fake-claude` sit there too.
fn target_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let name = format!("fake-claude{}", std::env::consts::EXE_SUFFIX);
    kata_core::fsutil::find_upward(exe.parent().unwrap(), &name)
        .unwrap_or_else(|| {
            panic!(
                "build fake-claude first (cargo build -p kata-core --bin fake-claude); none found above {}",
                exe.display()
            )
        })
        .parent()
        .unwrap()
        .to_path_buf()
}

/// R9.2: a job composed and run in the Workbench mode, which the Workbench and CI both run through the
/// kata program, works with neither git nor GitHub's command-line tool installed: `PATH` holds only
/// `node` and the kata binaries. The job runs worktree-isolated in a git repository, so the isolated copy,
/// the run's diff and the copy's clean-up all happen.
#[test]
#[serial]
fn the_workbench_mode_runs_without_git_or_gh() {
    let exe = |name: &str| target_dir().join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    let (kata, fake) = (exe("kata"), exe("fake-claude"));
    assert!(
        kata.exists() && fake.exists(),
        "build the kata binaries first (cargo build): {} {}",
        kata.display(),
        fake.display()
    );
    let fx = fixture();
    let bin = fx.folder.join("bin");
    fs::create_dir_all(&bin).unwrap();
    for (from, name) in [(&kata, "kata"), (&fake, "claude")] {
        fs::copy(
            from,
            bin.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)),
        )
        .unwrap();
    }
    let path = std::env::join_paths([&fx.only_node, &bin]).unwrap();

    let work = fx.repo("app");
    let spec = fx.folder.join("job.toml");
    fs::write(
        &spec,
        format!(
            "schema = 1\nname = \"job\"\ntask = \"write a file\"\nworkdir = {:?}\n\n[leash]\nisolation = \"worktree\"\n",
            work.to_string_lossy().replace('\\', "/")
        ),
    )
    .unwrap();
    let out = Command::new(bin.join(format!("kata{}", std::env::consts::EXE_SUFFIX)))
        .arg("run")
        .arg(&spec)
        .current_dir(&work)
        .env("PATH", &path)
        .env("KATA_HOME", &fx.home)
        .env("KATA_FAKE_MODE", "writefile")
        .env_remove("KATA_CLAUDE_BIN")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let events: Vec<serde_json::Value> = stdout
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let of = |kind: &str| events.iter().find(|e| e["type"] == kind);
    let started = of("run.started").expect("the run starts");
    assert_eq!(started["isolation"], "worktree", "{started}");
    let diff = of("run.diff").expect("the run reports what it changed");
    assert_eq!(diff["files"][0]["path"], "agent-made.txt", "{diff}");
    let completed = of("run.completed").expect("the run completes");
    assert_eq!(completed["exit_code"], 0, "{completed}");
    // The agent's file landed in the isolated copy, not the repository itself.
    assert!(!work.join("agent-made.txt").exists());
}
