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
    #[default]
    Bypass,
    Prompt,
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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct WorkspaceEntry {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub base_branch: String,
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

pub fn save_workspaces(w: &[WorkspaceEntry]) -> Result<(), StoreError> {
    write("workspaces.json", w)
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
    read_or_default("pull-requests.json")
}

/// Save `record`, replacing the entry of the same workspace, system and change.
pub fn save_pr_record(record: &PrRecord) -> Result<(), StoreError> {
    let mut all = load_pr_records();
    let same = |r: &PrRecord| {
        r.workspace_id == record.workspace_id
            && r.system == record.system
            && r.change == record.change
    };
    match all.iter_mut().find(|r| same(r)) {
        Some(old) => *old = record.clone(),
        None => all.push(record.clone()),
    }
    let dir = workbench_dir().ok_or(StoreError::NoHome)?;
    std::fs::create_dir_all(&dir)?;
    let temp = dir.join("pull-requests.json.tmp");
    std::fs::write(&temp, serde_json::to_string_pretty(&all)?)?;
    std::fs::rename(&temp, dir.join("pull-requests.json"))?;
    Ok(())
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
        assert_eq!(w[0].base_branch, "");
        assert_eq!(w[0].last_opened, 0);
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

    fn pr_record(change: &str, declared_at: Option<u64>) -> PrRecord {
        let mut r = PrRecord::new("w1", "billing", change);
        r.declared_at = declared_at;
        r
    }

    #[test]
    #[serial]
    fn pr_records_replace_the_same_change_and_keep_the_rest() {
        let home = with_home();
        assert!(load_pr_records().is_empty());
        save_pr_record(&pr_record("a", None)).unwrap();
        save_pr_record(&pr_record("b", None)).unwrap();
        save_pr_record(&pr_record("a", Some(5))).unwrap();
        assert_eq!(
            load_pr_records(),
            vec![pr_record("a", Some(5)), pr_record("b", None)]
        );
        let dir = home.temp.path().join("workbench");
        assert!(!dir.join("pull-requests.json.tmp").exists());
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
