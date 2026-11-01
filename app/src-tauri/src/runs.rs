//! The table of live runs behind the Workbench's `run_spec`. Pure and generic over
//! the child handle so tests can use a fake; the app uses `CommandChild`.

// The lane-aware commands construct the other lanes and kinds; the strip (T18) reads `live`.
#![allow(dead_code)]

use kata_sdlc::holds::{ChangeKey, RepoKey};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri_plugin_shell::process::CommandChild;

/// What a run belongs to, for the claim rule.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Lane {
    /// A run outside any workspace (the Workbench, the library).
    Solo,
    /// A run of a workspace that belongs to no change (setup, context).
    Workspace,
    /// A run of one change; `build` is true for a build run.
    #[serde(rename_all = "camelCase")]
    Change { key: ChangeKey, build: bool },
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunKind {
    Setup,
    Context,
    Intent,
    Spec,
    Plan,
    Triage,
    Fix,
    Build,
    Review,
    Solo,
}

/// One run the backend is tracking.
pub struct LiveRun<C = CommandChild> {
    pub id: u64,
    pub workdir: PathBuf,
    pub group: Option<String>,
    pub lane: Lane,
    pub kind: RunKind,
    /// The product repository of a build run.
    pub repo: Option<String>,
    pub child: Option<C>,
}

/// What the strip and the close guard show of a live run.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveSummary {
    pub id: u64,
    pub workdir: PathBuf,
    pub lane: Lane,
    pub kind: RunKind,
    pub repo: Option<String>,
}

/// Every live run, keyed by id.
pub struct RunTable<C = CommandChild> {
    runs: BTreeMap<u64, LiveRun<C>>,
}

impl<C> Default for RunTable<C> {
    fn default() -> Self {
        Self {
            runs: BTreeMap::new(),
        }
    }
}

impl<C> RunTable<C> {
    /// Decide whether a run in `workdir` on `lane` may start.
    pub fn claim(&self, workdir: &Path, lane: &Lane) -> Result<(), String> {
        let folder = RepoKey::of(workdir);
        if self
            .runs
            .values()
            .any(|r| RepoKey::of(&r.workdir) == folder)
        {
            return Err(format!(
                "Another run is already working in {}.",
                workdir.display()
            ));
        }
        if *lane == Lane::Solo && self.runs.values().any(|r| r.lane == Lane::Solo) {
            return Err("Another task is already running.".into());
        }
        Ok(())
    }

    /// Every live run with its lane, oldest id first.
    pub fn live(&self) -> Vec<LiveSummary> {
        self.runs
            .values()
            .map(|r| LiveSummary {
                id: r.id,
                workdir: r.workdir.clone(),
                lane: r.lane.clone(),
                kind: r.kind,
                repo: r.repo.clone(),
            })
            .collect()
    }

    pub fn insert(&mut self, run: LiveRun<C>) {
        self.runs.insert(run.id, run);
    }

