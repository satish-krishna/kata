//! The format reader's caches. `format::runs_started` counts every start in the process and the tests set `KATA_HOME`,
//! so every test here is `#[serial]`.
#![allow(clippy::disallowed_methods)]
use kata_sdlc::format::{self, Reads};
use serial_test::serial;
use std::path::PathBuf;

#[test]
#[serial]
fn the_same_bytes_read_from_two_paths_start_the_program_once() {
    let program = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-format/check.mjs");
    let plan = include_str!("ai-sdlc-format/examples/plan/2/valid.md");
    let tmp = tempfile::tempdir().unwrap();
    let mut files = Vec::new();
    for change in ["first-change", "second-change"] {
        let file = tmp.path().join(change).join("plan.md");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, plan).unwrap();
        files.push(file);
    }

    let before = format::runs_started();
    let first = format::read(&program, &files[0]).unwrap();
    let second = format::read(&program, &files[1]).unwrap();

    assert_eq!(first, second);
    assert_eq!(format::runs_started() - before, 1);
}

/// Points `KATA_HOME` at a folder of its own for the test, and puts the old value back after.
struct Home {
    _dir: tempfile::TempDir,
    old: Option<std::ffi::OsString>,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let old = std::env::var_os("KATA_HOME");
        std::env::set_var("KATA_HOME", dir.path());
        Home { _dir: dir, old }
    }

    fn cache(&self) -> PathBuf {
        self._dir.path().join("workbench").join("parse-cache")
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        match &self.old {
            Some(v) => std::env::set_var("KATA_HOME", v),
            None => std::env::remove_var("KATA_HOME"),
        }
    }
}

fn program() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-format/check.mjs")
}

/// A change folder holding the valid plan, and the plan's path. Each call ends the plan with a line of its
/// own, so no test finds another's answer in the in-memory cache.
fn plan_in(root: &std::path::Path) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let file = root.join("a-change").join("plan.md");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let text = include_str!("ai-sdlc-format/examples/plan/2/valid.md");
    std::fs::write(
        &file,
        format!(
            "{text}
<!-- test {n} -->
"
        ),
    )
    .unwrap();
    file
}

fn task_ids(result: &format::ReadResult) -> Vec<String> {
    match result {
        format::ReadResult::Plan { document, .. } => {
            document.tasks.iter().map(|t| t.id.clone()).collect()
        }
        other => panic!("not a plan: {other:?}"),
    }
}

#[test]
#[serial]
fn shown_reads_survive_a_restart() {
    let _home = Home::new();
    let tmp = tempfile::tempdir().unwrap();
    let plan = plan_in(tmp.path());

    let first = format::read_with(&program(), &plan, Reads::Shown).unwrap();
    let before = format::runs_started();
    format::forget_memory_cache();
    let second = format::read_with(&program(), &plan, Reads::Shown).unwrap();

    assert_eq!(first, second);
    assert_eq!(format::runs_started(), before);
}

#[test]
#[serial]
fn gate_reads_never_use_the_disk() {
    let home = Home::new();
    let tmp = tempfile::tempdir().unwrap();
    let plan = plan_in(tmp.path());
    let real = format::read_with(&program(), &plan, Reads::Shown).unwrap();

    // Plant an entry with a different task list under the plan's own key.
    let entry = format::cache_entry_path(&program(), &plan).unwrap();
    assert!(entry.starts_with(home.cache()), "{entry:?}");
    let mut planted: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&entry).unwrap()).unwrap();
    planted["document"]["tasks"][0]["id"] = "T99".into();
    std::fs::write(&entry, planted.to_string()).unwrap();
    format::forget_memory_cache();

    let before = format::runs_started();
    let gate = format::read(&program(), &plan).unwrap();
    assert_eq!(gate, real);
    assert_eq!(format::runs_started() - before, 1);

    // The same planted entry is what a shown read takes, so the plant was a valid one.
    format::forget_memory_cache();
    let shown = format::read_with(&program(), &plan, Reads::Shown).unwrap();
    assert_eq!(task_ids(&shown)[0], "T99");
}

