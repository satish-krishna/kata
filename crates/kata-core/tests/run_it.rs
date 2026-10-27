#![allow(clippy::disallowed_methods)]
use kata_core::catalog::CatalogEntry;
use kata_core::event::KataEvent;
use kata_core::run::{run, run_with, CancelToken, RunError, RunOptions};
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 130);
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::RunCancelled { exit_code: 130, .. })));
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
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 125);
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::Turn { n: 1, .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::Turn { n: 2, .. })));
    assert!(!events
        .iter()
        .any(|e| matches!(e, KataEvent::Turn { n, .. } if *n >= 3)));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::RunError { exit_code: 125, .. })));
}

#[test]
#[serial]
fn run_max_turns_counts_messages_not_lines() {
    with_fake("splitturns");
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
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    // Two messages of two lines each fit under a cap of 2; the third message trips it.
    assert_eq!(outcome.exit_code, 125);
    let texts: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            KataEvent::AssistantText { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, ["turn 1", "turn 2"]);
    assert!(!events
        .iter()
        .any(|e| matches!(e, KataEvent::Turn { n, .. } if *n >= 3)));
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
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    // No turn cap fires: all 10 drip turns are counted, none trips exit 125.
    assert!(!events
        .iter()
        .any(|e| matches!(e, KataEvent::RunError { exit_code: 125, .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::Turn { n: 10, .. })));
    assert_eq!(outcome.exit_code, 0);
}

/// The assistant-text lines the child emitted, in order. The `envreport` fake
/// mode reports each probed variable as one `ENV <name>=<value>` line.
fn assistant_texts(events: &[KataEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            KataEvent::AssistantText { text, .. } => Some(text.clone()),
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
        &kata_core::run::DecisionRx::default(),
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
        lines
            .iter()
            .any(|l| l == "ENV KATA_PROBE_A=hello-from-spec"),
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
        lines
            .iter()
            .any(|l| l == "ENV ANTHROPIC_API_KEY=sk-override"),
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
        lines
            .iter()
            .any(|l| l == "ENV KATA_PROBE_D=still-inherited"),
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
            &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &answers,
        &kata_core::run::DecisionRx::default(),
        |e| {
            if let KataEvent::AskRequested { id, .. } = &e {
                tx.send(kata_core::run::Answer {
                    id: id.clone(),
                    answers: vec![vec!["JWT".into()]],
                })
                .unwrap();
            }
            events.push(e);
        },
    )
    .unwrap();

    assert_eq!(outcome.exit_code, 0);
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::AskRequested { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::AskAnswered { .. })));
    // The bridge tool's tool_use and tool_result are both suppressed in the
    // live loop; the question surfaces only as ask.requested / ask.answered.
    assert!(
        !events.iter().any(|e| matches!(e,
            KataEvent::ToolUse { id, .. } | KataEvent::ToolResult { id, .. }
                if id.as_deref() == Some("toolu_ask"))),
        "ask_user must not surface as a tool row"
    );
    assert!(matches!(
        events.last().unwrap(),
        KataEvent::RunCompleted { exit_code: 0, .. }
    ));
}

#[test]
#[serial]
fn awaiting_does_not_count_against_the_wall_clock_r4_1() {
    with_fake("ask");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.interactive.enabled = true;
    spec.leash.timeout_secs = Some(1);
    let cancel = CancelToken::new();
    let (answer_tx, answers) = kata_core::run::answer_channel();

    // The operator takes 3 seconds to answer, three times the time limit.
    let mut events: Vec<KataEvent> = Vec::new();
    let tx = answer_tx.clone();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &answers,
        &kata_core::run::DecisionRx::default(),
        |e| {
            if let KataEvent::AskRequested { id, .. } = &e {
                let tx = tx.clone();
                let id = id.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = tx.send(kata_core::run::Answer {
                        id,
                        answers: vec![vec!["JWT".into()]],
                    });
                });
            }
            events.push(e);
        },
    )
    .unwrap();

    assert_eq!(
        outcome.exit_code, 0,
        "waiting on the operator must not trip the time limit"
    );
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
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &answers,
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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
        &kata_core::run::DecisionRx::default(),
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

#[test]
#[serial]
fn default_run_in_git_workdir_emits_changeset() {
    // No worktree isolation: the agent writes into the live workdir, and a
    // run.diff naming that file is emitted before run.completed, with no
    // worktree/branch (they are None for a non-isolated run).
    with_fake("writefile");
    let repo = init_git_repo();
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(
        &base_spec(&repo.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);

    let diff_idx = events
        .iter()
        .position(|e| {
            matches!(e,
            KataEvent::RunDiff { worktree: None, branch: None, files, .. }
                if files.iter().any(|f| f.path == "agent-made.txt"))
        })
        .expect("a run.diff naming the file, with no worktree/branch");
    let done_idx = events
        .iter()
        .position(|e| matches!(e, KataEvent::RunCompleted { .. }))
        .unwrap();
    assert!(diff_idx < done_idx, "run.diff must precede run.completed");
}

#[test]
#[serial]
fn default_run_in_non_git_workdir_notes_no_changeset() {
    // A plain (non-git) workdir has no HEAD to diff: no run.diff, and a
    // deterministic info log explains why (not a scary warn). The run still
    // completes normally.
    with_fake("writefile");
    let work = tempfile::tempdir().unwrap(); // NOT a git repo
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let outcome = run(
        &base_spec(&work.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);

    assert!(
        !events
            .iter()
            .any(|e| matches!(e, KataEvent::RunDiff { .. })),
        "a non-git workdir must emit no run.diff"
    );
    assert!(
        events.iter().any(|e| matches!(e,
            KataEvent::Log { level, message }
                if level == "info" && message == "no changeset: workdir is not a git repository")),
        "a deterministic info log must explain the missing changeset, got {events:?}"
    );
}

#[test]
#[serial]
fn cancelled_run_reports_duration() {
    // run.cancelled now carries duration_ms (cost is None — the killed child
    // never reported one).
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
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 130);
    assert!(
        events.iter().any(|e| matches!(e,
            KataEvent::RunCancelled { exit_code: 130, cost_usd: None, duration_ms }
                if *duration_ms > 0)),
        "run.cancelled must carry a positive duration_ms, got {events:?}"
    );
}

// ---------------------------------------------------------------------------
// [permissions] mode = "prompt": the route for a machine whose managed settings
// forbid --dangerously-skip-permissions. The `approve` fake mode plays the
// mcp-ask server, so these drive the real bridge end to end.
// ---------------------------------------------------------------------------

fn prompt_spec(workdir: &str) -> RunSpec {
    let mut spec = base_spec(workdir);
    spec.permissions.mode = kata_core::spec::PermissionMode::Prompt;
    spec.permissions.unmatched = kata_core::spec::UnmatchedPolicy::Deny;
    spec
}

/// Run the `approve` fake against `spec`, optionally overriding the tool call it
/// asks about, and return the events.
fn run_prompt(spec: &RunSpec, tool: Option<&str>, input: Option<&str>) -> (i32, Vec<KataEvent>) {
    with_fake("approve");
    match tool {
        Some(t) => std::env::set_var("KATA_FAKE_TOOL", t),
        None => std::env::remove_var("KATA_FAKE_TOOL"),
    }
    match input {
        Some(i) => std::env::set_var("KATA_FAKE_TOOL_INPUT", i),
        None => std::env::remove_var("KATA_FAKE_TOOL_INPUT"),
    }
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(
        spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    std::env::remove_var("KATA_FAKE_TOOL");
    std::env::remove_var("KATA_FAKE_TOOL_INPUT");
    (outcome.exit_code, events)
}

fn decision(events: &[KataEvent]) -> (bool, String, Option<String>) {
    events
        .iter()
        .find_map(|e| match e {
            KataEvent::PermissionDecided {
                allow,
                decided_by,
                message,
                ..
            } => Some((*allow, decided_by.clone(), message.clone())),
            _ => None,
        })
        .expect("expected a permission.decided event")
}

/// The assistant text the `approve` fake echoes: the raw verdict frame the
/// engine sent back down the bridge. Proves the decision reached the child.
fn verdict_text(events: &[KataEvent]) -> String {
    events
        .iter()
        .find_map(|e| match e {
            KataEvent::AssistantText { text, .. } => Some(text.clone()),
            _ => None,
        })
        .expect("expected the fake to echo the verdict")
}

#[test]
#[serial]
fn prompt_mode_denies_an_unmatched_call_under_the_deny_policy() {
    let work = tempfile::tempdir().unwrap();
    let spec = prompt_spec(&work.path().to_string_lossy());
    let (exit, events) = run_prompt(&spec, None, None);

    assert_eq!(exit, 0, "a denied tool call is not a failed run");
    let (allow, by, message) = decision(&events);
    assert!(!allow);
    assert_eq!(by, "unmatched-policy");
    assert!(
        message.unwrap_or_default().contains("permissions.allow"),
        "the denial must tell claude how the run is scoped"
    );
    assert!(
        verdict_text(&events).contains("deny"),
        "the verdict must reach the child: {}",
        verdict_text(&events)
    );
    // Nothing paused: an auto-resolved check emits no permission.requested.
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, KataEvent::PermissionRequested { .. })),
        "a policy-resolved call must not pause the run"
    );
}

