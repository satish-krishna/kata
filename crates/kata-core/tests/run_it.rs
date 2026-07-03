use kata_core::catalog::CatalogEntry;
use kata_core::event::KataEvent;
use kata_core::run::{run, CancelToken, RunError};
use kata_core::spec::RunSpec;
use serial_test::serial;
use std::sync::atomic::Ordering;
use std::time::Duration;

fn base_spec(workdir: &str) -> RunSpec {
    RunSpec {
        schema: 1,
        name: "it".into(),
        task: "do".into(),
        workdir: workdir.into(),
        ..Default::default()
    }
}

// These tests mutate process-global env vars that run() reads, so each is marked
// #[serial] — otherwise parallel tests clobber each other's KATA_FAKE_MODE.
fn with_fake(mode: &str) {
    std::env::set_var("KATA_CLAUDE_BIN", env!("CARGO_BIN_EXE_fake-claude"));
    std::env::set_var("KATA_FAKE_MODE", mode);
    // Always-on transcripts would otherwise write into the developer's real
    // ~/.kata/runs during the suite. Point KATA_HOME at an OS-temp dir. Tests that
    // assert transcript contents override KATA_HOME with their own tempdir after
    // calling with_fake.
    std::env::set_var("KATA_HOME", std::env::temp_dir().join("kata-test-home"));
}

#[test]
#[serial]
fn run_ok_streams_events_and_completes_zero() {
    with_fake("ok");
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(
        &base_spec(&work.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();

    assert_eq!(outcome.exit_code, 0);
    assert!(matches!(events.first(), Some(KataEvent::RunStarted { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::AssistantText { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::ToolUse { .. })));
    match events.last().unwrap() {
        KataEvent::RunCompleted {
            exit_code,
            num_turns,
            is_error,
            ..
        } => {
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
    let outcome = run(
        &base_spec(&work.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();

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
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();

    assert_eq!(
        outcome.exit_code, 0,
        "child blocked on stdin (timed out) instead of completing; events={events:?}"
    );
    assert!(matches!(
        events.last().unwrap(),
        KataEvent::RunCompleted { exit_code: 0, .. }
    ));
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
    run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();

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
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();

    assert_eq!(
        outcome.exit_code, 124,
        "deadline must reap a child that closed stdio but kept running"
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::RunError { .. })));
}

#[test]
#[serial]
fn run_invalid_spec_errors_before_spawn() {
    with_fake("ok");
    let mut spec = base_spec("/w");
    spec.task = "".into();
    let cancel = CancelToken::new();
    let err = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |_| {},
    )
    .unwrap_err();
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
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 124);
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::RunError { .. })));
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
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 130);
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::RunCancelled { exit_code: 130 })));
}

#[test]
#[serial]
fn run_max_turns_kills_child() {
    with_fake("manyturns");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.max_turns = Some(2);
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 125);
    assert!(events.iter().any(|e| matches!(e, KataEvent::Turn { n: 1 })));
    assert!(events.iter().any(|e| matches!(e, KataEvent::Turn { n: 2 })));
    assert!(!events
        .iter()
        .any(|e| matches!(e, KataEvent::Turn { n } if *n >= 3)));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::RunError { exit_code: 125, .. })));
}

