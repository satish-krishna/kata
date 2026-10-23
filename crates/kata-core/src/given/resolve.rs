//! What a run will be given: every item, the run's settings, the names (never
//! the values) of its environment, and what a saved job names that is gone.

use super::lock::{lock_for, LockReason};
use super::settings::{effort_setting, env_names, hooks, model_setting, read_layers};
use super::{items, parse_item_id, ItemFacts, ItemKind, ResolveRoots, Source};
use crate::spec::{Given, PermissionMode, RunSpec, DEFAULT_TIMEOUT_SECS};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// What the caller needs the resolver to treat specially.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct ResolveOptions {
    /// Plugin names (without a marketplace) the run cannot work without. The
    /// Workbench passes `["ai-sdlc"]` for an AI-SDLC run; the CLI passes none.
    #[serde(default)]
    pub required_plugins: Vec<String>,
    /// True for a build run.
    #[serde(default)]
    pub build: bool,
}

impl ResolveOptions {
    /// The options a spec asks for: its `given.required_plugins` and `given.build`
    /// (none and false when `given` is absent).
    pub fn from_spec(spec: &RunSpec) -> ResolveOptions {
        spec.given
            .as_ref()
            .map(|g| ResolveOptions {
                required_plugins: g.required_plugins.clone(),
                build: g.build,
            })
            .unwrap_or_default()
    }
}

/// One item the run will be given. `lock` is the only authority on whether the
/// row can be switched; `off` is already resolved, including a follower taking
/// the state of its plugin.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResolvedItem {
    pub id: String,
    pub kind: ItemKind,
    pub source: Source,
    pub name: String,
    pub detail: String,
    pub path: Option<String>,
    pub brought_by: Option<String>,
    pub lock: Option<LockReason>,
    pub off: bool,
    /// The ids of the hooks whose switch-off also drops this item (R4.6).
    pub goes_off_with: Vec<String>,
}

/// Where a setting's value comes from.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "kebab-case"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingSource {
    RunSpec,
    Personal,
    Project,
    ProjectLocal,
    Organization,
    ClaudeDefault,
    KataDefault,
    /// What Claude's own start report said the run started with.
    ClaudeReport,
}

/// One setting. `value` is `None` when nothing is set: "none" for a cap or a
/// deadline, Claude's own default for the model and the effort level.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct RunSetting {
    pub value: Option<String>,
    pub source: SettingSource,
}

/// The settings of R17.1 the engine can resolve. The build's safety rules come
/// from the Workbench.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct RunSettings {
    pub model: RunSetting,
    pub effort: RunSetting,
    pub permission_posture: RunSetting,
    pub empty_room: RunSetting,
    pub answer_deadline: RunSetting,
    pub time_limit: RunSetting,
    pub turn_cap: RunSetting,
    pub spending_ceiling: RunSetting,
}

/// The name of an environment variable the run sees. Never its value.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct EnvName {
    pub source: Source,
    pub name: String,
    /// True for the variable that holds the API key (`auth.token_env`).
    pub api_key: bool,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Resolved {
    pub items: Vec<ResolvedItem>,
    pub settings: RunSettings,
    pub env: Vec<EnvName>,
    /// Identities in `spec.given` that match no item (R10.3).
    pub missing: Vec<String>,
    /// Settings files that could not be read, by path.
    pub problems: Vec<String>,
    /// True when the run is in the empty room: only what Kata passes is listed.
    pub empty_room: bool,
}

fn setting(value: impl Into<Option<String>>, source: SettingSource) -> RunSetting {
    RunSetting {
        value: value.into(),
        source,
    }
}

fn layer_source(source: Source) -> SettingSource {
    match source {
        Source::Personal => SettingSource::Personal,
        Source::Project => SettingSource::Project,
        Source::ProjectLocal => SettingSource::ProjectLocal,
        Source::Organization => SettingSource::Organization,
        _ => SettingSource::ClaudeDefault,
    }
}