#[test]
#[serial]
fn prompt_mode_records_the_call_being_decided() {
    let work = tempfile::tempdir().unwrap();
    let spec = prompt_spec(&work.path().to_string_lossy());
    let (_, events) = run_prompt(&spec, Some("Bash"), Some(r#"{"command":"rm -rf build/"}"#));

    let summarized = events.iter().any(|e| {
        matches!(e, KataEvent::PermissionDecided { tool, input_summary, .. }
            if tool == "Bash" && input_summary == "rm -rf build/")
    });
    assert!(
        summarized,
        "the audit trail must name the tool and its target: {events:?}"
    );
}

#[test]
#[serial]
fn prompt_mode_ask_pauses_until_the_operator_decides() {
    with_fake("approve");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.permissions.mode = kata_core::spec::PermissionMode::Prompt;
    // "ask" is the default policy; it needs an operator, so interactive is on.
    spec.interactive.enabled = true;
    let cancel = CancelToken::new();
    let (decision_tx, decisions) = kata_core::run::decision_channel();

    let mut events: Vec<KataEvent> = Vec::new();
    let tx = decision_tx.clone();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &decisions,
        |e| {
            if let KataEvent::PermissionRequested { id, .. } = &e {
                tx.send(kata_core::run::Decision {
                    id: id.clone(),
                    allow: false,
                    message: Some("not on this branch".into()),
                })
                .unwrap();
            }
            events.push(e);
        },
    )
    .unwrap();

    assert_eq!(outcome.exit_code, 0);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, KataEvent::PermissionRequested { .. })),
        "an unmatched call under ask must pause the run"
    );
    let (allow, by, message) = decision(&events);
    assert!(!allow);
    assert_eq!(by, "operator");
    assert_eq!(message.as_deref(), Some("not on this branch"));
    assert!(
        verdict_text(&events).contains("not on this branch"),
        "the operator's reason must reach claude"
    );
}

#[test]
#[serial]
fn prompt_mode_ask_hits_the_answer_deadline_with_123() {
    with_fake("approve"); // asks, then waits forever for a decision that never comes
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.permissions.mode = kata_core::spec::PermissionMode::Prompt;
    spec.interactive.enabled = true;
    spec.interactive.answer_timeout_secs = Some(1);
    let cancel = CancelToken::new();
    let (_tx, decisions) = kata_core::run::decision_channel();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &decisions,
        |e| events.push(e),
    )
    .unwrap();

    assert_eq!(
        outcome.exit_code, 123,
        "an undecided permission check is reaped by the same answer deadline"
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, KataEvent::PermissionRequested { .. })));
}

// The default posture must be exactly what it was before the field existed.
#[test]
#[serial]
fn bypass_mode_wires_no_permission_bridge() {
    with_fake("ok");
    let work = tempfile::tempdir().unwrap();
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(
        &base_spec(&work.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();

    assert_eq!(outcome.exit_code, 0);
    assert!(
        !events.iter().any(|e| matches!(
            e,
            KataEvent::PermissionRequested { .. } | KataEvent::PermissionDecided { .. }
        )),
        "a bypass run must emit no permission events at all"
    );
}

// Regression: `ask_user` is an ordinary MCP tool to claude, so under prompt mode
// it goes through the permission check like anything else. A headless deny
// policy must not be able to silently switch interactivity off.
#[test]
#[serial]
fn prompt_mode_never_puts_katas_own_tools_to_the_rules() {
    let work = tempfile::tempdir().unwrap();
    // The strictest posture there is: deny everything unmatched, allow nothing.
    let spec = prompt_spec(&work.path().to_string_lossy());
    let (exit, events) = run_prompt(
        &spec,
        Some("mcp__kata-ask__ask_user"),
        Some(r#"{"questions":[]}"#),
    );

    assert_eq!(exit, 0);
    let (allow, by, _) = decision(&events);
    assert!(allow, "the engine's own bridge tool must not be deniable");
    assert_eq!(by, "engine");
}

// The rules are no longer matched engine-side: they are handed to claude in a
// generated settings file and claude enforces them. That is what lets a deny
// cover the read-only commands claude auto-approves without consulting anyone.
#[test]
#[serial]
fn prompt_mode_writes_a_settings_file_with_the_spec_rules_verbatim() {
    with_fake("settingsecho");
    let work = tempfile::tempdir().unwrap();
    let mut spec = prompt_spec(&work.path().to_string_lossy());
    spec.permissions.allow.push("Bash(git *)".into());
    spec.permissions.allow.push("Read(*)".into());
    spec.permissions.deny.push("Bash(rm *)".into());
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();

    assert_eq!(outcome.exit_code, 0);
    let text = assistant_texts(&events)
        .into_iter()
        .find(|t| t.starts_with("SETTINGS "))
        .expect("fake-claude must echo the --settings file it was given");
    let body = text.trim_start_matches("SETTINGS ");
    let actual: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|e| panic!("settings file was not JSON ({e}): {body}"));
    let expected = serde_json::json!({
        "permissions": {
            "allow": ["Bash(git *)", "Read(*)"],
            "deny": ["Bash(rm *)"],
            "ask": [],
        }
    });
    assert_eq!(
        actual, expected,
        "settings file content must be exactly the spec's rule arrays, verbatim"
    );
}

#[test]
#[serial]
fn auto_mode_writes_ask_rules_into_the_settings_file() {
    with_fake("settingsecho");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.permissions.mode = kata_core::spec::PermissionMode::Auto;
    spec.interactive.enabled = true;
    spec.permissions.deny.push("Bash(rm *)".into());
    spec.permissions.ask.push("Bash(git push *)".into());
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);
    let text = assistant_texts(&events)
        .into_iter()
        .find(|t| t.starts_with("SETTINGS "))
        .expect("auto mode must write a --settings file");
    let actual: serde_json::Value =
        serde_json::from_str(text.trim_start_matches("SETTINGS ")).unwrap();
    let expected = serde_json::json!({
        "permissions": {
            "allow": [],
            "deny": ["Bash(rm *)"],
            "ask": ["Bash(git push *)"],
        }
    });
    assert_eq!(actual, expected);
}

#[test]
#[serial]
fn auto_mode_routes_a_reaching_call_to_the_operator() {
    with_fake("approve");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.permissions.mode = kata_core::spec::PermissionMode::Auto;
    spec.interactive.enabled = true;
    spec.permissions.ask.push("Bash(*)".into());
    // A valid auto spec: unmatched is left at its default (validate rejects an
    // explicit unmatched under auto, and run() validates first). Under auto the
    // decision path routes a reaching call to the operator; this characterizes
    // that observable contract. It is not fail-first — the default Ask policy
    // would also pause — so the explicit auto branch is defensive per the design
    // (spec Section D).
    let cancel = CancelToken::new();
    let (decision_tx, decisions) = kata_core::run::decision_channel();
    let mut events: Vec<KataEvent> = Vec::new();
    let tx = decision_tx.clone();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &decisions,
        |e| {
            if let KataEvent::PermissionRequested { id, .. } = &e {
                tx.send(kata_core::run::Decision {
                    id: id.clone(),
                    allow: true,
                    message: None,
                })
                .unwrap();
            }
            events.push(e);
        },
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, KataEvent::PermissionRequested { .. })),
        "under auto, a call reaching approve_tool must pause on the operator"
    );
    let (allow, by, _msg) = decision(&events);
    assert!(allow);
    assert_eq!(by, "operator");
}

// Permission mode governs tool approval, not whether claude wants to ask a
// question — and its built-in AskUserQuestion kills a headless session. So Kata's
// `ask_user` is wired into every run, whatever the mode, interactive or not.
#[test]
#[serial]
fn ask_user_is_wired_in_every_permission_mode_even_when_not_interactive() {
    with_fake("envreport");
    for mode in [
        kata_core::spec::PermissionMode::Bypass,
        kata_core::spec::PermissionMode::Prompt,
        kata_core::spec::PermissionMode::Auto,
    ] {
        let work = tempfile::tempdir().unwrap();
        let mut spec = base_spec(&work.path().to_string_lossy());
        spec.permissions.mode = mode;
        if mode == kata_core::spec::PermissionMode::Prompt {
            spec.permissions.unmatched = kata_core::spec::UnmatchedPolicy::Deny;
        }
        assert!(!spec.interactive.enabled);
        let lines = run_envreport(&spec, "KATA_MCP_TOOLS,KATA_ASK_PORT");
        let tools = lines
            .iter()
            .find_map(|l| l.strip_prefix("ENV KATA_MCP_TOOLS="))
            .unwrap_or_else(|| panic!("{mode:?}: no KATA_MCP_TOOLS line in {lines:?}"));
        assert!(
            tools.split(',').any(|t| t == "ask_user"),
            "{mode:?}: ask_user must be advertised on a non-interactive run; got {tools:?}"
        );
        assert!(
            !lines.iter().any(|l| l == "ENV KATA_ASK_PORT=<unset>"),
            "{mode:?}: the ask bridge must be bound; got {lines:?}"
        );
    }
}

// No automatic answer: a question on a non-interactive run pauses on the
// operator exactly as it does on an interactive one.
#[test]
#[serial]
fn non_interactive_run_still_pauses_on_a_question_for_the_operator() {
    with_fake("ask");
    let work = tempfile::tempdir().unwrap();
    let spec = base_spec(&work.path().to_string_lossy());
    assert!(!spec.interactive.enabled);
    let cancel = CancelToken::new();
    let (answer_tx, answers) = kata_core::run::answer_channel();
    let mut events: Vec<KataEvent> = Vec::new();
    let outcome = run(
        &spec,
        &[] as &[CatalogEntry],
        &cancel,
        &answers,
        &kata_core::run::DecisionRx::default(),
        |e| {
            if let KataEvent::AskRequested { id, .. } = &e {
                answer_tx
                    .send(kata_core::run::Answer {
                        id: id.clone(),
                        answers: vec![vec!["from the operator".into()]],
                    })
                    .unwrap();
            }
            events.push(e);
        },
    )
    .unwrap();

    assert_eq!(outcome.exit_code, 0);
    let answered = events.iter().find_map(|e| match e {
        KataEvent::AskAnswered { answers, .. } => Some(answers.clone()),
        _ => None,
    });
    assert_eq!(
        answered,
        Some(vec![vec!["from the operator".to_string()]]),
        "the answer must be the operator's, not an automatic one: {events:?}"
    );
}

