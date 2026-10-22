//! Whether an item is locked on for one run, and why. The frontend reads the
//! answer from `Resolved.items[].lock` and never decides a lock itself.

use super::resolve::ResolveOptions;
use super::{ItemFacts, ItemKind, Source};
use serde::Serialize;

pub const REASON_KATA: &str = "the run needs it to ask you questions";
pub const REASON_REQUIRED: &str = "AI-SDLC runs work through this plugin";
pub const REASON_ORGANIZATION: &str = "set by your organization";
pub const REASON_UNSWITCHABLE: &str =
    "Kata cannot switch this off for one run without editing your setup";

/// Why an item is locked on. Every variant but `FollowsPlugin` carries the
/// one-line reason text the row shows.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "kebab-case", tag = "kind"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LockReason {
    /// Kata's own tool server or standing note.
    Kata { text: String },
    /// A plugin the mode requires, or an item it brings.
    Required { text: String },
    /// Set by the organization's managed settings.
    Organization { text: String },
    /// No mechanism switches this kind and source off for one run.
    Unswitchable { text: String },
    /// Brought by a plugin that is not required: no switch of its own, the row
    /// shows its plugin's state. `plugin` is the plugin's item identity.
    FollowsPlugin { plugin: String },
}

impl LockReason {
    /// The reason line, `None` for a follower.
    pub fn text(&self) -> Option<&str> {
        match self {
            LockReason::Kata { text }
            | LockReason::Required { text }
            | LockReason::Organization { text }
            | LockReason::Unswitchable { text } => Some(text),
            LockReason::FollowsPlugin { .. } => None,
        }
    }
}

/// The name of a plugin from its item key (`<name>@<marketplace>` or `<name>`).
fn plugin_name(key: &str) -> &str {
    key.split('@').next().unwrap_or(key)
}

/// The plugin name an item id refers to, when the id is a plugin's.
fn plugin_name_of_id(id: &str) -> Option<String> {
    let r = super::parse_item_id(id).ok()?;
    (r.kind == ItemKind::Plugin).then(|| plugin_name(&r.key).to_string())
}

