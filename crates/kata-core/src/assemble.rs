use crate::catalog::{CatalogEntry, EntryKind};
use crate::fsutil::copy_dir;
use crate::spec::{IdentityMode, RunSpec};
use tempfile::TempDir;

#[derive(Debug, thiserror::Error)]
pub enum AssembleError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("not found: {0}")]
    NotFound(String),
}

pub fn assemble(spec: &RunSpec, catalog: &[CatalogEntry]) -> Result<Assembled, AssembleError> {
    let temp = tempfile::tempdir()?;
    let root = temp.path();

    // System prompt file (append mode only; replace passes inline in command.rs).
    let mut system_prompt_file = None;
    if let Some(sp) = spec.identity.system_prompt.as_ref().filter(|s| !s.trim().is_empty()) {
        if spec.identity.mode == IdentityMode::Append {
            let f = root.join("system.txt");
            std::fs::write(&f, sp)?;
            system_prompt_file = Some(f.to_string_lossy().into_owned());
        }
    }

    // Disposable plugin-dir: skills/<name>/ and plugins/<name>/.
    let plugin_root = root.join("plugindir");
    let mut any = false;

    for name in &spec.skills {
        let entry = catalog.iter()
            .find(|e| e.kind == EntryKind::Skill && &e.name == name)
            .ok_or_else(|| AssembleError::NotFound(format!("skill '{name}'")))?;
        copy_dir(&entry.path, &plugin_root.join("skills").join(name))?;
        any = true;
    }
    for name in spec.plugins.keys() {
        let entry = catalog.iter()
            .find(|e| e.kind == EntryKind::Plugin && &e.name == name)
            .ok_or_else(|| AssembleError::NotFound(format!("plugin '{name}'")))?;
        copy_dir(&entry.path, &plugin_root.join("plugins").join(name))?;
        any = true;
    }

    let plugin_dir = if any {
        Some(plugin_root.to_string_lossy().into_owned())
    } else {
        None
    };

    Ok(Assembled { plugin_dir, system_prompt_file, _temp: Some(temp) })
}

/// The disposable kit assembled for one run.
///
/// IMPORTANT: `plugin_dir` and `system_prompt_file` are paths INTO an owned
/// temporary directory that is deleted when this value is dropped. They are
/// only valid for the lifetime of this `Assembled`. Do not copy these paths
/// out and use them after the value is dropped, or they will dangle.
#[derive(Debug)]
pub struct Assembled {
    /// Path to the assembled `--plugin-dir`, or `None` if no skills/plugins
    /// were selected. Valid only while this `Assembled` is alive.
    pub plugin_dir: Option<String>,
    /// Path to the written `system.txt` (append mode only), or `None`.
    /// Valid only while this `Assembled` is alive.
    pub system_prompt_file: Option<String>,
    #[allow(dead_code)]
    _temp: Option<TempDir>,
}

impl Assembled {
    /// Construct without a backing temp dir, for tests of pure consumers.
    pub fn for_test(plugin_dir: Option<String>, system_prompt_file: Option<String>) -> Self {
        Self { plugin_dir, system_prompt_file, _temp: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{CatalogEntry, EntryKind};
    use crate::spec::*;
    use std::fs;
    use std::path::PathBuf;

    fn skill_entry(name: &str) -> (CatalogEntry, tempfile::TempDir) {
        let td = tempfile::tempdir().unwrap();
        fs::write(td.path().join("SKILL.md"),
            format!("---\nname: {name}\ndescription: d\n---\nsteps\n")).unwrap();
        let entry = CatalogEntry {
            kind: EntryKind::Skill, name: name.into(), description: "d".into(),
            source: "user".into(), path: td.path().to_path_buf(),
            provides: vec![], mcp_servers: vec![],
        };
        (entry, td)
    }

    #[test]
    fn assembles_selected_skill_into_plugin_dir() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.skills = vec!["triage".into()];

        let a = assemble(&spec, std::slice::from_ref(&entry)).unwrap();
        let dir = PathBuf::from(a.plugin_dir.as_ref().unwrap());
        assert!(dir.join("skills").join("triage").join("SKILL.md").is_file());
        assert!(a.system_prompt_file.is_none());
    }

    #[test]
    fn writes_system_prompt_file_in_append_mode() {
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.identity.system_prompt = Some("you triage".into());
        spec.identity.mode = IdentityMode::Append;

        let a = assemble(&spec, &[]).unwrap();
        let f = a.system_prompt_file.as_ref().unwrap();
        assert_eq!(fs::read_to_string(f).unwrap(), "you triage");
        assert!(a.plugin_dir.is_none());
    }

    #[test]
    fn replace_mode_writes_no_file() {
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.identity.system_prompt = Some("x".into());
        spec.identity.mode = IdentityMode::Replace;
        let a = assemble(&spec, &[]).unwrap();
        assert!(a.system_prompt_file.is_none());
    }

    #[test]
    fn unknown_skill_is_an_error() {
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.skills = vec!["nope".into()];
        let err = assemble(&spec, &[]).unwrap_err();
        assert!(matches!(err, AssembleError::NotFound(_)));
    }

    #[test]
    fn cleanup_removes_temp_on_drop() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec { schema: 1, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.skills = vec!["triage".into()];
        let dir = {
            let a = assemble(&spec, std::slice::from_ref(&entry)).unwrap();
            PathBuf::from(a.plugin_dir.as_ref().unwrap())
        }; // a dropped here
        assert!(!dir.exists(), "temp plugin dir should be cleaned up on drop");
    }
}