#[test]
#[serial]
fn run_unlimited_turns_does_not_cap() {
    with_fake("manyturns");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.max_turns = None; // unlimited
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    // No turn cap fires: all 10 drip turns are counted, none trips exit 125.
    assert!(!events
        .iter()
        .any(|e| matches!(e, KataEvent::RunError { exit_code: 125, .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::Turn { n: 10 })));
    assert_eq!(outcome.exit_code, 0);
}

/// The assistant-text lines the child emitted, in order. The `envreport` fake
/// mode reports each probed variable as one `ENV <name>=<value>` line.
fn assistant_texts(events: &[KataEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            KataEvent::AssistantText { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

/// Run the `envreport` child once, probing the named variables, and return the
/// `ENV name=value` lines it reported.
fn run_envreport(spec: &RunSpec, probe: &str) -> Vec<String> {
    std::env::set_var("KATA_ENV_PROBE", probe);
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    run(
        spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    std::env::remove_var("KATA_ENV_PROBE");
    assistant_texts(&events)
}

#[test]
#[serial]
fn env_var_reaches_child_with_given_value() {
    with_fake("envreport");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.env
        .insert("KATA_PROBE_A".into(), "hello-from-spec".into());
    let lines = run_envreport(&spec, "KATA_PROBE_A");
    assert!(
        lines.iter().any(|l| l == "ENV KATA_PROBE_A=hello-from-spec"),
        "child must see the spec.env value; got {lines:?}"
    );
}

#[test]
#[serial]
fn env_overrides_inherited_parent_value() {
    with_fake("envreport");
    std::env::set_var("KATA_PROBE_B", "from-parent");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.env.insert("KATA_PROBE_B".into(), "child-wins".into());
    let lines = run_envreport(&spec, "KATA_PROBE_B");
    std::env::remove_var("KATA_PROBE_B");
    assert!(
        lines.iter().any(|l| l == "ENV KATA_PROBE_B=child-wins"),
        "spec.env must override the inherited parent value; got {lines:?}"
    );
}

#[test]
#[serial]
fn env_remove_strips_inherited_var() {
    with_fake("envreport");
    std::env::set_var("KATA_PROBE_C", "present-in-parent");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.env_remove.push("KATA_PROBE_C".into());
    let lines = run_envreport(&spec, "KATA_PROBE_C");
    std::env::remove_var("KATA_PROBE_C");
    assert!(
        lines.iter().any(|l| l == "ENV KATA_PROBE_C=<unset>"),
        "env_remove must strip an inherited var from the child; got {lines:?}"
    );
}

#[test]
#[serial]
fn env_overrides_token_derived_api_key() {
    with_fake("envreport");
    std::env::set_var("KATA_TEST_TOKEN_OV", "sk-from-token");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.auth.bare = true;
    spec.auth.token_env = Some("KATA_TEST_TOKEN_OV".into());
    spec.env
        .insert("ANTHROPIC_API_KEY".into(), "sk-override".into());
    let lines = run_envreport(&spec, "ANTHROPIC_API_KEY");
    std::env::remove_var("KATA_TEST_TOKEN_OV");
    assert!(
        lines.iter().any(|l| l == "ENV ANTHROPIC_API_KEY=sk-override"),
        "spec.env must override the token_env-derived key; got {lines:?}"
    );
}

#[test]
#[serial]
fn env_remove_strips_token_derived_api_key() {
    // The direct-to-Anthropic vs bring-your-own-proxy split: strip the real key so
    // it never leaves the host, even though token_env resolved it.
    with_fake("envreport");
    std::env::set_var("KATA_TEST_TOKEN_RM", "sk-real-secret");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.auth.bare = true;
    spec.auth.token_env = Some("KATA_TEST_TOKEN_RM".into());
    spec.env_remove.push("ANTHROPIC_API_KEY".into());
    let lines = run_envreport(&spec, "ANTHROPIC_API_KEY");
    std::env::remove_var("KATA_TEST_TOKEN_RM");
    assert!(
        lines.iter().any(|l| l == "ENV ANTHROPIC_API_KEY=<unset>"),
        "env_remove must strip the token_env-derived key; got {lines:?}"
    );
}

#[test]
#[serial]
fn empty_env_leaves_inherited_environment_intact() {
    // Regression guard: with no env/env_remove the child sees the parent env
    // exactly as before this feature — we must never clear the environment.
    with_fake("envreport");
    std::env::set_var("KATA_PROBE_D", "still-inherited");
    let work = tempfile::tempdir().unwrap();
    let spec = base_spec(&work.path().to_string_lossy());
    assert!(spec.env.is_empty() && spec.env_remove.is_empty());
    let lines = run_envreport(&spec, "KATA_PROBE_D");
    std::env::remove_var("KATA_PROBE_D");
    assert!(
        lines.iter().any(|l| l == "ENV KATA_PROBE_D=still-inherited"),
        "an empty env must leave the inherited environment intact; got {lines:?}"
    );
}

#[test]
#[serial]
fn concurrent_runs_get_divergent_env_without_crosstalk() {
    // The case that justifies the whole enhancement: two runs started at the same
    // time with different env values for the SAME key each produce a child with the
    // respective value. Because the layers are applied via the child Command and
    // never via std::env::set_var, there is no shared-process-environment cross-talk.
    with_fake("envreport");
    std::env::set_var("KATA_ENV_PROBE", "KATA_PROBE_RACE");
    let work_a = tempfile::tempdir().unwrap();
    let work_b = tempfile::tempdir().unwrap();

    let mut spec_a = base_spec(&work_a.path().to_string_lossy());
    spec_a.name = "race-a".into(); // distinct transcript slugs so they can't collide
    spec_a.env.insert("KATA_PROBE_RACE".into(), "run-a".into());
    let mut spec_b = base_spec(&work_b.path().to_string_lossy());
    spec_b.name = "race-b".into();
    spec_b.env.insert("KATA_PROBE_RACE".into(), "run-b".into());

    let collect = |spec: &RunSpec| -> Vec<String> {
        let cancel = CancelToken::new();
        let mut events: Vec<KataEvent> = Vec::new();
        run(
            spec,
            &[] as &[CatalogEntry],
            &cancel,
            &kata_core::run::AnswerRx::default(),
            |e| events.push(e),
        )
        .unwrap();
        assistant_texts(&events)
    };

    let (lines_a, lines_b) = std::thread::scope(|s| {
        let ha = s.spawn(|| collect(&spec_a));
        let hb = s.spawn(|| collect(&spec_b));
        (ha.join().unwrap(), hb.join().unwrap())
    });
    std::env::remove_var("KATA_ENV_PROBE");

    assert!(
        lines_a.iter().any(|l| l == "ENV KATA_PROBE_RACE=run-a"),
        "run A must see its own value; got {lines_a:?}"
    );
    assert!(
        lines_b.iter().any(|l| l == "ENV KATA_PROBE_RACE=run-b"),
        "run B must see its own value; got {lines_b:?}"
    );
    // And no cross-talk: neither child saw the other's value.
    assert!(
        !lines_a.iter().any(|l| l.contains("run-b")),
        "run A must not see run B's value; got {lines_a:?}"
    );
    assert!(
        !lines_b.iter().any(|l| l.contains("run-a")),
        "run B must not see run A's value; got {lines_b:?}"
    );
}

fn init_git_repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(d.path())
            .args(args)
            .status()
            .unwrap()
            .success();
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
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);

    // run.started carried the worktree path + branch.
    let wt_path = match events.first().unwrap() {
        KataEvent::RunStarted {
            worktree: Some(p),
            branch: Some(b),
            isolation,
            ..
        } => {
            assert_eq!(isolation, "worktree");
            assert!(b.starts_with("kata/"), "branch was {b}");
            p.clone()
        }
        other => panic!("expected RunStarted with worktree, got {other:?}"),
    };

    // The agent's file landed in the worktree, NOT the live workdir.
    assert!(std::path::Path::new(&wt_path)
        .join("agent-made.txt")
        .exists());
    assert!(!repo.path().join("agent-made.txt").exists());

    // A run.diff naming the new file was emitted before run.completed.
    let diff_idx = events
        .iter()
        .position(|e| {
            matches!(e,
        KataEvent::RunDiff { files, .. } if files.iter().any(|f| f.path == "agent-made.txt"))
        })
        .expect("a run.diff naming the file");
    let done_idx = events
        .iter()
        .position(|e| matches!(e, KataEvent::RunCompleted { .. }))
        .unwrap();
    assert!(diff_idx < done_idx, "run.diff must precede run.completed");

    std::env::remove_var("KATA_HOME");
    // Best-effort: remove the worktree we created so the test leaves nothing behind.
    let _ = std::process::Command::new("git")
        .arg("-C")
        .arg(repo.path())
        .args(["worktree", "remove", "--force", &wt_path])
        .status();
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
    let err = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap_err();

    assert!(matches!(err, RunError::Auth(_)));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::RunError { .. })));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, KataEvent::RunStarted { .. })),
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
    let err = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap_err();

    assert!(matches!(err, RunError::Worktree(_)));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::RunError { .. })));
    assert!(
        !work.path().join("agent-made.txt").exists(),
        "must not run in the live workdir"
    );

    std::env::remove_var("KATA_HOME");
}