// A question nobody can ever answer must not hang the run: the work clock is
// paused while awaiting, so without this an unattended run (CI with stdin at
// EOF) with no answer deadline would wait forever. It ends with 123, the
// "nobody answered" code, as soon as the inbox is known to be closed.
#[test]
#[serial]
fn a_question_nobody_can_answer_ends_the_run_with_123() {
    with_fake("ask");
    for dropped_sender in [false, true] {
        let work = tempfile::tempdir().unwrap();
        let spec = base_spec(&work.path().to_string_lossy());
        assert_eq!(spec.interactive.answer_timeout_secs, None);
        let answers = if dropped_sender {
            let (tx, rx) = kata_core::run::answer_channel();
            drop(tx);
            rx
        } else {
            kata_core::run::AnswerRx::default()
        };
        let cancel = CancelToken::new();
        let mut events: Vec<KataEvent> = Vec::new();
        let started = std::time::Instant::now();
        let outcome = run(
            &spec,
            &[] as &[CatalogEntry],
            &cancel,
            &answers,
            &kata_core::run::DecisionRx::default(),
            |e| events.push(e),
        )
        .unwrap();

        assert_eq!(outcome.exit_code, 123, "dropped_sender={dropped_sender}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(30),
            "must end promptly, not wait out a deadline"
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                KataEvent::RunError { message, exit_code: 123, .. }
                    if message.contains("nobody can answer")
            )),
            "dropped_sender={dropped_sender}: {events:?}"
        );
    }
}

fn run_subagent(opts: RunOptions) -> Vec<KataEvent> {
    with_fake("subagent");
    let work = tempfile::tempdir().unwrap();
    let mut events = Vec::new();
    let outcome = run_with(
        &base_spec(&work.path().to_string_lossy()),
        &[] as &[CatalogEntry],
        &CancelToken::new(),
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        opts,
        |e| events.push(e),
    )
    .unwrap();
    assert_eq!(outcome.exit_code, 0);
    events
}

#[test]
#[serial]
fn tool_results_carry_their_tool_name_ids_and_parent() {
    // Before this change the live loop parsed each line with a fresh parser,
    // so every tool.result had name "" in a real run.
    let events = run_subagent(RunOptions::default());
    let read_result = events
        .iter()
        .find_map(|e| match e {
            KataEvent::ToolResult {
                id,
                name,
                parent_id,
                output,
                ..
            } if id.as_deref() == Some("toolu_B") => {
                Some((name.clone(), parent_id.clone(), output.clone()))
            }
            _ => None,
        })
        .expect("a tool.result for the subagent's Read");
    assert_eq!(read_result, ("Read".into(), Some("toolu_A".into()), None));
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::ToolUse { name, parent_id: None, .. } if name == "Agent")));
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::AssistantText { text, parent_id: Some(p) } if text == "reading" && p == "toolu_A")));
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::Turn { parent_id: Some(p), .. } if p == "toolu_A")));
}

#[test]
#[serial]
fn full_payloads_adds_input_and_output() {
    let events = run_subagent(RunOptions {
        full_payloads: true,
    });
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::ToolUse { name, input: Some(i), .. }
            if name == "Read" && i == &serde_json::json!({"file_path": "probe.txt"}))));
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::ToolResult { name, output: Some(o), .. } if name == "Read" && o == "1	hello")));
    assert!(events.iter().any(|e| matches!(e,
        KataEvent::ToolResult { name, output: Some(o), .. } if name == "Agent" && o == "probe.txt says hello")));
}

// ---------------------------------------------------------------------------
// Opt-in proofs of the claude behaviors the AI-SDLC build relies on (plan T36).
// Each drives a real, authenticated `claude` and runs only when KATA_SMOKE_REAL=1.
// They cost tokens. They answer spec areas of concern 12 and 18 on the claude
// version of the machine they run on.
// ---------------------------------------------------------------------------

fn build_proof_enabled() -> bool {
    if std::env::var("KATA_SMOKE_REAL").as_deref() != Ok("1") {
        eprintln!("skipping build proof (set KATA_SMOKE_REAL=1 to enable)");
        return false;
    }
    true
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let to = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir_all(&entry.path(), &to);
        } else {
            std::fs::copy(entry.path(), &to).unwrap();
        }
    }
}

/// Mirrors `slashes` and `rulePath` in `app/src/app/lib/sdlc.ts`: claude's
/// absolute-path rule form is `//` then the path with forward slashes, and on
/// Windows the drive is a lowercase letter without a colon (`D:\ws` is `//d/ws`).
/// A change to those functions must change this one.
fn rule_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/');
    let b = s.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'/')
    {
        return format!(
            "//{}/{}",
            s[..1].to_lowercase(),
            s[2..].trim_start_matches('/')
        );
    }
    format!("//{}", s.trim_start_matches('/'))
}

/// A workspace copied from the build-proof fixture: `app`, `api`, and the
/// `master` repository, plus a separate checks folder outside the workspace.
struct ProofWorkspace {
    _root: tempfile::TempDir,
    ws: std::path::PathBuf,
    checks: std::path::PathBuf,
}

impl ProofWorkspace {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let ws = root.path().join("ws");
        let checks = root.path().join("checks");
        copy_dir_all(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/build-proof"),
            &ws,
        );
        std::fs::create_dir_all(&checks).unwrap();
        // `git remote -v` must be refused by the rule, not fail for want of a repository.
        let st = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(ws.join("app"))
            .status()
            .unwrap();
        assert!(st.success());
        Self {
            _root: root,
            ws,
            checks,
        }
    }

    fn build_file(&self, repo: &str) -> std::path::PathBuf {
        self.ws
            .join("master/intent/proof/change/build")
            .join(format!("{repo}.md"))
    }

    /// The rules T41's `buildPermissions` generates for a repository run of `app`
    /// (api and master are the other repositories). Copied from
    /// `app/src/app/lib/sdlc.ts`: `BUILD_DENY`, the checks and other-repository
    /// `Edit` denies, the other repositories' build logs (not `build/**`: deny
    /// beats allow, which would block the run's own log), the allows. Only `Edit`
    /// path rules exist; claude ignores `Write(path)`.
    fn rules(&self) -> (Vec<String>, Vec<String>) {
        let mut deny: Vec<String> = ["Bash(git push:*)", "Bash(gh:*)", "Bash(git remote:*)"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        deny.push(format!("Edit({}/**)", rule_path(&self.checks)));
        let mut allow = vec![format!("Read({}/**)", rule_path(&self.ws))];
        for other in ["api", "master"] {
            deny.push(format!("Edit({})", rule_path(&self.build_file(other))));
        }
        deny.push(format!("Edit({}/**)", rule_path(&self.ws.join("api"))));
        allow.push(format!("Edit({})", rule_path(&self.build_file("app"))));
        (deny, allow)
    }

    /// `auto` runs the deny proofs; `prompt` with `unmatched = "deny"` runs the
    /// allow proofs, so nothing but an allow rule can let a call through.
    fn spec(&self, name: &str, task: &str, auto: bool) -> RunSpec {
        let (deny, allow) = self.rules();
        let mut spec = base_spec(&self.ws.join("app").to_string_lossy());
        spec.name = name.into();
        spec.task = task.into();
        spec.auth.bare = false;
        if auto {
            spec.permissions.mode = kata_core::spec::PermissionMode::Auto;
        } else {
            spec.permissions.mode = kata_core::spec::PermissionMode::Prompt;
            spec.permissions.unmatched = kata_core::spec::UnmatchedPolicy::Deny;
        }
        spec.permissions.deny = deny;
        spec.permissions.allow = allow;
        spec.leash.max_turns = Some(30);
        spec.leash.timeout_secs = Some(420);
        spec
    }
}

/// Runs the spec through the real `kata` binary. Under `mode = "auto"` the engine
/// registers `<current exe> mcp-ask` as the approval bridge, so the process that
/// calls `run` must itself be `kata`; this test binary is not, which is why the
/// proofs spawn the CLI instead of calling `run_with` in process.
fn run_real(spec: &RunSpec) -> Vec<KataEvent> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let st = std::process::Command::new(cargo)
        .args(["build", "-q", "-p", "kata-cli", "--bin", "kata"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .unwrap();
    assert!(st.success(), "building the kata binary failed");
    let exe = std::env::current_exe().unwrap();
    let kata = exe
        .parent()
        .and_then(|p| p.parent())
        .unwrap()
        .join(format!("kata{}", std::env::consts::EXE_SUFFIX));
    assert!(kata.exists(), "no kata binary at {}", kata.display());

    let dir = tempfile::tempdir().unwrap();
    let spec_path = dir.path().join("proof.kata.toml");
    kata_core::spec::save(&spec_path, spec).unwrap();
    let out = std::process::Command::new(kata)
        .args(["run", "--full-payloads"])
        .arg(&spec_path)
        .env_remove("KATA_CLAUDE_BIN")
        .env_remove("KATA_FAKE_MODE")
        .env("KATA_HOME", dir.path().join("home"))
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    let events: Vec<KataEvent> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("bad event line {l}: {e}")))
        .collect();
    eprintln!(
        "exit {:?}\nstderr: {}\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr),
        proof_evidence(&events)
    );
    events
}

