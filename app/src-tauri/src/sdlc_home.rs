//! The AI-SDLC home's commands: the open changes of the shown system, read alone, and what the pull request
//! merge check last said about each. The Tauri commands in `lib.rs` are one-line wrappers over [`home_list`],
//! [`home_open`] and [`home_pull_requests`], so this module is testable without Tauri.
use crate::sdlc_state::view_of;
use kata_sdlc::ai_sdlc::list::ChangeList;
use kata_sdlc::ai_sdlc::state::{ChangeState, SystemState};
use kata_sdlc::ai_sdlc::{Program, ProgramError};
use kata_sdlc::copy_removal::CopyRemoval;
use kata_sdlc::offer::{home_reading, LiveFacts};
use kata_sdlc::open_changes::{
    relist, shown_system, split, to_check, HomeChecked, HomeList, HomeOpen, HomeRow, Refresh,
};
use kata_sdlc::plugin::Readiness;
use kata_sdlc::view::ChangeView;
use std::collections::{BTreeMap, BTreeSet};
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
    source: &dyn HomeSource,
    readiness: &Readiness,
    remembered: Option<&str>,
    folder: &Path,
    systems: &[String],
) -> Result<HomeList, String> {
    if !kata_sdlc::plugin::lists_changes(readiness) {
        return Ok(HomeList::Legacy);
    }
    let system = shown_system(remembered, systems);
    let (open, finished) = match &system {
        Some(system) => split(source.list(folder, system)?),
        None => (Vec::new(), Vec::new()),
    };
    let (can_start_change, start_change_reason) = match readiness {
        Readiness::Blocked { message, .. } => (false, Some(message.clone())),
        Readiness::Ready { .. } => (true, None),
    };
    Ok(HomeList::Listed {
        system,
        systems: systems.to_vec(),
        open,
        finished_count: finished.len(),
        finished,
        can_start_change,
        start_change_reason,
    })
}

fn key(folder: &Path, system: &str, change: &str) -> Key {
    (folder.display().to_string(), system.into(), change.into())
}

/// The open changes of `system` with their views and rows. `shown` is the change names the screen shows.
#[allow(clippy::too_many_arguments)]
pub fn home_open(
    source: &dyn HomeSource,
    readiness: &Readiness,
    live: &dyn Fn(&str, &str) -> LiveFacts,
    folder: &Path,
    system: &str,
    shown: &[String],
    trigger: Refresh,
    memory: &HomeMemory,
) -> Result<HomeOpen, String> {
    if !kata_sdlc::plugin::lists_changes(readiness) {
        return Err("the installed ai-sdlc plugin cannot read open changes alone".into());
    }
    let found = source.open_states(folder, system)?;
    let mut problems = found.problems.clone();
    // Declaring done needs a committed review and every task logged, which is what the candidate means, so
    // any other change is not declared and costs no read.
    let reads: Vec<(String, Result<bool, String>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = found
            .changes
            .iter()
            .filter(|c| c.ready.done.candidate)
            .map(|c| {
                let name = c.change.clone();
                scope.spawn(move || {
                    let read = source.declared(folder, system, &name);
                    (name, read)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| (String::new(), Err("reading a change failed".into())))
            })
            .collect()
    });
    let mut declared = BTreeSet::new();
    for (name, read) in reads {
        match read {
            Ok(true) => {
                declared.insert(name);
            }
            Ok(false) => {}
            Err(reason) => problems.push(reason),
        }
    }
    let check = to_check(trigger, &found.changes, &declared);
    let relisted = relist(shown, &found.changes);
    let mut remembered = memory.rows.lock().unwrap();
    let open_keys: BTreeSet<Key> = found
        .changes
        .iter()
        .map(|c| key(folder, system, &c.change))
        .collect();
    remembered.retain(|k, _| {
        k.0 != folder.display().to_string() || k.1 != system || open_keys.contains(k)
    });
    let mut rows = Vec::new();
    for state in found.changes {
        let is_declared = declared.contains(&state.change);
        let k = key(folder, system, &state.change);
        let facts = live(system, &state.change);
        let view = view_of(state, readiness, facts);
        let entry = remembered.entry(k).or_default();
        if !is_declared {
            entry.check = None;
        }
        entry.view = Some(view.clone());
        let reading = home_reading(&view.offer, is_declared, entry.check.as_ref());
        rows.push(HomeRow { view, reading });
    }
    Ok(HomeOpen {
        rows,
        check,
        relist: relisted,
        problems,
    })
}

