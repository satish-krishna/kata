use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Skill,
    Plugin,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogEntry {
    pub kind: EntryKind,
    pub name: String,
    pub description: String,
    pub source: String, // "user" | "project" | "plugin"
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
    discover_plugins(&roots.user_dir, &mut out);
    discover_plugins(&roots.project_dir, &mut out);
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

fn discover_plugins(claude_dir: &Path, out: &mut Vec<CatalogEntry>) {
    let plugins = claude_dir.join("plugins");
    let Ok(rd) = std::fs::read_dir(&plugins) else { return };
    for entry in rd.flatten() {
        let dir = entry.path();
        let manifest = dir.join("plugin.json");
        if !manifest.is_file() {
            continue;
        }
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let description = std::fs::read_to_string(&manifest)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("description").and_then(|d| d.as_str()).map(String::from))
            .unwrap_or_default();
        out.push(CatalogEntry {
            kind: EntryKind::Plugin,
            name,
            description,
            source: "plugin".to_string(),
            provides: plugin_provides(&dir),
            mcp_servers: plugin_mcp_servers(&dir),
            path: dir,
        });
    }
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