fn proof_evidence(events: &[KataEvent]) -> String {
    let mut out = String::new();
    for e in events {
        match e {
            KataEvent::ToolUse {
                name,
                id,
                parent_id,
                input,
                ..
            } => out.push_str(&format!(
                "tool.use {name} id={id:?} parent={parent_id:?} input={}\n",
                input.clone().unwrap_or_default()
            )),
            KataEvent::ToolResult {
                name,
                ok,
                id,
                parent_id,
                output,
                ..
            } => out.push_str(&format!(
                "tool.result {name} ok={ok} id={id:?} parent={parent_id:?} output={:?}\n",
                output.clone().unwrap_or_default()
            )),
            KataEvent::AssistantText { text, parent_id } => {
                out.push_str(&format!("assistant.text parent={parent_id:?} {text:?}\n"))
            }
            KataEvent::RunCompleted { result, .. } => {
                out.push_str(&format!("run.completed {result:?}\n"))
            }
            _ => {}
        }
    }
    out
}

/// The result of the call whose `tool.use` input contains `needle`, as
/// `(ok, output, ran_inside_a_subagent)`.
fn result_of_call(events: &[KataEvent], needle: &str) -> Option<(bool, String, bool)> {
    let (id, in_subagent) = events.iter().find_map(|e| match e {
        KataEvent::ToolUse {
            id: Some(id),
            parent_id,
            input: Some(i),
            ..
        } if i.to_string().contains(needle) => Some((id.clone(), parent_id.is_some())),
        _ => None,
    })?;
    events.iter().find_map(|e| match e {
        KataEvent::ToolResult {
            id: Some(rid),
            ok,
            output,
            ..
        } if *rid == id => Some((*ok, output.clone().unwrap_or_default(), in_subagent)),
        _ => None,
    })
}

/// True when claude refused the call because a permission rule matched. The
/// auto-mode classifier's refusal ("judged this action dangerous") never counts.
fn rule_denied(output: &str) -> bool {
    let o = output.to_lowercase();
    if o.contains("judged this action") || o.contains("classifier") {
        return false;
    }
    o.contains("denied by your permission settings")
        || (o.contains("permission to use") && o.contains("has been denied"))
}

