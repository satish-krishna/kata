//! Where a change stands: `state --json`, typed field for field as the program's GRAMMAR.md ("Where a
//! change stands") defines it. Kata reads the answer; the program decides every gate in it.
use super::{Program, ProgramError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// Whether a change takes the full pipeline or the light fix track.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ChangeTrack {
    Full,
    Fix,
}

/// Whether a document's source pin still matches the document above it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum SourcePin {
    Missing,
    Broken,
    Holds,
}

/// What the program found out about one of the intent, the spec and the plan.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct StateDocument {
    pub exists: bool,
    pub in_head: bool,
    pub head_status: Option<String>,
    pub working_status: Option<String>,
    pub uncommitted: bool,
    pub pin: Option<SourcePin>,
}

/// The three documents of a change.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct StateDocuments {
    pub intent: StateDocument,
    pub spec: StateDocument,
    pub plan: StateDocument,
}

/// One repository's share of the plan.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RepoTasks {
    pub all: Vec<String>,
    pub logged: Vec<String>,
    pub unlogged: Vec<String>,
    pub commits: Option<BTreeMap<String, Vec<String>>>,
    pub untasked: Option<Vec<String>>,
    pub uncommitted: Option<Vec<String>>,
}

/// How a build log differs from `HEAD`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum BuildLogState {
    Clean,
    AddedEntries,
    Other,
}

/// How the working review document differs from `HEAD`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ReviewDraft {
    None,
    NextSection,
    Other,
}

/// The review document's standing.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ReviewState {
    pub committed: u32,
    pub draft: ReviewDraft,
}

/// One skill's gate for a change.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ReadyGate {
    pub candidate: bool,
    pub stop: Option<String>,
    pub accept: Vec<String>,
}

/// Every skill's gate for a change.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Ready {
    pub spec: ReadyGate,
    pub plan: ReadyGate,
    pub build: ReadyGate,
    pub review: ReadyGate,
    pub done: ReadyGate,
    pub reject: ReadyGate,
}

/// Where one change stands.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ChangeState {
    pub change: String,
    pub master: String,
    pub folder: String,
    pub in_copy: bool,
    pub title: Option<String>,
    pub track: ChangeTrack,
    pub documents: StateDocuments,
    pub scenarios: Option<u32>,
    pub tasks: Option<BTreeMap<String, RepoTasks>>,
    pub build_logs: BTreeMap<String, BuildLogState>,
    pub review: ReviewState,
    pub fix: Option<crate::format::FixState>,
    pub ready: Ready,
}

/// Where every change of a system stands.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct SystemState {
    pub system: String,
    pub changes: Vec<ChangeState>,
    pub problems: Vec<String>,
}

/// Reads the program's `state --json` answer. Fields this version does not know are ignored.
pub fn read_state(answer: Value) -> Result<SystemState, ProgramError> {
    serde_json::from_value(answer).map_err(|e| ProgramError::CouldNotRun {
        message: format!("the state answer is not what this version reads: {e}"),
    })
}