fn run_settings(spec: &RunSpec, layers: &[super::SettingsLayer]) -> RunSettings {
    let model = match (&spec.model.id, model_setting(layers)) {
        (Some(id), _) => setting(id.clone(), SettingSource::RunSpec),
        (None, Some((v, s))) => setting(v, layer_source(s)),
        (None, None) => setting(None, SettingSource::ClaudeDefault),
    };
    let effort = match effort_setting(layers) {
        Some((v, s)) => setting(v, layer_source(s)),
        None => setting(None, SettingSource::ClaudeDefault),
    };
    let posture = match spec.permissions.mode {
        PermissionMode::Bypass => "bypass",
        PermissionMode::Prompt => "prompt",
        PermissionMode::Auto => "auto",
    };
    let answer_deadline = match spec.interactive.answer_timeout_secs {
        Some(s) => setting(s.to_string(), SettingSource::RunSpec),
        // Kata's default is to wait until answered or cancelled.
        None => setting(None, SettingSource::KataDefault),
    };
    let time_limit = match spec.leash.timeout_secs {
        Some(s) => setting(s.to_string(), SettingSource::RunSpec),
        None => setting(DEFAULT_TIMEOUT_SECS.to_string(), SettingSource::KataDefault),
    };
    RunSettings {
        model,
        effort,
        permission_posture: setting(posture.to_string(), SettingSource::RunSpec),
        empty_room: setting(
            if spec.auth.bare { "on" } else { "off" }.to_string(),
            SettingSource::RunSpec,
        ),
        answer_deadline,
        time_limit,
        turn_cap: setting(
            spec.leash.max_turns.map(|n| n.to_string()),
            SettingSource::RunSpec,
        ),
        spending_ceiling: setting(
            spec.leash.max_budget_usd.map(|n| n.to_string()),
            SettingSource::RunSpec,
        ),
    }
}

/// Names only: the settings layers', the run-spec's, and the API key's variable.
fn env_of(spec: &RunSpec, layers: &[super::SettingsLayer]) -> Vec<EnvName> {
    let mut out: Vec<EnvName> = env_names(layers)
        .into_iter()
        .map(|(source, name)| EnvName {
            source,
            name,
            api_key: false,
        })
        .collect();
    out.extend(spec.env.keys().map(|name| EnvName {
        source: Source::RunSpec,
        name: name.clone(),
        api_key: false,
    }));
    if let Some(name) = spec.auth.token_env.as_ref().filter(|n| !n.is_empty()) {
        out.push(EnvName {
            source: Source::RunSpec,
            name: name.clone(),
            api_key: true,
        });
    }
    out
}

/// Lock, switch state and the missing entries, from the facts. A follower (a
/// row that follows its plugin) is off when its plugin is.
fn build_items(
    facts: Vec<ItemFacts>,
    given: Option<&Given>,
    opts: &ResolveOptions,
) -> (Vec<ResolvedItem>, Vec<String>) {
    let listed: Vec<&String> = given
        .map(|g| {
            [
                &g.hooks,
                &g.skills,
                &g.plugins,
                &g.instructions,
                &g.tool_servers,
            ]
            .into_iter()
            .flatten()
            .collect()
        })
        .unwrap_or_default();
    let known: HashSet<&str> = facts.iter().map(|f| f.id.as_str()).collect();
    let missing: Vec<String> = listed
        .iter()
        .filter(|id| !known.contains(id.as_str()))
        .map(|id| (*id).clone())
        .collect();
    let listed: HashSet<&str> = listed.iter().map(|s| s.as_str()).collect();

    let mut items: Vec<ResolvedItem> = facts
        .iter()
        .map(|f| {
            let lock = lock_for(f, opts);
            let off = lock.is_none() && listed.contains(f.id.as_str());
            ResolvedItem {
                id: f.id.clone(),
                kind: f.kind,
                source: f.source,
                name: f.name.clone(),
                detail: f.detail.clone(),
                path: f.path.as_ref().map(|p| p.display().to_string()),
                brought_by: f.brought_by.clone(),
                lock,
                off,
                goes_off_with: super::goes_off_with(f, &facts),
            }
        })
        .collect();
    let plugin_off: HashMap<String, bool> = items
        .iter()
        .filter(|i| i.kind == ItemKind::Plugin)
        .map(|i| (i.id.clone(), i.off))
        .collect();
    for i in &mut items {
        if let Some(LockReason::FollowsPlugin { plugin }) = &i.lock {
            i.off = plugin_off.get(plugin).copied().unwrap_or(false);
        }
    }
    // An item that goes off with a hook is off when that hook is. Its lock is
    // its own: nothing about the item itself is locked.
    let off_now: HashSet<String> = items
        .iter()
        .filter(|i| i.off)
        .map(|i| i.id.clone())
        .collect();
    for i in &mut items {
        if i.goes_off_with.iter().any(|h| off_now.contains(h)) {
            i.off = true;
        }
    }
    items.sort_by(|a, b| {
        (a.kind as u8, a.source as u8, &a.name).cmp(&(b.kind as u8, b.source as u8, &b.name))
    });
    (items, missing)
}

