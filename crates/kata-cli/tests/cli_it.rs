use std::process::Command;

fn kata() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kata"))
}

fn write(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    p
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
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("name"));
    assert!(err.contains("task"));
}
