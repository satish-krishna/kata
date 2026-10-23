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

pub fn apply(_spec: &RunSpec, resolved: &Resolved, roots: &ResolveRoots) -> Applied {
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
        assert_eq!(apply(&spec, &resolved, &r), Applied::default());
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
        assert_eq!(apply(&spec, &resolved, &r), want);
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
        assert_eq!(apply(&spec, &resolved, &r), want);
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
        assert_eq!(apply(&spec, &resolved, &r), want);
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
        assert_eq!(apply(&spec, &resolved, &r), want);
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
        assert_eq!(apply(&spec, &resolved, &r), want);
    }

    #[test]
    fn a_switched_off_tool_server_leaves_the_kept_ones_verbatim() {
        let td = tempfile::tempdir().unwrap();
        let r = roots(td.path());
        let work_key = r.workdir.to_string_lossy().replace('\\', "/");
        write(
            &r.claude_json,
            &json!({
                "mcpServers": {
                    "off-personal": {"command": "a"},
                    "keep-personal": {"command": "b", "env": {"K": "secret"}}
                },
                "projects": {work_key: {"mcpServers": {
                    "keep-local": {"type": "http", "url": "https://x"},
                    "off-local": {"command": "c"}
                }}}
            })
            .to_string(),
        );
        write(
            &r.workdir.join(".mcp.json"),
            &json!({"mcpServers": {
                "keep-project": {"command": "d", "args": ["--x"]},
                "off-project": {"command": "e"}
            }})
            .to_string(),
        );
        let mut spec = spec_for(&r);
        spec.auth.bare = false;
        spec.given = Some(crate::spec::Given {
            tool_servers: vec![
                item_id(ItemKind::ToolServer, Source::Personal, "off-personal"),
                item_id(ItemKind::ToolServer, Source::ProjectLocal, "off-local"),
                item_id(ItemKind::ToolServer, Source::Project, "off-project"),
            ],
            ..Default::default()
        });
        let resolved = resolve(&spec, &r, &ResolveOptions::default());
        let want = Applied {
            mcp: Some(json!({"mcpServers": {
                "keep-personal": {"command": "b", "env": {"K": "secret"}},
                "keep-project": {"command": "d", "args": ["--x"]},
                "keep-local": {"type": "http", "url": "https://x"}
            }})),
            ..Applied::default()
        };
        assert_eq!(apply(&spec, &resolved, &r), want);
        // The secret is in the result for the run, never in what the UI reads.
        assert!(!serde_json::to_string(&resolved).unwrap().contains("secret"));
    }

    #[test]
    fn a_hook_or_on_disk_skill_marked_off_is_ignored() {
        let td = tempfile::tempdir().unwrap();
        let mut follower = row(ItemKind::Skill, Source::Plugin, "p@m:s", None, true);
        follower.brought_by = Some("personal:plugin:p@m".into());
        let (spec, resolved, r) = with_items(
            td.path(),
            vec![
                row(
                    ItemKind::Hook,
                    Source::Project,
                    "PreToolUse:Bash:00ff",
                    None,
                    true,
                ),
                row(ItemKind::Skill, Source::Personal, "s", None, true),
                row(ItemKind::Skill, Source::Project, "t", None, true),
                follower,
                row(
                    ItemKind::ToolServer,
                    Source::Organization,
                    "org",
                    None,
                    true,
                ),
            ],
        );
        assert_eq!(apply(&spec, &resolved, &r), Applied::default());
    }

    #[test]
    fn a_missing_id_is_ignored() {
        let td = tempfile::tempdir().unwrap();
        let (spec, mut resolved, r) = with_items(
            td.path(),
            vec![row(ItemKind::Plugin, Source::RunSpec, "gone", None, true)],
        );
        resolved.missing = vec![item_id(ItemKind::Plugin, Source::RunSpec, "gone")];
        assert_eq!(apply(&spec, &resolved, &r), Applied::default());
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
