//! Removing a finished change's copy. Kata decides only what the change page offers: the offer appears for
//! a change in a copy whose recorded pull requests are all merged and whose copy holds no uncommitted file.
//! The removal itself is the plugin's `change remove`, which refuses a copy with uncommitted files at the
//! moment it removes it, so a file written after the offer still keeps the copy.
use crate::ai_sdlc::show::ChangeShow;
use crate::ai_sdlc::state::ChangeState;
use crate::ai_sdlc::{Place, Program, StepOutcome};
use crate::git::{Repo, StatusEntry};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// What the change page offers for a change's copy.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum CopyRemoval {
    /// The change has no copy, or its pull requests are not all merged: nothing is offered.
    NotOffered,
    /// The copy may be removed, once the engineer confirms.
    Offer,
    /// The copy holds uncommitted files, so no removal is offered; the files are named.
    Keep { uncommitted: Vec<String> },
}

/// What confirming the removal came to.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum RemoveOutcome {
    /// The copy is gone; `kept` names the branches the plugin kept, with its reason for each.
    Removed { kept: Vec<String> },
    /// The copy holds uncommitted files, so it is kept; the files are named.
    Keep { uncommitted: Vec<String> },
    /// The plugin refused for another reason; its words.
    Refused { problems: Vec<String> },
    /// The plugin could not run.
    CouldNotRun { message: String },
}

/// True when the change recorded pull requests and every one of them is `MERGED` in `show` (read with
/// `--refresh`). A pull request the plugin could not read is not merged.
pub fn merged(show: &ChangeShow) -> bool {
    let Some(record) = &show.record else {
        return false;
    };
    let Some(states) = &show.states else {
        return false;
    };
    !record.pull_requests.is_empty()
        && record
            .pull_requests
            .iter()
            .all(|p| states.get(&p.url).and_then(Option::as_deref) == Some("MERGED"))
}

/// Whether the copy's removal is offered: `status` is the copy's uncommitted files.
pub fn decide(change: &ChangeState, status: &[StatusEntry], merged: bool) -> CopyRemoval {
    if !change.in_copy || !merged {
        return CopyRemoval::NotOffered;
    }
    if status.is_empty() {
        CopyRemoval::Offer
    } else {
        CopyRemoval::Keep {
            uncommitted: status.iter().map(|e| e.path.clone()).collect(),
        }
    }
}

/// Reads what is offered for `change`: its pull requests' states from GitHub now, and the copy's files. A
/// change that is not in a copy is not offered anything, and GitHub is not asked.
pub fn offer(
    program: &Program,
    place: &Place,
    change: &ChangeState,
) -> Result<CopyRemoval, String> {
    if !change.in_copy {
        return Ok(CopyRemoval::NotOffered);
    }
    let show = program
        .change_show(place, &change.change, true)
        .map_err(|e| e.to_string())?;
    let status = if merged(&show) {
        copy_status(&change.master)?
    } else {
        Vec::new()
    };
    Ok(decide(change, &status, merged(&show)))
}

/// The branch the change uses, as the plugin records it; the copy holds it.
pub fn branch(program: &Program, place: &Place, change: &str) -> Result<String, String> {
    program
        .change_show(place, change, false)
        .map(|s| s.branch)
        .map_err(|e| e.to_string())
}

/// Removes the change's copy through the plugin (`change remove`, without `--abandon`: the branch stays
/// unless git sees it merged). `place` is the workspace's own master, so the command works once the copy
/// is gone. The plugin refuses a copy with uncommitted files as it removes it, so a file written after the
/// offer keeps the copy; the refusal is answered as `Keep` naming the files.
pub fn remove(program: &Program, place: &Place, change: &ChangeState) -> RemoveOutcome {
    let command = ["change", "remove", "--json", "--change", &change.change];
    let answer = program.step(&command, place);
    let problems = match answer.outcome {
        StepOutcome::Passed { .. } => {
            return RemoveOutcome::Removed {
                kept: strings(&answer.json["kept"]),
            }
        }
        StepOutcome::Refused { problems } | StepOutcome::Failed { problems, .. } => problems,
        StepOutcome::CouldNotRun { reason, .. } => {
            return RemoveOutcome::CouldNotRun { message: reason }
        }
    };
    // The copy is still there when the plugin refused: its files are the reason, or it says another.
    match copy_status(&change.master) {
        Ok(files) if !files.is_empty() => RemoveOutcome::Keep {
            uncommitted: files.into_iter().map(|e| e.path).collect(),
        },
        _ => RemoveOutcome::Refused { problems },
    }
}

