//! Read past-run transcripts (`~/.kata/runs/*.jsonl`) into history records.
//! Each transcript is a stream of `KataEvent` lines; the first `run.started`
//! and the last terminal event determine a `RunRecord`.
use crate::event::KataEvent;
use crate::fsutil;
use serde::Serialize;
use std::path::Path;

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize)]
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
    let Some(dir) = fsutil::runs_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if let Ok(events) = read_events(&path) {
            if let Some(rec) = build_record(stem, &events) {
                out.push(rec);
            }
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.started_at));
    out
}

/// One run's record plus its full event stream (for the detail view).
pub fn load_run(id: &str) -> Result<RunDetail, HistoryError> {
    if !is_valid_id(id) { return Err(HistoryError::InvalidId); }
    let dir = fsutil::runs_dir().ok_or(HistoryError::NotFound)?;
    let path = dir.join(format!("{id}.jsonl"));
    // Path-traversal guard: the resolved file must sit directly under runs_dir.
    if path.parent() != Some(dir.as_path()) { return Err(HistoryError::InvalidId); }
    if !path.exists() { return Err(HistoryError::NotFound); }
    let events = read_events(&path).map_err(|e| HistoryError::Io(e.to_string()))?;
    let record = build_record(id, &events).ok_or(HistoryError::NotFound)?;
    Ok(RunDetail { record, events })
}

fn is_valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Read a transcript into events, skipping blank and malformed lines.
fn read_events(path: &Path) -> std::io::Result<Vec<KataEvent>> {
    use std::io::BufRead;
    let file = std::fs::File::open(path)?;
    let mut events = Vec::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() { continue; }
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
        KataEvent::RunStarted { spec, isolation, .. } => Some((spec.clone(), isolation.clone())),
        _ => None,
    })?;
    let terminal = events.iter().rev().find(|e| matches!(
        e,
        KataEvent::RunCompleted { .. } | KataEvent::RunError { .. } | KataEvent::RunCancelled { .. }
    ));
    let (exit, turns, cost_usd, duration_ms, result) = match terminal {
        Some(KataEvent::RunCompleted { exit_code, num_turns, cost_usd, duration_ms, result, .. }) =>
            (Some(*exit_code), Some(*num_turns), *cost_usd, Some(*duration_ms), result.clone()),
        Some(KataEvent::RunError { exit_code, message }) =>
            (Some(*exit_code), None, None, None, Some(message.clone())),
        Some(KataEvent::RunCancelled { exit_code }) =>
            (Some(*exit_code), None, None, None, Some("cancelled".to_string())),
        _ => (None, None, None, None, None),
    };
    Some(RunRecord {
        id: stem.to_string(), kata, started_at, isolation,
        exit, turns, cost_usd, duration_ms, result,
    })
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
        r#"{"type":"run.started","spec":"triage","model":null,"workdir":"/w","isolation":"none"}"#, "\n",
        r#"{"type":"turn","n":1}"#, "\n",
        r#"{"type":"run.completed","exit_code":0,"is_error":false,"num_turns":4,"cost_usd":0.041,"duration_ms":48120,"result":"isolated the flake"}"#, "\n",
    );
    const KILLED: &str = concat!(
        r#"{"type":"run.started","spec":"audit","model":null,"workdir":"/w","isolation":"worktree"}"#, "\n",
        r#"{"type":"run.error","message":"reached max turns (12)","exit_code":125}"#, "\n",
    );
    const CANCELLED: &str = concat!(
        r#"{"type":"run.started","spec":"perf","model":null,"workdir":"/w","isolation":"none"}"#, "\n",
        r#"{"type":"run.cancelled","exit_code":130}"#, "\n",
    );
    const INCOMPLETE: &str = concat!(
        r#"{"type":"run.started","spec":"doc","model":null,"workdir":"/w","isolation":"none"}"#, "\n",
        r#"{"type":"log","level":"info","message":"working"}"#, "\n",
    );

    #[test]
    #[serial]
    fn lists_records_newest_first_with_derived_fields() {
        let _h = seed(&[
            ("triage-20260618T100000Z.jsonl", COMPLETED),
            ("audit-20260618T120000Z.jsonl", &format!("{KILLED}garbage not json\n")),
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
    #[serial]
    fn incomplete_transcript_has_no_exit() {
        let _h = seed(&[("doc-20260618T090000Z.jsonl", INCOMPLETE)]);
        let runs = list_runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].exit, None);
        assert_eq!(runs[0].result, None);
    }

    #[test]
    #[serial]
    fn load_run_returns_full_events_and_guards_id() {
        let _h = seed(&[("triage-20260618T100000Z.jsonl", COMPLETED)]);
        let detail = load_run("triage-20260618T100000Z").unwrap();
        assert_eq!(detail.record.exit, Some(0));
        assert!(detail.events.iter().any(|e| matches!(e, KataEvent::Turn { .. })));
        assert!(matches!(load_run("../escape"), Err(HistoryError::InvalidId)));
        assert!(matches!(load_run("nope-20260101T000000Z"), Err(HistoryError::NotFound)));
    }
}
