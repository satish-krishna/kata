use kata_core::catalog::CatalogEntry;
use kata_core::event::KataEvent;
use kata_core::run::{run, CancelToken, RunError};
use kata_core::spec::RunSpec;
use serial_test::serial;
use std::sync::atomic::Ordering;
use std::time::Duration;

fn base_spec(workdir: &str) -> RunSpec {
    RunSpec { schema: 1, name: "it".into(), task: "do".into(), workdir: workdir.into(), ..Default::default() }
}

// These tests mutate process-global env vars that run() reads, so each is marked
// #[serial] — otherwise parallel tests clobber each other's KATA_FAKE_MODE.
fn with_fake(mode: &str) {
    std::env::set_var("KATA_CLAUDE_BIN", env!("CARGO_BIN_EXE_fake-claude"));
    std::env::set_var("KATA_FAKE_MODE", mode);
}

#[test]
#[serial]
fn run_ok_streams_events_and_completes_zero() {
    with_fake("ok");
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(&base_spec(&work.path().to_string_lossy()), &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();

    assert_eq!(outcome.exit_code, 0);
    assert!(matches!(events.first(), Some(KataEvent::RunStarted { .. })));
    assert!(events.iter().any(|e| matches!(e, KataEvent::AssistantText { .. })));
    assert!(events.iter().any(|e| matches!(e, KataEvent::ToolUse { .. })));
    match events.last().unwrap() {
        KataEvent::RunCompleted { exit_code, num_turns, is_error, .. } => {
            assert_eq!(*exit_code, 0);
            assert_eq!(*num_turns, 2);
            assert!(!*is_error);
        }
        other => panic!("expected RunCompleted, got {other:?}"),
    }
}

#[test]
#[serial]
fn run_surfaces_child_stderr_as_log_events() {
    with_fake("stderr");
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(&base_spec(&work.path().to_string_lossy()), &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();

    assert_eq!(outcome.exit_code, 0);
    assert!(
        events.iter().any(|e| matches!(e,
            KataEvent::Log { level, message }
                if level == "warn" && message.contains("diagnostic from claude on stderr"))),
        "expected a warn Log event carrying the child's stderr line, got {events:?}"
    );
}

#[test]
#[serial]
fn run_gives_child_noninteractive_stdin_so_it_cannot_block() {
    // A child that reads stdin must not hang waiting for input it will never get.
    // Kata gives claude a closed (null) stdin, so the read EOFs immediately and the
    // run completes; without that, a blocked child would trip the leash timeout.
    with_fake("blockstdin");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.timeout_secs = Some(2); // guard: a stdin-blocked child times out (124)
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();

    assert_eq!(
        outcome.exit_code, 0,
        "child blocked on stdin (timed out) instead of completing; events={events:?}"
    );
    assert!(matches!(events.last().unwrap(), KataEvent::RunCompleted { exit_code: 0, .. }));
}

#[test]
#[serial]
fn run_logs_default_timeout_cap_when_unset() {
    // A spec with no timeout_secs must not run unbounded: the engine applies a
    // default wall-clock cap and says so, so "forever" is never silent.
    with_fake("ok");
    let work = tempfile::tempdir().unwrap();
    let spec = base_spec(&work.path().to_string_lossy()); // timeout_secs defaults to None
    assert_eq!(spec.leash.timeout_secs, None);
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();

    assert!(
        events.iter().any(|e| matches!(e,
            KataEvent::Log { level, message }
                if level == "info" && message.contains("default") && message.contains("cap"))),
        "expected an info Log announcing the default timeout cap, got {events:?}"
    );
}

#[test]
#[serial]
fn run_reaps_child_that_closes_stdio_but_lingers() {
    // A child that closes stdout+stderr (reader threads disconnect) but keeps
    // running must still be reaped by the wall-clock deadline — not block forever
    // in child.wait(). Without a leashed wait this hangs well past the deadline.
    with_fake("closestdio");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.timeout_secs = Some(1);
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();

    assert_eq!(
        outcome.exit_code, 124,
        "deadline must reap a child that closed stdio but kept running"
    );
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunError { .. })));
}

#[test]
#[serial]
fn run_invalid_spec_errors_before_spawn() {
    with_fake("ok");
    let mut spec = base_spec("/w");
    spec.task = "".into();
    let cancel = CancelToken::new();
    let err = run(&spec, &[] as &[CatalogEntry], &cancel, |_| {}).unwrap_err();
    assert!(matches!(err, RunError::Invalid(_)));
}

