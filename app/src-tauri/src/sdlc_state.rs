//! Where a system's changes stand, as the Workbench shows them: the plugin's `state` answer, what each
//! change shows and offers, and the live facts only the run table knows. The Tauri commands in `lib.rs`
//! are one-line wrappers over [`system_view`] and [`change_view`], so this module is testable without Tauri.
use kata_sdlc::ai_sdlc::state::{ChangeState, SystemState};
use kata_sdlc::ai_sdlc::{Program, ProgramError};
use kata_sdlc::offer::{ChangeOffer, LiveFacts};
use kata_sdlc::plugin::Readiness;
pub use kata_sdlc::view::{ChangeView, SystemView, WorkspaceView};
use std::path::Path;

/// Where the answer about a system's changes comes from; the plugin's program in the app, a fake in tests.
pub trait StateSource {
    fn state(
        &self,
        workspace: &Path,
        system: &str,
        change: Option<&str>,
    ) -> Result<SystemState, ProgramError>;
}

impl StateSource for Program {
    fn state(
        &self,
        workspace: &Path,
        system: &str,
        change: Option<&str>,
    ) -> Result<SystemState, ProgramError> {
        kata_sdlc::ai_sdlc::state::state(self, workspace, system, change)
    }
}

/// The offer of a change on a machine where the mode cannot run: the stage and label stay, and every
/// action is refused with the readiness message.
fn refused(mut offer: ChangeOffer, message: &str) -> ChangeOffer {
    for action in &mut offer.actions {
        action.enabled = false;
        action.reason = Some(message.to_string());
    }
    offer
}

pub fn view_of(state: ChangeState, readiness: &Readiness, live: LiveFacts) -> ChangeView {
    let mut offer = kata_sdlc::offer::of(&state, &live);
    if let Readiness::Blocked { message, .. } = readiness {
        offer = refused(offer, message);
    }
    ChangeView {
        state,
        offer,
        live,
        readiness: readiness.clone(),
    }
}

/// The view of every change of `system`, from one `state` call. `source` is `None` where the mode cannot
/// run and there is no program to ask: the view then lists nothing. A blocked readiness offers nothing,
/// and starting a change is not offered.
pub fn system_view(
    source: Option<&dyn StateSource>,
    readiness: &Readiness,
    live: &dyn Fn(&str, &str) -> LiveFacts,
    folder: &Path,
    system: &str,
) -> Result<SystemView, String> {
    let empty = SystemState {
        system: system.to_string(),
        changes: Vec::new(),
        problems: Vec::new(),
    };
    let found = match source {
        Some(source) => match source.state(folder, system, None) {
            Ok(found) => found,
            Err(e) if matches!(readiness, Readiness::Blocked { .. }) => SystemState {
                problems: vec![e.to_string()],
                ..empty
            },
            Err(e) => return Err(e.to_string()),
        },
        None => empty,
    };
    let (can_start_change, start_change_reason) = match readiness {
        Readiness::Blocked { message, .. } => (false, Some(message.clone())),
        Readiness::Ready { .. } => (true, None),
    };
    let changes = found
        .changes
        .into_iter()
        .map(|state| {
            let facts = live(system, &state.change);
            view_of(state, readiness, facts)
        })
        .collect();
    Ok(SystemView {
        system: system.to_string(),
        readiness: readiness.clone(),
        can_start_change,
        start_change_reason,
        changes,
        problems: found.problems,
    })
}

/// One answer for the systems the home lists: each system's view, and whether a new change may be started across the
/// set. It may only when at least one system was read and every one may; the reason is the first refusing system's.
pub fn workspace_view(systems: Vec<SystemView>) -> WorkspaceView {
    let refusing = systems.iter().find(|s| !s.can_start_change);
    WorkspaceView {
        can_start_change: !systems.is_empty() && refusing.is_none(),
        start_change_reason: refusing.and_then(|s| s.start_change_reason.clone()),
        systems,
    }
}

