//! How a switched-off item is kept from Claude. Pure in the sense that matters:
//! it builds values and writes nothing. It reads the tool server files named by
//! the resolved items, because their definitions are never carried in `Resolved`
//! (they hold secrets).

use super::{ResolveRoots, Resolved};
use crate::spec::RunSpec;
use serde_json::{Map, Value};
use std::collections::BTreeSet;

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

pub fn apply(_spec: &RunSpec, _resolved: &Resolved, _roots: &ResolveRoots) -> Applied {
    Applied::default()
}

/// Combine settings layers the way Claude does: objects merge key by key, arrays
/// concatenate with duplicates removed, scalars take `over`.
pub fn merge_settings(_base: &mut Map<String, Value>, _over: &Map<String, Value>) {}

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
