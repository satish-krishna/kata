//! What the view says about an item: what Kata passed, what Claude reported, and
//! the one label that follows. The frontend labels the status it receives and
//! never derives it.

use super::{
    parse_item_id, ItemKind, LockReason, Resolved, ResolvedItem, RunSetting, SettingSource, Source,
};
use crate::event::{HookFired, InitReport, KataEvent, McpState};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// What Kata did with an item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KataSide {
    Passed,
    SwitchedOff,
    /// Claude reported it and Kata's list never held it.
    DidNotKnow,
}

/// What Claude's own report says about an item. Which values a kind can have:
/// skill and plugin take `Loaded` or `NotReported`; a tool server takes
/// `Connected`, `FailedToConnect` or `NotReported`; a hook takes `Fired` or
/// `NotFired`; an instruction always takes `NoReportOfKind`. `NoStartReport`
/// replaces `Loaded`, `Connected`, `FailedToConnect` and `NotReported` when the
/// run ended before Claude's start report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeSide {
    Loaded,
    Connected,
    FailedToConnect,
    NotReported,
    Fired,
    NotFired,
    NoReportOfKind,
    NoStartReport,
}

/// Why a (Kata, kind, Claude) triple cannot occur.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{kata:?} {kind:?} with Claude side {claude:?} cannot occur")]
pub struct ImpossibleStatus {
    pub kata: KataSide,
    pub kind: ItemKind,
    pub claude: ClaudeSide,
}

/// A triple that can occur. The only way to make one is [`StatusInput::new`],
/// which rejects every pair the table calls impossible (row 28) and every
/// Claude-side value that is not one of the kind's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatusInput {
    kata: KataSide,
    kind: ItemKind,
    claude: ClaudeSide,
}

impl StatusInput {
    pub fn new(
        kata: KataSide,
        kind: ItemKind,
        claude: ClaudeSide,
    ) -> Result<StatusInput, ImpossibleStatus> {
        use ClaudeSide::*;
        // Claude's report for a kind uses only that kind's values.
        let of_the_kind = match kind {
            ItemKind::Skill | ItemKind::Plugin => {
                matches!(claude, Loaded | NotReported | NoStartReport)
            }
            ItemKind::ToolServer => {
                matches!(
                    claude,
                    Connected | FailedToConnect | NotReported | NoStartReport
                )
            }
            ItemKind::Hook => matches!(claude, Fired | NotFired),
            ItemKind::Instruction => claude == NoReportOfKind,
        };
        // Row 28: an item neither Kata passed nor Claude reported is unknown to
        // both, so a did-not-know item always has something Claude reported.
        let known_to_someone = kata != KataSide::DidNotKnow
            || matches!(claude, Loaded | Connected | FailedToConnect | Fired);
        if of_the_kind && known_to_someone {
            Ok(StatusInput { kata, kind, claude })
        } else {
            Err(ImpossibleStatus { kata, kind, claude })
        }
    }
}

/// One variant per distinct text the view shows. The frontend maps each to its
/// words.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GivenStatus {
    /// "given"
    Given,
    /// "passed by Kata, not loaded by Claude"
    PassedNotLoaded,
    /// "given, failed to connect"
    GivenFailedToConnect,
    /// "given, fired"
    GivenFired,
    /// "given, has not fired"
    GivenNotFired,
    /// "given, Claude does not confirm this kind"
    GivenUnconfirmed,
    /// "switched off, but Claude loaded it"
    SwitchedOffButLoaded,
    /// "switched off, but it fired"
    SwitchedOffButFired,
    /// "switched off"
    SwitchedOff,
    /// "switched off, Claude does not confirm this kind"
    SwitchedOffUnconfirmed,
    /// "loaded by Claude, source unknown"
    LoadedSourceUnknown,
    /// "loaded by Claude, source unknown, failed to connect"
    LoadedSourceUnknownFailedToConnect,
    /// "fired, source unknown"
    FiredSourceUnknown,
    /// "passed by Kata, Claude made no start report"
    PassedNoStartReport,
    /// "switched off, Claude made no start report"
    SwitchedOffNoStartReport,
}

impl GivenStatus {
    /// R15.2: the row asks for a warning, because a switch did not hold.
    pub fn warns(self) -> bool {
        matches!(
            self,
            GivenStatus::SwitchedOffButLoaded | GivenStatus::SwitchedOffButFired
        )
    }
}

