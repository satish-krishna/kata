//! Accepting and rejecting a change's documents through the ai-sdlc plugin. Kata edits one front matter
//! line; the plugin commits it (`commit --kind accept-<doc>` or `reject-intent` / `reject-fix`), runs the
//! `doc.accept` event and removes the rejected change's copy. Kata makes no commit and runs no hook.
use crate::ai_sdlc::state::{ChangeState, ChangeTrack};
use crate::ai_sdlc::{Place, Program, ProgramError};
use crate::frontmatter;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// A document of the full pipeline that is accepted by the engineer.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ChangeDocument {
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
    program: &Program,
    place: &Place,
    system: &str,
    change: &ChangeState,
    doc: ChangeDocument,
) -> AcceptOutcome {
    let file = doc.file();
    let mut edits = match Edit::start(&Path::new(&change.folder).join(file), "accepted") {
        Ok(edit) => vec![edit],
        Err(message) => return AcceptOutcome::CouldNotRun { message },
    };
    let at = copy_place(place, change);
    let kind = format!("accept-{}", doc.name());
    match commit(program, &at, system, &change.change, &kind, &edits) {
        Committed::Yes => {}
        Committed::No(problems) => {
            revert(&mut edits);
            return AcceptOutcome::NotCommitted { problems };
        }
        Committed::CouldNotRun(message) => {
            revert(&mut edits);
            return AcceptOutcome::CouldNotRun { message };
        }
    }
    let command = [
        "run",
        "doc.accept",
        "--json",
        "--system",
        system,
        "--change",
        &change.change,
        "--document",
        file,
    ];
    match program.run(&command, &at) {
        Ok(answer) => event_outcome(&answer),
        Err(ProgramError::Refused { stdout }) => AcceptOutcome::AcceptedHookFailed {
            hook: None,
            output: stdout,
            problems: Vec::new(),
        },
        Err(e) => AcceptOutcome::AcceptedHookCouldNotRun {
            output: e.to_string(),
        },
    }
}

/// Rejects `change` the way the plugin's own `intent --reject` and `fix --reject` do (section 13 of its
/// workspace reference): the intent is `rejected` and a plan is `superseded`, the plugin commits them, then
/// removes the change's copy and keeps the master's branch as the record. Nothing is rejected while the
/// plugin's `ready.reject` refuses. `place` is the workspace's own master, as `Program::resolve` finds it.
pub fn reject(
    program: &Program,
    place: &Place,
    system: &str,
    change: &ChangeState,
) -> RejectOutcome {
    if let Some(message) = &change.ready.reject.stop {
        return RejectOutcome::Refused {
            message: message.clone(),
        };
    }
    // The record branch is read first: the removal takes the copy, and the plugin's record with it.
    let branch = match program.change_show(place, &change.change, false) {
        Ok(show) => show.branch,
        Err(e) => {
            return RejectOutcome::CouldNotRun {
                message: e.to_string(),
            }
        }
    };
    let folder = Path::new(&change.folder);
    let mut edits = Vec::new();
    let mut targets = vec![(ChangeDocument::Intent, "rejected")];
    if change.documents.plan.exists {
        targets.push((ChangeDocument::Plan, "superseded"));
    }
    for (doc, status) in targets {
        match Edit::start(&folder.join(doc.file()), status) {
            Ok(edit) => edits.push(edit),
            Err(message) => {
                revert(&mut edits);
                return RejectOutcome::CouldNotRun { message };
            }
        }
    }
    let at = copy_place(place, change);
    let kind = match change.track {
        ChangeTrack::Fix => "reject-fix",
        ChangeTrack::Full => "reject-intent",
    };
    match commit(program, &at, system, &change.change, kind, &edits) {
        Committed::Yes => {}
        Committed::No(problems) => {
            revert(&mut edits);
            return RejectOutcome::NotCommitted { problems };
        }
        Committed::CouldNotRun(message) => {
            revert(&mut edits);
            return RejectOutcome::CouldNotRun { message };
        }
    }
    // From the workspace's own master, so the command still works once the copy is gone.
    let command = [
        "change",
        "remove",
        "--json",
        "--change",
        &change.change,
        "--abandon",
    ];
    match program.run(&command, place) {
        Ok(answer) => {
            let problems = strings(&answer["problems"]);
            if problems.is_empty() {
                RejectOutcome::Rejected {
                    record_branch: branch,
                }
            } else {
                RejectOutcome::RejectedNotRemoved { problems }
            }
        }
        Err(e) => RejectOutcome::RejectedNotRemoved {
            problems: vec![e.to_string()],
        },
    }
}

