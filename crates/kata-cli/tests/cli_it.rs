#![allow(clippy::disallowed_methods)]
use std::process::Command;

fn kata() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kata"))
}

fn write(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    p
}

fn fake_claude() -> std::path::PathBuf {
    // `kata` and `fake-claude` build into the same target dir.
    let kata = std::path::PathBuf::from(env!("CARGO_BIN_EXE_kata"));
    let dir = kata.parent().unwrap();
    let name = if cfg!(windows) {
        "fake-claude.exe"
    } else {
        "fake-claude"
    };
    dir.join(name)
}

#[test]
fn validate_ok_exits_zero() {
    let tmp = tempfile::tempdir().unwrap();
    let spec = write(
        tmp.path(),
        "ok.kata.toml",
        "schema = 1\nname = \"x\"\ntask = \"t\"\nworkdir = \"/w\"\n",
    );
    let out = kata().arg("validate").arg(&spec).output().unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn validate_bad_exits_nonzero_and_lists_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let spec = write(
        tmp.path(),
        "bad.kata.toml",
        "schema = 1\nname = \"\"\ntask = \"\"\nworkdir = \"\"\n",
    );
    let out = kata().arg("validate").arg(&spec).output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(1),
        "validation failure should exit 1"
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("name"));
    assert!(err.contains("task"));
    assert!(err.contains("workdir"));
}

#[test]
fn catalog_emits_json_array() {
    // Point discovery at an isolated HOME so the test is deterministic.
    let home = tempfile::tempdir().unwrap();
    let skill = home.path().join(".claude").join("skills").join("triage");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: triage\ndescription: triage flaky tests\n---\n",
    )
    .unwrap();

    let work = tempfile::tempdir().unwrap();
    let out = kata()
        .arg("catalog")
        .current_dir(work.path())
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let arr = v.as_array().unwrap();
    assert!(arr
        .iter()
        .any(|e| e["name"] == "triage" && e["kind"] == "skill"));
}

#[test]
fn run_streams_jsonl_events_and_exits_zero() {
    let work = tempfile::tempdir().unwrap();
    let spec = write(
        work.path(),
        "r.kata.toml",
        &format!(
            "schema = 1\nname = \"r\"\ntask = \"t\"\nworkdir = \"{}\"\n",
            work.path().to_string_lossy().replace('\\', "/")
        ),
    );

    let fake = fake_claude();
    let out = kata()
        .arg("run")
        .arg(&spec)
        .env("KATA_CLAUDE_BIN", &fake)
        .env("KATA_FAKE_MODE", "ok")
        .output()
        .unwrap();

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    let first: serde_json::Value = serde_json::from_str(lines.first().unwrap()).unwrap();
    let last: serde_json::Value = serde_json::from_str(lines.last().unwrap()).unwrap();
    assert_eq!(first["type"], "run.started");
    assert_eq!(last["type"], "run.completed");
    assert_eq!(last["exit_code"], 0);
}

