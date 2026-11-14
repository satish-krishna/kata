//! A change started through the real (vendored) ai-sdlc program must be found again from the one folder the
//! Workbench saved for its workspace, in both layouts, through the app's own code paths: the home's list and
//! open reads, the change page's `home::resolve` and the build host's `resolve` and state read. Nothing here
//! is faked and no `Place` under test is built by hand; the only hand-made one starts the change.
use crate::build_host::{ProgramTools, Tools};
use crate::sdlc_home::HomeSource;
use kata_sdlc::ai_sdlc::{Place, Program};
use kata_sdlc::layout::Layout;
use std::path::{Path, PathBuf};

const SYSTEM: &str = "kata";
const CHANGE: &str = "2026-11-12-saved-folder";
const INTENT: &str = "---\ntitle: Saved\nstatus: accepted\n---\n\n# Intent\n";

fn vendored() -> Program {
    Program {
        node: "node".into(),
        entry: Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../crates/kata-sdlc/tests/ai-sdlc-tools/ai-sdlc.ts"),
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
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn init_repo(parent: &Path, name: &str) -> PathBuf {
    let dir = parent.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    git(&dir, &["config", "commit.gpgsign", "false"]);
    std::fs::write(dir.join("README.md"), "init\n").unwrap();
    dir
}

fn commit_all(dir: &Path, message: &str) {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
}

/// A single-repo repository `kata` with two apps in folders, inside `parent`; returns its root.
fn single_repo(parent: &Path) -> PathBuf {
    let root = init_repo(parent, "kata");
    std::fs::write(
        root.join(".ai-sdlc.json"),
        r#"{"version":1,"layout":"single-repo","systems":{"kata":{"apps":{"engine":"engine","workbench":"app"}}}}"#,
    )
    .unwrap();
    for folder in ["engine", "app", "intent/kata/context"] {
        std::fs::create_dir_all(root.join(folder)).unwrap();
        std::fs::write(root.join(folder).join("keep.txt"), "x\n").unwrap();
    }
    std::fs::write(root.join("intent/kata/policies.md"), "# Policies\n").unwrap();
    commit_all(&root, "single-repo layout");
    root
}

/// A workspace `parent` holding the master `ai-sdlc` and the product repository `kata`; returns `parent`.
fn workspace(parent: &Path) -> PathBuf {
    let master = init_repo(parent, "ai-sdlc");
    std::fs::write(
        master.join(".ai-sdlc.json"),
        r#"{"version":1,"systems":{"kata":{"repos":["kata"]}}}"#,
    )
    .unwrap();
    commit_all(&master, "marker");
    let product = init_repo(parent, "kata");
    commit_all(&product, "init");
    parent.to_path_buf()
}

/// Starts the change through the program in `place`, then commits an intent in its copy so it is listed.
fn start(program: &Program, place: &Place) {
    let started = program
        .run(
            &[
                "change", "start", "--json", "--system", SYSTEM, "--change", CHANGE, "--type",
                "feat", "--scope", "X-1", "--title", "Saved",
            ],
            place,
        )
        .unwrap();
    assert_eq!(started["outcome"], "passed", "{started}");
    let copy = place.workspace.join(".ai-sdlc/copies").join(CHANGE);
    let folder = copy.join(format!("intent/{SYSTEM}/{CHANGE}"));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("intent.md"), INTENT).unwrap();
    commit_all(&copy, "intent");
}

/// What the app does with `saved`, the folder it saved when the engineer added the workspace.
fn found_again(program: &Program, saved: &str) {
    let folder = Path::new(saved);

    // (a) The home lists the change, in the light list and in the open read.
    let listed = HomeSource::list(program, folder, SYSTEM).unwrap();
    assert_eq!(
        listed
            .changes
            .iter()
            .map(|c| c.change.as_str())
            .collect::<Vec<_>>(),
        [CHANGE],
        "list from {saved}"
    );
    let open = HomeSource::open_states(program, folder, SYSTEM).unwrap();
    assert_eq!(
        open.changes
            .iter()
            .map(|c| c.change.as_str())
            .collect::<Vec<_>>(),
        [CHANGE],
        "open states from {saved}"
    );

    // (b) The change page opens it: `sdlc_open_change` resolves through `home::resolve`.
    let home = kata_sdlc::home::resolve(program, folder, SYSTEM, CHANGE)
        .unwrap_or_else(|e| panic!("open from {saved}: {e}"));
    assert!(home.in_copy);

    // (c) The build host resolves the folder, then reads the change's state in the place it got.
    let tools = ProgramTools::new(program.clone(), true);
    let place = tools.resolve(folder).unwrap();
    let state = tools
        .change_state(&place, SYSTEM, CHANGE)
        .unwrap()
        .unwrap_or_else(|| panic!("the build host cannot read the state of {CHANGE} from {saved}"));
    assert_eq!(state.change, CHANGE);
}

#[test]
fn a_single_repo_change_is_found_from_the_folder_saved_for_it() {
    let program = vendored();
    let tmp = tempfile::tempdir().unwrap();
    let parent = tmp.path().canonicalize().unwrap();
    let root = single_repo(&parent);

    // The folder the app saves for the engineer's pick, exactly as `sdlc_add_workspace` computes it.
    let (saved, layout) = crate::resolve_added(Some(&program), root.to_str().unwrap()).unwrap();
    assert_eq!(layout, Layout::SingleRepo);

    // Start the change; the one hand-made place is for this setup step only.
    start(
        &program,
        &Place {
            layout,
            master: root.clone(),
            workspace: parent.clone(),
        },
    );

    found_again(&program, &saved);
}

#[test]
fn a_workspace_change_is_found_from_the_folder_saved_for_it() {
    let program = vendored();
    let tmp = tempfile::tempdir().unwrap();
    let parent = tmp.path().canonicalize().unwrap();
    let ws = workspace(&parent);

    let (saved, layout) = crate::resolve_added(Some(&program), ws.to_str().unwrap()).unwrap();
    assert_eq!(layout, Layout::Workspace);

    start(
        &program,
        &Place {
            layout,
            master: ws.join("ai-sdlc"),
            workspace: ws.clone(),
        },
    );

    found_again(&program, &saved);
}

/// R6.1: the backend works out the layout of the master it is given; the caller says nothing, and a
/// single-repo checkout is never switched.
#[test]
fn the_backend_refuses_to_switch_a_single_repo_checkout_whatever_the_caller_says() {
    let program = vendored();
    let tmp = tempfile::tempdir().unwrap();
    let parent = tmp.path().canonicalize().unwrap();
    let root = single_repo(&parent);
    let master = root.to_str().unwrap();

    let refused = crate::switch_layout(Some(&program), master).unwrap_err();
    assert_eq!(
        refused,
        kata_sdlc::branch::BranchError::NotSwitchable.to_string()
    );
    let info = crate::branches_in(Some(&program), master);
    assert!(!info.switchable);
    assert!(info.others.is_empty());
}

#[test]
fn the_backend_lets_a_workspace_master_be_switched() {
    let program = vendored();
    let tmp = tempfile::tempdir().unwrap();
    let parent = tmp.path().canonicalize().unwrap();
    let ws = workspace(&parent);
    let master = ws.join("ai-sdlc");
    let master = master.to_str().unwrap();

    assert_eq!(
        crate::switch_layout(Some(&program), master).unwrap(),
        Layout::Workspace
    );
    assert!(crate::branches_in(Some(&program), master).switchable);
}

#[test]
fn the_backend_refuses_a_switch_it_cannot_place() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(crate::switch_layout(None, tmp.path().to_str().unwrap()).is_err());
}
