//! Which findings a change shows comes from its review document, `build/review.md` (R14, R15, R16).
//!
//! These tests run the vendored copy of the plugin's format program in `tests/ai-sdlc-tools/`.
#![allow(clippy::disallowed_methods)]
use kata_sdlc::format::Severity;
use kata_sdlc::review;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const SYS: &str = "claims";
const CHG: &str = "2026-10-12-fnol";

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

/// A stand-in for the plugin folder: its `tools/` is the vendored program.
fn plugin(tmp: &Path) -> PathBuf {
    let dir = tmp.join("plugin");
    copy_dir(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools"),
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

/// A master repository whose `HEAD` holds `build/review.md` with `review`, if any.
fn master(tmp: &Path, review: Option<&str>) -> PathBuf {
    let master = tmp.join("master");
    fs::create_dir_all(&master).unwrap();
    git(&master, &["init", "-q", "-b", "main"]);
    git(&master, &["config", "user.name", "Test"]);
    git(&master, &["config", "user.email", "test@example.com"]);
    git(&master, &["config", "commit.gpgsign", "false"]);
    let change = master.join(format!("intent/{SYS}/{CHG}"));
    fs::create_dir_all(change.join("build")).unwrap();
    fs::write(change.join("plan.md"), "# Plan\n").unwrap();
    if let Some(text) = review {
        fs::write(change.join("build/review.md"), text).unwrap();
    }
    git(&master, &["add", "."]);
    git(&master, &["commit", "-q", "-m", "change"]);
    master
}

const TWO_FINDINGS: &str = "---\nlayout: 2\n---\n\n# Review findings\n\n## Review 1\n\n```yaml\nreview: 1\nreviewed_at: 2026-10-22\ncommits: { app: 840fa0c }\n```\n\n### F1\n\n```yaml\nid: F1\nseverity: high\nfile: src/a.ts\nline: 4\n```\n\nThe limit is not enforced on retry.\n\n### F2\n\n```yaml\nid: F2\nseverity: low\nfile: README.md\nline: 12\n```\n\nA typo.\n";

const NOTHING_FOUND: &str = "---\nlayout: 2\n---\n\n# Review findings\n\n## Review 1\n\n```yaml\nreview: 1\nreviewed_at: 2026-10-22\ncommits: { app: 840fa0c }\n```\n";

const SECOND_REVIEW: &str = "\n## Review 2\n\n```yaml\nreview: 2\nreviewed_at: 2026-10-23\ncommits: { app: aaa1111 }\n```\n\n### F1\n\n```yaml\nid: F1\nseverity: medium\nfile: src/b.ts\nline: 9\n```\n\nThe refusal has no test.\n";

#[test]
fn findings_come_from_review_md_not_the_runs_words() {
    let tmp = tempfile::tempdir().unwrap();
    let master = master(tmp.path(), Some(TWO_FINDINGS));
    let got = review::record(&plugin(tmp.path()), &master, SYS, CHG)
        .unwrap()
        .expect("the document is there");
    let shown: Vec<(&str, Severity, &str)> = got.reviews[0]
        .findings
        .iter()
        .map(|f| (f.id.as_str(), f.severity, f.text.as_str()))
        .collect();
    // Only the document's two findings: nothing a run said about tasks or commits is read.
    assert_eq!(
        shown,
        vec![
            ("F1", Severity::High, "The limit is not enforced on retry."),
            ("F2", Severity::Low, "A typo."),
        ]
    );
    assert!(got.problems.is_empty());
}

#[test]
fn a_review_with_no_findings_shows_reviewed_nothing_found() {
    let tmp = tempfile::tempdir().unwrap();
    let master = master(tmp.path(), Some(NOTHING_FOUND));
    let got = review::record(&plugin(tmp.path()), &master, SYS, CHG)
        .unwrap()
        .expect("the document is there");
    assert_eq!(got.reviews.len(), 1);
    assert_eq!(got.reviews[0].number, 1);
    assert!(got.reviews[0].findings.is_empty());
}

#[test]
fn a_second_review_is_shown_with_the_first_one_available() {
    let tmp = tempfile::tempdir().unwrap();
    let master = master(tmp.path(), Some(&format!("{TWO_FINDINGS}{SECOND_REVIEW}")));
    let got = review::record(&plugin(tmp.path()), &master, SYS, CHG)
        .unwrap()
        .expect("the document is there");
    let numbers: Vec<u32> = got.reviews.iter().map(|r| r.number).collect();
    assert_eq!(numbers, vec![1, 2]);
    assert_eq!(got.reviews[0].findings.len(), 2);
    assert_eq!(got.reviews[1].findings.len(), 1);
    assert_eq!(got.reviews[1].commits["app"], "aaa1111");
}

#[test]
fn a_change_without_review_md_reads_the_runs_words_labeled_older() {
    let tmp = tempfile::tempdir().unwrap();
    let master = master(tmp.path(), None);
    // No document: the caller falls back to the run's closing words and labels them older.
    assert_eq!(
        review::record(&plugin(tmp.path()), &master, SYS, CHG).unwrap(),
        None
    );
}

/// A master (the directory is named `master`) whose review document records the head it started
/// from, committed after that head, as the review skill does.
fn reviewed_master(tmp: &Path) -> PathBuf {
    let master = master(tmp, None);
    let head = String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(&master)
            .args(["rev-parse", "--short=7", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let doc = format!("---\nlayout: 2\n---\n\n# Review findings\n\n## Review 1\n\n```yaml\nreview: 1\nreviewed_at: 2026-10-22\ncommits: {{ master: {} }}\n```\n", head.trim());
    fs::write(
        master.join(format!("intent/{SYS}/{CHG}/build/review.md")),
        doc,
    )
    .unwrap();
    git(&master, &["add", "."]);
    git(&master, &["commit", "-q", "-m", "review"]);
    master
}

/// What the record says the master committed since the review, as the frontend reads it.
fn moved_since_review(tmp: &Path, master: &Path) -> serde_json::Value {
    let got = review::record(&plugin(tmp), master, SYS, CHG)
        .unwrap()
        .expect("the document is there");
    serde_json::to_value(&got).unwrap()["master_moved"].clone()
}

#[test]
fn a_master_that_only_committed_the_review_document_since_the_review_is_unmoved() {
    let tmp = tempfile::tempdir().unwrap();
    let master = reviewed_master(tmp.path());
    assert_eq!(
        moved_since_review(tmp.path(), &master),
        serde_json::json!([])
    );
}

#[test]
fn a_master_that_gained_a_product_commit_after_the_review_lists_its_files() {
    let tmp = tempfile::tempdir().unwrap();
    let master = reviewed_master(tmp.path());
    fs::create_dir_all(master.join("plugin")).unwrap();
    fs::write(master.join("plugin/ai-sdlc.ts"), "// changed\n").unwrap();
    git(&master, &["add", "."]);
    git(&master, &["commit", "-q", "-m", "product"]);
    assert_eq!(
        moved_since_review(tmp.path(), &master),
        serde_json::json!(["plugin/ai-sdlc.ts"])
    );
}

#[test]
fn review_stays_current_after_a_rename_r10_3() {
    let tmp = tempfile::tempdir().unwrap();
    let master = reviewed_master(tmp.path());
    // A rename commits the change's branch record and nothing else in the change's folder.
    let record = master.join(format!("intent/{SYS}/{CHG}/branch.md"));
    fs::create_dir_all(record.parent().unwrap()).unwrap();
    fs::write(
        &record,
        "---
branch: feat/PROJ-123-reset
type: feat
---
",
    )
    .unwrap();
    git(&master, &["add", "."]);
    git(&master, &["commit", "-q", "-m", "rename branch"]);
    assert_eq!(
        moved_since_review(tmp.path(), &master),
        serde_json::json!([])
    );
    // Any other file committed after the review still counts.
    fs::write(master.join(format!("intent/{SYS}/{CHG}/intent.md")), "x\n").unwrap();
    git(&master, &["add", "."]);
    git(&master, &["commit", "-q", "-m", "intent"]);
    assert_eq!(
        moved_since_review(tmp.path(), &master),
        serde_json::json!([format!("intent/{SYS}/{CHG}/intent.md")])
    );
}

/// A master with the marker and the change's record, reviewed, then renamed by the vendored program.
fn reviewed_then_renamed(tmp: &Path) -> PathBuf {
    let master = tmp.join("master");
    fs::create_dir_all(master.join(format!("intent/{SYS}/{CHG}/build"))).unwrap();
    git(&master, &["init", "-q", "-b", "main"]);
    git(&master, &["config", "user.name", "Test"]);
    git(&master, &["config", "user.email", "test@example.com"]);
    git(&master, &["config", "commit.gpgsign", "false"]);
    fs::write(
        master.join(".ai-sdlc.json"),
        format!(r#"{{"version":1,"systems":{{"{SYS}":{{"repos":[]}}}}}}"#),
    )
    .unwrap();
    let dir = master.join(format!("intent/{SYS}/{CHG}"));
    fs::write(
        dir.join("plan.md"),
        "# Plan
",
    )
    .unwrap();
    fs::write(
        dir.join("change.yml"),
        "version: 1
branch: \"main\"
type: feat
scope: \"X-1\"
base: \"main\"
",
    )
    .unwrap();
    git(&master, &["add", "."]);
    git(&master, &["commit", "-q", "-m", "change"]);
    let head = Command::new("git")
        .arg("-C")
        .arg(&master)
        .args(["rev-parse", "--short=7", "HEAD"])
        .output()
        .unwrap()
        .stdout;
    let head = String::from_utf8(head).unwrap();
    let doc = format!(
        "---
layout: 2
---

# Review findings

## Review 1

```yaml
review: 1
reviewed_at: 2026-10-22
commits: {{ master: {} }}
```
",
        head.trim()
    );
    fs::write(dir.join("build/review.md"), doc).unwrap();
    git(&master, &["add", "."]);
    git(&master, &["commit", "-q", "-m", "review"]);
    // The plugin renames the branch and commits the change's record.
    let out = Command::new("node")
        .arg(plugin(tmp).join("tools/ai-sdlc.ts"))
        .args([
            "change",
            "rename",
            "--json",
            "--system",
            SYS,
            "--change",
            CHG,
            "--to",
            "feat/X-1-new",
        ])
        .arg("--master")
        .arg(&master)
        .arg("--workspace")
        .arg(tmp)
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    master
}

#[test]
fn review_stays_current_after_the_plugin_renames_the_branch() {
    let tmp = tempfile::tempdir().unwrap();
    let master = reviewed_then_renamed(tmp.path());
    assert!(String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(&master)
            .args(["show", "--stat", "--format=%s", "HEAD"])
            .output()
            .unwrap()
            .stdout
    )
    .unwrap()
    .contains("change.yml"));
    assert_eq!(
        moved_since_review(tmp.path(), &master),
        serde_json::json!([])
    );
    // Product code committed after the review still makes it not current.
    fs::create_dir_all(master.join("plugin")).unwrap();
    fs::write(
        master.join("plugin/ai-sdlc.ts"),
        "// changed
",
    )
    .unwrap();
    git(&master, &["add", "."]);
    git(&master, &["commit", "-q", "-m", "product"]);
    assert_eq!(
        moved_since_review(tmp.path(), &master),
        serde_json::json!(["plugin/ai-sdlc.ts"])
    );
}
