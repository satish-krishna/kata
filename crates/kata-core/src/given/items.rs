//! Turns the machine and the run-spec into the items a run would start with.
//! A tool server is described by its name and kind of connection only; its
//! command, arguments, URL, headers and environment never leave the file.

use super::{ItemFacts, ResolveRoots, SettingsLayer};
use crate::spec::RunSpec;
use std::path::Path;

/// Every item except the settings-derived ones is gathered here.
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
    _spec: &RunSpec,
    _roots: &ResolveRoots,
    _layers: &[SettingsLayer],
    _stop_at: Option<&Path>,
) -> (Vec<ItemFacts>, Vec<String>) {
    (Vec::new(), Vec::new())
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
}
