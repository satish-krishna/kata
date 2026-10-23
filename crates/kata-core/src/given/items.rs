//! Turns the machine and the run-spec into the items a run would start with.
//! A tool server is described by its name and kind of connection only; its
//! command, arguments, URL, headers and environment never leave the file.
//!
//! Hooks that live in the settings files are not gathered here; `settings::hooks`
//! reads them. A plugin's own hooks are gathered here, with the plugin.

use super::settings::{enabled_plugins, hooks_in, output_style};
use super::{item_id, parse_item_id, ItemFacts, ItemKind, ResolveRoots, SettingsLayer, Source};
use crate::assemble::resolve;
use crate::catalog::{
    discover, discover_skills, installed_records, manifest_description, plugin_manifest,
    CatalogEntry, DiscoveryRoots, EntryKind, InstalledRecord,
};
use crate::spec::{IdentityMode, RunSpec};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Everything the resolver gathers from files and the run-spec except the hooks
/// in settings files. The second value lists what could not be read.
pub fn collect(
    spec: &RunSpec,
    roots: &ResolveRoots,
    layers: &[SettingsLayer],
) -> (Vec<ItemFacts>, Vec<String>) {
    collect_to(spec, roots, layers, None)
}

/// `stop_at` is the highest folder the `CLAUDE.md` walk visits; `None` walks to
/// the filesystem root. Tests use it so a real file above the temp folder never
/// leaks in.
pub(crate) fn collect_to(
    spec: &RunSpec,
    roots: &ResolveRoots,
    layers: &[SettingsLayer],
    stop_at: Option<&Path>,
) -> (Vec<ItemFacts>, Vec<String>) {
    let mut c = Collector {
        items: Vec::new(),
        problems: Vec::new(),
    };
    let workdir = std::path::absolute(&roots.workdir).unwrap_or_else(|_| roots.workdir.clone());
    c.skills_on_disk(roots, &workdir);
    c.installed_plugins(roots, &workdir, layers);
    c.kit(spec, roots, &workdir);
    c.instructions(spec, roots, &workdir, layers, stop_at);
    c.tool_servers(roots, &workdir);
    c.kata();
    (c.items, c.problems)
}

struct Collector {
    items: Vec<ItemFacts>,
    problems: Vec<String>,
}

fn item(kind: ItemKind, source: Source, key: &str, name: &str) -> ItemFacts {
    ItemFacts {
        id: item_id(kind, source, key),
        kind,
        source,
        name: name.to_string(),
        detail: String::new(),
        path: None,
        brought_by: None,
        repo_relative: false,
        shadowed: false,
    }
}

/// A path as one comparable string: forward slashes, no trailing slash, no
/// extended-length prefix, and lowercase on Windows where paths ignore case.
pub(super) fn norm(path: &str) -> String {
    let s = path.replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s).trim_end_matches('/');
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    norm(&a.to_string_lossy()) == norm(&b.to_string_lossy())
}

/// A path for display and for keys: forward slashes only.
fn shown(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The kind of connection a tool server uses, never anything else of it.
fn connection_kind(cfg: &Value) -> &'static str {
    match cfg.get("type").and_then(|t| t.as_str()) {
        Some("stdio") => "stdio",
        Some("http") => "http",
        Some("sse") => "sse",
        _ if cfg.get("command").is_some() => "stdio",
        _ if cfg.get("url").is_some() => "http",
        _ => "unknown",
    }
}