/// What the view says about an item (the status table, rows 1 to 27).
pub fn status(input: StatusInput) -> GivenStatus {
    use ClaudeSide as C;
    use GivenStatus as G;
    use KataSide as K;
    match (input.kata, input.claude) {
        (K::Passed, C::Loaded | C::Connected) => G::Given,
        (K::Passed, C::NotReported) => G::PassedNotLoaded,
        (K::Passed, C::FailedToConnect) => G::GivenFailedToConnect,
        (K::Passed, C::Fired) => G::GivenFired,
        (K::Passed, C::NotFired) => G::GivenNotFired,
        (K::Passed, C::NoReportOfKind) => G::GivenUnconfirmed,
        (K::Passed, C::NoStartReport) => G::PassedNoStartReport,
        // A switch that did not hold, whatever the connection's outcome.
        (K::SwitchedOff, C::Loaded | C::Connected | C::FailedToConnect) => G::SwitchedOffButLoaded,
        (K::SwitchedOff, C::Fired) => G::SwitchedOffButFired,
        (K::SwitchedOff, C::NotReported | C::NotFired) => G::SwitchedOff,
        (K::SwitchedOff, C::NoReportOfKind) => G::SwitchedOffUnconfirmed,
        (K::SwitchedOff, C::NoStartReport) => G::SwitchedOffNoStartReport,
        (K::DidNotKnow, C::FailedToConnect) => G::LoadedSourceUnknownFailedToConnect,
        (K::DidNotKnow, C::Fired) => G::FiredSourceUnknown,
        // `StatusInput::new` refuses every other did-not-know pair (row 28).
        (K::DidNotKnow, _) => G::LoadedSourceUnknown,
    }
}

/// One row of the view: the resolved item (without its path) and its status.
/// `source` is `None` for a row Claude reported that Kata did not know.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GivenItem {
    pub id: String,
    pub kind: ItemKind,
    pub source: Option<Source>,
    pub name: String,
    pub detail: String,
    pub brought_by: Option<String>,
    pub lock: Option<LockReason>,
    pub off: bool,
    pub status: GivenStatus,
}