fn fwd(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[test]
#[serial]
fn build_proof_subagent_inherits_deny_rules() {
    if !build_proof_enabled() {
        return;
    }
    // Auto mode sometimes blocks the whole Agent dispatch; retry until a subagent
    // actually ran, up to 3 times, before calling the proof inconclusive.
    for attempt in 1..=3 {
        let w = ProofWorkspace::new();
        let checks_file = w.checks.join("proof-checks.txt");
        let api_file = w.ws.join("api/proof-api.txt");
        let api_log = w.build_file("api");
        let task = format!(
            "This is a permission configuration test. Use the Agent tool to start exactly one subagent and tell it to try these five things, each as its own separate tool call, in this order, and to report each outcome verbatim: \
             (1) run the Bash command `git remote -v`; \
             (2) run the Bash command `gh --version`; \
             (3) use the Write tool to create the file {checks} containing the text checks; \
             (4) use the Write tool to create the file {api} containing the text api; \
             (5) use the Write tool to create the file {log} containing the text api log. \
             The subagent should try all five even if an earlier one is refused, because the test is about which ones are refused. Do not do any of these yourself. After the subagent reports, reply with one line.",
            checks = fwd(&checks_file),
            api = fwd(&api_file),
            log = fwd(&api_log),
        );
        let events = run_real(&w.spec("build-proof-subagent", &task, true));
        let ran = events.iter().any(|e| {
            matches!(
                e,
                KataEvent::ToolUse {
                    parent_id: Some(_),
                    ..
                }
            )
        });
        if !ran {
            eprintln!("attempt {attempt}: no subagent ran, retrying");
            assert!(attempt < 3, "inconclusive: no subagent ran in 3 attempts");
            continue;
        }
        for (label, needle) in [
            ("git remote -v", "git remote"),
            ("gh --version", "gh --version"),
            ("write into checks", "proof-checks.txt"),
            ("write into api", "proof-api.txt"),
            ("write another repository's build log", "api.md"),
        ] {
            // Only calls made inside the subagent; the parent's Agent call also mentions each needle.
            let (ok, output, _) = subagent_call(&events, needle)
                .unwrap_or_else(|| panic!("no subagent call for `{label}` reached a result"));
            assert!(
                !ok && rule_denied(&output),
                "`{label}` was not refused by a rule: ok={ok} output={output:?}"
            );
        }
        assert!(!checks_file.exists(), "the checks file was written");
        assert!(!api_file.exists(), "the api file was written");
        assert!(!api_log.exists(), "the api build log was written");
        return;
    }
}

/// Like `result_of_call`, but only a call made inside a subagent.
fn subagent_call(events: &[KataEvent], needle: &str) -> Option<(bool, String, bool)> {
    let id = events.iter().find_map(|e| match e {
        KataEvent::ToolUse {
            id: Some(id),
            parent_id: Some(_),
            input: Some(i),
            ..
        } if i.to_string().contains(needle) => Some(id.clone()),
        _ => None,
    })?;
    events.iter().find_map(|e| match e {
        KataEvent::ToolResult {
            id: Some(rid),
            ok,
            output,
            ..
        } if *rid == id => Some((*ok, output.clone().unwrap_or_default(), true)),
        _ => None,
    })
}

#[test]
#[serial]
fn build_proof_absolute_allow_rules_reach_outside_the_workdir() {
    if !build_proof_enabled() {
        return;
    }
    let w = ProofWorkspace::new();
    let notes = w.ws.join("api/notes.txt");
    let app_md = w.build_file("app");
    let task = format!(
        "This is a permission configuration test. Do these two things yourself, each as its own tool call, in this order, using exactly these absolute paths. \
         (1) Use the Read tool on {notes}. \
         (2) Use the Write tool to create {app_md} containing the text app done. \
         Then reply with one line saying which succeeded.",
        notes = fwd(&notes),
        app_md = fwd(&app_md),
    );
    // Prompt mode with unmatched = deny: only an allow rule can let these through.
    let events = run_real(&w.spec("build-proof-absolute", &task, false));

    let (ok, output, _) = result_of_call(&events, "notes.txt").expect("the Read reached a result");
    assert!(
        ok && output.contains("api-secret-token-4417"),
        "read of api/notes.txt failed: ok={ok} output={output:?}"
    );
    let (ok, output, _) =
        result_of_call(&events, "app.md").expect("the app.md Write reached a result");
    assert!(ok, "write of build/app.md was refused: {output:?}");
    assert!(app_md.exists(), "build/app.md was not created");
}

#[test]
#[serial]
fn build_proof_nested_skills_load_when_working_there() {
    if !build_proof_enabled() {
        return;
    }
    let w = ProofWorkspace::new();
    let task = "Edit the file web/src/index.txt so that its single line `old` becomes `new`. \
                Then reply with one sentence naming every skill, by exact name, that is available to you from the project, including any that came into scope because you worked under web/. \
                If none, say none.";
    let events = run_real(&w.spec("build-proof-nested-skill", task, true));

    let edited = std::fs::read_to_string(w.ws.join("app/web/src/index.txt")).unwrap();
    assert_eq!(edited.trim(), "new", "the edit under web/ did not happen");
    let said: String = events
        .iter()
        .filter_map(|e| match e {
            KataEvent::AssistantText { text, .. } => Some(text.clone()),
            KataEvent::RunCompleted {
                result: Some(r), ..
            } => Some(r.clone()),
            KataEvent::ToolUse {
                name,
                input: Some(i),
                ..
            } if name == "Skill" => Some(i.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        said.contains("proof-skill"),
        "proof-skill was not reported loaded: {said}"
    );
}

// ---------------------------------------------------------------------------
// Switched-off items and the per-run files (plan T7). Every test runs over a
// temporary home and workdir, so the machine's real setup is never read or
// written, and through `fake-claude` in `argsfiles` mode, which reports what
// Kata passed.
// ---------------------------------------------------------------------------

use kata_core::given::{
    resolve as resolve_given, ItemKind, LockReason, ResolveOptions, ResolveRoots, Resolved, Source,
    SWITCHABLE,
};
use kata_core::spec::Given;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Points HOME and USERPROFILE at a folder for the test and restores them on drop.
struct HomeGuard {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

impl HomeGuard {
    fn set(home: &Path) -> HomeGuard {
        let saved = ["HOME", "USERPROFILE"]
            .into_iter()
            .map(|k| (k, std::env::var_os(k)))
            .collect();
        std::env::set_var("HOME", home);
        std::env::set_var("USERPROFILE", home);
        HomeGuard { saved }
    }
}

impl Drop for HomeGuard {
    fn drop(&mut self) {
        for (k, v) in &self.saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
    }
}

/// What `fake-claude` in `argsfiles` mode reported.
#[derive(Debug, Default)]
struct Seen {
    argv: Vec<String>,
    settings: Option<serde_json::Value>,
    mcp: Option<serde_json::Value>,
    plugin_files: Option<Vec<String>>,
    /// Every `--plugin-dir`'s files, in the order passed (the kit's first).
    plugin_dirs: Vec<Vec<String>>,
    cwd: Option<String>,
    add_dir_md: String,
    exit_code: i32,
}

impl Seen {
    fn has(&self, flag: &str) -> bool {
        self.argv.iter().any(|a| a == flag)
    }
    fn value(&self, flag: &str) -> Option<&str> {
        self.argv
            .windows(2)
            .find(|w| w[0] == flag)
            .map(|w| w[1].as_str())
    }
    fn mcp_servers(&self) -> Vec<String> {
        self.mcp.as_ref().map_or_else(Vec::new, |m| {
            m["mcpServers"]
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default()
        })
    }
}

struct Rig {
    _td: tempfile::TempDir,
    _home_guard: HomeGuard,
    home: PathBuf,
    work: PathBuf,
    kata_home: PathBuf,
}

fn write_file(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

impl Rig {
    /// A home with a personal hook, a personal installed plugin, two skills; a
    /// workdir with a `CLAUDE.md` and a `.mcp.json` of two servers.
    fn new() -> Rig {
        let td = tempfile::tempdir().unwrap();
        let home = td.path().join("home");
        let work = td.path().join("work");
        let kata_home = td.path().join("kata-home");
        std::fs::create_dir_all(&work).unwrap();
        let guard = HomeGuard::set(&home);
        std::env::set_var("KATA_CLAUDE_BIN", env!("CARGO_BIN_EXE_fake-claude"));
        std::env::set_var("KATA_FAKE_MODE", "argsfiles");
        std::env::set_var("KATA_HOME", &kata_home);

        write_file(
            &home.join(".claude/settings.json"),
            &serde_json::json!({
                "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
                    {"type": "command", "command": "node repair-me.js"}]}]},
                "enabledPlugins": {"pers@mkt": true}
            })
            .to_string(),
        );
        for name in ["kit-skill", "kit-keep"] {
            write_file(
                &home.join(format!(".claude/skills/{name}/SKILL.md")),
                &format!("---\nname: {name}\ndescription: does {name}\n---\nbody\n"),
            );
        }
        // A flat plugin the kit picks. Unlike the kit skills, which are also
        // personal skills on disk, it is not shadowed and can be switched off.
        write_file(
            &home.join(".claude/plugins/kit-plug/.claude-plugin/plugin.json"),
            r#"{"name":"kit-plug","description":"the kit plugin"}"#,
        );
        write_file(
            &home.join(".claude/plugins/kit-plug/skills/plug-skill/SKILL.md"),
            "---
name: plug-skill
description: does it
---
body
",
        );
        let cache = td.path().join("cache/pers");
        write_file(
            &cache.join(".claude-plugin/plugin.json"),
            r#"{"name":"pers","description":"the pers plugin"}"#,
        );
        write_file(
            &home.join(".claude/plugins/installed_plugins.json"),
            &serde_json::json!({"version": 2, "plugins": {"pers@mkt": [
                {"scope": "user", "installPath": cache.to_string_lossy(), "version": "1"}
            ]}})
            .to_string(),
        );
        write_file(&work.join("CLAUDE.md"), "project rules");
        write_file(
            &work.join(".mcp.json"),
            &serde_json::json!({"mcpServers": {
                "srv-a": {"command": "node", "args": ["a.js"], "env": {"API_KEY": "tok-a"}},
                "srv-b": {"command": "node", "args": ["b.js"]}
            }})
            .to_string(),
        );
        Rig {
            _td: td,
            _home_guard: guard,
            home,
            work,
            kata_home,
        }
    }

    fn spec(&self) -> RunSpec {
        let mut s = base_spec(&self.work.to_string_lossy());
        // The rig is a setup with items to switch off, which the empty room does
        // not list.
        s.auth.bare = false;
        s.skills = vec!["kit-skill".into(), "kit-keep".into()];
        s.plugins.insert("kit-plug".into(), Default::default());
        s
    }

    fn catalog(&self) -> Vec<CatalogEntry> {
        kata_core::catalog::discover(&kata_core::catalog::DiscoveryRoots {
            user_dir: self.home.join(".claude"),
            project_dir: self.work.join(".claude"),
        })
    }

    fn resolved(&self, spec: &RunSpec) -> Resolved {
        resolve_given(
            spec,
            &ResolveRoots::for_spec(spec),
            &ResolveOptions::default(),
        )
    }

    /// The identity of the one item matching, by kind, source and name.
    fn id(&self, spec: &RunSpec, kind: ItemKind, source: Source, name: &str) -> String {
        self.resolved(spec)
            .items
            .into_iter()
            .find(|i| i.kind == kind && i.source == source && i.name == name)
            .unwrap_or_else(|| panic!("no {kind:?} {source:?} item named {name}"))
            .id
    }

    /// The identity of the personal hook of the fixture.
    fn hook_id(&self, spec: &RunSpec) -> String {
        self.resolved(spec)
            .items
            .into_iter()
            .find(|i| i.kind == ItemKind::Hook && i.source == Source::Personal)
            .expect("the personal hook is an item")
            .id
    }

    /// Every file under the temporary home and workdir, with its bytes.
    fn snapshot(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(&p, out);
                } else {
                    out.insert(p.clone(), std::fs::read(&p).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.home, &mut out);
        walk(&self.work, &mut out);
        out
    }

    fn run(&self, spec: &RunSpec) -> Seen {
        let cancel = CancelToken::new();
        let mut events: Vec<KataEvent> = Vec::new();
        let outcome = run(
            spec,
            &self.catalog(),
            &cancel,
            &kata_core::run::AnswerRx::default(),
            &kata_core::run::DecisionRx::default(),
            |e| events.push(e),
        )
        .unwrap();
        let mut seen = Seen {
            exit_code: outcome.exit_code,
            ..Seen::default()
        };
        for e in &events {
            let KataEvent::Log { message, .. } = e else {
                continue;
            };
            let json = |rest: &str| serde_json::from_str::<serde_json::Value>(rest).unwrap();
            if let Some(r) = message.strip_prefix("ARGV ") {
                seen.argv = serde_json::from_value(json(r)).unwrap();
            } else if let Some(r) = message.strip_prefix("SETTINGS ") {
                seen.settings = Some(json(r));
            } else if let Some(r) = message.strip_prefix("MCP ") {
                seen.mcp = Some(json(r));
            } else if let Some(r) = message.strip_prefix("PLUGINDIR ") {
                let files: Vec<String> = serde_json::from_value(json(r)).unwrap();
                seen.plugin_files.get_or_insert_with(|| files.clone());
                seen.plugin_dirs.push(files);
            } else if let Some(r) = message.strip_prefix("CWD ") {
                seen.cwd = Some(r.to_string());
            } else if let Some(r) = message.strip_prefix("ADDDIRMD ") {
                seen.add_dir_md = r.to_string();
            }
        }
        assert_eq!(seen.exit_code, 0, "events: {events:?}");
        assert!(!seen.argv.is_empty(), "fake-claude reported no argv");
        seen
    }
}

fn given_with(f: impl FnOnce(&mut Given)) -> Option<Given> {
    let mut g = Given::default();
    f(&mut g);
    Some(g)
}

// R4.2: one row per kind. A project hook goes off by dropping its settings
// source (docs/switch-proofs.md) and a personal hook cannot be switched off. The
// rows assert through `resolve` and what Kata passed to claude.
#[test]
#[serial]
fn each_kind_switched_off_is_kept_from_the_run_and_no_setup_file_changes() {
    let rig = Rig::new();
    rig.add_project_setup();
    let before = rig.snapshot();

    // skill: a kit skill that is also a personal skill on disk is shadowed, so it
    // is locked and stays given (T19 lifts this in the empty room).
    let mut spec = rig.spec();
    let id = rig.id(&spec, ItemKind::Skill, Source::RunSpec, "kit-skill");
    spec.given = given_with(|g| g.skills.push(id.clone()));
    let shadowed = rig.resolved(&spec);
    let shadowed = shadowed.items.iter().find(|i| i.id == id).unwrap();
    assert!(shadowed.lock.is_some() && !shadowed.off, "{shadowed:?}");
    // kit plugin: not on disk elsewhere, so it is left out of the assembled folder.
    let mut spec = rig.spec();
    let id = rig.id(&spec, ItemKind::Plugin, Source::RunSpec, "kit-plug");
    spec.given = given_with(|g| g.plugins.push(id));
    let seen = rig.run(&spec);
    let files = seen
        .plugin_files
        .clone()
        .expect("a kept skill leaves a plugin dir");
    assert!(
        files.iter().any(|f| f.starts_with("skills/kit-keep/")),
        "{files:?}"
    );
    assert!(
        !files.iter().any(|f| f.contains("plug-skill")),
        "the switched-off kit plugin reached the plugin dir: {files:?}"
    );
    assert!(!seen.has("--setting-sources"));
    assert_eq!(rig.snapshot(), before, "skill row changed a setup file");

    // plugin: an installed personal plugin is disabled in the per-run settings.
    let mut spec = rig.spec();
    let id = rig.id(&spec, ItemKind::Plugin, Source::Personal, "pers");
    spec.given = given_with(|g| g.plugins.push(id));
    let seen = rig.run(&spec);
    assert_eq!(
        seen.settings,
        Some(serde_json::json!({"enabledPlugins": {"pers@mkt": false}}))
    );
    assert!(seen.has("--settings"));
    assert_eq!(rig.snapshot(), before, "plugin row changed a setup file");

    // standing instruction: the project CLAUDE.md goes into claudeMdExcludes.
    let mut spec = rig.spec();
    let id = rig.id(&spec, ItemKind::Instruction, Source::Project, "CLAUDE.md");
    let path = rig
        .resolved(&spec)
        .items
        .into_iter()
        .find(|i| i.id == id)
        .and_then(|i| i.path)
        .expect("the instruction names its file");
    spec.given = given_with(|g| g.instructions.push(id));
    let seen = rig.run(&spec);
    let want = path.replace('\\', "/");
    assert!(want.starts_with(&rig.work.to_string_lossy().replace('\\', "/")));
    assert_eq!(
        seen.settings,
        Some(serde_json::json!({"claudeMdExcludes": [want]}))
    );
    assert_eq!(
        rig.snapshot(),
        before,
        "instruction row changed a setup file"
    );

    // tool server: denied by name in the settings file; claude's own scopes are
    // not replaced (no strict file), and the definition never reaches the run.
    let mut spec = rig.spec();
    let id = rig.id(&spec, ItemKind::ToolServer, Source::Project, "srv-a");
    spec.given = given_with(|g| g.tool_servers.push(id));
    let seen = rig.run(&spec);
    assert!(!seen.has("--strict-mcp-config"), "{:?}", seen.argv);
    assert_eq!(seen.mcp_servers(), vec!["kata-ask".to_string()]);
    let settings = seen.settings.clone().expect("a settings file is written");
    assert_eq!(
        settings["deniedMcpServers"],
        serde_json::json!([{"serverName": "srv-a"}])
    );
    assert!(
        !settings.to_string().contains("tok-a"),
        "the switched-off server's definition reached the file"
    );
    assert_eq!(
        rig.snapshot(),
        before,
        "tool server row changed a setup file"
    );

    // hook: a project hook goes off by dropping its settings source and handing
    // the rest of that source back, so claude is told to read the other sources.
    let mut spec = rig.spec();
    spec.given = given_with(|g| g.hooks.push(rig.project_hook_id(HOOK_A)));
    let seen = rig.run(&spec);
    assert_eq!(seen.value("--setting-sources"), Some("user,local"));
    assert!(!seen.has("--strict-mcp-config"));
    let hooks = seen.settings.as_ref().expect("the rest is handed back")["hooks"].to_string();
    assert!(hooks.contains(HOOK_B) && !hooks.contains(HOOK_A), "{hooks}");
    assert!(
        seen.has("--add-dir"),
        "the project's other files are carried"
    );
    assert_eq!(rig.snapshot(), before, "hook row changed a setup file");

    // A personal hook is not switchable (its source cannot be dropped on its own).
    assert!(!SWITCHABLE.contains(&(ItemKind::Hook, Source::Personal)));
    let mut spec = rig.spec();
    let hook_id = rig.hook_id(&spec);
    spec.given = given_with(|g| g.hooks.push(hook_id.clone()));
    let resolved = rig.resolved(&spec);
    let hook = resolved.items.iter().find(|i| i.id == hook_id).unwrap();
    assert!(!hook.off, "a locked hook must stay given");
    let seen = rig.run(&spec);
    assert!(!seen.has("--setting-sources") && !seen.has("--settings"));
    assert_eq!(
        rig.snapshot(),
        before,
        "personal hook row changed a setup file"
    );
}

// R4.1, as it stands: hooks ship locked because no mechanism was proven, so a
// hook listed in `[given].hooks` stays given and the settings source is not
// re-routed. The real-claude marker variant is skipped: there is no mechanism
// to prove (docs/switch-proofs.md).
#[test]
#[serial]
fn a_switched_off_personal_hook_never_fires_and_the_setup_is_untouched() {
    let rig = Rig::new();
    let settings_path = rig.home.join(".claude/settings.json");
    let before_bytes = std::fs::read(&settings_path).unwrap();
    let mut spec = rig.spec();
    let hook_id = rig.hook_id(&spec);
    spec.given = given_with(|g| g.hooks.push(hook_id.clone()));
    let resolved = rig.resolved(&spec);
    let hook = resolved.items.iter().find(|i| i.id == hook_id).unwrap();
    assert!(!hook.off);
    assert!(
        matches!(&hook.lock, Some(LockReason::Unswitchable { text })
            if text.starts_with("Kata cannot switch this off")),
        "{:?}",
        hook.lock
    );
    let seen = rig.run(&spec);
    assert!(
        !seen.has("--setting-sources"),
        "no re-routing is passed: {:?}",
        seen.argv
    );
    assert_eq!(std::fs::read(&settings_path).unwrap(), before_bytes);
}

// R7.3: the posture is the same with and without items switched off.
#[test]
#[serial]
fn switching_items_off_leaves_the_posture_flags_unchanged() {
    let rig = Rig::new();
    let mut plain = rig.spec();
    plain.permissions.mode = kata_core::spec::PermissionMode::Auto;
    plain.permissions.deny.push("Bash(rm *)".into());
    plain.permissions.allow.push("Read(*)".into());
    let mut off = plain.clone();
    let hook = rig.hook_id(&off);
    let skill = rig.id(&off, ItemKind::Plugin, Source::RunSpec, "kit-plug");
    let server = rig.id(&off, ItemKind::ToolServer, Source::Project, "srv-a");
    off.given = given_with(|g| {
        g.hooks.push(hook);
        g.plugins.push(skill);
        g.tool_servers.push(server);
    });

    let a = rig.run(&plain);
    let b = rig.run(&off);
    // The switches did something...
    assert!(b
        .settings
        .as_ref()
        .unwrap()
        .get("deniedMcpServers")
        .is_some());
    assert!(a
        .settings
        .as_ref()
        .unwrap()
        .get("deniedMcpServers")
        .is_none());
    assert!(a
        .plugin_files
        .as_ref()
        .unwrap()
        .iter()
        .any(|f| f.contains("plug-skill")));
    assert!(!b
        .plugin_files
        .as_ref()
        .unwrap()
        .iter()
        .any(|f| f.contains("plug-skill")));
    // ...and the posture did not move.
    assert_eq!(a.value("--permission-mode"), Some("auto"));
    assert_eq!(b.value("--permission-mode"), Some("auto"));
    assert_eq!(
        a.value("--permission-prompt-tool"),
        b.value("--permission-prompt-tool")
    );
    assert!(a.value("--permission-prompt-tool").is_some());
    assert!(!b.has("--dangerously-skip-permissions"));
    let perms = |s: &Seen| s.settings.as_ref().unwrap()["permissions"].clone();
    assert_eq!(perms(&a), perms(&b));
    assert_eq!(perms(&b)["deny"], serde_json::json!(["Bash(rm *)"]));
}

#[test]
#[serial]
fn bypass_with_nothing_off_writes_no_settings_file() {
    let rig = Rig::new();
    let seen = rig.run(&rig.spec());
    assert!(!seen.has("--settings"), "{:?}", seen.argv);
    assert!(seen.settings.is_none());
    assert!(!seen.has("--strict-mcp-config"));
    assert!(seen.has("--dangerously-skip-permissions"));
    assert_eq!(seen.mcp_servers(), vec!["kata-ask".to_string()]);
    // Claude's hook events are always on; the build reads them.
    assert!(seen.has("--include-hook-events"));
    // The per-run files live under <kata home>/tmp/run-<pid>-<nanos>/.
    let cfg = PathBuf::from(seen.value("--mcp-config").unwrap());
    let run_dir = cfg.parent().unwrap();
    assert_eq!(run_dir.parent().unwrap(), rig.kata_home.join("tmp"));
    let name = run_dir.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with(&format!("run-{}-", std::process::id())),
        "{name}"
    );
    // And they are gone once the run ends.
    assert!(!run_dir.exists(), "the run's temp folder was left behind");
}