#[test]
#[serial]
fn run_timeout_kills_child_and_reports_error() {
    with_fake("sleep");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.timeout_secs = Some(1);
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();
    assert_eq!(outcome.exit_code, 124);
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunError { .. })));
}

#[test]
#[serial]
fn run_cancel_kills_child() {
    with_fake("sleep");
    let work = tempfile::tempdir().unwrap();
    let spec = base_spec(&work.path().to_string_lossy());
    let cancel = CancelToken::new();
    let flag = cancel.flag();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        flag.store(true, Ordering::SeqCst);
    });
    let mut events = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();
    assert_eq!(outcome.exit_code, 130);
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunCancelled)));
}

#[test]
#[serial]
fn run_max_turns_kills_child() {
    with_fake("manyturns");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.max_turns = 2;
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();
    assert_eq!(outcome.exit_code, 125);
    assert!(events.iter().any(|e| matches!(e, KataEvent::Turn { n: 1 })));
    assert!(events.iter().any(|e| matches!(e, KataEvent::Turn { n: 2 })));
    assert!(!events.iter().any(|e| matches!(e, KataEvent::Turn { n } if *n >= 3)));
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunError { .. })));
}

fn init_git_repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git").arg("-C").arg(d.path()).args(args).status().unwrap().success();
        assert!(ok, "git {args:?} failed");
    };
    git(&["init", "-q"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(d.path().join("seed.txt"), "seed\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "init"]);
    d
}

#[test]
#[serial]
fn worktree_isolation_runs_in_worktree_and_emits_diff() {
    with_fake("writefile");
    let repo = init_git_repo();
    let khome = tempfile::tempdir().unwrap();
    std::env::set_var("KATA_HOME", khome.path());

    let mut spec = base_spec(&repo.path().to_string_lossy());
    spec.leash.isolation = kata_core::spec::Isolation::Worktree;
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap();
    assert_eq!(outcome.exit_code, 0);

    // run.started carried the worktree path + branch.
    let wt_path = match events.first().unwrap() {
        KataEvent::RunStarted { worktree: Some(p), branch: Some(b), isolation, .. } => {
            assert_eq!(isolation, "worktree");
            assert!(b.starts_with("kata/"), "branch was {b}");
            p.clone()
        }
        other => panic!("expected RunStarted with worktree, got {other:?}"),
    };

    // The agent's file landed in the worktree, NOT the live workdir.
    assert!(std::path::Path::new(&wt_path).join("agent-made.txt").exists());
    assert!(!repo.path().join("agent-made.txt").exists());

    // A run.diff naming the new file was emitted before run.completed.
    let diff_idx = events.iter().position(|e| matches!(e,
        KataEvent::RunDiff { files, .. } if files.iter().any(|f| f.path == "agent-made.txt"))).expect("a run.diff naming the file");
    let done_idx = events.iter().position(|e| matches!(e, KataEvent::RunCompleted { .. })).unwrap();
    assert!(diff_idx < done_idx, "run.diff must precede run.completed");

    std::env::remove_var("KATA_HOME");
    // Best-effort: remove the worktree we created so the test leaves nothing behind.
    let _ = std::process::Command::new("git").arg("-C").arg(repo.path())
        .args(["worktree", "remove", "--force", &wt_path]).status();
}

#[test]
#[serial]
fn run_refuses_bare_run_with_unresolved_token_env() {
    with_fake("ok");
    std::env::remove_var("KATA_MISSING_TOKEN"); // ensure the referenced var is unset
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.auth.bare = true;
    spec.auth.token_env = Some("KATA_MISSING_TOKEN".into());
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let err = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap_err();

    assert!(matches!(err, RunError::Auth(_)));
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunError { .. })));
    assert!(
        !events.iter().any(|e| matches!(e, KataEvent::RunStarted { .. })),
        "must refuse before run.started"
    );
}

#[test]
#[serial]
fn worktree_isolation_refuses_non_repo() {
    with_fake("writefile");
    let work = tempfile::tempdir().unwrap(); // NOT a git repo
    let khome = tempfile::tempdir().unwrap();
    std::env::set_var("KATA_HOME", khome.path());

    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.isolation = kata_core::spec::Isolation::Worktree;
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let err = run(&spec, &[] as &[CatalogEntry], &cancel, |e| events.push(e)).unwrap_err();

    assert!(matches!(err, RunError::Worktree(_)));
    assert!(events.iter().any(|e| matches!(e, KataEvent::RunError { .. })));
    assert!(!work.path().join("agent-made.txt").exists(), "must not run in the live workdir");

    std::env::remove_var("KATA_HOME");
}
