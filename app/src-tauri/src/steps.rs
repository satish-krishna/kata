//! The long steps of a change that are not a run: one entry per change, its latest progress label and the
//! token that stops it.

use crate::build_host::ChangeRef;
use kata_core::proc::CancelToken;
use kata_sdlc::accept::ChangeDocument;
use kata_sdlc::ai_sdlc::StepProgress;
use kata_sdlc::holds::ChangeKey;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The channel a step's progress goes out on.
pub const STEP_EVENT: &str = "sdlc://step";

/// What a long step of a change is.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum StepKind {
    PreparingBuild,
    PreparingReview,
    Starting,
    Renaming,
    RemovingCopy,
    Accepting(ChangeDocument),
    Rejecting(ChangeDocument),
    RejectingFix,
    DeclaringDone,
}

impl StepKind {
    /// The close question's words for what the change is doing.
    pub fn doing(&self) -> String {
        let doc = |d: &ChangeDocument| match d {
            ChangeDocument::Intent => "intent",
            ChangeDocument::Spec => "spec",
            ChangeDocument::Plan => "plan",
        };
        match self {
            StepKind::PreparingBuild => "preparing".into(),
            StepKind::PreparingReview => "preparing the review".into(),
            StepKind::Starting => "starting".into(),
            StepKind::Renaming => "being renamed".into(),
            StepKind::RemovingCopy => "having its copy removed".into(),
            StepKind::Accepting(d) => format!("accepting its {}", doc(d)),
            StepKind::Rejecting(d) => format!("rejecting its {}", doc(d)),
            StepKind::RejectingFix => "rejecting its fix".into(),
            StepKind::DeclaringDone => "being declared done".into(),
        }
    }
}

/// One progress report of a step, as it goes to the page.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct StepEvent {
    pub change: ChangeKey,
    pub kind: StepKind,
    pub progress: StepProgress,
}

/// A step that is running, for the close question and for a page opened late.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RunningStep {
    pub change: ChangeKey,
    pub kind: StepKind,
    pub doing: String,
    pub progress: Option<StepProgress>,
}

/// The change already has a long step running.
#[derive(Debug, PartialEq, Eq)]
pub struct Busy;

struct Entry {
    kind: StepKind,
    token: CancelToken,
    progress: Option<StepProgress>,
}

type Emitter = Arc<dyn Fn(StepEvent) + Send + Sync>;

/// Every long step that is running, one per change. A clone shares the table with the original.
#[derive(Clone)]
pub struct StepTable {
    entries: Arc<Mutex<HashMap<ChangeKey, Entry>>>,
    emit: Emitter,
}

/// Holds a change's entry; dropping it removes the entry.
pub struct StepGuard {
    entries: Arc<Mutex<HashMap<ChangeKey, Entry>>>,
    key: ChangeKey,
    token: CancelToken,
}

impl std::fmt::Debug for StepGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StepGuard").field("key", &self.key).finish()
    }
}

impl StepGuard {
    /// The token to pass to the program call, so a stop ends it.
    pub fn token(&self) -> &CancelToken {
        &self.token
    }
}

impl Drop for StepGuard {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(&self.key);
        }
    }
}

impl StepTable {
    pub fn new(emit: Emitter) -> Self {
        Self {
            entries: Arc::default(),
            emit,
        }
    }

    /// Register a step of `change`, or `Busy` when it already has one.
    pub fn begin(&self, change: ChangeKey, kind: StepKind) -> Result<StepGuard, Busy> {
        let mut entries = self.entries.lock().unwrap();
        if entries.contains_key(&change) {
            return Err(Busy);
        }
        let token = CancelToken::new();
        entries.insert(
            change.clone(),
            Entry {
                kind,
                token: token.clone(),
                progress: None,
            },
        );
        Ok(StepGuard {
            entries: self.entries.clone(),
            key: change,
            token,
        })
    }

    /// Record the latest progress of the change's step and send it to the page.
    pub fn label(&self, change: &ChangeKey, progress: StepProgress) {
        let kind = {
            let mut entries = self.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(change) else {
                return;
            };
            entry.progress = Some(progress.clone());
            entry.kind
        };
        (self.emit)(StepEvent {
            change: change.clone(),
            kind,
            progress,
        });
    }

    /// Cancel the change's step; whether there was one.
    pub fn stop(&self, change: &ChangeKey) -> bool {
        match self.entries.lock().unwrap().get(change) {
            Some(entry) => {
                entry.token.cancel();
                true
            }
            None => false,
        }
    }

    /// Every step that is running, in change order, so the close question lists them the same way each time.
    pub fn running(&self) -> Vec<RunningStep> {
        let mut steps: Vec<RunningStep> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|(change, entry)| RunningStep {
                change: change.clone(),
                kind: entry.kind,
                doing: entry.kind.doing(),
                progress: entry.progress.clone(),
            })
            .collect();
        steps.sort_by(|a, b| order_key(&a.change).cmp(&order_key(&b.change)));
        steps
    }
}