#[test]
#[serial]
fn a_crashed_runs_temp_folder_is_swept_by_the_next_run() {
    let rig = Rig::new();
    // A process that has certainly ended: its pid is not alive.
    let mut dead = std::process::Command::new(env!("CARGO_BIN_EXE_fake-claude"))
        .env("KATA_FAKE_MODE", "ok")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let dead_pid = dead.id();
    dead.wait().unwrap();

    let tmp = rig.kata_home.join("tmp");
    let crashed = tmp.join(format!("run-{dead_pid}-1700000000000000000"));
    write_file(&crashed.join("mcp-config.json"), r#"{"token":"x"}"#);
    // Not swept: a live process's folder (this one), a folder that is not a
    // run's, and a name that does not parse.
    let live = tmp.join(format!("run-{}-1700000000000000001", std::process::id()));
    write_file(&live.join("keep.txt"), "live");
    let other = tmp.join("something-else");
    write_file(&other.join("keep.txt"), "other");
    let odd = tmp.join("run-notapid-1");
    write_file(&odd.join("keep.txt"), "odd");

    rig.run(&rig.spec());

    assert!(!crashed.exists(), "the crashed run's folder survived");
    assert!(live.join("keep.txt").exists());
    assert!(other.join("keep.txt").exists());
    assert!(odd.join("keep.txt").exists());
    let left: Vec<String> = std::fs::read_dir(&tmp)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        left.len(),
        3,
        "this run left its own folder behind: {left:?}"
    );
}

// T8: run.given.

impl Rig {
    /// Run in the given fake mode, calling `on_event` for each event as it
    /// arrives, and return them all.
    fn run_events(
        &self,
        spec: &RunSpec,
        mode: &str,
        mut on_event: impl FnMut(&KataEvent),
    ) -> Vec<KataEvent> {
        std::env::set_var("KATA_FAKE_MODE", mode);
        let mut events: Vec<KataEvent> = Vec::new();
        run(
            spec,
            &self.catalog(),
            &CancelToken::new(),
            &kata_core::run::AnswerRx::default(),
            &kata_core::run::DecisionRx::default(),
            |e| {
                on_event(&e);
                events.push(e);
            },
        )
        .unwrap();
        events
    }
}

type GivenParts = (
    Vec<kata_core::given::GivenItem>,
    kata_core::given::RunSettings,
    Vec<kata_core::given::EnvName>,
    Vec<String>,
);

