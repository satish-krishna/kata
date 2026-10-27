//! Kata reads every document exactly as the ai-sdlc format program does (R6.2).
//!
//! These tests run the vendored copy of the plugin's format folder in `tests/ai-sdlc-format/`
//! (refreshed with `node scripts/vendor-ai-sdlc-format.mjs`), never the plugin repository. The
//! running Workbench always runs the installed plugin's program instead.
#![allow(clippy::disallowed_methods)]
use kata_sdlc::format::{self, FormatError, Problem};
use serde_json::Value;
use serial_test::serial;
use std::fs;
use std::path::{Path, PathBuf};

fn vendored() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-format")
}

fn program() -> PathBuf {
    vendored().join("check.mjs")
}

/// Every file below `dir` whose name ends with `suffix`, sorted.
fn files_below(dir: &Path, suffix: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            found.extend(files_below(&path, suffix));
        } else if path.to_string_lossy().ends_with(suffix) {
            found.push(path);
        }
    }
    found.sort();
    found
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let path = entry.unwrap().path();
        let target = to.join(path.file_name().unwrap());
        if path.is_dir() {
            copy_dir(&path, &target);
        } else {
            fs::copy(&path, &target).unwrap();
        }
    }
}

/// The program takes the kind of a document from its file name, so an example is staged under the
/// name its kind needs: `spec.md`, `plan.md`, `build/review.md` or `build/<example name>.md`.
fn stage(kind: &str, example: &Path, dir: &Path) -> PathBuf {
    let name = example.file_name().unwrap();
    let relative: PathBuf = match kind {
        "spec" => "spec.md".into(),
        "plan" => "plan.md".into(),
        "review" => "build/review.md".into(),
        "build-log" => Path::new("build").join(name),
        other => panic!("unknown example kind {other}"),
    };
    let staged = dir.join(relative);
    fs::create_dir_all(staged.parent().unwrap()).unwrap();
    fs::copy(example, &staged).unwrap();
    staged
}

#[test]
#[serial]
fn kata_reads_every_published_example_as_the_check_does() {
    let examples = vendored().join("examples");
    let mut seen = 0;
    for kind in ["spec", "plan", "build-log", "review"] {
        for document in files_below(&examples.join(kind), ".md") {
            let expected_path = document.with_extension("expected.json");
            let expected: Value =
                serde_json::from_str(&fs::read_to_string(&expected_path).unwrap()).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let staged = stage(kind, &document, dir.path());
            let result = format::read(&program(), &staged)
                .unwrap_or_else(|e| panic!("{}: {e}", document.display()));
            assert_eq!(
                serde_json::to_value(&result).unwrap(),
                expected,
                "{}",
                document.display()
            );
            seen += 1;
        }
    }
    assert!(seen >= 20, "only {seen} examples were found");
}

