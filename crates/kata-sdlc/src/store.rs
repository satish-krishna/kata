use crate::prs::PrRecord;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("no home directory: set KATA_HOME, HOME, or USERPROFILE")]
    NoHome,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("no workspace with id {0}")]
    UnknownWorkspace(String),
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Mode {
    Workbench,
    Sdlc,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum SdlcPermissionMode {
    Bypass,
    Prompt,
    #[default]
    Auto,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Settings {
    pub mode: Option<Mode>,
    pub remember: bool,
    pub permission_mode: SdlcPermissionMode,
    /// Systems whose old per-machine checks file the engineer has been told about. Not on the wire to the screens.
    #[cfg_attr(feature = "ts", ts(skip))]
    pub old_checks_shown: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct WorkspaceEntry {
    pub id: String,
    pub name: String,
    pub folder: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub last_opened: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RunLink {
    pub workspace_id: String,
    pub system: String,
    pub change: String,
    pub stage: String,
    pub run_id: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub started_at: u64,
    /// The commit each repository's change branch pointed at when the run started.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub heads: Option<std::collections::BTreeMap<String, String>>,
}

/// Which run recorded a task: one entry per task of a finished run, appended and never rewritten.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct TaskLink {
    pub workspace_id: String,
    pub system: String,
    pub change: String,
    pub repo: String,
    pub task: String,
    pub run_id: String,
}

/// `<kata-home>/workbench`. Mirrors kata-core's home resolution: `KATA_HOME` if
/// set and non-empty (verbatim), else `<HOME or USERPROFILE>/.kata`.
pub fn workbench_dir() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("KATA_HOME") {
        if !h.is_empty() {
            return Some(PathBuf::from(h).join("workbench"));
        }
    }
    let base = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(base).join(".kata").join("workbench"))
}

fn read_or_default<T: serde::de::DeserializeOwned + Default>(file: &str) -> T {
    workbench_dir()
        .and_then(|d| std::fs::read_to_string(d.join(file)).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write<T: Serialize + ?Sized>(file: &str, value: &T) -> Result<(), StoreError> {
    let dir = workbench_dir().ok_or(StoreError::NoHome)?;
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(file), serde_json::to_string_pretty(value)?)?;
    Ok(())
}

pub fn load_settings() -> Settings {
    read_or_default("settings.json")
}

pub fn save_settings(s: &Settings) -> Result<(), StoreError> {
    write("settings.json", s)
}

pub fn load_workspaces() -> Vec<WorkspaceEntry> {
    read_or_default("workspaces.json")
}

/// The workspace the home opens on: the highest `last_opened`; on a tie, the earliest in the saved order.
pub fn current_workspace(list: &[WorkspaceEntry]) -> Option<&WorkspaceEntry> {
    // `max_by_key` keeps the last of equal maxima; a strict comparison keeps the first.
    list.iter()
        .fold(None, |best: Option<&WorkspaceEntry>, w| match best {
            Some(b) if b.last_opened >= w.last_opened => Some(b),
            _ => Some(w),
        })
}

pub fn save_workspaces(w: &[WorkspaceEntry]) -> Result<(), StoreError> {
    write("workspaces.json", w)
}

/// The saved workspace list and the workspace the home opens on, answered after a change to the list.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct WorkspaceChoice {
    pub workspaces: Vec<WorkspaceEntry>,
    pub current: Option<String>,
}

static WORKSPACES: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Load the saved list, change it and save it under one process-wide lock; answers the saved list.
/// Nothing is written before the save, so a failed save leaves the file as it was.
pub fn update_workspaces<F>(f: F) -> Result<Vec<WorkspaceEntry>, StoreError>
where
    F: FnOnce(&mut Vec<WorkspaceEntry>) -> Result<(), StoreError>,
{
    let _guard = WORKSPACES.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load_workspaces();
    f(&mut list)?;
    save_workspaces(&list)?;
    Ok(list)
}

/// The `last_opened` for the workspace just picked: `now`, or one past every other entry when one is
/// at or ahead of `now`, so the pick wins a same-second tie under `current_workspace`.
pub fn stamp(list: &[WorkspaceEntry], id: &str, now: u64) -> u64 {
    list.iter()
        .filter(|w| w.id != id)
        .map(|w| w.last_opened.saturating_add(1))
        .fold(now, u64::max)
}

fn choice(workspaces: Vec<WorkspaceEntry>) -> WorkspaceChoice {
    let current = current_workspace(&workspaces).map(|w| w.id.clone());
    WorkspaceChoice {
        workspaces,
        current,
    }
}

pub fn open_workspace(id: &str, now: u64) -> Result<WorkspaceChoice, StoreError> {
    update_workspaces(|list| {
        let at = stamp(list, id, now);
        let entry = list
            .iter_mut()
            .find(|w| w.id == id)
            .ok_or_else(|| StoreError::UnknownWorkspace(id.to_string()))?;
        entry.last_opened = at;
        Ok(())
    })
    .map(choice)
}

fn workspace_id(name: &str, list: &[WorkspaceEntry]) -> String {
    let mut slug = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "workspace" } else { slug };
    let mut id = slug.to_string();
    let mut n = 2;
    while list.iter().any(|w| w.id == id) {
        id = format!("{slug}-{n}");
        n += 1;
    }
    id
}