/// The `run.given` event for what `resolved` listed at the start, checked
/// against Claude's start report (`None` when it has not arrived) and the hooks
/// seen firing so far.
pub fn given_event(
    resolved: &Resolved,
    init: Option<&InitReport>,
    fired: &[HookFired],
) -> KataEvent {
    let plugin_names: HashMap<&str, &str> = resolved
        .items
        .iter()
        .filter(|i| i.kind == ItemKind::Plugin)
        .map(|i| (i.id.as_str(), i.name.as_str()))
        .collect();
    let brought_by = |item: &ResolvedItem| {
        item.brought_by
            .as_deref()
            .and_then(|id| plugin_names.get(id).copied())
    };

    let mut claimed_skills: HashSet<&str> = HashSet::new();
    let mut claimed_plugins: HashSet<&str> = HashSet::new();
    let mut claimed_servers: HashSet<&str> = HashSet::new();
    let mut claimed_hooks: HashSet<usize> = HashSet::new();

    let mut items: Vec<GivenItem> = Vec::new();
    for item in &resolved.items {
        let claude = match item.kind {
            ItemKind::Instruction => ClaudeSide::NoReportOfKind,
            ItemKind::Hook => {
                let mut any = false;
                for (n, f) in fired.iter().enumerate() {
                    if hook_matches(item, f) {
                        claimed_hooks.insert(n);
                        any = true;
                    }
                }
                if any {
                    ClaudeSide::Fired
                } else {
                    ClaudeSide::NotFired
                }
            }
            _ => match init {
                None => ClaudeSide::NoStartReport,
                Some(report) => match item.kind {
                    ItemKind::Skill => {
                        let found = report
                            .skills
                            .iter()
                            .filter(|s| skill_matches(item, s, brought_by(item)))
                            .map(|s| claimed_skills.insert(s.as_str()))
                            .count();
                        if found > 0 {
                            ClaudeSide::Loaded
                        } else {
                            ClaudeSide::NotReported
                        }
                    }
                    ItemKind::Plugin => {
                        let found = report
                            .plugins
                            .iter()
                            .filter(|p| plugin_matches(item, p))
                            .map(|p| claimed_plugins.insert(p.as_str()))
                            .count();
                        if found > 0 {
                            ClaudeSide::Loaded
                        } else {
                            ClaudeSide::NotReported
                        }
                    }
                    _ => {
                        let want = server_name(item, brought_by(item));
                        match report.mcp_servers.iter().find(|(n, _)| *n == want) {
                            Some((n, state)) => {
                                claimed_servers.insert(n.as_str());
                                match state {
                                    McpState::Connected | McpState::Pending => {
                                        ClaudeSide::Connected
                                    }
                                    McpState::Failed => ClaudeSide::FailedToConnect,
                                }
                            }
                            None => ClaudeSide::NotReported,
                        }
                    }
                },
            },
        };
        let kata = if item.off {
            KataSide::SwitchedOff
        } else {
            KataSide::Passed
        };
        items.push(GivenItem {
            id: item.id.clone(),
            kind: item.kind,
            source: Some(item.source),
            name: item.name.clone(),
            detail: item.detail.clone(),
            brought_by: item.brought_by.clone(),
            lock: item.lock.clone(),
            off: item.off,
            status: status_of(kata, item.kind, claude),
        });
    }

    // What Claude reported that Kata's list never held (rows 21 to 25).
    let mut unknown = |kind: ItemKind, name: &str, claude: ClaudeSide| {
        items.push(GivenItem {
            id: format!("claude:{}:{name}", kind.as_str()),
            kind,
            source: None,
            name: name.to_string(),
            detail: String::new(),
            brought_by: None,
            lock: None,
            off: false,
            status: status_of(KataSide::DidNotKnow, kind, claude),
        });
    };
    if let Some(report) = init {
        for s in report
            .skills
            .iter()
            .filter(|s| !claimed_skills.contains(s.as_str()))
        {
            unknown(ItemKind::Skill, s, ClaudeSide::Loaded);
        }
        // Claude's own bundled plugins are not part of anyone's setup.
        for p in report
            .plugins
            .iter()
            .filter(|p| !p.ends_with("@builtin") && !claimed_plugins.contains(p.as_str()))
        {
            unknown(ItemKind::Plugin, p, ClaudeSide::Loaded);
        }
        for (n, state) in report
            .mcp_servers
            .iter()
            .filter(|(n, _)| !claimed_servers.contains(n.as_str()))
        {
            let claude = match state {
                McpState::Failed => ClaudeSide::FailedToConnect,
                McpState::Connected | McpState::Pending => ClaudeSide::Connected,
            };
            unknown(ItemKind::ToolServer, n, claude);
        }
    }
    let mut seen_hooks: HashSet<&str> = HashSet::new();
    for (n, f) in fired.iter().enumerate() {
        if !claimed_hooks.contains(&n) && seen_hooks.insert(f.name.as_str()) {
            unknown(ItemKind::Hook, &f.name, ClaudeSide::Fired);
        }
    }

    let warnings = items
        .iter()
        .filter(|i| i.status.warns())
        .map(|i| match i.status {
            GivenStatus::SwitchedOffButFired => {
                format!("{} was switched off, but it fired", i.name)
            }
            _ => format!("{} was switched off, but Claude loaded it", i.name),
        })
        .collect();

    let mut settings = resolved.settings.clone();
    if let Some(report) = init {
        let reported = |v: &Option<String>, was: &RunSetting| match v {
            Some(v) => RunSetting {
                value: Some(v.clone()),
                source: SettingSource::ClaudeReport,
            },
            None => was.clone(),
        };
        settings.model = reported(&report.model, &settings.model);
        settings.permission_posture =
            reported(&report.permission_mode, &settings.permission_posture);
    }

    KataEvent::RunGiven {
        items,
        settings,
        env: resolved.env.clone(),
        warnings,
    }
}

fn status_of(kata: KataSide, kind: ItemKind, claude: ClaudeSide) -> GivenStatus {
    match StatusInput::new(kata, kind, claude) {
        Ok(input) => status(input),
        // Every triple built above is one the table allows; falling here means
        // the matching code drifted from the table, which a test will catch.
        Err(_) => GivenStatus::SwitchedOff,
    }
}