/// The unattended CI case: a non-interactive spec, no answer deadline, and
/// stdin at EOF. Claude asks anyway (it can, whatever the permission mode); the
/// question pauses on the operator, nobody can ever answer, and the run must end
/// with 123 rather than hang with its work clock paused.
#[test]
fn run_question_with_stdin_at_eof_exits_123_instead_of_hanging() {
    let work = tempfile::tempdir().unwrap();
    let kata_home = tempfile::tempdir().unwrap();
    let spec = write(
        work.path(),
        "q.kata.toml",
        &format!(
            "schema = 1\nname = \"q\"\ntask = \"t\"\nworkdir = \"{}\"\n\n[leash]\ntimeout_secs = 60\n",
            work.path().to_string_lossy().replace('\\', "/")
        ),
    );

    let started = std::time::Instant::now();
    let out = kata()
        .arg("run")
        .arg(&spec)
        .env("KATA_CLAUDE_BIN", fake_claude())
        .env("KATA_FAKE_MODE", "ask")
        .env("KATA_HOME", kata_home.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();

    assert_eq!(
        out.status.code(),
        Some(123),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(30));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains(r#""type":"ask.requested""#), "{stdout}");
    assert!(stdout.contains("nobody can answer"), "{stdout}");
}

/// Blank the volatile fields of one event line for golden comparison: the temp
/// workdir, the timestamped transcript path, and the wall-clock duration. Returns
/// the parsed value; serde_json's default Map is a BTreeMap, so re-serializing
/// sorts keys and the golden is stable and platform-independent.
fn normalize_line(line: &str) -> serde_json::Value {
    let mut v: serde_json::Value = serde_json::from_str(line)
        .unwrap_or_else(|e| panic!("non-JSON line on run stdout: {line:?} ({e})"));
    match v["type"].as_str() {
        Some("run.started") => v["workdir"] = "<WORKDIR>".into(),
        Some("log")
            if v["message"]
                .as_str()
                .unwrap_or("")
                .starts_with("transcript: ") =>
        {
            v["message"] = "transcript: <TRANSCRIPT>".into()
        }
        Some("run.completed") => v["duration_ms"] = serde_json::json!(0),
        // Instruction files found in the folders above the temp workdir belong to
        // whichever machine runs the test, and the standing note's text is pinned
        // by the engine's own tests; neither belongs in the golden.
        Some("run.given") => {
            if let Some(items) = v["items"].as_array_mut() {
                items.retain(|i| i["detail"] != "from a parent folder");
                for i in items.iter_mut() {
                    if i["id"] == "kata:instruction:standing-note" {
                        i["detail"] = "<STANDING NOTE>".into();
                    }
                }
            }
        }
        _ => {}
    }
    v
}

/// Render normalized event values as one compact JSON object per line.
fn render(values: impl Iterator<Item = serde_json::Value>) -> String {
    let mut s = values
        .map(|v| serde_json::to_string(&v).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    s.push('\n');
    s
}

fn normalize_events(stdout: &str) -> String {
    render(
        stdout
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(normalize_line),
    )
}

/// Like `normalize_events`, but drops `turn` events. In an interactive run the
/// turn counter is driven by the child's stdout while `ask.requested` is driven
/// by the localhost ask bridge, so their relative order is inherently
/// concurrent (the in-process test asserts on them order-agnostically for the
/// same reason). The `ok` golden pins `turn`; this one pins the ask protocol.
fn normalize_ask_events(stdout: &str) -> String {
    render(
        stdout
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(normalize_line)
            .filter(|v| v["type"] != "turn"),
    )
}

/// Golden test: the full `kata run` event stream for the deterministic `ok`
/// fake-claude mode must match a checked-in fixture. This pins the out-of-process
/// wire protocol (event sequence, type tags, field names) that the consumer guide
/// in `docs/consuming-kata.md` documents. When the protocol changes on purpose,
/// regenerate with `UPDATE_GOLDEN=1 cargo test -p kata-cli --test cli_it`.
#[test]
fn run_ok_event_stream_matches_golden() {
    let work = tempfile::tempdir().unwrap();
    let kata_home = tempfile::tempdir().unwrap();
    let workdir = work.path().to_string_lossy().replace('\\', "/");
    let spec = write(
        work.path(),
        "g.kata.toml",
        &format!(
            "schema = 1\nname = \"golden\"\ntask = \"t\"\nworkdir = \"{workdir}\"\n\n[leash]\ntimeout_secs = 60\n"
        ),
    );

    let out = kata()
        .arg("run")
        .arg(&spec)
        .env("KATA_CLAUDE_BIN", fake_claude())
        .env("KATA_FAKE_MODE", "ok")
        .env("KATA_HOME", kata_home.path())
        // The given view reads the home's setup; an empty one keeps the golden the same on every machine.
        .env("HOME", kata_home.path().join("home"))
        .env("USERPROFILE", kata_home.path().join("home"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let actual = normalize_events(&String::from_utf8(out.stdout).unwrap());

    let golden_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/run_ok_events.jsonl");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        std::fs::write(&golden_path, &actual).unwrap();
    }
    let golden = std::fs::read_to_string(&golden_path)
        .unwrap_or_else(|_| {
            panic!(
                "missing golden fixture {}; generate it with UPDATE_GOLDEN=1",
                golden_path.display()
            )
        })
        .replace("\r\n", "\n");
    assert_eq!(
        actual, golden,
        "the run event stream drifted from the golden fixture. If this change is \
         intentional, regenerate with UPDATE_GOLDEN=1 and review the diff."
    );
}

/// The `kata run` command for the `ok` fake-claude mode, with the spec written
/// into `work` and an empty home, so the event stream is the same on every
/// machine. The caller chooses what the engine's stdin is.
fn ok_run_command(work: &std::path::Path, kata_home: &std::path::Path) -> Command {
    let workdir = work.to_string_lossy().replace('\\', "/");
    let spec = write(
        work,
        "g.kata.toml",
        &format!(
            "schema = 1\nname = \"golden\"\ntask = \"t\"\nworkdir = \"{workdir}\"\n\n[leash]\ntimeout_secs = 60\n"
        ),
    );
    let mut cmd = kata();
    cmd.arg("run")
        .arg(&spec)
        .env("KATA_CLAUDE_BIN", fake_claude())
        .env("KATA_FAKE_MODE", "ok")
        .env("KATA_HOME", kata_home)
        .env("HOME", kata_home.join("home"))
        .env("USERPROFILE", kata_home.join("home"));
    cmd
}

/// Run the `ok` fake-claude mode with the engine's stdin closed at once, the way a
/// CI pipeline does (R8.1, R8.2). Returns the finished process output.
fn run_ok_with_stdin_closed() -> std::process::Output {
    let work = tempfile::tempdir().unwrap();
    let kata_home = tempfile::tempdir().unwrap();
    ok_run_command(work.path(), kata_home.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap()
}

/// R8.1, "a CI pipeline that keeps its input open": nobody sends a message and
/// the input stays open (nothing written, never closed) until the run is over.
/// The run must finish by itself with outcome 0 and report exactly the events it
/// reported before steering existed. A run that waited for end of input before
/// finishing would hang here, so every wait is bounded.
#[test]
fn run_ok_with_stdin_held_open_matches_golden() {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let work = tempfile::tempdir().unwrap();
    let kata_home = tempfile::tempdir().unwrap();
    let mut child = ok_run_command(work.path(), kata_home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    // Held open and untouched until the assertions are done.
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut lines = Vec::new();
    let mut completed = false;
    while !completed {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) => {
                completed = serde_json::from_str::<serde_json::Value>(&line)
                    .is_ok_and(|v| v["type"] == "run.completed");
                lines.push(line);
            }
            Err(_) => {
                let _ = child.kill();
                panic!(
                    "no run.completed within 30s while stdin stayed open; the run is \
                     waiting for end of input. Events so far:\n{}",
                    lines.join("\n")
                );
            }
        }
    }

    // The process must also exit on its own while the input is still open.
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!(
                "run.completed arrived but the process did not exit within 30s while stdin stayed open"
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // Anything after run.completed still belongs to the stream.
    lines.extend(rx.try_iter());
    drop(stdin);

    assert_eq!(status.code(), Some(0), "events:\n{}", lines.join("\n"));
    let actual = normalize_events(&lines.join("\n"));
    let golden_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/run_ok_events.jsonl");
    let golden = std::fs::read_to_string(&golden_path)
        .unwrap_or_else(|_| panic!("missing golden fixture {}", golden_path.display()))
        .replace("\r\n", "\n");
    assert_eq!(
        actual, golden,
        "an unsteered run with its input held open drifted from the golden fixture"
    );
}

/// A run whose input was closed at once and whose agent asks nothing ends with 0.
#[test]
fn run_with_stdin_closed_at_once_exits_zero() {
    let out = run_ok_with_stdin_closed();
    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// The same event stream, order and outcome as before steering existed, for a
/// pipeline that closes its input at once.
#[test]
fn run_ok_with_stdin_closed_at_once_matches_golden() {
    let out = run_ok_with_stdin_closed();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let actual = normalize_events(&String::from_utf8(out.stdout).unwrap());

    let golden_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden/run_ok_stdin_closed_events.jsonl");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        std::fs::write(&golden_path, &actual).unwrap();
    }
    let golden = std::fs::read_to_string(&golden_path)
        .unwrap_or_else(|_| {
            panic!(
                "missing golden fixture {}; generate it with UPDATE_GOLDEN=1",
                golden_path.display()
            )
        })
        .replace("\r\n", "\n");
    assert_eq!(
        actual, golden,
        "the stdin-closed run event stream drifted from the golden fixture. If this \
         change is intentional, regenerate with UPDATE_GOLDEN=1 and review the diff."
    );
}

/// Golden test for the interactive path: drive the `ask` fake mode through
/// `kata run`, answer the question on stdin, and pin the resulting
/// `ask.requested` -> `ask.answered` -> `run.completed` exchange against a
/// fixture. This locks the interactive wire shapes (the question fields, the
/// answer matrix) documented in `docs/consuming-kata.md`. Regenerate on an
/// intentional change with `UPDATE_GOLDEN=1 cargo test -p kata-cli --test cli_it`.
#[test]
fn run_ask_interactive_event_stream_matches_golden() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;

    let work = tempfile::tempdir().unwrap();
    let kata_home = tempfile::tempdir().unwrap();
    let workdir = work.path().to_string_lossy().replace('\\', "/");
    let spec = write(
        work.path(),
        "gi.kata.toml",
        &format!(
            "schema = 1\nname = \"golden-ask\"\ntask = \"t\"\nworkdir = \"{workdir}\"\n\n\
             [leash]\ntimeout_secs = 60\n\n\
             [interactive]\nenabled = true\nanswer_timeout_secs = 30\n"
        ),
    );

    let mut child = kata()
        .arg("run")
        .arg(&spec)
        .env("KATA_CLAUDE_BIN", fake_claude())
        .env("KATA_FAKE_MODE", "ask")
        .env("KATA_HOME", kata_home.path())
        // The given view reads the home's setup; an empty one keeps the golden the same on every machine.
        .env("HOME", kata_home.path().join("home"))
        .env("USERPROFILE", kata_home.path().join("home"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    // Read the stream; when the question arrives, answer it on stdin and keep
    // reading until the child completes and closes stdout.
    let mut stdin = child.stdin.take().unwrap();
    let reader = BufReader::new(child.stdout.take().unwrap());
    let mut lines = Vec::new();
    let mut answered = false;
    for line in reader.lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        if !answered {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v["type"] == "ask.requested" {
                    let id = v["id"].as_str().unwrap();
                    writeln!(stdin, "answer {id} [[\"use a refresh token\"]]").unwrap();
                    stdin.flush().unwrap();
                    answered = true;
                }
            }
        }
        lines.push(line);
    }
    let status = child.wait().unwrap();
    assert!(status.success(), "interactive run should exit 0");
    assert!(answered, "expected an ask.requested event to answer");

    let actual = normalize_ask_events(&lines.join("\n"));

    let golden_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/run_ask_events.jsonl");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        std::fs::write(&golden_path, &actual).unwrap();
    }
    let golden = std::fs::read_to_string(&golden_path)
        .unwrap_or_else(|_| {
            panic!(
                "missing golden fixture {}; generate it with UPDATE_GOLDEN=1",
                golden_path.display()
            )
        })
        .replace("\r\n", "\n");
    assert_eq!(
        actual, golden,
        "the interactive run event stream drifted from the golden fixture. If this \
         change is intentional, regenerate with UPDATE_GOLDEN=1 and review the diff."
    );
}

/// Golden test for the permission-prompt path: drive the `approve` fake mode
/// through `kata run` in `[permissions] mode = "prompt"`, decide the check on
/// stdin, and pin the resulting `permission.requested` -> `permission.decided`
/// -> `run.completed` exchange. This locks the wire shapes and the `decide`
/// control line documented in `docs/consuming-kata.md`. Regenerate on an
/// intentional change with `UPDATE_GOLDEN=1 cargo test -p kata-cli --test cli_it`.
#[test]
fn run_permission_prompt_event_stream_matches_golden() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;

    let work = tempfile::tempdir().unwrap();
    let kata_home = tempfile::tempdir().unwrap();
    let workdir = work.path().to_string_lossy().replace('\\', "/");
    let spec = write(
        work.path(),
        "gp.kata.toml",
        &format!(
            "schema = 1\nname = \"golden-perm\"\ntask = \"t\"\nworkdir = \"{workdir}\"\n\n\
             [leash]\ntimeout_secs = 60\n\n\
             [interactive]\nenabled = true\nanswer_timeout_secs = 30\n\n\
             [permissions]\nmode = \"prompt\"\nunmatched = \"ask\"\ndeny = [\"Bash(shutdown *)\"]\n"
        ),
    );

    let mut child = kata()
        .arg("run")
        .arg(&spec)
        .env("KATA_CLAUDE_BIN", fake_claude())
        .env("KATA_FAKE_MODE", "approve")
        .env("KATA_FAKE_TOOL", "Bash")
        .env("KATA_FAKE_TOOL_INPUT", r#"{"command":"rm -rf build/"}"#)
        .env("KATA_HOME", kata_home.path())
        // The given view reads the home's setup; an empty one keeps the golden the same on every machine.
        .env("HOME", kata_home.path().join("home"))
        .env("USERPROFILE", kata_home.path().join("home"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let reader = BufReader::new(child.stdout.take().unwrap());
    let mut lines = Vec::new();
    let mut decided = false;
    for line in reader.lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        if !decided {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v["type"] == "permission.requested" {
                    let id = v["id"].as_str().unwrap();
                    writeln!(stdin, "decide {id} deny build/ is not yours to delete").unwrap();
                    stdin.flush().unwrap();
                    decided = true;
                }
            }
        }
        lines.push(line);
    }
    let status = child.wait().unwrap();
    assert!(status.success(), "a denied tool call is not a failed run");
    assert!(decided, "expected a permission.requested event to decide");

    let actual = normalize_ask_events(&lines.join("\n"));

    let golden_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden/run_permission_events.jsonl");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        std::fs::write(&golden_path, &actual).unwrap();
    }
    let golden = std::fs::read_to_string(&golden_path)
        .unwrap_or_else(|_| {
            panic!(
                "missing golden fixture {}; generate it with UPDATE_GOLDEN=1",
                golden_path.display()
            )
        })
        .replace("\r\n", "\n");
    assert_eq!(
        actual, golden,
        "the permission-prompt event stream drifted from the golden fixture. If this \
         change is intentional, regenerate with UPDATE_GOLDEN=1 and review the diff."
    );
}

/// The engine must refuse a spec whose permission posture cannot work: `ask`
/// with no operator to ask. Exit 1 is the validation code, and the message has
/// to name the field so the fix is obvious from CI output alone.
#[test]
fn run_rejects_ask_policy_without_interactive() {
    let work = tempfile::tempdir().unwrap();
    let workdir = work.path().to_string_lossy().replace('\\', "/");
    let spec = write(
        work.path(),
        "bad.kata.toml",
        &format!(
            "schema = 1\nname = \"bad\"\ntask = \"t\"\nworkdir = \"{workdir}\"\n\n\
             [permissions]\nmode = \"prompt\"\n"
        ),
    );

    let out = kata().arg("validate").arg(&spec).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "validation failure is exit 1");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("permissions.unmatched"),
        "the error must name the field: {stderr}"
    );
}

