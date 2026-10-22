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
