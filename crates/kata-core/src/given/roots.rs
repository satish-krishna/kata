//! The folders the resolver reads, injectable so tests never touch the real machine.

use crate::spec::RunSpec;
use std::path::PathBuf;

/// Where the resolver looks for what a run would start with.
#[derive(Debug, Clone)]
pub struct ResolveRoots {
    pub home: PathBuf,
    pub workdir: PathBuf,
    pub managed_settings: PathBuf,
    pub claude_json: PathBuf,
}

impl ResolveRoots {
    /// Home follows `catalog::dirs_home`; the workdir is the spec's, never the
    /// process's current folder.
    pub fn for_spec(spec: &RunSpec) -> ResolveRoots {
        let home = crate::catalog::dirs_home();
        let workdir = if spec.workdir.is_empty() {
            PathBuf::from(".")
        } else {
            PathBuf::from(&spec.workdir)
        };
        ResolveRoots {
            claude_json: home.join(".claude.json"),
            managed_settings: managed_settings_path(),
            home,
            workdir,
        }
    }
}

fn managed_settings_path() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\Program Files\ClaudeCode\managed-settings.json")
    } else if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json")
    } else {
        PathBuf::from("/etc/claude-code/managed-settings.json")
    }
}
