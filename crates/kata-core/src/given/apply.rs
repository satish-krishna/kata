//! How a switched-off item is kept from Claude. Pure in the sense that matters:
//! it builds values, reads the setup files the resolved items name (their
//! definitions are never carried in `Resolved`, they hold secrets) and writes
//! nothing.

use super::settings::read_layers;
use super::{hook_key, item_id, parse_item_id, ItemKind, ResolveRoots, Resolved, Source};
use crate::spec::RunSpec;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The name of the plugin Kata generates to hand a dropped project's skills,
/// agents and commands back to Claude.
pub const CARRY_PLUGIN: &str = "kata-proj";

/// How Claude names a carried-over project skill, agent or command.
pub fn carried_name(name: &str) -> String {
    format!("{CARRY_PLUGIN}:{name}")
}

/// Makes Claude load `CLAUDE.md`, its imports and `.claude/rules` from an
/// `--add-dir` folder.
const ADD_DIR_MD_ENV: (&str, &str) = ("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", "1");

/// What a dropped settings source hands back by other routes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Carry {
    /// `{ "mcpServers": { ... } }` holding the project's `.mcp.json` servers that
    /// are not switched off, verbatim. Passed as an addition to the scopes Claude reads itself, so it
    /// only adds.
    pub mcp: Option<Value>,
    /// Files to copy into the generated plugin folder: (source, path inside it).
    pub plugin: Vec<(PathBuf, PathBuf)>,
    /// The folder passed as `--add-dir`.
    pub add_dir: Option<PathBuf>,
    /// Environment variables for the child.
    pub env: Vec<(&'static str, &'static str)>,
}

/// What to change about a run so each switched-off item stays out of it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Applied {
    /// Kit skills and plugins `assemble` leaves out of the plugin folder.
    pub kit_skip: BTreeSet<String>,
    /// Keys for the per-run `--settings` file (`enabledPlugins`,
    /// `claudeMdExcludes`, `outputStyle`, `deniedMcpServers`, and the settings of
    /// a dropped source).
    pub settings: Map<String, Value>,
    /// The `--setting-sources` list, present only when a project hook is off.
    pub setting_sources: Option<Vec<&'static str>>,
    /// What a dropped settings source hands back by other routes.
    pub carry: Option<Carry>,
    /// The run-spec's system prompt is switched off.
    pub drop_system_prompt: bool,
}

/// `path` made relative to `base`, when it lies under it.
fn relative_to<'a>(path: &'a Path, base: &Path) -> Option<&'a Path> {
    let mut rest = path.components();
    for want in base.components() {
        let got = rest.next()?;
        let (g, w) = (got.as_os_str(), want.as_os_str());
        let same = if cfg!(windows) {
            g.to_string_lossy()
                .eq_ignore_ascii_case(&w.to_string_lossy())
        } else {
            g == w
        };
        if !same {
            return None;
        }
    }
    Some(rest.as_path())
}

/// A path under the workdir moved to the same place under the folder Claude runs
/// in; any other path unchanged.
fn rebase(path: &Path, workdir: &Path, run_dir: &Path) -> PathBuf {
    match relative_to(path, workdir) {
        Some(rel) => run_dir.join(rel),
        None => path.to_path_buf(),
    }
}

/// What a hook entry runs or calls, as `hook_key` hashes it.
fn hook_text(entry: &Value) -> Option<&str> {
    let text = |field: &str| entry.get(field).and_then(Value::as_str);
    match entry.get("type").and_then(Value::as_str)? {
        "command" => text("command"),
        "prompt" | "agent" => text("prompt"),
        "http" => text("url"),
        _ => None,
    }
}

/// Remove the switched-off hooks of one layer, and the groups and events that
/// are left empty.
fn strip_off_hooks(layer: &mut Map<String, Value>, source: Source, off: &BTreeSet<String>) {
    let Some(Value::Object(events)) = layer.get_mut("hooks") else {
        return;
    };
    events.retain(|event, groups| {
        let Some(groups) = groups.as_array_mut() else {
            return true;
        };
        groups.retain_mut(|group| {
            let matcher = group
                .get("matcher")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .map(String::from);
            let Some(entries) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            entries.retain(|e| match hook_text(e) {
                Some(t) => {
                    let key = hook_key(event, matcher.as_deref(), t);
                    !off.contains(&item_id(ItemKind::Hook, source, &key))
                }
                None => true,
            });
            !entries.is_empty()
        });
        !groups.is_empty()
    });
    if events.is_empty() {
        layer.remove("hooks");
    }
}

