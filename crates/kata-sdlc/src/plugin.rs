//! The ai-sdlc plugin on this machine: its version, and whether it can build one repository at a time.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The oldest plugin version whose format program knows every field Kata's build logs carry, `notes` among them.
pub const MIN_VERSION: &str = "0.9.0";

/// The first plugin version that can decide the track of a change itself (the light track).
pub const LIGHT_TRACK_VERSION: &str = "0.13.0";

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
    /// Installed and at least [`MIN_VERSION`]. `layouts` are the document layouts the Workbench reads
    /// ([`crate::format::ACCEPTED_LAYOUTS`]), so the frontend tests membership instead of keeping its own list.
    Ready {
        dir: PathBuf,
        version: String,
        layouts: Vec<u32>,
        /// Whether the plugin is at least [`LIGHT_TRACK_VERSION`].
        light_track: bool,
    },
    /// Not installed, or its version cannot be read.
    Missing,
    /// Installed but older than [`MIN_VERSION`].
    TooOld { have: String, need: String },
}

/// Whether the plugin installed at `plugin_dir` (`None` when the catalog has no such plugin) is new enough.
pub fn readiness(plugin_dir: Option<&Path>) -> Readiness {
    let Some(dir) = plugin_dir else {
        return Readiness::Missing;
    };
    match version(dir) {
        None => Readiness::Missing,
        Some(have) if at_least(&have, MIN_VERSION) => Readiness::Ready {
            dir: dir.to_path_buf(),
            version: have,
            layouts: crate::format::ACCEPTED_LAYOUTS.to_vec(),
            light_track: false,
        },
        Some(have) => Readiness::TooOld {
            have,
            need: MIN_VERSION.to_string(),
        },
    }
}

/// Whether `version` is at least [`LIGHT_TRACK_VERSION`].
pub fn light_track(_version: &str) -> bool {
    false
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
        for ok in ["0.9.0", "0.10.1", "1.0.0"] {
            let dir = plugin_with(Some(&format!(r#"{{"name":"ai-sdlc","version":"{ok}"}}"#)));
            let v = version(dir.path()).unwrap();
            assert_eq!(v, ok);
            assert!(at_least(&v, MIN_VERSION), "{ok}");
        }
        for (json, expect) in [
            (Some(r#"{"version":"0.5.0"}"#), Some("0.5.0")),
            (Some(r#"{"version":"0.8.0"}"#), Some("0.8.0")),
            (Some(r#"{"version":"0.9.0-rc1"}"#), Some("0.9.0-rc1")),
            (Some(r#"{"name":"ai-sdlc"}"#), None),
            (None, None),
        ] {
            let dir = plugin_with(json);
            let v = version(dir.path());
            assert_eq!(v.as_deref(), expect);
            assert!(!v.is_some_and(|v| at_least(&v, MIN_VERSION)));
        }
    }

    /// F15: the layouts the Workbench accepts travel with a ready plugin, so the frontend tests membership.
    #[test]
    fn a_ready_plugin_carries_the_accepted_layouts_f15() {
        let current = plugin_with(Some(r#"{"name":"ai-sdlc","version":"0.9.0"}"#));
        let json = serde_json::to_value(readiness(Some(current.path()))).unwrap();
        assert_eq!(
            json["layouts"],
            serde_json::json!(crate::format::ACCEPTED_LAYOUTS)
        );
    }

    #[test]
    fn readiness_reports_ready_missing_and_too_old() {
        let current = plugin_with(Some(r#"{"name":"ai-sdlc","version":"0.9.0"}"#));
        assert_eq!(
            readiness(Some(current.path())),
            Readiness::Ready {
                dir: current.path().to_path_buf(),
                version: "0.9.0".to_string(),
                layouts: crate::format::ACCEPTED_LAYOUTS.to_vec(),
                light_track: false
            }
        );
        let old = plugin_with(Some(r#"{"name":"ai-sdlc","version":"0.8.0"}"#));
        assert_eq!(
            readiness(Some(old.path())),
            Readiness::TooOld {
                have: "0.8.0".to_string(),
                need: MIN_VERSION.to_string()
            }
        );
        let unreadable = plugin_with(None);
        assert_eq!(readiness(Some(unreadable.path())), Readiness::Missing);
        assert_eq!(readiness(None), Readiness::Missing);
        assert_eq!(MIN_VERSION, "0.9.0");
    }

    #[test]
    fn light_track_needs_0_13_0() {
        for no in ["0.12.0", "0.12.9", "0.13.0-rc1"] {
            assert!(!light_track(no), "{no}");
        }
        for yes in ["0.13.0", "0.13.1", "1.0.0"] {
            assert!(light_track(yes), "{yes}");
        }
    }

    #[test]
    fn readiness_carries_light_track() {
        for (v, expect) in [("0.12.0", false), ("0.13.0", true)] {
            let dir = plugin_with(Some(&format!(r#"{{"name":"ai-sdlc","version":"{v}"}}"#)));
            let r = readiness(Some(dir.path()));
            assert!(matches!(r, Readiness::Ready { .. }), "{v}");
            assert_eq!(
                serde_json::to_value(r).unwrap()["lightTrack"],
                expect,
                "{v}"
            );
        }
    }
}