#[test]
#[serial]
fn interactive_run_pauses_and_resumes_on_answer() {
    with_fake("ask");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.interactive.enabled = true;
    let cancel = CancelToken::new();
    let (answer_tx, answers) = kata_core::run::answer_channel();

    // Answer the first ask.requested we observe, from the emit closure.
    let mut events: Vec<KataEvent> = Vec::new();
    let tx = answer_tx.clone();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, &answers, |e| {
        if let KataEvent::AskRequested { id, .. } = &e {
            tx.send(kata_core::run::Answer {
                id: id.clone(),
                answers: vec![vec!["JWT".into()]],
            })
            .unwrap();
        }
        events.push(e);
    })
    .unwrap();

    assert_eq!(outcome.exit_code, 0);
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::AskRequested { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::AskAnswered { .. })));
    assert!(matches!(
        events.last().unwrap(),
        KataEvent::RunCompleted { exit_code: 0, .. }
    ));
}

#[test]
#[serial]
fn interactive_run_answer_deadline_reaps_with_123() {
    with_fake("ask"); // asks, then waits forever for an answer that never comes
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.interactive.enabled = true;
    spec.interactive.answer_timeout_secs = Some(1);
    let cancel = CancelToken::new();
    let (_tx, answers) = kata_core::run::answer_channel();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(&spec, &[] as &[CatalogEntry], &cancel, &answers, |e| {
        events.push(e)
    })
    .unwrap();

    assert_eq!(outcome.exit_code, 123, "answer-deadline must reap with 123");
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::AskRequested { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::RunError { .. })));
}