fn given_events(events: &[KataEvent]) -> Vec<GivenParts> {
    events
        .iter()
        .filter_map(|e| match e {
            KataEvent::RunGiven {
                items,
                settings,
                env,
                warnings,
                ..
            } => Some((
                items.clone(),
                settings.clone(),
                env.clone(),
                warnings.clone(),
            )),
            _ => None,
        })
        .collect()
}

// R15.3: the fake's start report says a model other than the spec's, and a
// posture spelled the way Claude spells it.
#[test]
#[serial]
fn model_and_posture_come_from_claudes_start_report() {
    use kata_core::given::{RunSetting, SettingSource};
    let rig = Rig::new();
    let mut spec = rig.spec();
    spec.model.id = Some("the-specs-model".into());
    let events = rig.run_events(&spec, "ok", |_| {});
    let given = given_events(&events);
    assert_eq!(
        given.len(),
        1,
        "no hook fired, so one run.given: {events:?}"
    );
    let settings = &given[0].1;
    assert_eq!(
        settings.model,
        RunSetting {
            value: Some("claude-fake-1".into()),
            source: SettingSource::ClaudeReport
        }
    );
    assert_eq!(
        settings.permission_posture,
        RunSetting {
            value: Some("bypassPermissions".into()),
            source: SettingSource::ClaudeReport
        }
    );
    // What Claude does not report keeps its own source.
    assert_eq!(settings.turn_cap.source, SettingSource::RunSpec);
    assert_eq!(settings.time_limit.source, SettingSource::KataDefault);
}

// T17: the engine resolves with the options the spec carries, so its record
// locks a required plugin exactly as the preview does.
#[test]
#[serial]
fn the_engines_record_locks_the_required_plugin_like_the_preview() {
    let rig = Rig::new();
    let cache = rig.home.parent().unwrap().join("cache/ai-sdlc");
    write_file(
        &cache.join(".claude-plugin/plugin.json"),
        r#"{"name":"ai-sdlc","description":"the ai-sdlc plugin"}"#,
    );
    write_file(
        &rig.home.join(".claude/plugins/installed_plugins.json"),
        &serde_json::json!({"version": 2, "plugins": {"ai-sdlc@mkt": [
            {"scope": "user", "installPath": cache.to_string_lossy(), "version": "1"}
        ]}})
        .to_string(),
    );
    write_file(
        &rig.home.join(".claude/settings.json"),
        &serde_json::json!({"enabledPlugins": {"ai-sdlc@mkt": true}}).to_string(),
    );
    let mut spec = rig.spec();
    spec.given = given_with(|g| g.required_plugins.push("ai-sdlc".into()));
    let events = rig.run_events(&spec, "ok", |_| {});
    let given = given_events(&events);
    let item = given
        .last()
        .expect("a run.given")
        .0
        .iter()
        .find(|i| i.kind == ItemKind::Plugin && i.name == "ai-sdlc")
        .expect("the ai-sdlc plugin is listed");
    assert!(
        matches!(item.lock, Some(LockReason::Required { .. })),
        "{:?}",
        item.lock
    );
}

// R16.1: a hook added on disk after run.started is in no run.given of this
// run, and is in the next resolve.
#[test]
#[serial]
fn a_hook_added_on_disk_during_a_run_is_not_in_its_run_given() {
    use kata_core::given::{GivenStatus, ItemKind, ResolveOptions, ResolveRoots, Source};
    let rig = Rig::new();
    let spec = rig.spec();
    let settings_path = rig.home.join(".claude/settings.json");
    let mut written = false;
    let events = rig.run_events(&spec, "hooks", |e| {
        if matches!(e, KataEvent::RunStarted { .. }) && !written {
            written = true;
            let mut v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
            v["hooks"]["Stop"] = serde_json::json!([
                {"hooks": [{"type": "command", "command": "node added-during-run.js"}]}
            ]);
            std::fs::write(&settings_path, v.to_string()).unwrap();
        }
    });
    assert!(written);
    let given = given_events(&events);
    assert!(
        given.len() >= 2,
        "the start report and the first hook each emit one: {events:?}"
    );
    for (items, ..) in &given {
        assert!(
            !items
                .iter()
                .any(|i| i.kind == ItemKind::Hook && i.name == "Stop any"),
            "the hook added during the run is listed: {items:?}"
        );
    }
    let hook_status = |items: &[kata_core::given::GivenItem]| {
        items
            .iter()
            .find(|i| i.kind == ItemKind::Hook && i.name == "PreToolUse Bash")
            .map(|i| i.status)
    };
    assert_eq!(hook_status(&given[0].0), Some(GivenStatus::GivenNotFired));
    assert_eq!(
        hook_status(&given.last().unwrap().0),
        Some(GivenStatus::GivenFired)
    );

    let next = kata_core::given::resolve(
        &spec,
        &ResolveRoots::for_spec(&spec),
        &ResolveOptions::default(),
    );
    assert!(next
        .items
        .iter()
        .any(|i| i.kind == ItemKind::Hook && i.source == Source::Personal && i.name == "Stop any"));
}

// R8.1: names reach the event, values never do.
#[test]
#[serial]
fn run_given_carries_no_secret_value() {
    let rig = Rig::new();
    let settings_path = rig.home.join(".claude/settings.json");
    let mut v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
    v["env"] = serde_json::json!({"PERSONAL_SECRET": "pers-s3cret-111"});
    v["hooks"]["PreToolUse"][0]["hooks"][0]["command"] =
        "node repair-me.js --token hook-s3cret-222".into();
    std::fs::write(&settings_path, v.to_string()).unwrap();
    let mut spec = rig.spec();
    spec.env
        .insert("SPEC_SECRET".into(), "spec-s3cret-333".into());
    let events = rig.run_events(&spec, "hooks", |_| {});
    let given = given_events(&events);
    assert!(!given.is_empty());
    let json = serde_json::to_string(
        &given_events(&events)
            .iter()
            .map(|g| (&g.0, &g.1, &g.2, &g.3))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    for name in ["PERSONAL_SECRET", "SPEC_SECRET"] {
        assert!(json.contains(name), "{name} is named: {json}");
    }
    for value in [
        "pers-s3cret-111",
        "hook-s3cret-222",
        "spec-s3cret-333",
        "tok-a",
    ] {
        assert!(!json.contains(value), "{value} leaked: {json}");
    }
}

// Rows 26 and 27: the run ended before Claude's start report.
#[test]
#[serial]
fn a_run_that_ends_before_the_start_report_emits_rows_26_and_27() {
    use kata_core::given::{GivenStatus, ItemKind, Source};
    let rig = Rig::new();
    let mut spec = rig.spec();
    // `.mcp.json` holds srv-a and srv-b; switch srv-b off.
    let off = rig.id(&spec, ItemKind::ToolServer, Source::Project, "srv-b");
    spec.given = given_with(|g| g.tool_servers.push(off));
    let events = rig.run_events(&spec, "noinit", |_| {});
    let given = given_events(&events);
    assert_eq!(given.len(), 1, "{events:?}");
    let status_of = |kind: ItemKind, name: &str| {
        given[0]
            .0
            .iter()
            .find(|i| i.kind == kind && i.name == name)
            .unwrap_or_else(|| panic!("no {kind:?} {name}"))
            .status
    };
    assert_eq!(
        status_of(ItemKind::ToolServer, "srv-a"),
        GivenStatus::PassedNoStartReport
    );
    assert_eq!(
        status_of(ItemKind::ToolServer, "srv-b"),
        GivenStatus::SwitchedOffNoStartReport
    );
    assert_eq!(
        status_of(ItemKind::Plugin, "pers"),
        GivenStatus::PassedNoStartReport
    );
    assert_eq!(
        status_of(ItemKind::Hook, "PreToolUse Bash"),
        GivenStatus::GivenNotFired
    );
    assert!(given[0].3.is_empty(), "no warning without a report");
    // It comes before the terminal event.
    let at = |f: &dyn Fn(&KataEvent) -> bool| events.iter().position(f).unwrap();
    assert!(
        at(&|e| matches!(e, KataEvent::RunGiven { .. }))
            < at(&|e| matches!(e, KataEvent::RunCompleted { .. }))
    );
}

// ---------------------------------------------------------------------------
// T21: the switch-offs and the carry-over reach Claude.
// ---------------------------------------------------------------------------

const HOOK_A: &str = "echo x > hookA.marker";
const HOOK_B: &str = "echo x > hookB.marker";

fn project_settings_body() -> String {
    let hook = |c: &str| serde_json::json!({"type": "command", "command": c});
    serde_json::json!({"hooks": {"UserPromptSubmit": [
        {"hooks": [hook(HOOK_A)]}, {"hooks": [hook(HOOK_B)]}
    ]}})
    .to_string()
}

fn project_hook_id(command: &str) -> String {
    kata_core::given::item_id(
        ItemKind::Hook,
        Source::Project,
        &kata_core::given::hook_key("UserPromptSubmit", None, command),
    )
}

impl Rig {
    /// Two project hooks on one event and a project skill.
    fn add_project_setup(&self) {
        write_file(
            &self.work.join(".claude/settings.json"),
            &project_settings_body(),
        );
        write_file(
            &self.work.join(".claude/skills/projskill/SKILL.md"),
            "---
name: projskill
description: the project skill
---
body
",
        );
    }

    fn project_hook_id(&self, command: &str) -> String {
        project_hook_id(command)
    }
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

// R4.5: the switched-off hook is dropped with its source and everything else of
// the project is handed back.
#[test]
#[serial]
fn a_switched_off_project_hook_never_fires_the_rest_is_carried_over_and_the_setup_is_untouched() {
    let rig = Rig::new();
    rig.add_project_setup();
    let before = rig.snapshot();
    let mut spec = rig.spec();
    spec.given = given_with(|g| g.hooks.push(rig.project_hook_id(HOOK_A)));
    let seen = rig.run(&spec);

    assert_eq!(seen.value("--setting-sources"), Some("user,local"));
    let hooks = seen.settings.as_ref().expect("the rest is handed back")["hooks"].to_string();
    assert!(hooks.contains(HOOK_B) && !hooks.contains(HOOK_A), "{hooks}");

    // The `.mcp.json` servers ride in the tool-server file, never strict.
    assert!(!seen.has("--strict-mcp-config"));
    assert_eq!(
        seen.mcp_servers(),
        vec![
            "kata-ask".to_string(),
            "srv-a".to_string(),
            "srv-b".to_string()
        ]
    );

    // The project skill is in a generated plugin next to the kit's.
    assert_eq!(seen.plugin_dirs.len(), 2, "{:?}", seen.plugin_dirs);
    let carried = &seen.plugin_dirs[1];
    assert!(
        carried.contains(&"skills/projskill/SKILL.md".to_string()),
        "{carried:?}"
    );
    assert!(
        carried.contains(&".claude-plugin/plugin.json".to_string()),
        "{carried:?}"
    );
    let dirs: Vec<&String> = seen
        .argv
        .windows(2)
        .filter(|w| w[0] == "--plugin-dir")
        .map(|w| &w[1])
        .collect();
    assert!(
        !std::path::Path::new(dirs[1]).exists(),
        "the carried plugin outlived the run"
    );

    // The project's standing instructions come back through `--add-dir`.
    assert_eq!(
        seen.value("--add-dir").map(norm),
        Some(norm(&rig.work.to_string_lossy()))
    );
    assert_eq!(seen.add_dir_md, "1");
    assert_eq!(rig.snapshot(), before, "a setup file changed");
}

// The same run through a real claude: the dropped hook never fires, the other does.
#[test]
#[serial]
fn a_switched_off_project_hook_never_fires_in_a_real_run() {
    if !build_proof_enabled() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("proj");
    write_file(
        &work.join(".claude/settings.json"),
        &project_settings_body(),
    );
    let before = std::fs::read(work.join(".claude/settings.json")).unwrap();
    let mut spec = base_spec(&work.to_string_lossy());
    spec.name = "t21-hook-off".into();
    spec.task = "Reply with the single word ok.".into();
    spec.auth.bare = false;
    spec.model.id = Some("haiku".into());
    spec.leash.max_turns = Some(4);
    spec.leash.timeout_secs = Some(240);
    spec.given = given_with(|g| g.hooks.push(project_hook_id(HOOK_A)));
    let events = run_real(&spec);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, KataEvent::RunCompleted { .. })),
        "the run did not complete"
    );
    assert!(
        !work.join("hookA.marker").exists(),
        "the switched-off hook fired"
    );
    assert!(
        work.join("hookB.marker").exists(),
        "the other hook did not fire"
    );
    assert_eq!(
        std::fs::read(work.join(".claude/settings.json")).unwrap(),
        before
    );
}

