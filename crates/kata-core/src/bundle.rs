use crate::assemble::{resolve, AssembleError};
use crate::catalog::{CatalogEntry, DiscoveryRoots, EntryKind};
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
    pub kind: String, // "skill" | "plugin"
    pub name: String,
    pub source: String, // original scope: "user" | "project"
    pub path: String,   // original absolute path
}

/// Produce a self-contained bundle at `out`: vendor every resolved
/// skill/plugin into `<out>/.claude/{skills,plugins}/<name>/`, copy the
/// spec to `<out>/spec.toml`, and write `<out>/kata-bundle.toml`.
pub fn bundle(
    spec: &RunSpec,
    catalog: &[CatalogEntry],
    out: &Path,
    force: bool,
) -> Result<(), BundleError> {
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

    // Start from a clean kit tree. On a re-bundle (`--force` into an existing
    // dir) this drops any skill/plugin no longer selected by the spec, so the
    // vendored `.claude` never drifts from the regenerated manifest.
    let claude_root = out.join(".claude");
    if claude_root.exists() {
        std::fs::remove_dir_all(&claude_root)?;
    }
    let mut entries = Vec::new();
    for r in &resolved {
        let sub = match r.kind {
            EntryKind::Skill => "skills",
            EntryKind::Plugin => "plugins",
        };
        copy_dir(&r.path, &claude_root.join(sub).join(&r.name))?;
        entries.push(ManifestEntry {
            kind: match r.kind {
                EntryKind::Skill => "skill",
                EntryKind::Plugin => "plugin",
            }
            .to_string(),
            name: r.name.clone(),
            source: r.source.clone(),
            path: r.path.display().to_string(),
        });
    }

    crate::spec::save(&out.join("spec.toml"), spec)?;

    let manifest = BundleManifest {
        tool_version: env!("CARGO_PKG_VERSION").to_string(),
        entry: entries,
    };
    let text = toml::to_string(&manifest)?;
    std::fs::write(out.join("kata-bundle.toml"), text)?;
    Ok(())
}

/// True if `path` is a bundle directory: a dir containing the
/// `kata-bundle.toml` marker. This is the sole disambiguator between a
/// bundle directory and a plain spec-file path.
pub fn is_bundle(path: &Path) -> bool {
    path.is_dir() && path.join("kata-bundle.toml").is_file()
}

/// The default output directory for `bundle`: the spec name slugged into a
/// single filesystem-safe segment plus a `-bundle` suffix. The one home for the
/// naming convention shared by the CLI and the Workbench.
pub fn default_out_dir(spec: &RunSpec) -> std::path::PathBuf {
    format!("{}-bundle", crate::fsutil::slug(&spec.name)).into()
}

/// Discovery roots for running a bundle: the kit is discovered ONLY from
/// the bundle's vendored `.claude`. The project scope is pointed at a
/// path that will not exist, so discovery never leaks user/project entries.
pub fn bundle_roots(bundle_dir: &Path) -> DiscoveryRoots {
    DiscoveryRoots {
        user_dir: bundle_dir.join(".claude"),
        project_dir: bundle_dir.join(".kata-no-project-scope"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::RunSpec;
    use std::fs;

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
    fn bundles_skill_and_writes_spec_and_manifest() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec {
            schema: 1,
            name: "demo".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.skills = vec!["triage".into()];

        let out_root = tempfile::tempdir().unwrap();
        let out = out_root.path().join("demo-bundle");
        bundle(&spec, std::slice::from_ref(&entry), &out, false).unwrap();

        assert!(out
            .join(".claude")
            .join("skills")
            .join("triage")
            .join("SKILL.md")
            .is_file());
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
        let mut spec = RunSpec {
            schema: 1,
            name: "demo".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.skills = vec!["triage".into()];

        let out = tempfile::tempdir().unwrap();
        fs::write(out.path().join("preexisting.txt"), "keep me").unwrap();

        let err = bundle(&spec, std::slice::from_ref(&entry), out.path(), false).unwrap_err();
        assert!(matches!(err, BundleError::Exists(_)));
    }

    #[test]
    fn force_overwrites_nonempty_out() {
        let (entry, _keep) = skill_entry("triage");
        let mut spec = RunSpec {
            schema: 1,
            name: "demo".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.skills = vec!["triage".into()];

        let out = tempfile::tempdir().unwrap();
        fs::write(out.path().join("preexisting.txt"), "keep me").unwrap();

        bundle(&spec, std::slice::from_ref(&entry), out.path(), true).unwrap();
        assert!(out
            .path()
            .join(".claude")
            .join("skills")
            .join("triage")
            .join("SKILL.md")
            .is_file());
    }

    #[test]
    fn force_rebundle_drops_a_removed_skill() {
        let (old, _keep_old) = skill_entry("old");
        let (new, _keep_new) = skill_entry("new");
        let out = tempfile::tempdir().unwrap();

        // First bundle selects "old".
        let mut spec = RunSpec {
            schema: 1,
            name: "demo".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.skills = vec!["old".into()];
        bundle(&spec, std::slice::from_ref(&old), out.path(), false).unwrap();
        assert!(out
            .path()
            .join(".claude")
            .join("skills")
            .join("old")
            .join("SKILL.md")
            .is_file());

        // Re-bundle (force) now selects only "new": the stale "old" kit must be gone
        // and the manifest must list only "new".
        spec.skills = vec!["new".into()];
        bundle(&spec, std::slice::from_ref(&new), out.path(), true).unwrap();
        assert!(out
            .path()
            .join(".claude")
            .join("skills")
            .join("new")
            .join("SKILL.md")
            .is_file());
        assert!(
            !out.path()
                .join(".claude")
                .join("skills")
                .join("old")
                .exists(),
            "a skill dropped from the spec must not linger in the vendored tree"
        );

        let manifest: BundleManifest =
            toml::from_str(&fs::read_to_string(out.path().join("kata-bundle.toml")).unwrap())
                .unwrap();
        assert_eq!(manifest.entry.len(), 1);
        assert_eq!(manifest.entry[0].name, "new");
    }

    #[test]
    fn default_out_dir_slugs_name_and_appends_bundle() {
        let mut spec = RunSpec {
            schema: 1,
            name: "My Cool Kata".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        assert_eq!(
            default_out_dir(&spec),
            std::path::PathBuf::from("My-Cool-Kata-bundle")
        );
        // A name that is already a clean slug just gets the suffix.
        spec.name = "demo".into();
        assert_eq!(default_out_dir(&spec), std::path::PathBuf::from("demo-bundle"));
    }

    #[test]
    fn is_bundle_true_only_for_dir_with_marker() {
        let dir = tempfile::tempdir().unwrap();
        // A plain dir is not a bundle.
        assert!(!is_bundle(dir.path()));
        // With the marker, it is.
        fs::write(
            dir.path().join("kata-bundle.toml"),
            "tool_version = \"0\"\n",
        )
        .unwrap();
        assert!(is_bundle(dir.path()));
        // A file path is never a bundle.
        let file = dir.path().join("kata-bundle.toml");
        assert!(!is_bundle(&file));
    }

    #[test]
    fn bundle_roots_point_user_at_bundle_claude_and_project_nowhere() {
        let dir = tempfile::tempdir().unwrap();
        let roots = bundle_roots(dir.path());
        assert_eq!(roots.user_dir, dir.path().join(".claude"));
        assert!(
            !roots.project_dir.exists(),
            "project scope must point at a nonexistent path"
        );
    }
}