#[test]
fn run_cancel_via_stdin_exits_130() {
    use std::io::Write;
    use std::process::Stdio;

    let work = tempfile::tempdir().unwrap();
    let spec = write(work.path(), "c.kata.toml",
        &format!("schema = 1\nname = \"c\"\ntask = \"t\"\nworkdir = \"{}\"\n\n[leash]\ntimeout_secs = 8\n",
            work.path().to_string_lossy().replace('\\', "/")));

    let fake = fake_claude();
    let mut child = kata()
        .arg("run")
        .arg(&spec)
        .env("KATA_CLAUDE_BIN", &fake)
        .env("KATA_FAKE_MODE", "sleep")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    // Give the engine time to spawn fake-claude and enter its run loop.
    std::thread::sleep(std::time::Duration::from_millis(500));
    child.stdin.take().unwrap().write_all(b"cancel\n").unwrap();

    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(130), "stdin cancel should exit 130");
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.lines().any(|l| {
            serde_json::from_str::<serde_json::Value>(l)
                .map(|v| v["type"] == "run.cancelled")
                .unwrap_or(false)
        }),
        "expected a run.cancelled event, got:\n{stdout}"
    );
}

#[test]
fn bundle_writes_self_contained_folder() {
    // Isolated HOME so discovery is deterministic.
    let home = tempfile::tempdir().unwrap();
    let skill = home.path().join(".claude").join("skills").join("triage");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: triage\ndescription: triage flaky tests\n---\nbody\n",
    )
    .unwrap();

    let work = tempfile::tempdir().unwrap();
    let spec = write(
        work.path(),
        "b.kata.toml",
        &format!(
            "schema = 1\nname = \"b\"\ntask = \"t\"\nworkdir = \"{}\"\nskills = [\"triage\"]\n",
            work.path().to_string_lossy().replace('\\', "/")
        ),
    );

    let out = work.path().join("b-bundle");
    let result = kata()
        .arg("bundle")
        .arg(&spec)
        .arg("-o")
        .arg(&out)
        .current_dir(work.path())
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .output()
        .unwrap();

    assert!(
        result.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(out
        .join(".claude")
        .join("skills")
        .join("triage")
        .join("SKILL.md")
        .is_file());
    assert!(out.join("spec.toml").is_file());
    assert!(out.join("kata-bundle.toml").is_file());
}

