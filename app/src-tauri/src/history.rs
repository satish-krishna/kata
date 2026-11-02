//! Every live run's events, kept by the backend so a session opened later shows the whole run.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

/// What a run is waiting on. `since_ms` is the unix time in milliseconds the request was pushed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Pending {
    #[serde(rename_all = "camelCase")]
    Question { text: String, since_ms: u64 },
    #[serde(rename_all = "camelCase")]
    Permission { action: String, since_ms: u64 },
}

/// One event of a run with its position in the run.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct HistoryEntry {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub seq: u64,
    #[cfg_attr(feature = "ts", ts(type = "import(\"./kata-events\").KataEvent"))]
    pub event: Value,
}

/// How many ended runs keep their history. A page that learned of a run just before it ended still reads
/// the whole run; past these, nothing asks for it: a page follows only the runs the backend names live.
pub const KEPT_ENDED: usize = 8;

#[derive(Default)]
pub struct RunHistory {
    runs: Mutex<HashMap<u64, Vec<(u64, Value)>>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn str_of<'a>(event: &'a Value, key: &str) -> &'a str {
    event.get(key).and_then(Value::as_str).unwrap_or("")
}

impl RunHistory {
    /// Append one event to the run's history, stamped with the time it arrived. The answer is the event's
    /// position in the run, counted from 0: the number the relayed event carries.
    pub fn push(&self, run_id: u64, event: &Value) -> u64 {
        let mut runs = self.runs.lock().unwrap();
        let list = runs.entry(run_id).or_default();
        list.push((now_ms(), event.clone()));
        list.len() as u64 - 1
    }

    /// Every event of the run, from its start, in the order they were pushed, each with its position.
    pub fn replay(&self, run_id: u64) -> Vec<HistoryEntry> {
        let runs = self.runs.lock().unwrap();
        runs.get(&run_id)
            .map(|v| {
                v.iter()
                    .enumerate()
                    .map(|(seq, (_, e))| HistoryEntry {
                        seq: seq as u64,
                        event: e.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The run ended and its reader took its last replay. Its history is kept for the latest
    /// [`KEPT_ENDED`] ended runs, then dropped.
    pub fn finish(&self, _run_id: u64) {}

    /// The question or permission the run is waiting on, if its last request has no answer or decision.
    pub fn pending(&self, run_id: u64) -> Option<Pending> {
        let runs = self.runs.lock().unwrap();
        let mut open: Option<(String, Pending)> = None;
        for (at, event) in runs.get(&run_id)? {
            let id = str_of(event, "id");
            match str_of(event, "type") {
                "ask.requested" => {
                    let text = event
                        .get("questions")
                        .and_then(Value::as_array)
                        .and_then(|q| q.first())
                        .map_or("", |q| str_of(q, "question"))
                        .to_string();
                    open = Some((
                        id.to_string(),
                        Pending::Question {
                            text,
                            since_ms: *at,
                        },
                    ));
                }
                "permission.requested" => {
                    let action = format!(
                        "{}: {}",
                        str_of(event, "tool"),
                        str_of(event, "input_summary")
                    );
                    open = Some((
                        id.to_string(),
                        Pending::Permission {
                            action,
                            since_ms: *at,
                        },
                    ));
                }
                "ask.answered" | "permission.decided"
                    if open.as_ref().is_some_and(|(open_id, _)| open_id == id) =>
                {
                    open = None;
                }
                "run.completed" | "run.error" | "run.cancelled" => open = None,
                _ => {}
            }
        }
        open.map(|(_, p)| p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ask(id: &str, text: &str) -> Value {
        json!({"type": "ask.requested", "id": id, "questions": [{"kind": "text", "header": "h", "question": text}]})
    }
    fn answered(id: &str) -> Value {
        json!({"type": "ask.answered", "id": id, "answers": [["x"]]})
    }
    fn perm(id: &str, tool: &str, summary: &str) -> Value {
        json!({"type": "permission.requested", "id": id, "tool": tool, "input_summary": summary})
    }
    fn decided(id: &str) -> Value {
        json!({"type": "permission.decided", "id": id, "tool": "Bash", "input_summary": "s", "allow": true, "decided_by": "operator"})
    }

    #[test]
    fn replay_returns_every_event_from_the_start_in_order() {
        let h = RunHistory::default();
        let events = vec![
            json!({"type": "run.started"}),
            json!({"type": "assistant.text", "text": "a"}),
            json!({"type": "assistant.text", "text": "b"}),
        ];
        for e in &events {
            h.push(1, e);
        }
        let replayed: Vec<Value> = h.replay(1).into_iter().map(|e| e.event).collect();
        assert_eq!(replayed, events);
        assert!(h.replay(2).is_empty());
    }

    #[test]
    fn every_event_gets_its_position_in_its_own_run() {
        let h = RunHistory::default();
        let seqs: Vec<u64> = (0..3)
            .map(|n| h.push(1, &json!({"type": "turn", "n": n})))
            .collect();
        assert_eq!(seqs, vec![0, 1, 2]);
        assert_eq!(h.push(2, &json!({"type": "run.started"})), 0);
        assert_eq!(h.push(1, &json!({"type": "turn", "n": 3})), 3);
        let entries = h.replay(1);
        assert_eq!(
            entries.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
        assert_eq!(entries[2].event, json!({"type": "turn", "n": 2}));
    }

    #[test]
    fn pending_is_the_open_question_until_it_is_answered() {
        let h = RunHistory::default();
        assert_eq!(h.pending(1), None);
        h.push(1, &ask("q1", "Which branch?"));
        assert!(matches!(
            h.pending(1),
            Some(Pending::Question { text, .. }) if text == "Which branch?"
        ));
        h.push(1, &answered("q1"));
        assert_eq!(h.pending(1), None);
    }

    #[test]
    fn pending_is_the_open_permission_until_it_is_decided() {
        let h = RunHistory::default();
        h.push(1, &perm("p1", "Bash", "rm -rf build"));
        assert!(matches!(
            h.pending(1),
            Some(Pending::Permission { action, .. }) if action.contains("rm -rf build")
        ));
        h.push(1, &decided("p1"));
        assert_eq!(h.pending(1), None);
    }

    #[test]
    fn an_ended_run_is_dropped_once_newer_ended_runs_push_it_out() {
        let h = RunHistory::default();
        let total = KEPT_ENDED as u64 + 2;
        // Run 0 stays live throughout.
        h.push(0, &json!({"type": "run.started"}));
        for id in 1..=total {
            h.push(id, &json!({"type": "run.started"}));
            h.push(id, &json!({"type": "run.completed"}));
            h.finish(id);
        }
        // The two oldest ended runs are gone; the latest KEPT_ENDED still replay in full.
        assert!(h.replay(1).is_empty());
        assert!(h.replay(2).is_empty());
        for id in 3..=total {
            assert_eq!(h.replay(id).len(), 2, "run {id}");
        }
        // A live run is never dropped, however many runs end.
        assert_eq!(h.replay(0).len(), 1);
    }
}
