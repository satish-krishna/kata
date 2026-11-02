//! Accepting and rejecting a change's documents through the ai-sdlc plugin. Kata edits one front matter
//! line; the plugin commits it (`commit --kind accept-<doc>` or `reject-intent` / `reject-fix`), runs the
//! `doc.accept` event and removes the rejected change's copy. Kata makes no commit and runs no hook.
use crate::ai_sdlc::state::ChangeState;
use crate::ai_sdlc::{Place, Program};
use serde::{Deserialize, Serialize};

/// A document of the full pipeline that is accepted by the engineer.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Document {
    Intent,
    Spec,
    Plan,
}

/// What accepting a document came to.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum AcceptOutcome {
    /// Committed, and the `doc.accept` event passed.
    Accepted,
    /// Committed, but a team hook on accepting failed; the engineer decides what happens next.
    AcceptedHookFailed {
        hook: Option<String>,
        output: String,
        problems: Vec<String>,
    },
    /// Committed, but the machine could not run the `doc.accept` hooks.
    AcceptedHookCouldNotRun { output: String },
    /// Nothing was committed and the status edit was taken back; `problems` are the plugin's words.
    NotCommitted { problems: Vec<String> },
    /// The plugin could not run, or the document could not be edited; the edit was taken back.
    CouldNotRun { message: String },
}

/// What rejecting a change came to.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum RejectOutcome {
    /// The rejection is committed and the copy is gone; its record stays on `record_branch`.
    Rejected { record_branch: String },
    /// The rejection is committed, but the plugin refused to remove the copy.
    RejectedNotRemoved { problems: Vec<String> },
    /// The plugin does not offer rejecting this change; `message` is its reason as it printed it.
    Refused { message: String },
    /// Nothing was committed and the status edits were taken back.
    NotCommitted { problems: Vec<String> },
    /// The plugin could not run, or a document could not be edited.
    CouldNotRun { message: String },
}

/// Accepts `doc` of `change`: `status: accepted` in its front matter, the plugin's `accept-<doc>` commit,
/// then the `doc.accept` event. `place` is the workspace's own master, as `Program::resolve` finds it.
pub fn apply(
    _program: &Program,
    _place: &Place,
    _system: &str,
    _change: &ChangeState,
    _doc: Document,
) -> AcceptOutcome {
    AcceptOutcome::CouldNotRun {
        message: "not implemented".into(),
    }
}

