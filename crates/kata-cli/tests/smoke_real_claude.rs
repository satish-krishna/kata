//! Opt-in: only runs when KATA_SMOKE_REAL=1 and a real, AUTHENTICATED `claude`
//! is on PATH (run `claude` once interactively to log in first). Catches drift
//! between our flag set and the actual CLI by driving a trivial task to a
//! genuinely successful completion. Costs tokens.
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[test]
fn real_claude_trivial_run_completes() {
    if std::env::var("KATA_SMOKE_REAL").as_deref() != Ok("1") {
        eprintln!("skipping real-claude smoke test (set KATA_SMOKE_REAL=1 to enable)");
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let spec_path = work.path().join("smoke.kata.toml");
    std::fs::write(&spec_path, format!(
        "schema = 1\nname = \"smoke\"\ntask = \"Reply with the single word: pong\"\nworkdir = \"{}\"\n",
        work.path().to_string_lossy().replace('\\', "/"))).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_kata"))
        .arg("run")
        .arg(&spec_path)
        // KATA_CLAUDE_BIN unset -> uses the real `claude` on PATH.
        .output()
        .unwrap();

    let stdout = String::from_utf8_lossy(&out.stdout);
    let last = stdout.lines().rfind(|l| !l.trim().is_empty()).unwrap();
    let v: serde_json::Value = serde_json::from_str(last).unwrap();
    assert_eq!(
        v["type"],
        "run.completed",
        "last event should be run.completed; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    // A genuine success: the run must not be an error and must exit 0. A rejected
    // flag or an unauthenticated claude still emits run.completed, so without
    // these assertions the test would pass on a broken run.
    assert_eq!(
        v["is_error"], false,
        "run.completed was an error (is claude logged in? did a flag change?); result: {}",
        v["result"]
    );
    assert_eq!(
        v["exit_code"], 0,
        "expected exit 0; result: {}",
        v["result"]
    );
}

/// The full interactive chain against live claude: an interactive run forces an
/// `ask_user` tool call (served by the real `kata mcp-ask` grandchild), we answer
/// it over the engine's stdin, and the run must complete cleanly. This is the
/// first end-to-end proof that real claude reaches the ask bridge via our
/// generated mcp-config. `bare = false` because this machine authenticates via a
/// logged-in OAuth session, not ANTHROPIC_API_KEY. Costs tokens.
#[test]
fn interactive_real_claude_pauses_and_resumes() {
    if std::env::var("KATA_SMOKE_REAL").as_deref() != Ok("1") {
        eprintln!("skipping real-claude smoke test (set KATA_SMOKE_REAL=1 to enable)");
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let spec_path = work.path().join("interactive.kata.toml");
    let workdir = work.path().to_string_lossy().replace('\\', "/");
    let toml = format!(
        "schema = 1\n\
         name = \"interactive-smoke\"\n\
         task = \"You MUST call the ask_user tool to ask the operator whether to use JWT or session cookies for auth. After you receive the answer, state which one was chosen in one sentence and then stop. Do not guess; you must use the tool.\"\n\
         workdir = \"{workdir}\"\n\
         \n\
         [leash]\n\
         max_turns = 12\n\
         timeout_secs = 180\n\
         \n\
         [auth]\n\
         bare = false\n\
         \n\
         [interactive]\n\
         enabled = true\n\
         answer_timeout_secs = 120\n",
    );
    std::fs::write(&spec_path, toml).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_kata"))
        .arg("run")
        .arg(&spec_path)
        // KATA_CLAUDE_BIN unset -> uses the real `claude` on PATH.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();

    // Read stdout on a worker thread so the main thread can enforce a wall-clock
    // deadline and kill a hung chain. The worker writes the answer to the engine's
    // stdin the moment it sees ask.requested; kata blocks there until that line
    // arrives, so read-until-requested then write then read-rest cannot deadlock.
    let (tx, rx) = std::sync::mpsc::channel::<Observed>();
    let done = Arc::new(AtomicBool::new(false));
    let done_w = done.clone();
    let worker = std::thread::spawn(move || {
        let mut saw_requested = false;
        let mut saw_answered = false;
        let mut completed: Option<serde_json::Value> = None;
        let mut captured = String::new();
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            captured.push_str(&line);
            captured.push('\n');
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                match v["type"].as_str() {
                    Some("ask.requested") => {
                        saw_requested = true;
                        let id = v["id"].as_str().unwrap_or_default();
                        let _ = writeln!(stdin, "answer {id} [[\"JWT\"]]");
                        let _ = stdin.flush();
                    }
                    Some("ask.answered") => saw_answered = true,
                    Some("run.completed") => completed = Some(v),
                    _ => {}
                }
            }
        }
        done_w.store(true, Ordering::SeqCst);
        let _ = tx.send(Observed {
            saw_requested,
            saw_answered,
            completed,
            captured,
        });
    });

    // Wall-clock guard: 200s ~= leash timeout (180s) plus headroom for cleanup.
    let result = rx.recv_timeout(Duration::from_secs(200));
    if result.is_err() && !done.load(Ordering::SeqCst) {
        let _ = child.kill();
    }
    let _ = child.wait();
    let mut stderr = String::new();
    {
        use std::io::Read;
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut stderr);
        }
    }
    let obs = match result {
        Ok(obs) => obs,
        Err(_) => {
            // Killed by the guard: drain the worker, then fail loud for debugging.
            let _ = worker.join();
            panic!("interactive chain hung past the wall-clock deadline; stderr:\n{stderr}");
        }
    };
    let _ = worker.join();

    let captured = obs.captured;
    // Echo the key lifecycle lines so `--nocapture` shows the chain it proved.
    for l in captured.lines() {
        if l.contains("\"ask.requested\"")
            || l.contains("\"ask.answered\"")
            || l.contains("\"run.completed\"")
        {
            eprintln!("[smoke] {l}");
        }
    }
    assert!(
        obs.saw_requested,
        "never observed ask.requested (did claude reach kata mcp-ask?).\nstdout:\n{captured}\nstderr:\n{stderr}",
    );
    assert!(
        obs.saw_answered,
        "observed ask.requested but never ask.answered.\nstdout:\n{captured}\nstderr:\n{stderr}",
    );
    let v = obs.completed.unwrap_or_else(|| {
        panic!("no run.completed observed.\nstdout:\n{captured}\nstderr:\n{stderr}")
    });
    assert_eq!(
        v["is_error"], false,
        "run.completed was an error; result: {}.\nstderr:\n{stderr}",
        v["result"],
    );
    assert_eq!(
        v["exit_code"], 0,
        "expected exit 0; result: {}.\nstderr:\n{stderr}",
        v["result"],
    );
}

