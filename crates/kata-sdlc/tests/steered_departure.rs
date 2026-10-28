//! R6.3: off-plan work an operator message causes in a build surfaces through the existing departure
//! path. The build skill, the plan and the build log format are unchanged, so this pins that path.
//!
//! These tests run the vendored copy of the plugin's format program in `tests/ai-sdlc-format/`.
#![allow(clippy::disallowed_methods)]
use kata_sdlc::build::{self, Departure};
use kata_sdlc::format;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const SYS: &str = "kata";
const CHG: &str = "2026-10-27-steered";
const STEERED: &str = "The operator asked mid-run to also rename the helper parse_name to read_name, which the plan does not mention; renamed it in src/helper.rs and its two callers.";
const ORDINARY: &str = "Used a queue because the list blocked.";

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
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-format"),
        &dir.join("format"),
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

/// A master repository whose `HEAD` holds the fixture change, its build log's departure replaced by
/// `departure` when given. Returns the master and the change folder inside it.
fn master(tmp: &Path, name: &str, departure: Option<&str>) -> (PathBuf, PathBuf) {
    let master = tmp.join(name);
    let change = master.join(format!("intent/{SYS}/{CHG}"));
    copy_dir(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/steered-departure"),
        &change,
    );
    if let Some(text) = departure {
        let log = change.join("build/kata.md");
        let old = fs::read_to_string(&log).unwrap().replace("\r\n", "\n");
        let new = old.replace(STEERED, text);
        assert_ne!(old, new, "the fixture's departure text moved");
        fs::write(&log, new).unwrap();
    }
    git(&master, &["init", "-q", "-b", "main"]);
    git(&master, &["config", "user.name", "Test"]);
    git(&master, &["config", "user.email", "test@example.com"]);
    git(&master, &["config", "commit.gpgsign", "false"]);
    git(&master, &["add", "."]);
    git(&master, &["commit", "-q", "-m", "change"]);
    (master, change)
}

fn only_departure(status: &build::BuildStatus) -> &Departure {
    assert_eq!(status.departures.len(), 1, "{:?}", status.departures);
    &status.departures[0]
}

#[test]
fn operator_caused_departure_reads_like_any_other() {
    let tmp = tempfile::tempdir().unwrap();
    let plugin = plugin(tmp.path());
    let (steered_master, change) = master(tmp.path(), "steered", None);
    let (ordinary_master, _) = master(tmp.path(), "ordinary", Some(ORDINARY));

    let plan = change.join("plan.md");
    let plan_before = fs::read(&plan).unwrap();

    let steered = build::status(&plugin, &steered_master, SYS, CHG).unwrap();
    let ordinary = build::status(&plugin, &ordinary_master, SYS, CHG).unwrap();

    // The departure text comes back for the task, exactly as written (a block scalar keeps its
    // final line break out of the value).
    let d = only_departure(&steered);
    assert_eq!((d.task.as_str(), d.repo.as_str()), ("T1", "kata"));
    assert_eq!(d.departure, STEERED);
    assert!(d.plan_text.starts_with("### T1: Report the helper name"));

    // The plan is not edited by the read.
    assert_eq!(fs::read(&plan).unwrap(), plan_before);

    // The format program reports no problem, neither in the read nor in its own check.
    assert!(steered.problems.is_empty(), "{:?}", steered.problems);
    let program = plugin.join("format/check.mjs");
    let problems =
        format::check_change(&program, &change, &["spec.md", "plan.md", "build/kata.md"]).unwrap();
    assert!(problems.is_empty(), "{problems:?}");

    // It reads the same way as an ordinary departure: the same fields, the same plan text, the
    // text verbatim, and no extra problem.
    let o = only_departure(&ordinary);
    assert_eq!(o.departure, ORDINARY);
    assert_eq!(
        (&d.task, &d.repo, &d.plan_text),
        (&o.task, &o.repo, &o.plan_text)
    );
    assert_eq!(steered.problems, ordinary.problems);
    assert_eq!(steered.tasks.len(), ordinary.tasks.len());
    assert_eq!(steered.has_tasks, ordinary.has_tasks);
}