impl ChangeDocument {
    fn file(self) -> &'static str {
        match self {
            ChangeDocument::Intent => "intent.md",
            ChangeDocument::Spec => "spec.md",
            ChangeDocument::Plan => "plan.md",
        }
    }

    fn name(self) -> &'static str {
        match self {
            ChangeDocument::Intent => "intent",
            ChangeDocument::Spec => "spec",
            ChangeDocument::Plan => "plan",
        }
    }
}

/// Where the plugin works for `change`: the master that holds it (its copy) in the workspace of `place`.
fn copy_place(place: &Place, change: &ChangeState) -> Place {
    Place {
        master: PathBuf::from(&change.master),
        workspace: place.workspace.clone(),
    }
}

/// A front matter `status` edit made to a document, with what it needs to be taken back.
struct Edit {
    path: PathBuf,
    original: Vec<u8>,
    written: Vec<u8>,
}

impl Edit {
    /// Sets the document's `status` to `status` on disk.
    fn start(path: &Path, status: &str) -> Result<Edit, String> {
        let original = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let text = String::from_utf8(original.clone())
            .map_err(|_| format!("{} is not UTF-8 text", path.display()))?;
        let written = frontmatter::set_status(&text, status).into_bytes();
        if written != original {
            std::fs::write(path, &written).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        Ok(Edit {
            path: path.to_path_buf(),
            original,
            written,
        })
    }
}

/// Puts every edited document back as it was, unless the engineer changed it since: that edit is theirs.
fn revert(edits: &mut [Edit]) {
    for edit in edits {
        if edit.written != edit.original
            && std::fs::read(&edit.path).is_ok_and(|now| now == edit.written)
        {
            let _ = std::fs::write(&edit.path, &edit.original);
        }
    }
}

enum Committed {
    /// Committed, or nothing differed from `HEAD` (an acceptance already in the document).
    Yes,
    /// The check failed or git refused; the plugin's problems.
    No(Vec<String>),
    CouldNotRun(String),
}

/// Asks the plugin to commit the edited documents as `kind`.
fn commit(
    program: &Program,
    at: &Place,
    system: &str,
    change: &str,
    kind: &str,
    edits: &[Edit],
) -> Committed {
    let paths: Vec<String> = edits.iter().map(|e| e.path.display().to_string()).collect();
    let mut command = vec![
        "commit", "--json", "--kind", kind, "--system", system, "--change", change, "--",
    ];
    command.extend(paths.iter().map(String::as_str));
    match program.run(&command, at) {
        Ok(answer) if answer["committed"] == true => Committed::Yes,
        Ok(answer) if answer["reason"] == "nothing changed" => Committed::Yes,
        Ok(answer) => {
            let mut problems = strings(&answer["problems"]);
            if problems.is_empty() {
                problems.push(
                    answer["reason"]
                        .as_str()
                        .unwrap_or("the plugin did not commit")
                        .to_string(),
                );
            }
            Committed::No(problems)
        }
        Err(ProgramError::Refused { stdout }) => Committed::No(vec![stdout]),
        Err(e) => Committed::CouldNotRun(e.to_string()),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// What the `doc.accept` event's answer means for the acceptance that is already committed.
fn event_outcome(answer: &Value) -> AcceptOutcome {
    let problems = strings(&answer["problems"]);
    match answer["outcome"].as_str() {
        Some("passed") => AcceptOutcome::Accepted,
        Some("failed" | "refused") => {
            let failed = &answer["failed"];
            AcceptOutcome::AcceptedHookFailed {
                hook: failed["id"].as_str().map(String::from),
                output: failed["output"].as_str().unwrap_or_default().to_string(),
                problems,
            }
        }
        _ => {
            let hooks = answer["hooks"].as_array().cloned().unwrap_or_default();
            let mut output: Vec<String> = hooks
                .iter()
                .filter(|h| h["outcome"] == "could-not-run")
                .filter_map(|h| h["output"].as_str())
                .map(String::from)
                .collect();
            output.extend(problems);
            AcceptOutcome::AcceptedHookCouldNotRun {
                output: output.join("\n"),
            }
        }
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

        fn apply(&self, doc: ChangeDocument) -> AcceptOutcome {
            apply(&program(), &self.place(), SYSTEM, &self.state(), doc)
        }

        fn log_of(&self, branch: &str) -> String {
            git(&self.master, &["log", "-1", "--format=%s%n%b", branch])
        }
    }

    /// A change whose `doc` is drafted and waiting to be accepted, the documents above it accepted.
    fn ready(doc: ChangeDocument, spec_body: &str, base: &[(&str, &str)]) -> Fx {
        let fx = Fx::new(base);
        let accepted_intent = intent("accepted", "");
        match doc {
            ChangeDocument::Intent => {
                fx.commit_doc("intent.md", &intent("draft", ""));
            }
            ChangeDocument::Spec | ChangeDocument::Plan => {
                let pin = fx.commit_doc("intent.md", &accepted_intent);
                match doc {
                    ChangeDocument::Spec => {
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

    fn file_of(doc: ChangeDocument) -> &'static str {
        match doc {
            ChangeDocument::Intent => "intent.md",
            ChangeDocument::Spec => "spec.md",
            ChangeDocument::Plan => "plan.md",
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
            (
                ChangeDocument::Intent,
                "accept intent",
                StageAction::StartSpec,
            ),
            (ChangeDocument::Spec, "accept spec", StageAction::StartPlan),
            (ChangeDocument::Plan, "accept plan", StageAction::StartBuild),
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
                ChangeDocument::Intent => &state.documents.intent,
                ChangeDocument::Spec => &state.documents.spec,
                ChangeDocument::Plan => &state.documents.plan,
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
            let fx = ready(ChangeDocument::Spec, SPEC_NO_ID, &[]);
            let head = fx.head();
            let before = fx.text("spec.md");
            let AcceptOutcome::NotCommitted { problems } = fx.apply(ChangeDocument::Spec) else {
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
            let fx = ready(ChangeDocument::Plan, SPEC_BODY, &[]);
            pre_commit_hook(&fx.master, "echo hook says no >&2\nexit 1");
            let head = fx.head();
            let before = fx.text("plan.md");
            let AcceptOutcome::NotCommitted { problems } = fx.apply(ChangeDocument::Plan) else {
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
                ChangeDocument::Spec,
                SPEC_BODY,
                &[("intent/demo/hooks.json", &hooks)],
            );
            let outcome = fx.apply(ChangeDocument::Spec);
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
                ChangeDocument::Intent,
                SPEC_BODY,
                &[("intent/demo/hooks.json", &hooks)],
            );
            let outcome = fx.apply(ChangeDocument::Intent);
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
            let fx = ready(ChangeDocument::Intent, SPEC_BODY, &[]);
            let head = fx.head();
            let before = fx.text("intent.md");
            let gone = Program {
                node: "node".into(),
                entry: fx.ws.join("no-such-plugin").join("ai-sdlc.ts"),
            };
            let outcome = apply(
                &gone,
                &fx.place(),
                SYSTEM,
                &fx.state(),
                ChangeDocument::Intent,
            );
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
            let fx = ready(ChangeDocument::Intent, SPEC_BODY, &[]);
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
            let fx = ready(ChangeDocument::Intent, SPEC_BODY, &[]);
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
            let fx = ready(ChangeDocument::Intent, SPEC_BODY, &[]);
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