/// Where the changes of `system` stand in `workspace`; with `change`, only that one. The master is the
/// one the program finds in the workspace (`resolve`); a change that lives in a copy reports the copy as
/// its `master`.
pub fn state(
    program: &Program,
    workspace: &Path,
    system: &str,
    change: Option<&str>,
) -> Result<SystemState, ProgramError> {
    let place = program.resolve(workspace)?;
    let mut command = vec!["state", "--json", "--system", system];
    if let Some(change) = change {
        command.extend(["--change", change]);
    }
    read_state(program.run(&command, &place)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_sdlc::Place;
    use crate::testutil;

    const EXAMPLE: &str = r#"{"system":"demo","changes":[{"change":"2026-11-01-greeting","master":"/ws/.ai-sdlc/copies/2026-11-01-greeting","folder":"/ws/.ai-sdlc/copies/2026-11-01-greeting/intent/demo/2026-11-01-greeting","inCopy":true,"title":"Greeting","track":"full",
 "documents":{"intent":{"exists":true,"inHead":true,"headStatus":"accepted","workingStatus":"accepted","uncommitted":false},"spec":{"exists":true,"inHead":true,"headStatus":"accepted","workingStatus":"accepted","uncommitted":false,"pin":"holds"},"plan":{"exists":true,"inHead":true,"headStatus":"accepted","workingStatus":"accepted","uncommitted":false,"pin":"holds"}},
 "scenarios":2,"tasks":{"app":{"all":["T1","T2"],"logged":["T1"],"unlogged":["T2"],"commits":{"T1":["4f1c2a9e0b7d3c5a8e6f1b2d4c7a9e0f3b5d8c1a"],"T2":[]},"untasked":[],"uncommitted":["src/greet.ts"]}},"buildLogs":{"app":"clean"},"review":{"committed":0,"draft":"none"},"fix":null,
 "ready":{"spec":{"candidate":false,"stop":null,"accept":["intent.md"]},"plan":{"candidate":false,"stop":null,"accept":["intent.md","spec.md"]},"build":{"candidate":true,"stop":null,"accept":["intent.md","spec.md","plan.md"]},"review":{"candidate":false,"stop":"These tasks have no build log entry yet: `app`: T2.","accept":["intent.md","spec.md","plan.md"]},"done":{"candidate":false,"stop":null,"accept":[]},"reject":{"candidate":false,"stop":"`greeting` has build work (a build log or a review), so it is not rejected. The engineer settles that work first.","accept":[]}}}],"problems":[]}"#;

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    fn norm(s: &str) -> String {
        s.replace('\\', "/").to_lowercase()
    }

    fn doc(head: &str, pin: Option<SourcePin>) -> StateDocument {
        StateDocument {
            exists: true,
            in_head: true,
            head_status: Some(head.into()),
            working_status: Some(head.into()),
            uncommitted: false,
            pin,
        }
    }

    fn gate(candidate: bool, stop: Option<&str>, accept: &[&str]) -> ReadyGate {
        ReadyGate {
            candidate,
            stop: stop.map(String::from),
            accept: accept.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn state_reads_the_grammar_example() {
        let answer: Value = serde_json::from_str(EXAMPLE).unwrap();
        let system = read_state(answer).unwrap();
        assert_eq!(system.system, "demo");
        assert!(system.problems.is_empty());
        assert_eq!(system.changes.len(), 1);
        let c = &system.changes[0];
        assert_eq!(c.change, "2026-11-01-greeting");
        assert_eq!(c.master, "/ws/.ai-sdlc/copies/2026-11-01-greeting");
        assert_eq!(
            c.folder,
            "/ws/.ai-sdlc/copies/2026-11-01-greeting/intent/demo/2026-11-01-greeting"
        );
        assert!(c.in_copy);
        assert_eq!(c.title.as_deref(), Some("Greeting"));
        assert_eq!(c.track, ChangeTrack::Full);
        assert_eq!(c.documents.intent, doc("accepted", None));
        assert_eq!(c.documents.spec, doc("accepted", Some(SourcePin::Holds)));
        assert_eq!(c.documents.plan, doc("accepted", Some(SourcePin::Holds)));
        assert_eq!(c.scenarios, Some(2));
        let tasks = c.tasks.as_ref().unwrap();
        assert_eq!(tasks.len(), 1);
        let app = &tasks["app"];
        assert_eq!(app.all, ["T1", "T2"]);
        assert_eq!(app.logged, ["T1"]);
        assert_eq!(app.unlogged, ["T2"]);
        let commits = app.commits.as_ref().unwrap();
        assert_eq!(commits["T1"], ["4f1c2a9e0b7d3c5a8e6f1b2d4c7a9e0f3b5d8c1a"]);
        assert!(commits["T2"].is_empty());
        assert_eq!(app.untasked, Some(vec![]));
        assert_eq!(app.uncommitted, Some(vec!["src/greet.ts".to_string()]));
        assert_eq!(c.build_logs["app"], BuildLogState::Clean);
        assert_eq!(c.build_logs.len(), 1);
        assert_eq!(c.review.committed, 0);
        assert_eq!(c.review.draft, ReviewDraft::None);
        assert!(c.fix.is_none());
        let all = ["intent.md", "spec.md", "plan.md"];
        assert_eq!(c.ready.spec, gate(false, None, &["intent.md"]));
        assert_eq!(c.ready.plan, gate(false, None, &["intent.md", "spec.md"]));
        assert_eq!(c.ready.build, gate(true, None, &all));
        assert_eq!(
            c.ready.review,
            gate(
                false,
                Some("These tasks have no build log entry yet: `app`: T2."),
                &all
            )
        );
        assert_eq!(c.ready.done, gate(false, None, &[]));
        assert!(!c.ready.reject.candidate);
        assert!(c
            .ready
            .reject
            .stop
            .as_deref()
            .unwrap()
            .contains("build work"));
        assert!(c.ready.reject.accept.is_empty());
    }

    #[test]
    fn state_reads_a_fix_and_unknown_fields_are_ignored() {
        let mut answer: Value = serde_json::from_str(EXAMPLE).unwrap();
        answer["somethingNew"] = serde_json::json!(1);
        answer["changes"][0]["alsoNew"] = serde_json::json!({"x": 1});
        answer["changes"][0]["tasks"] = Value::Null;
        answer["changes"][0]["scenarios"] = Value::Null;
        answer["changes"][0]["track"] = "fix".into();
        answer["changes"][0]["fix"] = serde_json::json!({
            "row": 3,
            "facts": {
                "intent": {"inHead": true, "headStatus": "accepted", "workingStatus": "accepted"},
                "spec": {"inHead": false, "headStatus": null, "workingStatus": null},
                "plan": {"inHead": false, "headStatus": null, "workingStatus": null},
                "unrecorded": [],
                "ownLinesOnly": false,
                "accepted": "leading",
                "acceptanceLast": true,
                "built": false
            }
        });
        let c = &read_state(answer).unwrap().changes[0];
        assert_eq!(c.track, ChangeTrack::Fix);
        assert!(c.tasks.is_none());
        assert!(c.scenarios.is_none());
        assert_eq!(c.fix.as_ref().unwrap().row, 3);
    }

    #[test]
    fn state_of_a_workspace_with_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        let master = testutil::repo(ws, "ai-sdlc");
        testutil::commit_file(
            &master,
            ".ai-sdlc.json",
            r#"{"version":1,"systems":{"demo":{"repos":["app"]}}}"#,
            "marker",
        );
        testutil::repo(ws, "app");
        let place = Place {
            master: master.clone(),
            workspace: ws.to_path_buf(),
        };
        let change = "2026-11-01-greeting";
        let started = program()
            .run(
                &[
                    "change",
                    "start",
                    "--json",
                    "--system",
                    "demo",
                    "--change",
                    change,
                    "--type",
                    "feat",
                    "--scope",
                    "X-1",
                    "--master",
                    &master.display().to_string(),
                    "--workspace",
                    &ws.display().to_string(),
                ],
                &place,
            )
            .unwrap();
        assert_eq!(started["outcome"], "passed", "{started}");
        let copy = started["details"]["copy"].as_str().unwrap().to_string();
        testutil::write(
            Path::new(&copy),
            &format!("intent/demo/{change}/intent.md"),
            "---\ntitle: Greeting\nstatus: draft\n---\n\n# Intent\n",
        );

        let found = state(&program(), ws, "demo", Some(change)).unwrap();
        assert_eq!(found.system, "demo");
        assert_eq!(found.changes.len(), 1);
        let c = &found.changes[0];
        assert_eq!(c.change, change);
        assert!(c.in_copy);
        assert_eq!(norm(&c.master), norm(&copy));
        assert!(norm(&c.folder).starts_with(&norm(&copy)));
        assert_eq!(c.title.as_deref(), Some("Greeting"));
        assert_eq!(c.documents.intent.working_status.as_deref(), Some("draft"));
        assert!(c.documents.intent.uncommitted);

        let all = state(&program(), ws, "demo", None).unwrap();
        assert_eq!(all.changes.len(), 1);
    }
}
