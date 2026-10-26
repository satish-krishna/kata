//! The format reader's cache. This file holds one test on purpose: `format::runs_started` counts
//! every start in the process, so a second test running beside it would skew the count.
#![allow(clippy::disallowed_methods)]
use kata_sdlc::format;
use std::path::PathBuf;

#[test]
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