#[test]
#[serial]
fn run_writes_transcript_of_the_event_stream() {
    with_fake("ok");
    let khome = tempfile::tempdir().unwrap();
    std::env::set_var("KATA_HOME", khome.path());
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(
        &base_spec(&work.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);

    let runs = khome.path().join("runs");
    let files: Vec<_> = std::fs::read_dir(&runs)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(
        files.len(),
        1,
        "exactly one transcript expected, got {files:?}"
    );

    let body = std::fs::read_to_string(&files[0]).unwrap();
    let lines: Vec<&str> = body.lines().collect();
    assert!(
        lines
            .iter()
            .all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok()),
        "every transcript line must be valid JSON: {body}"
    );
    let first: serde_json::Value = serde_json::from_str(lines.first().unwrap()).unwrap();
    let last: serde_json::Value = serde_json::from_str(lines.last().unwrap()).unwrap();
    assert_eq!(first["type"], "run.started");
    assert_eq!(last["type"], "run.completed");

    assert_eq!(
        outcome.transcript_path.as_deref(),
        Some(files[0].to_string_lossy().as_ref())
    );

    std::env::remove_var("KATA_HOME");
}

#[test]
#[serial]
fn run_budget_exhausted_reports_122() {
    with_fake("budget");
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.max_budget_usd = Some(0.01);
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();

    assert_eq!(
        outcome.exit_code, 122,
        "budget exhaustion must map to exit 122"
    );
    match events.last().unwrap() {
        KataEvent::RunError { message, .. } => assert!(
            message.contains("budget"),
            "terminal RunError should mention the budget, got: {message}"
        ),
        other => panic!("expected RunError terminal event, got {other:?}"),
    }
}

#[test]
#[serial]
fn budget_subtype_without_configured_ceiling_is_not_122() {
    // Exit 122 is only reachable when leash.max_budget_usd is set. A result
    // carrying the error_max_budget_usd subtype but no configured ceiling stays
    // a normal completion (defensive against future subtype reuse).
    with_fake("budget");
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let spec = base_spec(&work.path().to_string_lossy()); // no max_budget_usd
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();

    assert_ne!(outcome.exit_code, 122, "no ceiling set must not map to 122");
    assert!(
        matches!(events.last().unwrap(), KataEvent::RunCompleted { .. }),
        "without a ceiling the run completes normally, got: {:?}",
        events.last().unwrap()
    );
}

#[test]
#[serial]
fn run_survives_when_transcript_cannot_be_written() {
    with_fake("ok");
    // A regular file where a directory is needed makes create_dir_all fail — portably.
    let blocker = tempfile::NamedTempFile::new().unwrap();
    std::env::set_var("KATA_HOME", blocker.path());
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(
        &base_spec(&work.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        |e| events.push(e),
    )
    .unwrap();

    assert_eq!(
        outcome.exit_code, 0,
        "a missing transcript must never fail the run"
    );
    assert!(outcome.transcript_path.is_none());
    assert!(
        events.iter().any(|e| matches!(e,
        KataEvent::Log { level, message } if level == "warn" && message.contains("transcript"))),
        "a warn log must explain the missing transcript"
    );

    std::env::remove_var("KATA_HOME");
}
