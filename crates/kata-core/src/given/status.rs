//! What the view says about an item: what Kata passed, what Claude reported, and
//! the one label that follows. The frontend labels the status it receives and
//! never derives it.

use super::{ItemKind, LockReason, Resolved, Source};
use crate::event::{HookFired, InitReport, KataEvent};
use serde::{Deserialize, Serialize};

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
        let _ = (kata, kind, claude);
        Err(ImpossibleStatus { kata, kind, claude })
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

pub fn status(input: StatusInput) -> GivenStatus {
    let _ = input;
    GivenStatus::Given
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
    let _ = (init, fired);
    KataEvent::RunGiven {
        items: Vec::new(),
        settings: resolved.settings.clone(),
        env: resolved.env.clone(),
        warnings: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::ClaudeSide as C;
    use super::GivenStatus as G;
    use super::KataSide as K;
    use super::*;
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
}
