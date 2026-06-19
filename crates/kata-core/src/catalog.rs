use serde::Serialize;
use std::path::{Path, PathBuf};

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "lowercase"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Skill,
    Plugin,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, Serialize)]
pub struct CatalogEntry {
    pub kind: EntryKind,
    pub name: String,
    pub description: String,
    pub source: String, // original scope: "user" | "project"
    pub path: PathBuf,
    pub provides: Vec<String>,
    pub mcp_servers: Vec<String>,
}

pub struct DiscoveryRoots {
    /// e.g. ~/.claude
    pub user_dir: PathBuf,
    /// e.g. <project>/.claude
    pub project_dir: PathBuf,
}

impl DiscoveryRoots {
    /// Default roots: $HOME/.claude and <cwd>/.claude.
    pub fn defaults(cwd: &Path) -> Self {
        let home = dirs_home();
        Self {
            user_dir: home.join(".claude"),
            project_dir: cwd.join(".claude"),
        }
    }
}

/// Build discovery roots for the Workbench, scoped to an optional workdir.
/// User scope (`~/.claude`) is always included; project scope
/// (`<workdir>/.claude`) is included only when `workdir` is a non-blank path.
/// When absent, `project_dir` points at a path that will not exist, so
/// discovery yields user-scope entries only.
pub fn roots_for_workdir(workdir: Option<&str>) -> DiscoveryRoots {
    let home = dirs_home();
    let project_dir = match workdir {
        Some(w) if !w.trim().is_empty() => Path::new(w).join(".claude"),
        _ => home.join(".kata-no-project-scope"),
    };
    DiscoveryRoots { user_dir: home.join(".claude"), project_dir }
}

fn dirs_home() -> PathBuf {
    // Avoid an extra dependency: HOME on unix, USERPROFILE on windows.
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn discover(roots: &DiscoveryRoots) -> Vec<CatalogEntry> {
    let mut out = Vec::new();
    discover_skills(&roots.user_dir, "user", &mut out);
    discover_skills(&roots.project_dir, "project", &mut out);
    discover_plugins(&roots.user_dir, "user", &mut out);
    discover_plugins(&roots.project_dir, "project", &mut out);
    // Marketplace-installed plugins (incl. those Claude Code caches under
    // plugins/cache/<marketplace>/<plugin>/<version>/) are registered only in
    // installed_plugins.json, never as a flat plugins/<name>/ dir. Read it last
    // so an explicit flat install of the same name wins.
    discover_installed_plugins(&roots.user_dir, &mut out);
    out
}

fn discover_skills(claude_dir: &Path, source: &str, out: &mut Vec<CatalogEntry>) {
    let skills = claude_dir.join("skills");
    let Ok(rd) = std::fs::read_dir(&skills) else { return };
    for entry in rd.flatten() {
        let dir = entry.path();
        let skill_md = dir.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let (name, description) = read_frontmatter(&skill_md);
        let name = name.unwrap_or_else(|| dir.file_name().unwrap().to_string_lossy().into_owned());
        out.push(CatalogEntry {
            kind: EntryKind::Skill,
            name,
            description: description.unwrap_or_default(),
            source: source.to_string(),
            path: dir,
            provides: vec![],
            mcp_servers: vec![],
        });
    }
}

fn discover_plugins(claude_dir: &Path, source: &str, out: &mut Vec<CatalogEntry>) {
    let plugins = claude_dir.join("plugins");
    let Ok(rd) = std::fs::read_dir(&plugins) else { return };
    for entry in rd.flatten() {
        let dir = entry.path();
        let Some(manifest) = plugin_manifest(&dir) else { continue };
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        out.push(CatalogEntry {
            kind: EntryKind::Plugin,
            name,
            description: manifest_description(&manifest),
            source: source.to_string(),
            provides: plugin_provides(&dir),
            mcp_servers: plugin_mcp_servers(&dir),
            path: dir,
        });
    }
}

/// Surface plugins recorded in `<user>/.claude/plugins/installed_plugins.json`.
/// Claude Code installs marketplace plugins into a content-addressed cache and
/// tracks the active `installPath` there, so this is the authoritative way to
/// find them by name. Deduped against plugins already found as flat dirs.
fn discover_installed_plugins(user_claude_dir: &Path, out: &mut Vec<CatalogEntry>) {
    let path = user_claude_dir.join("plugins").join("installed_plugins.json");
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let Some(plugins) = v.get("plugins").and_then(|p| p.as_object()) else { return };
    for (key, records) in plugins {
        // Keys are "<name>@<marketplace>"; a kata references the bare name.
        let name = key.split('@').next().unwrap_or(key).to_string();
        if name.is_empty() || out.iter().any(|e| e.kind == EntryKind::Plugin && e.name == name) {
            continue;
        }
        let Some(arr) = records.as_array() else { continue };
        // First record whose recorded installPath still has a manifest on disk.
        for rec in arr {
            let Some(install) = rec.get("installPath").and_then(|s| s.as_str()) else { continue };
            let root = PathBuf::from(install);
            let Some(manifest) = plugin_manifest(&root) else { continue };
            let source = rec.get("scope").and_then(|s| s.as_str()).unwrap_or("user").to_string();
            out.push(CatalogEntry {
                kind: EntryKind::Plugin,
                description: manifest_description(&manifest),
                name: name.clone(),
                source,
                provides: plugin_provides(&root),
                mcp_servers: plugin_mcp_servers(&root),
                path: root,
            });
            break;
        }
    }
}

/// A plugin's manifest is at `<dir>/plugin.json` (legacy) or
/// `<dir>/.claude-plugin/plugin.json` (current Claude Code layout).
fn plugin_manifest(dir: &Path) -> Option<PathBuf> {
    let root = dir.join("plugin.json");
    if root.is_file() {
        return Some(root);
    }
    let nested = dir.join(".claude-plugin").join("plugin.json");
    nested.is_file().then_some(nested)
}

fn manifest_description(manifest: &Path) -> String {
    std::fs::read_to_string(manifest)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("description").and_then(|d| d.as_str()).map(String::from))
        .unwrap_or_default()
}

