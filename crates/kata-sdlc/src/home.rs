//! Where a change lives. The ai-sdlc plugin's `state` answer says, for each change, the master it lives in
//! (its own copy, or the engineer's checkout) and the folder of its documents. This module is the one place
//! Kata asks that, and the one place that checks the folder is on disk. Nothing falls back to the checkout:
//! a change the plugin cannot place is an error with a message, never a guess.
use crate::ai_sdlc::state::{self, ChangeState};
use crate::ai_sdlc::{Place, Program, ProgramError};
use crate::changes::{is_change_name, is_safe_system};
use std::path::{Path, PathBuf};

/// Where the plugin has a change, and how it stands there.
#[derive(Clone, Debug, PartialEq)]
pub struct ChangeHome {
    /// The workspace's own master and the workspace around it, as the plugin resolves them.
    pub place: Place,
    /// The change's `state` entry.
    pub state: ChangeState,
    /// The master the change lives in: its copy when `in_copy`, else the checkout.
    pub master: PathBuf,
    /// The folder of the change's documents, on disk.
    pub folder: PathBuf,
    /// Whether the change lives in its own copy.
    pub in_copy: bool,
}

/// Why a change could not be placed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HomeError {
    /// The plugin gave no answer; its reason.
    #[error("Could not find where this change lives: {0}")]
    Unanswered(String),
    /// The plugin answered and does not list the change.
    #[error("This change's copy was removed and the plugin no longer lists it.")]
    NotListed,
    /// The plugin lists the change but its folder is not on disk.
    #[error("This change's copy was removed and the plugin no longer lists it.")]
    Gone(PathBuf),
}