/// A skill Claude loads is named `<skill>`, or `<plugin>:<skill>` when a plugin
/// brings it. The kit's plugin is Kata's own and its name is not fixed here, so
/// a run-spec skill matches under any prefix.
fn skill_matches(item: &ResolvedItem, reported: &str, plugin: Option<&str>) -> bool {
    match plugin {
        Some(p) => reported == format!("{p}:{}", item.name),
        None if item.source == Source::RunSpec => {
            reported.rsplit(':').next() == Some(item.name.as_str())
        }
        None => reported == item.name,
    }
}

/// An installed plugin is reported by its `<name>@<marketplace>`, which is its
/// key; a kit plugin has only a name.
fn plugin_matches(item: &ResolvedItem, reported: &str) -> bool {
    if reported.ends_with("@builtin") {
        return false;
    }
    let Ok(r) = parse_item_id(&item.id) else {
        return false;
    };
    if r.key.contains('@') {
        reported == r.key
    } else {
        reported.split('@').next() == Some(r.key.as_str())
    }
}

/// A plugin's tool servers are reported as `plugin:<plugin>:<server>`.
fn server_name(item: &ResolvedItem, plugin: Option<&str>) -> String {
    match plugin {
        Some(p) => format!("plugin:{p}:{}", item.name),
        None => item.name.clone(),
    }
}

