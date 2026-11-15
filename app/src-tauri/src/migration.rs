//! Offering and running the migration from ai-sdlc to hoshin for a workspace folder. The program decides what the
//! migration is (`migrate`); this module decides only whether the Workbench may run it now: never while a run or a
//! build hold is working under the workspace, since the migration moves the copies those runs work in.
use crate::runs::{Lane, LiveSummary};
use kata_sdlc::holds::RepoKey;
use kata_sdlc::hoshin::migrate::{self, MigratePlan};
use kata_sdlc::hoshin::Program;
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

/// The migration to offer for `folder`: `None` when the folder opens as a hoshin workspace, when the program
/// cannot run `migrate` on it (no marker of either name), or when nothing is left to do.
pub fn offer(program: &Program, folder: &Path) -> Option<MigratePlan> {
    if kata_sdlc::layout::open(program, folder).is_ok() {
        return None;
    }
    migrate::migrate(program, folder, false)
        .ok()
        .filter(MigratePlan::needed)
}

/// Runs the migration of `folder` with `--write`, refused while `live` runs or `holds` work under it.
pub fn run(
    program: &Program,
    folder: &Path,
    live: &[LiveSummary],
    holds: &[PathBuf],
) -> Result<MigratePlan, String> {
    let dry = migrate::migrate(program, folder, false).map_err(|e| e.to_string())?;
    let workspace = PathBuf::from(&dry.workspace);
    if let Some(refusal) = migration_blocked(&workspace, live, holds)
        .or_else(|| migration_blocked(folder, live, holds))
    {
        return Err(refusal);
    }
    migrate::migrate(program, folder, true).map_err(|e| e.to_string())
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
        let plan = offer(&program(), dir.path()).expect("offered");
        assert!(plan.needed());
        let (dir, _) = workspace(".hoshin.json");
        assert_eq!(offer(&program(), dir.path()), None);
        let none = tempfile::tempdir().unwrap();
        assert_eq!(offer(&program(), none.path()), None);
    }

    #[test]
    fn a_live_run_in_the_workspace_refuses_the_migration_and_leaves_the_marker() {
        let (dir, hub) = workspace(".ai-sdlc.json");
        let live = [run_in(&dir.path().join("app"), None)];
        let err = run(&program(), dir.path(), &live, &[]).unwrap_err();
        assert!(
            err.starts_with("Stop the runs in this workspace before migrating it: app"),
            "{err}"
        );
        assert!(hub.join(".ai-sdlc.json").is_file());
        assert!(!hub.join(".hoshin.json").exists());
    }

    #[test]
    fn with_nothing_live_the_migration_runs() {
        let (dir, hub) = workspace(".ai-sdlc.json");
        let plan = run(&program(), dir.path(), &[], &[]).unwrap();
        assert!(plan.write);
        assert!(hub.join(".hoshin.json").is_file());
        assert!(!hub.join(".ai-sdlc.json").exists());
    }
}
