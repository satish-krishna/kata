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
    let name = if cfg!(windows) { "fake-claude.exe" } else { "fake-claude" };
    dir.join(name)
}

#[test]
fn validate_ok_exits_zero() {
    let tmp = tempfile::tempdir().unwrap();
    let spec = write(tmp.path(), "ok.kata.toml",
        "schema = 1\nname = \"x\"\ntask = \"t\"\nworkdir = \"/w\"\n");
    let out = kata().arg("validate").arg(&spec).output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn validate_bad_exits_nonzero_and_lists_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let spec = write(tmp.path(), "bad.kata.toml",
        "schema = 1\nname = \"\"\ntask = \"\"\nworkdir = \"\"\n");
    let out = kata().arg("validate").arg(&spec).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "validation failure should exit 1");
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
    std::fs::write(skill.join("SKILL.md"),
        "---\nname: triage\ndescription: triage flaky tests\n---\n").unwrap();

    let work = tempfile::tempdir().unwrap();
    let out = kata()
        .arg("catalog")
        .current_dir(work.path())
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .output()
        .unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));

    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let arr = v.as_array().unwrap();
    assert!(arr.iter().any(|e| e["name"] == "triage" && e["kind"] == "skill"));
}

#[test]
fn run_streams_jsonl_events_and_exits_zero() {
    let work = tempfile::tempdir().unwrap();
    let spec = write(work.path(), "r.kata.toml",
        &format!("schema = 1\nname = \"r\"\ntask = \"t\"\nworkdir = \"{}\"\n",
            work.path().to_string_lossy().replace('\\', "/")));

    let fake = fake_claude();
    let out = kata()
        .arg("run").arg(&spec)
        .env("KATA_CLAUDE_BIN", &fake)
        .env("KATA_FAKE_MODE", "ok")
        .output()
        .unwrap();

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8(out.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    let first: serde_json::Value = serde_json::from_str(lines.first().unwrap()).unwrap();
    let last: serde_json::Value = serde_json::from_str(lines.last().unwrap()).unwrap();
    assert_eq!(first["type"], "run.started");
    assert_eq!(last["type"], "run.completed");
    assert_eq!(last["exit_code"], 0);
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
        .arg("run").arg(&spec)
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
    assert!(stdout.lines().any(|l| {
        serde_json::from_str::<serde_json::Value>(l)
            .map(|v| v["type"] == "run.cancelled").unwrap_or(false)
    }), "expected a run.cancelled event, got:\n{stdout}");
}

#[test]
fn bundle_writes_self_contained_folder() {
    // Isolated HOME so discovery is deterministic.
    let home = tempfile::tempdir().unwrap();
    let skill = home.path().join(".claude").join("skills").join("triage");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"),
        "---\nname: triage\ndescription: triage flaky tests\n---\nbody\n").unwrap();

    let work = tempfile::tempdir().unwrap();
    let spec = write(work.path(), "b.kata.toml",
        &format!("schema = 1\nname = \"b\"\ntask = \"t\"\nworkdir = \"{}\"\nskills = [\"triage\"]\n",
            work.path().to_string_lossy().replace('\\', "/")));

    let out = work.path().join("b-bundle");
    let result = kata()
        .arg("bundle").arg(&spec)
        .arg("-o").arg(&out)
        .current_dir(work.path())
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .output()
        .unwrap();

    assert!(result.status.success(), "stderr: {}", String::from_utf8_lossy(&result.stderr));
    assert!(out.join(".claude").join("skills").join("triage").join("SKILL.md").is_file());
    assert!(out.join("spec.toml").is_file());
    assert!(out.join("kata-bundle.toml").is_file());
}