#[test]
fn run_from_bundle_is_hermetic_and_completes() {
    // Author the bundle from a HOME that has the skill.
    let home = tempfile::tempdir().unwrap();
    let skill = home.path().join(".claude").join("skills").join("triage");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: triage\ndescription: triage flaky tests\n---\nbody\n",
    )
    .unwrap();

    // workdir must exist at run time (it becomes the child's cwd).
    let work = tempfile::tempdir().unwrap();
    let spec = write(
        work.path(),
        "h.kata.toml",
        &format!(
            "schema = 1\nname = \"h\"\ntask = \"t\"\nworkdir = \"{}\"\nskills = [\"triage\"]\n",
            work.path().to_string_lossy().replace('\\', "/")
        ),
    );

    let bundle_dir = work.path().join("h-bundle");
    let made = kata()
        .arg("bundle")
        .arg(&spec)
        .arg("-o")
        .arg(&bundle_dir)
        .current_dir(work.path())
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .output()
        .unwrap();
    assert!(
        made.status.success(),
        "bundle stderr: {}",
        String::from_utf8_lossy(&made.stderr)
    );

    // Run the bundle with an EMPTY home -> proves the kit comes from the bundle.
    let empty_home = tempfile::tempdir().unwrap();
    let out = kata()
        .arg("run")
        .arg(&bundle_dir)
        .env("KATA_CLAUDE_BIN", fake_claude())
        .env("KATA_FAKE_MODE", "ok")
        .env("HOME", empty_home.path())
        .env("USERPROFILE", empty_home.path())
        .output()
        .unwrap();

    assert!(
        out.status.success(),
        "run stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    let first: serde_json::Value = serde_json::from_str(lines.first().unwrap()).unwrap();
    let last: serde_json::Value = serde_json::from_str(lines.last().unwrap()).unwrap();
    assert_eq!(first["type"], "run.started");
    assert_eq!(last["type"], "run.completed");
    assert_eq!(last["exit_code"], 0);
}