fn plugin_provides(dir: &Path) -> Vec<String> {
    let mut provides = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir.join("skills")) {
        for e in rd.flatten() {
            if e.path().join("SKILL.md").is_file() {
                provides.push(format!("skill:{}", e.file_name().to_string_lossy()));
            }
        }
    }
    provides.sort();
    provides
}

fn plugin_mcp_servers(dir: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(dir.join(".mcp.json")) else {
        return vec![];
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    let mut names: Vec<String> = v
        .get("mcpServers")
        .and_then(|m| m.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// Minimal YAML-frontmatter reader: pulls `name:` and `description:` from the
/// leading `---` block. Avoids a YAML dependency for two scalar fields.
fn read_frontmatter(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (None, None);
    };
    let mut lines = text.lines();
    if lines.next().map(|l| l.trim()) != Some("---") {
        return (None, None);
    }
    let (mut name, mut desc) = (None, None);
    for line in lines {
        let t = line.trim();
        if t == "---" {
            break;
        }
        if let Some(rest) = t.strip_prefix("name:") {
            name = Some(rest.trim().trim_matches('"').to_string());
        } else if let Some(rest) = t.strip_prefix("description:") {
            desc = Some(rest.trim().trim_matches('"').to_string());
        }
    }
    (name, desc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_skill(root: &std::path::Path, name: &str, desc: &str) {
        let dir = root.join("skills").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {desc}\n---\nbody\n"),
        )
        .unwrap();
    }

    fn make_plugin(root: &std::path::Path, name: &str, desc: &str, with_mcp: bool) {
        let dir = root.join("plugins").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("plugin.json"),
            format!("{{\"name\":\"{name}\",\"description\":\"{desc}\"}}"),
        )
        .unwrap();
        fs::create_dir_all(dir.join("skills").join("inner")).unwrap();
        fs::write(
            dir.join("skills").join("inner").join("SKILL.md"),
            "---\nname: inner\ndescription: d\n---\n",
        )
        .unwrap();
        if with_mcp {
            fs::write(
                dir.join(".mcp.json"),
                "{\"mcpServers\":{\"srv\":{\"command\":\"x\"}}}",
            )
            .unwrap();
        }
    }

    #[test]
    fn discovers_skills_with_source_labels() {
        let user = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        make_skill(user.path(), "triage", "triage flaky tests");
        make_skill(proj.path(), "build", "build the project");

        let roots = DiscoveryRoots {
            user_dir: user.path().to_path_buf(),
            project_dir: proj.path().to_path_buf(),
        };
        let mut entries = discover(&roots);
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(entries.len(), 2);
        let build = entries.iter().find(|e| e.name == "build").unwrap();
        assert_eq!(build.kind, EntryKind::Skill);
        assert_eq!(build.source, "project");
        assert_eq!(build.description, "build the project");
        let triage = entries.iter().find(|e| e.name == "triage").unwrap();
        assert_eq!(triage.source, "user");
    }

    #[test]
    fn discovers_plugins_with_provides_and_mcp() {
        let user = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        make_plugin(user.path(), "github-tools", "gh", true);

        let roots = DiscoveryRoots {
            user_dir: user.path().to_path_buf(),
            project_dir: proj.path().to_path_buf(),
        };
        let entries = discover(&roots);
        let p = entries.iter().find(|e| e.name == "github-tools").unwrap();
        assert_eq!(p.kind, EntryKind::Plugin);
        assert_eq!(p.mcp_servers, vec!["srv"]);
        assert!(p.provides.iter().any(|s| s == "skill:inner"));
    }

    #[test]
    fn plugin_source_reflects_discovery_scope() {
        // Plugins carry their original scope ("user"/"project"), like skills,
        // so a bundle's manifest records meaningful provenance.
        let user = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        make_plugin(user.path(), "user-plugin", "u", false);
        make_plugin(proj.path(), "project-plugin", "p", false);

        let roots = DiscoveryRoots {
            user_dir: user.path().to_path_buf(),
            project_dir: proj.path().to_path_buf(),
        };
        let entries = discover(&roots);
        let u = entries.iter().find(|e| e.name == "user-plugin").unwrap();
        let p = entries.iter().find(|e| e.name == "project-plugin").unwrap();
        assert_eq!(u.source, "user");
        assert_eq!(p.source, "project");
    }

    fn make_cached_plugin(install_path: &std::path::Path, name: &str, desc: &str, with_mcp: bool) {
        // Modern Claude Code layout: manifest under .claude-plugin/, skills at root.
        let cp = install_path.join(".claude-plugin");
        fs::create_dir_all(&cp).unwrap();
        fs::write(cp.join("plugin.json"), format!("{{\"name\":\"{name}\",\"description\":\"{desc}\"}}")).unwrap();
        fs::create_dir_all(install_path.join("skills").join("inner")).unwrap();
        fs::write(install_path.join("skills").join("inner").join("SKILL.md"), "---\nname: inner\ndescription: d\n---\n").unwrap();
        if with_mcp {
            fs::write(install_path.join(".mcp.json"), "{\"mcpServers\":{\"srv\":{\"command\":\"x\"}}}").unwrap();
        }
    }

    fn write_installed(user_dir: &std::path::Path, name: &str, marketplace: &str, scope: &str, install_path: &std::path::Path) {
        let plugins = user_dir.join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        let json = serde_json::json!({
            "version": 2,
            "plugins": {
                format!("{name}@{marketplace}"): [
                    { "scope": scope, "installPath": install_path.to_string_lossy(), "version": "1.0.0" }
                ]
            }
        });
        fs::write(plugins.join("installed_plugins.json"), serde_json::to_string(&json).unwrap()).unwrap();
    }

    #[test]
    fn discovers_installed_plugin_from_manifest_json() {
        // A marketplace-cached plugin is registered only in installed_plugins.json
        // (not as a flat plugins/<name>/ dir) and carries its manifest under
        // .claude-plugin/. It must still surface, with provides/mcp/source read
        // from its recorded installPath.
        let user = tempfile::tempdir().unwrap();
        let payload = tempfile::tempdir().unwrap();
        make_cached_plugin(payload.path(), "superpowers", "sp", true);
        write_installed(user.path(), "superpowers", "claude-plugins-official", "project", payload.path());

        let roots = DiscoveryRoots { user_dir: user.path().to_path_buf(), project_dir: "/nonexistent".into() };
        let entries = discover(&roots);
        let p = entries.iter().find(|e| e.name == "superpowers").expect("installed plugin discovered");
        assert_eq!(p.kind, EntryKind::Plugin);
        assert_eq!(p.source, "project");
        assert_eq!(p.description, "sp");
        assert_eq!(p.mcp_servers, vec!["srv"]);
        assert!(p.provides.iter().any(|s| s == "skill:inner"));
        assert_eq!(p.path, payload.path());
    }

    #[test]
    fn discovers_flat_plugin_with_claude_plugin_manifest() {
        // A flat-installed plugin whose manifest lives under .claude-plugin/ (no
        // root plugin.json) is discovered too.
        let user = tempfile::tempdir().unwrap();
        let dir = user.path().join("plugins").join("mytool");
        let cp = dir.join(".claude-plugin");
        fs::create_dir_all(&cp).unwrap();
        fs::write(cp.join("plugin.json"), "{\"name\":\"mytool\",\"description\":\"mt\"}").unwrap();

        let roots = DiscoveryRoots { user_dir: user.path().to_path_buf(), project_dir: "/nonexistent".into() };
        let entries = discover(&roots);
        let p = entries.iter().find(|e| e.name == "mytool").expect("flat .claude-plugin manifest discovered");
        assert_eq!(p.description, "mt");
    }

    #[test]
    fn installed_does_not_duplicate_flat_plugin() {
        // A plugin present both as a flat dir and in installed_plugins.json
        // appears once; the flat (explicit) entry wins.
        let user = tempfile::tempdir().unwrap();
        make_plugin(user.path(), "dup", "flat", false);
        let payload = tempfile::tempdir().unwrap();
        make_cached_plugin(payload.path(), "dup", "cached", false);
        write_installed(user.path(), "dup", "mp", "user", payload.path());

        let roots = DiscoveryRoots { user_dir: user.path().to_path_buf(), project_dir: "/nonexistent".into() };
        let entries = discover(&roots);
        let dups: Vec<_> = entries.iter().filter(|e| e.name == "dup").collect();
        assert_eq!(dups.len(), 1, "flat install wins, no duplicate");
        assert_eq!(dups[0].description, "flat");
    }

    #[test]
    fn missing_roots_yield_empty() {
        let roots = DiscoveryRoots {
            user_dir: "/nonexistent/x".into(),
            project_dir: "/nonexistent/y".into(),
        };
        assert!(discover(&roots).is_empty());
    }

    #[test]
    fn roots_for_workdir_uses_project_scope_when_workdir_given() {
        let r = roots_for_workdir(Some("/tmp/proj"));
        assert_eq!(r.project_dir, std::path::Path::new("/tmp/proj").join(".claude"));
        assert!(r.user_dir.ends_with(".claude"));
    }

    #[test]
    fn roots_for_workdir_falls_back_to_user_scope_only_when_absent() {
        let r = roots_for_workdir(None);
        // A path that will not exist, so discovery yields user-scope entries only.
        assert!(r.project_dir.ends_with(".kata-no-project-scope"));

        let blank = roots_for_workdir(Some("   "));
        assert!(blank.project_dir.ends_with(".kata-no-project-scope"));
    }
}
