//! The long steps of a change that are not a run: one entry per change, its latest progress label and the
//! token that stops it.

use crate::build_host::ChangeRef;
use kata_core::proc::CancelToken;
use kata_sdlc::accept::ChangeDocument;
use kata_sdlc::ai_sdlc::{StepProgress, StepProgressKind};
use kata_sdlc::holds::ChangeKey;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The channel a step's progress goes out on.
pub const STEP_EVENT: &str = "sdlc://step";

/// The channel a step's end goes out on, carrying the change's key, so a page that did not start the step
/// learns it is over.
pub const STEP_END_EVENT: &str = "sdlc://step-end";

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

impl StepKind {
    /// The step's own words, the start of every progress line it shows: what the step is doing, or, for a
    /// preparation of one repository, that repository.
    pub fn words(&self, repo: Option<&str>) -> String {
        let doc = |d: &ChangeDocument| match d {
            ChangeDocument::Intent => "intent",
            ChangeDocument::Spec => "spec",
            ChangeDocument::Plan => "plan",
        };
        match (self, repo) {
            (StepKind::PreparingBuild | StepKind::PreparingReview, Some(repo)) => {
                format!("Preparing {repo}")
            }
            (StepKind::PreparingBuild, None) => "Checking every repository before building".into(),
            (StepKind::PreparingReview, None) => {
                "Checking every repository before the review".into()
            }
            (StepKind::Starting, _) => "Starting the change".into(),
            (StepKind::Renaming, _) => "Renaming the change".into(),
            (StepKind::RemovingCopy, _) => "Removing the change's copy".into(),
            (StepKind::Accepting(d), _) => format!("Accepting the {}", doc(d)),
            (StepKind::Rejecting(d), _) => format!("Rejecting the {}", doc(d)),
            (StepKind::RejectingFix, _) => "Rejecting the fix".into(),
            (StepKind::DeclaringDone, _) => "Declaring the change done".into(),
        }
    }
}

