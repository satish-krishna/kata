//! Opt-in: only runs when KATA_SMOKE_REAL=1 and a real, AUTHENTICATED `claude`
//! is on PATH (run `claude` once interactively to log in first). Catches drift
//! between our flag set and the actual CLI by driving a trivial task to a
//! genuinely successful completion. Costs tokens.
use std::process::Command;

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
        .arg("run").arg(&spec_path)
        // KATA_CLAUDE_BIN unset -> uses the real `claude` on PATH.
        .output()
        .unwrap();

    let stdout = String::from_utf8_lossy(&out.stdout);
    let last = stdout.lines().rfind(|l| !l.trim().is_empty()).unwrap();
    let v: serde_json::Value = serde_json::from_str(last).unwrap();
    assert_eq!(v["type"], "run.completed", "last event should be run.completed; stderr: {}", String::from_utf8_lossy(&out.stderr));
    // A genuine success: the run must not be an error and must exit 0. A rejected
    // flag or an unauthenticated claude still emits run.completed, so without
    // these assertions the test would pass on a broken run.
    assert_eq!(v["is_error"], false, "run.completed was an error (is claude logged in? did a flag change?); result: {}", v["result"]);
    assert_eq!(v["exit_code"], 0, "expected exit 0; result: {}", v["result"]);
}