#[test]
fn init_writes_default_spec_that_validates() {
    let dir = tempfile::tempdir().unwrap();
    let status = kata().arg("init").current_dir(dir.path()).status().unwrap();
    assert!(status.success(), "init should exit 0");

    let spec = dir.path().join("kata.toml");
    let text = std::fs::read_to_string(&spec).unwrap();
    assert!(
        text.lines()
            .next()
            .unwrap()
            .starts_with("#:schema https://raw.githubusercontent.com/satish-krishna/kata/v"),
        "first line must be the pinned schema URL, got: {text}"
    );

    // The scaffolded spec must pass `kata validate`.
    let v = kata().arg("validate").arg(&spec).status().unwrap();
    assert!(v.success(), "scaffolded spec must validate");
}

#[test]
fn init_names_the_file_after_the_argument() {
    let dir = tempfile::tempdir().unwrap();
    let status = kata()
        .arg("init")
        .arg("triage")
        .current_dir(dir.path())
        .status()
        .unwrap();
    assert!(status.success());
    assert!(dir.path().join("triage.toml").exists());
}

#[test]
fn init_refuses_to_overwrite_without_force() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("kata.toml"), "existing").unwrap();
    let code = kata()
        .arg("init")
        .current_dir(dir.path())
        .status()
        .unwrap()
        .code()
        .unwrap();
    assert_eq!(code, 73, "no-overwrite refusal must exit 73 (EX_CANTCREAT)");
    // File must be untouched.
    assert_eq!(
        std::fs::read_to_string(dir.path().join("kata.toml")).unwrap(),
        "existing"
    );
}

