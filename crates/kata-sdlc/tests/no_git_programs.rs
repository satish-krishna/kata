//! R9.1 and R9.3: the Workbench's own work starts no git or GitHub program. The fixtures are built with
//! the git CLI by absolute path; then `PATH` holds a copy of `node` and nothing else, so a flow that still
//! starts `git` or `gh` by name fails. Test code may use the git CLI, so the lint is off for this file.
#![allow(clippy::disallowed_methods)]

use kata_sdlc::build::BuildAction;
use kata_sdlc::decide::{self, DecideOutcome, Decision};
use kata_sdlc::diff::{self, Part};
use kata_sdlc::github::{ApiError, Credential, GitHub, GitHubHosts, Pull, PullState};
use kata_sdlc::publish::{self, PrOutcome, Recorder};
use kata_sdlc::snapshot::{self, BuildScope};
use kata_sdlc::start::{self, PrepareOutcome};
use kata_sdlc::{base, build, changes, prs, review};
use serial_test::serial;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

const SYS: &str = "s";
const CHG: &str = "2026-10-19-c";
const DRAFT: &str = "2026-10-20-d";
const WS: &str = "w1";

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
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-format"),
        &fx.plugin.join("format"),
    );
    fs::create_dir_all(fx.plugin.join(".claude-plugin")).unwrap();
    fs::write(
        fx.plugin.join(".claude-plugin/plugin.json"),
        format!(
            r#"{{"name":"ai-sdlc","version":"{}"}}"#,
            kata_sdlc::plugin::LIGHT_TRACK_VERSION
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
    for name in ["m", "app", "api"] {
        fx.origin(name);
    }
    let master = fx.repo("m");
    fx.git(&master, &["checkout", "-q", "-b", &format!("change/{CHG}")]);
    fx.commit(
        "m",
        &format!("{dir}/plan.md"),
        &format!("---\n{}", PLAN.replace("SPEC", &spec)),
        "docs(s): accept plan

Generated-By: ai-sdlc",
    );
    let app = fx.repo("app");
    fx.git(&app, &["checkout", "-q", "-b", &format!("change/{CHG}")]);
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

/// A GitHub that answers like an account named octo and numbers the pull requests it opens.
#[derive(Clone, Default)]
struct Hub(Arc<Mutex<(u64, Vec<String>)>>);

impl GitHub for Hub {
    fn user(&self) -> Result<String, ApiError> {
        Ok("octo".into())
    }
    fn repo(&self, _owner: &str, _name: &str) -> Result<(), ApiError> {
        Ok(())
    }
    fn open_pull_for_branch(
        &self,
        _owner: &str,
        _name: &str,
        _branch: &str,
    ) -> Result<Option<Pull>, ApiError> {
        Ok(None)
    }
    fn create_pull(
        &self,
        owner: &str,
        name: &str,
        _base: &str,
        _head: &str,
        _title: &str,
        _body: &str,
    ) -> Result<Pull, ApiError> {
        let mut s = self.0.lock().unwrap();
        s.0 += 1;
        let url = format!("https://github.com/{owner}/{name}/pull/{}", s.0);
        s.1.push(url.clone());
        Ok(Pull { number: s.0, url })
    }
    fn edit_pull_body(&self, _: &str, _: &str, _: u64, _: &str) -> Result<(), ApiError> {
        Ok(())
    }
    fn pull_state(&self, _: &str, _: &str, _: u64) -> Result<PullState, ApiError> {
        Ok(PullState {
            state: "closed".into(),
            merged: true,
        })
    }
}

struct Hosts(Hub);

impl GitHubHosts for Hosts {
    fn github(&self, _host: &str) -> Option<Box<dyn GitHub>> {
        Some(Box::new(self.0.clone()))
    }
    fn credential(&self, _host: &str) -> Option<Credential> {
        None
    }
}

#[test]
#[serial]
fn every_flow_runs_with_no_git_or_gh_on_path() {
    let fx = fixture();
    let _home = KataHome::new(&fx.home);
    let master = fx.repo("m");
    let app = fx.repo("app");
    let _path = PathOnly::new(&fx.only_node);

    // The home page and the change page: list the changes and read stages; read one change.
    let list = changes::list(Some(&fx.plugin), &master, SYS);
    let names: Vec<&str> = list.iter().map(|c| c.change.as_str()).collect();
    assert_eq!(names, [DRAFT, CHG]);
    assert!(
        !list[1].plan_unreadable,
        "{:?}",
        list[1].plan_unreadable_reason
    );
    assert_eq!(list[1].build.tasks, 3);
    let branches = changes::branch_info(&master);
    assert_eq!(
        branches.current.as_deref(),
        Some(format!("change/{CHG}").as_str())
    );
    assert!(changes::read_doc(&master, SYS, CHG, "intent")
        .unwrap()
        .contains("Build the thing"));
    let parsed = changes::read_parsed(&fx.plugin, &master, SYS, CHG, "plan").unwrap();
    assert!(parsed.is_some());
    let status = build::status(&fx.plugin, &master, SYS, CHG).unwrap();
    assert!(
        status.tasks.iter().any(|t| t.id == "T1" && t.row.is_some()),
        "{status:?}"
    );
    assert!(build::unsaved_rows(&fx.plugin, &master, SYS, CHG)
        .unwrap()
        .is_empty());
    let record = review::record(&fx.plugin, &master, SYS, CHG)
        .unwrap()
        .expect("the review document is there");
    assert_eq!(record.reviews.len(), 1);

    // Accept a document.
    assert_eq!(
        decide::apply(&master, SYS, DRAFT, Decision::AcceptIntent, false).unwrap(),
        DecideOutcome::Committed
    );

    // Prepare and settle a build: the repository with no commits on its change branch gives it back.
    let begun = start::prepare(
        &fx.plugin,
        &fx.folder,
        "m",
        SYS,
        CHG,
        BuildAction::Continue,
        false,
        None,
    )
    .unwrap();
    let PrepareOutcome::Ready { start: begun } = begun else {
        panic!("expected Ready, got {begun:?}");
    };
    assert!(fx.repo("api").join("README.md").exists());
    let gone = start::settle(&begun).unwrap();
    assert_eq!(gone, ["api"]);
    start::heads(&fx.folder, &["app".to_string()], CHG).unwrap();

    // What changed.
    let files = diff::changed_files(&app, Part::Whole).unwrap();
    assert!(files.iter().any(|f| f.path == "x.txt"), "{files:?}");
    let pair = diff::file_pair(&app, Part::Whole, "x.txt").unwrap();
    assert_eq!(pair.modified.trim(), "x");
    let commits = diff::commit_files(&app).unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(base::base_info(&app).unwrap().base, "main");

    // Stray document edits are put back.
    let before = snapshot::take(&master).unwrap();
    let plan_rel = format!("intent/{SYS}/{CHG}/plan.md");
    let committed = fs::read_to_string(master.join(&plan_rel)).unwrap();
    fs::write(master.join(&plan_rel), format!("{committed}\nstray\n")).unwrap();
    let scope = BuildScope {
        system: SYS.into(),
        change: CHG.into(),
    };
    let left = snapshot::leftovers(&master, &before, &[app.clone()], Some(&scope)).unwrap();
    assert!(left.discardable.iter().any(|f| f == &plan_rel), "{left:?}");
    snapshot::discard(&master, &before, &[plan_rel.clone()], Some(&scope)).unwrap();
    // Line endings follow the machine's autocrlf, as a git checkout does.
    let restored = fs::read_to_string(master.join(&plan_rel)).unwrap();
    assert_eq!(
        restored.replace("\r\n", "\n"),
        committed.replace("\r\n", "\n")
    );

    // Declare done: touched repositories, commit rules, sign-in, origins, pull requests.
    let touched = publish::touched_repos(&fx.folder, "m", SYS, CHG).unwrap();
    let repos: Vec<&str> = touched.iter().map(|r| r.repo.as_str()).collect();
    assert_eq!(repos, ["app", "m"]);
    let offenders = publish::change_offenders(&fx.folder, "m", SYS, CHG).unwrap();
    assert!(offenders.is_empty(), "{offenders:?}");
    let hub = Hub::default();
    let hosts = Hosts(hub.clone());
    assert!(publish::signed_in(&hosts, &touched)
        .unwrap()
        .contains("octo"));
    publish::origins(&hosts, &touched).unwrap();
    let results = publish::publish(
        &hosts,
        "m",
        SYS,
        CHG,
        &touched,
        &mut Recorder::stored(WS, SYS, CHG),
        &mut |_| {},
    );
    for r in &results {
        assert!(matches!(r.outcome, PrOutcome::Opened { .. }), "{results:?}");
    }
    for name in ["app", "m"] {
        let bare = fx.folder.join(format!("{name}-origin.git"));
        // The push landed in the bare origin (checked with the git CLI by absolute path).
        fx.git(
            &bare,
            &["rev-parse", "--verify", &format!("refs/heads/change/{CHG}")],
        );
    }

    // Reopen the done change: the pull request states are looked up.
    let view = prs::refresh_states(&hosts, &fx.folder, "m", WS, SYS, CHG, true).unwrap();
    assert_eq!(view.links.len(), 2, "{view:?}");

    // Run mode: an isolated copy for a run-spec and the summary of what a run changed.
    let root = fx.folder.join("worktrees");
    let wt = kata_core::worktree::create_in(app.to_str().unwrap(), "run", &root).unwrap();
    fs::write(Path::new(&wt.path).join("new.txt"), "n\n").unwrap();
    let summary = kata_core::changeset::diff_at(Path::new(&wt.path)).unwrap();
    assert_eq!(summary.files.len(), 1);
}

#[test]
#[serial]
fn home_and_change_page_read_without_git() {
    let fx = fixture();
    let master = fx.repo("m");
    let read = |fx: &Fx| {
        (
            changes::list(Some(&fx.plugin), &master, SYS),
            serde_json::to_value(changes::branch_info(&master)).unwrap(),
            changes::read_doc(&master, SYS, CHG, "spec"),
        )
    };
    let with_git = read(&fx);
    assert_eq!(with_git.0.len(), 2);
    let without_git = {
        let _path = PathOnly::new(&fx.only_node);
        read(&fx)
    };
    assert_eq!(with_git.0, without_git.0);
    assert_eq!(with_git.1, without_git.1);
    assert_eq!(with_git.2, without_git.2);
}
