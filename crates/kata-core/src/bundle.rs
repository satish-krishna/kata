use crate::assemble::{resolve, AssembleError};
use crate::catalog::{CatalogEntry, EntryKind};
use crate::fsutil::copy_dir;
use crate::spec::RunSpec;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("resolving kit: {0}")]
    Resolve(#[from] AssembleError),
    #[error("output dir {0} exists and is not empty (use --force)")]
    Exists(String),
    #[error("writing spec: {0}")]
    Spec(#[from] crate::spec::SpecError),
    #[error("serializing manifest: {0}")]
    Manifest(#[from] toml::ser::Error),
}

/// `kata-bundle.toml`: the auto-detect marker and a provenance record.
/// Descriptive only — `run` discovers the actual kit from the `.claude`
/// tree, not from this file.
#[derive(Debug, Serialize, Deserialize)]
pub struct BundleManifest {
    pub tool_version: String,
    #[serde(default)]
    pub entry: Vec<ManifestEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub kind: String,   // "skill" | "plugin"
    pub name: String,
    pub source: String, // original scope: "user" | "project" | "plugin"
    pub path: String,   // original absolute path
}

/// Produce a self-contained bundle at `out`: vendor every resolved
/// skill/plugin into `<out>/.claude/{skills,plugins}/<name>/`, copy the
/// spec to `<out>/spec.toml`, and write `<out>/kata-bundle.toml`.
pub fn bundle(spec: &RunSpec, catalog: &[CatalogEntry], out: &Path, force: bool) -> Result<(), BundleError> {
    if out.exists() {
        let non_empty = std::fs::read_dir(out)?.next().is_some();
        if non_empty && !force {
            return Err(BundleError::Exists(out.display().to_string()));
        }
    }

    let resolved = resolve(spec, catalog)?;

    // Ensure the output dir exists before writing into it. `copy_dir`
    // would create it via the kit loop below, but a spec with no
    // skills/plugins skips that loop entirely.
    std::fs::create_dir_all(out)?;

    let claude_root = out.join(".claude");
    let mut entries = Vec::new();
    for r in &resolved {
        let sub = match r.kind {
            EntryKind::Skill => "skills",
            EntryKind::Plugin => "plugins",
        };
        copy_dir(&r.path, &claude_root.join(sub).join(&r.name))?;
        entries.push(ManifestEntry {
            kind: match r.kind { EntryKind::Skill => "skill", EntryKind::Plugin => "plugin" }.to_string(),
            name: r.name.clone(),
            source: r.source.clone(),
            path: r.path.display().to_string(),
        });
    }

    crate::spec::save(&out.join("spec.toml"), spec)?;

    let manifest = BundleManifest { tool_version: env!("CARGO_PKG_VERSION").to_string(), entry: entries };
    let text = toml::to_string(&manifest)?;
    std::fs::write(out.join("kata-bundle.toml"), text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::RunSpec;
    use std::fs;

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
    fn bundles_skill_and_writes_spec_and_manifest() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec { schema: 1, name: "demo".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.skills = vec!["triage".into()];

        let out_root = tempfile::tempdir().unwrap();
        let out = out_root.path().join("demo-bundle");
        bundle(&spec, std::slice::from_ref(&entry), &out, false).unwrap();

        assert!(out.join(".claude").join("skills").join("triage").join("SKILL.md").is_file());
        assert!(out.join("spec.toml").is_file());

        let manifest_text = fs::read_to_string(out.join("kata-bundle.toml")).unwrap();
        let manifest: BundleManifest = toml::from_str(&manifest_text).unwrap();
        assert_eq!(manifest.entry.len(), 1);
        assert_eq!(manifest.entry[0].kind, "skill");
        assert_eq!(manifest.entry[0].name, "triage");
        assert_eq!(manifest.entry[0].source, "user");
    }

    #[test]
    fn errors_on_nonempty_out_without_force() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec { schema: 1, name: "demo".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.skills = vec!["triage".into()];

        let out = tempfile::tempdir().unwrap();
        fs::write(out.path().join("preexisting.txt"), "keep me").unwrap();

        let err = bundle(&spec, std::slice::from_ref(&entry), out.path(), false).unwrap_err();
        assert!(matches!(err, BundleError::Exists(_)));
    }

    #[test]
    fn force_overwrites_nonempty_out() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec { schema: 1, name: "demo".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.skills = vec!["triage".into()];

        let out = tempfile::tempdir().unwrap();
        fs::write(out.path().join("preexisting.txt"), "keep me").unwrap();

        bundle(&spec, std::slice::from_ref(&entry), out.path(), true).unwrap();
        assert!(out.path().join(".claude").join("skills").join("triage").join("SKILL.md").is_file());
    }
}