/// The one owner of a progress line's text: `kind`'s words, then the latest line the plugin streamed for it,
/// when there is one ("Accepting the spec: running docs-lint", "Preparing kata: base-tests passed"), else the
/// words alone. `repo` is the repository the call is for, when it is for one. No caller words a step, lowercases
/// or prefixes a line itself; `progress_of` only reads the line.
pub fn progress_line(
    kind: StepKind,
    repo: Option<&str>,
    line: Option<&StepProgress>,
) -> StepProgress {
    let words = kind.words(repo);
    let Some(line) = line else {
        return StepProgress {
            kind: if repo.is_some() {
                StepProgressKind::Repository
            } else {
                StepProgressKind::Verifying
            },
            label: words,
            repo: repo.map(str::to_string),
            check: None,
        };
    };
    // A line that opens with a check's id keeps it as the check spelled it; the others open with a verb.
    let said = match &line.check {
        Some(check) if line.label.starts_with(check.as_str()) => line.label.clone(),
        _ => {
            let mut chars = line.label.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_lowercase(), chars.as_str()),
                None => String::new(),
            }
        }
    };
    StepProgress {
        kind: line.kind,
        label: if said.is_empty() {
            words
        } else {
            format!("{words}: {said}")
        },
        repo: repo.map(str::to_string).or_else(|| line.repo.clone()),
        check: line.check.clone(),
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

/// Tells that the step of a change is over.
pub type EndEmitter = Arc<dyn Fn(ChangeKey) + Send + Sync>;

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

    /// Also tell `end` with the change's key each time a step is over.
    pub fn with_end(self, _end: EndEmitter) -> Self {
        self
    }

    /// Register a step of `change`, or `Busy` when it already has one.
    pub fn begin(&self, change: ChangeKey, kind: StepKind) -> Result<StepGuard, Busy> {
        let first = progress_line(kind, None, None);
        let token = CancelToken::new();
        {
            let mut entries = self.entries.lock().unwrap();
            if entries.contains_key(&change) {
                return Err(Busy);
            }
            entries.insert(
                change.clone(),
                Entry {
                    kind,
                    token: token.clone(),
                    progress: Some(first.clone()),
                },
            );
        }
        // Every step says what it is as it begins: the real plugin streams nothing for some of them.
        (self.emit)(StepEvent {
            change: change.clone(),
            kind,
            progress: first,
        });
        Ok(StepGuard {
            entries: self.entries.clone(),
            key: change,
            token,
        })
    }

    /// Record and send the progress of the change's step: the step's words, then the plugin's latest line when
    /// there is one, worded by [`progress_line`]. `repo` is the repository the call is for.
    pub fn report(&self, change: &ChangeKey, repo: Option<&str>, line: Option<StepProgress>) {
        let (kind, progress) = {
            let mut entries = self.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(change) else {
                return;
            };
            let progress = progress_line(entry.kind, repo, line.as_ref());
            entry.progress = Some(progress.clone());
            (entry.kind, progress)
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
    use kata_sdlc::ai_sdlc::progress_of;
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

    fn capturing() -> (StepTable, Arc<Mutex<Vec<StepEvent>>>) {
        let seen: Arc<Mutex<Vec<StepEvent>>> = Arc::default();
        let sink = seen.clone();
        (
            StepTable::new(Arc::new(move |e| sink.lock().unwrap().push(e))),
            seen,
        )
    }

    fn line(json: &str) -> Option<StepProgress> {
        Some(progress_of(json).expect("a progress line"))
    }

    // The one owner of the progress line's text: the step, and the check or action the plugin reports.
    #[test]
    fn the_progress_line_is_the_step_and_the_line_it_names() {
        let start = r#"{"type":"hook-start","id":"base-tests"}"#;
        let end = r#"{"type":"hook-end","id":"base-tests","outcome":"passed"}"#;
        let failed = r#"{"type":"hook-end","id":"docs-lint","outcome":"failed"}"#;
        let push = r#"{"type":"push","repo":"kata"}"#;
        let spec = StepKind::Accepting(ChangeDocument::Spec);
        let rows: Vec<(StepKind, Option<&str>, Option<StepProgress>, &str)> = vec![
            (spec, None, None, "Accepting the spec"),
            (
                spec,
                None,
                line(start),
                "Accepting the spec: running base-tests",
            ),
            (
                spec,
                None,
                line(end),
                "Accepting the spec: base-tests passed",
            ),
            (
                StepKind::Accepting(ChangeDocument::Plan),
                None,
                line(failed),
                "Accepting the plan: docs-lint failed",
            ),
            (
                StepKind::PreparingBuild,
                None,
                None,
                "Checking every repository before building",
            ),
            (
                StepKind::PreparingReview,
                None,
                None,
                "Checking every repository before the review",
            ),
            (
                StepKind::PreparingBuild,
                None,
                line(start),
                "Checking every repository before building: running base-tests",
            ),
            (
                StepKind::PreparingBuild,
                Some("kata"),
                None,
                "Preparing kata",
            ),
            (
                StepKind::PreparingReview,
                Some("kata"),
                line(start),
                "Preparing kata: running base-tests",
            ),
            (
                StepKind::PreparingBuild,
                Some("kata"),
                line(end),
                "Preparing kata: base-tests passed",
            ),
            (StepKind::Starting, None, None, "Starting the change"),
            (StepKind::Renaming, None, None, "Renaming the change"),
            (
                StepKind::RemovingCopy,
                None,
                None,
                "Removing the change's copy",
            ),
            (
                StepKind::Rejecting(ChangeDocument::Intent),
                None,
                None,
                "Rejecting the intent",
            ),
            (StepKind::RejectingFix, None, None, "Rejecting the fix"),
            (
                StepKind::DeclaringDone,
                None,
                None,
                "Declaring the change done",
            ),
            (
                StepKind::DeclaringDone,
                None,
                line(push),
                "Declaring the change done: pushing kata",
            ),
        ];
        for (kind, repo, line, label) in rows {
            let made = progress_line(kind, repo, line.as_ref());
            assert_eq!(made.label, label, "{kind:?} {repo:?} {line:?}");
        }
    }

    // What the line is about rides along: its kind, the check it names and the repository of the call.
    #[test]
    fn the_progress_line_keeps_what_the_line_is_about() {
        let start = progress_of(r#"{"type":"hook-start","id":"base-tests"}"#);
        let made = progress_line(StepKind::PreparingBuild, Some("kata"), start.as_ref());
        assert_eq!(made.kind, StepProgressKind::Hook);
        assert_eq!(made.check.as_deref(), Some("base-tests"));
        assert_eq!(made.repo.as_deref(), Some("kata"));
        let alone = progress_line(StepKind::PreparingBuild, Some("kata"), None);
        assert_eq!(alone.kind, StepProgressKind::Repository);
        assert_eq!(alone.repo.as_deref(), Some("kata"));
        let first = progress_line(StepKind::Accepting(ChangeDocument::Spec), None, None);
        assert_eq!(first.kind, StepProgressKind::Verifying);
        assert_eq!((first.repo, first.check), (None, None));
    }

    // Every long step says what it is the moment it begins, so a page sees it with no stream line to wait for.
    #[test]
    fn a_step_sends_its_first_label_when_it_begins() {
        let (t, seen) = capturing();
        let _g = t.begin(key("a"), StepKind::Starting).unwrap();
        {
            let events = seen.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].change, key("a"));
            assert_eq!(events[0].kind, StepKind::Starting);
            assert_eq!(events[0].progress.label, "Starting the change");
        }
        let running = t.running();
        assert_eq!(
            running[0].progress.as_ref().map(|p| p.label.as_str()),
            Some("Starting the change")
        );
    }

    #[test]
    fn a_report_is_the_step_and_the_line_and_is_what_a_late_page_reads() {
        let (t, seen) = capturing();
        let _g = t
            .begin(key("a"), StepKind::Accepting(ChangeDocument::Spec))
            .unwrap();
        t.report(
            &key("a"),
            None,
            line(r#"{"type":"hook-start","id":"docs-lint"}"#),
        );
        let events = seen.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[1].progress.label,
            "Accepting the spec: running docs-lint"
        );
        assert_eq!(events[1].progress.check.as_deref(), Some("docs-lint"));
        let running = t.running();
        assert_eq!(running[0].progress.as_ref(), Some(&events[1].progress));
    }

    // A report for a change with no step is dropped.
    #[test]
    fn a_report_for_no_step_is_dropped() {
        let (t, seen) = capturing();
        t.report(&key("a"), None, None);
        assert!(seen.lock().unwrap().is_empty());
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
    fn a_step_that_is_over_is_told_with_its_change() {
        let ended: Arc<Mutex<Vec<ChangeKey>>> = Arc::default();
        let sink = ended.clone();
        let t = table().with_end(Arc::new(move |k| sink.lock().unwrap().push(k)));
        let guard = t.begin(key("a"), StepKind::Starting).unwrap();
        let _other = t.begin(key("b"), StepKind::Renaming).unwrap();
        assert!(ended.lock().unwrap().is_empty());
        drop(guard);
        assert_eq!(*ended.lock().unwrap(), vec![key("a")]);
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
            label: "Declaring the change done: pushing kata".into(),
            repo: Some("kata".into()),
            check: None,
        };
        let pushing = StepProgress {
            kind: StepProgressKind::Push,
            label: "Pushing kata".into(),
            repo: Some("kata".into()),
            check: None,
        };
        t.report(&key("a"), None, Some(pushing));
        let events = seen.lock().unwrap();
        // The first event is the step beginning; the second is the line, worded by the one owner.
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].progress, progress);
        assert_eq!(events[1].kind, StepKind::DeclaringDone);
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
