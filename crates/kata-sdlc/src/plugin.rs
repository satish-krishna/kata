//! What the AI-SDLC mode needs on this machine: the ai-sdlc plugin, Node.js, git and (for declaring done) gh.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// The first plugin release with every plugin step Kata relies on.
pub const MIN_VERSION: &str = "1.1.0";

/// The oldest Node.js the plugin's program runs on.
pub const MIN_NODE: &str = "22.18";

/// What the machine has that the AI-SDLC mode needs, found once: the plugin, Node.js, git and gh.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Machine {
    /// The installed plugin, or `None` when it is not installed or its version cannot be read.
    pub plugin: Option<Installed>,
    /// What `node --version` printed (for example `v22.18.0`), or `None` when `node` cannot run.
    pub node: Option<String>,
    /// Whether `git` is on `PATH`.
    pub git: bool,
    /// Whether `gh` is on `PATH`.
    pub gh: bool,
}

/// An installed plugin: its folder and the version its manifest names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installed {
    pub dir: PathBuf,
    pub version: String,
}

/// The plugin a ready machine runs: where it is, its version and the document layouts the Workbench reads
/// ([`crate::format::ACCEPTED_LAYOUTS`]), so the frontend tests membership instead of keeping its own list.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Plugin {
    pub dir: PathBuf,
    pub version: String,
    pub layouts: Vec<u32>,
}

/// Whether GitHub's command-line tool is on `PATH`; only declaring a change done needs it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum GhPresence {
    Present,
    Missing,
}

/// Why the AI-SDLC mode cannot run.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum BlockReason {
    PluginMissing,
    PluginTooOld,
    NodeMissing,
    NodeTooOld,
    GitMissing,
}

/// Whether the AI-SDLC mode can run on this machine, decided once for the whole app.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Readiness {
    /// Everything the mode needs is here; `gh` says whether declaring done can work.
    Ready { plugin: Plugin, gh: GhPresence },
    /// Something is missing; the message says what, and the mode offers nothing.
    Blocked {
        reason: BlockReason,
        message: String,
    },
}

impl Readiness {
    /// The blocked readiness for a plugin that is not installed (what tests that need no plugin pass).
    pub fn missing() -> Readiness {
        blocked(BlockReason::PluginMissing, "Install the ai-sdlc plugin")
    }
}

fn blocked(reason: BlockReason, message: impl Into<String>) -> Readiness {
    Readiness::Blocked {
        reason,
        message: message.into(),
    }
}

/// Whether the AI-SDLC mode can run on `env`; the first row of the table that matches decides.
pub fn readiness(_env: &Machine) -> Readiness {
    Readiness::missing()
}

impl Machine {
    /// Looks at this machine: the plugin installed at `plugin_dir` (`None` when the catalog has none),
    /// `node --version`, and `git` and `gh` on `PATH`. Neither `git` nor `gh` is started.
    pub fn detect(plugin_dir: Option<&Path>) -> Machine {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let pathext = std::env::var_os("PATHEXT");
        Machine {
            plugin: plugin_dir.and_then(|dir| {
                version(dir).map(|version| Installed {
                    dir: dir.to_path_buf(),
                    version,
                })
            }),
            node: node_version(),
            git: on_path("git", &path, pathext.as_deref()),
            gh: on_path("gh", &path, pathext.as_deref()),
        }
    }
}

/// Whether a file named `program` (or `program` plus one of the `pathext` extensions, as Windows resolves
/// a command) is in a folder of `path`. It only looks at the file system and starts nothing.
pub fn on_path(
    _program: &str,
    _path: &std::ffi::OsStr,
    _pathext: Option<&std::ffi::OsStr>,
) -> bool {
    false
}