/// What the empty room leaves of the facts: Kata's own items, the run-spec's
/// kit and what a kit plugin brings except its hooks, and the output style a
/// settings layer sets. Nothing in it is shadowed, because nothing from the
/// setup is loaded for it to shadow.
fn empty_room_facts(facts: Vec<ItemFacts>) -> Vec<ItemFacts> {
    facts
        .into_iter()
        .filter(|f| {
            let from_kit_plugin = f
                .brought_by
                .as_deref()
                .is_some_and(|b| b.starts_with("run-spec:plugin:"));
            let output_style = f.kind == ItemKind::Instruction
                && parse_item_id(&f.id).is_ok_and(|r| r.key == "output-style");
            matches!(f.source, Source::Kata | Source::RunSpec)
                || (from_kit_plugin && f.kind != ItemKind::Hook)
                || output_style
        })
        .map(|mut f| {
            f.shadowed = false;
            f
        })
        .collect()
}

/// What the run will be given. Reads files under `roots`; never reads an
/// environment value and never copies one into the result.
pub fn resolve(spec: &RunSpec, roots: &ResolveRoots, opts: &ResolveOptions) -> Resolved {
    let layers = read_layers(roots);
    let (mut facts, mut problems) = items::collect(spec, roots, &layers);
    facts.extend(hooks(&layers));
    problems.extend(layers.iter().filter_map(|l| l.problem.clone()));
    let empty_room = spec.auth.bare;
    let all_ids: HashSet<String> = facts.iter().map(|f| f.id.clone()).collect();
    if empty_room {
        facts = empty_room_facts(facts);
    }
    let (items, mut missing) = build_items(facts, spec.given.as_ref(), opts);
    if empty_room {
        // An item the room leaves out is not gone, only not listed.
        missing.retain(|id| !all_ids.contains(id));
    }
    Resolved {
        items,
        settings: run_settings(spec, &layers),
        env: env_of(spec, &layers),
        missing,
        problems,
        empty_room,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::given::item_id;
    use serial_test::serial;
    use std::fs;
    use std::path::Path;

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

    #[test]
    fn from_spec_reads_required_plugins_and_build() {
        assert_eq!(
            ResolveOptions::from_spec(&RunSpec::default()),
            ResolveOptions::default()
        );
        let spec = RunSpec {
            given: Some(Given {
                required_plugins: vec!["ai-sdlc".into()],
                build: true,
                ..Given::default()
            }),
            ..RunSpec::default()
        };
        assert_eq!(
            ResolveOptions::from_spec(&spec),
            ResolveOptions {
                required_plugins: vec!["ai-sdlc".into()],
                build: true
            }
        );
    }

    fn spec_for(r: &ResolveRoots) -> RunSpec {
        RunSpec {
            workdir: r.workdir.to_string_lossy().into_owned(),
            ..RunSpec::default()
        }
    }

    fn facts(kind: ItemKind, source: Source, key: &str, by: Option<&str>) -> ItemFacts {
        ItemFacts {
            id: item_id(kind, source, key),
            kind,
            source,
            name: key.to_string(),
            detail: String::new(),
            path: None,
            brought_by: by.map(str::to_string),
            repo_relative: false,
            shadowed: false,
        }
    }

    /// Resolve, serialize the whole result, and check each name is present and
    /// each value absent.
    fn assert_named_not_carried(r: &ResolveRoots, spec: &RunSpec, names: &[&str], values: &[&str]) {
        // Outside the empty room, where the setup's items are listed.
        let mut spec = spec.clone();
        spec.auth.bare = false;
        let resolved = resolve(&spec, r, &ResolveOptions::default());
        let json = serde_json::to_string(&resolved).unwrap();
        for n in names {
            assert!(json.contains(n), "name {n} missing from {json}");
        }
        for v in values {
            assert!(!json.contains(v), "secret {v} leaked: {json}");
        }
    }

    #[test]
    #[serial]
    fn secrets_are_named_never_carried() {
        const KEY_VALUE: &str = "sk-ant-known-api-key-123";
        // An API key held in an environment variable.
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        let mut spec = spec_for(&r);
        spec.auth.token_env = Some("KATA_TEST_API_KEY".into());
        std::env::set_var("KATA_TEST_API_KEY", KEY_VALUE);
        assert_named_not_carried(&r, &spec, &["KATA_TEST_API_KEY"], &[KEY_VALUE]);
        std::env::remove_var("KATA_TEST_API_KEY");
        let resolved = resolve(&spec, &r, &ResolveOptions::default());
        assert!(resolved
            .env
            .iter()
            .any(|e| e.name == "KATA_TEST_API_KEY" && e.api_key));

        // A tool server whose definition carries a token.
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(
            &r.workdir.join(".mcp.json"),
            &serde_json::json!({"mcpServers": {
                "srv-with-token": {"command": "node", "args": ["--token", "tok-in-args-77"],
                    "env": {"K": "tok-in-env-88"}},
                "remote-srv": {"type": "sse", "url": "https://x.test/tok-in-url-99",
                    "headers": {"Authorization": "Bearer tok-in-header-55"}}
            }})
            .to_string(),
        );
        let spec = spec_for(&r);
        assert_named_not_carried(
            &r,
            &spec,
            &["srv-with-token", "remote-srv", "stdio", "sse"],
            &[
                "tok-in-args-77",
                "tok-in-env-88",
                "tok-in-url-99",
                "tok-in-header-55",
            ],
        );

        // Environment settings in the personal setup.
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(
            &r.home.join(".claude/settings.json"),
            &serde_json::json!({"env": {"PERSONAL_VAR": "personal-secret-value-1"}}).to_string(),
        );
        let spec = spec_for(&r);
        assert_named_not_carried(&r, &spec, &["PERSONAL_VAR"], &["personal-secret-value-1"]);

        // Environment overrides in the run-spec.
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        let mut spec = spec_for(&r);
        spec.env
            .insert("SPEC_VAR".into(), "spec-secret-value-2".into());
        assert_named_not_carried(&r, &spec, &["SPEC_VAR"], &["spec-secret-value-2"]);
    }

    #[test]
    fn an_unset_model_reads_claude_default() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        let resolved = resolve(&spec_for(&r), &r, &ResolveOptions::default());
        let s = &resolved.settings;
        assert_eq!(s.model, setting(None, SettingSource::ClaudeDefault));
        assert_eq!(s.effort, setting(None, SettingSource::ClaudeDefault));
        // The rest of R17.1.
        assert_eq!(s.permission_posture.value.as_deref(), Some("bypass"));
        assert_eq!(s.empty_room.value.as_deref(), Some("on"));
        assert_eq!(
            s.time_limit,
            setting("1800".to_string(), SettingSource::KataDefault)
        );
        assert_eq!(s.answer_deadline, setting(None, SettingSource::KataDefault));
        assert_eq!(s.turn_cap, setting(None, SettingSource::RunSpec));
        assert_eq!(s.spending_ceiling, setting(None, SettingSource::RunSpec));
    }

    #[test]
    fn a_model_comes_from_the_run_spec_first_then_the_personal_setup() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(
            &r.home.join(".claude/settings.json"),
            r#"{"model": "sonnet", "effortLevel": "high"}"#,
        );
        let mut spec = spec_for(&r);
        let s = resolve(&spec, &r, &ResolveOptions::default()).settings;
        assert_eq!(
            s.model,
            setting("sonnet".to_string(), SettingSource::Personal)
        );
        assert_eq!(
            s.effort,
            setting("high".to_string(), SettingSource::Personal)
        );
        spec.model.id = Some("opus".into());
        spec.leash.timeout_secs = Some(60);
        spec.leash.max_turns = Some(7);
        spec.leash.max_budget_usd = Some(2.5);
        spec.interactive.answer_timeout_secs = Some(30);
        spec.auth.bare = false;
        spec.permissions.mode = PermissionMode::Auto;
        let s = resolve(&spec, &r, &ResolveOptions::default()).settings;
        assert_eq!(s.model, setting("opus".to_string(), SettingSource::RunSpec));
        assert_eq!(
            s.time_limit,
            setting("60".to_string(), SettingSource::RunSpec)
        );
        assert_eq!(s.turn_cap, setting("7".to_string(), SettingSource::RunSpec));
        assert_eq!(
            s.spending_ceiling,
            setting("2.5".to_string(), SettingSource::RunSpec)
        );
        assert_eq!(s.answer_deadline.value.as_deref(), Some("30"));
        assert_eq!(s.empty_room.value.as_deref(), Some("off"));
        assert_eq!(s.permission_posture.value.as_deref(), Some("auto"));
    }

    #[test]
    fn a_given_entry_that_matches_nothing_is_listed_as_missing() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        let mut spec = spec_for(&r);
        spec.given = Some(Given {
            plugins: vec!["personal:plugin:gone@mkt".into()],
            ..Given::default()
        });
        let resolved = resolve(&spec, &r, &ResolveOptions::default());
        assert_eq!(resolved.missing, vec!["personal:plugin:gone@mkt"]);
        assert!(resolved.items.iter().all(|i| !i.off));
    }

    #[test]
    fn a_locked_item_listed_in_given_is_not_off() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(
            &r.workdir.join(".mcp.json"),
            r#"{"mcpServers": {"proj-srv": {"command": "x"}}}"#,
        );
        write(
            &r.managed_settings.with_file_name("managed-mcp.json"),
            r#"{"mcpServers": {"org-srv": {"command": "x"}}}"#,
        );
        let mut spec = spec_for(&r);
        spec.auth.bare = false;
        spec.given = Some(Given {
            tool_servers: vec![
                "kata:tool-server:kata-ask".into(),
                "organization:tool-server:org-srv".into(),
                "project:tool-server:proj-srv".into(),
            ],
            ..Given::default()
        });
        let resolved = resolve(&spec, &r, &ResolveOptions::default());
        assert!(resolved.missing.is_empty(), "{:?}", resolved.missing);
        let find = |id: &str| resolved.items.iter().find(|i| i.id == id).unwrap();
        let kata = find("kata:tool-server:kata-ask");
        assert!(kata.lock.is_some() && !kata.off);
        let org = find("organization:tool-server:org-srv");
        assert!(org.lock.is_some() && !org.off);
        let proj = find("project:tool-server:proj-srv");
        assert!(proj.lock.is_none() && proj.off);
    }

    #[test]
    fn a_follower_is_off_when_its_plugin_is_and_items_are_ordered() {
        let plugin = facts(ItemKind::Plugin, Source::Personal, "p@mkt", None);
        let skill = facts(ItemKind::Skill, Source::Plugin, "p@mkt:s", Some(&plugin.id));
        let other = facts(ItemKind::Plugin, Source::Personal, "a@mkt", None);
        let given = Given {
            plugins: vec![plugin.id.clone()],
            ..Given::default()
        };
        let (items, missing) = build_items(
            vec![skill.clone(), plugin.clone(), other.clone()],
            Some(&given),
            &ResolveOptions::default(),
        );
        assert!(missing.is_empty());
        let ids: Vec<_> = items.iter().map(|i| i.id.as_str()).collect();
        // Kind order first (skill before plugin, as declared), then source, then name.
        assert_eq!(
            ids,
            [skill.id.as_str(), other.id.as_str(), plugin.id.as_str()]
        );
        assert!(items[0].off && !items[1].off && items[2].off);
    }

    #[test]
    fn an_unreadable_settings_file_is_a_problem() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(&r.home.join(".claude/settings.json"), "{ not json");
        let resolved = resolve(&spec_for(&r), &r, &ResolveOptions::default());
        assert!(
            resolved
                .problems
                .iter()
                .any(|p| p.contains("settings.json")),
            "{:?}",
            resolved.problems
        );
    }

    // ---- the empty room (R18), hook actions, and what goes off with a hook ----

    fn skill_at(dir: &Path, name: &str) {
        write(
            &dir.join("skills").join(name).join("SKILL.md"),
            &format!("---\nname: {name}\ndescription: does {name}\n---\nbody\n"),
        );
    }

    fn hook_file(command: &str) -> String {
        serde_json::json!({"hooks": {"PreToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": command}]}
        ]}})
        .to_string()
    }

    fn plugin_manifest(dir: &Path, name: &str) {
        write(
            &dir.join(".claude-plugin").join("plugin.json"),
            &format!("{{\"name\":\"{name}\",\"description\":\"the {name} plugin\"}}"),
        );
    }

    fn listed(resolved: &Resolved, kind: ItemKind, source: Source) -> bool {
        resolved
            .items
            .iter()
            .any(|i| i.kind == kind && i.source == source)
    }

    #[test]
    fn in_the_empty_room_a_kit_plugins_skill_is_listed_and_its_hook_is_not() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        let plug = r.home.join(".claude/plugins/kit-plug");
        plugin_manifest(&plug, "kit-plug");
        skill_at(&plug, "plug-skill");
        write(&plug.join("hooks/hooks.json"), &hook_file("node plug.js"));
        write(
            &plug.join(".mcp.json"),
            r#"{"mcpServers": {"plug-srv": {"command": "node"}}}"#,
        );
        let mut spec = spec_for(&r);
        spec.plugins.insert("kit-plug".into(), Default::default());
        assert!(spec.auth.bare);
        let resolved = resolve(&spec, &r, &ResolveOptions::default());
        assert!(resolved.empty_room);
        let skill = resolved
            .items
            .iter()
            .find(|i| i.kind == ItemKind::Skill && i.name == "plug-skill")
            .expect("the plugin's skill is listed");
        assert_eq!(skill.source, Source::Plugin);
        assert_eq!(
            skill.brought_by.as_deref(),
            Some("run-spec:plugin:kit-plug")
        );
        assert!(
            !listed(&resolved, ItemKind::Hook, Source::Plugin),
            "the plugin's hook is not listed"
        );
        assert!(
            resolved
                .items
                .iter()
                .any(|i| i.kind == ItemKind::ToolServer && i.name == "plug-srv"),
            "what a kit plugin brings, except its hooks, is listed"
        );
        // Outside the empty room the same plugin brings its hook.
        spec.auth.bare = false;
        let open = resolve(&spec, &r, &ResolveOptions::default());
        assert!(!open.empty_room);
        assert!(listed(&open, ItemKind::Hook, Source::Plugin));
    }

    /// Put one item of `kind` from `source` on disk.
    fn put(r: &ResolveRoots, source: &str, kind: &str) {
        let claude = if source == "personal setup" {
            r.home.join(".claude")
        } else {
            r.workdir.join(".claude")
        };
        match kind {
            "hook" => write(&claude.join("settings.json"), &hook_file("node h.js")),
            "skill" => skill_at(&claude, "setup-skill"),
            "plugin" => {
                let cache = r.home.parent().unwrap().join("cache/pers");
                plugin_manifest(&cache, "pers");
                write(
                    &claude.join("settings.json"),
                    r#"{"enabledPlugins": {"pers@mkt": true}}"#,
                );
                write(
                    &r.home.join(".claude/plugins/installed_plugins.json"),
                    &serde_json::json!({"version": 2, "plugins": {"pers@mkt": [
                        {"scope": "user", "installPath": cache.to_string_lossy(), "version": "1"}
                    ]}})
                    .to_string(),
                );
            }
            "standing instruction" => {
                let file = if source == "personal setup" {
                    claude.join("CLAUDE.md")
                } else {
                    r.workdir.join("CLAUDE.md")
                };
                write(&file, "rules");
            }
            "tool server" => {
                let body = r#"{"mcpServers": {"setup-srv": {"command": "node"}}}"#;
                if source == "personal setup" {
                    write(&r.claude_json, body);
                } else {
                    write(&r.workdir.join(".mcp.json"), body);
                }
            }
            other => panic!("{other}"),
        }
    }

    #[test]
    fn the_empty_room_lists_none_of_the_setups_items() {
        // One case per R18.1 Examples row.
        use ItemKind as K;
        use Source as S;
        let rows = [
            ("personal setup", "hook", K::Hook, S::Personal),
            ("project", "hook", K::Hook, S::Project),
            ("personal setup", "skill", K::Skill, S::Personal),
            ("project", "skill", K::Skill, S::Project),
            ("personal setup", "plugin", K::Plugin, S::Personal),
            (
                "personal setup",
                "standing instruction",
                K::Instruction,
                S::Personal,
            ),
            (
                "project",
                "standing instruction",
                K::Instruction,
                S::Project,
            ),
            ("personal setup", "tool server", K::ToolServer, S::Personal),
            ("project", "tool server", K::ToolServer, S::Project),
        ];
        for (from, what, kind, source) in rows {
            let d = tempfile::tempdir().unwrap();
            let r = roots(d.path());
            put(&r, from, what);
            let mut spec = spec_for(&r);
            spec.auth.bare = false;
            let open = resolve(&spec, &r, &ResolveOptions::default());
            assert!(
                listed(&open, kind, source),
                "{from} {what}: listed outside the empty room"
            );
            spec.auth.bare = true;
            let room = resolve(&spec, &r, &ResolveOptions::default());
            assert!(room.empty_room, "{from} {what}");
            assert!(
                !listed(&room, kind, source),
                "{from} {what}: listed in the empty room"
            );
        }
    }

    #[test]
    fn the_empty_room_lists_what_kata_passes() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        // A skill on disk of the same name as the one picked, and a setup output
        // style and model.
        skill_at(&r.home.join(".claude"), "kit-skill");
        plugin_manifest(&r.home.join(".claude/plugins/kit-plug"), "kit-plug");
        write(
            &r.home.join(".claude/settings.json"),
            r#"{"outputStyle": "Explanatory", "model": "sonnet"}"#,
        );
        let mut spec = spec_for(&r);
        spec.skills = vec!["kit-skill".into()];
        spec.plugins.insert("kit-plug".into(), Default::default());
        spec.identity.system_prompt = Some("be brief".into());
        let resolved = resolve(&spec, &r, &ResolveOptions::default());
        assert!(resolved.empty_room);
        let rows = [
            ("the question tool", "kata:tool-server:kata-ask", true),
            ("the standing note", "kata:instruction:standing-note", true),
            ("a skill picked", "run-spec:skill:kit-skill", false),
            ("a plugin picked", "run-spec:plugin:kit-plug", false),
            (
                "the job's own instruction",
                "run-spec:instruction:system-prompt",
                false,
            ),
            (
                "an output style set in the setup",
                "personal:instruction:output-style",
                false,
            ),
        ];
        for (label, id, locked) in rows {
            let it = resolved
                .items
                .iter()
                .find(|i| i.id == id)
                .unwrap_or_else(|| panic!("{label}: {id} is not listed"));
            assert_eq!(it.lock.is_some(), locked, "{label}: {:?}", it.lock);
        }
        // Nothing from the setup besides the output style.
        assert!(!listed(&resolved, ItemKind::Skill, Source::Personal));
        // Setting values still apply.
        assert_eq!(
            resolved.settings.model,
            setting("sonnet".to_string(), SettingSource::Personal)
        );
    }

    #[test]
    fn a_prompt_hook_an_agent_hook_and_an_http_hook_are_listed() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(
            &r.workdir.join(".claude/settings.json"),
            &serde_json::json!({"hooks": {"Stop": [{"hooks": [
                {"type": "prompt", "prompt": "Check it"},
                {"type": "agent", "prompt": "Verify it"},
                {"type": "http", "url": "https://h.test/x"}
            ]}]}})
            .to_string(),
        );
        let mut spec = spec_for(&r);
        spec.auth.bare = false;
        let resolved = resolve(&spec, &r, &ResolveOptions::default());
        let hooks: Vec<&str> = resolved
            .items
            .iter()
            .filter(|i| i.kind == ItemKind::Hook)
            .map(|i| i.detail.as_str())
            .collect();
        assert_eq!(hooks.len(), 3, "{hooks:?}");
        assert!(hooks.iter().any(|d| d.ends_with("prompt: Check it")));
        assert!(hooks.iter().any(|d| d.ends_with("agent: Verify it")));
        assert!(hooks.iter().any(|d| d.ends_with("http: https://h.test/x")));
    }

    fn off_ids(resolved: &Resolved) -> Vec<&str> {
        resolved
            .items
            .iter()
            .filter(|i| i.off)
            .map(|i| i.id.as_str())
            .collect()
    }

    #[test]
    fn an_instruction_is_off_when_a_hook_it_goes_off_with_is_off() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(
            &r.workdir.join(".claude/settings.json"),
            &hook_file("node shared.js"),
        );
        write(
            &r.workdir.join(".claude/settings.local.json"),
            &hook_file("node mine.js"),
        );
        write(&r.workdir.join("sub/CLAUDE.md"), "sub rules");
        write(&r.workdir.join("CLAUDE.local.md"), "mine");
        let mut spec = spec_for(&r);
        spec.auth.bare = false;
        let before = resolve(&spec, &r, &ResolveOptions::default());
        let find = |res: &Resolved, id: &str| res.items.iter().find(|i| i.id == id).cloned();
        let sub_id = "project:instruction:sub/CLAUDE.md";
        let local_id = "project-local:instruction:CLAUDE.local.md";
        let hook_of = |source: Source| {
            before
                .items
                .iter()
                .find(|i| i.kind == ItemKind::Hook && i.source == source)
                .unwrap()
                .id
                .clone()
        };
        let shared = hook_of(Source::Project);
        let mine = hook_of(Source::ProjectLocal);
        let sub = find(&before, sub_id).expect("nested instruction listed");
        assert_eq!(sub.goes_off_with, vec![shared.clone()]);
        assert!(!sub.off && sub.lock.is_none());
        assert_eq!(
            find(&before, local_id).unwrap().goes_off_with,
            vec![mine.clone()]
        );
        assert!(off_ids(&before).is_empty());

        // The shared hook off: the nested instruction goes with it, unlocked, and
        // the local pair stays.
        spec.given = Some(Given {
            hooks: vec![shared.clone()],
            ..Given::default()
        });
        let after = resolve(&spec, &r, &ResolveOptions::default());
        let mut off = off_ids(&after);
        off.sort();
        let mut want = vec![shared.as_str(), sub_id];
        want.sort();
        assert_eq!(off, want);
        assert!(find(&after, sub_id).unwrap().lock.is_none());

        // The local hook off takes CLAUDE.local.md.
        spec.given = Some(Given {
            hooks: vec![mine.clone()],
            ..Given::default()
        });
        let after = resolve(&spec, &r, &ResolveOptions::default());
        let mut off = off_ids(&after);
        off.sort();
        let mut want = vec![mine.as_str(), local_id];
        want.sort();
        assert_eq!(off, want);
    }
}