/// Asks the plugin where `change` of `system` lives in `workspace`, and checks its folder is on disk.
pub fn resolve(
    program: &Program,
    workspace: &Path,
    system: &str,
    change: &str,
) -> Result<ChangeHome, HomeError> {
    if !is_safe_system(system) || !is_change_name(change) {
        return Err(HomeError::Unanswered(format!(
            "{system}/{change} is not a system and change name"
        )));
    }
    let unanswered = |e: ProgramError| HomeError::Unanswered(e.to_string());
    // `Program::resolve` runs node on the entry without looking for it, and a missing file would come back
    // as an empty refusal; say what is wrong instead.
    if !program.entry.is_file() {
        return Err(unanswered(ProgramError::TooOld {
            found: format!("{} does not exist", program.entry.display()),
        }));
    }
    let place = program.resolve(workspace).map_err(unanswered)?;
    let answer = program
        .run(&["state", "--json", "--system", system], &place)
        .map_err(unanswered)?;
    let found = state::read_state(answer)
        .map_err(unanswered)?
        .changes
        .into_iter()
        .find(|c| c.change == change)
        .ok_or(HomeError::NotListed)?;
    let folder = PathBuf::from(&found.folder);
    if !folder.is_dir() {
        return Err(HomeError::Gone(folder));
    }
    Ok(ChangeHome {
        place,
        master: PathBuf::from(&found.master),
        folder,
        in_copy: found.in_copy,
        state: found,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    const SYSTEM: &str = "demo";
    const CHANGE: &str = "2026-11-02-greeting";
    const MARKER: &str = r#"{"version":1,"systems":{"demo":{"repos":["app"]}}}"#;
    const LISTED: &str = "This change's copy was removed and the plugin no longer lists it.";

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    /// A workspace with a master, a product repository and a change the plugin started, with its copy.
    struct Fx {
        _dir: tempfile::TempDir,
        ws: PathBuf,
        master: PathBuf,
        copy: PathBuf,
    }

    impl Fx {
        fn new() -> Fx {
            let dir = tempfile::tempdir().unwrap();
            let ws = dir.path().to_path_buf();
            let master = testutil::repo(&ws, "ai-sdlc");
            testutil::commit_file(&master, ".ai-sdlc.json", MARKER, "marker");
            testutil::repo(&ws, "app");
            let place = Place {
                master: master.clone(),
                workspace: ws.clone(),
            };
            let started = program()
                .run(
                    &[
                        "change", "start", "--json", "--system", SYSTEM, "--change", CHANGE,
                        "--type", "feat", "--scope", "demo", "--title", "Greeting",
                    ],
                    &place,
                )
                .unwrap();
            assert_eq!(started["outcome"], "passed", "{started}");
            let copy = ws.join(".ai-sdlc").join("copies").join(CHANGE);
            testutil::commit_file(
                &copy,
                &format!("intent/{SYSTEM}/{CHANGE}/intent.md"),
                "---
status: accepted
---
# Intent
",
                "intent",
            );
            Fx {
                _dir: dir,
                ws,
                master,
                copy,
            }
        }

        fn resolve(&self) -> Result<ChangeHome, HomeError> {
            resolve(&program(), &self.ws, SYSTEM, CHANGE)
        }
    }

    fn norm(p: &Path) -> String {
        p.to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches("//?/")
            .to_lowercase()
    }

    #[test]
    fn resolve_errors_for_each_unanswered_case() {
        let fx = Fx::new();

        // Row 1: the program is missing (a plugin folder with no tools/ai-sdlc.ts).
        let empty = tempfile::tempdir().unwrap();
        let missing = Program::locate(empty.path());
        let err = resolve(&missing, &fx.ws, SYSTEM, CHANGE).unwrap_err();
        let HomeError::Unanswered(reason) = &err else {
            panic!("expected Unanswered, got {err:?}");
        };
        assert!(
            reason.starts_with("the installed ai-sdlc plugin is too old"),
            "{reason}"
        );
        assert_eq!(
            err.to_string(),
            format!("Could not find where this change lives: {reason}")
        );

        // Row 1: the program exits 2.
        let bad = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(bad.path().join("tools")).unwrap();
        std::fs::write(
            bad.path().join("tools").join("ai-sdlc.ts"),
            "console.error('boom'); process.exit(2);\n",
        )
        .unwrap();
        let err = resolve(&Program::locate(bad.path()), &fx.ws, SYSTEM, CHANGE).unwrap_err();
        assert!(
            matches!(&err, HomeError::Unanswered(r) if r.contains("boom")),
            "{err:?}"
        );
        assert!(err.to_string().starts_with(
            "Could not find where this change lives: the ai-sdlc program could not run"
        ));

        // Row 2: the change is not listed.
        let err = resolve(&program(), &fx.ws, SYSTEM, "2026-11-02-unknown").unwrap_err();
        assert_eq!(err, HomeError::NotListed);
        assert_eq!(err.to_string(), LISTED);

        // Row 3: the copy folder is deleted after the plugin started the change.
        std::fs::remove_dir_all(&fx.copy).unwrap();
        let err = fx.resolve().unwrap_err();
        assert!(
            matches!(err, HomeError::Gone(_) | HomeError::NotListed),
            "{err:?}"
        );
        assert_eq!(err.to_string(), LISTED);
    }

    #[test]
    fn resolve_reports_a_removed_copy_as_gone() {
        let fx = Fx::new();
        let before = fx.resolve().unwrap();
        assert!(before.in_copy);
        assert_eq!(norm(&before.master), norm(&fx.copy));
        std::fs::remove_dir_all(&fx.copy).unwrap();
        let after = fx.resolve();
        assert!(
            matches!(after, Err(HomeError::Gone(_)) | Err(HomeError::NotListed)),
            "{after:?}"
        );
    }

    #[test]
    fn resolve_follows_the_plugin_when_checkout_and_copy_both_hold_the_change() {
        let fx = Fx::new();
        let rel = format!("intent/{SYSTEM}/{CHANGE}/intent.md");
        testutil::commit_file(&fx.master, &rel, "---\nstatus: draft\n---\n# Old\n", "old");
        let home = fx.resolve().unwrap();
        // Whatever master the plugin reports is the one resolve returns.
        let state = state::state(&program(), &fx.ws, SYSTEM, Some(CHANGE))
            .unwrap()
            .changes
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(home.master, PathBuf::from(&state.master));
        assert_eq!(home.folder, PathBuf::from(&state.folder));
        assert_eq!(home.in_copy, state.in_copy);
        assert!(home.folder.is_dir());
    }

    #[test]
    fn resolve_follows_a_done_change_into_the_checkout() {
        let fx = Fx::new();
        let folder = fx
            .master
            .join("intent")
            .join(SYSTEM)
            .join("2026-11-02-merged");
        testutil::commit_file(
            &fx.master,
            &format!("intent/{SYSTEM}/2026-11-02-merged/intent.md"),
            "---\nstatus: accepted\n---\n# Intent\n",
            "merged change",
        );
        let home = resolve(&program(), &fx.ws, SYSTEM, "2026-11-02-merged").unwrap();
        assert!(!home.in_copy);
        assert_eq!(norm(&home.master), norm(&fx.master));
        assert_eq!(norm(&home.folder), norm(&folder));
    }

    #[test]
    fn resolve_returns_the_copy_for_a_change_in_a_copy() {
        let fx = Fx::new();
        let home = fx.resolve().unwrap();
        assert!(home.in_copy);
        assert_eq!(norm(&home.master), norm(&fx.copy));
        assert!(home.folder.is_dir());
        assert_eq!(norm(&home.place.master), norm(&fx.master));
    }
}