/// A hook item is named `<event> <matcher or any>`. Claude names a fired hook
/// by its event, or `<event>:<matcher>` when it has a matcher, and the line has
/// no command. A bare event name therefore fires every hook of that event, and
/// a matcher fires the hooks of that event and matcher: two hooks that differ
/// only by command cannot be told apart, so both show as fired.
fn hook_matches(item: &ResolvedItem, fired: &HookFired) -> bool {
    let Some((event, matcher)) = item.name.split_once(' ') else {
        return false;
    };
    if event != fired.event {
        return false;
    }
    match fired.name.strip_prefix(&format!("{}:", fired.event)) {
        Some(m) => matcher == m,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::ClaudeSide as C;
    use super::GivenStatus as G;
    use super::KataSide as K;
    use super::*;
    use crate::given::ResolvedItem;
    use ItemKind as I;

    type Row = (u8, K, I, C, G, bool);

    /// Rows 1 to 27 of the status table: row, Kata side, kind, Claude side, shown,
    /// warning (R15.2). Rows 26 and 27 cover each of skill, plugin and tool server.
    fn rows() -> Vec<Row> {
        let mut r: Vec<Row> = vec![
            (1, K::Passed, I::Skill, C::Loaded, G::Given, false),
            (
                2,
                K::Passed,
                I::Skill,
                C::NotReported,
                G::PassedNotLoaded,
                false,
            ),
            (3, K::Passed, I::Plugin, C::Loaded, G::Given, false),
            (
                4,
                K::Passed,
                I::Plugin,
                C::NotReported,
                G::PassedNotLoaded,
                false,
            ),
            (5, K::Passed, I::ToolServer, C::Connected, G::Given, false),
            (
                6,
                K::Passed,
                I::ToolServer,
                C::FailedToConnect,
                G::GivenFailedToConnect,
                false,
            ),
            (
                7,
                K::Passed,
                I::ToolServer,
                C::NotReported,
                G::PassedNotLoaded,
                false,
            ),
            (8, K::Passed, I::Hook, C::Fired, G::GivenFired, false),
            (9, K::Passed, I::Hook, C::NotFired, G::GivenNotFired, false),
            (
                10,
                K::Passed,
                I::Instruction,
                C::NoReportOfKind,
                G::GivenUnconfirmed,
                false,
            ),
            (
                11,
                K::SwitchedOff,
                I::Skill,
                C::Loaded,
                G::SwitchedOffButLoaded,
                true,
            ),
            (
                12,
                K::SwitchedOff,
                I::Plugin,
                C::Loaded,
                G::SwitchedOffButLoaded,
                true,
            ),
            (
                13,
                K::SwitchedOff,
                I::ToolServer,
                C::Connected,
                G::SwitchedOffButLoaded,
                true,
            ),
            (
                14,
                K::SwitchedOff,
                I::ToolServer,
                C::FailedToConnect,
                G::SwitchedOffButLoaded,
                true,
            ),
            (
                15,
                K::SwitchedOff,
                I::Hook,
                C::Fired,
                G::SwitchedOffButFired,
                true,
            ),
            (
                16,
                K::SwitchedOff,
                I::Skill,
                C::NotReported,
                G::SwitchedOff,
                false,
            ),
            (
                17,
                K::SwitchedOff,
                I::Plugin,
                C::NotReported,
                G::SwitchedOff,
                false,
            ),
            (
                18,
                K::SwitchedOff,
                I::ToolServer,
                C::NotReported,
                G::SwitchedOff,
                false,
            ),
            (
                19,
                K::SwitchedOff,
                I::Hook,
                C::NotFired,
                G::SwitchedOff,
                false,
            ),
            (
                20,
                K::SwitchedOff,
                I::Instruction,
                C::NoReportOfKind,
                G::SwitchedOffUnconfirmed,
                false,
            ),
            (
                21,
                K::DidNotKnow,
                I::Skill,
                C::Loaded,
                G::LoadedSourceUnknown,
                false,
            ),
            (
                22,
                K::DidNotKnow,
                I::Plugin,
                C::Loaded,
                G::LoadedSourceUnknown,
                false,
            ),
            (
                23,
                K::DidNotKnow,
                I::ToolServer,
                C::Connected,
                G::LoadedSourceUnknown,
                false,
            ),
            (
                24,
                K::DidNotKnow,
                I::ToolServer,
                C::FailedToConnect,
                G::LoadedSourceUnknownFailedToConnect,
                false,
            ),
            (
                25,
                K::DidNotKnow,
                I::Hook,
                C::Fired,
                G::FiredSourceUnknown,
                false,
            ),
        ];
        for kind in [I::Skill, I::Plugin, I::ToolServer] {
            r.push((
                26,
                K::Passed,
                kind,
                C::NoStartReport,
                G::PassedNoStartReport,
                false,
            ));
            r.push((
                27,
                K::SwitchedOff,
                kind,
                C::NoStartReport,
                G::SwitchedOffNoStartReport,
                false,
            ));
        }
        r
    }

    // R15.1
    #[test]
    fn status_decides_every_row_of_the_status_table() {
        let rows = rows();
        for n in 1..=27u8 {
            assert!(rows.iter().any(|r| r.0 == n), "row {n} is not covered");
        }
        for (n, kata, kind, claude, shown, warns) in rows {
            let input = StatusInput::new(kata, kind, claude)
                .unwrap_or_else(|e| panic!("row {n} must be possible: {e}"));
            let got = status(input);
            assert_eq!(got, shown, "row {n}: {kata:?} {kind:?} {claude:?}");
            assert_eq!(got.warns(), warns, "row {n} warning");
        }
    }

    // Row 28.
    #[test]
    fn the_input_pair_rejects_what_cannot_occur() {
        let kinds = [I::Hook, I::Skill, I::Plugin, I::Instruction, I::ToolServer];
        let kata_sides = [K::Passed, K::SwitchedOff, K::DidNotKnow];
        let claude_sides = [
            C::Loaded,
            C::Connected,
            C::FailedToConnect,
            C::NotReported,
            C::Fired,
            C::NotFired,
            C::NoReportOfKind,
            C::NoStartReport,
        ];
        let allowed: Vec<(K, I, C)> = rows().into_iter().map(|r| (r.1, r.2, r.3)).collect();
        for kata in kata_sides {
            for kind in kinds {
                for claude in claude_sides {
                    let ok = StatusInput::new(kata, kind, claude).is_ok();
                    assert_eq!(
                        ok,
                        allowed.contains(&(kata, kind, claude)),
                        "{kata:?} {kind:?} {claude:?}"
                    );
                }
            }
        }
        // Row 28 by name: an item neither Kata passed nor Claude reported.
        for claude in [
            C::NotReported,
            C::NotFired,
            C::NoReportOfKind,
            C::NoStartReport,
        ] {
            for kind in kinds {
                assert!(StatusInput::new(K::DidNotKnow, kind, claude).is_err());
            }
        }
        // A kind's report uses only that kind's values.
        assert!(StatusInput::new(K::Passed, I::Hook, C::Loaded).is_err());
        assert!(StatusInput::new(K::Passed, I::Skill, C::Connected).is_err());
        assert!(StatusInput::new(K::Passed, I::Instruction, C::Loaded).is_err());
    }

    fn item(
        kind: ItemKind,
        source: Source,
        key: &str,
        name: &str,
        by: Option<&str>,
        off: bool,
    ) -> ResolvedItem {
        ResolvedItem {
            id: super::super::item_id(kind, source, key),
            kind,
            source,
            name: name.into(),
            detail: String::new(),
            path: None,
            brought_by: by.map(String::from),
            lock: None,
            off,
        }
    }

    #[test]
    fn claudes_report_is_matched_to_items_and_the_rest_is_listed_as_unknown() {
        use crate::event::McpState;
        let td = tempfile::tempdir().unwrap();
        let roots = crate::given::ResolveRoots {
            home: td.path().join("home"),
            workdir: td.path().join("work"),
            managed_settings: td.path().join("managed.json"),
            claude_json: td.path().join("home/.claude.json"),
        };
        let mut resolved = crate::given::resolve(
            &crate::spec::RunSpec::default(),
            &roots,
            &crate::given::ResolveOptions::default(),
        );
        let plugin_id = "personal:plugin:pers@mkt";
        resolved.items = vec![
            item(I::Plugin, Source::Personal, "pers@mkt", "pers", None, false),
            item(
                I::Skill,
                Source::Plugin,
                "pers@mkt:deep",
                "deep",
                Some(plugin_id),
                false,
            ),
            item(I::Skill, Source::Personal, "mine", "mine", None, true),
            item(I::Skill, Source::RunSpec, "kit", "kit", None, false),
            item(
                I::ToolServer,
                Source::Plugin,
                "pers@mkt:db",
                "db",
                Some(plugin_id),
                false,
            ),
            item(I::ToolServer, Source::Project, "srv", "srv", None, false),
            item(
                I::Hook,
                Source::Personal,
                "PreToolUse:Bash:aa",
                "PreToolUse Bash",
                None,
                false,
            ),
            item(
                I::Hook,
                Source::Personal,
                "PreToolUse:Edit:bb",
                "PreToolUse Edit",
                None,
                false,
            ),
            item(
                I::Hook,
                Source::Personal,
                "Stop:*:cc",
                "Stop any",
                None,
                true,
            ),
        ];
        let init = InitReport {
            skills: vec![
                "pers:deep".into(),
                "mine".into(),
                "kata-kit:kit".into(),
                "bundled".into(),
            ],
            plugins: vec![
                "pers@mkt".into(),
                "other@mkt".into(),
                "cc-plugin-x@builtin".into(),
            ],
            mcp_servers: vec![
                ("plugin:pers:db".into(), McpState::Failed),
                ("srv".into(), McpState::Connected),
                ("claude.ai Docs".into(), McpState::Connected),
            ],
            ..InitReport::default()
        };
        let fired = vec![
            HookFired {
                event: "PreToolUse".into(),
                name: "PreToolUse:Bash".into(),
                command: None,
            },
            HookFired {
                event: "Stop".into(),
                name: "Stop".into(),
                command: None,
            },
            HookFired {
                event: "SessionStart".into(),
                name: "SessionStart".into(),
                command: None,
            },
        ];
        let KataEvent::RunGiven {
            items, warnings, ..
        } = given_event(&resolved, Some(&init), &fired)
        else {
            panic!("not a run.given");
        };
        let by_name = |name: &str| items.iter().find(|i| i.name == name).unwrap().status;
        assert_eq!(by_name("pers"), G::Given);
        assert_eq!(by_name("deep"), G::Given);
        assert_eq!(by_name("mine"), G::SwitchedOffButLoaded);
        assert_eq!(by_name("kit"), G::Given);
        assert_eq!(by_name("db"), G::GivenFailedToConnect);
        assert_eq!(by_name("srv"), G::Given);
        assert_eq!(by_name("PreToolUse Bash"), G::GivenFired);
        assert_eq!(by_name("PreToolUse Edit"), G::GivenNotFired);
        assert_eq!(by_name("Stop any"), G::SwitchedOffButFired);
        // What Claude reported that no item matches; its own plugins are left out.
        assert_eq!(by_name("bundled"), G::LoadedSourceUnknown);
        assert_eq!(by_name("other@mkt"), G::LoadedSourceUnknown);
        assert_eq!(by_name("claude.ai Docs"), G::LoadedSourceUnknown);
        assert_eq!(by_name("SessionStart"), G::FiredSourceUnknown);
        assert!(!items.iter().any(|i| i.name.contains("builtin")));
        assert_eq!(items.len(), 9 + 4);
        assert_eq!(
            warnings,
            vec![
                "mine was switched off, but Claude loaded it".to_string(),
                "Stop any was switched off, but it fired".to_string(),
            ]
        );
    }
}
