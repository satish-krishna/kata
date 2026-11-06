//! Read past-run transcripts (`~/.kata/runs/*.jsonl`) into history records.
//! Each transcript is a stream of `KataEvent` lines; the first `run.started`
//! and the last terminal event determine a `RunRecord`.
use crate::event::KataEvent;
use crate::fsutil;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// How a recorded run ended, decided once here from the outcome-code contract so no screen maps exit codes.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunEnding {
    Finished,
    Failed,
    Cancelled,
    OutOfTime,
    NobodyAnswered,
    TurnCap,
    Budget,
}

impl RunEnding {
    /// The ending for a run whose transcript ends with `run.cancelled` (`cancelled`) or whose terminal event carried `exit`.
    pub fn from_exit(exit: Option<i32>, cancelled: bool) -> RunEnding {
        let _ = (exit, cancelled);
        RunEnding::Failed
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub kata: String,
    #[cfg_attr(feature = "ts", ts(as = "u32"))]
    pub started_at: u64,
    pub isolation: String,
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub exit: Option<i32>,
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub turns: Option<u32>,
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub cost_usd: Option<f64>,
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<u32>"))]
    pub duration_ms: Option<u64>,
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub result: Option<String>,
    /// True when the operator's message was accepted during the run.
    pub steered: bool,
    /// How the run ended.
    pub ending: RunEnding,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunDetail {
    pub record: RunRecord,
    pub events: Vec<KataEvent>,
}

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("run not found")]
    NotFound,
    #[error("invalid run id")]
    InvalidId,
    #[error("reading run: {0}")]
    Io(String),
}

/// All runs in `~/.kata/runs`, newest first. Best-effort: an unreadable or
/// malformed transcript is skipped, never fatal. Empty when there is no home.
pub fn list_runs() -> Vec<RunRecord> {
    let Some(dir) = fsutil::runs_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if let Ok(events) = read_events(&path) {
            if let Some(rec) = build_record(stem, &events) {
                out.push(rec);
            }
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.started_at));
    out
}

/// The path of an existing transcript, `<runs_dir>/<id>.jsonl`, after the guards every access shares:
/// a valid id, a file directly under the runs folder, and not a symlink.
fn transcript_path(id: &str) -> Result<std::path::PathBuf, HistoryError> {
    if !is_valid_id(id) {
        return Err(HistoryError::InvalidId);
    }
    let dir = fsutil::runs_dir().ok_or(HistoryError::NotFound)?;
    let path = dir.join(format!("{id}.jsonl"));
    // Path-traversal guard: the resolved file must sit directly under runs_dir.
    if path.parent() != Some(dir.as_path()) {
        return Err(HistoryError::InvalidId);
    }
    // Reject symlinks: the file's contents are returned to the webview, so a
    // symlink at <id>.jsonl could exfiltrate an arbitrary file. symlink_metadata
    // does not follow the link; a missing file errors here -> NotFound.
    let meta = std::fs::symlink_metadata(&path).map_err(|_| HistoryError::NotFound)?;
    if meta.file_type().is_symlink() {
        return Err(HistoryError::InvalidId);
    }
    Ok(path)
}

/// One run's record plus its full event stream (for the detail view).
pub fn load_run(id: &str) -> Result<RunDetail, HistoryError> {
    let path = transcript_path(id)?;
    let events = read_events(&path).map_err(|e| HistoryError::Io(e.to_string()))?;
    let record = build_record(id, &events).ok_or(HistoryError::NotFound)?;
    Ok(RunDetail { record, events })
}

/// Append one event as a JSON line to an existing transcript, `<runs_dir>/<id>.jsonl`.
///
/// Takes the event as a JSON value because the Workbench relay holds its events that way.
/// The same guards as `load_run` apply, and the file must already exist: this never creates a transcript.
/// When the transcript ends mid-line, the event starts on a new line so it is not lost.
pub fn append_event(id: &str, event: &serde_json::Value) -> Result<(), HistoryError> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let path = transcript_path(id)?;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .append(true)
        .open(&path)
        .map_err(|e| HistoryError::Io(e.to_string()))?;
    let ends_mid_line = match file.seek(SeekFrom::End(-1)) {
        Ok(_) => {
            let mut last = [0u8; 1];
            file.read_exact(&mut last)
                .map_err(|e| HistoryError::Io(e.to_string()))?;
            last[0] != b'\n'
        }
        Err(_) => false, // empty file
    };
    let line = if ends_mid_line {
        format!("\n{event}\n")
    } else {
        format!("{event}\n")
    };
    file.write_all(line.as_bytes())
        .map_err(|e| HistoryError::Io(e.to_string()))
}

fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Read a transcript into events, skipping blank and malformed lines.
fn read_events(path: &Path) -> std::io::Result<Vec<KataEvent>> {
    use std::io::BufRead;
    let file = std::fs::File::open(path)?;
    let mut events = Vec::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(ev) = serde_json::from_str::<KataEvent>(&line) {
            events.push(ev);
        }
    }
    Ok(events)
}

/// Derive a record from a transcript's events: the first `run.started` carries
/// kata + isolation; the last terminal event carries exit + summary fields.
/// `None` when the stem has no parseable stamp or there is no `run.started`.
fn build_record(stem: &str, events: &[KataEvent]) -> Option<RunRecord> {
    let started_at = fsutil::parse_stamp(stem)?;
    let (kata, isolation) = events.iter().find_map(|e| match e {
        KataEvent::RunStarted {
            spec, isolation, ..
        } => Some((spec.clone(), isolation.clone())),
        _ => None,
    })?;
    let terminal = events.iter().rev().find(|e| {
        matches!(
            e,
            KataEvent::RunCompleted { .. }
                | KataEvent::RunError { .. }
                | KataEvent::RunCancelled { .. }
        )
    });
    let (exit, turns, cost_usd, duration_ms, result) = match terminal {
        Some(KataEvent::RunCompleted {
            exit_code,
            num_turns,
            cost_usd,
            duration_ms,
            result,
            ..
        }) => (
            Some(*exit_code),
            Some(*num_turns),
            *cost_usd,
            Some(*duration_ms),
            result.clone(),
        ),
        Some(KataEvent::RunError {
            exit_code,
            message,
            cost_usd,
            duration_ms,
        }) => (
            Some(*exit_code),
            None,
            *cost_usd,
            Some(*duration_ms),
            Some(message.clone()),
        ),
        Some(KataEvent::RunCancelled {
            exit_code,
            cost_usd,
            duration_ms,
        }) => (
            Some(*exit_code),
            None,
            *cost_usd,
            Some(*duration_ms),
            Some("cancelled".to_string()),
        ),
        _ => (None, None, None, None, None),
    };
    Some(RunRecord {
        id: stem.to_string(),
        kata,
        started_at,
        isolation,
        exit,
        turns,
        cost_usd,
        duration_ms,
        result,
        steered: is_steered(events),
        ending: RunEnding::from_exit(
            exit,
            matches!(
                events.iter().rev().find(|e| matches!(
                    e,
                    KataEvent::RunCompleted { .. }
                        | KataEvent::RunError { .. }
                        | KataEvent::RunCancelled { .. }
                )),
                Some(KataEvent::RunCancelled { .. })
            ),
        ),
    })
}

