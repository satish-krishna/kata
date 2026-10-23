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
/// `docs/switch-proofs.md`. A personal hook and the skills on disk stay out
/// (a personal hook cannot be re-supplied without editing the setup; a deny rule
/// refuses a skill without removing it). `Organization` and `Kata` never appear.
/// A project hook is listed here and locked only in a build run (the lock table).
pub const SWITCHABLE: &[(ItemKind, Source)] = &[
    // Always: Kata builds these itself, so leaving one out needs no proof.
    (ItemKind::Skill, Source::RunSpec),
    (ItemKind::Plugin, Source::RunSpec),
    (ItemKind::Instruction, Source::RunSpec),
    // Proof: proof_plugin_enabled_false (and proof_resupply_user_plugins for
    // the personal source).
    (ItemKind::Plugin, Source::Personal),
    (ItemKind::Plugin, Source::Project),
    (ItemKind::Plugin, Source::ProjectLocal),
    // Proof: proof_claude_md_excludes and proof_output_style_default.
    (ItemKind::Instruction, Source::Personal),
    (ItemKind::Instruction, Source::Project),
    (ItemKind::Instruction, Source::ProjectLocal),
    // Proof: proof_combined_carry_over.
    (ItemKind::Hook, Source::Project),
    (ItemKind::Hook, Source::ProjectLocal),
    // Proof: proof_deny_mcp_server_in_settings (project) and
    // proof_deny_personal_and_local_servers (personal, local).
    (ItemKind::ToolServer, Source::Personal),
    (ItemKind::ToolServer, Source::Project),
    (ItemKind::ToolServer, Source::ProjectLocal),
];

impl ItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Hook => "hook",
            ItemKind::Skill => "skill",
            ItemKind::Plugin => "plugin",
            ItemKind::Instruction => "instruction",
            ItemKind::ToolServer => "tool-server",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        [
            ItemKind::Hook,
            ItemKind::Skill,
            ItemKind::Plugin,
            ItemKind::Instruction,
            ItemKind::ToolServer,
        ]
        .into_iter()
        .find(|k| k.as_str() == s)
    }
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Personal => "personal",
            Source::Project => "project",
            Source::ProjectLocal => "project-local",
            Source::Plugin => "plugin",
            Source::Organization => "organization",
            Source::Kata => "kata",
            Source::RunSpec => "run-spec",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        [
            Source::Personal,
            Source::Project,
            Source::ProjectLocal,
            Source::Plugin,
            Source::Organization,
            Source::Kata,
            Source::RunSpec,
        ]
        .into_iter()
        .find(|k| k.as_str() == s)
    }
}

/// FNV-1a, 64 bit. Written by hand because `DefaultHasher` is not stable across
/// Rust releases and a saved job must keep matching.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// The key of a hook: `<event>:<matcher or *>:<fnv1a64 of the command, 16 hex
/// digits>`. The command itself is never stored, so a secret in it never reaches
/// a saved job.
pub fn hook_key(event: &str, matcher: Option<&str>, command: &str) -> String {
    let matcher = matcher.filter(|m| !m.is_empty()).unwrap_or("*");
    format!("{event}:{matcher}:{:016x}", fnv1a64(command.as_bytes()))
}

/// `<source>:<kind>:<key>`.
pub fn item_id(kind: ItemKind, source: Source, key: &str) -> String {
    format!("{}:{}:{key}", source.as_str(), kind.as_str())
}

/// Split an identity back into its parts. The key may itself contain colons.
pub fn parse_item_id(id: &str) -> Result<ItemRef, String> {
    let mut parts = id.splitn(3, ':');
    let (source, kind, key) = match (parts.next(), parts.next(), parts.next()) {
        (Some(s), Some(k), Some(key)) => (s, k, key),
        _ => return Err(format!("'{id}' is not '<source>:<kind>:<key>'")),
    };
    let source =
        Source::parse(source).ok_or_else(|| format!("'{id}': unknown source '{source}'"))?;
    let kind = ItemKind::parse(kind).ok_or_else(|| format!("'{id}': unknown kind '{kind}'"))?;
    if key.is_empty() {
        return Err(format!("'{id}': the key is empty"));
    }
    Ok(ItemRef {
        kind,
        source,
        key: key.to_string(),
    })
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
        assert_eq!(k, "PreToolUse:Bash:5b5b6626bd2df6ba");
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