fn copy_status(copy: &str) -> Result<Vec<StatusEntry>, String> {
    Repo::open(Path::new(copy))
        .and_then(|r| r.status(""))
        .map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_sdlc::state;
    use crate::git::Repo;
    use crate::testutil;
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

    /// A workspace with a master, a product repository and a change the plugin started, with its copy.
    struct Fx {
        _dir: tempfile::TempDir,
        ws: PathBuf,
        master: PathBuf,
        copy: PathBuf,
    }

    impl Fx {
        fn new() -> Fx {
            let dir = tempfile::tempdir().unwrap();
            let ws = dir.path().to_path_buf();
            let master = testutil::repo(&ws, "ai-sdlc");
            testutil::commit_file(&master, ".ai-sdlc.json", MARKER, "marker");
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
            let copy = ws.join(".ai-sdlc").join("copies").join(CHANGE);
            // A commit on the change branch, so git does not see the branch as merged into main and the
            // plugin keeps it, as it does for a branch whose pull request was squash-merged.
            testutil::commit_file(
                &copy,
                &format!("intent/{SYSTEM}/{CHANGE}/intent.md"),
                "---\nstatus: accepted\n---\n# Intent\n",
                "intent",
            );
            Fx {
                copy,
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

        fn state(&self) -> ChangeState {
            state::state(&program(), &self.ws, SYSTEM, Some(CHANGE))
                .unwrap()
                .changes
                .into_iter()
                .next()
                .expect("the change is listed")
        }

        /// What the page would offer, with every pull request merged (or not, per `merged`).
        fn offered(&self, merged: bool) -> CopyRemoval {
            let state = self.state();
            let status = Repo::open(Path::new(&state.master))
                .unwrap()
                .status("")
                .unwrap();
            decide(&state, &status, merged)
        }

        fn write(&self, name: &str) {
            std::fs::write(self.copy.join(name), "x\n").unwrap();
        }

        fn branches(&self) -> String {
            testutil::run(&self.master, &["branch", "--list", "change/*"]).unwrap()
        }
    }

    fn show(states: Option<&[(&str, Option<&str>)]>, recorded: usize) -> ChangeShow {
        use crate::ai_sdlc::show::{ChangeRecord, RecordedByPlugin};
        ChangeShow {
            change: CHANGE.into(),
            system: SYSTEM.into(),
            branch: format!("change/{CHANGE}"),
            record: Some(ChangeRecord {
                branch: format!("change/{CHANGE}"),
                work_type: "feat".into(),
                scope: "demo".into(),
                base: "main".into(),
                pull_requests: (0..recorded)
                    .map(|i| RecordedByPlugin {
                        repo: format!("r{i}"),
                        url: format!("https://github.com/o/r{i}/pull/{i}"),
                        number: i as u64,
                        pushed: "abc".into(),
                    })
                    .collect(),
            }),
            repos: Default::default(),
            states: states.map(|s| {
                s.iter()
                    .map(|(u, v)| (u.to_string(), v.map(String::from)))
                    .collect()
            }),
        }
    }

    #[test]
    fn merged_means_every_recorded_pull_request_is_merged() {
        let a = "https://github.com/o/r0/pull/0";
        let b = "https://github.com/o/r1/pull/1";
        assert!(merged(&show(
            Some(&[(a, Some("MERGED")), (b, Some("MERGED"))]),
            2
        )));
        assert!(!merged(&show(
            Some(&[(a, Some("MERGED")), (b, Some("OPEN"))]),
            2
        )));
        assert!(!merged(&show(Some(&[(a, Some("MERGED")), (b, None)]), 2)));
        assert!(!merged(&show(Some(&[(a, Some("CLOSED"))]), 1)));
        // Nothing recorded, or nothing read, is not merged.
        assert!(!merged(&show(Some(&[]), 0)));
        assert!(!merged(&show(None, 1)));
    }

    #[test]
    fn removal_rows() {
        // The decision table, one case per row.
        let fx = Fx::new();
        let mut not_in_copy = fx.state();
        not_in_copy.in_copy = false;
        let dirty = [StatusEntry {
            path: "notes.txt".into(),
            index: '?',
            worktree: '?',
            from: None,
        }];
        // Row 1: not in a copy, whatever else holds.
        assert_eq!(decide(&not_in_copy, &[], true), CopyRemoval::NotOffered);
        assert_eq!(decide(&not_in_copy, &dirty, false), CopyRemoval::NotOffered);
        // Row 2: in a copy, not merged.
        assert_eq!(decide(&fx.state(), &[], false), CopyRemoval::NotOffered);
        assert_eq!(decide(&fx.state(), &dirty, false), CopyRemoval::NotOffered);
        // Row 3: in a copy, merged, nothing uncommitted.
        assert_eq!(decide(&fx.state(), &[], true), CopyRemoval::Offer);
        // Row 4: in a copy, merged, uncommitted files.
        assert_eq!(
            decide(&fx.state(), &dirty, true),
            CopyRemoval::Keep {
                uncommitted: vec!["notes.txt".into()]
            }
        );
    }

    #[test]
    fn removal_rows_of_removing_a_done_changes_copy() {
        // R15.3, nothing uncommitted, the engineer confirms: the copy is gone, the branch stays.
        let fx = Fx::new();
        assert_eq!(fx.offered(true), CopyRemoval::Offer);
        let outcome = remove(&program(), &fx.place(), &fx.state());
        // The plugin names the branch it kept, and why: git does not see it merged into main.
        let RemoveOutcome::Removed { kept } = outcome else {
            panic!("the copy is removed: {outcome:?}");
        };
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(
            kept[0].starts_with(&format!("master: change/{CHANGE}")),
            "{kept:?}"
        );
        assert!(!fx.copy.exists(), "the copy folder is gone");
        assert!(
            fx.branches().contains(&format!("change/{CHANGE}")),
            "the change branch stays in the master repository: {}",
            fx.branches()
        );

        // R15.3, nothing uncommitted, the engineer declines: nothing runs, the copy is kept and the offer stays.
        let fx = Fx::new();
        assert_eq!(fx.offered(true), CopyRemoval::Offer);
        assert!(fx.copy.exists());
        assert_eq!(fx.offered(true), CopyRemoval::Offer);

        // R15.3, uncommitted files, the engineer looks at the copy: nothing is offered and the files are named.
        let fx = Fx::new();
        fx.write("notes.txt");
        assert_eq!(
            fx.offered(true),
            CopyRemoval::Keep {
                uncommitted: vec!["notes.txt".into()]
            }
        );
        assert!(fx.copy.exists());
    }

    #[test]
    fn a_file_changed_before_confirming_keeps_the_copy() {
        // R15.2: the offer was made, a file appears, and the plugin's refusal comes back as Keep naming it.
        let fx = Fx::new();
        assert_eq!(fx.offered(true), CopyRemoval::Offer);
        fx.write("late.txt");
        let outcome = remove(&program(), &fx.place(), &fx.state());
        assert_eq!(
            outcome,
            RemoveOutcome::Keep {
                uncommitted: vec!["late.txt".into()]
            }
        );
        assert!(fx.copy.exists(), "the copy is still there");
        assert!(fx.copy.join("late.txt").exists());
    }
}
