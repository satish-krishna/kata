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
