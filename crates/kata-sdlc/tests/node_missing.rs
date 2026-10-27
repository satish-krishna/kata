//! R2.5: with Node.js missing from `PATH`, every change whose stage needs the format program says so,
//! the rest show their stage, and the program is tried once. `PATH` is changed for the whole process, so
//! this lives in a test binary of its own. The fixtures are built with the git CLI by absolute path, and
//! test code may use it, so the lint is off for this file.
#![allow(clippy::disallowed_methods)]

use kata_sdlc::changes::{self, ReadContext, Stage, StageEvent};
use serial_test::serial;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The first match of `program` on the real `PATH`, found before the test changes it.
fn find_program(program: &str) -> PathBuf {
    let finder = if cfg!(windows) { "where" } else { "which" };
    let out = Command::new(finder).arg(program).output().unwrap();
    assert!(out.status.success(), "{program} is not on PATH");
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    PathBuf::from(text.lines().next().unwrap().trim())
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Sets environment variables for a test and puts them back.
struct Env(Vec<(&'static str, Option<OsString>)>);

impl Env {
    fn set(&mut self, key: &'static str, value: &Path) {
        self.0.push((key, std::env::var_os(key)));
        std::env::set_var(key, value);
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        for (key, old) in self.0.drain(..).rev() {
            match old {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn git(program: &Path, repo: &Path, args: &[&str]) -> String {
    let out = Command::new(program)
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
#[serial]
fn node_missing_is_reported_on_every_change_that_needs_it() {
    let dir = tempfile::tempdir().unwrap();
    let git_program = find_program("git");
    let plugin = dir.path().join("plugin");
    copy_dir(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-format"),
        &plugin.join("format"),
    );
    fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
    fs::write(
        plugin.join(".claude-plugin/plugin.json"),
        format!(
            r#"{{"name":"ai-sdlc","version":"{}"}}"#,
            kata_sdlc::plugin::LIGHT_TRACK_VERSION
        ),
    )
    .unwrap();

    let repo = dir.path().join("master");
    fs::create_dir_all(&repo).unwrap();
    let run = |args: &[&str]| git(&git_program, &repo, args);
    run(&["init", "-q", "-b", "main"]);
    run(&["config", "user.name", "Test"]);
    run(&["config", "user.email", "test@example.com"]);
    run(&["config", "commit.gpgsign", "false"]);
    let write = |rel: &str, text: &str| {
        let file = repo.join(rel);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    };
    let commit_all = |message: &str| {
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", message]);
        run(&["rev-parse", "HEAD"])
    };
    // A plan nobody has read before in this process or on this disk, so no cache answers for it.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let plans: Vec<String> = (1..=6)
        .map(|n| format!("2026-10-{n:02}-plan-{n}"))
        .collect();
    for name in &plans {
        write(
            &format!("intent/claims/{name}/intent.md"),
            "---\nstatus: accepted\n---\nintent\n",
        );
    }
    let intent_pin = commit_all("intents");
    for name in &plans {
        write(
            &format!("intent/claims/{name}/spec.md"),
            &format!("---\nstatus: accepted\nsource_intent_commit: {intent_pin}\n---\nspec\n"),
        );
    }
    let spec_pin = commit_all("specs");
    for (n, name) in plans.iter().enumerate() {
        write(
            &format!("intent/claims/{name}/plan.md"),
            &format!(
                "---\nstatus: accepted\nsource_spec_commit: {spec_pin}\n---\n\n# Plan: never read {n} {nonce}\n\n## Tasks\n\n### T1: One (`app`)\n\n- **Depends on:** none\n"
            ),
        );
    }
    let fix = "2026-10-23-fix-it";
    write(
        &format!("intent/claims/{fix}/intent.md"),
        "---\nstatus: draft\ntrack: fix\n---\nintent\n",
    );
    write(
        &format!("intent/claims/{fix}/spec.md"),
        "---\nstatus: draft\nsource_intent_commit: pending acceptance\n---\nspec\n",
    );
    write(
        &format!("intent/claims/{fix}/plan.md"),
        &format!(
            "---\nstatus: draft\nsource_spec_commit: pending acceptance\n---\n\n# Plan: fix {nonce}\n\n## Tasks\n\n### T1: One (`app`)\n\n- **Depends on:** none\n"
        ),
    );
    let only = "2026-10-24-only-intent";
    write(
        &format!("intent/claims/{only}/intent.md"),
        "---\nstatus: draft\n---\nintent\n",
    );
    commit_all("plans, a fix and a bare intent");

    let nowhere = dir.path().join("no-programs-here");
    fs::create_dir_all(&nowhere).unwrap();
    let mut env = Env(Vec::new());
    env.set("PATH", &nowhere);
    env.set("KATA_HOME", &dir.path().join("kata-home"));
    let order: Vec<String> = changes::names(&repo, "claims")
        .into_iter()
        .map(|n| n.change)
        .collect();
    assert_eq!(order.len(), 8);
    let ctx = ReadContext::new(Some(&plugin), &repo);
    let mut events = Vec::new();
    changes::read_stages(&ctx, "claims", &order, 1, &|| false, &mut |e| {
        events.push(e)
    });
    let started = ctx.programs_started();
    drop(env);

    let info_of = |change: &str| {
        events
            .iter()
            .find_map(|e| match e {
                StageEvent::Stage {
                    change: c, info, ..
                } if c == change => Some(info.clone()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no stage for {change}"))
    };
    for name in &plans {
        let info = info_of(name);
        assert!(info.plan_unreadable, "{name}");
        assert_eq!(info.stage, Stage::PlanUnreadable, "{name}");
        let why = info.plan_unreadable_reason.unwrap_or_default();
        assert!(why.contains("Node.js"), "{name}: {why:?}");
    }
    let info = info_of(fix);
    assert_eq!(info.stage, Stage::FixUnsettled);
    let why = info.plan_unreadable_reason.unwrap_or_default();
    assert!(why.contains("Node.js"), "{why:?}");
    let info = info_of(only);
    assert_eq!(info.stage, Stage::IntentAwaiting);
    assert!(!info.plan_unreadable);
    assert!(matches!(events.last(), Some(StageEvent::Done { pass: 1 })));
    assert_eq!(started, 1, "the program is tried once");
}