/// The view of one change; an error when the plugin's report does not hold it.
pub fn change_view(
    source: Option<&dyn StateSource>,
    readiness: &Readiness,
    live: &dyn Fn(&str, &str) -> LiveFacts,
    folder: &Path,
    system: &str,
    change: &str,
) -> Result<ChangeView, String> {
    let not_listed = || format!("{change} is not listed");
    let source = source.ok_or_else(not_listed)?;
    let found = source
        .state(folder, system, Some(change))
        .map_err(|e| e.to_string())?;
    let state = found
        .changes
        .into_iter()
        .find(|c| c.change == change)
        .ok_or_else(not_listed)?;
    let facts = live(system, change);
    Ok(view_of(state, readiness, facts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kata_sdlc::ai_sdlc::state::read_state;
    use kata_sdlc::plugin::{GhPresence, Plugin};
    use std::cell::Cell;
    use std::path::PathBuf;
    use std::process::Command;

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../crates/kata-sdlc/tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    fn ready() -> Readiness {
        Readiness::Ready {
            plugin: Plugin {
                dir: PathBuf::from("plugin"),
                version: "1.1.0".into(),
                layouts: vec![],
            },
            gh: GhPresence::Present,
        }
    }

    fn no_live(_: &str, _: &str) -> LiveFacts {
        LiveFacts::default()
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A workspace with a master repository (system `demo`, repository `app`).
    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_path_buf();
        let master = ws.join("ai-sdlc");
        for name in ["ai-sdlc", "app"] {
            let repo = ws.join(name);
            std::fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init", "-q", "-b", "main"]);
            git(&repo, &["config", "user.name", "Test"]);
            git(&repo, &["config", "user.email", "test@example.com"]);
            git(&repo, &["config", "commit.gpgsign", "false"]);
        }
        std::fs::write(
            master.join(".ai-sdlc.json"),
            r#"{"version":1,"systems":{"demo":{"repos":["app"]}}}"#,
        )
        .unwrap();
        git(&master, &["add", "."]);
        git(&master, &["commit", "-q", "-m", "marker"]);
        std::fs::write(ws.join("app").join("a.txt"), "a").unwrap();
        git(&ws.join("app"), &["add", "."]);
        git(&ws.join("app"), &["commit", "-q", "-m", "init"]);
        (dir, ws)
    }

    fn system(name: &str, reason: Option<&str>) -> SystemView {
        SystemView {
            system: name.into(),
            readiness: ready(),
            can_start_change: reason.is_none(),
            start_change_reason: reason.map(String::from),
            changes: vec![],
            problems: vec![],
        }
    }

    fn merged(systems: Vec<SystemView>) -> (Vec<String>, bool, Option<String>) {
        let view = workspace_view(systems);
        let names = view.systems.iter().map(|s| s.system.clone()).collect();
        (names, view.can_start_change, view.start_change_reason)
    }

    /// Whether the home may start a change, over every system of the workspace: every row of the merge.
    #[test]
    fn a_change_may_be_started_only_when_every_system_may() {
        // No system read: nothing to start a change in.
        assert_eq!(merged(vec![]), (vec![], false, None));
        // Every system can: it may, with no reason.
        assert_eq!(
            merged(vec![system("a", None), system("b", None)]),
            (vec!["a".into(), "b".into()], true, None)
        );
        // One cannot: it may not, with that system's reason.
        assert_eq!(
            merged(vec![system("a", None), system("b", Some("b is blocked"))]),
            (
                vec!["a".into(), "b".into()],
                false,
                Some("b is blocked".into())
            )
        );
        // Several cannot: the first refusing system's reason, in the order the systems were asked.
        assert_eq!(
            merged(vec![
                system("a", None),
                system("b", Some("b is blocked")),
                system("c", Some("c is blocked")),
            ]),
            (
                vec!["a".into(), "b".into(), "c".into()],
                false,
                Some("b is blocked".into())
            )
        );
    }

    #[test]
    fn sdlc_state_lists_a_change_that_lives_only_in_its_copy() {
        let (_dir, ws) = workspace();
        let master = ws.join("ai-sdlc");
        let change = "2026-11-01-greeting";
        let started = program()
            .step_long(
                &[
                    "change", "start", "--json", "--system", "demo", "--change", change, "--type",
                    "feat", "--scope", "X-1",
                ],
                &kata_sdlc::ai_sdlc::Place {
                    master: master.clone(),
                    workspace: ws.clone(),
                },
                &kata_core::proc::CancelToken::new(),
                None,
            )
            .json;
        assert_eq!(started["outcome"], "passed", "{started}");
        let copy = PathBuf::from(started["details"]["copy"].as_str().unwrap());
        let folder = copy.join("intent/demo").join(change);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("intent.md"),
            "---\ntitle: Greeting\nstatus: draft\n---\n\n# Intent\n",
        )
        .unwrap();

        let p = program();
        let view = system_view(Some(&p), &ready(), &no_live, &ws, "demo").unwrap();
        assert_eq!(view.changes.len(), 1);
        let c = &view.changes[0];
        assert_eq!(c.state.change, change);
        assert!(c.state.in_copy);
        assert!(!c.offer.label.text.is_empty());
        let one = change_view(Some(&p), &ready(), &no_live, &ws, "demo", change).unwrap();
        assert_eq!(one.state.change, change);
    }

    #[test]
    fn a_change_only_on_its_branch_is_not_listed() {
        let (_dir, ws) = workspace();
        let master = ws.join("ai-sdlc");
        let change = "2026-10-31-several-changes-at-once";
        git(
            &master,
            &["checkout", "-q", "-b", &format!("change/{change}")],
        );
        let folder = master.join("intent/demo").join(change);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("intent.md"),
            "---\ntitle: Several\nstatus: accepted\n---\n\n# Intent\n",
        )
        .unwrap();
        git(&master, &["add", "."]);
        git(&master, &["commit", "-q", "-m", "intent"]);
        git(&master, &["checkout", "-q", "main"]);

        let p = program();
        let view = system_view(Some(&p), &ready(), &no_live, &ws, "demo").unwrap();
        assert!(view.changes.is_empty(), "{}", view.changes.len());
        assert!(change_view(Some(&p), &ready(), &no_live, &ws, "demo", change).is_err());
    }

    fn change_json(name: &str) -> String {
        format!(
            r#"{{"change":"{name}","master":"/ws","folder":"/ws/intent/demo/{name}","inCopy":false,"title":null,"track":"full",
 "documents":{{"intent":{{"exists":true,"inHead":true,"headStatus":"accepted","workingStatus":"accepted","uncommitted":false}},"spec":{{"exists":false,"inHead":false,"headStatus":null,"workingStatus":null,"uncommitted":false,"pin":null}},"plan":{{"exists":false,"inHead":false,"headStatus":null,"workingStatus":null,"uncommitted":false,"pin":null}}}},
 "scenarios":null,"tasks":null,"buildLogs":{{}},"review":{{"committed":0,"draft":"none"}},"fix":null,
 "ready":{{"spec":{{"candidate":true,"stop":null,"accept":["intent.md"]}},"plan":{{"candidate":false,"stop":"no spec","accept":[]}},"build":{{"candidate":false,"stop":"no plan","accept":[]}},"review":{{"candidate":false,"stop":"no build","accept":[]}},"done":{{"candidate":false,"stop":"no review","accept":[]}},"reject":{{"candidate":true,"stop":null,"accept":[]}}}}}}"#
        )
    }

    struct Counting {
        calls: Cell<u32>,
        names: Vec<String>,
    }

    impl StateSource for Counting {
        fn state(
            &self,
            _workspace: &Path,
            system: &str,
            _change: Option<&str>,
        ) -> Result<SystemState, ProgramError> {
            self.calls.set(self.calls.get() + 1);
            let changes: Vec<String> = self.names.iter().map(|n| change_json(n)).collect();
            let answer = format!(
                r#"{{"system":"{system}","changes":[{}],"problems":[]}}"#,
                changes.join(",")
            );
            Ok(read_state(serde_json::from_str(&answer).unwrap()).unwrap())
        }
    }

    fn counting(n: usize) -> Counting {
        Counting {
            calls: Cell::new(0),
            names: (0..n)
                .map(|i| format!("2026-11-01-change-{i:02}"))
                .collect(),
        }
    }

    #[test]
    fn one_state_call_per_system() {
        let source = counting(20);
        let view =
            system_view(Some(&source), &ready(), &no_live, Path::new("/ws"), "demo").unwrap();
        assert_eq!(view.changes.len(), 20);
        assert_eq!(source.calls.get(), 1);
    }

    #[test]
    fn a_blocked_readiness_offers_nothing() {
        let source = counting(2);
        let blocked = Readiness::Blocked {
            reason: kata_sdlc::plugin::BlockReason::PluginTooOld,
            message: "The AI-SDLC mode needs ai-sdlc 1.1.0 or later; this machine has 1.0.0."
                .into(),
        };
        let view =
            system_view(Some(&source), &blocked, &no_live, Path::new("/ws"), "demo").unwrap();
        assert_eq!(view.changes.len(), 2);
        assert!(!view.can_start_change);
        assert!(view
            .start_change_reason
            .as_deref()
            .unwrap()
            .contains("1.1.0"));
        for c in &view.changes {
            assert!(!c.offer.label.text.is_empty());
            assert!(!c.offer.actions.is_empty());
            for a in &c.offer.actions {
                assert!(!a.enabled, "{:?}", a.action);
                assert!(a.reason.as_deref().unwrap().contains("1.0.0"));
            }
        }
    }
}
