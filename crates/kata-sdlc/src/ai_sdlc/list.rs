//! The light list: `list --json`, typed field for field as the program's GRAMMAR.md ("Listing a system's
//! changes") defines it. Kata reads the answer; the program decides what is finished.
use super::state::ChangeTrack;
use super::{Place, Program, ProgramError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How the program says a change ended.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Finished {
    Merged,
    Rejected,
}

/// One row of the light list.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ChangeListing {
    pub change: String,
    pub title: Option<String>,
    pub track: ChangeTrack,
    pub master: String,
    pub in_copy: bool,
    pub finished: Option<Finished>,
}

/// Every change of a system, open and finished.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeList {
    pub system: String,
    pub changes: Vec<ChangeListing>,
    pub problems: Vec<String>,
}

/// Reads the program's `list --json` answer. Fields this version does not know are ignored.
pub fn read_list(answer: Value) -> Result<ChangeList, ProgramError> {
    serde_json::from_value(answer).map_err(|e| ProgramError::CouldNotRun {
        message: format!("the list answer is not what this version reads: {e}"),
    })
}

impl Program {
    /// The changes of `system` with the few facts a list row needs, open and finished. Needs ai-sdlc
    /// 1.3.0 or later.
    pub fn list(&self, place: &Place, system: &str) -> Result<ChangeList, ProgramError> {
        read_list(self.run(&["list", "--json", "--system", system], place)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_sdlc::state;
    use crate::testutil;
    use std::path::Path;

    const EXAMPLE: &str = r#"{"system":"kata","changes":[{"change":"2026-11-03-end-finished-runs","title":"End finished runs","track":"full","master":"/ws/.ai-sdlc/copies/2026-11-03-end-finished-runs","inCopy":true,"finished":null}],"problems":[]}"#;

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    #[test]
    fn list_reads_the_grammar_example() {
        let mut answer: Value = serde_json::from_str(EXAMPLE).unwrap();
        answer["somethingNew"] = serde_json::json!(1);
        answer["changes"][0]["alsoNew"] = serde_json::json!({"x": 1});
        let list = read_list(answer).unwrap();
        assert_eq!(list.system, "kata");
        assert!(list.problems.is_empty());
        assert_eq!(
            list.changes,
            [ChangeListing {
                change: "2026-11-03-end-finished-runs".into(),
                title: Some("End finished runs".into()),
                track: ChangeTrack::Full,
                master: "/ws/.ai-sdlc/copies/2026-11-03-end-finished-runs".into(),
                in_copy: true,
                finished: None,
            }]
        );

        let finished: Value = serde_json::from_str(
            r#"{"system":"kata","changes":[
 {"change":"a","title":null,"track":"fix","master":"/m","inCopy":false,"finished":"merged"},
 {"change":"b","title":"B","track":"full","master":"/m","inCopy":false,"finished":"rejected"}],"problems":[]}"#,
        )
        .unwrap();
        let list = read_list(finished).unwrap();
        assert_eq!(list.changes[0].finished, Some(Finished::Merged));
        assert_eq!(list.changes[0].title, None);
        assert_eq!(list.changes[0].track, ChangeTrack::Fix);
        assert_eq!(list.changes[1].finished, Some(Finished::Rejected));
    }

    #[test]
    fn list_and_open_against_the_vendored_program() {
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
        let merged = "2026-10-12-photo-upload";
        testutil::commit_file(
            &master,
            &format!("intent/demo/{merged}/intent.md"),
            "---\ntitle: Photo upload\nstatus: accepted\n---\n\n# Intent\n",
            "intent",
        );
        let place = Place {
            master: master.clone(),
            workspace: ws.to_path_buf(),
        };
        let open = "2026-11-01-greeting";
        let started = program()
            .run(
                &[
                    "change", "start", "--json", "--system", "demo", "--change", open, "--type",
                    "feat", "--scope", "X-1",
                ],
                &place,
            )
            .unwrap();
        assert_eq!(started["outcome"], "passed", "{started}");
        let copy = started["details"]["copy"].as_str().unwrap().to_string();
        testutil::write(
            Path::new(&copy),
            &format!("intent/demo/{open}/intent.md"),
            "---\ntitle: Greeting\nstatus: draft\n---\n\n# Intent\n",
        );

        let listed = program().list(&place, "demo").unwrap();
        assert_eq!(listed.system, "demo");
        assert!(listed.problems.is_empty(), "{:?}", listed.problems);
        let names: Vec<&str> = listed.changes.iter().map(|c| c.change.as_str()).collect();
        assert_eq!(names, [merged, open]);
        assert_eq!(listed.changes[0].finished, Some(Finished::Merged));
        assert_eq!(listed.changes[0].title.as_deref(), Some("Photo upload"));
        assert!(!listed.changes[0].in_copy);
        assert_eq!(listed.changes[1].finished, None);
        assert_eq!(listed.changes[1].title.as_deref(), Some("Greeting"));
        assert!(listed.changes[1].in_copy);

        let only_open = state::open(&program(), ws, "demo").unwrap();
        assert_eq!(only_open.system, "demo");
        assert_eq!(only_open.changes.len(), 1);
        assert_eq!(only_open.changes[0].change, open);
        assert_eq!(only_open.changes[0].finished, None);
    }
}
