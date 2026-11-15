//! Offering and running the migration from ai-sdlc to hoshin for a workspace folder. The program decides what the
//! migration is (`migrate`); this module decides only whether the Workbench may run it now: never while a run or a
//! build hold is working under the workspace, since the migration moves the copies those runs work in.
use crate::runs::{Lane, LiveSummary};
use kata_sdlc::holds::RepoKey;
use kata_sdlc::hoshin::migrate::{self, MigratePlan, StepStatus};
use kata_sdlc::hoshin::{Program, ProgramError};
use std::path::{Path, PathBuf};

/// The key of a folder's resolved form, the one way a path the program prints meets a path Kata holds: 8.3 short
/// names, a `\\?\` prefix, a mapped drive, a junction or a symlink all name one folder in different spellings. A
/// folder that is gone keeps its lexical key.
pub fn resolved_key(path: &Path) -> RepoKey {
    match std::fs::canonicalize(path) {
        Ok(real) => RepoKey::of(&strip_verbatim(real)),
        Err(_) => RepoKey::of(path),
    }
}

/// `resolved_key` for a key already held: the key's normalized path is resolved again.
pub fn resolved_held(key: &RepoKey) -> RepoKey {
    resolved_key(Path::new(key.path()))
}

/// Removes the Windows verbatim prefix `canonicalize` adds: `\\?\C:\x` becomes `C:\x`, `\\?\UNC\h\s` becomes
/// `\\h\s`.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest.to_string())
    } else {
        path
    }
}

/// Why the migration of `workspace` must wait, or `None` when nothing is working under it. A run counts by its
/// folder, a hold by its repository's folder, so a run in one of the workspace's change copies counts too. Every
/// folder is compared by its resolved form.
pub fn migration_blocked(
    workspace: &Path,
    live: &[LiveSummary],
    holds: &[PathBuf],
) -> Option<String> {
    let root = resolved_key(workspace);
    let folder_name = |p: &Path| {
        p.file_name()
            .map_or_else(|| p.display().to_string(), |n| n.to_string_lossy().into())
    };
    let mut names: Vec<String> = Vec::new();
    let mut add = |name: String| {
        if !names.contains(&name) {
            names.push(name);
        }
    };
    for run in live
        .iter()
        .filter(|r| root.contains(&resolved_key(&r.workdir)))
    {
        add(match &run.lane {
            Lane::Change { key, .. } => key.change.clone(),
            _ => folder_name(&run.workdir),
        });
    }
    for hold in holds.iter().filter(|h| root.contains(&resolved_key(h))) {
        add(folder_name(hold));
    }
    (!names.is_empty()).then(|| {
        format!(
            "Stop the runs in this workspace before migrating it: {}.",
            names.join(", ")
        )
    })
}

/// What the program says when no master repository of either marker name is there: the one answer of `migrate`
/// that means "this folder is not a workspace", not a fault.
const NO_MASTER: &str = "No master repository found";

/// What the offer is about: the marker still has to move (`SetUp`), or the marker is already `.hoshin.json` and
/// only this machine's files are left (`LocalFiles`).
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum OfferKind {
    SetUp,
    LocalFiles,
}

/// A migration the home offers: the program's plan, and how the home presents it. `blocks` is true only when the
/// folder does not open as a hoshin workspace yet (the `marker` step is not `current`); a folder that opens keeps
/// its home, and the offer is a banner above it, even when the plan is refused.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct MigrationOffer {
    pub plan: MigratePlan,
    pub blocks: bool,
    pub kind: OfferKind,
}

impl MigrationOffer {
    fn of(plan: MigratePlan) -> Self {
        let marker_moved = plan
            .steps
            .iter()
            .any(|s| s.step == "marker" && s.status == StepStatus::Current);
        let (blocks, kind) = if marker_moved {
            (false, OfferKind::LocalFiles)
        } else {
            (true, OfferKind::SetUp)
        };
        Self { plan, blocks, kind }
    }
}