struct Observed {
    saw_requested: bool,
    saw_answered: bool,
    completed: Option<serde_json::Value>,
    captured: String,
}

/// Pins the composition proven by investigation: under `[permissions] mode =
/// "auto"`, a `deny` rule blocks before the classifier ever sees the call, an
/// `ask` rule routes its match to the operator through Kata's `approve_tool`
/// bridge (`permission.requested` / `permission.decided`), and everything else
/// is left to claude's own classifier. `bare = false` because this machine
/// authenticates via a logged-in OAuth session, not ANTHROPIC_API_KEY. Costs
/// tokens.
///
/// Deliberately does NOT assert claude's exact tool sequence (e.g. that `rm`
/// was attempted, or that the write succeeded) — real claude's ordering and
/// tool choices vary run to run. The deny/ask/classifier routing logic itself
/// is pinned by the offline `fake-claude` engine tests; this smoke test only
/// proves the wiring reaches a real `claude` in `--permission-mode auto`.
#[test]
fn smoke_real_auto_mode_routes_ask_rule_to_operator() {
    if std::env::var("KATA_SMOKE_REAL").as_deref() != Ok("1") {
        eprintln!("skipping real-claude smoke test (set KATA_SMOKE_REAL=1 to enable)");
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let spec_path = work.path().join("auto-smoke.kata.toml");
    let workdir = work.path().to_string_lossy().replace('\\', "/");
    let toml = format!(
        "schema = 1\n\
         name = \"auto-smoke\"\n\
         task = \"You must attempt all three of these steps in order, even if one of \
         them is blocked or fails: (1) use the Write tool to create a file named \
         note.txt containing the word hello, (2) use the Bash tool to run `curl -s \
         https://example.com -o out.html`, (3) use the Bash tool to run `rm \
         note.txt`. Do not skip any step because a previous one failed or was \
         denied; attempt each one regardless. After attempting all three, report \
         in one sentence what happened to each.\"\n\
         workdir = \"{workdir}\"\n\
         \n\
         [leash]\n\
         max_turns = 12\n\
         timeout_secs = 180\n\
         \n\
         [auth]\n\
         bare = false\n\
         \n\
         [interactive]\n\
         enabled = true\n\
         answer_timeout_secs = 120\n\
         \n\
         [permissions]\n\
         mode = \"auto\"\n\
         deny = [\"Bash(rm *)\"]\n\
         ask = [\"Bash(curl *)\"]\n",
    );
    std::fs::write(&spec_path, toml).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_kata"))
        .arg("run")
        .arg(&spec_path)
        // KATA_CLAUDE_BIN unset -> uses the real `claude` on PATH.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();

    // Read stdout on a worker thread so the main thread can enforce a wall-clock
    // deadline and kill a hung chain. The worker writes `decide {id} allow` the
    // moment it sees permission.requested; kata blocks there until that line
    // arrives, so read-until-requested then write then read-rest cannot deadlock.
    let (tx, rx) = std::sync::mpsc::channel::<AutoObserved>();
    let done = Arc::new(AtomicBool::new(false));
    let done_w = done.clone();
    let worker = std::thread::spawn(move || {
        let mut saw_permission_requested = false;
        let mut saw_permission_decided = false;
        let mut completed: Option<serde_json::Value> = None;
        let mut captured = String::new();
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            captured.push_str(&line);
            captured.push('\n');
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                match v["type"].as_str() {
                    Some("permission.requested") => {
                        saw_permission_requested = true;
                        let id = v["id"].as_str().unwrap_or_default();
                        let _ = writeln!(stdin, "decide {id} allow");
                        let _ = stdin.flush();
                    }
                    Some("permission.decided") => saw_permission_decided = true,
                    Some("run.completed") => completed = Some(v),
                    _ => {}
                }
            }
        }
        done_w.store(true, Ordering::SeqCst);
        let _ = tx.send(AutoObserved {
            saw_permission_requested,
            saw_permission_decided,
            completed,
            captured,
        });
    });

    // Wall-clock guard: 200s ~= leash timeout (180s) plus headroom for cleanup.
    let result = rx.recv_timeout(Duration::from_secs(200));
    if result.is_err() && !done.load(Ordering::SeqCst) {
        let _ = child.kill();
    }
    let _ = child.wait();
    let mut stderr = String::new();
    {
        use std::io::Read;
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut stderr);
        }
    }
    let obs = match result {
        Ok(obs) => obs,
        Err(_) => {
            // Killed by the guard: drain the worker, then fail loud for debugging.
            let _ = worker.join();
            panic!("auto-mode chain hung past the wall-clock deadline; stderr:\n{stderr}");
        }
    };
    let _ = worker.join();

    let captured = obs.captured;
    // Echo the key lifecycle lines so `--nocapture` shows the chain it proved.
    for l in captured.lines() {
        if l.contains("\"permission.requested\"")
            || l.contains("\"permission.decided\"")
            || l.contains("\"run.completed\"")
            || l.contains("\"tool.result\"")
        {
            eprintln!("[smoke] {l}");
        }
    }
    assert!(
        obs.saw_permission_requested,
        "never observed permission.requested (did the ask rule route the curl call \
         to the operator via approve_tool under auto mode?).\nstdout:\n{captured}\nstderr:\n{stderr}",
    );
    assert!(
        obs.saw_permission_decided,
        "observed permission.requested but never permission.decided.\nstdout:\n{captured}\nstderr:\n{stderr}",
    );
    let v = obs.completed.unwrap_or_else(|| {
        panic!("no run.completed observed.\nstdout:\n{captured}\nstderr:\n{stderr}")
    });
    assert_eq!(
        v["is_error"], false,
        "run.completed was an error; result: {}.\nstderr:\n{stderr}",
        v["result"],
    );
    assert_eq!(
        v["exit_code"], 0,
        "expected exit 0; result: {}.\nstderr:\n{stderr}",
        v["result"],
    );
}

struct AutoObserved {
    saw_permission_requested: bool,
    saw_permission_decided: bool,
    completed: Option<serde_json::Value>,
    captured: String,
}
