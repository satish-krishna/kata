//! Offering and running the migration from ai-sdlc to hoshin for a workspace folder. The program decides what the
//! migration is (`migrate`); this module decides only whether the Workbench may run it now: never while a run or a
//! build hold is working under the workspace, since the migration moves the copies those runs work in.
use crate::runs::{Lane, LiveSummary};
use kata_sdlc::holds::RepoKey;
use kata_sdlc::hoshin::migrate::{self, MigratePlan};
use kata_sdlc::hoshin::{Program, ProgramError};
use std::path::{Path, PathBuf};

/// Why the migration of `workspace` must wait, or `None` when nothing is working under it. A run counts by its
/// folder, a hold by its repository's folder, so a run in one of the workspace's change copies counts too.
pub fn migration_blocked(
    workspace: &Path,
    live: &[LiveSummary],
    holds: &[PathBuf],
) -> Option<String> {
    let root = RepoKey::of(workspace);
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
        .filter(|r| root.contains(&RepoKey::of(&r.workdir)))
    {
        add(match &run.lane {
            Lane::Change { key, .. } => key.change.clone(),
            _ => folder_name(&run.workdir),
        });
    }
    for hold in holds.iter().filter(|h| root.contains(&RepoKey::of(h))) {
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

/// The migration to offer for `folder`: `None` when the folder opens as a hoshin workspace, when the program
/// finds no master repository of either marker name there, or when nothing is left to do. Any other failure of
/// the program is an error with its own words.
pub fn offer(program: &Program, folder: &Path) -> Result<Option<MigratePlan>, String> {
    if kata_sdlc::layout::open(program, folder).is_ok() {
        return Ok(None);
    }
    match migrate::dry_run(program, folder) {
        Ok((plan, _)) => Ok(Some(plan).filter(MigratePlan::needed)),
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
        let plan = offer(&program(), dir.path()).unwrap().expect("offered");
        assert!(plan.needed());
        let (dir, _) = workspace(".hoshin.json");
        assert_eq!(offer(&program(), dir.path()), Ok(None));
        let none = tempfile::tempdir().unwrap();
        assert_eq!(offer(&program(), none.path()), Ok(None));
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