#[test]
fn init_force_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("kata.toml"), "existing").unwrap();
    let status = kata()
        .arg("init")
        .arg("--force")
        .current_dir(dir.path())
        .status()
        .unwrap();
    assert!(status.success());
    let text = std::fs::read_to_string(dir.path().join("kata.toml")).unwrap();
    assert!(text.contains("[leash]"), "should be the scaffold now");
}

#[test]
fn init_local_emits_a_relative_path_inside_a_workspace() {
    // Fake a workspace root: a Cargo.toml with [workspace] and a schema dir.
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("Cargo.toml"),
        "[workspace]\nmembers = []\n",
    )
    .unwrap();
    std::fs::create_dir_all(root.path().join("schema")).unwrap();
    std::fs::write(
        root.path().join("schema").join("kata-runspec.schema.json"),
        "{}",
    )
    .unwrap();
    let sub = root.path().join("specs");
    std::fs::create_dir_all(&sub).unwrap();

    let status = kata()
        .arg("init")
        .arg("--local")
        .current_dir(&sub)
        .status()
        .unwrap();
    assert!(status.success());
    let text = std::fs::read_to_string(sub.join("kata.toml")).unwrap();
    assert_eq!(
        text.lines().next().unwrap(),
        "#:schema ../schema/kata-runspec.schema.json"
    );
}

#[test]
fn init_local_errors_outside_a_workspace() {
    // No Cargo.toml anywhere under this temp dir: `find_workspace_root` must fail.
    let dir = tempfile::tempdir().unwrap();
    let code = kata()
        .arg("init")
        .arg("--local")
        .current_dir(dir.path())
        .status()
        .unwrap()
        .code()
        .unwrap();
    assert_eq!(code, 2, "--local outside a workspace must exit 2");
    assert!(
        !dir.path().join("kata.toml").exists(),
        "kata.toml must not be written on failure"
    );
}

#[test]
fn init_local_errors_when_schema_missing() {
    // A [workspace] Cargo.toml exists, but there is no schema/ dir under it.
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("Cargo.toml"),
        "[workspace]\nmembers = []\n",
    )
    .unwrap();
    let sub = root.path().join("specs");
    std::fs::create_dir_all(&sub).unwrap();

    let code = kata()
        .arg("init")
        .arg("--local")
        .current_dir(&sub)
        .status()
        .unwrap()
        .code()
        .unwrap();
    assert_eq!(code, 2, "--local with a missing schema file must exit 2");
    assert!(
        !sub.join("kata.toml").exists(),
        "kata.toml must not be written on failure"
    );
}

#[test]
fn init_rejects_path_like_names() {
    // NAME must be a single file-name component: a name with a path separator or
    // a `..` component must be refused (exit 2) and write nothing outside cwd.
    let dir = tempfile::tempdir().unwrap();
    for bad in ["../escape", "sub/name", ".."] {
        let code = kata()
            .arg("init")
            .arg(bad)
            .current_dir(dir.path())
            .status()
            .unwrap()
            .code()
            .unwrap();
        assert_eq!(
            code, 2,
            "init should reject path-like name {bad:?} with exit 2"
        );
    }
    // Nothing was written into or above the temp dir.
    assert!(!dir.path().join("escape.toml").exists());
    assert!(!dir.path().join("..").join("escape.toml").exists());
}

