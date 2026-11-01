//! Every live run's events, kept by the backend so a session opened later shows the whole run.

// `pending`, `forget` and `Pending` are read by the running-changes list, a later task.
#![allow(dead_code)]

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
    /// Append one event to the run's history, stamped with the time it arrived.
    pub fn push(&self, run_id: u64, event: &Value) {
        todo!()
    }

    /// Every event of the run, from its start, in the order they were pushed.
    pub fn replay(&self, run_id: u64) -> Vec<Value> {
        todo!()
    }

    /// The question or permission the run is waiting on, if its last request has no answer or decision.
    pub fn pending(&self, run_id: u64) -> Option<Pending> {
        todo!()
    }

    /// Drop the run's history.
    pub fn forget(&self, run_id: u64) {
        todo!()
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
        assert_eq!(h.replay(1), events);
        assert!(h.replay(2).is_empty());
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
    fn forget_drops_only_that_run() {
        let h = RunHistory::default();
        h.push(1, &json!({"type": "run.started"}));
        h.push(2, &json!({"type": "run.started"}));
        h.forget(1);
        assert!(h.replay(1).is_empty());
        assert_eq!(h.replay(2).len(), 1);
    }
}
