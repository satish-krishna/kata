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
