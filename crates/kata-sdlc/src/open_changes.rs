//! The home's list rules: which system it shows, which changes are open and which finished, whether a
//! refresh must list again, and which open changes the GitHub merge check asks about.
use crate::ai_sdlc::list::{ChangeList, Finished};
use crate::ai_sdlc::state::ChangeState;
use crate::offer::HomeReading;
use crate::view::ChangeView;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// An open change as the home lists it at once: its name and title.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ListedChange {
    pub change: String,
    pub title: Option<String>,
}

/// A finished change with the mark the workflow gave it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct FinishedChange {
    pub change: String,
    pub title: Option<String>,
    pub finished: Finished,
}

/// What made the home refresh.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "kebab-case"))]
pub enum Refresh {
    Open,
    ActionEnded,
    Focus,
}

/// What the home lists for a workspace: nothing new on a plugin older than 1.3.0 (the page asks `sdlc_state`
/// as before), else the shown system with its open and finished changes.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub enum HomeList {
    Legacy,
    Listed {
        system: Option<String>,
        systems: Vec<String>,
        open: Vec<ListedChange>,
        finished: Vec<FinishedChange>,
        finished_count: usize,
        can_start_change: bool,
        start_change_reason: Option<String>,
    },
}

/// One open change's row: its view and what the row reads and offers.
#[derive(Serialize, Clone, Debug)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct HomeRow {
    pub view: ChangeView,
    pub reading: HomeReading,
}

/// The answer to opening or refreshing the home: the open changes' rows, the changes the merge check should
/// now be asked about, whether the light list must be read again, and what could not be read.
#[derive(Serialize, Clone, Debug)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct HomeOpen {
    pub rows: Vec<HomeRow>,
    pub check: Vec<String>,
    pub relist: bool,
    pub problems: Vec<String>,
}

/// The rows the merge check relabelled, and the checks that failed.
#[derive(Serialize, Clone, Debug)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct HomeChecked {
    pub rows: Vec<HomeRow>,
    pub problems: Vec<String>,
}

/// The system the home shows: the remembered one when the marker still has it, else the first.
pub fn shown_system(remembered: Option<&str>, systems: &[String]) -> Option<String> {
    remembered
        .and_then(|r| systems.iter().find(|s| s.as_str() == r))
        .or_else(|| systems.first())
        .cloned()
}

/// Open and finished changes, each in the order the plugin listed them. Only `finished` is read.
pub fn split(list: ChangeList) -> (Vec<ListedChange>, Vec<FinishedChange>) {
    let mut open = Vec::new();
    let mut finished = Vec::new();
    for c in list.changes {
        match c.finished {
            None => open.push(ListedChange {
                change: c.change,
                title: c.title,
            }),
            Some(mark) => finished.push(FinishedChange {
                change: c.change,
                title: c.title,
                finished: mark,
            }),
        }
    }
    (open, finished)
}

/// True when the open change names the screen shows differ, as a set, from the ones just reported.
pub fn relist(shown: &[String], open: &[ChangeState]) -> bool {
    let shown: BTreeSet<&str> = shown.iter().map(String::as_str).collect();
    let open: BTreeSet<&str> = open.iter().map(|c| c.change.as_str()).collect();
    shown != open
}

/// The open changes the merge check asks about, in order.
pub fn to_check(
    trigger: Refresh,
    open: &[ChangeState],
    declared: &BTreeSet<String>,
) -> Vec<String> {
    match trigger {
        Refresh::Open | Refresh::ActionEnded => open
            .iter()
            .filter(|c| declared.contains(&c.change))
            .map(|c| c.change.clone())
            .collect(),
        Refresh::Focus => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_sdlc::list::ChangeListing;
    use crate::ai_sdlc::state::ChangeTrack;
    use crate::permissions::fixtures::change_state;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn shown_system_rows() {
        let both = names(&["bob", "kata"]);
        #[allow(clippy::type_complexity)]
        let rows: Vec<(&str, Option<&str>, Vec<String>, Option<&str>)> = vec![
            ("empty, none", None, vec![], None),
            ("empty, remembered", Some("kata"), vec![], None),
            ("none remembered", None, both.clone(), Some("bob")),
            (
                "remembered in list",
                Some("kata"),
                both.clone(),
                Some("kata"),
            ),
            ("remembered gone", Some("gone"), both.clone(), Some("bob")),
        ];
        for (label, remembered, systems, expected) in rows {
            assert_eq!(
                shown_system(remembered, &systems).as_deref(),
                expected,
                "{label}"
            );
        }
    }

    fn listing(change: &str, title: Option<&str>, finished: Option<Finished>) -> ChangeListing {
        ChangeListing {
            change: change.into(),
            title: title.map(String::from),
            track: ChangeTrack::Full,
            master: "/m".into(),
            in_copy: false,
            finished,
        }
    }

    #[test]
    fn split_reads_finished_only() {
        let list = ChangeList {
            system: "kata".into(),
            changes: vec![
                listing("2026-11-01-a", Some("A"), None),
                listing("2026-11-03-c", Some("C"), Some(Finished::Merged)),
                listing("2026-11-02-b", None, Some(Finished::Rejected)),
                listing("2026-11-04-d", Some("D"), None),
            ],
            problems: vec![],
        };
        let (open, finished) = split(list);
        let expected_open = vec![
            ListedChange {
                change: "2026-11-01-a".into(),
                title: Some("A".into()),
            },
            ListedChange {
                change: "2026-11-04-d".into(),
                title: Some("D".into()),
            },
        ];
        assert_eq!(open, expected_open);
        let expected_finished = vec![
            FinishedChange {
                change: "2026-11-03-c".into(),
                title: Some("C".into()),
                finished: Finished::Merged,
            },
            FinishedChange {
                change: "2026-11-02-b".into(),
                title: None,
                finished: Finished::Rejected,
            },
        ];
        assert_eq!(finished, expected_finished);
    }

    fn open_states(list: &[&str]) -> Vec<ChangeState> {
        list.iter().map(|c| change_state(c, "/m", false)).collect()
    }

    #[test]
    fn relist_rows() {
        let open = open_states(&["a", "b"]);
        assert!(!relist(&names(&["b", "a"]), &open), "same set, other order");
        assert!(relist(&names(&["a", "b", "c"]), &open), "a name left");
        assert!(relist(&names(&["a"]), &open), "a new name");
        assert!(!relist(&[], &[]), "both empty");
    }

    #[test]
    fn to_check_rows() {
        let mut open = open_states(&["a", "b", "c"]);
        open[2].ready.done.candidate = true;
        let declared: BTreeSet<String> = ["a".to_string()].into();
        let rows = [
            (Refresh::Open, vec!["a"]),
            (Refresh::ActionEnded, vec!["a"]),
            (Refresh::Focus, vec![]),
        ];
        for (trigger, expected) in rows {
            assert_eq!(to_check(trigger, &open, &declared), expected, "{trigger:?}");
        }
        let none = BTreeSet::new();
        assert!(to_check(Refresh::Open, &open, &none).is_empty());
        assert!(to_check(Refresh::ActionEnded, &open, &none).is_empty());
        let two: BTreeSet<String> = ["b".to_string(), "a".to_string()].into();
        assert_eq!(to_check(Refresh::Open, &open, &two), ["a", "b"]);
    }
}