/// Replace every scalar of `carried` by the value it has once all layers are
/// merged in Claude's order, so a re-routed value never beats a kept layer that
/// should win.
fn pin_scalars(carried: &mut Map<String, Value>, effective: &Map<String, Value>) {
    for (key, value) in carried.iter_mut() {
        match (value, effective.get(key)) {
            (Value::Object(c), Some(Value::Object(e))) => pin_scalars(c, e),
            (Value::Object(_) | Value::Array(_), _) => {}
            (v, Some(e)) if !e.is_object() && !e.is_array() => *v = e.clone(),
            _ => {}
        }
    }
}

/// Every file under `dir`, relative to it, in a stable order.
fn files_under(dir: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, rel: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let rel = rel.join(entry.file_name());
            match entry.file_type() {
                Ok(t) if t.is_dir() => walk(&entry.path(), &rel, out),
                Ok(t) if t.is_file() => out.push(rel),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, Path::new(""), &mut out);
    out.sort();
    out
}

/// The project's `.mcp.json` servers that are not switched off, verbatim.
fn project_servers(workdir: &Path, off: &BTreeSet<String>) -> Option<Value> {
    let text = std::fs::read_to_string(workdir.join(".mcp.json")).ok()?;
    let file: Value = serde_json::from_str(&text).ok()?;
    let mut servers = file.get("mcpServers")?.as_object()?.clone();
    servers.retain(|name, _| !off.contains(name));
    (!servers.is_empty()).then(|| json!({ "mcpServers": servers }))
}

