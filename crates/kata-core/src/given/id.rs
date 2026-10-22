//! Item identity: `<source>:<kind>:<key>`, stable across runs and machines.

use serde::{Deserialize, Serialize};

/// The kind of thing a run starts with that can be switched off.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "kebab-case"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ItemKind {
    Hook,
    Skill,
    Plugin,
    Instruction,
    ToolServer,
}

/// Where an item comes from. `ProjectLocal` is `.claude/settings.local.json`,
/// `CLAUDE.local.md` and the local MCP scope in `~/.claude.json`; it displays as
/// "project" but keeps its own identity.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "kebab-case"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Personal,
    Project,
    ProjectLocal,
    Plugin,
    Organization,
    Kata,
    RunSpec,
}

/// A parsed item identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemRef {
    pub kind: ItemKind,
    pub source: Source,
    pub key: String,
}

/// The `(kind, source)` pairs a run can switch off, as proven in
/// `docs/switch-proofs.md`. Hooks and skills on disk are locked because of that
/// document's findings (dropping a settings source also drops its instructions,
/// skills, tool servers and plugins; a deny rule refuses a skill without removing
/// it). `Organization` and `Kata` never appear.
pub const SWITCHABLE: &[(ItemKind, Source)] = &[];

pub fn fnv1a64(_bytes: &[u8]) -> u64 {
    0
}

pub fn hook_key(_event: &str, _matcher: Option<&str>, _command: &str) -> String {
    String::new()
}

pub fn item_id(_kind: ItemKind, _source: Source, _key: &str) -> String {
    String::new()
}

pub fn parse_item_id(_id: &str) -> Result<ItemRef, String> {
    Err("todo".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: [ItemKind; 5] = [
        ItemKind::Hook,
        ItemKind::Skill,
        ItemKind::Plugin,
        ItemKind::Instruction,
        ItemKind::ToolServer,
    ];
    const SOURCES: [Source; 7] = [
        Source::Personal,
        Source::Project,
        Source::ProjectLocal,
        Source::Plugin,
        Source::Organization,
        Source::Kata,
        Source::RunSpec,
    ];

    #[test]
    fn item_id_and_parse_item_id_round_trip_for_every_kind_and_source() {
        for kind in KINDS {
            for source in SOURCES {
                // Keys with colons and slashes, like a hook or a rules file.
                for key in ["name", "PreToolUse:Bash:00ff", ".claude/rules/x.md"] {
                    let id = item_id(kind, source, key);
                    let r = parse_item_id(&id).unwrap();
                    assert_eq!(
                        r,
                        ItemRef {
                            kind,
                            source,
                            key: key.into()
                        },
                        "{id}"
                    );
                }
            }
        }
        assert_eq!(
            item_id(
                ItemKind::Instruction,
                Source::ProjectLocal,
                "CLAUDE.local.md"
            ),
            "project-local:instruction:CLAUDE.local.md"
        );
        assert_eq!(
            item_id(ItemKind::ToolServer, Source::RunSpec, "srv"),
            "run-spec:tool-server:srv"
        );
        assert!(parse_item_id("nope").is_err());
        assert!(parse_item_id("bogus:hook:x").is_err());
        assert!(parse_item_id("personal:bogus:x").is_err());
        assert!(parse_item_id("personal:hook:").is_err());
    }

    #[test]
    fn a_hook_id_is_stable_across_runs_and_differs_by_command() {
        // FNV-1a 64 known vectors.
        assert_eq!(fnv1a64(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a64(b"a"), 0xaf63dc4c8601ec8c);
        let k = hook_key("PreToolUse", Some("Bash"), "node check.js");
        assert_eq!(k, "PreToolUse:Bash:PINNED");
        assert_ne!(k, hook_key("PreToolUse", Some("Bash"), "node other.js"));
        assert!(hook_key("Stop", None, "x").starts_with("Stop:*:"));
    }

    #[test]
    fn a_hook_id_never_contains_the_command() {
        let id = item_id(
            ItemKind::Hook,
            Source::Project,
            &hook_key("PreToolUse", Some("Bash"), "curl -H 'token: s3cret' x"),
        );
        assert!(!id.contains("s3cret") && !id.contains("curl"));
        assert_eq!(id.rsplit(':').next().unwrap().len(), 16);
    }
}
