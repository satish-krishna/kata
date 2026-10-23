//! How a switched-off item is kept from Claude. Pure in the sense that matters:
//! it builds values and writes nothing. It reads the tool server files named by
//! the resolved items, because their definitions are never carried in `Resolved`
//! (they hold secrets).

use super::{
    items, parse_item_id, ItemKind, ResolveRoots, Resolved, ResolvedItem, Source, SWITCHABLE,
};
use crate::spec::RunSpec;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// The name of the plugin Kata generates to hand a dropped project's skills,
/// agents and commands back to Claude.
pub const CARRY_PLUGIN: &str = "kata-proj";

/// How Claude names a carried-over project skill, agent or command.
pub fn carried_name(_name: &str) -> String {
    String::new()
}

/// What a dropped settings source hands back by other routes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Carry {
    /// `{ "mcpServers": { ... } }`, passed without `--strict-mcp-config`.
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
    /// `claudeMdExcludes`, `outputStyle`).
    pub settings: Map<String, Value>,
    /// Always `None` for now: hooks and on-disk skills ship locked, so no
    /// settings source is ever dropped (docs/switch-proofs.md).
    pub setting_sources: Option<Vec<&'static str>>,
    /// `{ "mcpServers": { ... } }` holding every kept server, present only when
    /// a tool server is off. The caller adds Kata's own entry and passes
    /// `--strict-mcp-config`.
    pub mcp: Option<Value>,
    /// What a dropped settings source hands back by other routes.
    pub carry: Option<Carry>,
    /// The run-spec's system prompt is switched off.
    pub drop_system_prompt: bool,
}

/// A source's own tool server table, read from the file the item names.
fn server_definition(
    file: &Value,
    source: Source,
    name: &str,
    roots: &ResolveRoots,
) -> Option<Value> {
    let servers = match source {
        Source::ProjectLocal => {
            let want = items::norm(&roots.workdir.to_string_lossy());
            file.get("projects")?
                .as_object()?
                .iter()
                .find(|(k, _)| items::norm(k) == want)?
                .1
                .get("mcpServers")?
        }
        _ => file.get("mcpServers")?,
    };
    servers.get(name).cloned()
}

/// The kept tool servers of every source that Claude reads from a file Kata can
/// copy from, verbatim. Plugin tool servers are not copied: Claude names them
/// `plugin:<plugin>:<server>` and expands `${CLAUDE_PLUGIN_ROOT}` for them, which
/// a copy under a plain name would lose.
fn kept_servers(resolved: &Resolved, roots: &ResolveRoots) -> Value {
    let rank = |s: Source| match s {
        Source::Personal => 0,
        Source::Project => 1,
        Source::ProjectLocal => 2,
        _ => 3,
    };
    let mut kept: Vec<&ResolvedItem> = resolved
        .items
        .iter()
        .filter(|i| i.kind == ItemKind::ToolServer && !i.off && i.brought_by.is_none())
        .filter(|i| {
            matches!(
                i.source,
                Source::Personal | Source::Project | Source::ProjectLocal | Source::Organization
            )
        })
        .collect();
    // Later wins, in Claude's order: personal, project, project-local.
    kept.sort_by_key(|i| rank(i.source));
    let mut files: BTreeMap<String, Option<Value>> = BTreeMap::new();
    let mut servers = Map::new();
    for i in kept {
        let Some(path) = i.path.as_ref() else {
            continue;
        };
        let file = files.entry(path.clone()).or_insert_with(|| {
            std::fs::read_to_string(path)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
        });
        if let Some(def) = file
            .as_ref()
            .and_then(|f| server_definition(f, i.source, &i.name, roots))
        {
            servers.insert(i.name.clone(), def);
        }
    }
    json!({ "mcpServers": servers })
}

pub fn apply(
    _spec: &RunSpec,
    resolved: &Resolved,
    roots: &ResolveRoots,
    _run_dir: &Path,
) -> Applied {
    let mut out = Applied::default();
    let missing: BTreeSet<&str> = resolved.missing.iter().map(String::as_str).collect();
    let mut any_server_off = false;
    let mut enabled = Map::new();
    let mut excludes: Vec<Value> = Vec::new();
    for i in &resolved.items {
        // Only what a switch can reach: a hook, an on-disk skill, and anything
        // brought by a plugin or owned by the organization or Kata never counts.
        if !i.off
            || i.brought_by.is_some()
            || missing.contains(i.id.as_str())
            || !SWITCHABLE.contains(&(i.kind, i.source))
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
            (ItemKind::Plugin, _) => {
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
                    excludes.push(Value::String(p.replace('\\', "/")));
                }
            }
            (ItemKind::ToolServer, _) => any_server_off = true,
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
    if any_server_off {
        // A server that is off is left out by not being copied.
        out.mcp = Some(kept_servers(resolved, roots));
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
