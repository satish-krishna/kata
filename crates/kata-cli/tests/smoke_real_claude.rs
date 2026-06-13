//! Opt-in: only runs when KATA_SMOKE_REAL=1 and a real `claude` is on PATH.
//! Catches drift between our flag set and the actual CLI. Costs tokens.
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
    let last = stdout.lines().filter(|l| !l.trim().is_empty()).last().unwrap();
    let v: serde_json::Value = serde_json::from_str(last).unwrap();
    assert_eq!(v["type"], "run.completed", "last event should be run.completed; stderr: {}", String::from_utf8_lossy(&out.stderr));
}