#[test]
fn run_full_payloads_flag_adds_tool_output() {
    let work = tempfile::tempdir().unwrap();
    let kata_home = tempfile::tempdir().unwrap();
    let spec = write(
        work.path(),
        "p.kata.toml",
        &format!(
            "schema = 1\nname = \"p\"\ntask = \"t\"\nworkdir = \"{}\"\n",
            work.path().to_string_lossy().replace('\\', "/")
        ),
    );
    let run = |flag: bool| {
        let mut cmd = kata();
        cmd.arg("run");
        if flag {
            cmd.arg("--full-payloads");
        }
        let out = cmd
            .arg(&spec)
            .env("KATA_CLAUDE_BIN", fake_claude())
            .env("KATA_FAKE_MODE", "subagent")
            .env("KATA_HOME", kata_home.path())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
            .find(|v| v["type"] == "tool.result" && v["name"] == "Read")
            .expect("a Read tool.result")
    };
    let lean = run(false);
    assert_eq!(lean["id"], "toolu_B");
    assert!(lean.get("output").is_none());
    let full = run(true);
    assert_eq!(full["output"], "1\thello");
}

#[cfg(windows)]
#[test]
fn ctrl_break_cancels_with_130() {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    let work = tempfile::tempdir().unwrap();
    let pidfile = work.path().join("fake.pid");
    let spec = write(work.path(), "c.kata.toml",
        &format!("schema = 1\nname = \"c\"\ntask = \"t\"\nworkdir = \"{}\"\n\n[leash]\ntimeout_secs = 20\n",
            work.path().to_string_lossy().replace('\\', "/")));

    let child = kata()
        .arg("run")
        .arg(&spec)
        .env("KATA_CLAUDE_BIN", fake_claude())
        .env("KATA_FAKE_MODE", "sleep")
        .env("KATA_FAKE_PIDFILE", &pidfile)
        .creation_flags(CREATE_NEW_PROCESS_GROUP)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    // Wait until fake-claude is running and has written its pid.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let fake_pid: u32 = loop {
        if let Some(pid) = std::fs::read_to_string(&pidfile)
            .ok()
            .and_then(|s| s.trim().parse().ok())
        {
            break pid;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "fake-claude never started"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    std::thread::sleep(std::time::Duration::from_millis(300));

    // SAFETY: plain Win32 call; the pid is the process group id of the child started above.
    let sent = unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.id()) };
    assert_ne!(sent, 0, "GenerateConsoleCtrlEvent failed");

    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(130), "Ctrl+Break should exit 130");

    // The agent process must be gone too.
    std::thread::sleep(std::time::Duration::from_millis(300));
    let tasks = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {fake_pid}"), "/NH"])
        .output()
        .unwrap();
    assert!(
        !String::from_utf8_lossy(&tasks.stdout).contains(&fake_pid.to_string()),
        "fake-claude {fake_pid} is still running"
    );
}