/// Whether the operator's message was accepted during the run: a
/// `message.sent` event. Refusals do not count.
pub fn is_steered(events: &[KataEvent]) -> bool {
    events
        .iter()
        .any(|e| matches!(e, KataEvent::MessageSent { .. }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::io::Write;

    // Each test seeds its own runs dir and points KATA_HOME at it.
    fn seed(files: &[(&str, &str)]) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("KATA_HOME", home.path());
        let runs = crate::fsutil::runs_dir().unwrap();
        std::fs::create_dir_all(&runs).unwrap();
        for (name, body) in files {
            let mut f = std::fs::File::create(runs.join(name)).unwrap();
            f.write_all(body.as_bytes()).unwrap();
        }
        home
    }

    const COMPLETED: &str = concat!(
        r#"{"type":"run.started","spec":"triage","model":null,"workdir":"/w","isolation":"none"}"#,
        "\n",
        r#"{"type":"turn","n":1}"#,
        "\n",
        r#"{"type":"run.completed","exit_code":0,"is_error":false,"num_turns":4,"cost_usd":0.041,"duration_ms":48120,"result":"isolated the flake"}"#,
        "\n",
    );
    const KILLED: &str = concat!(
        r#"{"type":"run.started","spec":"audit","model":null,"workdir":"/w","isolation":"worktree"}"#,
        "\n",
        r#"{"type":"run.error","message":"reached max turns (12)","exit_code":125,"cost_usd":null,"duration_ms":9000}"#,
        "\n",
    );
    const CANCELLED: &str = concat!(
        r#"{"type":"run.started","spec":"perf","model":null,"workdir":"/w","isolation":"none"}"#,
        "\n",
        r#"{"type":"run.cancelled","exit_code":130,"cost_usd":null,"duration_ms":500}"#,
        "\n",
    );
    const INCOMPLETE: &str = concat!(
        r#"{"type":"run.started","spec":"doc","model":null,"workdir":"/w","isolation":"none"}"#,
        "\n",
        r#"{"type":"log","level":"info","message":"working"}"#,
        "\n",
    );

    #[test]
    #[serial]
    fn lists_records_newest_first_with_derived_fields() {
        let _h = seed(&[
            ("triage-20260618T100000Z.jsonl", COMPLETED),
            (
                "audit-20260618T120000Z.jsonl",
                &format!("{KILLED}garbage not json\n"),
            ),
            ("perf-20260617T080000Z.jsonl", CANCELLED),
        ]);
        let runs = list_runs();
        assert_eq!(runs.len(), 3);
        // newest first by started_at
        assert_eq!(runs[0].id, "audit-20260618T120000Z");
        assert_eq!(runs[2].id, "perf-20260617T080000Z");

        let completed = runs.iter().find(|r| r.kata == "triage").unwrap();
        assert_eq!(completed.exit, Some(0));
        assert_eq!(completed.turns, Some(4));
        assert_eq!(completed.cost_usd, Some(0.041));
        assert_eq!(completed.duration_ms, Some(48120));
        assert_eq!(completed.result.as_deref(), Some("isolated the flake"));

        let killed = runs.iter().find(|r| r.kata == "audit").unwrap();
        assert_eq!(killed.exit, Some(125));
        assert_eq!(killed.isolation, "worktree");
        assert_eq!(killed.turns, None); // unknown for killed runs
        assert_eq!(killed.cost_usd, None);
        assert_eq!(killed.result.as_deref(), Some("reached max turns (12)"));

        let cancelled = runs.iter().find(|r| r.kata == "perf").unwrap();
        assert_eq!(cancelled.exit, Some(130));
        assert_eq!(cancelled.result.as_deref(), Some("cancelled"));
    }

    #[test]
    fn run_ending_follows_the_outcome_codes() {
        assert_eq!(RunEnding::from_exit(Some(0), true), RunEnding::Cancelled);
        assert_eq!(RunEnding::from_exit(Some(130), true), RunEnding::Cancelled);
        assert_eq!(RunEnding::from_exit(None, true), RunEnding::Cancelled);
        assert_eq!(RunEnding::from_exit(None, false), RunEnding::Failed);
        assert_eq!(RunEnding::from_exit(Some(0), false), RunEnding::Finished);
        assert_eq!(RunEnding::from_exit(Some(122), false), RunEnding::Budget);
        assert_eq!(
            RunEnding::from_exit(Some(123), false),
            RunEnding::NobodyAnswered
        );
        assert_eq!(RunEnding::from_exit(Some(124), false), RunEnding::OutOfTime);
        assert_eq!(RunEnding::from_exit(Some(125), false), RunEnding::TurnCap);
        assert_eq!(RunEnding::from_exit(Some(130), false), RunEnding::Cancelled);
        assert_eq!(RunEnding::from_exit(Some(1), false), RunEnding::Failed);
        assert_eq!(RunEnding::from_exit(Some(2), false), RunEnding::Failed);
    }

    #[test]
    #[serial]
    fn a_cancelled_transcript_records_cancelled() {
        let _h = seed(&[("perf-20260617T080000Z.jsonl", CANCELLED)]);
        let runs = list_runs();
        assert_eq!(runs[0].exit, Some(130));
        assert_eq!(runs[0].ending, RunEnding::Cancelled);
    }

    #[test]
    #[serial]
    fn incomplete_transcript_has_no_exit() {
        let _h = seed(&[("doc-20260618T090000Z.jsonl", INCOMPLETE)]);
        let runs = list_runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].exit, None);
        assert_eq!(runs[0].result, None);
    }

    const STEERED: &str = concat!(
        r#"{"type":"run.started","spec":"triage","model":null,"workdir":"/w","isolation":"none"}"#,
        "\n",
        r#"{"type":"message.sent","id":"m1","text":"look at the lexer","sent_at":1700000000000}"#,
        "\n",
        r#"{"type":"message.read","id":"m1","read_at":1700000001000}"#,
        "\n",
        r#"{"type":"run.completed","exit_code":0,"is_error":false,"num_turns":4,"cost_usd":0.041,"duration_ms":48120,"result":"done"}"#,
        "\n",
    );
    const REFUSED_ONLY: &str = concat!(
        r#"{"type":"run.started","spec":"triage","model":null,"workdir":"/w","isolation":"none"}"#,
        "\n",
        r#"{"type":"message.refused","id":"m2","reason":"repeated","text":"again"}"#,
        "\n",
        r#"{"type":"run.completed","exit_code":0,"is_error":false,"num_turns":4,"cost_usd":0.041,"duration_ms":48120,"result":"done"}"#,
        "\n",
    );

    #[test]
    #[serial]
    fn steered_only_when_a_message_was_accepted() {
        let _h = seed(&[
            ("triage-20260618T100000Z.jsonl", STEERED),
            ("triage-20260618T110000Z.jsonl", COMPLETED),
        ]);
        let runs = list_runs();
        let steered = runs
            .iter()
            .find(|r| r.id == "triage-20260618T100000Z")
            .unwrap();
        let plain = runs
            .iter()
            .find(|r| r.id == "triage-20260618T110000Z")
            .unwrap();
        assert!(steered.steered);
        assert!(!plain.steered);
    }

    #[test]
    #[serial]
    fn refused_message_does_not_mark_steered() {
        let _h = seed(&[("triage-20260618T100000Z.jsonl", REFUSED_ONLY)]);
        let runs = list_runs();
        assert_eq!(runs.len(), 1);
        assert!(!runs[0].steered);
    }

    #[test]
    #[serial]
    fn load_run_keeps_message_events() {
        let _h = seed(&[("triage-20260618T100000Z.jsonl", STEERED)]);
        let detail = load_run("triage-20260618T100000Z").unwrap();
        assert!(detail.events.iter().any(|e| matches!(
            e,
            KataEvent::MessageSent {
                sent_at: 1_700_000_000_000,
                ..
            }
        )));
        assert!(detail.events.iter().any(|e| matches!(
            e,
            KataEvent::MessageRead {
                read_at: 1_700_000_001_000,
                ..
            }
        )));
    }

    #[test]
    #[serial]
    fn load_run_returns_full_events_and_guards_id() {
        let _h = seed(&[("triage-20260618T100000Z.jsonl", COMPLETED)]);
        let detail = load_run("triage-20260618T100000Z").unwrap();
        assert_eq!(detail.record.exit, Some(0));
        assert!(detail
            .events
            .iter()
            .any(|e| matches!(e, KataEvent::Turn { .. })));
        assert!(matches!(
            load_run("../escape"),
            Err(HistoryError::InvalidId)
        ));
        assert!(matches!(
            load_run("nope-20260101T000000Z"),
            Err(HistoryError::NotFound)
        ));
    }

    #[test]
    #[serial]
    fn an_appended_warning_is_in_the_run_after_reload() {
        let home = seed(&[("triage-20260618T100000Z.jsonl", COMPLETED)]);
        let id = "triage-20260618T100000Z";
        let before = load_run(id).unwrap().record;
        let warning = serde_json::json!({
            "type": "log",
            "level": "warn",
            "message": "run 7: the engine (pid 1) exited, but its output stayed open; the run was ended without waiting for it"
        });
        append_event(id, &warning).unwrap();
        let detail = load_run(id).unwrap();
        match detail.events.last() {
            Some(KataEvent::Log { level, message }) => {
                assert_eq!(level, "warn");
                assert!(message.contains("output stayed open"));
            }
            other => panic!("last event should be the warning, got {other:?}"),
        }
        assert_eq!(detail.record.exit, before.exit);
        assert_eq!(detail.record.result, before.result);
        assert_eq!(detail.record.turns, before.turns);

        assert!(matches!(
            append_event("../escape", &warning),
            Err(HistoryError::InvalidId)
        ));
        assert!(matches!(
            append_event("a/b", &warning),
            Err(HistoryError::InvalidId)
        ));
        let missing = "nope-20260101T000000Z";
        assert!(matches!(
            append_event(missing, &warning),
            Err(HistoryError::NotFound)
        ));
        let runs = crate::fsutil::runs_dir().unwrap();
        assert!(!runs.join(format!("{missing}.jsonl")).exists());
        drop(home);
    }

    #[test]
    #[serial]
    fn an_event_appended_after_a_cut_off_line_is_kept() {
        let cut_off = format!("{COMPLETED}{}", r#"{"type":"log","level":"info","mess"#);
        let home = seed(&[("triage-20260618T100000Z.jsonl", cut_off.as_str())]);
        let id = "triage-20260618T100000Z";
        let warning = serde_json::json!({
            "type": "log",
            "level": "warn",
            "message": "run 7: the engine (pid 1) exited, but its output stayed open"
        });
        append_event(id, &warning).unwrap();
        let detail = load_run(id).unwrap();
        match detail.events.last() {
            Some(KataEvent::Log { level, message }) => {
                assert_eq!(level, "warn");
                assert!(message.contains("output stayed open"));
            }
            other => panic!("last event should be the warning, got {other:?}"),
        }
        drop(home);
    }
}
