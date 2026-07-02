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

/// One skill/plugin selected by a spec, resolved against the catalog.
/// Shared by `assemble` (copies into a throwaway temp kit) and
/// `bundle` (copies into a durable `.claude` tree + records provenance).
#[derive(Debug, Clone)]
pub struct ResolvedEntry {
    pub kind: EntryKind,
    pub name: String,
    pub source: String,
    pub path: std::path::PathBuf,
}

/// Map each skill/plugin name in `spec` to its catalog entry, in order
/// (skills first, then plugins). Errors `NotFound` on the first miss.
pub fn resolve(
    spec: &RunSpec,
    catalog: &[CatalogEntry],
) -> Result<Vec<ResolvedEntry>, AssembleError> {
    let mut out = Vec::new();
    for name in &spec.skills {
        let e = catalog
            .iter()
            .find(|e| e.kind == EntryKind::Skill && &e.name == name)
            .ok_or_else(|| AssembleError::NotFound(format!("skill '{name}'")))?;
        out.push(ResolvedEntry {
            kind: e.kind,
            name: e.name.clone(),
            source: e.source.clone(),
            path: e.path.clone(),
        });
    }
    for name in spec.plugins.keys() {
        let e = catalog
            .iter()
            .find(|e| e.kind == EntryKind::Plugin && &e.name == name)
            .ok_or_else(|| AssembleError::NotFound(format!("plugin '{name}'")))?;
        out.push(ResolvedEntry {
            kind: e.kind,
            name: e.name.clone(),
            source: e.source.clone(),
            path: e.path.clone(),
        });
    }
    Ok(out)
}

pub fn assemble(spec: &RunSpec, catalog: &[CatalogEntry]) -> Result<Assembled, AssembleError> {
    let temp = tempfile::tempdir()?;
    let root = temp.path();

    // System prompt file (append mode only; replace passes inline in command.rs).
    let mut system_prompt_file = None;
    if let Some(sp) = spec
        .identity
        .system_prompt
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        if spec.identity.mode == IdentityMode::Append {
            let f = root.join("system.txt");
            std::fs::write(&f, sp)?;
            system_prompt_file = Some(f.to_string_lossy().into_owned());
        }
    }

    // Disposable plugin-dir: skills/<name>/ and plugins/<name>/.
    let plugin_root = root.join("plugindir");
    let resolved = resolve(spec, catalog)?;
    let any = !resolved.is_empty();
    for r in &resolved {
        let sub = match r.kind {
            EntryKind::Skill => "skills",
            EntryKind::Plugin => "plugins",
        };
        copy_dir(&r.path, &plugin_root.join(sub).join(&r.name))?;
    }

    let plugin_dir = if any {
        Some(plugin_root.to_string_lossy().into_owned())
    } else {
        None
    };

    Ok(Assembled {
        plugin_dir,
        system_prompt_file,
        _temp: Some(temp),
    })
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
    #[cfg(test)]
    pub fn for_test(plugin_dir: Option<String>, system_prompt_file: Option<String>) -> Self {
        Self {
            plugin_dir,
            system_prompt_file,
            _temp: None,
        }
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
        fs::write(
            td.path().join("SKILL.md"),
            format!("---\nname: {name}\ndescription: d\n---\nsteps\n"),
        )
        .unwrap();
        let entry = CatalogEntry {
            kind: EntryKind::Skill,
            name: name.into(),
            description: "d".into(),
            source: "user".into(),
            path: td.path().to_path_buf(),
            provides: vec![],
            mcp_servers: vec![],
        };
        (entry, td)
    }

    #[test]
    fn assembles_selected_skill_into_plugin_dir() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.skills = vec!["triage".into()];

        let a = assemble(&spec, std::slice::from_ref(&entry)).unwrap();
        let dir = PathBuf::from(a.plugin_dir.as_ref().unwrap());
        assert!(dir.join("skills").join("triage").join("SKILL.md").is_file());
        assert!(a.system_prompt_file.is_none());
    }

    #[test]
    fn writes_system_prompt_file_in_append_mode() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.identity.system_prompt = Some("you triage".into());
        spec.identity.mode = IdentityMode::Append;

        let a = assemble(&spec, &[]).unwrap();
        let f = a.system_prompt_file.as_ref().unwrap();
        assert_eq!(fs::read_to_string(f).unwrap(), "you triage");
        assert!(a.plugin_dir.is_none());
    }

    #[test]
    fn replace_mode_writes_no_file() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.identity.system_prompt = Some("x".into());
        spec.identity.mode = IdentityMode::Replace;
        let a = assemble(&spec, &[]).unwrap();
        assert!(a.system_prompt_file.is_none());
    }

    #[test]
    fn unknown_skill_is_an_error() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.skills = vec!["nope".into()];
        let err = assemble(&spec, &[]).unwrap_err();
        assert!(matches!(err, AssembleError::NotFound(_)));
    }

    #[test]
    fn cleanup_removes_temp_on_drop() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.skills = vec!["triage".into()];
        let dir = {
            let a = assemble(&spec, std::slice::from_ref(&entry)).unwrap();
            PathBuf::from(a.plugin_dir.as_ref().unwrap())
        }; // a dropped here
        assert!(
            !dir.exists(),
            "temp plugin dir should be cleaned up on drop"
        );
    }

    #[test]
    fn resolve_returns_selected_entries_with_metadata() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.skills = vec!["triage".into()];

        let resolved = resolve(&spec, std::slice::from_ref(&entry)).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].kind, EntryKind::Skill);
        assert_eq!(resolved[0].name, "triage");
        assert_eq!(resolved[0].source, "user");
        assert_eq!(resolved[0].path, entry.path);
    }

    #[test]
    fn resolve_missing_name_is_notfound() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.skills = vec!["nope".into()];
        let err = resolve(&spec, &[]).unwrap_err();
        assert!(matches!(err, AssembleError::NotFound(_)));
    }
}
