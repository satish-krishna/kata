//! The AI-SDLC home's commands: the open changes of the shown system, read alone, and what the pull request
//! merge check last said about each. The Tauri commands in `lib.rs` are one-line wrappers over [`home_list`],
//! [`home_open`] and [`home_pull_requests`], so this module is testable without Tauri.
use kata_sdlc::ai_sdlc::list::ChangeList;
use kata_sdlc::ai_sdlc::state::{ChangeState, SystemState};
use kata_sdlc::ai_sdlc::{Program, ProgramError};
use kata_sdlc::copy_removal::CopyRemoval;
use kata_sdlc::offer::LiveFacts;
use kata_sdlc::open_changes::{HomeChecked, HomeList, HomeOpen, Refresh};
use kata_sdlc::plugin::Readiness;
use kata_sdlc::view::ChangeView;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

/// Where the home's answers come from; the plugin's program in the app, a fake in tests.
pub trait HomeSource: Sync {
    /// The light list of every change of `system`, open and finished.
    fn list(&self, folder: &Path, system: &str) -> Result<ChangeList, String>;
    /// The open changes of `system`, read alone.
    fn open_states(&self, folder: &Path, system: &str) -> Result<SystemState, String>;
    /// Whether `change` was declared done, read on this machine with no network.
    fn declared(&self, folder: &Path, system: &str, change: &str) -> Result<bool, String>;
    /// Whether the declared change's pull requests are all merged and its copy may be removed (asks GitHub).
    fn merge_check(&self, folder: &Path, change: &ChangeState) -> Result<CopyRemoval, String>;
}

fn program_error(e: ProgramError) -> String {
    e.to_string()
}

impl HomeSource for Program {
    fn list(&self, folder: &Path, system: &str) -> Result<ChangeList, String> {
        let place = self.resolve(folder).map_err(program_error)?;
        Program::list(self, &place, system).map_err(program_error)
    }
    fn open_states(&self, folder: &Path, system: &str) -> Result<SystemState, String> {
        kata_sdlc::ai_sdlc::state::open(self, folder, system).map_err(program_error)
    }
    fn declared(&self, folder: &Path, system: &str, change: &str) -> Result<bool, String> {
        let place = self.resolve(folder).map_err(program_error)?;
        let workspace_id = crate::build_host::workspace_id_in_store(folder);
        kata_sdlc::pull_requests::read_view(
            self,
            &place,
            workspace_id.as_deref(),
            system,
            change,
            false,
        )
        .map(|view| view.done)
    }
    fn merge_check(&self, folder: &Path, change: &ChangeState) -> Result<CopyRemoval, String> {
        let place = self.resolve(folder).map_err(program_error)?;
        kata_sdlc::copy_removal::offer(self, &place, change)
    }
}

type Key = (String, String, String);

#[derive(Default)]
struct Remembered {
    view: Option<ChangeView>,
    check: Option<CopyRemoval>,
}

/// What the home remembers between its calls: each open change's last view, and its last merge check, the only
/// GitHub answer kept. Memory only.
#[derive(Default)]
pub struct HomeMemory {
    rows: Mutex<BTreeMap<Key, Remembered>>,
}

/// The home's list for the saved workspace: the shown system's open and finished changes. A plugin older than
/// 1.3.0 answers `Legacy`, and the program is not asked.
pub fn home_list(
    _source: &dyn HomeSource,
    _readiness: &Readiness,
    _remembered: Option<&str>,
    _folder: &Path,
    _systems: &[String],
) -> Result<HomeList, String> {
    todo!()
}

/// The open changes of `system` with their views and rows. `shown` is the change names the screen shows.
#[allow(clippy::too_many_arguments)]
pub fn home_open(
    _source: &dyn HomeSource,
    _readiness: &Readiness,
    _live: &dyn Fn(&str, &str) -> LiveFacts,
    _folder: &Path,
    _system: &str,
    _shown: &[String],
    _trigger: Refresh,
    _memory: &HomeMemory,
) -> Result<HomeOpen, String> {
    todo!()
}

