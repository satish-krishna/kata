//! Opt-in proofs of the switch-off mechanisms the run-setup preview relies on (plan T1).
//!
//! Each proof spawns a real, authenticated `claude -p` directly (not through Kata) in a
//! temporary project folder and inspects the `stream-json` output. They run only when
//! `KATA_SMOKE_REAL=1` and cost tokens (a `haiku` run of one short reply each).
//!
//! They are characterization tests: nothing in Kata changes, so each one either passes
//! on first run or documents a mechanism that does not hold, asserting the observed
//! (non-holding) behavior. `docs/switch-proofs.md` records the outcome per mechanism.
//!
//! The real home (`~/.claude`) is only ever read. A temporary `CLAUDE_CONFIG_DIR` breaks
//! authentication on the machines this was written on, so personal-scope behavior is
//! proven by dropping the `user` source and by the project/local scopes, which use the
//! same mechanism. Set `KATA_BLESS_FIXTURES=1` to rewrite the two fixtures from a run.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn build_proof_enabled() -> bool {
    if std::env::var("KATA_SMOKE_REAL").as_deref() != Ok("1") {
        eprintln!("skipping switch proof (set KATA_SMOKE_REAL=1 to enable)");
        return false;
    }
    true
}

const PROMPT: &str = "Reply with the single word ok.";
const NONCE_CLAUDE_MD: &str = "NONCE-PROJ-7731";
const NONCE_RULE: &str = "NONCE-RULE-4410";

/// One `claude -p` run: every stream-json line, the `system`/`init` line, the final text.
struct Out {
    events: Vec<Value>,
    init: Value,
    result: String,
}