pub fn add_workspace(name: &str, folder: &str, now: u64) -> Result<WorkspaceChoice, StoreError> {
    update_workspaces(|list| {
        let id = workspace_id(name, list);
        let last_opened = stamp(list, &id, now);
        list.push(WorkspaceEntry {
            id,
            name: name.to_string(),
            folder: folder.to_string(),
            last_opened,
        });
        Ok(())
    })
    .map(choice)
}

pub fn remove_workspace(id: &str) -> Result<WorkspaceChoice, StoreError> {
    update_workspaces(|list| {
        list.retain(|w| w.id != id);
        Ok(())
    })
    .map(choice)
}

pub fn load_run_links() -> Vec<RunLink> {
    read_or_default("runs.json")
}

pub fn append_run_link(l: RunLink) -> Result<(), StoreError> {
    let mut links = load_run_links();
    links.push(l);
    write("runs.json", &links)
}

pub fn load_task_links() -> Vec<TaskLink> {
    read_or_default("task-runs.json")
}

/// Append all of `links` in one write.
pub fn append_task_links(links: &[TaskLink]) -> Result<(), StoreError> {
    let mut all = load_task_links();
    all.extend_from_slice(links);
    write("task-runs.json", &all)
}

/// Every saved pull request record, from `pull-requests.json`.
pub fn load_pr_records() -> Vec<PrRecord> {
    let mut records: Vec<PrRecord> = read_or_default("pull-requests.json");
    // A record saved before branches could be renamed names no branch: it used `change/<change>`.
    for record in &mut records {
        let default = format!("change/{}", record.change);
        for entry in record.repos.iter_mut().chain(record.left_behind.iter_mut()) {
            if entry.branch.is_empty() {
                entry.branch.clone_from(&default);
            }
        }
    }
    records
}

/// The engineer's arrangement of the build page, kept beside `settings.json`
/// and never inside a workspace. The backend never looks inside the value.
pub fn load_build_layout() -> serde_json::Value {
    match read_or_default::<Option<serde_json::Value>>("build-layout.json") {
        Some(v) if v.is_object() => v,
        _ => serde_json::Value::Object(Default::default()),
    }
}