#[test]
#[serial]
fn kata_checks_every_published_change_as_the_check_does() {
    let mut seen = 0;
    for expected_path in files_below(&vendored().join("examples/change"), "expected.json") {
        let expected: Value =
            serde_json::from_str(&fs::read_to_string(&expected_path).unwrap()).unwrap();
        let expected: Vec<Problem> = serde_json::from_value(expected["problems"].clone()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        copy_dir(expected_path.parent().unwrap(), dir.path());
        let mut documents = vec!["spec.md".to_string(), "plan.md".to_string()];
        if dir.path().join("build").is_dir() {
            for log in files_below(&dir.path().join("build"), ".md") {
                let name = log.file_name().unwrap().to_string_lossy();
                documents.push(format!("build/{name}"));
            }
        }
        let documents: Vec<&str> = documents.iter().map(String::as_str).collect();
        let problems = format::check_change(&program(), dir.path(), &documents)
            .unwrap_or_else(|e| panic!("{}: {e}", expected_path.display()));
        assert_eq!(problems, expected, "{}", expected_path.display());
        seen += 1;
    }
    assert!(seen >= 4, "only {seen} change examples were found");
}

#[test]
fn the_vendored_copy_is_at_the_minimum_plugin_version() {
    let version = fs::read_to_string(vendored().join("VERSION")).unwrap();
    assert!(
        kata_sdlc::plugin::at_least(version.trim(), kata_sdlc::plugin::MIN_VERSION),
        "the vendored copy is {}, below the minimum {}",
        version.trim(),
        kata_sdlc::plugin::MIN_VERSION
    );
}

/// Line endings differ between checkouts (this repository is LF, the sibling may be CRLF).
fn without_carriage_returns(bytes: Vec<u8>) -> Vec<u8> {
    bytes.into_iter().filter(|b| *b != b'\r').collect()
}

fn compare_trees(sibling: &Path, copy: &Path, differences: &mut Vec<String>) {
    if sibling.is_dir() {
        let mut names: Vec<_> = fs::read_dir(sibling)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        if copy.is_dir() {
            names.extend(fs::read_dir(copy).unwrap().map(|e| e.unwrap().file_name()));
        }
        names.sort();
        names.dedup();
        for name in names {
            compare_trees(&sibling.join(&name), &copy.join(&name), differences);
        }
    } else if !sibling.exists() {
        differences.push(format!("not in the sibling checkout: {}", copy.display()));
    } else if !copy.is_file() {
        differences.push(format!("missing from the copy: {}", copy.display()));
    } else if without_carriage_returns(fs::read(sibling).unwrap())
        != without_carriage_returns(fs::read(copy).unwrap())
    {
        differences.push(format!("differs: {}", copy.display()));
    }
}

#[test]
fn the_vendored_copy_matches_the_sibling_checkout() {
    let plugin = std::env::var_os("KATA_AI_SDLC_PLUGIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ai-sdlc/plugin"));
    let source = plugin.join("format");
    if !source.is_dir() {
        println!("sibling ai-sdlc checkout not found; copy not compared");
        return;
    }
    let copy = vendored();
    let mut differences = Vec::new();
    for entry in [
        "check.mjs",
        "THIRD_PARTY_LICENSES.txt",
        "schema",
        "examples",
    ] {
        compare_trees(&source.join(entry), &copy.join(entry), &mut differences);
    }
    assert!(
        differences.is_empty(),
        "run node scripts/vendor-ai-sdlc-format.mjs; {differences:#?}"
    );
    let manifest = fs::read_to_string(plugin.join(".claude-plugin/plugin.json")).unwrap();
    let manifest: Value = serde_json::from_str(&manifest).unwrap();
    let version = fs::read_to_string(copy.join("VERSION")).unwrap();
    assert_eq!(manifest["version"].as_str().unwrap(), version.trim());
}

#[test]
#[serial]
fn the_cache_reads_an_unchanged_document_once() {
    let dir = tempfile::tempdir().unwrap();
    let source = vendored().join("examples/spec/2/valid.md");
    let spec = stage("spec", &source, dir.path());
    // The cache is keyed by content, so this test's bytes must not be any other test's bytes.
    let mut own = fs::read_to_string(&spec).unwrap();
    own.push_str(
        "
Only the cache test writes this line.
",
    );
    fs::write(&spec, own).unwrap();

    let before = format::runs_started();
    let first = format::read(&program(), &spec).unwrap();
    let second = format::read(&program(), &spec).unwrap();
    assert_eq!(first, second);
    assert_eq!(format::runs_started() - before, 1);

    let mut text = fs::read_to_string(&spec).unwrap();
    text.push_str("\nA changed line.\n");
    fs::write(&spec, text).unwrap();
    format::read(&program(), &spec).unwrap();
    assert_eq!(format::runs_started() - before, 2);
}

#[test]
#[serial]
fn a_missing_node_is_node_missing() {
    let dir = tempfile::tempdir().unwrap();
    let spec = stage(
        "spec",
        &vendored().join("examples/spec/2/valid.md"),
        dir.path(),
    );
    // A document some other test already read would come from the cache and never start node.
    let mut own = fs::read_to_string(&spec).unwrap();
    own.push_str(
        "
Only the missing node test writes this line.
",
    );
    fs::write(&spec, own).unwrap();
    let saved = std::env::var_os("PATH");
    std::env::set_var("PATH", "");
    let result = format::read(&program(), &spec);
    match saved {
        Some(path) => std::env::set_var("PATH", path),
        None => std::env::remove_var("PATH"),
    }
    assert!(
        matches!(result, Err(FormatError::NodeMissing)),
        "{result:?}"
    );
}

#[test]
#[serial]
fn a_file_the_program_does_not_know_is_could_not_run() {
    let dir = tempfile::tempdir().unwrap();
    let odd = dir.path().join("notes.md");
    fs::write(&odd, "hello\n").unwrap();
    let result = format::read(&program(), &odd);
    match result {
        Err(FormatError::CouldNotRun(message)) => {
            assert!(message.contains("not a document"), "{message}")
        }
        other => panic!("expected CouldNotRun, got {other:?}"),
    }
}

/// Runs git in `dir` and returns its stdout.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
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

