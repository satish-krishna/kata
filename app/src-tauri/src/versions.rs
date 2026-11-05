//! The version line the Workbench shows and the text it copies for a bug report.

use serde::Serialize;

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
pub fn versions(_package: &str, _debug: bool, ai_sdlc: AiSdlc) -> Versions {
    Versions {
        workbench: String::new(),
        ai_sdlc,
        line: String::new(),
        copy: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