/// The migration to offer for `folder`: `None` when the program finds no master repository of either marker
/// name there, or when nothing is left to do. A folder that already opens as a hoshin workspace is asked all the
/// same: a pull that renamed the marker leaves this machine's copies and git state under the ai-sdlc names, and a
/// write the program refused part way is continued by a rerun. Any other failure of the program is an error
/// with its own words.
pub fn offer(program: &Program, folder: &Path) -> Result<Option<MigrationOffer>, String> {
    match migrate::dry_run(program, folder) {
        Ok((plan, _)) => Ok(Some(plan)
            .filter(MigratePlan::needed)
            .map(MigrationOffer::of)),
        Err(ProgramError::CouldNotRun { message }) if message.contains(NO_MASTER) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Runs the end closure when dropped, so a migration's mark is lifted on every path out of `run`.
struct Marked<E: FnMut(&Path)> {
    workspace: PathBuf,
    end: E,
}

impl<E: FnMut(&Path)> Drop for Marked<E> {
    fn drop(&mut self) {
        (self.end)(&self.workspace);
    }
}

/// Migrates `folder`: one dry run, then `begin` marks the workspace as migrating (and refuses while a run or a
/// hold works under it, which is one decision with the mark), then the write, then `end` lifts the mark, on
/// every path. A dry plan with nothing to take is returned as it is, with `write` false.
pub fn run(
    program: &Program,
    folder: &Path,
    begin: impl FnOnce(&Path) -> Result<(), String>,
    end: impl FnMut(&Path),
) -> Result<MigratePlan, String> {
    let (plan, layout) = migrate::dry_run(program, folder).map_err(|e| e.to_string())?;
    if !plan.needed() {
        return Ok(plan);
    }
    let workspace = PathBuf::from(&plan.workspace);
    begin(&workspace)?;
    let _marked = Marked { workspace, end };
    migrate::write(program, &plan, layout).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runs::RunKind;
    use kata_sdlc::holds::ChangeKey;

    #[test]
    fn a_missing_path_keeps_its_lexical_key() {
        let gone = Path::new("D:/no/such/Folder/here");
        assert_eq!(resolved_key(gone), RepoKey::of(gone));
    }

    #[cfg(windows)]
    #[test]
    fn spellings_of_one_folder_resolve_to_one_key() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().to_path_buf();
        let verbatim = PathBuf::from(format!(r"\\?\{}", plain.display()));
        let shouted = PathBuf::from(plain.to_string_lossy().to_uppercase());
        let want = resolved_key(&plain);
        assert_eq!(resolved_key(&verbatim), want);
        assert_eq!(resolved_key(&shouted), want);
        assert_eq!(resolved_held(&RepoKey::of(&plain)), want);
    }

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../crates/kata-sdlc/tests/hoshin-tools/hoshin.ts"),
        }
    }

    #[allow(clippy::disallowed_methods)]
    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    /// A workspace whose master `hub` tracks the marker `name`.
    fn workspace(name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let hub = dir.path().join("hub");
        std::fs::create_dir_all(&hub).unwrap();
        git(&hub, &["init", "-q", "-b", "main"]);
        git(&hub, &["config", "user.name", "Test"]);
        git(&hub, &["config", "user.email", "test@example.com"]);
        git(&hub, &["config", "commit.gpgsign", "false"]);
        std::fs::write(
            hub.join(name),
            "{\"version\":1,\"systems\":{\"kata\":{\"repos\":[]}}}\n",
        )
        .unwrap();
        git(&hub, &["add", "."]);
        git(
            &hub,
            &["commit", "-q", "-m", "marker\n\nGenerated-By: ai-sdlc"],
        );
        (dir, hub)
    }

    fn run_in(workdir: &Path, change: Option<&str>) -> LiveSummary {
        LiveSummary {
            id: 1,
            workdir: workdir.to_path_buf(),
            lane: match change {
                Some(c) => Lane::Change {
                    key: ChangeKey {
                        workspace: RepoKey::of(Path::new("D:/ws")),
                        system: "kata".into(),
                        change: c.into(),
                    },
                    build: true,
                },
                None => Lane::Solo,
            },
            kind: RunKind::Build,
            repo: None,
        }
    }

    #[test]
    fn nothing_under_the_workspace_is_not_blocking() {
        let ws = Path::new("D:/ws");
        assert_eq!(migration_blocked(ws, &[], &[]), None);
        let elsewhere = [run_in(Path::new("D:/ws2/app"), Some("x"))];
        assert_eq!(
            migration_blocked(ws, &elsewhere, &[PathBuf::from("D:/other/app")]),
            None
        );
    }

    #[test]
    fn runs_and_holds_under_the_workspace_are_named_once() {
        let ws = Path::new("D:/ws");
        let live = [
            run_in(Path::new("D:/ws/.ai-sdlc/copies/c1/app"), Some("c1")),
            run_in(Path::new("D:/ws/.ai-sdlc/copies/c1/hub"), Some("c1")),
            run_in(Path::new("D:/ws/tool"), None),
        ];
        let holds = [PathBuf::from("D:/ws/api"), PathBuf::from("D:/else/web")];
        assert_eq!(
            migration_blocked(ws, &live, &holds).as_deref(),
            Some("Stop the runs in this workspace before migrating it: c1, tool, api.")
        );
    }

    #[test]
    fn an_ai_sdlc_workspace_is_offered_and_a_hoshin_one_is_not() {
        let (dir, _) = workspace(".ai-sdlc.json");
        let offered = offer(&program(), dir.path()).unwrap().expect("offered");
        assert!(offered.plan.needed());
        let (dir, _) = workspace(".hoshin.json");
        assert_eq!(offer(&program(), dir.path()), Ok(None));
        let none = tempfile::tempdir().unwrap();
        assert_eq!(offer(&program(), none.path()), Ok(None));
    }

    #[test]
    fn a_legacy_workspace_scans_without_a_master_and_is_still_offered() {
        // What the home page meets for a folder set up with ai-sdlc: the scan does not fail, it finds no master,
        // so the offer cannot depend on the scan failing.
        let (dir, _) = workspace(".ai-sdlc.json");
        let scan = kata_sdlc::workspace::scan(dir.path()).expect("the scan does not fail");
        assert!(
            matches!(scan.master, kata_sdlc::workspace::MasterState::None),
            "{:?}",
            scan.master
        );
        let offered = offer(&program(), dir.path()).unwrap().expect("offered");
        assert!(offered.plan.needed());
        assert!(offered.blocks);
        assert_eq!(offered.kind, OfferKind::SetUp);
    }

    #[test]
    fn a_single_repo_legacy_folder_is_offered() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        git(dir.path(), &["config", "user.name", "Test"]);
        git(dir.path(), &["config", "user.email", "test@example.com"]);
        git(dir.path(), &["config", "commit.gpgsign", "false"]);
        std::fs::write(
            dir.path().join(".ai-sdlc.json"),
            "{\"version\":1,\"layout\":\"single-repo\",\"systems\":{\"kata\":{\"apps\":{\"app\":\".\"}}}}\n",
        )
        .unwrap();
        git(dir.path(), &["add", "."]);
        git(
            dir.path(),
            &["commit", "-q", "-m", "marker\n\nGenerated-By: ai-sdlc"],
        );
        let offered = offer(&program(), dir.path()).unwrap().expect("offered");
        assert!(offered.plan.needed());
    }

    #[test]
    fn a_hoshin_workspace_with_only_local_steps_left_is_still_offered() {
        // A pull renamed the marker; this machine's copies and git state are still under the ai-sdlc names.
        let (dir, hub) = workspace(".hoshin.json");
        std::fs::create_dir_all(hub.join(".git").join("ai-sdlc")).unwrap();
        std::fs::write(hub.join(".git").join("ai-sdlc").join("state.json"), "{}").unwrap();
        let offered = offer(&program(), dir.path()).unwrap().expect("offered");
        assert!(
            !offered.blocks,
            "the folder opens, so the offer must not block it"
        );
        assert_eq!(offered.kind, OfferKind::LocalFiles);
        let plan = offered.plan;
        assert!(plan.needed());
        let would: Vec<&str> = plan
            .steps
            .iter()
            .filter(|s| s.status == kata_sdlc::hoshin::migrate::StepStatus::Would)
            .map(|s| s.step.as_str())
            .collect();
        assert!(!would.is_empty(), "{plan:?}");
        assert!(!would.contains(&"marker"), "{would:?}");
    }

    #[test]
    fn a_hoshin_workspace_with_both_state_folders_is_offered_refused_and_does_not_block() {
        // A teammate who ran any hoshin build before migrating has `.git/hoshin` beside `.git/ai-sdlc`.
        let (dir, hub) = workspace(".hoshin.json");
        for name in ["ai-sdlc", "hoshin"] {
            std::fs::create_dir_all(hub.join(".git").join(name)).unwrap();
            std::fs::write(hub.join(".git").join(name).join("state.json"), "{}").unwrap();
        }
        let offered = offer(&program(), dir.path()).unwrap().expect("offered");
        assert!(!offered.blocks);
        assert_eq!(offered.kind, OfferKind::LocalFiles);
        let state = offered
            .plan
            .steps
            .iter()
            .find(|s| s.step == "state")
            .expect("state step");
        assert_eq!(
            state.status,
            kata_sdlc::hoshin::migrate::StepStatus::Refused,
            "{:?}",
            offered.plan
        );
    }

    #[test]
    fn a_failure_other_than_no_marker_is_an_error_with_the_programs_words() {
        let (dir, hub) = workspace(".ai-sdlc.json");
        // Two markers of the same workspace make the program refuse, which is a plan; a marker the program
        // cannot read at all is a fault.
        std::fs::write(hub.join(".ai-sdlc.json"), "{ not json").unwrap();
        let err = offer(&program(), dir.path()).unwrap_err();
        assert!(!err.is_empty(), "{err}");
        assert!(!err.contains(NO_MASTER), "{err}");
    }

    fn marked_run(
        table: &std::cell::RefCell<crate::runs::RunTable<()>>,
        dir: &Path,
    ) -> Result<MigratePlan, String> {
        run(
            &program(),
            dir,
            |w| table.borrow_mut().begin_migrating(w),
            |w| table.borrow_mut().end_migrating(w),
        )
    }

    #[test]
    fn a_live_run_in_the_workspace_refuses_the_migration_and_leaves_the_marker() {
        let (dir, hub) = workspace(".ai-sdlc.json");
        let mut table = crate::runs::RunTable::<()>::default();
        table.insert(crate::runs::LiveRun {
            id: 1,
            workdir: dir.path().join("app"),
            group: None,
            lane: Lane::Solo,
            kind: RunKind::Solo,
            repo: None,
            child: None,
        });
        let table = std::cell::RefCell::new(table);
        let err = marked_run(&table, dir.path()).unwrap_err();
        assert!(
            err.starts_with("Stop the runs in this workspace before migrating it: app"),
            "{err}"
        );
        assert!(hub.join(".ai-sdlc.json").is_file());
        assert!(!hub.join(".hoshin.json").exists());
    }

    #[test]
    fn the_mark_is_lifted_after_the_write_and_a_refused_plan_is_written_as_the_programs_answer() {
        let (dir, hub) = workspace(".ai-sdlc.json");
        let table = std::cell::RefCell::new(crate::runs::RunTable::<()>::default());
        let plan = marked_run(&table, dir.path()).unwrap();
        assert!(plan.write);
        assert!(hub.join(".hoshin.json").is_file());
        assert!(!hub.join(".ai-sdlc.json").exists());
        assert!(table
            .borrow()
            .claim(&dir.path().join("app"), &Lane::Solo)
            .is_ok());
        // Nothing left to take: the dry plan comes back, not written, and no mark is left either.
        let again = marked_run(&table, dir.path()).unwrap();
        assert!(!again.write && !again.needed());
        assert!(table
            .borrow()
            .claim(&dir.path().join("app"), &Lane::Solo)
            .is_ok());
    }
}