/// A repository with a fix's three drafts committed, returned with the change folder.
fn fix_repo(dir: &Path, autocrlf: bool) -> PathBuf {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    if autocrlf {
        git(dir, &["config", "core.autocrlf", "true"]);
    }
    let folder = dir.join("intent/claims/2026-10-23-fix-it");
    fs::create_dir_all(&folder).unwrap();
    let eol = |text: &str| {
        if autocrlf {
            text.replace('\n', "\r\n")
        } else {
            text.to_string()
        }
    };
    fs::write(
        folder.join("intent.md"),
        eol("---\nstatus: draft\ntrack: fix\n---\nintent\n"),
    )
    .unwrap();
    fs::write(
        folder.join("spec.md"),
        eol("---\nstatus: draft\nsource_intent_commit: pending acceptance\n---\nspec\n"),
    )
    .unwrap();
    fs::write(
        folder.join("plan.md"),
        eol("---\nstatus: draft\nsource_spec_commit: pending acceptance\n---\n\n## Tasks\n"),
    )
    .unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "draft fix"]);
    folder
}

#[test]
#[serial]
fn kata_reads_where_a_fix_stands_as_the_check_does() {
    let dir = tempfile::tempdir().unwrap();
    let folder = fix_repo(dir.path(), false);

    // Row 6: all three drafted, none accepted, nothing built.
    let state = format::fix_state(&program(), &folder).unwrap();
    assert_eq!(
        serde_json::to_value(&state).unwrap(),
        serde_json::json!({"row": 6, "facts": {
            "intent": {"inHead": true, "headStatus": "draft", "workingStatus": "draft"},
            "spec": {"inHead": true, "headStatus": "draft", "workingStatus": "draft"},
            "plan": {"inHead": true, "headStatus": "draft", "workingStatus": "draft"},
            "unrecorded": [], "ownLinesOnly": false, "accepted": "none",
            "acceptanceLast": false, "built": false}})
    );

    // Row 4: an acceptance's own status line, not yet recorded.
    fs::write(
        folder.join("intent.md"),
        "---\nstatus: accepted\ntrack: fix\n---\nintent\n",
    )
    .unwrap();
    let state = format::fix_state(&program(), &folder).unwrap();
    assert_eq!(state.row, 4);
    assert!(state.facts.own_lines_only);
    assert_eq!(
        state.facts.intent.working_status.as_deref(),
        Some("accepted")
    );

    // Row 3: an edit that is not an acceptance's own.
    fs::write(folder.join("plan.md"), "---\nstatus: draft\n---\nedited\n").unwrap();
    let state = format::fix_state(&program(), &folder).unwrap();
    assert_eq!(state.row, 3);
    assert_eq!(state.facts.unrecorded, vec!["plan"]);
}

#[test]
#[serial]
fn a_fix_checked_out_with_crlf_is_not_edited_by_it() {
    let dir = tempfile::tempdir().unwrap();
    let folder = fix_repo(dir.path(), true);
    let state = format::fix_state(&program(), &folder).unwrap();
    assert_eq!(state.row, 6);
    assert!(state.facts.unrecorded.is_empty());
}

#[test]
#[serial]
fn a_folder_that_is_not_a_fix_is_could_not_run() {
    let dir = tempfile::tempdir().unwrap();
    let folder = fix_repo(dir.path(), false);
    fs::write(
        folder.join("intent.md"),
        "---\nstatus: draft\n---\nintent\n",
    )
    .unwrap();
    // The program reads the track from `HEAD` when the working intent names none, so the change is recorded.
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-q", "-m", "not a fix"]);
    match format::fix_state(&program(), &folder) {
        Err(FormatError::CouldNotRun(message)) => {
            assert!(message.contains("not a fix"), "{message}")
        }
        other => panic!("expected CouldNotRun, got {other:?}"),
    }
}

#[test]
#[serial]
fn the_vendored_program_answers_fix_state_for_several_folders_in_one_run() {
    let dir = tempfile::tempdir().unwrap();
    let fix = fix_repo(dir.path(), false);
    let plain = dir.path().join("plain");
    fs::create_dir_all(&plain).unwrap();
    fs::write(plain.join("intent.md"), "---\nstatus: draft\n---\nintent\n").unwrap();
    let before = format::runs_started();
    let got = format::fix_states(&program(), &[fix, plain]);
    assert_eq!(format::runs_started() - before, 1);
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].as_ref().unwrap().row, 6);
    assert!(matches!(&got[1], Err(FormatError::CouldNotRun(m)) if m.contains("not a fix")));
}