/// `*.md` files under `dir`, sorted, as paths relative to it.
fn markdown_files(dir: &Path) -> Vec<PathBuf> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else if p.extension().is_some_and(|x| x == "md") {
                out.push(p.strip_prefix(base).unwrap_or(&p).to_path_buf());
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

impl Collector {
    /// A JSON file; absent is fine, unreadable or invalid is a problem.
    fn read_json(&mut self, path: &Path) -> Option<Value> {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => {
                self.problems
                    .push(format!("cannot read {}: {e}", path.display()));
                return None;
            }
        };
        match serde_json::from_str(&text) {
            Ok(v) => Some(v),
            Err(e) => {
                self.problems
                    .push(format!("{} is not valid JSON: {e}", path.display()));
                None
            }
        }
    }

    fn skills_in(
        &mut self,
        claude_dir: &Path,
        source: Source,
        brought_by: Option<(&str, &str)>,
        repo_relative: bool,
    ) {
        let mut found = Vec::new();
        discover_skills(claude_dir, "", &mut found);
        found.sort_by(|a, b| a.name.cmp(&b.name));
        for e in found {
            self.items
                .push(skill_item(&e, source, brought_by, repo_relative));
        }
    }

    fn servers(
        &mut self,
        map: Option<&Value>,
        source: Source,
        path: &Path,
        brought_by: Option<(&str, &str)>,
        repo_relative: bool,
    ) {
        let Some(map) = map.and_then(|m| m.as_object()) else {
            return;
        };
        for (name, cfg) in map {
            let key = match brought_by {
                Some((_, pkey)) => format!("{pkey}:{name}"),
                None => name.clone(),
            };
            let mut it = item(ItemKind::ToolServer, source, &key, name);
            it.detail = connection_kind(cfg).to_string();
            it.path = Some(path.to_path_buf());
            it.brought_by = brought_by.map(|(id, _)| id.to_string());
            it.repo_relative = repo_relative;
            self.items.push(it);
        }
    }

    fn skills_on_disk(&mut self, roots: &ResolveRoots, workdir: &Path) {
        self.skills_in(&roots.home.join(".claude"), Source::Personal, None, false);
        self.skills_in(&workdir.join(".claude"), Source::Project, None, true);
    }

    /// A plugin's skills, hooks and tool servers, each brought by the plugin.
    fn plugin_parts(&mut self, root: &Path, plugin_id: &str, plugin_key: &str) {
        let by = Some((plugin_id, plugin_key));
        self.skills_in(root, Source::Plugin, by, false);
        let hooks_file = root.join("hooks").join("hooks.json");
        if let Some(v) = self.read_json(&hooks_file) {
            // The file is either `{ "hooks": { ... } }` or the events themselves.
            let events = v.get("hooks").unwrap_or(&v);
            for mut h in hooks_in(
                Some(events),
                Source::Plugin,
                &hooks_file,
                Some(plugin_id),
                false,
            ) {
                // Two plugins may run the same command; the plugin keeps them apart.
                if let Ok(r) = parse_item_id(&h.id) {
                    let key = format!("{plugin_key}:{}", r.key);
                    h.id = item_id(ItemKind::Hook, Source::Plugin, &key);
                }
                self.items.push(h);
            }
        }
        let mcp_file = root.join(".mcp.json");
        if let Some(v) = self.read_json(&mcp_file) {
            // Either `{ "mcpServers": { ... } }` or the servers themselves.
            let servers = v.get("mcpServers").unwrap_or(&v);
            self.servers(Some(servers), Source::Plugin, &mcp_file, by, false);
        }
    }

    /// Installed and enabled plugins. A project or local install counts only for
    /// the folder it was installed for.
    fn installed_plugins(
        &mut self,
        roots: &ResolveRoots,
        workdir: &Path,
        layers: &[SettingsLayer],
    ) {
        let enabled = enabled_plugins(layers);
        let records = installed_records(&roots.home.join(".claude"));
        let mut done: Vec<&str> = Vec::new();
        for rec in &records {
            if done.contains(&rec.key.as_str())
                || enabled.get(&rec.key).map(|(on, _)| *on) != Some(true)
            {
                continue;
            }
            let Some(mut source) = install_source(rec, workdir) else {
                continue;
            };
            // A plugin the organization enables is the organization's, whatever
            // scope it was installed in.
            if enabled.get(&rec.key).map(|(_, layer)| *layer) == Some(Source::Organization) {
                source = Source::Organization;
            }
            done.push(&rec.key);
            let Some(manifest) = plugin_manifest(&rec.install_path) else {
                self.problems.push(format!(
                    "plugin {} is enabled but {} has no plugin manifest",
                    rec.key,
                    rec.install_path.display()
                ));
                continue;
            };
            let name = rec.key.split('@').next().unwrap_or(&rec.key);
            let mut it = item(ItemKind::Plugin, source, &rec.key, name);
            it.detail = manifest_description(&manifest);
            it.path = Some(rec.install_path.clone());
            let id = it.id.clone();
            self.items.push(it);
            self.plugin_parts(&rec.install_path, &id, &rec.key);
        }
    }

    /// The skills and plugins the run-spec picks, resolved one by one so a name
    /// that is missing is a problem and not the end of the others.
    fn kit(&mut self, spec: &RunSpec, roots: &ResolveRoots, workdir: &Path) {
        if spec.skills.is_empty() && spec.plugins.is_empty() {
            return;
        }
        let catalog = discover(&DiscoveryRoots {
            user_dir: roots.home.join(".claude"),
            project_dir: workdir.join(".claude"),
        });
        let names = spec
            .skills
            .iter()
            .map(|s| (EntryKind::Skill, s))
            .chain(spec.plugins.keys().map(|p| (EntryKind::Plugin, p)));
        for (kind, name) in names {
            let mut one = RunSpec::default();
            match kind {
                EntryKind::Skill => one.skills = vec![name.clone()],
                EntryKind::Plugin => {
                    one.plugins = BTreeMap::from([(name.clone(), Default::default())])
                }
            }
            let resolved = match resolve(&one, &catalog) {
                Ok(r) => r,
                Err(e) => {
                    self.problems.push(format!("the run-spec's kit: {e}"));
                    continue;
                }
            };
            for r in resolved {
                let entry = catalog
                    .iter()
                    .find(|e| e.kind == r.kind && e.name == r.name && e.path == r.path);
                match r.kind {
                    EntryKind::Skill => {
                        if let Some(e) = entry {
                            let mut it = skill_item(e, Source::RunSpec, None, false);
                            it.shadowed = self.items.iter().any(|i| {
                                i.kind == ItemKind::Skill
                                    && matches!(i.source, Source::Personal | Source::Project)
                                    && i.name == e.name
                            });
                            self.items.push(it);
                        }
                    }
                    EntryKind::Plugin => {
                        let mut it = item(ItemKind::Plugin, Source::RunSpec, &r.name, &r.name);
                        it.detail = entry.map(|e| e.description.clone()).unwrap_or_default();
                        it.path = Some(r.path.clone());
                        it.shadowed = self.items.iter().any(|i| {
                            i.kind == ItemKind::Plugin
                                && i.source != Source::RunSpec
                                && i.name == r.name
                        });
                        let id = it.id.clone();
                        self.items.push(it);
                        self.plugin_parts(&r.path, &id, &r.name);
                    }
                }
            }
        }
    }

    fn instruction_file(&mut self, source: Source, key: &str, name: &str, path: PathBuf) {
        let mut it = item(ItemKind::Instruction, source, key, name);
        it.path = Some(path);
        it.repo_relative = matches!(source, Source::Project | Source::ProjectLocal);
        self.items.push(it);
    }

    fn instructions(
        &mut self,
        spec: &RunSpec,
        roots: &ResolveRoots,
        workdir: &Path,
        layers: &[SettingsLayer],
        stop_at: Option<&Path>,
    ) {
        let home_claude = roots.home.join(".claude");
        if home_claude.join("CLAUDE.md").is_file() {
            self.instruction_file(
                Source::Personal,
                "CLAUDE.md",
                "CLAUDE.md",
                home_claude.join("CLAUDE.md"),
            );
        }
        for rel in markdown_files(&home_claude.join("rules")) {
            let key = format!(".claude/rules/{}", shown(&rel));
            self.instruction_file(
                Source::Personal,
                &key,
                &key,
                home_claude.join("rules").join(&rel),
            );
        }
        // Every CLAUDE.md from the workdir up. Claude Code also reads ones in
        // folders below the workdir, but only when it opens files there.
        for dir in workdir.ancestors() {
            let own = same_dir(dir, workdir);
            for (rel, nested) in [("CLAUDE.md", false), (".claude/CLAUDE.md", true)] {
                // `~/.claude/CLAUDE.md` is the personal file, already listed.
                if nested && same_dir(dir, &roots.home) {
                    continue;
                }
                let path = dir.join(rel);
                if !path.is_file() {
                    continue;
                }
                if own {
                    self.instruction_file(Source::Project, rel, rel, path);
                } else {
                    let full = shown(&path);
                    let mut it = item(ItemKind::Instruction, Source::Project, &full, &full);
                    it.detail = "from a parent folder".to_string();
                    it.path = Some(path);
                    self.items.push(it);
                }
            }
            if stop_at.is_some_and(|s| same_dir(dir, s)) {
                break;
            }
        }
        let rules = workdir.join(".claude").join("rules");
        for rel in markdown_files(&rules) {
            let key = format!(".claude/rules/{}", shown(&rel));
            self.instruction_file(Source::Project, &key, &key, rules.join(&rel));
        }
        let local = workdir.join("CLAUDE.local.md");
        if local.is_file() {
            self.instruction_file(
                Source::ProjectLocal,
                "CLAUDE.local.md",
                "CLAUDE.local.md",
                local,
            );
        }
        if let Some((style, source)) = output_style(layers) {
            let mut it = item(
                ItemKind::Instruction,
                source,
                "output-style",
                "Output style",
            );
            it.detail = style;
            self.items.push(it);
        }
        if spec
            .identity
            .system_prompt
            .as_deref()
            .is_some_and(|p| !p.trim().is_empty())
        {
            let mut it = item(
                ItemKind::Instruction,
                Source::RunSpec,
                "system-prompt",
                "System prompt",
            );
            it.detail = match spec.identity.mode {
                IdentityMode::Append => "appended",
                IdentityMode::Replace => "replaces Claude's",
            }
            .to_string();
            self.items.push(it);
        }
    }

    fn tool_servers(&mut self, roots: &ResolveRoots, workdir: &Path) {
        if let Some(v) = self.read_json(&roots.claude_json) {
            self.servers(
                v.get("mcpServers"),
                Source::Personal,
                &roots.claude_json,
                None,
                false,
            );
            // Local scope: the entry for this folder. Claude Code writes the key as
            // an absolute path, with whichever separators and drive-letter case it
            // saw, so compare them loosely.
            let want = norm(&workdir.to_string_lossy());
            let local = v
                .get("projects")
                .and_then(|p| p.as_object())
                .and_then(|p| p.iter().find(|(k, _)| norm(k) == want))
                .and_then(|(_, p)| p.get("mcpServers"));
            self.servers(local, Source::ProjectLocal, &roots.claude_json, None, false);
        }
        let project = workdir.join(".mcp.json");
        if let Some(v) = self.read_json(&project) {
            self.servers(v.get("mcpServers"), Source::Project, &project, None, true);
        }
        let managed = roots.managed_settings.with_file_name("managed-mcp.json");
        if let Some(v) = self.read_json(&managed) {
            self.servers(
                v.get("mcpServers"),
                Source::Organization,
                &managed,
                None,
                false,
            );
        }
    }

    /// What Kata adds to every run.
    fn kata(&mut self) {
        let name = crate::ask::MCP_SERVER_NAME;
        let mut server = item(ItemKind::ToolServer, Source::Kata, name, name);
        server.detail = "stdio".to_string();
        self.items.push(server);
        let mut note = item(
            ItemKind::Instruction,
            Source::Kata,
            "standing-note",
            "Standing note",
        );
        note.detail = crate::run::INTERACTIVE_RETASK.to_string();
        self.items.push(note);
    }
}