    /// Remove only `id`, so a stale reader never clears a newer run.
    pub fn remove(&mut self, id: u64) -> Option<LiveRun<C>> {
        self.runs.remove(&id)
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut LiveRun<C>> {
        self.runs.get_mut(&id)
    }

    /// Whether any live run belongs to `group`.
    pub fn group_live(&self, group: &str) -> bool {
        self.runs
            .values()
            .any(|r| r.group.as_deref() == Some(group))
    }

    pub fn is_live(&self, id: u64) -> bool {
        self.runs.contains_key(&id)
    }
}

/// Put the run id around a kata event, leaving the event itself unchanged.
pub fn wrap(run_id: u64, event: Value) -> Value {
    serde_json::json!({ "runId": run_id, "event": event })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn change(name: &str, build: bool) -> Lane {
        Lane::Change {
            key: ChangeKey {
                workspace: RepoKey::of(Path::new("D:/ws")),
                system: "s".into(),
                change: name.into(),
            },
            build,
        }
    }

    fn live(id: u64, workdir: &str, lane: Lane) -> LiveRun<()> {
        let kind = match &lane {
            Lane::Solo => RunKind::Solo,
            Lane::Change { build: true, .. } => RunKind::Build,
            Lane::Change { .. } => RunKind::Spec,
            Lane::Workspace => RunKind::Context,
        };
        let group = match &lane {
            Lane::Change {
                key, build: true, ..
            } => Some(format!("build:{}/{}", key.system, key.change)),
            _ => None,
        };
        LiveRun {
            id,
            workdir: PathBuf::from(workdir),
            group,
            lane,
            kind,
            repo: None,
            child: None,
        }
    }

    fn table(runs: Vec<LiveRun<()>>) -> RunTable<()> {
        let mut t = RunTable::<()>::default();
        for r in runs {
            t.insert(r);
        }
        t
    }

    #[test]
    fn group_live_sees_only_runs_of_that_group() {
        let t = table(vec![live(1, r"D:wsapp", change("c", true))]);
        assert!(t.group_live("build:s/c"));
        assert!(!t.group_live("build:s/other"));
    }

    #[test]
    fn claim_refuses_a_second_run_in_the_same_folder() {
        let t = table(vec![live(1, r"D:\ws\app", change("c", true))]);
        let err = t
            .claim(Path::new("D:/ws/app/"), &change("c", true))
            .unwrap_err();
        assert_eq!(err, "Another run is already working in D:/ws/app/.");
    }

    #[test]
    fn claim_allows_two_build_runs_in_different_folders() {
        let t = table(vec![live(1, "D:/ws/app", change("c", true))]);
        assert!(t.claim(Path::new("D:/ws/api"), &change("c", true)).is_ok());
    }

    #[test]
    fn claim_refuses_anything_while_a_part_one_run_is_live() {
        // Row 4 allows a workspace or change request elsewhere, so only a solo request is
        // refused behind a solo run; the build-lane half of today's test no longer holds.
        let t = table(vec![live(1, "D:/ws/app", Lane::Solo)]);
        let msg = "Another task is already running.";
        assert_eq!(
            t.claim(Path::new("D:/ws/api"), &Lane::Solo).unwrap_err(),
            msg
        );
    }

    #[test]
    fn claim_allows_the_first_run() {
        let t = RunTable::<()>::default();
        assert!(t.claim(Path::new("D:/ws/app"), &Lane::Solo).is_ok());
    }

    #[test]
    fn claim_rows() {
        let same = |t: &RunTable<()>, lane: &Lane| t.claim(Path::new("D:/ws/app"), lane);
        let elsewhere = |t: &RunTable<()>, lane: &Lane| t.claim(Path::new("D:/ws/other"), lane);
        // Row 1: the same folder refuses every request.
        let t = table(vec![live(1, "D:/ws/app", Lane::Solo)]);
        for lane in [Lane::Solo, Lane::Workspace, change("c", false)] {
            assert_eq!(
                same(&t, &lane).unwrap_err(),
                "Another run is already working in D:/ws/app."
            );
        }
        // Row 2: solo behind another solo run elsewhere.
        assert_eq!(
            elsewhere(&t, &Lane::Solo).unwrap_err(),
            "Another task is already running."
        );
        // Row 3: solo with no solo run live, even while a change builds.
        let b = table(vec![live(1, "D:/ws/app", change("c", true))]);
        assert!(elsewhere(&b, &Lane::Solo).is_ok());
        // Row 4: workspace or change behind a solo run elsewhere.
        assert!(elsewhere(&t, &Lane::Workspace).is_ok());
        assert!(elsewhere(&t, &change("c", true)).is_ok());
    }

    #[test]
    fn two_changes_run_at_once() {
        let t = table(vec![live(1, "D:/c/a", change("a", true))]);
        assert!(t.claim(Path::new("D:/c/b"), &change("b", true)).is_ok());
    }

    #[test]
    fn two_changes_in_the_checkout_run_one_at_a_time() {
        let t = table(vec![live(1, "D:/ws/app", change("a", true))]);
        let err = t
            .claim(Path::new("D:/ws/app"), &change("b", true))
            .unwrap_err();
        assert_eq!(err, "Another run is already working in D:/ws/app.");
    }

    #[test]
    fn live_lists_every_run_with_its_lane() {
        let a = change("a", true);
        let mut run = live(1, "D:/c/a", a.clone());
        run.repo = Some("app".into());
        let t = table(vec![run, live(2, "D:/o", Lane::Solo)]);
        let got = t.live();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].id, 1);
        assert_eq!(got[0].lane, a);
        assert_eq!(got[0].kind, RunKind::Build);
        assert_eq!(got[0].repo.as_deref(), Some("app"));
        assert_eq!(got[1].lane, Lane::Solo);
        assert_eq!(got[1].repo, None);
    }

    #[test]
    fn remove_ignores_a_stale_id() {
        let mut t = table(vec![live(2, "D:/ws/app", Lane::Solo)]);
        assert!(t.remove(1).is_none());
        assert!(t.is_live(2));
        assert!(t.remove(2).is_some());
        assert!(!t.is_live(2));
    }

    #[test]
    fn wrap_puts_the_run_id_around_the_event_unchanged() {
        let event = json!({ "type": "turn", "n": 3 });
        let wrapped = wrap(7, event.clone());
        assert_eq!(wrapped, json!({ "runId": 7, "event": event }));
    }
}
