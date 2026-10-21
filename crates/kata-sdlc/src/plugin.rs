//! The ai-sdlc plugin on this machine: its version, and whether it can build one repository at a time.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The oldest plugin version that builds one repository per run.
pub const MIN_VERSION: &str = "0.6.0";

/// Whether the ai-sdlc plugin can be used: where it is and which version, decided once for the whole app.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Readiness {
    /// Installed and at least [`MIN_VERSION`].
    Ready { dir: PathBuf, version: String },
    /// Not installed, or its version cannot be read.
    Missing,
    /// Installed but older than [`MIN_VERSION`].
    TooOld { have: String, need: String },
}

/// Whether the plugin installed at `plugin_dir` (`None` when the catalog has no such plugin) is new enough.
pub fn readiness(plugin_dir: Option<&Path>) -> Readiness {
    let _ = plugin_dir;
    Readiness::Missing
}

/// The `version` field of `<plugin_dir>/.claude-plugin/plugin.json`.
pub fn version(plugin_dir: &Path) -> Option<String> {
    let text =
        std::fs::read_to_string(plugin_dir.join(".claude-plugin").join("plugin.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

fn numbers(version: &str) -> Option<Vec<u64>> {
    version
        .trim()
        .split('.')
        .map(|part| part.parse().ok())
        .collect()
}

/// Whether `version` is at least `min`, comparing dotted numbers. A pre-release or an unparsable
/// version is never enough.
pub fn at_least(version: &str, min: &str) -> bool {
    let (Some(mut have), Some(mut need)) = (numbers(version), numbers(min)) else {
        return false;
    };
    let len = have.len().max(need.len());
    have.resize(len, 0);
    need.resize(len, 0);
    have >= need
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin_with(json: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        if let Some(json) = json {
            let meta = dir.path().join(".claude-plugin");
            std::fs::create_dir_all(&meta).unwrap();
            std::fs::write(meta.join("plugin.json"), json).unwrap();
        }
        dir
    }

    #[test]
    fn plugin_version_reads_plugin_json_r2_5() {
        for ok in ["0.6.0", "0.10.1", "1.0.0"] {
            let dir = plugin_with(Some(&format!(r#"{{"name":"ai-sdlc","version":"{ok}"}}"#)));
            let v = version(dir.path()).unwrap();
            assert_eq!(v, ok);
            assert!(at_least(&v, MIN_VERSION), "{ok}");
        }
        for (json, expect) in [
            (Some(r#"{"version":"0.5.0"}"#), Some("0.5.0")),
            (Some(r#"{"version":"0.6.0-rc1"}"#), Some("0.6.0-rc1")),
            (Some(r#"{"name":"ai-sdlc"}"#), None),
            (None, None),
        ] {
            let dir = plugin_with(json);
            let v = version(dir.path());
            assert_eq!(v.as_deref(), expect);
            assert!(!v.is_some_and(|v| at_least(&v, MIN_VERSION)));
        }
    }

    #[test]
    fn readiness_reports_ready_missing_and_too_old() {
        let current = plugin_with(Some(r#"{"name":"ai-sdlc","version":"0.8.0"}"#));
        assert_eq!(
            readiness(Some(current.path())),
            Readiness::Ready {
                dir: current.path().to_path_buf(),
                version: "0.8.0".to_string()
            }
        );
        let old = plugin_with(Some(r#"{"name":"ai-sdlc","version":"0.7.9"}"#));
        assert_eq!(
            readiness(Some(old.path())),
            Readiness::TooOld {
                have: "0.7.9".to_string(),
                need: MIN_VERSION.to_string()
            }
        );
        let unreadable = plugin_with(None);
        assert_eq!(readiness(Some(unreadable.path())), Readiness::Missing);
        assert_eq!(readiness(None), Readiness::Missing);
        assert_eq!(MIN_VERSION, "0.8.0");
    }
}