pub fn apply(
    _spec: &RunSpec,
    resolved: &Resolved,
    roots: &ResolveRoots,
    run_dir: &Path,
) -> Applied {
    let mut out = Applied::default();
    let missing: BTreeSet<&str> = resolved.missing.iter().map(String::as_str).collect();
    let mut enabled = Map::new();
    let mut excludes: Vec<Value> = Vec::new();
    let mut denied: Vec<Value> = Vec::new();
    let mut off_hooks: BTreeSet<String> = BTreeSet::new();
    let mut off_project_servers: BTreeSet<String> = BTreeSet::new();
    let (mut drop_project, mut drop_local) = (false, false);
    for i in &resolved.items {
        // The lock is the one authority on what a switch can reach. An item that
        // goes off with a hook follows that hook's source, not a switch of its own.
        if !i.off
            || i.lock.is_some()
            || missing.contains(i.id.as_str())
            || !i.goes_off_with.is_empty()
        {
            continue;
        }
        let Ok(r) = parse_item_id(&i.id) else {
            continue;
        };
        match (i.kind, i.source) {
            (ItemKind::Skill | ItemKind::Plugin, Source::RunSpec) => {
                out.kit_skip.insert(r.key);
            }
            (ItemKind::Plugin, Source::Personal | Source::Project | Source::ProjectLocal) => {
                enabled.insert(r.key, Value::Bool(false));
            }
            (ItemKind::Instruction, Source::RunSpec) if r.key == "system-prompt" => {
                out.drop_system_prompt = true;
            }
            (ItemKind::Instruction, Source::RunSpec) => {}
            (ItemKind::Instruction, _) => {
                if r.key == "output-style" {
                    out.settings
                        .insert("outputStyle".into(), Value::String("default".into()));
                } else if let Some(p) = &i.path {
                    let moved = rebase(Path::new(p), &roots.workdir, run_dir);
                    excludes.push(Value::String(moved.to_string_lossy().replace('\\', "/")));
                }
            }
            (ItemKind::ToolServer, Source::Personal | Source::Project | Source::ProjectLocal) => {
                denied.push(json!({ "serverName": r.key }));
                if i.source == Source::Project {
                    off_project_servers.insert(r.key);
                }
            }
            (ItemKind::Hook, Source::Project) => {
                drop_project = true;
                off_hooks.insert(i.id.clone());
            }
            (ItemKind::Hook, Source::ProjectLocal) => {
                drop_local = true;
                off_hooks.insert(i.id.clone());
            }
            _ => {}
        }
    }
    if !enabled.is_empty() {
        out.settings
            .insert("enabledPlugins".into(), Value::Object(enabled));
    }
    if !excludes.is_empty() {
        out.settings
            .insert("claudeMdExcludes".into(), Value::Array(excludes));
    }
    if !denied.is_empty() {
        out.settings
            .insert("deniedMcpServers".into(), Value::Array(denied));
    }
    out.setting_sources = match (drop_project, drop_local) {
        (false, false) => None,
        (true, false) => Some(vec!["user", "local"]),
        (false, true) => Some(vec!["user", "project"]),
        (true, true) => Some(vec!["user"]),
    };
    if drop_project || drop_local {
        let layers = read_layers(roots);
        let layer = |s: Source| {
            layers
                .iter()
                .find(|l| l.source == s)
                .and_then(|l| l.value.as_object())
        };
        let mut effective = Map::new();
        for s in [Source::Personal, Source::Project, Source::ProjectLocal] {
            if let Some(o) = layer(s) {
                merge_settings(&mut effective, o);
            }
        }
        let mut carried = Map::new();
        for (s, dropped) in [
            (Source::Project, drop_project),
            (Source::ProjectLocal, drop_local),
        ] {
            if let (true, Some(o)) = (dropped, layer(s)) {
                let mut o = o.clone();
                strip_off_hooks(&mut o, s, &off_hooks);
                merge_settings(&mut carried, &o);
            }
        }
        pin_scalars(&mut carried, &effective);
        // What the switches change wins over what the dropped layers said.
        merge_settings(&mut carried, &out.settings);
        out.settings = carried;
    }
    if drop_project {
        let claude = roots.workdir.join(".claude");
        let mut plugin = Vec::new();
        for folder in ["skills", "agents", "commands"] {
            for rel in files_under(&claude.join(folder)) {
                let source = rebase(&claude.join(folder).join(&rel), &roots.workdir, run_dir);
                plugin.push((source, Path::new(folder).join(rel)));
            }
        }
        out.carry = Some(Carry {
            mcp: project_servers(&roots.workdir, &off_project_servers),
            plugin,
            add_dir: Some(run_dir.to_path_buf()),
            env: vec![ADD_DIR_MD_ENV],
        });
    }
    out
}