impl Out {
    fn names(&self, key: &str, field: &str) -> Vec<String> {
        self.init[key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| {
                        if field.is_empty() {
                            x.as_str().map(str::to_string)
                        } else {
                            x[field].as_str().map(str::to_string)
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    fn mcp(&self) -> Vec<String> {
        self.names("mcp_servers", "name")
    }
    fn plugin_sources(&self) -> Vec<String> {
        self.names("plugins", "source")
    }
    fn skills(&self) -> Vec<String> {
        self.names("skills", "")
    }
    fn model(&self) -> String {
        self.init["model"].as_str().unwrap_or("").to_string()
    }
    fn output_style(&self) -> String {
        self.init["output_style"].as_str().unwrap_or("").to_string()
    }
    fn hook_started(&self) -> Vec<&Value> {
        self.events
            .iter()
            .filter(|e| e["type"] == "system" && e["subtype"] == "hook_started")
            .collect()
    }
}

fn fwd(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Spawns claude in `dir`. `model` is passed as `--model` unless `None`.
fn claude(dir: &Path, model: Option<&str>, prompt: &str, max_turns: u32, extra: &[&str]) -> Out {
    claude_env(dir, model, prompt, max_turns, extra, &[])
}

/// Like [`claude`], with extra environment variables for the child.
fn claude_env(
    dir: &Path,
    model: Option<&str>,
    prompt: &str,
    max_turns: u32,
    extra: &[&str],
    env: &[(&str, &str)],
) -> Out {
    for entry in std::fs::read_dir(dir).unwrap() {
        let p = entry.unwrap().path();
        if p.extension().and_then(|e| e.to_str()) == Some("marker") {
            std::fs::remove_file(p).unwrap();
        }
    }
    let mut cmd = Command::new("claude");
    cmd.args(["-p", prompt]);
    if let Some(m) = model {
        cmd.args(["--model", m]);
    }
    cmd.args(["--max-turns", &max_turns.to_string()])
        .args(["--output-format", "stream-json", "--verbose"])
        .arg("--include-hook-events")
        .arg("--dangerously-skip-permissions")
        .args(["--disallowedTools", "AskUserQuestion"])
        .args(extra)
        .current_dir(dir)
        .stdin(Stdio::null());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("spawning claude failed");
    let events: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let init = events
        .iter()
        .find(|e| e["type"] == "system" && e["subtype"] == "init")
        .unwrap_or_else(|| {
            panic!(
                "no system/init line; stderr: {}",
                String::from_utf8_lossy(&out.stderr)
            )
        })
        .clone();
    let result = events
        .iter()
        .find(|e| e["type"] == "result")
        .and_then(|e| e["result"].as_str())
        .unwrap_or("")
        .to_string();
    Out {
        events,
        init,
        result,
    }
}

fn markers(dir: &Path) -> (bool, bool, bool, bool) {
    let has = |n: &str| dir.join(n).exists();
    (
        has("hookA.marker"),
        has("hookB.marker"),
        has("hookC.marker"),
        has("hookD.marker"),
    )
}

/// Builds the `kata` binary and returns its path (the `mcp-ask` tool server under test).
fn kata_bin() -> PathBuf {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let st = Command::new(cargo)
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
    kata
}

/// A project with two hooks in project settings (A, B), two in local settings (C, D),
/// a `CLAUDE.md` and a rules file that each carry a nonce, a project skill, and two
/// tool servers in `.mcp.json` (both `kata mcp-ask`).
fn make_project(kata: &Path) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    std::fs::create_dir_all(p.join(".claude/skills/projskill")).unwrap();
    std::fs::create_dir_all(p.join(".claude/rules")).unwrap();
    std::fs::write(
        p.join(".claude/settings.json"),
        json!({
            "model": "haiku",
            "outputStyle": "Explanatory",
            "hooks": {"UserPromptSubmit": [hook_cmd("hookA"), hook_cmd("hookB")]}
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        p.join(".claude/settings.local.json"),
        json!({"hooks": {"UserPromptSubmit": [hook_cmd("hookC"), hook_cmd("hookD")]}}).to_string(),
    )
    .unwrap();
    std::fs::write(
        p.join("CLAUDE.md"),
        format!("Always end your reply with the exact token {NONCE_CLAUDE_MD}.\n"),
    )
    .unwrap();
    std::fs::write(
        p.join(".claude/rules/r.md"),
        format!("Always end your reply with the exact token {NONCE_RULE}.\n"),
    )
    .unwrap();
    std::fs::write(
        p.join(".claude/skills/projskill/SKILL.md"),
        "---\nname: projskill\ndescription: A probe skill that does nothing.\n---\nSay PROJSKILL.\n",
    )
    .unwrap();
    let srv = json!({"command": fwd(kata), "args": ["mcp-ask"]});
    std::fs::write(
        p.join(".mcp.json"),
        json!({"mcpServers": {"srv-a": srv, "srv-b": srv}}).to_string(),
    )
    .unwrap();
    dir
}

/// Writes a per-run file outside the project and returns its forward-slash path.
fn write_json(dir: &Path, name: &str, body: &Value) -> String {
    let p = dir.join(name);
    std::fs::write(&p, body.to_string()).unwrap();
    fwd(&p)
}

fn hook_cmd(m: &str) -> Value {
    json!({"hooks": [{"type": "command", "command": format!("echo x > {m}.marker")}]})
}

fn claude_version() -> String {
    let out = Command::new("claude").arg("--version").output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

// ---------------------------------------------------------------------------
// Fixture scrubbing
// ---------------------------------------------------------------------------

fn scrub(v: &mut Value, subs: &[(String, String)]) {
    match v {
        Value::String(s) => {
            for (a, b) in subs {
                *s = s.replace(a.as_str(), b);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| scrub(x, subs)),
        Value::Object(m) => {
            for (k, x) in m.iter_mut() {
                match k.as_str() {
                    "session_id" => *x = json!("<session-id>"),
                    "uuid" => *x = json!("<uuid>"),
                    "hook_id" => *x = json!("<hook-id>"),
                    "messaging_socket_path" => *x = json!("<socket-path>"),
                    "powershell_path" => *x = json!("<powershell-path>"),
                    "memory_paths" if !x.is_null() => *x = json!({"auto": "<memory-path>"}),
                    "path" if x.as_str().is_some_and(|s| s != "builtin") => {
                        *x = json!("<plugin-path>")
                    }
                    _ => scrub(x, subs),
                }
            }
        }
        _ => {}
    }
}

fn machine_subs(project: &Path) -> Vec<(String, String)> {
    let mut subs = Vec::new();
    let mut push = |p: &str, to: &str| {
        subs.push((p.to_string(), to.to_string()));
        subs.push((p.replace('\\', "/"), to.to_string()));
    };
    let proj = project.to_string_lossy().to_string();
    push(&proj, "<cwd>");
    push(&std::env::temp_dir().to_string_lossy(), "<tmp>");
    if let Ok(h) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        push(&h, "<home>");
    }
    subs
}

/// Fails if the text still holds a drive path, `Users`, or the account name.
fn assert_no_machine_paths(text: &str) {
    assert!(!text.contains("Users"), "fixture holds 'Users'");
    if let Ok(u) = std::env::var("USERNAME") {
        assert!(
            !text.to_lowercase().contains(&u.to_lowercase()),
            "fixture holds the account name"
        );
    }
    let b = text.as_bytes();
    for i in 0..b.len().saturating_sub(3) {
        let drive = b[i].is_ascii_alphabetic()
            && b[i + 1] == b':'
            && (b[i + 2] == b'\\' || (b[i + 2] == b'/' && b[i + 3] != b'/'))
            && (i == 0 || !b[i - 1].is_ascii_alphanumeric());
        assert!(!drive, "fixture holds a drive path near byte {i}");
    }
}

fn bless_fixtures(base: &Out, hooks: &Out, project: &Path) {
    if std::env::var("KATA_BLESS_FIXTURES").as_deref() != Ok("1") {
        return;
    }
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let subs = machine_subs(project);

    let mut init = base.init.clone();
    scrub(&mut init, &subs);
    let init_text = serde_json::to_string_pretty(&init).unwrap() + "\n";
    assert_no_machine_paths(&init_text);
    std::fs::write(fixtures.join("claude-init.json"), init_text).unwrap();

    let mut lines = String::new();
    for e in hooks.events.iter().filter(|e| {
        e["type"] == "system"
            && matches!(
                e["subtype"].as_str(),
                Some("hook_started" | "hook_progress" | "hook_response")
            )
    }) {
        let mut e = e.clone();
        scrub(&mut e, &subs);
        lines.push_str(&e.to_string());
        lines.push('\n');
    }
    assert!(!lines.is_empty(), "no hook lifecycle lines to capture");
    assert_no_machine_paths(&lines);
    std::fs::write(fixtures.join("claude-hook-events.jsonl"), lines).unwrap();
    eprintln!("blessed the two fixtures");
}

// ---------------------------------------------------------------------------
// The proofs
// ---------------------------------------------------------------------------

/// Hooks (personal, project, local): drop the source from `--setting-sources` and pass
/// the source's other content in `--settings`.
#[test]
fn proof_hook_source_reroute() {
    if !build_proof_enabled() {
        return;
    }
    eprintln!("claude version: {}", claude_version());
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();

    // Baseline: every source loaded, every hook fires.
    let base = claude(dir, Some("haiku"), PROMPT, 2, &[]);
    assert_eq!(markers(dir), (true, true, true, true), "baseline hooks");
    assert!(
        !base.hook_started().is_empty(),
        "--include-hook-events produced no hook_started lines"
    );
    let base_hooks = base.hook_started().len();
    eprintln!(
        "baseline: {base_hooks} hook_started lines, nonces in reply: claude_md={} rule={}",
        base.result.contains(NONCE_CLAUDE_MD),
        base.result.contains(NONCE_RULE)
    );

    // Project source: A off, B kept.
    let rr = write_json(
        tmp.path(),
        "project.json",
        &json!({
            "model": "haiku",
            "outputStyle": "Explanatory",
            "hooks": {"UserPromptSubmit": [hook_cmd("hookB")]}
        }),
    );
    let proj_off = claude(
        dir,
        Some("haiku"),
        PROMPT,
        2,
        &["--setting-sources", "user,local", "--settings", &rr],
    );
    let m = markers(dir);
    eprintln!("project source dropped: markers (A,B,C,D) = {m:?}");
    assert_eq!(m, (false, true, true, true), "A off, B kept, local kept");
    assert_eq!(
        proj_off.output_style(),
        "Explanatory",
        "other project content re-routed"
    );
    // Secondary: what else leaves with the project source.
    let skill_gone = !proj_off.skills().iter().any(|s| s == "projskill");
    let mcp_gone = !proj_off.mcp().iter().any(|s| s == "srv-a");
    eprintln!(
        "project source dropped also drops: skill={skill_gone} tool servers (.mcp.json)={mcp_gone} \
         CLAUDE.md (nonce absent from reply)={} rules file (nonce absent)={}",
        !proj_off.result.contains(NONCE_CLAUDE_MD),
        !proj_off.result.contains(NONCE_RULE)
    );
    assert!(skill_gone, "project skill stayed after dropping project");
    assert!(mcp_gone, ".mcp.json servers stayed after dropping project");
    assert!(!proj_off.result.contains(NONCE_CLAUDE_MD));
    assert!(!proj_off.result.contains(NONCE_RULE));

    // Local source: C off, D kept.
    let rl = write_json(
        tmp.path(),
        "local.json",
        &json!({"hooks": {"UserPromptSubmit": [hook_cmd("hookD")]}}),
    );
    let _ = claude(
        dir,
        Some("haiku"),
        PROMPT,
        2,
        &["--setting-sources", "user,project", "--settings", &rl],
    );
    let m = markers(dir);
    eprintln!("local source dropped: markers (A,B,C,D) = {m:?}");
    assert_eq!(m, (true, true, false, true), "C off, D kept, project kept");

    // Personal source: drop `user`. Personal hooks stop; only the four project/local
    // hooks remain. (The machine's own personal hooks are the thing being switched off.)
    let user_off = claude(
        dir,
        Some("haiku"),
        PROMPT,
        2,
        &["--setting-sources", "project,local"],
    );
    let kept = user_off.hook_started();
    eprintln!(
        "user source dropped: hook_started {base_hooks} -> {}; plugins loaded: {:?}",
        kept.len(),
        user_off
            .plugin_sources()
            .into_iter()
            .filter(|s| !s.ends_with("@builtin"))
            .collect::<Vec<_>>()
    );
    assert_eq!(kept.len(), 4, "only the four project/local hooks remain");
    assert!(kept.iter().all(|e| e["hook_event"] == "UserPromptSubmit"));
    if base_hooks == 4 {
        eprintln!(
            "NOTE: this machine has no personal hooks, so the user-source drop was not exercised"
        );
    }
    eprintln!(
        "user source dropped also drops: all non-builtin plugins={} (plugins now listed: {}), \
         project tool servers kept={}, project skill kept={}",
        !user_off
            .plugin_sources()
            .iter()
            .any(|s| !s.ends_with("@builtin")),
        user_off.plugin_sources().len(),
        user_off.mcp().iter().any(|s| s == "srv-a"),
        user_off.skills().iter().any(|s| s == "projskill")
    );

    bless_fixtures(&base, &user_off, dir);
}

/// Plugins (installed): `enabledPlugins: { "<name>@<marketplace>": false }`.
#[test]
fn proof_plugin_enabled_false() {
    if !build_proof_enabled() {
        return;
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let installed = Path::new(&home).join(".claude/plugins/installed_plugins.json");
    let Ok(text) = std::fs::read_to_string(&installed) else {
        eprintln!("SKIP: no installed_plugins.json at {}", installed.display());
        return;
    };
    let v: Value = serde_json::from_str(&text).unwrap();
    let plugins = v["plugins"].as_object().cloned().unwrap_or_default();
    let user_scope: Vec<String> = plugins
        .iter()
        .filter(|(_, e)| {
            e.as_array()
                .is_some_and(|a| a.iter().any(|x| x["scope"] == "user"))
        })
        .map(|(k, _)| k.clone())
        .collect();
    let project_scope = plugins
        .iter()
        .filter(|(_, e)| {
            e.as_array()
                .is_some_and(|a| a.iter().any(|x| x["scope"] == "project"))
        })
        .count();
    eprintln!(
        "installed plugins: {} user-scope, {project_scope} project-scope (project-scope installs are \
         bound to a projectPath and cannot be exercised from a temporary folder)",
        user_scope.len()
    );
    if user_scope.is_empty() {
        eprintln!("SKIP: installed_plugins.json has no user-scope plugin on this machine");
        return;
    }
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();

    let base = claude(dir, Some("haiku"), PROMPT, 2, &[]);
    let sources = base.plugin_sources();
    let Some(key) = user_scope.iter().find(|k| sources.contains(k)) else {
        eprintln!("SKIP: no installed user-scope plugin is enabled on this machine");
        return;
    };
    let name = key.split('@').next().unwrap().to_string();
    let prefix = format!("{name}:");
    let base_skills = base
        .skills()
        .iter()
        .filter(|s| s.starts_with(&prefix))
        .count();
    let f = write_json(
        tmp.path(),
        "plugin.json",
        &json!({"enabledPlugins": {key.as_str(): false}}),
    );
    let off = claude(dir, Some("haiku"), PROMPT, 2, &["--settings", &f]);
    let off_skills = off
        .skills()
        .iter()
        .filter(|s| s.starts_with(&prefix))
        .count();
    eprintln!(
        "plugin {key}: in report before={} after={}; its skills before={base_skills} after={off_skills}; \
         plugins {} -> {}",
        sources.contains(key),
        off.plugin_sources().contains(key),
        sources.len(),
        off.plugin_sources().len()
    );
    assert!(!off.plugin_sources().contains(key), "plugin still reported");
    assert_eq!(off_skills, 0, "the plugin's skills still reported");
}

/// Standing instructions (any CLAUDE.md or rules file): `claudeMdExcludes`.
#[test]
fn proof_claude_md_excludes() {
    if !build_proof_enabled() {
        return;
    }
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();

    let base = claude(dir, Some("haiku"), PROMPT, 2, &[]);
    assert!(
        base.result.contains(NONCE_CLAUDE_MD) && base.result.contains(NONCE_RULE),
        "the proof is vacuous unless the baseline reply carries both nonces: {:?}",
        base.result
    );
    let f = write_json(
        tmp.path(),
        "excludes.json",
        &json!({"claudeMdExcludes": [
            fwd(&dir.join("CLAUDE.md")),
            fwd(&dir.join(".claude/rules/r.md")),
        ]}),
    );
    let off = claude(dir, Some("haiku"), PROMPT, 2, &["--settings", &f]);
    eprintln!("claudeMdExcludes: reply after = {:?}", off.result);
    assert!(
        !off.result.contains(NONCE_CLAUDE_MD),
        "CLAUDE.md still loaded"
    );
    assert!(!off.result.contains(NONCE_RULE), "rules file still loaded");
}

/// Standing instructions (output style): `outputStyle: "default"`.
#[test]
fn proof_output_style_default() {
    if !build_proof_enabled() {
        return;
    }
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();

    let base = claude(dir, Some("haiku"), PROMPT, 2, &[]);
    assert_eq!(base.output_style(), "Explanatory");
    let f = write_json(tmp.path(), "style.json", &json!({"outputStyle": "default"}));
    let off = claude(dir, Some("haiku"), PROMPT, 2, &["--settings", &f]);
    eprintln!(
        "outputStyle: {} -> {}",
        base.output_style(),
        off.output_style()
    );
    assert_eq!(off.output_style(), "default");
}

/// Tool servers: `--strict-mcp-config --mcp-config <file>` holding only the kept servers.
#[test]
fn proof_strict_mcp_config() {
    if !build_proof_enabled() {
        return;
    }
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();

    let base = claude(dir, Some("haiku"), PROMPT, 2, &[]);
    let base_mcp = base.mcp();
    assert!(base_mcp.iter().any(|s| s == "srv-a") && base_mcp.iter().any(|s| s == "srv-b"));
    let srv = json!({"command": fwd(&kata), "args": ["mcp-ask"]});
    let f = write_json(
        tmp.path(),
        "mcp.json",
        &json!({"mcpServers": {"srv-a": srv}}),
    );
    let off = claude(
        dir,
        Some("haiku"),
        PROMPT,
        2,
        &["--strict-mcp-config", "--mcp-config", &f],
    );
    let mcp = off.mcp();
    let is_ours = |s: &String| s.starts_with("srv-");
    eprintln!("strict-mcp-config: before {base_mcp:?}\nafter {mcp:?}");
    assert!(mcp.iter().any(|s| s == "srv-a"));
    assert!(
        !mcp.iter().any(|s| s == "srv-b"),
        "dropped server still reported"
    );
    let plugin_before = base_mcp.iter().filter(|s| s.starts_with("plugin:")).count();
    let plugin_after = mcp.iter().filter(|s| s.starts_with("plugin:")).count();
    let cloud_before = base_mcp
        .iter()
        .filter(|s| s.starts_with("claude.ai"))
        .count();
    let cloud_after = mcp.iter().filter(|s| s.starts_with("claude.ai")).count();
    eprintln!(
        "plugin tool servers before={plugin_before} after={plugin_after}; claude.ai connectors \
         before={cloud_before} after={cloud_after}; kept={}",
        mcp.iter().filter(|s| is_ours(s)).count()
    );
    let status = off.init["mcp_servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == "srv-a")
        .map(|m| m["status"].clone());
    eprintln!("srv-a status: {status:?}");
    assert_eq!(status, Some(json!("connected")));
}

/// Skills (on disk): a `Skill(<name>)` deny rule. Records whether the skill leaves the
/// start report or is only refused when invoked.
#[test]
fn proof_skill_deny() {
    if !build_proof_enabled() {
        return;
    }
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();

    let base = claude(dir, Some("haiku"), PROMPT, 2, &[]);
    assert!(base.skills().iter().any(|s| s == "projskill"));
    let f = write_json(
        tmp.path(),
        "skill.json",
        &json!({"permissions": {"deny": ["Skill(projskill)"]}}),
    );
    let off = claude(dir, Some("haiku"), PROMPT, 2, &["--settings", &f]);
    let listed = off.skills().iter().any(|s| s == "projskill");
    eprintln!("Skill(projskill) deny: skill still in start report = {listed}");

    // What happens on invocation.
    let inv = claude(
        dir,
        Some("haiku"),
        "Use the Skill tool to invoke the projskill skill, then reply with the single word done.",
        4,
        &["--settings", &f],
    );
    let denials = inv
        .events
        .iter()
        .find(|e| e["type"] == "result")
        .map(|e| e["permission_denials"].clone())
        .unwrap_or(Value::Null);
    eprintln!(
        "invocation under deny: permission_denials = {denials}; reply = {:?}",
        inv.result
    );

    // Observed on 2.1.308: the skill stays in the report, so a deny rule is not a
    // switch-off (docs/switch-proofs.md: unproven, ships locked). This pins that.
    assert!(
        listed,
        "the skill left the start report: the deny rule now works as a switch-off, update the doc and SWITCHABLE"
    );
}

/// Settings re-routing (area of concern 2): the model is the same with and without the
/// re-routing, and what happens when a kept source also sets it.
#[test]
fn proof_reroute_keeps_model() {
    if !build_proof_enabled() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let dir = proj.path();
    std::fs::create_dir_all(dir.join(".claude")).unwrap();
    std::fs::write(dir.join(".claude/settings.json"), r#"{"model":"haiku"}"#).unwrap();
    let rr = write_json(tmp.path(), "model.json", &json!({"model": "haiku"}));
    let reroute = ["--setting-sources", "user,local", "--settings", rr.as_str()];

    // No --model flag: the model comes from settings alone.
    let base = claude_no_model(dir, &[]);
    let routed = claude_no_model(dir, &reroute);
    eprintln!(
        "model, project sets it: {} vs rerouted {}",
        base.model(),
        routed.model()
    );
    assert_eq!(base.model(), routed.model());

    // A kept source (local) overrides project. Per-run `--settings` outranks local.
    std::fs::write(
        dir.join(".claude/settings.local.json"),
        r#"{"model":"sonnet"}"#,
    )
    .unwrap();
    let base2 = claude_no_model(dir, &[]);
    let routed2 = claude_no_model(dir, &reroute);
    eprintln!(
        "model, project=haiku local=sonnet: {} vs rerouted {}",
        base2.model(),
        routed2.model()
    );
    assert_ne!(
        base2.model(),
        base.model(),
        "local should override project in the baseline"
    );
    // Observed on 2.1.308: the re-routed project value beats the kept local value.
    assert_ne!(
        base2.model(),
        routed2.model(),
        "re-routing now keeps local's precedence: update docs/switch-proofs.md"
    );
}

fn claude_no_model(dir: &Path, extra: &[&str]) -> Out {
    claude(dir, None, "ok", 1, extra)
}

// ---------------------------------------------------------------------------
// Re-supplying what a dropped source takes with it (Claude Code 2.1.309)
//
// Dropping a source from `--setting-sources` switches its hooks off, but takes the rest
// of what the source contributes with it. These proofs try to hand each lost item back
// by another route and record every difference from a normal run's start report.
// ---------------------------------------------------------------------------

const NONCE_IMPORT: &str = "NONCE-IMP-1";
const NONCE_NESTED: &str = "NONCE-SUB-1";
const NONCE_LOCAL: &str = "NONCE-LOCAL-1";
const ADD_DIR_MD: (&str, &str) = ("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", "1");
const NESTED_PROMPT: &str = "Read the file sub/f.txt, then reply with the single word ok.";

impl Out {
    fn entries(&self, key: &str, f: impl Fn(&Value) -> String) -> Vec<String> {
        self.init[key]
            .as_array()
            .map(|a| a.iter().map(f).collect())
            .unwrap_or_default()
    }
    fn list(&self, key: &str) -> Vec<String> {
        self.entries(key, |x| x.as_str().unwrap_or("").to_string())
    }
    fn plugins_full(&self) -> Vec<String> {
        self.entries("plugins", |p| {
            format!(
                "{}@{}",
                p["source"].as_str().unwrap_or(""),
                p["version"].as_str().unwrap_or("-")
            )
        })
    }
    fn mcp_full(&self) -> Vec<String> {
        self.entries("mcp_servers", |m| {
            format!(
                "{}|{}|{}",
                m["name"].as_str().unwrap_or(""),
                m["status"].as_str().unwrap_or(""),
                m["source"].as_str().unwrap_or("")
            )
        })
    }
    /// `(skill argument, result was an error)` of every `Skill` call.
    fn skill_calls(&self) -> Vec<(String, bool)> {
        let mut calls = Vec::new();
        for e in &self.events {
            if e["type"] == "assistant" {
                for c in e["message"]["content"].as_array().into_iter().flatten() {
                    if c["type"] == "tool_use" && c["name"] == "Skill" {
                        calls.push((
                            c["id"].as_str().unwrap_or("").to_string(),
                            c["input"]["skill"].as_str().unwrap_or("").to_string(),
                        ));
                    }
                }
            }
        }
        calls
            .into_iter()
            .map(|(id, skill)| {
                let err = self
                    .events
                    .iter()
                    .filter(|e| e["type"] == "user")
                    .flat_map(|e| e["message"]["content"].as_array().into_iter().flatten())
                    .find(|c| c["type"] == "tool_result" && c["tool_use_id"] == id.as_str())
                    .map(|c| c["is_error"] == true)
                    .unwrap_or(true);
                (skill, err)
            })
            .collect()
    }
}

/// `(missing from other, added in other, order of the shared entries unchanged)`.
fn delta(base: &[String], other: &[String]) -> (Vec<String>, Vec<String>, bool) {
    let missing = base
        .iter()
        .filter(|x| !other.contains(x))
        .cloned()
        .collect();
    let added = other
        .iter()
        .filter(|x| !base.contains(x))
        .cloned()
        .collect();
    let a: Vec<&String> = base.iter().filter(|x| other.contains(x)).collect();
    let b: Vec<&String> = other.iter().filter(|x| base.contains(x)).collect();
    (missing, added, a == b)
}

/// Prints, for every start-report list, what `other` lacks and gains against `base`.
fn report(label: &str, base: &Out, other: &Out) {
    eprintln!("--- {label}: start report against the normal run");
    let lists = [
        ("plugins", base.plugins_full(), other.plugins_full()),
        ("skills", base.skills(), other.skills()),
        ("mcp_servers", base.mcp_full(), other.mcp_full()),
        ("tools", base.list("tools"), other.list("tools")),
        ("agents", base.list("agents"), other.list("agents")),
        (
            "slash_commands",
            base.list("slash_commands"),
            other.list("slash_commands"),
        ),
    ];
    for (key, b, o) in &lists {
        let (missing, added, order_same) = delta(b, o);
        eprintln!(
            "{key}: {} -> {} | missing {missing:?} | added {added:?} | shared order unchanged: {order_same}",
            b.len(),
            o.len()
        );
        if !added.is_empty() {
            let at: Vec<usize> = added
                .iter()
                .filter_map(|a| o.iter().position(|x| x == a))
                .collect();
            eprintln!("  added entries sit at indexes {at:?}");
        }
    }
    for k in ["model", "output_style"] {
        if base.init[k] != other.init[k] {
            eprintln!("{k}: {} -> {}", base.init[k], other.init[k]);
        }
    }
    eprintln!(
        "hook_started: {} -> {}",
        base.hook_started().len(),
        other.hook_started().len()
    );
}

fn seen(out: &Out, tokens: &[&str]) -> String {
    tokens
        .iter()
        .map(|t| format!("{t}={}", out.result.contains(t)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let dest = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &dest);
        } else {
            std::fs::copy(entry.path(), dest).unwrap();
        }
    }
}

/// `make_project` plus an `@import` in `CLAUDE.md`, a nested `sub/CLAUDE.md`, and a `CLAUDE.local.md`.
fn add_extras(dir: &Path) {
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(
        dir.join("CLAUDE.md"),
        format!("Always end your reply with the exact token {NONCE_CLAUDE_MD}.\n@docs/imp.md\n"),
    )
    .unwrap();
    std::fs::write(
        dir.join("docs/imp.md"),
        format!("Always include the exact token {NONCE_IMPORT} on its own line in every reply.\n"),
    )
    .unwrap();
    std::fs::write(
        dir.join("sub/CLAUDE.md"),
        format!("Always include the exact token {NONCE_NESTED} on its own line in every reply.\n"),
    )
    .unwrap();
    std::fs::write(dir.join("sub/f.txt"), "hello\n").unwrap();
    std::fs::write(
        dir.join("CLAUDE.local.md"),
        format!("Always include the exact token {NONCE_LOCAL} on its own line in every reply.\n"),
    )
    .unwrap();
}

/// A plugin folder named `name` holding copies of the given skill folders.
fn make_skill_plugin(root: &Path, name: &str, skills: &[PathBuf]) -> PathBuf {
    let pl = root.join(name);
    std::fs::create_dir_all(pl.join(".claude-plugin")).unwrap();
    std::fs::write(
        pl.join(".claude-plugin/plugin.json"),
        json!({"name": name, "version": "0.0.1", "description": "copies of skills"}).to_string(),
    )
    .unwrap();
    for s in skills {
        copy_dir(s, &pl.join("skills").join(s.file_name().unwrap()));
    }
    pl
}

/// Project source: settings (`--settings`), `.mcp.json` (`--mcp-config`, not strict), project
/// skills (a generated plugin), `CLAUDE.md` and rules (`--add-dir` plus the env switch).
#[test]
fn proof_resupply_project() {
    if !build_proof_enabled() {
        return;
    }
    eprintln!("claude version: {}", claude_version());
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();

    let base = claude(dir, Some("haiku"), PROMPT, 2, &[]);
    assert_eq!(markers(dir), (true, true, true, true));
    assert!(
        base.result.contains(NONCE_CLAUDE_MD) && base.result.contains(NONCE_RULE),
        "baseline reply: {:?}",
        base.result
    );

    let rr = write_json(
        tmp.path(),
        "project.json",
        &json!({
            "model": "haiku",
            "outputStyle": "Explanatory",
            "hooks": {"UserPromptSubmit": [hook_cmd("hookB")]}
        }),
    );
    let srv = json!({"command": fwd(&kata), "args": ["mcp-ask"]});
    let mcp = write_json(
        tmp.path(),
        "mcp.json",
        &json!({"mcpServers": {"srv-a": srv, "srv-b": srv}}),
    );
    let pl = make_skill_plugin(
        tmp.path(),
        "kata-proj",
        &[dir.join(".claude/skills/projskill")],
    );
    let (plf, dirf) = (fwd(&pl), fwd(dir));
    let all = [
        "--setting-sources",
        "user,local",
        "--settings",
        &rr,
        "--mcp-config",
        &mcp,
        "--plugin-dir",
        &plf,
        "--add-dir",
        &dirf,
    ];

    // Everything re-supplied at once.
    let off = claude_env(dir, Some("haiku"), PROMPT, 2, &all, &[ADD_DIR_MD]);
    let m = markers(dir);
    eprintln!("project dropped, all re-supplied: markers (A,B,C,D) = {m:?}");
    report("project dropped, all re-supplied", &base, &off);
    eprintln!(
        "nonces in reply: {}",
        seen(&off, &[NONCE_CLAUDE_MD, NONCE_RULE])
    );
    assert_eq!(m, (false, true, true, true), "A off, B/C/D on");
    assert_eq!(off.output_style(), "Explanatory");
    assert_eq!(off.model(), base.model());
    // Tool servers: .mcp.json servers return, connected; plugin and claude.ai servers stay.
    let count = |o: &Out, p: &str| o.mcp().iter().filter(|s| s.starts_with(p)).count();
    for s in ["srv-a", "srv-b"] {
        assert!(
            off.mcp_full().contains(&format!("{s}|connected|dynamic")),
            "{s} not connected: {:?}",
            off.mcp_full()
        );
    }
    assert_eq!(count(&off, "plugin:"), count(&base, "plugin:"));
    assert_eq!(count(&off, "claude.ai"), count(&base, "claude.ai"));
    // Skill: back, but under the plugin's namespace.
    assert!(off.skills().contains(&"kata-proj:projskill".to_string()));
    assert!(!off.skills().contains(&"projskill".to_string()));
    assert!(off
        .plugin_sources()
        .contains(&"kata-proj@inline".to_string()));
    // CLAUDE.md and the rules file.
    assert!(off.result.contains(NONCE_CLAUDE_MD) && off.result.contains(NONCE_RULE));

    // The env switch is what makes --add-dir carry CLAUDE.md.
    let no_env = claude(dir, Some("haiku"), PROMPT, 2, &all);
    eprintln!(
        "same flags without the env switch: nonces in reply: {}",
        seen(&no_env, &[NONCE_CLAUDE_MD, NONCE_RULE])
    );
    assert!(!no_env.result.contains(NONCE_CLAUDE_MD) && !no_env.result.contains(NONCE_RULE));

    // Can the model still call the skill by its original name?
    let by_name = "Call the Skill tool with the skill argument set to exactly the string \"projskill\" (no prefix), then reply with the single word done.";
    let called = claude_env(dir, Some("haiku"), by_name, 4, &all, &[ADD_DIR_MD]);
    eprintln!(
        "Skill(\"projskill\") on the re-supplied run: calls (argument, is_error) = {:?}; reply = {:?}",
        called.skill_calls(),
        called.result
    );
    assert!(
        called
            .skill_calls()
            .iter()
            .any(|(s, err)| s == "projskill" && !err),
        "the original name no longer resolves"
    );
    // A user typing the slash command (recorded, not asserted).
    let slash_base = claude(dir, Some("haiku"), "/projskill", 3, &[]);
    let slash_off = claude_env(dir, Some("haiku"), "/projskill", 3, &all, &[ADD_DIR_MD]);
    let slash_ns = claude_env(
        dir,
        Some("haiku"),
        "/kata-proj:projskill",
        3,
        &all,
        &[ADD_DIR_MD],
    );
    eprintln!(
        "slash command, normal run `/projskill`: {:?}\nre-supplied `/projskill`: {:?}\nre-supplied `/kata-proj:projskill`: {:?}",
        slash_base.result, slash_off.result, slash_ns.result
    );
}

/// `CLAUDE.md` and rules, mechanism by mechanism, with the semantic differences visible:
/// `@import`, nested subfolder `CLAUDE.md`, rules.
#[test]
fn proof_resupply_claude_md() {
    if !build_proof_enabled() {
        return;
    }
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    add_extras(dir);
    let tmp = tempfile::tempdir().unwrap();
    let tokens = [NONCE_CLAUDE_MD, NONCE_RULE, NONCE_IMPORT, NONCE_NESTED];

    let base = claude(dir, Some("haiku"), NESTED_PROMPT, 4, &[]);
    eprintln!("normal run: {}", seen(&base, &tokens));
    for t in tokens {
        assert!(
            base.result.contains(t),
            "baseline lacks {t}: {:?}",
            base.result
        );
    }
    let dropped = claude(
        dir,
        Some("haiku"),
        NESTED_PROMPT,
        4,
        &["--setting-sources", "user,local"],
    );
    eprintln!(
        "project dropped, nothing re-supplied: {}",
        seen(&dropped, &tokens)
    );
    assert!(tokens.iter().all(|t| !dropped.result.contains(t)));

    // (a) --add-dir <the workdir itself> plus the env switch.
    let dirf = fwd(dir);
    let a1 = claude_env(
        dir,
        Some("haiku"),
        NESTED_PROMPT,
        4,
        &["--setting-sources", "user,local", "--add-dir", &dirf],
        &[ADD_DIR_MD],
    );
    eprintln!("(a) --add-dir <workdir> + env: {}", seen(&a1, &tokens));
    assert!(a1.result.contains(NONCE_CLAUDE_MD) && a1.result.contains(NONCE_RULE));

    // (a) --add-dir <temp dir holding copies>.
    let copy = tmp.path().join("copy");
    std::fs::create_dir_all(copy.join(".claude")).unwrap();
    std::fs::copy(dir.join("CLAUDE.md"), copy.join("CLAUDE.md")).unwrap();
    copy_dir(&dir.join(".claude/rules"), &copy.join(".claude/rules"));
    copy_dir(&dir.join("docs"), &copy.join("docs"));
    copy_dir(&dir.join("sub"), &copy.join("sub"));
    let copyf = fwd(&copy);
    let a2 = claude_env(
        dir,
        Some("haiku"),
        NESTED_PROMPT,
        4,
        &["--setting-sources", "user,local", "--add-dir", &copyf],
        &[ADD_DIR_MD],
    );
    eprintln!("(a) --add-dir <temp copies> + env: {}", seen(&a2, &tokens));
    assert!(a2.result.contains(NONCE_CLAUDE_MD) && a2.result.contains(NONCE_RULE));
    let a2_none = claude(
        dir,
        Some("haiku"),
        NESTED_PROMPT,
        4,
        &["--setting-sources", "user,local", "--add-dir", &copyf],
    );
    eprintln!(
        "(a) --add-dir <temp copies>, no env: {}",
        seen(&a2_none, &tokens)
    );
    assert!(tokens.iter().all(|t| !a2_none.result.contains(t)));

    // (b) --append-system-prompt-file with the two files joined.
    let joined = tmp.path().join("instructions.md");
    let text = format!(
        "{}\n{}",
        std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(),
        std::fs::read_to_string(dir.join(".claude/rules/r.md")).unwrap()
    );
    std::fs::write(&joined, text).unwrap();
    let jf = fwd(&joined);
    let b = claude(
        dir,
        Some("haiku"),
        NESTED_PROMPT,
        4,
        &[
            "--setting-sources",
            "user,local",
            "--append-system-prompt-file",
            &jf,
        ],
    );
    eprintln!("(b) --append-system-prompt-file: {}", seen(&b, &tokens));
    assert!(b.result.contains(NONCE_CLAUDE_MD) && b.result.contains(NONCE_RULE));
    report("(a) --add-dir <workdir> + env", &base, &a1);
}

/// Dropping `local`: what leaves besides its settings, and whether it can be handed back.
#[test]
fn proof_resupply_local() {
    if !build_proof_enabled() {
        return;
    }
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    add_extras(dir);
    let tmp = tempfile::tempdir().unwrap();
    let tokens = [NONCE_CLAUDE_MD, NONCE_RULE, NONCE_IMPORT, NONCE_LOCAL];

    let base = claude(dir, Some("haiku"), PROMPT, 2, &[]);
    eprintln!("normal run: {}", seen(&base, &tokens));
    assert!(base.result.contains(NONCE_LOCAL), "{:?}", base.result);
    let off = claude(
        dir,
        Some("haiku"),
        PROMPT,
        2,
        &["--setting-sources", "user,project"],
    );
    eprintln!("local dropped: {}", seen(&off, &tokens));
    report("local dropped, nothing re-supplied", &base, &off);
    assert!(
        !off.result.contains(NONCE_LOCAL),
        "CLAUDE.local.md survived"
    );
    assert!(
        off.result.contains(NONCE_CLAUDE_MD),
        "project files must stay"
    );

    let lc = tmp.path().join("local-as-is");
    std::fs::create_dir_all(&lc).unwrap();
    std::fs::copy(dir.join("CLAUDE.local.md"), lc.join("CLAUDE.local.md")).unwrap();
    let (lcf, dirf) = (fwd(&lc), fwd(dir));
    for (label, add) in [
        ("temp copy named CLAUDE.local.md", &lcf),
        ("the workdir itself", &dirf),
    ] {
        let o = claude_env(
            dir,
            Some("haiku"),
            PROMPT,
            2,
            &["--setting-sources", "user,project", "--add-dir", add],
            &[ADD_DIR_MD],
        );
        eprintln!("--add-dir {label} + env: {}", seen(&o, &tokens));
        assert!(
            !o.result.contains(NONCE_LOCAL),
            "{label} carried CLAUDE.local.md"
        );
    }

    let renamed = tmp.path().join("local-renamed");
    std::fs::create_dir_all(&renamed).unwrap();
    std::fs::copy(dir.join("CLAUDE.local.md"), renamed.join("CLAUDE.md")).unwrap();
    let rf = fwd(&renamed);
    let o = claude_env(
        dir,
        Some("haiku"),
        PROMPT,
        2,
        &["--setting-sources", "user,project", "--add-dir", &rf],
        &[ADD_DIR_MD],
    );
    eprintln!(
        "--add-dir <temp dir, file renamed CLAUDE.md> + env: {}",
        seen(&o, &tokens)
    );
    assert!(o.result.contains(NONCE_LOCAL));

    let lmd = fwd(&dir.join("CLAUDE.local.md"));
    let o = claude(
        dir,
        Some("haiku"),
        PROMPT,
        2,
        &[
            "--setting-sources",
            "user,project",
            "--append-system-prompt-file",
            &lmd,
        ],
    );
    eprintln!(
        "--append-system-prompt-file CLAUDE.local.md: {}",
        seen(&o, &tokens)
    );
    assert!(o.result.contains(NONCE_LOCAL));
}

/// User source: re-supply every enabled plugin with `--plugin-dir`, and a temporary copy of
/// the personal skills as a plugin. Reads the real home, never writes it.
#[test]
fn proof_resupply_user_plugins() {
    if !build_proof_enabled() {
        return;
    }
    let home = PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default(),
    );
    let installed = home.join(".claude/plugins/installed_plugins.json");
    let Ok(text) = std::fs::read_to_string(&installed) else {
        eprintln!("SKIP: no installed_plugins.json at {}", installed.display());
        return;
    };
    let v: Value = serde_json::from_str(&text).unwrap();
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();
    let drop_user = ["--setting-sources", "project,local"];

    let base = claude(dir, Some("haiku"), PROMPT, 2, &[]);
    let base_sources = base.plugin_sources();
    let third_party: Vec<&Value> = base.init["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["path"] != "builtin")
        .collect();
    if third_party.is_empty() {
        eprintln!("SKIP: no non-builtin plugin is enabled on this machine");
        return;
    }
    let has_manifest = |p: &Path| p.join(".claude-plugin/plugin.json").is_file();

    // A: what installed_plugins.json says (the user-scope install path of each enabled plugin).
    let mut from_installed: Vec<PathBuf> = Vec::new();
    for (key, entries) in v["plugins"].as_object().cloned().unwrap_or_default() {
        if !base_sources.contains(&key) {
            continue;
        }
        let user = entries
            .as_array()
            .and_then(|a| a.iter().find(|e| e["scope"] == "user"));
        if let Some(path) = user.and_then(|e| e["installPath"].as_str()) {
            let p = PathBuf::from(path);
            if has_manifest(&p) {
                from_installed.push(p);
            } else {
                eprintln!("no plugin.json, cannot be re-supplied by --plugin-dir: {key} ({path})");
            }
        }
    }
    // B: the path the start report gives for each (covers plugins installed_plugins.json lacks).
    let from_report: Vec<PathBuf> = third_party
        .iter()
        .filter_map(|p| p["path"].as_str().map(PathBuf::from))
        .filter(|p| has_manifest(p))
        .collect();
    for p in &third_party {
        let path = PathBuf::from(p["path"].as_str().unwrap_or(""));
        if !has_manifest(&path) {
            eprintln!(
                "enabled plugin without plugin.json (cannot be re-supplied): {} at {}",
                p["source"],
                path.display()
            );
        }
    }
    let run = |paths: &[PathBuf]| {
        let mut owned: Vec<String> = drop_user.iter().map(|s| s.to_string()).collect();
        for p in paths {
            owned.push("--plugin-dir".into());
            owned.push(fwd(p));
        }
        let args: Vec<&str> = owned.iter().map(String::as_str).collect();
        claude(dir, Some("haiku"), PROMPT, 2, &args)
    };

    let a = run(&from_installed);
    report(
        &format!(
            "user dropped, {} plugins from installed_plugins.json",
            from_installed.len()
        ),
        &base,
        &a,
    );
    let b = run(&from_report);
    report(
        &format!(
            "user dropped, {} plugins from the start report's paths",
            from_report.len()
        ),
        &base,
        &b,
    );
    for (label, out, paths) in [("A", &a, &from_installed), ("B", &b, &from_report)] {
        let names: Vec<String> = paths
            .iter()
            .filter_map(|p| {
                let m = std::fs::read_to_string(p.join(".claude-plugin/plugin.json")).ok()?;
                serde_json::from_str::<Value>(&m).ok()?["name"]
                    .as_str()
                    .map(str::to_string)
            })
            .collect();
        for n in &names {
            assert!(
                out.plugin_sources().contains(&format!("{n}@inline")),
                "{label}: {n} not reported as {n}@inline"
            );
            let prefix = format!("{n}:");
            for s in base.skills().iter().filter(|s| s.starts_with(&prefix)) {
                assert!(out.skills().contains(s), "{label}: skill {s} lost its name");
            }
        }
        assert!(
            !out.plugin_sources()
                .iter()
                .any(|s| base_sources.contains(s) && !s.ends_with("@builtin")),
            "{label}: a plugin kept its <name>@<marketplace> source"
        );
    }

    // Personal skills: temp copies of whatever sits under ~/.claude/skills, named like the
    // prefix the normal run shows. The personal path itself is only read.
    let plugin_names: Vec<String> = base.names("plugins", "name");
    let mut prefixes: Vec<String> = base
        .skills()
        .iter()
        .filter_map(|s| s.split_once(':').map(|(p, _)| p.to_string()))
        .filter(|p| !plugin_names.contains(p))
        .collect();
    prefixes.sort();
    prefixes.dedup();
    let mut skill_dirs: Vec<PathBuf> = Vec::new();
    find_skill_dirs(&home.join(".claude/skills"), 3, &mut skill_dirs);
    if prefixes.len() == 1 && !skill_dirs.is_empty() {
        let name = prefixes[0].clone();
        let pl = make_skill_plugin(tmp.path(), &name, &skill_dirs);
        let mut paths = from_report.clone();
        paths.push(pl);
        let c = run(&paths);
        report(
            &format!(
                "user dropped, report-path plugins plus a temp `{name}` plugin of {} personal skills",
                skill_dirs.len()
            ),
            &base,
            &c,
        );
        let prefix = format!("{name}:");
        for s in base.skills().iter().filter(|s| s.starts_with(&prefix)) {
            assert!(c.skills().contains(s), "personal skill {s} lost its name");
        }
    } else {
        eprintln!(
            "personal skills not exercised: prefixes without a plugin = {prefixes:?}, skill folders found = {}",
            skill_dirs.len()
        );
    }
}

/// Cheap alternative: `disableAllHooks: true` next to the hooks to keep in the same file.
#[test]
fn proof_disable_all_hooks_keeps_none() {
    if !build_proof_enabled() {
        return;
    }
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();
    let f = write_json(
        tmp.path(),
        "dah.json",
        &json!({"disableAllHooks": true, "hooks": {"UserPromptSubmit": [hook_cmd("hookB")]}}),
    );
    for (label, extra) in [
        ("all sources", vec!["--settings", f.as_str()]),
        (
            "project dropped",
            vec!["--setting-sources", "user,local", "--settings", f.as_str()],
        ),
    ] {
        let out = claude(dir, Some("haiku"), PROMPT, 2, &extra);
        eprintln!(
            "disableAllHooks + hook B in the same --settings file ({label}): markers (A,B,C,D) = {:?}, hook_started = {}",
            markers(dir),
            out.hook_started().len()
        );
        assert_eq!(markers(dir), (false, false, false, false), "{label}");
        assert!(out.hook_started().is_empty(), "{label}");
    }
}

/// Folders holding a `SKILL.md`, searched `depth` levels down (the synced personal skills
/// sit under `skills/synced/<id>/<skill>`).
fn find_skill_dirs(root: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let p = entry.path();
        if p.join("SKILL.md").is_file() {
            out.push(p);
        } else if p.is_dir() {
            find_skill_dirs(&p, depth - 1, out);
        }
    }
}

// ---------------------------------------------------------------------------
// Follow-up: plugins without a manifest (LSP), and a server a synced plugin loses
// ---------------------------------------------------------------------------

const LSP_PROMPT: &str = "Use the LSP tool (not Read or Grep) with operation documentSymbol on filePath main.ts. Then reply with the single line LSP-RESULT followed by the symbol names it returned, or LSP-FAILED followed by the error text.";

impl Out {
    /// Text of every `LSP` tool result.
    fn lsp_results(&self) -> Vec<String> {
        let ids: Vec<String> = self
            .events
            .iter()
            .filter(|e| e["type"] == "assistant")
            .flat_map(|e| e["message"]["content"].as_array().into_iter().flatten())
            .filter(|c| c["type"] == "tool_use" && c["name"] == "LSP")
            .filter_map(|c| c["id"].as_str().map(str::to_string))
            .collect();
        self.events
            .iter()
            .filter(|e| e["type"] == "user")
            .flat_map(|e| e["message"]["content"].as_array().into_iter().flatten())
            .filter(|c| c["type"] == "tool_result")
            .filter(|c| ids.iter().any(|i| c["tool_use_id"] == i.as_str()))
            .map(|c| c["content"].to_string())
            .collect()
    }
    fn has_tool(&self, name: &str) -> bool {
        self.list("tools").iter().any(|t| t == name)
    }
}

fn home_dir() -> PathBuf {
    PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default(),
    )
}

/// The marketplace entry (`plugins[]` item) for `name` in marketplace `market`, read from the
/// local marketplace checkouts.
fn marketplace_entry(home: &Path, market: &str, name: &str) -> Option<Value> {
    let root = home.join(".claude/plugins/marketplaces");
    for d in std::fs::read_dir(root).ok()?.flatten() {
        let f = d.path().join(".claude-plugin/marketplace.json");
        let Ok(text) = std::fs::read_to_string(&f) else {
            continue;
        };
        let v: Value = serde_json::from_str(&text).ok()?;
        if v["name"] != market {
            continue;
        }
        if let Some(e) = v["plugins"]
            .as_array()
            .and_then(|a| a.iter().find(|e| e["name"] == name))
        {
            return Some(e.clone());
        }
    }
    None
}

/// Copies an installed plugin folder (without its `.in_use` markers) into `to`.
fn copy_plugin(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        if entry.file_name() == ".in_use" {
            continue;
        }
        let dest = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_plugin(&entry.path(), &dest);
        } else {
            std::fs::copy(entry.path(), dest).unwrap();
        }
    }
}

/// Plugins the normal run loads from a folder with no `plugin.json`: their definition lives in
/// the marketplace entry. Returns `(name, marketplace, installed folder)`.
fn manifestless(base: &Out) -> Vec<(String, String, PathBuf)> {
    base.init["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["path"] != "builtin")
        .filter_map(|p| {
            let path = PathBuf::from(p["path"].as_str()?);
            if path.join(".claude-plugin/plugin.json").is_file() {
                return None;
            }
            let (name, market) = p["source"].as_str()?.split_once('@')?;
            Some((name.to_string(), market.to_string(), path))
        })
        .collect()
}

/// Plugins with a manifest, as the start report gives their paths.
fn with_manifest(base: &Out) -> Vec<PathBuf> {
    base.init["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["path"] != "builtin")
        .filter_map(|p| p["path"].as_str().map(PathBuf::from))
        .filter(|p| p.join(".claude-plugin/plugin.json").is_file())
        .collect()
}

/// Runs with `user` dropped and each given folder passed as `--plugin-dir`.
fn run_user_dropped(dir: &Path, prompt: &str, turns: u32, plugin_dirs: &[PathBuf]) -> Out {
    let mut owned: Vec<String> = vec!["--setting-sources".into(), "project,local".into()];
    for p in plugin_dirs {
        owned.push("--plugin-dir".into());
        owned.push(fwd(p));
    }
    let args: Vec<&str> = owned.iter().map(String::as_str).collect();
    claude(dir, Some("haiku"), prompt, turns, &args)
}

/// Plugins whose definition lives only in the marketplace entry (the LSP plugins): which
/// generated manifest brings them back, and whether the `LSP` tool then works.
#[test]
fn proof_resupply_lsp_manifest() {
    if !build_proof_enabled() {
        return;
    }
    let home = home_dir();
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.join("main.ts"),
        "export function add(a: number, b: number): number {\n  return a + b;\n}\nconst x = add(1, 2);\n",
    )
    .unwrap();

    let base = claude(dir, Some("haiku"), LSP_PROMPT, 5, &[]);
    let lsp: Vec<(String, String, PathBuf, Value)> = manifestless(&base)
        .into_iter()
        .filter_map(|(n, m, p)| {
            let e = marketplace_entry(&home, &m, &n)?;
            e.get("lspServers")?;
            Some((n, m, p, e))
        })
        .collect();
    if lsp.is_empty() {
        eprintln!(
            "SKIP: no enabled plugin without plugin.json whose marketplace entry has lspServers"
        );
        return;
    }
    eprintln!(
        "plugins to rebuild: {:?}; LSP tool in the normal run: {}; LSP result: {:?}",
        lsp.iter().map(|(n, ..)| n).collect::<Vec<_>>(),
        base.has_tool("LSP"),
        base.lsp_results()
    );
    assert!(base.has_tool("LSP"));
    let others = with_manifest(&base);

    // Variants of the generated manifest. The marketplace entry minus its marketplace-only
    // fields (`source`, `category`, `strict`) is the plugin's own manifest.
    let variants: [(&str, bool); 4] = [
        ("A: lspServers inline in plugin.json", true),
        (
            "B: plugin.json plus .lsp.json holding the servers map",
            true,
        ),
        (
            "C: plugin.json plus .lsp.json wrapped as {\"lspServers\": ...}",
            false,
        ),
        ("N: plugin.json with no lspServers at all", false),
    ];
    for (i, (label, should_work)) in variants.iter().enumerate() {
        let root = tmp.path().join(format!("v{i}"));
        let mut dirs = others.clone();
        for (name, _m, installed, entry) in &lsp {
            let dst = root.join(name);
            copy_plugin(installed, &dst);
            let mut manifest = entry.clone();
            let servers = manifest["lspServers"].clone();
            for k in ["source", "category", "strict", "lspServers"] {
                manifest.as_object_mut().unwrap().remove(k);
            }
            std::fs::create_dir_all(dst.join(".claude-plugin")).unwrap();
            match i {
                0 => {
                    manifest["lspServers"] = servers;
                }
                1 => std::fs::write(dst.join(".lsp.json"), servers.to_string()).unwrap(),
                2 => std::fs::write(
                    dst.join(".lsp.json"),
                    json!({"lspServers": servers}).to_string(),
                )
                .unwrap(),
                _ => {}
            }
            std::fs::write(
                dst.join(".claude-plugin/plugin.json"),
                serde_json::to_string_pretty(&manifest).unwrap(),
            )
            .unwrap();
            dirs.push(dst);
        }
        let out = run_user_dropped(dir, LSP_PROMPT, 5, &dirs);
        eprintln!(
            "variant {label}: LSP tool = {}, LSP result = {:?}",
            out.has_tool("LSP"),
            out.lsp_results()
        );
        report(&format!("user dropped, variant {label}"), &base, &out);
        for (name, ..) in &lsp {
            assert!(
                out.plugin_sources().contains(&format!("{name}@inline")),
                "{label}: {name} not loaded"
            );
        }
        if *should_work {
            assert!(out.has_tool("LSP"), "{label}: no LSP tool");
            assert!(
                out.lsp_results()
                    .iter()
                    .any(|r| r.contains("Document symbols") && r.contains("add")),
                "{label}: LSP call failed: {:?}",
                out.lsp_results()
            );
        } else {
            assert!(!out.has_tool("LSP"), "{label}: the LSP tool came back");
        }
    }
}

/// What the credentials store says about a server (metadata only; no token is read or printed).
/// Mirrors the rule Claude Code logs as "Left out MCP server ... of synced plugin ...".
fn left_out_by_rule(home: &Path, plugin: &str, plugin_dir: &Path) -> Vec<String> {
    let flag = std::fs::read_to_string(home.join(".claude.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| v["cachedGrowthBookFeatures"]["tengu_starry_locket"] == true)
        .unwrap_or(false);
    if !flag {
        return Vec::new();
    }
    let creds: Value = std::fs::read_to_string(home.join(".claude/.credentials.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let mcp: Value = std::fs::read_to_string(plugin_dir.join(".mcp.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let servers = mcp.get("mcpServers").unwrap_or(&mcp);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    const THIRTY_DAYS_MS: i64 = 2_592_000_000;
    let mut out = Vec::new();
    for (name, s) in servers.as_object().into_iter().flatten() {
        let ty = s["type"].as_str().unwrap_or("");
        let url = s["url"].as_str().unwrap_or("");
        if !(ty == "http" || ty == "sse")
            || s["oauth"]["clientId"].is_string()
            || url.is_empty()
            || url.contains("${")
        {
            continue;
        }
        let prefix = format!("plugin:{plugin}:{name}|");
        let hit = creds["mcpOAuth"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(k, v)| k.starts_with(&prefix) && v["serverUrl"] == url)
            .any(|(_, v)| {
                let no_tokens = v["accessToken"].as_str().unwrap_or("").is_empty()
                    && v["refreshToken"].as_str().unwrap_or("").is_empty();
                let at = v["discoveryState"]["registrationNotOfferedAt"].as_i64();
                no_tokens
                    && v["discoveryState"]["oauthMetadataFound"] == true
                    && !v["clientId"].is_string()
                    && at.is_some_and(|t| {
                        let age = now_ms - t;
                        age > -60_000 && age <= THIRTY_DAYS_MS
                    })
            });
        if hit {
            out.push(name.clone());
        }
    }
    out.sort();
    out
}

/// A synced plugin's tool server that the normal run leaves out, and why. Reads the credentials
/// store for metadata only.
#[test]
fn proof_synced_mcp_left_out() {
    if !build_proof_enabled() {
        return;
    }
    let home = home_dir();
    let kata = kata_bin();
    let proj = make_project(&kata);
    let dir = proj.path();
    let tmp = tempfile::tempdir().unwrap();
    let log = tmp.path().join("debug.log");
    let logf = fwd(&log);

    let base = claude(dir, Some("haiku"), PROMPT, 2, &["--debug-file", &logf]);
    let text = std::fs::read_to_string(&log).unwrap_or_default();
    // `Left out MCP server "asana" of synced plugin design: ...`
    let mut logged: Vec<(String, String)> = text
        .lines()
        .filter_map(|l| {
            let rest = l.split("Left out MCP server \"").nth(1)?;
            let (server, rest) = rest.split_once("\" of synced plugin ")?;
            let (plugin, _) = rest.split_once(':')?;
            Some((plugin.to_string(), server.to_string()))
        })
        .collect();
    logged.sort();
    eprintln!("left out by the normal run (from its debug log): {logged:?}");

    let synced: Vec<(String, PathBuf)> = base.init["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["source"].as_str().is_some_and(|s| s.ends_with("@synced")))
        .filter_map(|p| {
            Some((
                p["name"].as_str()?.to_string(),
                PathBuf::from(p["path"].as_str()?),
            ))
        })
        .collect();
    if synced.is_empty() {
        eprintln!("SKIP: no synced plugin is enabled on this machine");
        return;
    }
    // The rule, recomputed from the credentials store and the cached flag.
    let mut computed: Vec<(String, String)> = Vec::new();
    for (name, path) in &synced {
        for s in left_out_by_rule(&home, name, path) {
            computed.push((name.clone(), s));
        }
    }
    computed.sort();
    eprintln!("left out by the recomputed rule: {computed:?}");
    assert_eq!(computed, logged, "the recomputed rule differs from the log");
    if logged.is_empty() {
        eprintln!("nothing is left out on this machine: the re-supply difference cannot show");
        return;
    }

    // Re-supplying the synced plugin as it is brings the servers back (the rule is for synced only).
    let (plugin, path) = synced.iter().find(|(n, _)| *n == logged[0].0).unwrap();
    let theirs = |o: &Out| -> Vec<String> {
        o.mcp()
            .into_iter()
            .filter(|s| s.starts_with(&format!("plugin:{plugin}:")))
            .collect()
    };
    let as_is = run_user_dropped(dir, PROMPT, 2, std::slice::from_ref(path));
    let extra: Vec<String> = theirs(&as_is)
        .into_iter()
        .filter(|s| !theirs(&base).contains(s))
        .collect();
    eprintln!("re-supplied as it is: extra servers {extra:?}");
    for (p, s) in logged.iter().filter(|(p, _)| p == plugin) {
        assert!(
            extra.contains(&format!("plugin:{p}:{s}")),
            "{s} did not come back"
        );
    }

    // A copy whose .mcp.json omits the left-out servers reproduces the normal run's servers.
    let copy = tmp.path().join("copy").join(plugin);
    copy_plugin(path, &copy);
    let mut mcp: Value =
        serde_json::from_str(&std::fs::read_to_string(copy.join(".mcp.json")).unwrap()).unwrap();
    for (_, s) in logged.iter().filter(|(p, _)| p == plugin) {
        match mcp.get_mut("mcpServers") {
            Some(m) => m.as_object_mut().unwrap().remove(s),
            None => mcp.as_object_mut().unwrap().remove(s),
        };
    }
    std::fs::write(copy.join(".mcp.json"), mcp.to_string()).unwrap();
    let trimmed = run_user_dropped(dir, PROMPT, 2, &[copy]);
    let (missing, added, order_same) = delta(&theirs(&base), &theirs(&trimmed));
    eprintln!(
        "re-supplied with the left-out servers removed from .mcp.json: missing {missing:?} added {added:?} order unchanged {order_same}"
    );
    assert!(added.is_empty());
    assert!(missing.is_empty(), "unexpected missing: {missing:?}");
}
