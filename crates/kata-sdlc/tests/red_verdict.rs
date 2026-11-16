//! Each task's red verdict, decided in Rust from the plan's `test` fields and the build log's `red`
//! field, read through the vendored copy of the plugin's format program in `tests/hoshin-tools/`.
#![allow(clippy::disallowed_methods)]
use kata_sdlc::build::{self, RedVerdict};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const SYS: &str = "kata";
const CHG: &str = "2026-11-15-red";

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

fn plugin(tmp: &Path) -> PathBuf {
    let dir = tmp.join("plugin");
    copy_dir(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/hoshin-tools"),
        &dir.join("tools"),
    );
    dir
}

fn git(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

/// A master repository whose `HEAD` holds `files` (path inside the change folder, text).
fn master(tmp: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
    let master = tmp.join(name);
    let change = master.join(format!("intent/{SYS}/{CHG}"));
    for (rel, text) in files {
        let path = change.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    git(tmp, &["init", "-q", "-b", "main", name]);
    git(&master, &["config", "user.name", "Test"]);
    git(&master, &["config", "user.email", "test@example.com"]);
    git(&master, &["config", "commit.gpgsign", "false"]);
    git(&master, &["add", "."]);
    git(&master, &["commit", "-q", "-m", "change"]);
    master
}

fn task(id: &str, test: bool) -> String {
    let test = if test { "test: [cargo, test]\n" } else { "" };
    format!(
        "### {id}: Task {id}\n\n```yaml\nid: {id}\nrepo: kata\ndepends_on: []\nuses: []\nfiles: [src/{id}.rs]\ncovers: [R1.1]\n{test}```\n\n#### Change\n\nDo it.\n\n#### Tests\n\nTest it.\n\n#### Done when\n\nIt passes.\n\n"
    )
}

#[test]
fn red_verdicts_come_from_the_plan_and_the_build_log() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin = plugin(tmp.path());
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/steered-departure");
    let spec = fs::read_to_string(fixture.join("spec.md")).unwrap();
    let plan = format!(
        "---\nlayout: 2\nsource_spec: 2026-11-15-red/spec.md\nsource_spec_commit: 0123456789abcdef0123456789abcdef01234567\nsystem: kata\ndate: 2026-11-15\nauthor: Test\nstatus: accepted\n---\n\n# Plan: Red\n\n## Tasks\n\n{}{}{}",
        task("T1", true),
        task("T2", true),
        task("T3", false)
    );
    let log = "---\nlayout: 2\n---\n\n# Build log: kata\n\n### T1\n\n```yaml\ntask: T1\ncommits: [\"a111111\"]\nred: observed\n```\n\n### T2\n\n```yaml\ntask: T2\ncommits: [\"b222222\"]\nred: \"not observed: the test passed at abc1234, before the production code\"\n```\n\n### T3\n\n```yaml\ntask: T3\ncommits: [\"c333333\"]\n```\n";
    let master = master(
        tmp.path(),
        "m",
        &[
            ("spec.md", &spec),
            ("plan.md", &plan),
            ("build/kata.md", log),
        ],
    );

    let status = build::status(&plugin, &master, SYS, CHG).unwrap();
    assert!(status.problems.is_empty(), "{:?}", status.problems);
    assert!(status.red_shown);
    let reds: Vec<_> = status.tasks.iter().map(|t| t.red.clone()).collect();
    assert_eq!(
        reds,
        vec![
            Some(RedVerdict::Observed),
            Some(RedVerdict::NotObserved {
                reason: "the test passed at abc1234, before the production code".into()
            }),
            Some(RedVerdict::NoTest),
        ]
    );
    let stands_out: Vec<_> = status.tasks.iter().map(|t| t.red_stands_out).collect();
    assert_eq!(stands_out, vec![false, true, false]);
    let wanted: Vec<_> = status.tasks.iter().map(|t| t.red_record_wanted).collect();
    assert_eq!(wanted, vec![false, true, false]);
}

#[test]
fn an_older_plan_and_log_show_no_red_at_all() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin = plugin(tmp.path());
    let plan = "---\nstatus: accepted\n---\n\n# Plan: x\n\n## Tasks\n\n### T1: Do T1 (`kata`)\n\n- **Depends on:** none\n- **Change:** something\n\n### T2: Do T2 (`kata`)\n\n- **Depends on:** T1\n- **Change:** something\n\n## Order and dependencies\n\nNone.\n";
    let log = "# Build log: kata\n\n| Task | Commits | Departure |\n|---|---|---|\n| T1 | abc1234 | none |\n";
    let master = master(
        tmp.path(),
        "old",
        &[("plan.md", plan), ("build/kata.md", log)],
    );

    let status = build::status(&plugin, &master, SYS, CHG).unwrap();
    assert!(status.problems.is_empty(), "{:?}", status.problems);
    assert!(!status.red_shown);
    assert_eq!(status.tasks.len(), 2);
    assert!(status.tasks.iter().all(|t| t.red.is_none()));
    assert!(status.tasks.iter().all(|t| !t.red_stands_out));
    assert!(status.tasks.iter().all(|t| !t.red_record_wanted));
}
