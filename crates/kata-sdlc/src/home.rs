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
    let found = state::one(program, &place, system, change)
        .map_err(unanswered)?
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
                .step_long(
                    &[
                        "change", "start", "--json", "--system", SYSTEM, "--change", CHANGE,
                        "--type", "feat", "--scope", "demo", "--title", "Greeting",
                    ],
                    &place,
                    &kata_core::proc::CancelToken::new(),
                    None,
                )
                .json;
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

    /// One spelling of a path for comparison: canonical when it exists, which also expands a Windows
    /// 8.3 short name (`RUNNER~1`, as CI's temp folder is) to the long form the plugin reports.
    fn norm(p: &Path) -> String {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
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

    /// A program that logs its arguments, one JSON line each, and runs the vendored program.
    fn recording_program(dir: &Path, log: &Path) -> Program {
        let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts");
        let quoted =
            |p: &Path| serde_json::to_string(&p.to_string_lossy().replace('\\', "/")).unwrap();
        std::fs::create_dir_all(dir.join("tools")).unwrap();
        let text = format!(
            "import {{ appendFileSync }} from 'node:fs';\n\
             import {{ spawnSync }} from 'node:child_process';\n\
             appendFileSync({log}, JSON.stringify(process.argv.slice(2)) + '\\n');\n\
             const r = spawnSync(process.execPath, [{entry}, ...process.argv.slice(2)], {{ encoding: 'utf8' }});\n\
             process.stdout.write(r.stdout);\n\
             process.stderr.write(r.stderr);\n\
             process.exit(r.status ?? 2);\n",
            log = quoted(log),
            entry = quoted(&entry),
        );
        std::fs::write(dir.join("tools").join("ai-sdlc.ts"), text).unwrap();
        Program::locate(dir)
    }

    #[test]
    fn opening_a_change_asks_the_plugin_about_that_change_only() {
        let fx = Fx::new();
        let place = Place {
            master: fx.master.clone(),
            workspace: fx.ws.clone(),
        };
        for other in ["2026-11-02-one", "2026-11-02-two", "2026-11-02-three"] {
            let started = program()
                .step_long(
                    &[
                        "change", "start", "--json", "--system", SYSTEM, "--change", other,
                        "--type", "feat", "--scope", "demo", "--title", "Other",
                    ],
                    &place,
                    &kata_core::proc::CancelToken::new(),
                    None,
                )
                .json;
            assert_eq!(started["outcome"], "passed", "{started}");
        }
        let tools = tempfile::tempdir().unwrap();
        let log = tools.path().join("calls.jsonl");
        let recording = recording_program(tools.path(), &log);
        let home = resolve(&recording, &fx.ws, SYSTEM, CHANGE).unwrap();
        assert_eq!(home.state.change, CHANGE);
        let calls: Vec<Vec<String>> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let states: Vec<&Vec<String>> = calls.iter().filter(|c| c[0] == "state").collect();
        assert!(!states.is_empty(), "{calls:?}");
        for call in states {
            let at = call.iter().position(|a| a == "--change");
            assert!(
                at.is_some_and(|i| call.get(i + 1).is_some_and(|c| c == CHANGE)),
                "{call:?}"
            );
        }
    }

    #[test]
    fn a_change_no_repository_holds_is_not_listed() {
        let fx = Fx::new();
        // The real program, so its actual exit-2 text is what the prefix match sees.
        let err = resolve(&program(), &fx.ws, SYSTEM, "2026-11-02-nobody").unwrap_err();
        assert_eq!(err, HomeError::NotListed);
        assert_eq!(err.to_string(), LISTED);

        // A program that passes everything through but answers `state` with another exit 2.
        let tools = tempfile::tempdir().unwrap();
        let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts");
        std::fs::create_dir_all(tools.path().join("tools")).unwrap();
        std::fs::write(
            tools.path().join("tools").join("ai-sdlc.ts"),
            format!(
                "import {{ spawnSync }} from 'node:child_process';\n\
                 const a = process.argv.slice(2);\n\
                 if (a[0] === 'state') {{ console.error('something else broke'); process.exit(2); }}\n\
                 const r = spawnSync(process.execPath, [{}, ...a], {{ encoding: 'utf8' }});\n\
                 process.stdout.write(r.stdout);\n\
                 process.exit(r.status ?? 2);\n",
                serde_json::to_string(&entry.to_string_lossy().replace('\\', "/")).unwrap()
            ),
        )
        .unwrap();
        let err = resolve(&Program::locate(tools.path()), &fx.ws, SYSTEM, CHANGE).unwrap_err();
        assert!(
            matches!(&err, HomeError::Unanswered(r) if r.contains("something else broke")),
            "{err:?}"
        );
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
        // R2.4: the plugin puts the change in its copy, so the copy is the folder read, not the checkout.
        assert!(home.in_copy);
        assert_eq!(norm(&home.master), norm(&fx.copy));
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
