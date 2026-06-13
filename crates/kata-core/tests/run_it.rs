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