/// Decide the lock, first matching row of the table winning.
pub fn lock_for(item: &ItemFacts, opts: &ResolveOptions) -> Option<LockReason> {
    let text = |s: &str| s.to_string();
    // Rows 1 and 2.
    if item.source == Source::Kata
        && matches!(item.kind, ItemKind::ToolServer | ItemKind::Instruction)
    {
        return Some(LockReason::Kata {
            text: text(REASON_KATA),
        });
    }
    // Row 3: a required plugin, or an item it brings.
    let required = |name: &str| opts.required_plugins.iter().any(|r| r == name);
    let own_plugin = (item.kind == ItemKind::Plugin)
        .then(|| super::parse_item_id(&item.id).ok())
        .flatten()
        .map(|r| plugin_name(&r.key).to_string());
    let bringer = item.brought_by.as_deref().and_then(plugin_name_of_id);
    if own_plugin.is_some_and(|n| required(&n)) || bringer.is_some_and(|n| required(&n)) {
        return Some(LockReason::Required {
            text: text(REASON_REQUIRED),
        });
    }
    // Row 4.
    if item.source == Source::Organization {
        return Some(LockReason::Organization {
            text: text(REASON_ORGANIZATION),
        });
    }
    // Row 5.
    if let Some(plugin) = &item.brought_by {
        return Some(LockReason::FollowsPlugin {
            plugin: plugin.clone(),
        });
    }
    // Rows 6 and 7.
    if super::SWITCHABLE.contains(&(item.kind, item.source)) {
        None
    } else {
        Some(LockReason::Unswitchable {
            text: text(REASON_UNSWITCHABLE),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::given::item_id;

    fn facts(kind: ItemKind, source: Source, key: &str, brought_by: Option<&str>) -> ItemFacts {
        ItemFacts {
            id: item_id(kind, source, key),
            kind,
            source,
            name: key.to_string(),
            detail: String::new(),
            path: None,
            brought_by: brought_by.map(str::to_string),
            repo_relative: false,
        }
    }

    fn sdlc() -> ResolveOptions {
        ResolveOptions {
            required_plugins: vec!["ai-sdlc".to_string()],
        }
    }

    #[test]
    fn lock_for_decides_every_row_of_the_lock_table() {
        use ItemKind as K;
        use Source as S;
        let none = ResolveOptions::default();
        let kata = Some(LockReason::Kata {
            text: "the run needs it to ask you questions".into(),
        });

        // Row 1: Kata's own tool server.
        let r1 = facts(K::ToolServer, S::Kata, "kata-ask", None);
        assert_eq!(lock_for(&r1, &none), kata);
        // Row 2: Kata's standing note.
        let r2 = facts(K::Instruction, S::Kata, "standing-note", None);
        assert_eq!(lock_for(&r2, &none), kata);
        // Row 3: the required plugin, installed and in the kit, and what it brings.
        let required = Some(LockReason::Required {
            text: "AI-SDLC runs work through this plugin".into(),
        });
        let r3a = facts(K::Plugin, S::Personal, "ai-sdlc@mkt", None);
        assert_eq!(lock_for(&r3a, &sdlc()), required);
        let r3b = facts(K::Plugin, S::RunSpec, "ai-sdlc", None);
        assert_eq!(lock_for(&r3b, &sdlc()), required);
        let r3c = facts(
            K::Skill,
            S::Plugin,
            "ai-sdlc@mkt:build",
            Some("personal:plugin:ai-sdlc@mkt"),
        );
        assert_eq!(lock_for(&r3c, &sdlc()), required);
        // Without the option the same plugin is an ordinary switchable item.
        assert_eq!(lock_for(&r3a, &none), None);
        // A different plugin with a similar name is not the required one.
        let r3d = facts(K::Plugin, S::Personal, "ai-sdlc-extra@mkt", None);
        assert_eq!(lock_for(&r3d, &sdlc()), None);
        // Row 3 beats row 4: a required plugin set by the organization.
        let r3e = facts(K::Plugin, S::Organization, "ai-sdlc@mkt", None);
        assert_eq!(lock_for(&r3e, &sdlc()), required);
        // Row 4: anything the organization sets, whatever its kind.
        let org = Some(LockReason::Organization {
            text: "set by your organization".into(),
        });
        for kind in [K::Hook, K::Skill, K::Plugin, K::Instruction, K::ToolServer] {
            let r4 = facts(kind, S::Organization, "x", None);
            assert_eq!(lock_for(&r4, &none), org, "{kind:?}");
        }
        // Row 5: brought by another plugin; no switch of its own.
        let plugin_id = "personal:plugin:other@mkt";
        let follows = Some(LockReason::FollowsPlugin {
            plugin: plugin_id.into(),
        });
        for kind in [K::Hook, K::Skill, K::ToolServer] {
            let r5 = facts(kind, S::Plugin, "other@mkt:x", Some(plugin_id));
            assert_eq!(lock_for(&r5, &sdlc()), follows, "{kind:?}");
            assert_eq!(lock_for(&r5, &sdlc()).unwrap().text(), None);
        }
        // Row 6: anything else in SWITCHABLE is free.
        let r6 = facts(K::Plugin, S::Project, "p@mkt", None);
        assert_eq!(lock_for(&r6, &none), None);
        let r6b = facts(K::Skill, S::RunSpec, "kit-skill", None);
        assert_eq!(lock_for(&r6b, &none), None);
        let r6c = facts(K::ToolServer, S::ProjectLocal, "srv", None);
        assert_eq!(lock_for(&r6c, &none), None);
        // Row 7: a pair absent from SWITCHABLE (a skill on disk, a hook).
        let unswitchable = Some(LockReason::Unswitchable {
            text: "Kata cannot switch this off for one run without editing your setup".into(),
        });
        let r7 = facts(K::Skill, S::Personal, "own-skill", None);
        assert_eq!(lock_for(&r7, &none), unswitchable);
        let r7b = facts(K::Hook, S::Project, "PreToolUse:Bash:00", None);
        assert_eq!(lock_for(&r7b, &none), unswitchable);
    }
}