#[test]
#[serial]
fn a_gate_read_refuses_a_disk_entry_a_shown_read_already_loaded() {
    let _home = Home::new();
    let tmp = tempfile::tempdir().unwrap();
    let plan = plan_in(tmp.path());
    let real = format::read_with(&program(), &plan, Reads::Shown).unwrap();

    let entry = format::cache_entry_path(&program(), &plan).unwrap();
    let mut planted: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&entry).unwrap()).unwrap();
    planted["document"]["tasks"][0]["id"] = "T99".into();
    std::fs::write(&entry, planted.to_string()).unwrap();
    format::forget_memory_cache();

    // The shown read takes the planted entry from disk into memory.
    let shown = format::read_with(&program(), &plan, Reads::Shown).unwrap();
    assert_eq!(task_ids(&shown)[0], "T99");

    // The memory cache is not forgotten: the gate read must still not trust that entry.
    let before = format::runs_started();
    let gate = format::read(&program(), &plan).unwrap();
    assert_eq!(gate, real);
    assert_eq!(format::runs_started() - before, 1);
}

#[test]
#[serial]
fn a_changed_program_or_marker_misses() {
    let _home = Home::new();
    let tmp = tempfile::tempdir().unwrap();
    let plan = plan_in(tmp.path());
    let marker = tmp.path().join(".ai-sdlc.json");
    std::fs::write(
        &marker,
        r#"{"version":1,"systems":{"kata":{"repos":["kata"]}}}"#,
    )
    .unwrap();
    format::read_with(&program(), &plan, Reads::Shown).unwrap();

    // The same program, plan and marker are a hit.
    format::forget_memory_cache();
    let before = format::runs_started();
    format::read_with(&program(), &plan, Reads::Shown).unwrap();
    assert_eq!(format::runs_started(), before);

    // A marker with other bytes is a miss.
    std::fs::write(
        &marker,
        r#"{"version":1,"systems":{"kata":{"repos":["kata","x"]}}}"#,
    )
    .unwrap();
    format::forget_memory_cache();
    format::read_with(&program(), &plan, Reads::Shown).unwrap();
    assert_eq!(format::runs_started(), before + 1);

    // A program with other bytes is a miss.
    let other = tmp.path().join("other-check.mjs");
    let mut text = std::fs::read_to_string(program()).unwrap();
    text.push_str("\n// another version\n");
    std::fs::write(&other, text).unwrap();
    format::forget_memory_cache();
    format::read_with(&other, &plan, Reads::Shown).unwrap();
    assert_eq!(format::runs_started(), before + 2);
}

#[test]
#[serial]
fn prune_keeps_the_newest_2000() {
    let home = Home::new();
    let folder = home.cache();
    std::fs::create_dir_all(&folder).unwrap();
    let start = std::time::SystemTime::now() - std::time::Duration::from_secs(100_000);
    let name = |i: usize| folder.join(format!("{i:064x}.json"));
    for i in 0..2010 {
        std::fs::write(name(i), "{}").unwrap();
        std::fs::File::options()
            .write(true)
            .open(name(i))
            .unwrap()
            .set_modified(start + std::time::Duration::from_secs(i as u64))
            .unwrap();
    }
    let tmp = tempfile::tempdir().unwrap();
    let plan = plan_in(tmp.path());

    format::prune_on_next_shown_read();
    format::read_with(&program(), &plan, Reads::Shown).unwrap();

    assert!((0..10).all(|i| !name(i).exists()), "an old entry is left");
    assert!(
        (10..2010).all(|i| name(i).exists()),
        "a new entry was removed"
    );
}

#[test]
#[serial]
fn a_corrupt_entry_is_a_miss() {
    let _home = Home::new();
    let tmp = tempfile::tempdir().unwrap();
    let plan = plan_in(tmp.path());
    let real = format::read_with(&program(), &plan, Reads::Shown).unwrap();
    let entry = format::cache_entry_path(&program(), &plan).unwrap();
    std::fs::write(&entry, "{ not json").unwrap();
    format::forget_memory_cache();

    let before = format::runs_started();
    let again = format::read_with(&program(), &plan, Reads::Shown).unwrap();

    assert_eq!(again, real);
    assert_eq!(format::runs_started(), before + 1);
    // The bad entry was replaced by the fresh answer.
    let stored: format::ReadResult =
        serde_json::from_str(&std::fs::read_to_string(&entry).unwrap()).unwrap();
    assert_eq!(stored, real);
}
