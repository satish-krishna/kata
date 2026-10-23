//! Whether an item is locked on for one run, and why. The frontend reads the
//! answer from `Resolved.items[].lock` and never decides a lock itself.

use super::resolve::ResolveOptions;
use super::{ItemFacts, ItemKind, Source};
use serde::Serialize;

pub const REASON_KATA: &str = "the run needs it to ask you questions";
pub const REASON_REQUIRED: &str = "AI-SDLC runs work through this plugin";
pub const REASON_ORGANIZATION: &str = "set by your organization";
pub const REASON_BUILD_HOOK: &str =
    "a build keeps the project's hooks, which may guard what it edits";
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
    /// A build keeps the project's hooks.
    Build { text: String },
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
            | LockReason::Build { text }
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
            shadowed: false,
        }
    }

    fn sdlc() -> ResolveOptions {
        ResolveOptions {
            required_plugins: vec!["ai-sdlc".to_string()],
            ..ResolveOptions::default()
        }
    }

    #[test]
    fn lock_for_decides_every_row_of_the_r6_3_lock_table() {
        use ItemKind as K;
        use Source as S;
        let none = ResolveOptions::default();
        let build = ResolveOptions {
            build: true,
            ..ResolveOptions::default()
        };
        let shadowed = |mut f: ItemFacts| {
            f.shadowed = true;
            f
        };
        let kata = Some(LockReason::Kata {
            text: "the run needs it to ask you questions".into(),
        });
        let required = Some(LockReason::Required {
            text: "AI-SDLC runs work through this plugin".into(),
        });
        let org = Some(LockReason::Organization {
            text: "set by your organization".into(),
        });
        let unswitchable = Some(LockReason::Unswitchable {
            text: "Kata cannot switch this off for one run without editing your setup".into(),
        });
        let build_hook = Some(LockReason::Build {
            text: "a build keeps the project's hooks, which may guard what it edits".into(),
        });

        // Row 1 and the example "Kata's question tool".
        let r1 = facts(K::ToolServer, S::Kata, "kata-ask", None);
        assert_eq!(lock_for(&r1, &none), kata);
        assert_eq!(lock_for(&r1, &build), kata);
        // Row 2 and the example "Kata's standing note on how to ask".
        let r2 = facts(K::Instruction, S::Kata, "standing-note", None);
        assert_eq!(lock_for(&r2, &none), kata);
        // Row 3 and the example "the ai-sdlc plugin, in AI-SDLC mode".
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
        assert_eq!(lock_for(&r3a, &none), None);
        let r3d = facts(K::Plugin, S::Personal, "ai-sdlc-extra@mkt", None);
        assert_eq!(lock_for(&r3d, &sdlc()), None);
        // Row 3 beats row 4 and row 9.
        let r3e = facts(K::Plugin, S::Organization, "ai-sdlc@mkt", None);
        assert_eq!(lock_for(&r3e, &sdlc()), required);
        assert_eq!(lock_for(&shadowed(r3b.clone()), &sdlc()), required);
        // Row 4 and the example "anything the organization's managed settings set".
        for kind in [K::Hook, K::Skill, K::Plugin, K::Instruction, K::ToolServer] {
            let r4 = facts(kind, S::Organization, "x", None);
            assert_eq!(lock_for(&r4, &none), org, "{kind:?}");
            assert_eq!(lock_for(&r4, &build), org, "{kind:?} in a build");
        }
        // Row 5: brought by another plugin; no switch of its own, no reason text.
        let plugin_id = "personal:plugin:other@mkt";
        let follows = Some(LockReason::FollowsPlugin {
            plugin: plugin_id.into(),
        });
        for kind in [K::Hook, K::Skill, K::ToolServer] {
            let r5 = facts(kind, S::Plugin, "other@mkt:x", Some(plugin_id));
            assert_eq!(lock_for(&r5, &sdlc()), follows, "{kind:?}");
            assert_eq!(lock_for(&r5, &build), follows, "{kind:?} in a build");
            assert_eq!(lock_for(&r5, &sdlc()).unwrap().text(), None);
        }
        // Row 6 and the example "a hook from the personal setup".
        let r6 = facts(K::Hook, S::Personal, "PreToolUse:Bash:00", None);
        assert_eq!(lock_for(&r6, &none), unswitchable);
        assert_eq!(lock_for(&r6, &build), unswitchable);
        // Row 7 and the example "a project hook, in a build run".
        for source in [S::Project, S::ProjectLocal] {
            let r7 = facts(K::Hook, source, "PreToolUse:Bash:00", None);
            assert_eq!(lock_for(&r7, &build), build_hook, "{source:?}");
        }
        // Row 8 and the example "a skill from the personal setup or the project".
        for source in [S::Personal, S::Project] {
            let r8 = facts(K::Skill, source, "own-skill", None);
            assert_eq!(lock_for(&r8, &none), unswitchable, "{source:?}");
            assert_eq!(lock_for(&r8, &build), unswitchable, "{source:?} in a build");
        }
        // Row 9: a kit skill or plugin that is also on disk.
        for kind in [K::Skill, K::Plugin] {
            let r9 = shadowed(facts(kind, S::RunSpec, "kit", None));
            assert_eq!(lock_for(&r9, &none), unswitchable, "{kind:?}");
            // Row 10: the same item, not shadowed, is free.
            let r9b = facts(kind, S::RunSpec, "kit", None);
            assert_eq!(lock_for(&r9b, &none), None, "{kind:?}");
        }
        // Row 10: a pair in SWITCHABLE, including shadowed for a kind or source
        // rows 6 to 9 do not name.
        for (kind, source) in [
            (K::Plugin, S::Personal),
            (K::Plugin, S::Project),
            (K::Plugin, S::ProjectLocal),
            (K::Instruction, S::RunSpec),
            (K::Instruction, S::Personal),
            (K::ToolServer, S::Personal),
            (K::ToolServer, S::Project),
            (K::ToolServer, S::ProjectLocal),
        ] {
            let r10 = facts(kind, source, "x", None);
            assert_eq!(lock_for(&r10, &none), None, "{kind:?} {source:?}");
            assert_eq!(
                lock_for(&r10, &build),
                None,
                "{kind:?} {source:?} in a build"
            );
            let r10s = shadowed(r10);
            assert_eq!(lock_for(&r10s, &none), None, "{kind:?} {source:?} shadowed");
        }
        // Row 11 and the example "any other item Kata cannot switch off": a pair
        // absent from SWITCHABLE that no earlier row names.
        let r11 = facts(K::Skill, S::Plugin, "loose-skill", None);
        assert_eq!(lock_for(&r11, &none), unswitchable);
        let r11b = facts(K::Instruction, S::Plugin, "loose-note", None);
        assert_eq!(lock_for(&r11b, &build), unswitchable);
    }

    #[test]
    fn a_project_hook_outside_a_build_run_is_switchable() {
        let none = ResolveOptions::default();
        for source in [Source::Project, Source::ProjectLocal] {
            let hook = facts(ItemKind::Hook, source, "PostToolUse:Write:00", None);
            assert_eq!(lock_for(&hook, &none), None, "{source:?}");
        }
        // A personal hook is still locked.
        let hook = facts(
            ItemKind::Hook,
            Source::Personal,
            "PostToolUse:Write:00",
            None,
        );
        assert!(lock_for(&hook, &none).is_some());
    }
}
