use crate::workspace::{Marker, MARKER};
use crate::{branch, changes, frontmatter, git};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Decision {
    AcceptIntent,
    RejectIntent,
    AcceptSpec,
    AcceptPlan,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum DecideOutcome {
    Committed,
    NeedsConfirm { other_edits: bool },
    GitFailed { stderr: String },
}

#[derive(Debug, thiserror::Error)]
pub enum DecideError {
    #[error("invalid system or change name")]
    InvalidName,
    #[error("the master repo is on a detached HEAD")]
    Detached,
    #[error("cannot read or write the decision file: {0}")]
    Io(#[from] std::io::Error),
}

/// The only place commit messages are built: the ai-sdlc header and its `Generated-By` trailer.
pub fn message(decision: Decision, scope: &str, change: &str) -> String {
    let verb = match decision {
        Decision::AcceptIntent => "accept intent",
        Decision::RejectIntent => "reject intent",
        Decision::AcceptSpec => "accept spec",
        Decision::AcceptPlan => "accept plan",
    };
    format!("docs({scope}): {verb} {change}\n\nGenerated-By: ai-sdlc")
}

/// Lowercase kebab-case, the only scope shape a commitlint header accepts.
fn is_scope(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && !s.ends_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The change's scope, as the ai-sdlc plugin resolves it: the intent's `scope`, then the
/// marker's `systems.<system>.commitScope`, then the system name. A malformed value is skipped.
pub fn change_scope(master: &Path, system: &str, change: &str) -> String {
    let intent =
        std::fs::read_to_string(master.join(format!("intent/{system}/{change}/intent.md")))
            .ok()
            .and_then(|t| frontmatter::field(&t, "scope"));
    let marker = std::fs::read_to_string(master.join(MARKER))
        .ok()
        .and_then(|t| serde_json::from_str::<Marker>(&t).ok())
        .and_then(|m| m.systems.get(system)?.commit_scope.clone());
    [intent, marker]
        .into_iter()
        .flatten()
        .find(|s| is_scope(s))
        .unwrap_or_else(|| system.to_string())
}

/// Return `text` with the front-matter `status` line set to `value`, or removed when `None`.
/// A missing line is added before the closing `---`; a file with no front matter gets a new block.
/// Existing line endings are kept.
fn edit_status(text: &str, value: Option<&str>) -> String {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let eol_of = |line: &str| -> &'static str {
        if line.ends_with("\r\n") {
            "\r\n"
        } else if line.ends_with('\n') {
            "\n"
        } else {
            ""
        }
    };
    let opens = lines.first().is_some_and(|l| l.trim_end() == "---");
    if !opens {
        return match value {
            Some(v) => format!("---\nstatus: {v}\n---\n{text}"),
            None => text.to_string(),
        };
    }
    let default_eol = match eol_of(lines[0]) {
        "" => "\n",
        e => e,
    };
    let mut out = String::with_capacity(text.len() + 24);
    out.push_str(lines[0]);
    let mut done = false;
    let mut closed = false;
    for line in &lines[1..] {
        if closed {
            out.push_str(line);
        } else if line.trim_end() == "---" {
            closed = true;
            if !done {
                if let Some(v) = value {
                    out.push_str(&format!("status: {v}{default_eol}"));
                }
                done = true;
            }
            out.push_str(line);
        } else if !done
            && line
                .split_once(':')
                .is_some_and(|(k, _)| k.trim() == "status")
        {
            done = true;
            if let Some(v) = value {
                out.push_str(&format!("status: {v}{}", eol_of(line)));
            }
        } else {
            out.push_str(line);
        }
    }
    out
}

fn normalized(text: &str) -> String {
    edit_status(text, None).replace("\r\n", "\n")
}

/// Does the working-tree file differ from `HEAD` in anything other than the status line?
/// A file `HEAD` does not have counts as edited.
fn has_other_edits(master: &Path, rel: &str, current: &str) -> bool {
    match git::run(master, &["show", &format!("HEAD:{rel}")]) {
        Ok(head) => normalized(&head).trim_end() != normalized(current).trim_end(),
        Err(_) => true,
    }
}

pub fn apply(
    master: &Path,
    system: &str,
    change: &str,
    decision: Decision,
    confirmed: bool,
) -> Result<DecideOutcome, DecideError> {
    if !changes::is_safe_system(system) || !changes::is_change_name(change) {
        return Err(DecideError::InvalidName);
    }
    if branch::current_branch(master).is_none() {
        return Err(DecideError::Detached);
    }
    let (file, status) = match decision {
        Decision::AcceptIntent => ("intent.md", "accepted"),
        Decision::RejectIntent => ("intent.md", "rejected"),
        Decision::AcceptSpec => ("spec.md", "accepted"),
        Decision::AcceptPlan => ("plan.md", "accepted"),
    };
    let rel = format!("intent/{system}/{change}/{file}");
    let path = master.join(&rel);
    let text = std::fs::read_to_string(&path)?;

    if !confirmed && has_other_edits(master, &rel, &text) {
        return Ok(DecideOutcome::NeedsConfirm { other_edits: true });
    }

    let edited = edit_status(&text, Some(status));
    if edited != text {
        std::fs::write(&path, edited)?;
    }

    let msg = message(decision, &change_scope(master, system, change), change);
    let committed = git::run(master, &["add", "--", &rel])
        .and_then(|_| git::run(master, &["commit", "-m", &msg, "--", &rel]));
    Ok(match committed {
        Ok(_) => DecideOutcome::Committed,
        Err(e) => DecideOutcome::GitFailed { stderr: e.stderr },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{frontmatter, git, testutil};

    const CHANGE: &str = "2026-10-12-fnol";
    const INTENT: &str = "intent/claims/2026-10-12-fnol/intent.md";

    fn seeded(tmp: &Path) -> std::path::PathBuf {
        let repo = testutil::repo(tmp, "m");
        testutil::commit_file(&repo, INTENT, "---\nstatus: draft\n---\nbody\n", "intent");
        repo
    }

    fn head(repo: &Path) -> String {
        git::run(repo, &["rev-parse", "HEAD"]).unwrap()
    }

    fn status_of(repo: &Path) -> Option<String> {
        let text = std::fs::read_to_string(repo.join(INTENT)).unwrap();
        frontmatter::field(&text, "status")
    }

    #[test]
    fn message_format() {
        assert_eq!(
            message(Decision::AcceptIntent, "claims", CHANGE),
            "docs(claims): accept intent 2026-10-12-fnol\n\nGenerated-By: ai-sdlc"
        );
        assert_eq!(
            message(Decision::RejectIntent, "claims", CHANGE),
            "docs(claims): reject intent 2026-10-12-fnol\n\nGenerated-By: ai-sdlc"
        );
        assert_eq!(
            message(Decision::AcceptSpec, "claims", CHANGE),
            "docs(claims): accept spec 2026-10-12-fnol\n\nGenerated-By: ai-sdlc"
        );
    }

    #[test]
    fn accept_plan_message_uses_scope_and_trailer_r15_1() {
        assert_eq!(
            message(Decision::AcceptPlan, "sdlc", CHANGE),
            format!("docs(sdlc): accept plan {CHANGE}\n\nGenerated-By: ai-sdlc")
        );
    }

    #[test]
    fn accept_plan_commits_and_opens_build_r1_2() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let dir = "intent/claims/2026-10-12-fnol";
        testutil::commit_file(
            &repo,
            &format!("{dir}/intent.md"),
            "---\nstatus: accepted\nscope: sdlc\n---\nintent\n",
            "intent",
        );
        let intent_pin = git::run(&repo, &["rev-parse", "HEAD"]).unwrap();
        testutil::commit_file(
            &repo,
            &format!("{dir}/spec.md"),
            &format!("---\nstatus: accepted\nsource_intent_commit: {intent_pin}\n---\nspec\n"),
            "spec",
        );
        let spec_pin = git::run(&repo, &["rev-parse", "HEAD"]).unwrap();
        testutil::commit_file(
            &repo,
            &format!("{dir}/plan.md"),
            &format!(
                "---\nstatus: draft\nsource_spec_commit: {spec_pin}\n---\n\n## Tasks\n\n### T1: One (`app`)\n\n- **Depends on:** none\n"
            ),
            "plan",
        );
        let out = apply(&repo, "claims", CHANGE, Decision::AcceptPlan, false).unwrap();
        assert_eq!(out, DecideOutcome::Committed);
        assert_eq!(
            git::run(&repo, &["log", "-1", "--format=%B"])
                .unwrap()
                .trim_end(),
            format!("docs(sdlc): accept plan {CHANGE}\n\nGenerated-By: ai-sdlc")
        );
        let got = changes::list(Some(testutil::plugin_dir()), &repo, "claims");
        assert_eq!(got[0].stage, changes::Stage::BuildReady);
    }

    fn subject(repo: &Path) -> String {
        git::run(repo, &["log", "-1", "--format=%s"]).unwrap()
    }

    fn marker(repo: &Path, json: &str) {
        testutil::commit_file(repo, ".ai-sdlc.json", json, "marker");
    }

    #[test]
    fn commit_carries_the_trailer() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = seeded(tmp.path());
        apply(&repo, "claims", CHANGE, Decision::AcceptIntent, false).unwrap();
        let trailer = git::run(
            &repo,
            &[
                "log",
                "-1",
                "--format=%(trailers:key=Generated-By,valueonly)",
            ],
        )
        .unwrap();
        assert_eq!(trailer.trim_end(), "ai-sdlc");
    }

    #[test]
    fn scope_comes_from_the_intent() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        marker(
            &repo,
            r#"{"version":1,"systems":{"claims":{"commitScope":"claims-sys"}}}"#,
        );
        testutil::commit_file(
            &repo,
            INTENT,
            "---\nstatus: draft\nscope: \"fnol\"\n---\n",
            "i",
        );
        apply(&repo, "claims", CHANGE, Decision::AcceptIntent, false).unwrap();
        assert_eq!(subject(&repo), "docs(fnol): accept intent 2026-10-12-fnol");
    }

    #[test]
    fn spec_acceptance_uses_the_intent_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        testutil::commit_file(
            &repo,
            INTENT,
            "---\nstatus: accepted\nscope: fnol\n---\n",
            "i",
        );
        let spec = "intent/claims/2026-10-12-fnol/spec.md";
        testutil::commit_file(&repo, spec, "---\nstatus: ready\n---\n", "spec");
        apply(&repo, "claims", CHANGE, Decision::AcceptSpec, false).unwrap();
        assert_eq!(subject(&repo), "docs(fnol): accept spec 2026-10-12-fnol");
    }

    #[test]
    fn scope_falls_back_to_the_system_commit_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = seeded(tmp.path());
        marker(
            &repo,
            r#"{"version":1,"systems":{"claims":{"repos":[],"commitScope":"claims-sys"}}}"#,
        );
        apply(&repo, "claims", CHANGE, Decision::AcceptIntent, false).unwrap();
        assert_eq!(
            subject(&repo),
            "docs(claims-sys): accept intent 2026-10-12-fnol"
        );
    }

    #[test]
    fn malformed_scopes_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        marker(
            &repo,
            r#"{"version":1,"systems":{"claims":{"commitScope":"Claims Sys"}}}"#,
        );
        testutil::commit_file(&repo, INTENT, "---\nstatus: draft\nscope: a(b)\n---\n", "i");
        apply(&repo, "claims", CHANGE, Decision::AcceptIntent, false).unwrap();
        assert_eq!(
            subject(&repo),
            "docs(claims): accept intent 2026-10-12-fnol"
        );
    }

    #[test]
    fn accept_commits_only_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = seeded(tmp.path());
        std::fs::write(repo.join("other.txt"), "x").unwrap();
        git::run(&repo, &["add", "other.txt"]).unwrap();

        let out = apply(&repo, "claims", CHANGE, Decision::AcceptIntent, false).unwrap();
        assert_eq!(out, DecideOutcome::Committed);
        assert_eq!(
            git::run(&repo, &["log", "-1", "--format=%s"]).unwrap(),
            "docs(claims): accept intent 2026-10-12-fnol"
        );
        assert_eq!(
            git::run(&repo, &["diff", "--cached", "--name-only"]).unwrap(),
            "other.txt"
        );
        assert_eq!(status_of(&repo).as_deref(), Some("accepted"));
        assert!(crate::workspace::is_committed(&repo, INTENT));
    }

    #[test]
    fn missing_status_line_is_added_inside_front_matter() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        testutil::commit_file(&repo, INTENT, "---\ntitle: t\n---\nbody\n", "intent");
        apply(&repo, "claims", CHANGE, Decision::RejectIntent, false).unwrap();
        let text = std::fs::read_to_string(repo.join(INTENT)).unwrap();
        assert_eq!(text, "---\ntitle: t\nstatus: rejected\n---\nbody\n");
    }

    #[test]
    fn preserves_crlf_when_replacing_status() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let crlf = "---\r\nstatus: draft\r\n---\r\nbody\r\n";
        testutil::commit_file(&repo, INTENT, crlf, "i");
        apply(&repo, "claims", CHANGE, Decision::AcceptIntent, false).unwrap();
        let text = std::fs::read_to_string(repo.join(INTENT)).unwrap();
        assert_eq!(text, "---\r\nstatus: accepted\r\n---\r\nbody\r\n");
    }

    #[test]
    fn other_edits_need_confirmation() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = seeded(tmp.path());
        std::fs::write(repo.join(INTENT), "---\nstatus: draft\n---\nedited body\n").unwrap();
        let before = std::fs::read(repo.join(INTENT)).unwrap();
        let h = head(&repo);

        let out = apply(&repo, "claims", CHANGE, Decision::AcceptIntent, false).unwrap();
        assert_eq!(out, DecideOutcome::NeedsConfirm { other_edits: true });
        assert_eq!(std::fs::read(repo.join(INTENT)).unwrap(), before);
        assert_eq!(head(&repo), h);

        let out = apply(&repo, "claims", CHANGE, Decision::AcceptIntent, true).unwrap();
        assert_eq!(out, DecideOutcome::Committed);
        assert_ne!(head(&repo), h);
    }

    #[test]
    fn never_committed_file_needs_confirmation() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let p = repo.join(INTENT);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "---\nstatus: draft\n---\nbody\n").unwrap();
        let out = apply(&repo, "claims", CHANGE, Decision::AcceptIntent, false).unwrap();
        assert_eq!(out, DecideOutcome::NeedsConfirm { other_edits: true });
        let out = apply(&repo, "claims", CHANGE, Decision::AcceptIntent, true).unwrap();
        assert_eq!(out, DecideOutcome::Committed);
        assert!(crate::workspace::is_committed(&repo, INTENT));
    }

    #[test]
    fn already_accepted_uncommitted_commits() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = seeded(tmp.path());
        std::fs::write(repo.join(INTENT), "---\nstatus: accepted\n---\nbody\n").unwrap();
        let out = apply(&repo, "claims", CHANGE, Decision::AcceptIntent, false).unwrap();
        assert_eq!(out, DecideOutcome::Committed);
        assert!(crate::workspace::is_committed(&repo, INTENT));
    }

    #[test]
    fn accept_spec_targets_spec_file() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let spec = "intent/claims/2026-10-12-fnol/spec.md";
        testutil::commit_file(&repo, spec, "---\nstatus: ready\n---\n", "spec");
        let out = apply(&repo, "claims", CHANGE, Decision::AcceptSpec, false).unwrap();
        assert_eq!(out, DecideOutcome::Committed);
        assert_eq!(
            git::run(&repo, &["log", "-1", "--format=%s"]).unwrap(),
            "docs(claims): accept spec 2026-10-12-fnol"
        );
    }

    fn failing_hook(repo: &Path) {
        let hook = repo.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\necho hook says no >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn staged(repo: &Path) -> String {
        git::run(repo, &["diff", "--cached", "--name-only"]).unwrap()
    }

    #[test]
    fn failed_decision_keeps_the_engineers_other_edits_and_unrelated_staging() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = seeded(tmp.path());
        failing_hook(&repo);
        std::fs::write(repo.join("other.txt"), "x").unwrap();
        git::run(&repo, &["add", "other.txt"]).unwrap();
        let edited = "---\nstatus: draft\n---\nedited body\n";
        std::fs::write(repo.join(INTENT), edited).unwrap();
        let out = apply(&repo, "claims", CHANGE, Decision::AcceptIntent, true).unwrap();
        assert!(matches!(out, DecideOutcome::GitFailed { .. }));
        assert_eq!(std::fs::read_to_string(repo.join(INTENT)).unwrap(), edited);
        assert_eq!(staged(&repo), "other.txt");
    }

    #[test]
    fn hook_failure_is_reported_and_leaves_nothing_behind_r7_4() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = seeded(tmp.path());
        failing_hook(&repo);
        let h = head(&repo);
        let out = apply(&repo, "claims", CHANGE, Decision::AcceptIntent, false).unwrap();
        match out {
            DecideOutcome::GitFailed { stderr } => {
                assert!(stderr.contains("hook says no"), "{stderr}")
            }
            other => panic!("expected GitFailed, got {other:?}"),
        }
        assert_eq!(head(&repo), h);
        let at_head = git::run_bytes(&repo, &["show", &format!("HEAD:{INTENT}")]).unwrap();
        assert_eq!(std::fs::read(repo.join(INTENT)).unwrap(), at_head);
        assert_eq!(staged(&repo), "");
    }

    #[test]
    fn refuses_detached_head() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = seeded(tmp.path());
        git::run(&repo, &["checkout", "-q", "--detach"]).unwrap();
        let h = head(&repo);
        let err = apply(&repo, "claims", CHANGE, Decision::AcceptIntent, true).unwrap_err();
        assert!(matches!(err, DecideError::Detached));
        assert_eq!(err.to_string(), "the master repo is on a detached HEAD");
        assert_eq!(head(&repo), h);
        assert_eq!(status_of(&repo).as_deref(), Some("draft"));
    }

    #[test]
    fn rejects_unsafe_names() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = seeded(tmp.path());
        for (s, c) in [
            ("..", CHANGE),
            ("claims", "../x"),
            ("a/b", CHANGE),
            ("claims", ""),
        ] {
            assert!(matches!(
                apply(&repo, s, c, Decision::AcceptIntent, true),
                Err(DecideError::InvalidName)
            ));
        }
    }
}
