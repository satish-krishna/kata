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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Settings {
    pub mode: Option<Mode>,
    pub remember: bool,
    pub permission_mode: SdlcPermissionMode,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct WorkspaceEntry {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub base_branch: String,
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
    pub started_at: u64,
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
    #[serial]
    fn run_links_append() {
        let _home = with_home();
        append_run_link(link("a")).unwrap();
        append_run_link(link("b")).unwrap();
        assert_eq!(load_run_links(), vec![link("a"), link("b")]);
    }
}