#[test]
fn run_with_too_old_claude_exits_2() {
    let work = tempfile::tempdir().unwrap();
    let kata_home = tempfile::tempdir().unwrap();
    let spec = write(
        work.path(),
        "old.kata.toml",
        &format!(
            "schema = 1\nname = \"old\"\ntask = \"t\"\nworkdir = \"{}\"\n",
            work.path().to_string_lossy().replace('\\', "/")
        ),
    );
    let out = kata()
        .arg("run")
        .arg(&spec)
        .env("KATA_CLAUDE_BIN", fake_claude())
        .env("KATA_FAKE_CLAUDE_VERSION", "2.0.1 (Claude Code)")
        .env("KATA_HOME", kata_home.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains(r#""type":"run.error""#), "{stdout}");
    assert!(
        stdout.contains("2.0.1") && stdout.contains("2.1.311"),
        "{stdout}"
    );
    assert!(!stdout.contains("run.started"), "{stdout}");
}

/// Run `kata run` against the `steer` fake with its stdin piped. `on_line` sees each
/// stdout event as it arrives and may write control lines to the engine's stdin; the
/// run is synchronized on events, never on sleeps. Returns the exit code and the events.
fn run_steer_cli(
    env: &[(&str, &str)],
    interactive: bool,
    mut on_line: impl FnMut(&serde_json::Value, &mut std::process::ChildStdin),
) -> (Option<i32>, Vec<serde_json::Value>) {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    let work = tempfile::tempdir().unwrap();
    let kata_home = tempfile::tempdir().unwrap();
    let workdir = work.path().to_string_lossy().replace('\\', "/");
    let interactive = if interactive {
        "\n[interactive]\nenabled = true\nanswer_timeout_secs = 30\n"
    } else {
        ""
    };
    let spec = write(
        work.path(),
        "steer.kata.toml",
        &format!(
            "schema = 1\nname = \"steer\"\ntask = \"t\"\nworkdir = \"{workdir}\"\n\n\
             [leash]\ntimeout_secs = 60\n{interactive}"
        ),
    );
    let mut cmd = kata();
    cmd.arg("run")
        .arg(&spec)
        .env("KATA_CLAUDE_BIN", fake_claude())
        .env("KATA_FAKE_MODE", "steer")
        .env("KATA_HOME", kata_home.path())
        .env("HOME", kata_home.path().join("home"))
        .env("USERPROFILE", kata_home.path().join("home"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let reader = BufReader::new(child.stdout.take().unwrap());
    let mut events = Vec::new();
    for line in reader.lines() {
        let line = line.unwrap();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            on_line(&v, &mut stdin);
            events.push(v);
        }
    }
    let status = child.wait().unwrap();
    (status.code(), events)
}

/// `(type, id)` of each message event, in stream order.
fn message_events(events: &[serde_json::Value]) -> Vec<(String, String)> {
    events
        .iter()
        .filter(|v| {
            v["type"]
                .as_str()
                .is_some_and(|t| t.starts_with("message."))
        })
        .map(|v| {
            (
                v["type"].as_str().unwrap().to_string(),
                v["id"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect()
}

fn pair(kind: &str, id: &str) -> (String, String) {
    (kind.to_string(), id.to_string())
}

#[test]
fn say_outcomes_for_a_program() {
    use std::io::Write;

    // A new id is accepted and read; a repeated id is refused; blank text is ignored.
    let mut said = false;
    let (code, events) = run_steer_cli(&[("KATA_FAKE_STEP_MS", "1000")], false, |v, stdin| {
        if !said && v["type"] == "assistant.text" {
            said = true;
            let _ = stdin
                .write_all(b"say m1 \"first\"\nsay m1 \"again\"\nsay m3 \"  \"\nsay m4 \"last\"\n");
            let _ = stdin.flush();
        }
    });
    assert_eq!(code, Some(0));
    let all = message_events(&events);
    let early: Vec<_> = all.iter().take(3).cloned().collect();
    assert_eq!(
        early,
        [
            pair("message.sent", "m1"),
            pair("message.refused", "m1"),
            pair("message.sent", "m4")
        ],
        "{all:?}"
    );
    let rest: Vec<_> = all.iter().skip(3).cloned().collect();
    assert_eq!(
        rest,
        [pair("message.read", "m1"), pair("message.read", "m4")],
        "{all:?}"
    );
    let refused = events
        .iter()
        .find(|v| v["type"] == "message.refused")
        .unwrap();
    assert_eq!(refused["reason"], "repeated");
    assert_eq!(refused["text"], "again");
    assert!(
        !all.iter().any(|(_, id)| id == "m3"),
        "a blank message is not announced: {all:?}"
    );

    // During a question the message is refused; the answer follows the refusal.
    let (code, events) = run_steer_cli(&[("KATA_FAKE_ASK_AT", "1")], true, |v, stdin| {
        if v["type"] == "ask.requested" {
            let _ = stdin.write_all(b"say m1 \"hold on\"\n");
            let _ = stdin.flush();
        }
        if v["type"] == "message.refused" {
            let _ = stdin.write_all(b"answer q1 [[\"ok\"]]\n");
            let _ = stdin.flush();
        }
    });
    assert_eq!(code, Some(0));
    assert_eq!(
        message_events(&events),
        [pair("message.refused", "m1")],
        "{events:?}"
    );
    let refused = events
        .iter()
        .find(|v| v["type"] == "message.refused")
        .unwrap();
    assert_eq!(refused["reason"], "waiting-on-operator");
    assert_eq!(refused["text"], "hold on");

    // After the run has begun to end the message is refused. The fake prints one more
    // line after its result, which arrives after the engine closed Claude's input.
    let (code, events) = run_steer_cli(
        &[
            ("KATA_FAKE_LATE_TEXT", "late"),
            ("KATA_FAKE_LATE_MS", "1000"),
        ],
        false,
        |v, stdin| {
            if v["type"] == "assistant.text" && v["text"] == "late" {
                let _ = stdin.write_all(b"say m9 \"too late\"\n");
                let _ = stdin.flush();
            }
        },
    );
    assert_eq!(code, Some(0));
    assert_eq!(message_events(&events), [pair("message.refused", "m9")]);
    let refused = events
        .iter()
        .find(|v| v["type"] == "message.refused")
        .unwrap();
    assert_eq!(refused["reason"], "run-ending");
}

#[test]
fn say_same_text_under_two_ids_is_two_messages() {
    use std::io::Write;

    let mut said = false;
    let (code, events) = run_steer_cli(&[("KATA_FAKE_STEP_MS", "1000")], false, |v, stdin| {
        if !said && v["type"] == "assistant.text" {
            said = true;
            let _ = stdin.write_all(b"say a \"rerun the tests\"\nsay b \"rerun the tests\"\n");
            let _ = stdin.flush();
        }
    });
    assert_eq!(code, Some(0));
    assert_eq!(
        message_events(&events),
        [
            pair("message.sent", "a"),
            pair("message.sent", "b"),
            pair("message.read", "a"),
            pair("message.read", "b"),
        ]
    );
}