/// The order of a change's entries: its system, its change name, then its workspace path.
fn order_key(change: &ChangeKey) -> (&str, &str, &str) {
    (&change.system, &change.change, change.workspace.path())
}

/// Stop the long step of a change; whether there was one.
#[tauri::command]
pub fn sdlc_stop_step(steps: tauri::State<'_, StepTable>, change: ChangeRef) -> bool {
    steps.stop(&crate::build_host::key_of(&change))
}

/// Every long step that is running.
#[tauri::command]
pub fn sdlc_steps(steps: tauri::State<'_, StepTable>) -> Vec<RunningStep> {
    steps.running()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kata_sdlc::ai_sdlc::StepProgressKind;
    use kata_sdlc::holds::RepoKey;
    use std::path::Path;

    fn key(change: &str) -> ChangeKey {
        ChangeKey {
            workspace: RepoKey::of(Path::new("ws")),
            system: "kata".into(),
            change: change.into(),
        }
    }

    fn table() -> StepTable {
        StepTable::new(Arc::new(|_| {}))
    }

    #[test]
    fn stop_cancels_the_running_step_of_that_change() {
        let t = table();
        let a = t.begin(key("a"), StepKind::Starting).unwrap();
        let b = t.begin(key("b"), StepKind::DeclaringDone).unwrap();
        assert!(t.stop(&key("a")));
        assert!(a.token().is_cancelled());
        assert!(!b.token().is_cancelled());
        assert!(!t.stop(&key("c")));
    }

    #[test]
    fn the_guard_removes_its_entry() {
        let t = table();
        let g = t.begin(key("a"), StepKind::Renaming).unwrap();
        assert_eq!(t.running().len(), 1);
        drop(g);
        assert!(t.running().is_empty());
        assert!(!t.stop(&key("a")));
        assert!(t.begin(key("a"), StepKind::Renaming).is_ok());
    }

    #[test]
    fn a_second_step_of_one_change_is_busy() {
        let t = table();
        let _g = t.begin(key("a"), StepKind::Starting).unwrap();
        assert_eq!(
            t.begin(key("a"), StepKind::DeclaringDone).unwrap_err(),
            Busy
        );
        assert!(t.begin(key("b"), StepKind::DeclaringDone).is_ok());
    }

    #[test]
    fn label_records_and_emits_the_latest_progress() {
        let seen: Arc<Mutex<Vec<StepEvent>>> = Arc::default();
        let sink = seen.clone();
        let t = StepTable::new(Arc::new(move |e| sink.lock().unwrap().push(e)));
        let _g = t.begin(key("a"), StepKind::DeclaringDone).unwrap();
        let progress = StepProgress {
            kind: StepProgressKind::Push,
            label: "Pushing kata".into(),
            repo: Some("kata".into()),
            check: None,
        };
        t.label(&key("a"), progress.clone());
        let events = seen.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].progress, progress);
        assert_eq!(events[0].kind, StepKind::DeclaringDone);
        let running = t.running();
        assert_eq!(running[0].progress.as_ref(), Some(&progress));
    }

    // The close question lists the step lines in one order from one close to the next: the change key.
    #[test]
    fn running_lists_the_steps_in_change_order() {
        let t = table();
        let guards: Vec<_> = ["h", "c", "f", "a", "g", "b", "e", "d"]
            .iter()
            .map(|n| t.begin(key(n), StepKind::Starting).unwrap())
            .collect();
        let order: Vec<ChangeKey> = t.running().into_iter().map(|s| s.change).collect();
        let sorted: Vec<ChangeKey> = ["a", "b", "c", "d", "e", "f", "g", "h"]
            .iter()
            .map(|n| key(n))
            .collect();
        assert_eq!(order, sorted);
        drop(guards);
    }

    #[test]
    fn doing_names_each_kind() {
        let rows: Vec<(StepKind, &str)> = vec![
            (StepKind::PreparingBuild, "preparing"),
            (StepKind::PreparingReview, "preparing the review"),
            (StepKind::Starting, "starting"),
            (StepKind::Renaming, "being renamed"),
            (StepKind::RemovingCopy, "having its copy removed"),
            (
                StepKind::Accepting(ChangeDocument::Intent),
                "accepting its intent",
            ),
            (
                StepKind::Accepting(ChangeDocument::Spec),
                "accepting its spec",
            ),
            (
                StepKind::Accepting(ChangeDocument::Plan),
                "accepting its plan",
            ),
            (
                StepKind::Rejecting(ChangeDocument::Intent),
                "rejecting its intent",
            ),
            (
                StepKind::Rejecting(ChangeDocument::Spec),
                "rejecting its spec",
            ),
            (
                StepKind::Rejecting(ChangeDocument::Plan),
                "rejecting its plan",
            ),
            (StepKind::DeclaringDone, "being declared done"),
        ];
        for (kind, words) in rows {
            assert_eq!(kind.doing(), words, "{kind:?}");
        }
    }
}
