//! The version line the Workbench shows and the text it copies for a bug report.

use serde::Serialize;
use std::path::Path;

/// What the Workbench knows about the ai-sdlc plugin's version.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum AiSdlc {
    /// The plugin is installed and its version was read.
    Found { version: String },
    /// The plugin is not installed.
    NotFound,
    /// The plugin is installed but its version could not be read.
    Unknown,
}

/// The versions and their two texts.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Versions {
    pub workbench: String,
    pub ai_sdlc: AiSdlc,
    /// The line shown on screen.
    pub line: String,
    /// The plain text copied for a bug report.
    pub copy: String,
}

/// Build the versions and their texts. `package` is the declared version, `debug` marks a development build.
pub fn versions(package: &str, debug: bool, ai_sdlc: AiSdlc) -> Versions {
    let workbench = if debug {
        format!("{package} (dev)")
    } else {
        package.to_string()
    };
    let plugin = match &ai_sdlc {
        AiSdlc::Found { version } => format!("ai-sdlc {version}"),
        AiSdlc::NotFound => "ai-sdlc: not found".to_string(),
        AiSdlc::Unknown => "ai-sdlc: version unknown".to_string(),
    };
    Versions {
        line: format!("Workbench {workbench} \u{b7} {plugin}"),
        copy: format!("Kata Workbench {workbench}, {plugin}"),
        workbench,
        ai_sdlc,
    }
}

/// The ai-sdlc plugin the catalog finds for `folder` (the engineer's own scope alone when none), and the
/// version it declares. It reads files only and starts no process.
pub fn find_ai_sdlc(_folder: Option<&Path>) -> AiSdlc {
    todo!("read the installed plugin")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Points HOME at `home` while alive and restores it; holds the lock every HOME-changing test shares.
    struct Home {
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Home {
        fn at(home: &Path) -> Home {
            let guard = crate::tests::ENV_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let saved: Vec<_> = ["HOME", "USERPROFILE"]
                .iter()
                .map(|k| (*k, std::env::var_os(k)))
                .collect();
            for (k, _) in &saved {
                std::env::set_var(k, home);
            }
            Home {
                saved,
                _guard: guard,
            }
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            for (k, v) in self.saved.drain(..) {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    /// An ai-sdlc plugin folder under `claude_dir`, providing `skill:build`, with `manifest` as its plugin.json.
    fn install(claude_dir: &Path, manifest: &str) {
        let plugin = claude_dir.join("plugins").join("ai-sdlc");
        let skill = plugin.join("skills").join("build");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: build\n---\n").unwrap();
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::write(plugin.join(".claude-plugin").join("plugin.json"), manifest).unwrap();
    }

    fn found(version: &str) -> AiSdlc {
        AiSdlc::Found {
            version: version.into(),
        }
    }

    #[test]
    fn finds_the_installed_version_not_the_minimum() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("ws");
        install(&workspace.join(".claude"), r#"{"version":"1.3.0"}"#);
        let _home = Home::at(&root.path().join("home"));
        assert_eq!(find_ai_sdlc(Some(&workspace)), found("1.3.0"));
    }

    #[test]
    fn outside_a_workspace_reads_the_engineers_own_scope() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        install(&home.join(".claude"), r#"{"version":"1.3.0"}"#);
        let _home = Home::at(&home);
        assert_eq!(find_ai_sdlc(None), found("1.3.0"));
    }

    #[test]
    fn a_plugin_without_a_readable_plugin_json_is_unknown() {
        for manifest in ["not json at all", r#"{"name":"ai-sdlc"}"#] {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            install(&home.join(".claude"), manifest);
            let _home = Home::at(&home);
            assert_eq!(find_ai_sdlc(None), AiSdlc::Unknown, "{manifest}");
        }
    }

    #[test]
    fn no_plugin_is_not_found() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let _home = Home::at(&home);
        assert_eq!(find_ai_sdlc(None), AiSdlc::NotFound);
    }

    #[test]
    fn reading_the_versions_starts_no_program() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        install(&home.join(".claude"), r#"{"version":"1.3.0"}"#);
        let _home = Home::at(&home);
        let log = kata_core::proc::SpawnLog::open();
        let result = find_ai_sdlc(None);
        assert_eq!(result, found("1.3.0"));
        assert!(log.programs().is_empty(), "{:?}", log.programs());
    }

    #[test]
    fn the_line_and_copy_text_for_every_build_and_plugin_state() {
        let found = || AiSdlc::Found {
            version: "1.3.0".into(),
        };
        let rows: Vec<(&str, bool, AiSdlc, &str, &str, &str)> = vec![
            (
                "3.3.0",
                false,
                found(),
                "3.3.0",
                "Workbench 3.3.0 · ai-sdlc 1.3.0",
                "Kata Workbench 3.3.0, ai-sdlc 1.3.0",
            ),
            (
                "3.3.0",
                false,
                AiSdlc::NotFound,
                "3.3.0",
                "Workbench 3.3.0 · ai-sdlc: not found",
                "Kata Workbench 3.3.0, ai-sdlc: not found",
            ),
            (
                "3.3.0",
                false,
                AiSdlc::Unknown,
                "3.3.0",
                "Workbench 3.3.0 · ai-sdlc: version unknown",
                "Kata Workbench 3.3.0, ai-sdlc: version unknown",
            ),
            (
                "3.4.0-beta.1",
                false,
                found(),
                "3.4.0-beta.1",
                "Workbench 3.4.0-beta.1 · ai-sdlc 1.3.0",
                "Kata Workbench 3.4.0-beta.1, ai-sdlc 1.3.0",
            ),
            (
                "3.4.0-beta.1",
                false,
                AiSdlc::NotFound,
                "3.4.0-beta.1",
                "Workbench 3.4.0-beta.1 · ai-sdlc: not found",
                "Kata Workbench 3.4.0-beta.1, ai-sdlc: not found",
            ),
            (
                "3.4.0-beta.1",
                false,
                AiSdlc::Unknown,
                "3.4.0-beta.1",
                "Workbench 3.4.0-beta.1 · ai-sdlc: version unknown",
                "Kata Workbench 3.4.0-beta.1, ai-sdlc: version unknown",
            ),
            (
                "3.3.0",
                true,
                found(),
                "3.3.0 (dev)",
                "Workbench 3.3.0 (dev) · ai-sdlc 1.3.0",
                "Kata Workbench 3.3.0 (dev), ai-sdlc 1.3.0",
            ),
            (
                "3.3.0",
                true,
                AiSdlc::NotFound,
                "3.3.0 (dev)",
                "Workbench 3.3.0 (dev) · ai-sdlc: not found",
                "Kata Workbench 3.3.0 (dev), ai-sdlc: not found",
            ),
            (
                "3.3.0",
                true,
                AiSdlc::Unknown,
                "3.3.0 (dev)",
                "Workbench 3.3.0 (dev) · ai-sdlc: version unknown",
                "Kata Workbench 3.3.0 (dev), ai-sdlc: version unknown",
            ),
        ];
        for (package, debug, ai, workbench, line, copy) in rows {
            let got = versions(package, debug, ai.clone());
            assert_eq!(got.workbench, workbench, "{package} {debug} {ai:?}");
            assert_eq!(got.line, line, "{package} {debug} {ai:?}");
            assert_eq!(got.copy, copy, "{package} {debug} {ai:?}");
            assert_eq!(got.ai_sdlc, ai);
        }
    }
}