/// Combine settings layers the way Claude does: objects merge key by key, arrays
/// concatenate with duplicates removed, scalars take `over`.
pub fn merge_settings(base: &mut Map<String, Value>, over: &Map<String, Value>) {
    for (k, v) in over {
        match (base.get_mut(k), v) {
            (Some(Value::Object(b)), Value::Object(o)) => merge_settings(b, o),
            (Some(Value::Array(b)), Value::Array(o)) => {
                for item in o {
                    if !b.contains(item) {
                        b.push(item.clone());
                    }
                }
            }
            _ => {
                base.insert(k.clone(), v.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::given::{item_id, resolve, ItemKind, ResolveOptions, ResolvedItem, Source};
    use serde_json::json;
    use std::fs;
    use std::path::Path;

    fn roots(dir: &Path) -> ResolveRoots {
        ResolveRoots {
            home: dir.join("home"),
            workdir: dir.join("work"),
            managed_settings: dir.join("managed").join("managed-settings.json"),
            claude_json: dir.join("home").join(".claude.json"),
        }
    }

    fn spec_for(r: &ResolveRoots) -> RunSpec {
        RunSpec {
            workdir: r.workdir.to_string_lossy().into_owned(),
            ..RunSpec::default()
        }
    }

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn row(
        kind: ItemKind,
        source: Source,
        key: &str,
        path: Option<&str>,
        off: bool,
    ) -> ResolvedItem {
        ResolvedItem {
            id: item_id(kind, source, key),
            kind,
            source,
            name: key.to_string(),
            detail: String::new(),
            path: path.map(str::to_string),
            brought_by: None,
            lock: None,
            off,
            goes_off_with: Vec::new(),
        }
    }

    /// A `Resolved` with the given items; the rest comes from an empty machine.
    fn with_items(dir: &Path, items: Vec<ResolvedItem>) -> (RunSpec, Resolved, ResolveRoots) {
        let r = roots(dir);
        let spec = spec_for(&r);
        let mut resolved = resolve(&spec, &r, &ResolveOptions::default());
        resolved.items = items;
        (spec, resolved, r)
    }

    fn run(spec: &RunSpec, resolved: &Resolved, r: &ResolveRoots) -> Applied {
        apply(spec, resolved, r, &r.workdir)
    }

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn nothing_off_yields_an_empty_applied() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                row(ItemKind::Skill, Source::RunSpec, "triage", None, false),
                row(ItemKind::ToolServer, Source::Personal, "a", None, false),
            ],
        );
        assert_eq!(run(&spec, &resolved, &r), Applied::default());
    }

    #[test]
    fn a_run_spec_skill_or_plugin_goes_to_kit_skip() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                row(ItemKind::Skill, Source::RunSpec, "triage", None, true),
                row(ItemKind::Plugin, Source::RunSpec, "kata", None, true),
                row(ItemKind::Skill, Source::RunSpec, "kept", None, false),
            ],
        );
        let want = Applied {
            kit_skip: ["triage".to_string(), "kata".to_string()].into(),
            ..Applied::default()
        };
        assert_eq!(run(&spec, &resolved, &r), want);
    }

    #[test]
    fn an_installed_plugin_is_disabled_in_enabled_plugins() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                row(
                    ItemKind::Plugin,
                    Source::Personal,
                    "ai-sdlc@ai-sdlc",
                    None,
                    true,
                ),
                row(ItemKind::Plugin, Source::Project, "p@m", None, true),
                row(ItemKind::Plugin, Source::ProjectLocal, "l@m", None, true),
                row(ItemKind::Plugin, Source::Personal, "kept@m", None, false),
            ],
        );
        let want = Applied {
            settings: obj(json!({"enabledPlugins": {
                "ai-sdlc@ai-sdlc": false, "p@m": false, "l@m": false
            }})),
            ..Applied::default()
        };
        assert_eq!(run(&spec, &resolved, &r), want);
    }

    #[test]
    fn a_file_instruction_is_excluded_by_its_forward_slash_path() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                row(
                    ItemKind::Instruction,
                    Source::Project,
                    "CLAUDE.md",
                    Some(r"D:\ws\CLAUDE.md"),
                    true,
                ),
                row(
                    ItemKind::Instruction,
                    Source::Personal,
                    "CLAUDE.md",
                    Some("/home/u/.claude/CLAUDE.md"),
                    true,
                ),
                row(
                    ItemKind::Instruction,
                    Source::Project,
                    ".claude/rules/x.md",
                    Some("/ws/.claude/rules/x.md"),
                    false,
                ),
            ],
        );
        let want = Applied {
            settings: obj(
                json!({"claudeMdExcludes": ["D:/ws/CLAUDE.md", "/home/u/.claude/CLAUDE.md"]}),
            ),
            ..Applied::default()
        };
        assert_eq!(run(&spec, &resolved, &r), want);
    }

    #[test]
    fn an_output_style_is_set_back_to_default() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![row(
                ItemKind::Instruction,
                Source::Project,
                "output-style",
                None,
                true,
            )],
        );
        let want = Applied {
            settings: obj(json!({"outputStyle": "default"})),
            ..Applied::default()
        };
        assert_eq!(run(&spec, &resolved, &r), want);
    }

    #[test]
    fn the_run_specs_system_prompt_is_dropped() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![row(
                ItemKind::Instruction,
                Source::RunSpec,
                "system-prompt",
                None,
                true,
            )],
        );
        let want = Applied {
            drop_system_prompt: true,
            ..Applied::default()
        };
        assert_eq!(run(&spec, &resolved, &r), want);
    }

    use crate::given::{hook_key, LockReason};

    const ADD_DIR_ENV: (&str, &str) = ("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", "1");

    fn entry(cmd: &str) -> Value {
        json!({"matcher": "Bash", "hooks": [{"type": "command", "command": cmd}]})
    }

    fn hook_row(source: Source, cmd: &str, off: bool) -> ResolvedItem {
        row(
            ItemKind::Hook,
            source,
            &hook_key("PreToolUse", Some("Bash"), cmd),
            None,
            off,
        )
    }

    fn locked(mut item: ResolvedItem) -> ResolvedItem {
        item.lock = Some(LockReason::Unswitchable {
            text: "fixed".into(),
        });
        item
    }

    /// Project hooks `a` and `b`, local hook `c`, written under the workdir.
    fn project_with_hooks(r: &ResolveRoots) {
        write(
            &r.workdir.join(".claude/settings.json"),
            &json!({"model": "haiku", "hooks": {"PreToolUse": [entry("a"), entry("b")]}})
                .to_string(),
        );
        write(
            &r.workdir.join(".claude/settings.local.json"),
            &json!({"env": {"X": "1"}, "hooks": {"PreToolUse": [entry("c")]}}).to_string(),
        );
    }

    fn project_carry(run_dir: &Path) -> Option<Carry> {
        Some(Carry {
            add_dir: Some(run_dir.to_path_buf()),
            env: vec![ADD_DIR_ENV],
            ..Carry::default()
        })
    }

    #[test]
    fn a_tool_server_off_is_denied_by_name_and_no_strict_file_is_written() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                row(ItemKind::ToolServer, Source::Personal, "a", None, true),
                row(ItemKind::ToolServer, Source::Project, "b", None, true),
                row(ItemKind::ToolServer, Source::ProjectLocal, "c", None, true),
                row(ItemKind::ToolServer, Source::Personal, "kept", None, false),
            ],
        );
        let want = Applied {
            settings: obj(json!({"deniedMcpServers": [
                {"serverName": "a"}, {"serverName": "b"}, {"serverName": "c"}
            ]})),
            ..Applied::default()
        };
        assert_eq!(run(&spec, &resolved, &r), want);
    }

    #[test]
    fn no_hook_off_drops_no_source() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                hook_row(Source::Project, "a", false),
                hook_row(Source::ProjectLocal, "c", false),
            ],
        );
        project_with_hooks(&r);
        assert_eq!(run(&spec, &resolved, &r), Applied::default());
    }

    #[test]
    fn a_project_hook_off_drops_the_project_source_and_carries_it_over() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                hook_row(Source::Project, "a", true),
                hook_row(Source::Project, "b", false),
                hook_row(Source::ProjectLocal, "c", false),
            ],
        );
        project_with_hooks(&r);
        let run_dir = td.path().join("run");
        let want = Applied {
            setting_sources: Some(vec!["user", "local"]),
            settings: obj(json!({"model": "haiku", "hooks": {"PreToolUse": [entry("b")]}})),
            carry: project_carry(&run_dir),
            ..Applied::default()
        };
        assert_eq!(apply(&spec, &resolved, &r, &run_dir), want);
    }

    #[test]
    fn a_local_hook_off_drops_the_local_source_and_carries_only_its_settings() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                hook_row(Source::Project, "a", false),
                hook_row(Source::ProjectLocal, "c", true),
            ],
        );
        project_with_hooks(&r);
        let want = Applied {
            setting_sources: Some(vec!["user", "project"]),
            settings: obj(json!({"env": {"X": "1"}})),
            ..Applied::default()
        };
        assert_eq!(run(&spec, &resolved, &r), want);
    }

    #[test]
    fn both_hooks_off_drop_both_sources_and_carry_both_over() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                hook_row(Source::Project, "a", true),
                hook_row(Source::Project, "b", false),
                hook_row(Source::ProjectLocal, "c", true),
            ],
        );
        project_with_hooks(&r);
        let run_dir = td.path().join("run");
        let want = Applied {
            setting_sources: Some(vec!["user"]),
            settings: obj(json!({
                "model": "haiku",
                "env": {"X": "1"},
                "hooks": {"PreToolUse": [entry("b")]}
            })),
            carry: project_carry(&run_dir),
            ..Applied::default()
        };
        assert_eq!(apply(&spec, &resolved, &r, &run_dir), want);
    }

    #[test]
    fn a_re_routed_scalar_keeps_the_effective_value() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                hook_row(Source::Project, "a", true),
                hook_row(Source::Project, "b", false),
            ],
        );
        write(
            &r.home.join(".claude/settings.json"),
            &json!({"model": "opus"}).to_string(),
        );
        write(
            &r.workdir.join(".claude/settings.json"),
            &json!({
                "model": "haiku",
                "env": {"K": "project"},
                "hooks": {"PreToolUse": [entry("a"), entry("b")]}
            })
            .to_string(),
        );
        write(
            &r.workdir.join(".claude/settings.local.json"),
            &json!({"model": "sonnet", "env": {"K": "local"}}).to_string(),
        );
        let applied = run(&spec, &resolved, &r);
        assert_eq!(
            Value::Object(applied.settings),
            json!({
                "model": "sonnet",
                "env": {"K": "local"},
                "hooks": {"PreToolUse": [entry("b")]}
            })
        );
    }

    fn project_with_files(r: &ResolveRoots) {
        project_with_hooks(r);
        let w = &r.workdir;
        write(&w.join(".claude/skills/projskill/SKILL.md"), "skill");
        write(&w.join(".claude/skills/projskill/ref/notes.md"), "notes");
        write(&w.join(".claude/agents/projagent.md"), "agent");
        write(&w.join(".claude/commands/projcmd.md"), "command");
        write(
            &w.join(".mcp.json"),
            &json!({"mcpServers": {
                "srv-a": {"command": "a", "env": {"K": "secret"}},
                "srv-b": {"command": "b"}
            }})
            .to_string(),
        );
    }

    #[test]
    fn carrying_the_project_over_lists_its_skills_agents_and_commands_and_its_mcp_json_servers() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(td.path(), vec![hook_row(Source::Project, "a", true)]);
        project_with_files(&r);
        let run_dir = td.path().join("run");
        let carry = apply(&spec, &resolved, &r, &run_dir).carry.unwrap();
        let pair = |src: &str, dest: &[&str]| {
            (
                run_dir.join(".claude").join(src),
                dest.iter().collect::<PathBuf>(),
            )
        };
        assert_eq!(
            carry.plugin,
            vec![
                pair(
                    "skills/projskill/SKILL.md",
                    &["skills", "projskill", "SKILL.md"]
                ),
                pair(
                    "skills/projskill/ref/notes.md",
                    &["skills", "projskill", "ref", "notes.md"]
                ),
                pair("agents/projagent.md", &["agents", "projagent.md"]),
                pair("commands/projcmd.md", &["commands", "projcmd.md"]),
            ]
        );
        assert_eq!(
            carry.mcp,
            Some(json!({"mcpServers": {
                "srv-a": {"command": "a", "env": {"K": "secret"}},
                "srv-b": {"command": "b"}
            }}))
        );
        assert_eq!(carry.add_dir, Some(run_dir));
        assert_eq!(carry.env, vec![ADD_DIR_ENV]);
    }

    #[test]
    fn a_carried_over_server_that_is_switched_off_is_not_carried() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                hook_row(Source::Project, "a", true),
                row(ItemKind::ToolServer, Source::Project, "srv-b", None, true),
            ],
        );
        project_with_files(&r);
        let applied = run(&spec, &resolved, &r);
        assert_eq!(
            applied.carry.unwrap().mcp,
            Some(json!({"mcpServers": {"srv-a": {"command": "a", "env": {"K": "secret"}}}}))
        );
        assert_eq!(
            applied.settings["deniedMcpServers"],
            json!([{"serverName": "srv-b"}])
        );
    }

    #[test]
    fn paths_are_rewritten_under_the_folder_claude_runs_in() {
        let td = tempfile::tempdir().unwrap();
        let r = roots(td.path());
        let inside = r.workdir.join("CLAUDE.md");
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                hook_row(Source::Project, "a", true),
                row(
                    ItemKind::Instruction,
                    Source::Project,
                    "CLAUDE.md",
                    Some(&inside.to_string_lossy()),
                    true,
                ),
                row(
                    ItemKind::Instruction,
                    Source::Personal,
                    "CLAUDE.md",
                    Some("/home/u/.claude/CLAUDE.md"),
                    true,
                ),
            ],
        );
        project_with_files(&r);
        let run_dir = td.path().join("wt");
        let applied = apply(&spec, &resolved, &r, &run_dir);
        let moved = run_dir
            .join("CLAUDE.md")
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(
            applied.settings["claudeMdExcludes"],
            json!([moved, "/home/u/.claude/CLAUDE.md"])
        );
        let carry = applied.carry.unwrap();
        assert_eq!(carry.add_dir, Some(run_dir.clone()));
        assert!(!carry.plugin.is_empty());
        assert!(carry
            .plugin
            .iter()
            .all(|(src, _)| src.starts_with(&run_dir)));
    }

    #[test]
    fn an_item_locked_by_the_lock_table_is_never_applied_even_if_listed_off() {
        let td = tempfile::tempdir().unwrap();
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                locked(row(ItemKind::Plugin, Source::Personal, "p@m", None, true)),
                locked(hook_row(Source::Project, "a", true)),
                locked(row(ItemKind::ToolServer, Source::Personal, "s", None, true)),
                locked(row(ItemKind::Plugin, Source::RunSpec, "kata", None, true)),
                locked(row(
                    ItemKind::Instruction,
                    Source::RunSpec,
                    "system-prompt",
                    None,
                    true,
                )),
            ],
        );
        project_with_hooks(&r);
        assert_eq!(run(&spec, &resolved, &r), Applied::default());
    }

    #[test]
    fn an_item_that_goes_off_with_a_hook_is_not_applied_on_its_own() {
        let td = tempfile::tempdir().unwrap();
        let hook = hook_row(Source::Project, "a", false);
        let mut nested = row(
            ItemKind::Instruction,
            Source::Project,
            "sub/CLAUDE.md",
            Some("/ws/sub/CLAUDE.md"),
            true,
        );
        nested.goes_off_with = vec![hook.id.clone()];
        let (spec, resolved, r) = with_items(td.path(), vec![hook, nested]);
        project_with_hooks(&r);
        assert_eq!(run(&spec, &resolved, &r), Applied::default());
    }

    #[test]
    fn carried_name_prefixes_the_carry_plugin() {
        assert_eq!(CARRY_PLUGIN, "kata-proj");
        assert_eq!(carried_name("projskill"), "kata-proj:projskill");
    }

    #[test]
    fn a_missing_id_is_ignored() {
        let td = tempfile::tempdir().unwrap();
        let (spec, mut resolved, r) = with_items(
            td.path(),
            vec![row(ItemKind::Plugin, Source::RunSpec, "gone", None, true)],
        );
        resolved.missing = vec![item_id(ItemKind::Plugin, Source::RunSpec, "gone")];
        assert_eq!(run(&spec, &resolved, &r), Applied::default());
    }

    #[test]
    fn merge_settings_concatenates_hook_lists_and_permission_lists() {
        let mut base = obj(json!({
            "model": "haiku",
            "env": {"A": "1"},
            "hooks": {"PreToolUse": [{"matcher": "Bash"}]},
            "permissions": {"allow": ["Read", "Bash(ls)"], "deny": []}
        }));
        let over = obj(json!({
            "model": "sonnet",
            "env": {"B": "2"},
            "hooks": {"PreToolUse": [{"matcher": "Bash"}, {"matcher": "Edit"}], "Stop": [1]},
            "permissions": {"allow": ["Bash(ls)", "Edit"], "deny": ["Write"]}
        }));
        merge_settings(&mut base, &over);
        assert_eq!(
            Value::Object(base),
            json!({
                "model": "sonnet",
                "env": {"A": "1", "B": "2"},
                "hooks": {"PreToolUse": [{"matcher": "Bash"}, {"matcher": "Edit"}], "Stop": [1]},
                "permissions": {"allow": ["Read", "Bash(ls)", "Edit"], "deny": ["Write"]}
            })
        );
    }
}