/// Asks the merge check about `changes` side by side and relabels their rows.
pub fn home_pull_requests(
    _source: &dyn HomeSource,
    _readiness: &Readiness,
    _folder: &Path,
    _system: &str,
    _changes: &[String],
    _memory: &HomeMemory,
) -> Result<HomeChecked, String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kata_sdlc::ai_sdlc::list::{ChangeListing, Finished};
    use kata_sdlc::ai_sdlc::state::read_state;
    use kata_sdlc::offer::HomeAction;
    use kata_sdlc::plugin::{GhPresence, Plugin};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const STATE: &str = r#"{"system":"kata","changes":[{"change":"NAME","master":"/ws/.ai-sdlc/copies/NAME","folder":"/ws/.ai-sdlc/copies/NAME/intent/kata/NAME","inCopy":true,"title":"T","track":"full",
 "documents":{"intent":{"exists":true,"inHead":true,"headStatus":"accepted","workingStatus":"accepted","uncommitted":false},"spec":{"exists":true,"inHead":true,"headStatus":"accepted","workingStatus":"accepted","uncommitted":false,"pin":"holds"},"plan":{"exists":true,"inHead":true,"headStatus":"accepted","workingStatus":"accepted","uncommitted":false,"pin":"holds"}},
 "scenarios":2,"tasks":{"app":{"all":["T1"],"logged":["T1"],"unlogged":[],"commits":{"T1":["4f1c2a9e0b7d3c5a8e6f1b2d4c7a9e0f3b5d8c1a"]},"untasked":[],"uncommitted":[]}},"buildLogs":{"app":"clean"},"review":{"committed":0,"draft":"none"},"fix":null,
 "ready":{"spec":{"candidate":false,"stop":null,"accept":[]},"plan":{"candidate":false,"stop":null,"accept":[]},"build":{"candidate":false,"stop":null,"accept":[]},"review":{"candidate":false,"stop":null,"accept":[]},"done":{"candidate":DONE,"stop":null,"accept":[]},"reject":{"candidate":false,"stop":null,"accept":[]}}}],"problems":[]}"#;

    fn change(name: &str, done_candidate: bool) -> ChangeState {
        let json = STATE
            .replace("NAME", name)
            .replace("DONE", &done_candidate.to_string());
        read_state(serde_json::from_str(&json).unwrap())
            .unwrap()
            .changes
            .remove(0)
    }

    fn ready(version: &str) -> Readiness {
        Readiness::Ready {
            plugin: Plugin {
                dir: PathBuf::from("plugin"),
                version: version.into(),
                layouts: vec![],
            },
            gh: GhPresence::Present,
        }
    }

    fn no_live(_: &str, _: &str) -> LiveFacts {
        LiveFacts::default()
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[derive(Default)]
    struct Fake {
        open: Vec<ChangeState>,
        declared: Vec<String>,
        declared_fails: Vec<String>,
        merge: BTreeMap<String, Result<CopyRemoval, String>>,
        open_fails: Option<String>,
        listing: Vec<(String, Option<Finished>)>,
        lists: AtomicUsize,
        opens: AtomicUsize,
        declared_asked: Mutex<Vec<String>>,
        merge_asked: Mutex<Vec<String>>,
    }

    impl HomeSource for Fake {
        fn list(&self, _: &Path, system: &str) -> Result<ChangeList, String> {
            self.lists.fetch_add(1, Ordering::SeqCst);
            Ok(ChangeList {
                system: system.into(),
                changes: self
                    .listing
                    .iter()
                    .map(|(name, finished)| ChangeListing {
                        change: name.clone(),
                        title: None,
                        track: kata_sdlc::ai_sdlc::state::ChangeTrack::Full,
                        master: "/m".into(),
                        in_copy: false,
                        finished: finished.clone(),
                    })
                    .collect(),
                problems: vec![],
            })
        }
        fn open_states(&self, _: &Path, system: &str) -> Result<SystemState, String> {
            self.opens.fetch_add(1, Ordering::SeqCst);
            if let Some(words) = &self.open_fails {
                return Err(words.clone());
            }
            Ok(SystemState {
                system: system.into(),
                changes: self.open.clone(),
                problems: vec![],
            })
        }
        fn declared(&self, _: &Path, _: &str, change: &str) -> Result<bool, String> {
            self.declared_asked.lock().unwrap().push(change.into());
            if self.declared_fails.iter().any(|c| c == change) {
                return Err(format!("cannot read {change}"));
            }
            Ok(self.declared.iter().any(|c| c == change))
        }
        fn merge_check(&self, _: &Path, change: &ChangeState) -> Result<CopyRemoval, String> {
            self.merge_asked.lock().unwrap().push(change.change.clone());
            self.merge
                .get(&change.change)
                .cloned()
                .unwrap_or(Ok(CopyRemoval::NotOffered))
        }
    }

    /// Three open changes: `a` declared, `b` reviewed but not declared, `c` building.
    fn three() -> Fake {
        Fake {
            open: vec![change("a", true), change("b", true), change("c", false)],
            declared: names(&["a"]),
            ..Default::default()
        }
    }

    fn open(
        fake: &Fake,
        trigger: Refresh,
        shown: &[&str],
        memory: &HomeMemory,
    ) -> Result<HomeOpen, String> {
        home_open(
            fake,
            &ready("1.3.1"),
            &no_live,
            Path::new("/ws"),
            "kata",
            &names(shown),
            trigger,
            memory,
        )
    }

    fn text<'a>(open: &'a HomeOpen, change: &str) -> &'a str {
        &open
            .rows
            .iter()
            .find(|r| r.view.state.change == change)
            .unwrap()
            .reading
            .label
            .text
    }

    #[test]
    fn pull_request_check_follows_the_trigger() {
        let fake = three();
        let memory = HomeMemory::default();
        let shown = ["a", "b", "c"];
        for trigger in [Refresh::Open, Refresh::ActionEnded] {
            let answer = open(&fake, trigger, &shown, &memory).unwrap();
            assert_eq!(text(&answer, "a"), "Done · pull requests open");
            assert_eq!(answer.check, ["a"], "{trigger:?}");
        }
        let answer = open(&fake, Refresh::Focus, &shown, &memory).unwrap();
        assert!(answer.check.is_empty());
        assert_eq!(text(&answer, "a"), "Done · pull requests open");
        assert!(fake.merge_asked.lock().unwrap().is_empty());

        let mut fake = three();
        fake.merge.insert("a".into(), Ok(CopyRemoval::Offer));
        let checked =
            home_pull_requests(&fake, &ready("1.3.1"), Path::new("/ws"), "kata", &names(&["a"]), &memory)
                .unwrap();
        assert_eq!(checked.rows[0].reading.label.text, "Done · merged, remove the copy");
        let answer = open(&fake, Refresh::Focus, &shown, &memory).unwrap();
        assert_eq!(text(&answer, "a"), "Done · merged, remove the copy");
        let row = answer.rows.iter().find(|r| r.view.state.change == "a").unwrap();
        assert_eq!(row.reading.action, HomeAction::RemoveCopy);
        assert_eq!(*fake.merge_asked.lock().unwrap(), ["a"], "one check, none on focus");
        let asked = fake.declared_asked.lock().unwrap();
        assert!(asked.iter().all(|c| c == "a" || c == "b"), "{asked:?}");
        assert!(!asked.iter().any(|c| c == "c"));
    }

    #[test]
    fn an_older_plugin_answers_legacy_without_asking() {
        struct Panics;
        impl HomeSource for Panics {
            fn list(&self, _: &Path, _: &str) -> Result<ChangeList, String> {
                panic!("asked")
            }
            fn open_states(&self, _: &Path, _: &str) -> Result<SystemState, String> {
                panic!("asked")
            }
            fn declared(&self, _: &Path, _: &str, _: &str) -> Result<bool, String> {
                panic!("asked")
            }
            fn merge_check(&self, _: &Path, _: &ChangeState) -> Result<CopyRemoval, String> {
                panic!("asked")
            }
        }
        let blocked = Readiness::missing();
        for readiness in [ready("1.2.0"), blocked] {
            let answer = home_list(
                &Panics,
                &readiness,
                Some("kata"),
                Path::new("/ws"),
                &names(&["kata"]),
            )
            .unwrap();
            assert_eq!(answer, HomeList::Legacy);
        }
    }

    #[test]
    fn home_open_reads_open_changes_only() {
        let fake = three();
        let memory = HomeMemory::default();
        let same = open(&fake, Refresh::Focus, &["c", "b", "a"], &memory).unwrap();
        assert!(!same.relist);
        assert_eq!(same.rows.len(), 3);
        let gone = open(&fake, Refresh::Focus, &["a", "b", "c", "d"], &memory).unwrap();
        assert!(gone.relist);
        assert_eq!(fake.opens.load(Ordering::SeqCst), 2);
        assert_eq!(fake.lists.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn home_list_splits_and_picks() {
        let fake = Fake {
            listing: vec![
                ("2026-11-01-a".into(), None),
                ("2026-11-02-b".into(), Some(Finished::Merged)),
                ("2026-11-03-c".into(), Some(Finished::Rejected)),
            ],
            ..Default::default()
        };
        let answer = home_list(
            &fake,
            &ready("1.3.1"),
            Some("kata"),
            Path::new("/ws"),
            &names(&["bob", "kata"]),
        )
        .unwrap();
        match answer {
            HomeList::Listed {
                system,
                systems,
                open,
                finished,
                finished_count,
                can_start_change,
                ..
            } => {
                assert_eq!(system.as_deref(), Some("kata"));
                assert_eq!(systems, names(&["bob", "kata"]));
                assert_eq!(open.len(), 1);
                assert_eq!(finished.len(), 2);
                assert_eq!(finished_count, 2);
                assert!(can_start_change);
            }
            HomeList::Legacy => panic!("expected a listed home"),
        }
        let none = home_list(&fake, &ready("1.3.1"), None, Path::new("/ws"), &[]).unwrap();
        assert!(matches!(none, HomeList::Listed { system: None, ref open, .. } if open.is_empty()));
    }

    #[test]
    fn a_failed_read_is_the_programs_words() {
        let memory = HomeMemory::default();
        let fake = Fake {
            open_fails: Some("the program said no".into()),
            ..three()
        };
        let err = open(&fake, Refresh::Open, &["a"], &memory).err().unwrap();
        assert_eq!(err, "the program said no");

        let mut fake = three();
        fake.declared = names(&["a", "b"]);
        let answer = open(&fake, Refresh::Open, &["a", "b", "c"], &memory).unwrap();
        assert_eq!(answer.check, ["a", "b"]);
        fake.merge.insert("a".into(), Err("gh failed".into()));
        fake.merge.insert("b".into(), Ok(CopyRemoval::Offer));
        let checked = home_pull_requests(
            &fake,
            &ready("1.3.1"),
            Path::new("/ws"),
            "kata",
            &names(&["a", "b"]),
            &memory,
        )
        .unwrap();
        assert_eq!(checked.rows.len(), 1);
        assert_eq!(checked.rows[0].view.state.change, "b");
        assert_eq!(checked.problems, ["gh failed"]);
        let answer = open(&fake, Refresh::Focus, &["a", "b", "c"], &memory).unwrap();
        assert_eq!(text(&answer, "a"), "Done · pull requests open");

        let fake = Fake {
            declared_fails: names(&["a"]),
            ..three()
        };
        let answer = open(&fake, Refresh::Open, &["a", "b", "c"], &HomeMemory::default()).unwrap();
        assert_eq!(answer.problems.len(), 1);
        assert_ne!(text(&answer, "a"), "Done · pull requests open");
        assert!(answer.check.is_empty());
    }
}