pub fn save_build_layout(v: &serde_json::Value) -> Result<(), StoreError> {
    write("build-layout.json", v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn entry(id: &str, last_opened: u64) -> WorkspaceEntry {
        WorkspaceEntry {
            id: id.into(),
            name: id.into(),
            folder: format!("/{id}"),
            last_opened,
        }
    }

    #[test]
    fn current_workspace_of_an_empty_list_is_none() {
        assert!(current_workspace(&[]).is_none());
    }

    #[test]
    fn current_workspace_is_the_highest_last_opened() {
        let list = [entry("a", 5), entry("b", 50), entry("c", 7)];
        assert_eq!(current_workspace(&list).unwrap().id, "b");
    }

    #[test]
    fn current_workspace_on_a_tie_is_the_earliest_in_the_list() {
        let zeros = [entry("a", 0), entry("b", 0), entry("c", 0)];
        assert_eq!(current_workspace(&zeros).unwrap().id, "a");
        let top = [entry("a", 1), entry("b", 9), entry("c", 9), entry("d", 3)];
        assert_eq!(current_workspace(&top).unwrap().id, "b");
    }

    #[test]
    #[serial]
    fn stamp_rows() {
        let rows: Vec<(Vec<WorkspaceEntry>, &str, u64, u64)> = vec![
            (vec![entry("a", 0)], "a", 100, 100),
            (vec![entry("a", 0), entry("b", 50)], "a", 100, 100),
            (vec![entry("a", 0), entry("b", 100)], "a", 100, 101),
            (vec![entry("a", 0), entry("b", 105)], "a", 100, 106),
            (vec![entry("a", 200), entry("b", 100)], "a", 100, 101),
            (vec![entry("a", 200), entry("b", 50)], "a", 100, 100),
        ];
        for (list, id, now, expected) in rows {
            assert_eq!(stamp(&list, id, now), expected, "{list:?} {id} {now}");
        }
    }

    #[test]
    #[serial]
    fn open_workspace_wins_a_same_second_tie() {
        let _home = with_home();
        save_workspaces(&[entry("first", 1000), entry("second", 1000)]).unwrap();
        let choice = open_workspace("second", 1000).unwrap();
        assert_eq!(choice.current.as_deref(), Some("second"));
        let on_disk = load_workspaces();
        assert_eq!(on_disk, choice.workspaces);
        assert_eq!(
            on_disk
                .iter()
                .find(|w| w.id == "second")
                .unwrap()
                .last_opened,
            1001
        );
    }

    #[test]
    #[serial]
    fn open_workspace_of_an_unknown_id_saves_nothing() {
        let _home = with_home();
        save_workspaces(&[entry("a", 5)]).unwrap();
        let err = open_workspace("nope", 10).unwrap_err();
        assert!(matches!(err, StoreError::UnknownWorkspace(ref id) if id == "nope"));
        assert_eq!(load_workspaces(), vec![entry("a", 5)]);
    }

    #[test]
    #[serial]
    fn remove_workspace_answers_from_the_saved_list() {
        let _home = with_home();
        save_workspaces(&[entry("a", 5), entry("b", 50), entry("c", 7)]).unwrap();
        let choice = remove_workspace("b").unwrap();
        assert_eq!(choice.current.as_deref(), Some("c"));
        assert_eq!(choice.workspaces.len(), 2);
        assert_eq!(load_workspaces(), choice.workspaces);
        let unknown = remove_workspace("zzz").unwrap();
        assert_eq!(unknown.workspaces.len(), 2);
    }

    #[test]
    #[serial]
    fn a_failed_save_changes_nothing() {
        let home = with_home();
        save_workspaces(&[entry("a", 5), entry("b", 6)]).unwrap();
        let before = load_workspaces();
        let blocker = home.temp.path().join("not-a-folder");
        std::fs::write(&blocker, "x").unwrap();
        std::env::set_var("KATA_HOME", &blocker);
        assert!(open_workspace("a", 100).is_err());
        assert!(remove_workspace("a").is_err());
        std::env::set_var("KATA_HOME", home.temp.path());
        assert_eq!(load_workspaces(), before);
    }

    #[test]
    #[serial]
    fn add_workspace_makes_a_unique_id() {
        let _home = with_home();
        add_workspace("My Repo", "/one", 10).unwrap();
        let second = add_workspace("My Repo", "/two", 10).unwrap();
        let ids: Vec<&str> = second.workspaces.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["my-repo", "my-repo-2"]);
        assert_eq!(second.current.as_deref(), Some("my-repo-2"));
        let odd = add_workspace("!!!", "/three", 10).unwrap();
        assert_eq!(odd.workspaces.last().unwrap().id, "workspace");
    }

    struct HomeGuard {
        temp: tempfile::TempDir,
        prev: Option<std::ffi::OsString>,
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var("KATA_HOME", v),
                None => std::env::remove_var("KATA_HOME"),
            }
        }
    }

    fn with_home() -> HomeGuard {
        let temp = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("KATA_HOME");
        std::env::set_var("KATA_HOME", temp.path());
        HomeGuard { temp, prev }
    }

    fn link(run_id: &str) -> RunLink {
        RunLink {
            workspace_id: "w1".into(),
            system: "billing".into(),
            change: "0001-x".into(),
            stage: "spec".into(),
            run_id: run_id.into(),
            started_at: 1,
            heads: None,
        }
    }

    #[test]
    #[serial]
    fn settings_round_trip() {
        let home = with_home();
        let s = Settings {
            mode: Some(Mode::Sdlc),
            remember: true,
            permission_mode: SdlcPermissionMode::Prompt,
            ..Settings::default()
        };
        save_settings(&s).unwrap();
        assert_eq!(load_settings(), s);
        assert!(home
            .temp
            .path()
            .join("workbench")
            .join("settings.json")
            .is_file());
    }

    #[test]
    #[serial]
    fn settings_default_to_auto() {
        let home = with_home();
        assert_eq!(load_settings().permission_mode, SdlcPermissionMode::Auto);

        let dir = home.temp.path().join("workbench");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"mode":"sdlc","remember":true}"#,
        )
        .unwrap();
        let s = load_settings();
        assert_eq!(s.mode, Some(Mode::Sdlc));
        assert!(s.remember);
        assert_eq!(s.permission_mode, SdlcPermissionMode::Auto);
    }

    #[test]
    #[serial]
    fn build_layout_round_trips() {
        let _home = with_home();
        let v = serde_json::json!({"version": 1, "modes": {"wide": {"order": ["a", "b"]}}});
        save_build_layout(&v).unwrap();
        assert_eq!(load_build_layout(), v);
    }

    #[test]
    #[serial]
    fn build_layout_file_is_in_the_workbench_folder_and_alone() {
        let home = with_home();
        save_build_layout(&serde_json::json!({"a": 1})).unwrap();
        let dir = home.temp.path().join("workbench");
        assert!(dir.join("build-layout.json").is_file());
        let names: Vec<_> = std::fs::read_dir(home.temp.path())
            .unwrap()
            .chain(std::fs::read_dir(&dir).unwrap())
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2, "unexpected files: {names:?}");
    }

    #[test]
    #[serial]
    fn build_layout_reads_empty_object_when_missing_or_unusable() {
        let home = with_home();
        let empty = serde_json::json!({});
        assert_eq!(load_build_layout(), empty);
        let dir = home.temp.path().join("workbench");
        std::fs::create_dir_all(&dir).unwrap();
        for text in ["not json", "[1]"] {
            std::fs::write(dir.join("build-layout.json"), text).unwrap();
            assert_eq!(load_build_layout(), empty, "for {text}");
        }
    }

    #[test]
    #[serial]
    fn missing_files_load_defaults() {
        let _home = with_home();
        assert_eq!(load_settings(), Settings::default());
        assert!(load_workspaces().is_empty());
        assert!(load_run_links().is_empty());
    }

    #[test]
    #[serial]
    fn corrupt_settings_load_defaults() {
        let home = with_home();
        let dir = home.temp.path().join("workbench");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), "not json").unwrap();
        assert_eq!(load_settings(), Settings::default());
    }

    #[test]
    fn missing_fields_load_the_rest() {
        let s: Settings = serde_json::from_str(r#"{"remember":true}"#).unwrap();
        assert_eq!(
            s,
            Settings {
                remember: true,
                ..Settings::default()
            }
        );
        let w: Vec<WorkspaceEntry> =
            serde_json::from_str(r#"[{"id":"w1","name":"Acme","folder":"D:/acme"}]"#).unwrap();
        assert_eq!(w[0].id, "w1");
        assert_eq!(w[0].folder, "D:/acme");
        assert_eq!(w[0].last_opened, 0);
    }

    #[test]
    fn a_workspace_file_with_a_stored_base_branch_still_loads() {
        let w: Vec<WorkspaceEntry> = serde_json::from_str(
            r#"[{"id":"w1","name":"Acme","folder":"D:/acme","base_branch":"develop","last_opened":7}]"#,
        )
        .unwrap();
        assert_eq!(w[0].folder, "D:/acme");
        assert_eq!(w[0].last_opened, 7);
        let again = serde_json::to_string(&w).unwrap();
        assert!(!again.contains("base_branch"), "{again}");
    }

    #[test]
    fn run_links_without_heads_still_load() {
        let old = r#"[{"workspace_id":"w1","system":"billing","change":"0001-x","stage":"spec","run_id":"a","started_at":1}]"#;
        let links: Vec<RunLink> = serde_json::from_str(old).unwrap();
        assert_eq!(links[0].heads, None);
        assert_eq!(links[0], link("a"));
    }

    #[test]
    #[serial]
    fn run_link_heads_round_trip() {
        let _home = with_home();
        let mut l = link("a");
        l.heads = Some(
            [("api".to_string(), "abc123".to_string())]
                .into_iter()
                .collect(),
        );
        append_run_link(l.clone()).unwrap();
        assert_eq!(load_run_links(), vec![l]);
    }

    #[test]
    #[serial]
    fn run_links_append() {
        let _home = with_home();
        append_run_link(link("a")).unwrap();
        append_run_link(link("b")).unwrap();
        assert_eq!(load_run_links(), vec![link("a"), link("b")]);
    }

    #[test]
    #[serial]
    fn old_records_load_with_the_change_branch() {
        let home = with_home();
        let dir = home.temp.path().join("workbench");
        std::fs::create_dir_all(&dir).unwrap();
        let old = r#"[{"workspaceId":"w1","system":"billing","change":"0001-x","declaredAt":5,"repos":[{"repo":"api","url":"https://github.com/o/api/pull/3","number":3,"pushedHead":"abc","state":"open","seenAt":9}]}]"#;
        std::fs::write(dir.join("pull-requests.json"), old).unwrap();
        let loaded = load_pr_records();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].repos[0].branch, "change/0001-x");
        assert!(loaded[0].left_behind.is_empty());
    }

    fn task_link(task: &str, run_id: &str) -> TaskLink {
        TaskLink {
            workspace_id: "w1".into(),
            system: "billing".into(),
            change: "0001-x".into(),
            repo: "api".into(),
            task: task.into(),
            run_id: run_id.into(),
        }
    }

    #[test]
    #[serial]
    fn task_links_append_and_load_in_order() {
        let home = with_home();
        assert!(load_task_links().is_empty());
        append_task_links(&[task_link("T1", "a"), task_link("T2", "a")]).unwrap();
        append_task_links(&[task_link("T3", "b"), task_link("T4", "b")]).unwrap();
        assert_eq!(
            load_task_links(),
            vec![
                task_link("T1", "a"),
                task_link("T2", "a"),
                task_link("T3", "b"),
                task_link("T4", "b")
            ]
        );
        std::fs::write(
            home.temp.path().join("workbench").join("task-runs.json"),
            "not json",
        )
        .unwrap();
        assert!(load_task_links().is_empty());
    }
}