// Review 1 F2: the exclusion names the copy the run reads.
#[test]
#[serial]
fn an_isolated_run_excludes_paths_in_its_worktree() {
    let rig = Rig::new();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(&rig.work)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    };
    git(&["init", "-q"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "t"]);
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "init"]);

    let mut spec = rig.spec();
    spec.leash.isolation = kata_core::spec::Isolation::Worktree;
    let id = rig.id(&spec, ItemKind::Instruction, Source::Project, "CLAUDE.md");
    spec.given = given_with(|g| g.instructions.push(id));
    let seen = rig.run(&spec);

    let cwd = norm(seen.cwd.as_deref().expect("fake-claude reports its folder"));
    assert_ne!(cwd, norm(&rig.work.to_string_lossy()), "not isolated");
    let excludes = seen.settings.as_ref().expect("a settings file")["claudeMdExcludes"].clone();
    let want = format!("{cwd}/claude.md");
    let got: Vec<String> = excludes
        .as_array()
        .unwrap()
        .iter()
        .map(|v| norm(v.as_str().unwrap()))
        .collect();
    assert_eq!(got, vec![want], "the live workdir's copy was named instead");
}

// A run with nothing switched off keeps its command line.
#[test]
#[serial]
fn nothing_switched_off_passes_none_of_the_new_flags() {
    let rig = Rig::new();
    rig.add_project_setup();
    let seen = rig.run(&rig.spec());
    for flag in [
        "--setting-sources",
        "--settings",
        "--add-dir",
        "--strict-mcp-config",
    ] {
        assert!(!seen.has(flag), "{flag} in {:?}", seen.argv);
    }
    assert_eq!(seen.plugin_dirs.len(), 1, "only the kit's plugin folder");
    assert_eq!(seen.mcp_servers(), vec!["kata-ask".to_string()]);
    assert_eq!(seen.add_dir_md, "");
}

// T22: the record of a run covers every ending, and carries the run's options.
#[test]
#[serial]
fn a_run_refused_before_spawning_still_records_what_it_was_given() {
    with_fake("ok");
    // The authentication refusal.
    std::env::remove_var("KATA_MISSING_TOKEN");
    let work = tempfile::tempdir().unwrap();
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.auth.bare = true;
    spec.auth.token_env = Some("KATA_MISSING_TOKEN".into());
    let mut events: Vec<KataEvent> = Vec::new();
    let err = run(
        &spec,
        &[] as &[CatalogEntry],
        &CancelToken::new(),
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap_err();
    assert!(matches!(err, RunError::Auth(_)));
    assert_eq!(given_events(&events).len(), 1, "auth refusal: {events:?}");

    // A worktree failure (the workdir is not a repository).
    let khome = tempfile::tempdir().unwrap();
    std::env::set_var("KATA_HOME", khome.path());
    let mut spec = base_spec(&work.path().to_string_lossy());
    spec.leash.isolation = kata_core::spec::Isolation::Worktree;
    let mut events: Vec<KataEvent> = Vec::new();
    let err = run(
        &spec,
        &[] as &[CatalogEntry],
        &CancelToken::new(),
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    )
    .unwrap_err();
    std::env::remove_var("KATA_HOME");
    assert!(matches!(err, RunError::Worktree(_)));
    assert_eq!(given_events(&events).len(), 1, "worktree: {events:?}");
}

#[test]
#[serial]
fn run_given_carries_the_runs_options() {
    let rig = Rig::new();
    let mut spec = rig.spec();
    spec.given = Some(kata_core::spec::Given {
        required_plugins: vec!["ai-sdlc".into()],
        build: true,
        ..Default::default()
    });
    let events = rig.run_events(&spec, "ok", |_| {});
    let options = events
        .iter()
        .find_map(|e| match e {
            KataEvent::RunGiven { options, .. } => Some(options.clone()),
            _ => None,
        })
        .expect("a run.given");
    assert_eq!(options.required_plugins, vec!["ai-sdlc".to_string()]);
    assert!(options.build);
}

fn run_collect(workdir: &str) -> (Result<kata_core::run::RunOutcome, RunError>, Vec<KataEvent>) {
    let cancel = CancelToken::new();
    let mut events: Vec<KataEvent> = Vec::new();
    let result = run(
        &base_spec(workdir),
        &[] as &[CatalogEntry],
        &cancel,
        &kata_core::run::AnswerRx::default(),
        &kata_core::run::DecisionRx::default(),
        |e| events.push(e),
    );
    (result, events)
}

#[test]
#[serial]
fn run_refuses_too_old_or_unreadable_claude() {
    with_fake("ok");
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().to_string_lossy().to_string();

    std::env::set_var("KATA_FAKE_CLAUDE_VERSION", "2.0.1 (Claude Code)");
    let (result, events) = run_collect(&dir);
    assert!(matches!(result, Err(RunError::ClaudeVersion(_))));
    assert!(!events
        .iter()
        .any(|e| matches!(e, KataEvent::RunStarted { .. })));
    let errors: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            KataEvent::RunError {
                message, exit_code, ..
            } => Some((message.clone(), *exit_code)),
            _ => None,
        })
        .collect();
    assert_eq!(errors.len(), 1, "{events:?}");
    assert_eq!(errors[0].1, 2);
    assert!(errors[0].0.contains("2.0.1") && errors[0].0.contains("2.1.311"));

    std::env::set_var("KATA_FAKE_CLAUDE_VERSION", "garbage");
    let (result, events) = run_collect(&dir);
    std::env::remove_var("KATA_FAKE_CLAUDE_VERSION");
    assert!(matches!(result, Err(RunError::ClaudeVersion(_))));
    assert!(!events
        .iter()
        .any(|e| matches!(e, KataEvent::RunStarted { .. })));
    let message = events
        .iter()
        .find_map(|e| match e {
            KataEvent::RunError { message, .. } => Some(message.clone()),
            _ => None,
        })
        .expect("a run.error");
    assert!(message.contains("could not read"), "{message}");
}

#[test]
#[serial]
fn unsteered_run_still_refuses_too_old_claude() {
    with_fake("ok");
    let work = tempfile::tempdir().unwrap();
    std::env::set_var("KATA_FAKE_CLAUDE_VERSION", "2.1.310");
    let (result, events) = run_collect(&work.path().to_string_lossy());
    std::env::remove_var("KATA_FAKE_CLAUDE_VERSION");
    assert!(matches!(result, Err(RunError::ClaudeVersion(_))));
    assert!(!events.iter().any(|e| matches!(
        e,
        KataEvent::RunStarted { .. } | KataEvent::AssistantText { .. }
    )));
}
