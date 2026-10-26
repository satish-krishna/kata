//! The cross-document check's cache. This file holds one test on purpose: `format::runs_started` counts
//! every start in the process, so a second test running beside it would skew the count.
#![allow(clippy::disallowed_methods)]
use kata_sdlc::{build, format};
use std::path::Path;
use std::process::Command;

fn git(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

fn commit(repo: &Path, rel: &str, text: &str) {
    let file = repo.join(rel);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, text).unwrap();
    git(repo, &["add", "--", rel]);
    git(repo, &["commit", "-q", "-m", "x"]);
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

#[test]
fn two_status_calls_on_an_unchanged_change_start_the_check_once() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin = tmp.path().join("plugin");
    copy_dir(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-format"),
        &plugin.join("format"),
    );
    let repo = tmp.path().join("master");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.name", "Test"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    let rel = "intent/demo/2026-10-12-one/plan.md";
    let plan = include_str!("ai-sdlc-format/examples/plan/2/valid.md");
    commit(&repo, rel, plan);

    // The first status reads the plan and checks the change.
    let cold = format::runs_started();
    build::status(&plugin, &repo, "demo", "2026-10-12-one").unwrap();
    assert!(format::runs_started() > cold);

    // Nothing changed: no program starts at all.
    let before = format::runs_started();
    build::status(&plugin, &repo, "demo", "2026-10-12-one").unwrap();
    assert_eq!(format::runs_started() - before, 0);

    // A changed document is read and checked again.
    commit(&repo, rel, &format!("{plan}\nA later line.\n"));
    let before = format::runs_started();
    build::status(&plugin, &repo, "demo", "2026-10-12-one").unwrap();
    assert!(format::runs_started() > before);
}