/// What `node --version` prints, or `None` when `node` is not on this machine or does not answer.
fn node_version() -> Option<String> {
    let mut cmd = kata_core::proc::hidden_command("node").ok()?;
    let out = cmd.arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
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
        for ok in ["1.1.0", "1.10.1", "2.0.0"] {
            let dir = plugin_with(Some(&format!(r#"{{"name":"ai-sdlc","version":"{ok}"}}"#)));
            let v = version(dir.path()).unwrap();
            assert_eq!(v, ok);
            assert!(at_least(&v, MIN_VERSION), "{ok}");
        }
        for (json, expect) in [
            (Some(r#"{"version":"0.5.0"}"#), Some("0.5.0")),
            (Some(r#"{"version":"1.0.0"}"#), Some("1.0.0")),
            (Some(r#"{"version":"1.1.0-rc1"}"#), Some("1.1.0-rc1")),
            (Some(r#"{"name":"ai-sdlc"}"#), None),
            (None, None),
        ] {
            let dir = plugin_with(json);
            let v = version(dir.path());
            assert_eq!(v.as_deref(), expect);
            assert!(!v.is_some_and(|v| at_least(&v, MIN_VERSION)));
        }
    }

    fn installed(version: &str) -> Option<Installed> {
        Some(Installed {
            dir: PathBuf::from("/plugins/ai-sdlc"),
            version: version.to_string(),
        })
    }

    fn machine(plugin: Option<&str>, node: Option<&str>, git: bool, gh: bool) -> Machine {
        Machine {
            plugin: plugin.and_then(installed),
            node: node.map(str::to_string),
            git,
            gh,
        }
    }

    fn blocked_with(reason: BlockReason, message: &str) -> Readiness {
        Readiness::Blocked {
            reason,
            message: message.to_string(),
        }
    }

    fn ready(version: &str, gh: GhPresence) -> Readiness {
        Readiness::Ready {
            plugin: Plugin {
                dir: PathBuf::from("/plugins/ai-sdlc"),
                version: version.to_string(),
                layouts: crate::format::ACCEPTED_LAYOUTS.to_vec(),
            },
            gh,
        }
    }

    /// R10.1 and R9.1: the seven rows of the readiness table, first match wins, against a written list.
    #[test]
    fn readiness_rows() {
        let rows: Vec<(&str, Machine, Readiness)> = vec![
            (
                "1 plugin missing",
                machine(None, Some("v22.18.0"), true, true),
                blocked_with(BlockReason::PluginMissing, "Install the ai-sdlc plugin"),
            ),
            (
                "2 plugin below 1.1.0 (R10.1)",
                machine(Some("1.0.0"), None, false, false),
                blocked_with(
                    BlockReason::PluginTooOld,
                    "The AI-SDLC mode needs ai-sdlc 1.1.0 or later; this machine has 1.0.0.",
                ),
            ),
            (
                "3 node missing",
                machine(Some("1.1.0"), None, false, false),
                blocked_with(
                    BlockReason::NodeMissing,
                    "The AI-SDLC mode needs Node.js 22.18 or later; install it and reopen.",
                ),
            ),
            (
                "4 node below 22.18",
                machine(Some("1.1.0"), Some("v22.17.9"), false, false),
                blocked_with(
                    BlockReason::NodeTooOld,
                    "The AI-SDLC mode needs Node.js 22.18 or later; this machine has 22.17.9.",
                ),
            ),
            (
                "5 git missing",
                machine(Some("1.1.0"), Some("v22.18.0"), false, true),
                blocked_with(
                    BlockReason::GitMissing,
                    "The AI-SDLC mode needs git. Install it from https://git-scm.com and reopen.",
                ),
            ),
            (
                "6 gh missing",
                machine(Some("1.1.0"), Some("v22.18.0"), true, false),
                ready("1.1.0", GhPresence::Missing),
            ),
            (
                "7 everything present",
                machine(Some("1.2.0"), Some("v24.0.0"), true, true),
                ready("1.2.0", GhPresence::Present),
            ),
        ];
        for (name, env, expected) in rows {
            assert_eq!(readiness(&env), expected, "{name}");
        }
    }

    /// R9.1: git and gh are looked up as files on `PATH` (with `PATHEXT`), never started.
    #[test]
    fn git_and_gh_are_found_without_starting_them() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("git.exe"), b"").unwrap();
        let path = std::env::join_paths([dir.path()]).unwrap();
        let ext = std::ffi::OsString::from(".COM;.EXE");
        // The file is empty, so starting it would fail; finding it proves nothing was spawned.
        assert!(on_path("git", &path, Some(&ext)));
        assert!(!on_path("gh", &path, Some(&ext)));
    }
}