/// Asks the merge check about `changes` side by side and relabels their rows. A change the home has not
/// read is skipped; a check that fails leaves its row out, so it keeps its last reading.
pub fn home_pull_requests(
    source: &dyn HomeSource,
    readiness: &Readiness,
    folder: &Path,
    system: &str,
    changes: &[String],
    memory: &HomeMemory,
) -> Result<HomeChecked, String> {
    if !kata_sdlc::plugin::lists_changes(readiness) {
        return Err("the installed ai-sdlc plugin cannot read open changes alone".into());
    }
    let views: Vec<ChangeView> = {
        let remembered = memory.rows.lock().unwrap();
        changes
            .iter()
            .filter_map(|c| remembered.get(&key(folder, system, c))?.view.clone())
            .collect()
    };
    let answers: Vec<Result<CopyRemoval, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = views
            .iter()
            .map(|v| scope.spawn(move || source.merge_check(folder, &v.state)))
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| Err("checking a change failed".into()))
            })
            .collect()
    });
    let mut rows = Vec::new();
    let mut problems = Vec::new();
    let mut remembered = memory.rows.lock().unwrap();
    for (view, answer) in views.into_iter().zip(answers) {
        match answer {
            Ok(check) => {
                let reading = home_reading(&view.offer, true, Some(&check));
                if let Some(entry) = remembered.get_mut(&key(folder, system, &view.state.change)) {
                    entry.check = Some(check);
                }
                rows.push(HomeRow { view, reading });
            }
            Err(reason) => problems.push(reason),
        }
    }
    Ok(HomeChecked { rows, problems })
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
                        finished: *finished,
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
        let checked = home_pull_requests(
            &fake,
            &ready("1.3.1"),
            Path::new("/ws"),
            "kata",
            &names(&["a"]),
            &memory,
        )
        .unwrap();
        assert_eq!(
            checked.rows[0].reading.label.text,
            "Done · merged, remove the copy"
        );
        let answer = open(&fake, Refresh::Focus, &shown, &memory).unwrap();
        assert_eq!(text(&answer, "a"), "Done · merged, remove the copy");
        let row = answer
            .rows
            .iter()
            .find(|r| r.view.state.change == "a")
            .unwrap();
        assert_eq!(row.reading.action, HomeAction::RemoveCopy);
        assert_eq!(
            *fake.merge_asked.lock().unwrap(),
            ["a"],
            "one check, none on focus"
        );
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
        let answer = open(
            &fake,
            Refresh::Open,
            &["a", "b", "c"],
            &HomeMemory::default(),
        )
        .unwrap();
        assert_eq!(answer.problems.len(), 1);
        assert_ne!(text(&answer, "a"), "Done · pull requests open");
        assert!(answer.check.is_empty());
    }

    /// A stand-in for the ai-sdlc program that logs each command it is started with, so a test can count the
    /// `resolve` starts. It answers `resolve`, `list` and `state`; a `fail` file next to it makes the next
    /// `list` or `state` exit 2 and removes the file.
    fn recording_program(dir: &Path) -> Program {
        let entry = dir.join("ai-sdlc.ts");
        let script = r#"const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
const command = process.argv[2];
fs.appendFileSync(path.join(here, 'calls.log'), command + '\n');
if (command === 'resolve') {
  console.log(JSON.stringify({ master: here, workspace: here, problems: [] }));
} else if (fs.existsSync(path.join(here, 'fail'))) {
  fs.unlinkSync(path.join(here, 'fail'));
  console.error('boom');
  process.exit(2);
} else if (command === 'list') {
  console.log(JSON.stringify({ system: 'kata', changes: [], problems: [] }));
} else {
  console.log(JSON.stringify(JSON.parse(fs.readFileSync(path.join(here, 'state.json'), 'utf8'))));
}
"#;
        std::fs::write(&entry, script).unwrap();
        let state = STATE.replace("NAME", "a").replace("DONE", "false");
        std::fs::write(dir.join("state.json"), state).unwrap();
        Program {
            node: "node".into(),
            entry,
        }
    }

    fn resolves(dir: &Path) -> usize {
        std::fs::read_to_string(dir.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .filter(|l| *l == "resolve")
            .count()
    }

    #[test]
    fn the_program_resolves_a_folder_once_and_again_after_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let program = recording_program(dir.path());
        let readiness = ready("1.3.1");
        let systems = names(&["kata"]);
        let memory = HomeMemory::default();
        let folder = dir.path();
        home_list(&program, &readiness, None, folder, &systems).unwrap();
        home_open(
            &program,
            &readiness,
            &no_live,
            folder,
            "kata",
            &names(&["a"]),
            Refresh::Open,
            &memory,
        )
        .unwrap();
        assert_eq!(resolves(dir.path()), 1, "list then open resolve once");
        std::fs::write(dir.path().join("fail"), "").unwrap();
        assert!(home_list(&program, &readiness, None, folder, &systems).is_err());
        assert_eq!(resolves(dir.path()), 1, "the failed call used the cache");
        home_list(&program, &readiness, None, folder, &systems).unwrap();
        assert_eq!(
            resolves(dir.path()),
            2,
            "after an error the next call resolves again"
        );
    }

    // The speed targets (R11.1). Timings depend on the machine, so this runs only with KATA_SPEED_CHECK=1, the way the
    // real-claude smoke test waits for KATA_SMOKE_REAL; the routine suite and CI pass it without measuring.

    #[allow(clippy::disallowed_methods)]
    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(ws: &Path, name: &str) -> PathBuf {
        let dir = ws.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("README.md"), "init\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    const INTENT: &str = "---\ntitle: Speed\nstatus: accepted\n---\n\n# Intent\n";

    /// A workspace shaped like kata's: a master and one product repository, `open` changes started through the
    /// program (each with a copy and a committed intent), and `finished` changes whose intents are committed on
    /// `main` with no copy.
    fn speed_workspace(
        program: &Program,
        open: usize,
        finished: usize,
    ) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().canonicalize().unwrap();
        let master = init_repo(&ws, "ai-sdlc");
        std::fs::write(
            master.join(".ai-sdlc.json"),
            r#"{"version":1,"systems":{"kata":{"repos":["kata"]}}}"#,
        )
        .unwrap();
        init_repo(&ws, "kata");
        for n in 0..finished {
            let folder = master.join(format!("intent/kata/2026-09-{:02}-done-{n:03}", n % 28 + 1));
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("intent.md"), INTENT).unwrap();
        }
        git(&master, &["add", "."]);
        git(
            &master,
            &["commit", "-q", "-m", "marker and finished changes"],
        );
        let place = program.resolve(&ws).unwrap();
        for n in 0..open {
            let name = format!("2026-11-0{}-open-{n}", n + 1);
            let started = program
                .run(
                    &[
                        "change", "start", "--json", "--system", "kata", "--change", &name,
                        "--type", "feat", "--scope", "X-1", "--title", "Speed",
                    ],
                    &place,
                )
                .unwrap();
            assert_eq!(started["outcome"], "passed", "{started}");
            let copy = ws.join(".ai-sdlc").join("copies").join(&name);
            let folder = copy.join(format!("intent/kata/{name}"));
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("intent.md"), INTENT).unwrap();
            git(&copy, &["add", "."]);
            git(&copy, &["commit", "-q", "-m", "intent"]);
        }
        (dir, ws)
    }

    fn within(label: &str, took: std::time::Duration, limit_secs: u64, misses: &mut Vec<String>) {
        println!("speed_targets: {label}: {took:?} (limit {limit_secs} s)");
        if took.as_secs_f64() >= limit_secs as f64 {
            misses.push(format!("{label} took {took:?}, limit {limit_secs} s"));
        }
    }

    #[test]
    fn speed_targets() {
        if std::env::var("KATA_SPEED_CHECK").as_deref() != Ok("1") {
            println!("speed_targets: skipped, set KATA_SPEED_CHECK=1 to measure");
            return;
        }
        let program = Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../crates/kata-sdlc/tests/ai-sdlc-tools/ai-sdlc.ts"),
        };
        let readiness = ready("1.3.1");
        let systems = names(&["kata"]);
        let memory = HomeMemory::default();
        let mut misses = Vec::new();
        for finished in [19, 97] {
            let (_dir, ws) = speed_workspace(&program, 3, finished);
            let started = std::time::Instant::now();
            let listed = home_list(&program, &readiness, None, &ws, &systems).unwrap();
            let list_took = started.elapsed();
            let shown: Vec<String> = match &listed {
                HomeList::Listed {
                    open, finished: f, ..
                } => {
                    assert_eq!(f.len(), finished);
                    open.iter().map(|c| c.change.clone()).collect()
                }
                HomeList::Legacy => panic!("a 1.3.1 plugin answered Legacy"),
            };
            assert_eq!(shown.len(), 3, "{shown:?}");
            if finished == 19 {
                within(
                    "3 open, 19 finished: every open change's name",
                    list_took,
                    1,
                    &mut misses,
                );
            }
            let opened = home_open(
                &program,
                &readiness,
                &no_live,
                &ws,
                "kata",
                &shown,
                Refresh::Open,
                &memory,
            )
            .unwrap();
            let both = started.elapsed();
            assert_eq!(opened.rows.len(), 3);
            within(
                &format!("3 open, {finished} finished: every open change's stage"),
                both,
                3,
                &mut misses,
            );
            if finished == 19 {
                let started = std::time::Instant::now();
                let home = kata_sdlc::home::resolve(&program, &ws, "kata", &shown[0]).unwrap();
                let view = view_of(home.state, &readiness, LiveFacts::default());
                let took = started.elapsed();
                assert_eq!(view.state.change, shown[0]);
                within(
                    "3 open, 19 finished: the change page's stage and actions",
                    took,
                    2,
                    &mut misses,
                );
            }
        }
        assert!(misses.is_empty(), "speed targets missed: {misses:?}");
    }
}
