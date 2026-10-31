//! The table of live runs behind the Workbench's `run_spec`. Pure and generic over
//! the child handle so tests can use a fake; the app uses `CommandChild`.

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri_plugin_shell::process::CommandChild;

/// One run the backend is tracking.
pub struct LiveRun<C = CommandChild> {
    pub id: u64,
    pub workdir: PathBuf,
    pub group: Option<String>,
    pub child: Option<C>,
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
    /// Decide whether a run in `workdir` (optionally part of `group`) may start.
    pub fn claim(&self, workdir: &Path, group: Option<&str>) -> Result<(), String> {
        let folder = normalize(workdir);
        if self.runs.values().any(|r| normalize(&r.workdir) == folder) {
            return Err(format!(
                "Another run is already working in {}.",
                workdir.display()
            ));
        }
        let is_build = |g: &Option<String>| g.as_deref().is_some_and(|g| g.starts_with("build:"));
        if self
            .runs
            .values()
            .any(|r| is_build(&r.group) && r.group.as_deref() != group)
        {
            return Err("A build is running. Everything else waits until it ends.".into());
        }
        if self.runs.values().any(|r| r.group.is_none()) {
            return Err("Another task is already running.".into());
        }
        Ok(())
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

/// A lexical key for a working folder: separators unified, `.` and repeated or
/// trailing separators dropped, and case folded on Windows. The folder may not
/// exist yet, so nothing here touches the filesystem.
fn normalize(path: &Path) -> String {
    let unified = path.to_string_lossy().replace('\\', "/");
    let parts: Vec<&str> = unified
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    let joined = parts.join("/");
    let key = if unified.starts_with('/') {
        format!("/{joined}")
    } else {
        joined
    };
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn live(id: u64, workdir: &str, group: Option<&str>) -> LiveRun<()> {
        LiveRun {
            id,
            workdir: PathBuf::from(workdir),
            group: group.map(str::to_string),
            child: None,
        }
    }

    #[test]
    fn group_live_sees_only_runs_of_that_group() {
        let mut t = RunTable::<()>::default();
        t.insert(live(1, r"D:wsapp", Some("build:s/c")));
        assert!(t.group_live("build:s/c"));
        assert!(!t.group_live("build:s/other"));
    }

    #[test]
    fn claim_refuses_a_second_run_in_the_same_folder() {
        let mut t = RunTable::<()>::default();
        t.insert(live(1, r"D:\ws\app", Some("build:s/c")));
        let err = t
            .claim(Path::new("D:/ws/app/"), Some("build:s/c"))
            .unwrap_err();
        assert_eq!(err, "Another run is already working in D:/ws/app/.");
    }

    #[test]
    fn claim_allows_two_build_runs_in_different_folders() {
        let mut t = RunTable::<()>::default();
        t.insert(live(1, "D:/ws/app", Some("build:s/c")));
        assert!(t.claim(Path::new("D:/ws/api"), Some("build:s/c")).is_ok());
    }

    #[test]
    fn claim_refuses_a_non_build_run_during_a_build() {
        let mut t = RunTable::<()>::default();
        t.insert(live(1, "D:/ws/app", Some("build:s/c")));
        let msg = "A build is running. Everything else waits until it ends.";
        assert_eq!(t.claim(Path::new("D:/ws/api"), None).unwrap_err(), msg);
        assert_eq!(
            t.claim(Path::new("D:/ws/api"), Some("build:s/other"))
                .unwrap_err(),
            msg
        );
    }

    #[test]
    fn claim_refuses_anything_while_a_part_one_run_is_live() {
        let mut t = RunTable::<()>::default();
        t.insert(live(1, "D:/ws/app", None));
        let msg = "Another task is already running.";
        assert_eq!(t.claim(Path::new("D:/ws/api"), None).unwrap_err(), msg);
        assert_eq!(
            t.claim(Path::new("D:/ws/api"), Some("build:s/c"))
                .unwrap_err(),
            msg
        );
    }

    #[test]
    fn claim_allows_the_first_run() {
        let t = RunTable::<()>::default();
        assert!(t.claim(Path::new("D:/ws/app"), None).is_ok());
    }

    #[test]
    fn remove_ignores_a_stale_id() {
        let mut t = RunTable::<()>::default();
        t.insert(live(2, "D:/ws/app", None));
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