/// Rejects `change` the way the plugin's own `intent --reject` and `fix --reject` do.
pub fn reject(
    _program: &Program,
    _place: &Place,
    _system: &str,
    _change: &ChangeState,
) -> RejectOutcome {
    RejectOutcome::CouldNotRun {
        message: "not implemented".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_sdlc::state;
    use crate::offer::{self, LiveFacts, StageAction};
    use crate::testutil;
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};

    const SYSTEM: &str = "demo";
    const CHANGE: &str = "2026-11-01-greeting";
    const MARKER: &str = r#"{"version":1,"systems":{"demo":{"repos":["app"]}}}"#;

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        testutil::run(dir, args).unwrap()
    }

    fn intent(status: &str, extra: &str) -> String {
        format!("---\ntitle: Greeting\nsystem: demo\nauthor: t\ndate: 2026-11-01\nstatus: {status}\nscope: demo\n{extra}---\n\n# Intent: Greeting\n")
    }

    const SPEC_BODY: &str = "\n# Spec\n\n```gherkin\nFeature: Demo\n  @R1 @from:outcome-1\n  Rule: The engineer sees what changed\n    @R1.1\n    Scenario: What changed after a build\n      Given a build\n      Then the engineer sees the diff\n\n    @R1.2\n    Scenario: What changed after a rebuild\n      Given a rebuild\n      Then the engineer sees the new diff\n```\n";

    /// A spec whose requirement has no ID tag: the format check refuses it, with its file and line.
    const SPEC_NO_ID: &str = "\n# Spec\n\n```gherkin\nFeature: Demo\n  Rule: The engineer sees what changed\n    @R1.1\n    Scenario: What changed after a build\n      Given a build\n      Then the engineer sees the diff\n```\n";

    fn spec(status: &str, pin: &str, body: &str) -> String {
        format!("---\nlayout: 2\nsystem: demo\nstatus: {status}\nsource_intent_commit: {pin}\n---\n{body}")
    }

    fn plan(status: &str, pin: &str) -> String {
        format!("---\nlayout: 2\nsystem: demo\nstatus: {status}\nsource_spec_commit: {pin}\n---\n\n# Plan: Demo\n\n## Tasks\n\n### T1: Show the diff\n\n```yaml\nid: T1\nrepo: app\ndepends_on: []\ncovers: [R1.1]\n```\n\n#### Change\n\nShow the diff.\n\n#### Tests\n\nTest it first.\n\n### T2: Show the new diff\n\n```yaml\nid: T2\nrepo: app\ndepends_on: [T1]\ncovers: [R1.2]\n```\n\n#### Change\n\nShow the new diff.\n\n#### Tests\n\nTest it too.\n")
    }

    /// A workspace: the master `ai-sdlc` (a marker for system `demo`, and whatever `base` commits), the
    /// product repository `app`, and a change the plugin started, with its copy.
    struct Fx {
        _dir: tempfile::TempDir,
        ws: PathBuf,
        master: PathBuf,
        copy: PathBuf,
    }

    impl Fx {
        fn new(base: &[(&str, &str)]) -> Fx {
            let dir = tempfile::tempdir().unwrap();
            let ws = dir.path().to_path_buf();
            let master = testutil::repo(&ws, "ai-sdlc");
            testutil::commit_file(&master, ".ai-sdlc.json", MARKER, "marker");
            for (rel, text) in base {
                testutil::commit_file(&master, rel, text, "base");
            }
            testutil::repo(&ws, "app");
            let place = Place {
                master: master.clone(),
                workspace: ws.clone(),
            };
            let started = program()
                .run(
                    &[
                        "change", "start", "--json", "--system", SYSTEM, "--change", CHANGE,
                        "--type", "feat", "--scope", "demo", "--title", "Greeting",
                    ],
                    &place,
                )
                .unwrap();
            assert_eq!(started["outcome"], "passed", "{started}");
            Fx {
                copy: ws.join(".ai-sdlc").join("copies").join(CHANGE),
                _dir: dir,
                ws,
                master,
            }
        }

        fn place(&self) -> Place {
            Place {
                master: self.master.clone(),
                workspace: self.ws.clone(),
            }
        }

        fn folder(&self) -> PathBuf {
            self.copy.join("intent").join(SYSTEM).join(CHANGE)
        }

        fn rel(&self, name: &str) -> String {
            format!("intent/{SYSTEM}/{CHANGE}/{name}")
        }

        /// Writes a document into the copy and commits it, as the plugin's own skills would have.
        fn commit_doc(&self, name: &str, text: &str) -> String {
            testutil::commit_file(&self.copy, &self.rel(name), text, &format!("doc {name}"));
            self.head()
        }

        fn head(&self) -> String {
            git(&self.copy, &["rev-parse", "HEAD"])
        }

        fn text(&self, name: &str) -> String {
            std::fs::read_to_string(self.folder().join(name)).unwrap()
        }

        fn state(&self) -> ChangeState {
            state::state(&program(), &self.ws, SYSTEM, Some(CHANGE))
                .unwrap()
                .changes
                .into_iter()
                .next()
                .expect("the change is listed")
        }

        fn listed(&self) -> bool {
            !state::state(&program(), &self.ws, SYSTEM, None)
                .unwrap()
                .changes
                .iter()
                .all(|c| c.change != CHANGE)
        }

        /// The actions the page would offer now, with whether each is enabled.
        fn offered(&self) -> Vec<(StageAction, bool)> {
            offer::of(&self.state(), &LiveFacts::default())
                .actions
                .iter()
                .map(|a| (a.action, a.enabled))
                .collect()
        }

        fn apply(&self, doc: Document) -> AcceptOutcome {
            apply(&program(), &self.place(), SYSTEM, &self.state(), doc)
        }

        fn log_of(&self, branch: &str) -> String {
            git(&self.master, &["log", "-1", "--format=%s%n%b", branch])
        }
    }

    /// A change whose `doc` is drafted and waiting to be accepted, the documents above it accepted.
    fn ready(doc: Document, spec_body: &str, base: &[(&str, &str)]) -> Fx {
        let fx = Fx::new(base);
        let accepted_intent = intent("accepted", "");
        match doc {
            Document::Intent => {
                fx.commit_doc("intent.md", &intent("draft", ""));
            }
            Document::Spec | Document::Plan => {
                let pin = fx.commit_doc("intent.md", &accepted_intent);
                match doc {
                    Document::Spec => {
                        fx.commit_doc("spec.md", &spec("draft", &pin, spec_body));
                    }
                    _ => {
                        let spec_pin = fx.commit_doc("spec.md", &spec("accepted", &pin, spec_body));
                        fx.commit_doc("plan.md", &plan("draft", &spec_pin));
                    }
                }
            }
        }
        fx
    }

    fn file_of(doc: Document) -> &'static str {
        match doc {
            Document::Intent => "intent.md",
            Document::Spec => "spec.md",
            Document::Plan => "plan.md",
        }
    }

    fn subject(dir: &Path) -> String {
        git(dir, &["log", "-1", "--format=%s"])
    }

    fn pre_commit_hook(master: &Path, body: &str) {
        let hook = master.join(".git").join("hooks").join("pre-commit");
        std::fs::write(&hook, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn accept_hook(run: Value) -> String {
        json!({"version": 1, "hooks": {"doc.accept": [{"id": "docs-lint", "run": run}]}})
            .to_string()
    }

    #[test]
    fn accepting_a_document_rows() {
        // R3.1 "the commit and the accepting step pass": one case for each document.
        for (doc, header, next) in [
            (Document::Intent, "accept intent", StageAction::StartSpec),
            (Document::Spec, "accept spec", StageAction::StartPlan),
            (Document::Plan, "accept plan", StageAction::StartBuild),
        ] {
            let fx = ready(doc, SPEC_BODY, &[]);
            let before = git(&fx.copy, &["rev-list", "--count", "HEAD"]);
            let outcome = fx.apply(doc);
            assert_eq!(outcome, AcceptOutcome::Accepted, "{doc:?}");
            // The plugin made one commit, with its header and trailer; Kata made none.
            assert_eq!(
                git(&fx.copy, &["rev-list", "--count", "HEAD"])
                    .parse::<u32>()
                    .unwrap(),
                before.parse::<u32>().unwrap() + 1,
                "{doc:?}"
            );
            assert_eq!(
                subject(&fx.copy),
                format!("docs(demo): {header} {CHANGE}"),
                "{doc:?}"
            );
            assert!(git(&fx.copy, &["log", "-1", "--format=%b"]).contains("Generated-By: ai-sdlc"));
            // The document shows as accepted, and the next step is offered by the next state read.
            let committed = git(
                &fx.copy,
                &["show", &format!("HEAD:{}", fx.rel(file_of(doc)))],
            );
            assert!(committed.contains("status: accepted"), "{doc:?}");
            let state = fx.state();
            let status = match doc {
                Document::Intent => &state.documents.intent,
                Document::Spec => &state.documents.spec,
                Document::Plan => &state.documents.plan,
            };
            assert_eq!(status.head_status.as_deref(), Some("accepted"), "{doc:?}");
            assert_eq!(
                status.working_status.as_deref(),
                Some("accepted"),
                "{doc:?}"
            );
            assert!(!status.uncommitted, "{doc:?}");
            assert!(
                fx.offered().contains(&(next, true)),
                "{doc:?}: {:?}",
                fx.offered()
            );
        }

        // R3.1 "the format check fails" (row 4): nothing is committed, each problem has its file and line.
        {
            let fx = ready(Document::Spec, SPEC_NO_ID, &[]);
            let head = fx.head();
            let before = fx.text("spec.md");
            let AcceptOutcome::NotCommitted { problems } = fx.apply(Document::Spec) else {
                panic!("expected NotCommitted");
            };
            assert!(!problems.is_empty());
            for p in &problems {
                let at = p
                    .find("spec.md:")
                    .unwrap_or_else(|| panic!("no file and line in {p}"));
                assert!(
                    p[at + "spec.md:".len()..].starts_with(|c: char| c.is_ascii_digit()),
                    "{p}"
                );
            }
            assert_eq!(fx.head(), head);
            assert_eq!(fx.text("spec.md"), before, "the status edit is reverted");
        }

        // R3.1 "a git hook refuses the commit" (row 5): nothing is committed, the hook's output is shown.
        {
            let fx = ready(Document::Plan, SPEC_BODY, &[]);
            pre_commit_hook(&fx.master, "echo hook says no >&2\nexit 1");
            let head = fx.head();
            let before = fx.text("plan.md");
            let AcceptOutcome::NotCommitted { problems } = fx.apply(Document::Plan) else {
                panic!("expected NotCommitted");
            };
            assert!(problems.join("\n").contains("hook says no"), "{problems:?}");
            assert_eq!(fx.head(), head);
            assert_eq!(fx.text("plan.md"), before, "the status edit is reverted");
        }

        // R3.1 "a team hook on accepting fails" (row 2): committed, the hook's failure and output shown.
        {
            let hooks = accept_hook(json!([
                "node",
                "-e",
                "console.log('lint says no');process.exit(1)"
            ]));
            let fx = ready(
                Document::Spec,
                SPEC_BODY,
                &[("intent/demo/hooks.json", &hooks)],
            );
            let outcome = fx.apply(Document::Spec);
            let AcceptOutcome::AcceptedHookFailed { hook, output, .. } = outcome else {
                panic!("expected AcceptedHookFailed, got {outcome:?}");
            };
            assert_eq!(hook.as_deref(), Some("docs-lint"));
            assert!(output.contains("lint says no"), "{output}");
            // The acceptance stays committed; the engineer decides.
            assert_eq!(
                subject(&fx.copy),
                format!("docs(demo): accept spec {CHANGE}")
            );
            assert!(fx.text("spec.md").contains("status: accepted"));
        }

        // Row 2, the hook refused before it ran: `refused` is shown as a failure with the plugin's problems.
        // Row 3: the machine could not run the hook.
        {
            let hooks = accept_hook(json!(["kata-no-such-program-on-this-machine"]));
            let fx = ready(
                Document::Intent,
                SPEC_BODY,
                &[("intent/demo/hooks.json", &hooks)],
            );
            let outcome = fx.apply(Document::Intent);
            let AcceptOutcome::AcceptedHookCouldNotRun { output } = outcome else {
                panic!("expected AcceptedHookCouldNotRun, got {outcome:?}");
            };
            assert!(!output.trim().is_empty());
            assert_eq!(
                subject(&fx.copy),
                format!("docs(demo): accept intent {CHANGE}")
            );
        }

        // Row 6: the plugin could not run the commit; the edit is reverted and nothing is committed.
        {
            let fx = ready(Document::Intent, SPEC_BODY, &[]);
            let head = fx.head();
            let before = fx.text("intent.md");
            let gone = Program {
                node: "node".into(),
                entry: fx.ws.join("no-such-plugin").join("ai-sdlc.ts"),
            };
            let outcome = apply(&gone, &fx.place(), SYSTEM, &fx.state(), Document::Intent);
            let AcceptOutcome::CouldNotRun { message } = outcome else {
                panic!("expected CouldNotRun, got {outcome:?}");
            };
            assert!(!message.is_empty());
            assert_eq!(fx.head(), head);
            assert_eq!(fx.text("intent.md"), before, "the status edit is reverted");
        }
    }

    /// The fix track: an intent that says `track: fix`, and a drafted plan.
    fn fix_change() -> Fx {
        let fx = Fx::new(&[]);
        let pin = fx.commit_doc("intent.md", &intent("draft", "track: fix\n"));
        fx.commit_doc("spec.md", &spec("draft", &pin, SPEC_BODY));
        fx.commit_doc("plan.md", &plan("draft", &pin));
        fx
    }

    #[test]
    fn rejecting_goes_through_the_plugin_and_takes_the_change_away() {
        // R3.3 "full pipeline, intent, nothing was built".
        {
            let fx = ready(Document::Intent, SPEC_BODY, &[]);
            let branch = fx.state_branch();
            let before = git(&fx.master, &["rev-list", "--count", &branch])
                .parse::<u32>()
                .unwrap();
            let outcome = reject(&program(), &fx.place(), SYSTEM, &fx.state());
            assert_eq!(
                outcome,
                RejectOutcome::Rejected {
                    record_branch: branch.clone()
                }
            );
            // The plugin committed the rejection: its header, its trailer, one commit and no other.
            let log = fx.log_of(&branch);
            assert!(
                log.starts_with(&format!("docs(demo): reject intent {CHANGE}")),
                "{log}"
            );
            assert!(log.contains("Generated-By: ai-sdlc"), "{log}");
            assert_eq!(
                git(&fx.master, &["rev-list", "--count", &branch])
                    .parse::<u32>()
                    .unwrap(),
                before + 1
            );
            let record = git(
                &fx.master,
                &["show", &format!("{branch}:{}", fx.rel("intent.md"))],
            );
            assert!(record.contains("status: rejected"));
            // The copy is gone, the branch remains, and the change leaves the list.
            assert!(!fx.copy.exists());
            assert!(!git(&fx.master, &["branch", "--list", &branch]).is_empty());
            assert!(!fx.listed());
        }

        // R3.3 "light track, fix, nothing was built": the plan is superseded and the header says fix.
        {
            let fx = fix_change();
            let branch = fx.state_branch();
            let outcome = reject(&program(), &fx.place(), SYSTEM, &fx.state());
            assert_eq!(
                outcome,
                RejectOutcome::Rejected {
                    record_branch: branch.clone()
                }
            );
            let log = fx.log_of(&branch);
            assert!(
                log.starts_with(&format!("docs(demo): reject fix {CHANGE}")),
                "{log}"
            );
            assert!(log.contains("Generated-By: ai-sdlc"), "{log}");
            let plan_text = git(
                &fx.master,
                &["show", &format!("{branch}:{}", fx.rel("plan.md"))],
            );
            assert!(plan_text.contains("status: superseded"), "{plan_text}");
            let intent_text = git(
                &fx.master,
                &["show", &format!("{branch}:{}", fx.rel("intent.md"))],
            );
            assert!(intent_text.contains("status: rejected"));
            assert!(!fx.copy.exists());
            assert!(!git(&fx.master, &["branch", "--list", &branch]).is_empty());
            assert!(!fx.listed());
        }

        // R3.3 "a build log already exists": rejecting is not offered, and the plugin's reason is shown as is.
        {
            let fx = ready(Document::Intent, SPEC_BODY, &[]);
            fx.commit_doc("build/app.md", "---\nlayout: 2\n---\n\n# Build log: app\n");
            let state = fx.state();
            let stop = state.ready.reject.stop.clone().expect("the plugin refuses");
            let head = fx.head();
            let outcome = reject(&program(), &fx.place(), SYSTEM, &state);
            assert_eq!(outcome, RejectOutcome::Refused { message: stop });
            assert_eq!(fx.head(), head, "no commit was made");
            assert!(fx.copy.exists(), "nothing was removed");
            assert!(fx.listed());
            assert_eq!(fx.text("intent.md"), intent("draft", ""));
        }

        // Rows 4 to 6 apply to a rejection too: a git hook refuses, and the edit is taken back.
        {
            let fx = fix_change();
            pre_commit_hook(&fx.master, "echo hook says no >&2\nexit 1");
            let head = fx.head();
            let (intent_before, plan_before) = (fx.text("intent.md"), fx.text("plan.md"));
            let outcome = reject(&program(), &fx.place(), SYSTEM, &fx.state());
            let RejectOutcome::NotCommitted { problems } = outcome else {
                panic!("expected NotCommitted, got {outcome:?}");
            };
            assert!(problems.join("\n").contains("hook says no"), "{problems:?}");
            assert_eq!(fx.head(), head);
            assert_eq!(fx.text("intent.md"), intent_before);
            assert_eq!(fx.text("plan.md"), plan_before);
            assert!(fx.copy.exists());
        }

        // The rejection landed and the plugin refused to remove the copy: an uncommitted file stops it.
        {
            let fx = ready(Document::Intent, SPEC_BODY, &[]);
            std::fs::write(fx.folder().join("notes.txt"), "keep me\n").unwrap();
            let outcome = reject(&program(), &fx.place(), SYSTEM, &fx.state());
            let RejectOutcome::RejectedNotRemoved { problems } = outcome else {
                panic!("expected RejectedNotRemoved, got {outcome:?}");
            };
            assert!(problems.join("\n").contains("notes.txt"), "{problems:?}");
            assert_eq!(
                subject(&fx.copy),
                format!("docs(demo): reject intent {CHANGE}")
            );
            assert!(fx.copy.exists());
        }
    }

    impl Fx {
        /// The branch the change uses, as the plugin records it.
        fn state_branch(&self) -> String {
            program()
                .change_show(&self.place(), CHANGE, false)
                .unwrap()
                .branch
        }
    }
}