fn skill_item(
    e: &CatalogEntry,
    source: Source,
    brought_by: Option<(&str, &str)>,
    repo_relative: bool,
) -> ItemFacts {
    let key = match brought_by {
        Some((_, pkey)) => format!("{pkey}:{}", e.name),
        None => e.name.clone(),
    };
    let mut it = item(ItemKind::Skill, source, &key, &e.name);
    it.detail = e.description.clone();
    it.path = Some(e.path.clone());
    it.brought_by = brought_by.map(|(id, _)| id.to_string());
    it.repo_relative = repo_relative;
    it
}

/// The source a plugin install counts as, or `None` when it is not for this
/// folder.
fn install_source(rec: &InstalledRecord, workdir: &Path) -> Option<Source> {
    let for_here = || {
        rec.project_path
            .as_deref()
            .is_some_and(|p| norm(p) == norm(&workdir.to_string_lossy()))
    };
    match rec.scope.as_str() {
        "user" => Some(Source::Personal),
        "project" => for_here().then_some(Source::Project),
        "local" => for_here().then_some(Source::ProjectLocal),
        "managed" => Some(Source::Organization),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::given::settings::read_layers;
    use crate::given::{ItemKind, Source};
    use std::fs;
    use std::path::{Path, PathBuf};

    const TOKEN: &str = "tok-s3cret-9f8e7d";

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn roots(dir: &Path) -> ResolveRoots {
        ResolveRoots {
            home: dir.join("home"),
            workdir: dir.join("work"),
            managed_settings: dir.join("managed").join("managed-settings.json"),
            claude_json: dir.join("home").join(".claude.json"),
        }
    }

    fn skill(dir: &Path, name: &str) {
        write(
            &dir.join("skills").join(name).join("SKILL.md"),
            &format!("---\nname: {name}\ndescription: does {name}\n---\nbody\n"),
        );
    }

    fn hook_json(command: &str) -> String {
        serde_json::json!({"hooks": {"PreToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": command}]}
        ]}})
        .to_string()
    }

    fn plugin(dir: &Path, name: &str, with_parts: bool) {
        write(
            &dir.join(".claude-plugin").join("plugin.json"),
            &format!("{{\"name\":\"{name}\",\"description\":\"the {name} plugin\"}}"),
        );
        if with_parts {
            skill(dir, "plug-skill");
            write(
                &dir.join("hooks").join("hooks.json"),
                &hook_json("node plug.js"),
            );
            write(
                &dir.join(".mcp.json"),
                &serde_json::json!({"mcpServers": {"plug-srv": {
                    "command": "node", "args": ["srv.js"], "env": {"API_KEY": TOKEN}
                }}})
                .to_string(),
            );
        }
    }

    /// One item of every R2.1 row, on disk.
    fn fixture(dir: &Path) -> (ResolveRoots, RunSpec) {
        let r = roots(dir);
        let home = &r.home;
        let work = &r.workdir;
        // Settings: hooks in personal, project and organization, plugins enabled.
        write(
            &home.join(".claude/settings.json"),
            &serde_json::json!({
                "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "node p.js"}]}]},
                "enabledPlugins": {"pers@mkt": true, "proj@mkt": true, "off@mkt": false}
            })
            .to_string(),
        );
        write(&work.join(".claude/settings.json"), &hook_json("node q.js"));
        write(&r.managed_settings, &hook_json("node org.js"));
        // Skills on disk.
        skill(&home.join(".claude"), "own-skill");
        skill(&home.join(".claude"), "kit-skill");
        skill(&work.join(".claude"), "proj-skill");
        // Installed plugins.
        let (pers, proj, off) = (
            dir.join("cache/pers"),
            dir.join("cache/proj"),
            dir.join("cache/off"),
        );
        plugin(&pers, "pers", true);
        plugin(&proj, "proj", false);
        plugin(&off, "off", true);
        let rec = |path: &Path, scope: &str, project: Option<&Path>| {
            let mut v = serde_json::json!({
                "scope": scope, "installPath": path.to_string_lossy(), "version": "1"
            });
            if let Some(p) = project {
                v["projectPath"] = serde_json::json!(p.to_string_lossy());
            }
            serde_json::json!([v])
        };
        write(
            &home.join(".claude/plugins/installed_plugins.json"),
            &serde_json::json!({"version": 2, "plugins": {
                "pers@mkt": rec(&pers, "user", None),
                "proj@mkt": rec(&proj, "project", Some(work)),
                "off@mkt": rec(&off, "user", None),
            }})
            .to_string(),
        );
        // A flat plugin the run-spec kit picks.
        plugin(&home.join(".claude/plugins/kit-plug"), "kit-plug", false);
        // Standing instructions.
        write(&home.join(".claude/CLAUDE.md"), "personal rules");
        write(&work.join("CLAUDE.md"), "project rules");
        // Tool servers.
        write(
            &r.claude_json,
            &serde_json::json!({"mcpServers": {"own-srv": {
                "type": "http", "url": format!("https://x.test/?k={TOKEN}"),
                "headers": {"Authorization": format!("Bearer {TOKEN}")}}}})
            .to_string(),
        );
        write(
            &work.join(".mcp.json"),
            &serde_json::json!({"mcpServers": {"proj-srv": {
                "command": "node", "args": ["--token", TOKEN], "env": {"API_KEY": TOKEN},
                "headers": {"Authorization": format!("Bearer {TOKEN}")}}}})
            .to_string(),
        );
        let mut spec = RunSpec {
            workdir: work.to_string_lossy().into_owned(),
            skills: vec!["kit-skill".into()],
            ..RunSpec::default()
        };
        spec.plugins.insert("kit-plug".into(), Default::default());
        spec.identity.system_prompt = Some("be brief".into());
        (r, spec)
    }

    fn run(r: &ResolveRoots, spec: &RunSpec, stop: &Path) -> (Vec<ItemFacts>, Vec<String>) {
        let layers = read_layers(r);
        let (mut items, problems) = collect_to(spec, r, &layers, Some(stop));
        items.extend(crate::given::settings::hooks(&layers));
        (items, problems)
    }

    fn has(items: &[ItemFacts], kind: ItemKind, source: Source, name: &str) -> bool {
        items
            .iter()
            .any(|i| i.kind == kind && i.source == source && i.name == name)
    }

    #[test]
    fn every_kind_and_source_pair_of_r2_1_is_produced() {
        let d = tempfile::tempdir().unwrap();
        let (r, spec) = fixture(d.path());
        let (items, problems) = run(&r, &spec, d.path());
        assert!(problems.is_empty(), "{problems:?}");
        use ItemKind as K;
        use Source as S;
        let rows: [(ItemKind, Source, &str); 19] = [
            (K::Hook, S::Personal, "Stop any"),
            (K::Hook, S::Project, "PreToolUse Bash"),
            (K::Hook, S::Plugin, "PreToolUse Bash"),
            (K::Hook, S::Organization, "PreToolUse Bash"),
            (K::Skill, S::Personal, "own-skill"),
            (K::Skill, S::Project, "proj-skill"),
            (K::Skill, S::Plugin, "plug-skill"),
            (K::Skill, S::RunSpec, "kit-skill"),
            (K::Plugin, S::Personal, "pers"),
            (K::Plugin, S::Project, "proj"),
            (K::Plugin, S::RunSpec, "kit-plug"),
            (K::Instruction, S::Personal, "CLAUDE.md"),
            (K::Instruction, S::Project, "CLAUDE.md"),
            (K::Instruction, S::Kata, "Standing note"),
            (K::Instruction, S::RunSpec, "System prompt"),
            (K::ToolServer, S::Personal, "own-srv"),
            (K::ToolServer, S::Project, "proj-srv"),
            (K::ToolServer, S::Plugin, "plug-srv"),
            (K::ToolServer, S::Kata, "kata-ask"),
        ];
        for (kind, source, name) in rows {
            assert!(
                has(&items, kind, source, name),
                "missing {kind:?} {source:?} {name}"
            );
        }
        let ids: std::collections::HashSet<_> = items.iter().map(|i| &i.id).collect();
        assert_eq!(ids.len(), items.len(), "ids must be unique");
    }

    #[test]
    fn a_disabled_installed_plugin_is_not_an_item() {
        let d = tempfile::tempdir().unwrap();
        let (r, spec) = fixture(d.path());
        let (items, _) = run(&r, &spec, d.path());
        assert!(!items.iter().any(|i| i.name == "off"));
        // Nor do its skills, hooks or tool servers appear.
        assert_eq!(
            items.iter().filter(|i| i.name == "plug-skill").count(),
            1,
            "only the enabled plugin skill"
        );
    }

    #[test]
    fn a_plugins_skills_hooks_and_tool_servers_are_brought_by_it() {
        let d = tempfile::tempdir().unwrap();
        let (r, spec) = fixture(d.path());
        let (items, _) = run(&r, &spec, d.path());
        let plugin = items
            .iter()
            .find(|i| i.kind == ItemKind::Plugin && i.name == "pers")
            .unwrap();
        assert_eq!(plugin.id, "personal:plugin:pers@mkt");
        let brought: Vec<_> = items
            .iter()
            .filter(|i| i.source == Source::Plugin)
            .collect();
        assert_eq!(brought.len(), 3, "{brought:?}");
        for i in brought {
            assert_eq!(
                i.brought_by.as_deref(),
                Some(plugin.id.as_str()),
                "{}",
                i.id
            );
        }
        let kit = items
            .iter()
            .find(|i| i.kind == ItemKind::Plugin && i.source == Source::RunSpec)
            .unwrap();
        assert_eq!(kit.id, "run-spec:plugin:kit-plug");
    }

    #[test]
    fn ancestor_claude_md_files_are_project_instructions_with_their_path() {
        let d = tempfile::tempdir().unwrap();
        let mut r = roots(d.path());
        r.workdir = d.path().join("mono/pkg/app");
        write(&d.path().join("mono/CLAUDE.md"), "mono rules");
        write(&d.path().join("mono/pkg/.claude/CLAUDE.md"), "pkg rules");
        write(&r.workdir.join("CLAUDE.local.md"), "mine");
        write(&r.workdir.join(".claude/rules/style/a.md"), "rule");
        let spec = RunSpec {
            workdir: r.workdir.to_string_lossy().into_owned(),
            ..RunSpec::default()
        };
        let (items, _) = run(&r, &spec, d.path());
        let inst: Vec<_> = items
            .iter()
            .filter(|i| i.kind == ItemKind::Instruction && i.path.is_some())
            .collect();
        let at = |p: PathBuf| inst.iter().find(|i| i.path.as_deref() == Some(p.as_path()));
        let mono = at(d.path().join("mono/CLAUDE.md")).unwrap();
        assert_eq!(mono.source, Source::Project);
        assert!(mono.name.ends_with("mono/CLAUDE.md"), "{}", mono.name);
        let pkg = at(d.path().join("mono/pkg/.claude/CLAUDE.md")).unwrap();
        assert_eq!(pkg.source, Source::Project);
        assert!(
            pkg.name.ends_with("mono/pkg/.claude/CLAUDE.md"),
            "{}",
            pkg.name
        );
        assert_eq!(
            at(r.workdir.join("CLAUDE.local.md")).unwrap().source,
            Source::ProjectLocal
        );
        assert_eq!(
            at(r.workdir.join(".claude/rules/style/a.md"))
                .unwrap()
                .source,
            Source::Project
        );
    }

    #[test]
    fn a_tool_server_keeps_its_name_and_connection_kind_only() {
        let d = tempfile::tempdir().unwrap();
        let (r, spec) = fixture(d.path());
        // The local scope of the same file, and the organization file.
        let mut cj: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&r.claude_json).unwrap()).unwrap();
        cj["projects"] = serde_json::json!({
            r.workdir.to_string_lossy().replace('\\', "/"): {"mcpServers": {"local-srv": {
                "type": "sse", "url": format!("https://l.test/{TOKEN}")}}}
        });
        write(&r.claude_json, &cj.to_string());
        write(
            &r.managed_settings.with_file_name("managed-mcp.json"),
            &serde_json::json!({"mcpServers": {"org-srv": {"command": "org", "env": {"K": TOKEN}}}})
                .to_string(),
        );
        let (items, _) = run(&r, &spec, d.path());
        let find = |n: &str| items.iter().find(|i| i.name == n).unwrap();
        assert_eq!(find("own-srv").detail, "http");
        assert_eq!(find("proj-srv").detail, "stdio");
        assert_eq!(find("local-srv").detail, "sse");
        assert_eq!(find("local-srv").source, Source::ProjectLocal);
        assert_eq!(find("org-srv").source, Source::Organization);
        assert_eq!(find("org-srv").detail, "stdio");
        assert_eq!(find("plug-srv").detail, "stdio");
        let all = format!("{items:?}");
        assert!(!all.contains(TOKEN), "a secret leaked: {all}");
        assert!(!all.contains("srv.js") && !all.contains("x.test"));
        let json = serde_json::to_string(&items).unwrap();
        assert!(!json.contains(TOKEN), "a secret leaked: {json}");
    }

    #[test]
    fn a_kit_skill_that_is_also_on_disk_is_shadowed() {
        let d = tempfile::tempdir().unwrap();
        let (r, spec) = fixture(d.path());
        let (items, _) = run(&r, &spec, d.path());
        let kit = items
            .iter()
            .find(|i| i.kind == ItemKind::Skill && i.source == Source::RunSpec)
            .expect("the kit skill");
        assert_eq!(kit.name, "kit-skill");
        assert!(kit.shadowed, "kit-skill is also a personal skill");
        // A kit plugin that is not installed is not shadowed.
        let plug = items
            .iter()
            .find(|i| i.kind == ItemKind::Plugin && i.source == Source::RunSpec)
            .expect("the kit plugin");
        assert!(!plug.shadowed);
        // Nothing but a run-spec skill or plugin is ever shadowed.
        assert!(items
            .iter()
            .filter(|i| i.source != Source::RunSpec)
            .all(|i| !i.shadowed));
    }

    #[test]
    fn a_kit_plugin_that_is_also_installed_and_enabled_is_shadowed() {
        let d = tempfile::tempdir().unwrap();
        let (r, mut spec) = fixture(d.path());
        spec.skills.clear();
        spec.plugins.clear();
        // `pers@mkt` is installed and enabled by the fixture; the kit picks `pers`.
        plugin(&r.home.join(".claude/plugins/pers"), "pers", false);
        spec.plugins.insert("pers".into(), Default::default());
        let (items, _) = run(&r, &spec, d.path());
        let kit = items
            .iter()
            .find(|i| i.kind == ItemKind::Plugin && i.source == Source::RunSpec)
            .expect("the kit plugin");
        assert!(kit.shadowed);
    }

    #[test]
    fn a_plugin_the_organization_enables_takes_the_organization_as_its_source() {
        let d = tempfile::tempdir().unwrap();
        let (r, spec) = fixture(d.path());
        let org = d.path().join("cache/org");
        plugin(&org, "org", false);
        write(
            &r.managed_settings,
            &serde_json::json!({"enabledPlugins": {"org@mkt": true}}).to_string(),
        );
        let path = r.home.join(".claude/plugins/installed_plugins.json");
        let mut v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        v["plugins"]["org@mkt"] = serde_json::json!([
            {"scope": "user", "installPath": org.to_string_lossy(), "version": "1"}
        ]);
        write(&path, &v.to_string());
        let (items, _) = run(&r, &spec, d.path());
        assert!(
            has(&items, ItemKind::Plugin, Source::Organization, "org"),
            "{:?}",
            items
                .iter()
                .filter(|i| i.kind == ItemKind::Plugin)
                .map(|i| (&i.name, i.source))
                .collect::<Vec<_>>()
        );
        assert!(!has(&items, ItemKind::Plugin, Source::Personal, "org"));
    }
}
