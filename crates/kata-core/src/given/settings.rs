//! The settings layers Claude Code reads, and what the resolver takes from them.
//! Nothing here returns an environment value or a full hook command.

use super::{hook_key, item_id, ItemKind, ResolveRoots, Source};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// One item the run would start with, as the resolver describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct ItemFacts {
    pub id: String,
    pub kind: ItemKind,
    pub source: Source,
    pub name: String,
    pub detail: String,
    pub path: Option<PathBuf>,
    pub brought_by: Option<String>,
    pub repo_relative: bool,
}

/// One settings file. `value` is `null` and `problem` is set when the file
/// exists but cannot be read or parsed.
#[derive(Debug, Clone)]
pub struct SettingsLayer {
    pub source: Source,
    pub path: PathBuf,
    pub value: serde_json::Value,
    pub problem: Option<String>,
}

/// Read the four settings layers, lowest precedence first: personal, project,
/// project-local, organization. A missing file is no layer; an unreadable or
/// invalid one is a layer with a `problem`.
pub fn read_layers(roots: &ResolveRoots) -> Vec<SettingsLayer> {
    let files = [
        (Source::Personal, roots.home.join(".claude/settings.json")),
        (Source::Project, roots.workdir.join(".claude/settings.json")),
        (
            Source::ProjectLocal,
            roots.workdir.join(".claude/settings.local.json"),
        ),
        (Source::Organization, roots.managed_settings.clone()),
    ];
    let mut layers = Vec::new();
    for (source, path) in files {
        if !path.exists() {
            continue;
        }
        let parsed = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))
            .and_then(|text| {
                serde_json::from_str::<serde_json::Value>(&text)
                    .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
            });
        let (value, problem) = match parsed {
            Ok(v) if v.is_object() => (v, None),
            Ok(_) => (
                serde_json::Value::Null,
                Some(format!("{} is not a JSON object", path.display())),
            ),
            Err(p) => (serde_json::Value::Null, Some(p)),
        };
        layers.push(SettingsLayer {
            source,
            path,
            value,
            problem,
        });
    }
    layers
}

const SCRIPT_EXTENSIONS: &[&str] = &[
    ".mjs", ".js", ".cjs", ".ts", ".py", ".sh", ".ps1", ".cmd", ".bat",
];

/// Split a command on unquoted whitespace, dropping the quotes. Not a shell
/// parser: it only has to be safe, so an odd command yields odd tokens, never
/// more text than the command held.
fn tokens(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut open = false;
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                open = true;
            }
            None if c.is_whitespace() => {
                if open || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    open = false;
                }
            }
            None => cur.push(c),
        }
    }
    if open || !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `NAME=value`, as a shell reads a leading environment assignment.
fn is_assignment(token: &str) -> bool {
    match token.split_once('=') {
        Some((name, _)) => {
            !name.is_empty()
                && !name.starts_with(|c: char| c.is_ascii_digit())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        None => false,
    }
}

fn is_script_path(token: &str) -> bool {
    if token.starts_with('-') || is_assignment(token) || token.contains("://") {
        return false;
    }
    let ends_in_script = SCRIPT_EXTENSIONS.iter().any(|e| token.ends_with(e));
    // Code passed inline ("-c 'open(\"/etc/x\")'") has these; a path does not.
    let looks_like_code = token.contains(['(', ')', '\'', '"', ';', '|', '&', '<', '>', '`']);
    if looks_like_code {
        return false;
    }
    let has_space = token.contains(char::is_whitespace);
    ends_in_script || (!has_space && token.contains(['/', '\\']))
}

/// How a hook is shown: `<event> · <matcher or any> · <program> <first script
/// path>`. The program is the first token that is not a leading `NAME=value`
/// assignment; the script path is the first later token that is a script file or
/// a path (never a flag, an assignment or a URL). Nothing else of the command is
/// shown, so a token in an argument never reaches the screen.
pub fn hook_detail(event: &str, matcher: Option<&str>, command: &str) -> String {
    let matcher = matcher.filter(|m| !m.is_empty()).unwrap_or("any");
    let toks = tokens(command);
    let mut rest = toks.iter().skip_while(|t| is_assignment(t));
    let program = rest.next().map(String::as_str).unwrap_or("");
    let script = rest.find(|t| is_script_path(t));
    let mut out = format!("{event} · {matcher}");
    if !program.is_empty() {
        out.push_str(" · ");
        out.push_str(program);
        if let Some(s) = script {
            out.push(' ');
            out.push_str(s);
        }
    }
    out
}

/// One item per hook command. Entries that are not `type: "command"` (prompt,
/// agent, http hooks) have no command to run or identify and are left out.
pub fn hooks(layers: &[SettingsLayer]) -> Vec<ItemFacts> {
    let mut out = Vec::new();
    for layer in layers {
        let (source, path) = (layer.source, &layer.path);
        let Some(events) = layer.value.get("hooks").and_then(|h| h.as_object()) else {
            continue;
        };
        for (event, groups) in events {
            let Some(groups) = groups.as_array() else {
                continue;
            };
            for group in groups {
                let matcher = group.get("matcher").and_then(|m| m.as_str());
                let Some(entries) = group.get("hooks").and_then(|h| h.as_array()) else {
                    continue;
                };
                for entry in entries {
                    if entry.get("type").and_then(|t| t.as_str()) != Some("command") {
                        continue;
                    }
                    let Some(command) = entry.get("command").and_then(|c| c.as_str()) else {
                        continue;
                    };
                    let matcher = matcher.filter(|m| !m.is_empty());
                    out.push(ItemFacts {
                        id: item_id(ItemKind::Hook, source, &hook_key(event, matcher, command)),
                        kind: ItemKind::Hook,
                        source,
                        name: format!("{event} {}", matcher.unwrap_or("any")),
                        detail: hook_detail(event, matcher, command),
                        path: Some(path.clone()),
                        brought_by: None,
                        repo_relative: matches!(source, Source::Project | Source::ProjectLocal),
                    });
                }
            }
        }
    }
    out
}

/// The names of each layer's `env`; the values are dropped here.
pub fn env_names(layers: &[SettingsLayer]) -> Vec<(Source, String)> {
    layers
        .iter()
        .filter_map(|l| {
            l.value
                .get("env")
                .and_then(|e| e.as_object())
                .map(|e| (l, e))
        })
        .flat_map(|(l, e)| e.keys().map(move |k| (l.source, k.clone())))
        .collect()
}

/// The highest-precedence layer's string value for `key`: organization,
/// project-local, project, personal.
fn string_setting(layers: &[SettingsLayer], key: &str) -> Option<(String, Source)> {
    layers.iter().rev().find_map(|l| {
        l.value
            .get(key)
            .and_then(|v| v.as_str())
            .map(|v| (v.to_string(), l.source))
    })
}

pub fn model_setting(layers: &[SettingsLayer]) -> Option<(String, Source)> {
    string_setting(layers, "model")
}

pub fn effort_setting(layers: &[SettingsLayer]) -> Option<(String, Source)> {
    string_setting(layers, "effortLevel")
}

pub fn output_style(layers: &[SettingsLayer]) -> Option<(String, Source)> {
    string_setting(layers, "outputStyle")
}

/// `enabledPlugins` merged per key, a higher layer overriding a lower one.
pub fn enabled_plugins(layers: &[SettingsLayer]) -> BTreeMap<String, (bool, Source)> {
    let mut out = BTreeMap::new();
    for l in layers {
        let Some(map) = l.value.get("enabledPlugins").and_then(|p| p.as_object()) else {
            continue;
        };
        for (name, on) in map {
            if let Some(on) = on.as_bool() {
                out.insert(name.clone(), (on, l.source));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn roots(dir: &std::path::Path) -> ResolveRoots {
        ResolveRoots {
            home: dir.join("home"),
            workdir: dir.join("work"),
            managed_settings: dir.join("managed").join("managed-settings.json"),
            claude_json: dir.join("home").join(".claude.json"),
        }
    }

    fn write(path: &std::path::Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn hook_settings(command: &str) -> String {
        serde_json::json!({"hooks": {"PreToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": command}]}
        ]}})
        .to_string()
    }

    #[test]
    fn hooks_are_read_from_each_of_the_four_layers_with_their_source() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(
            &r.home.join(".claude/settings.json"),
            &hook_settings("node a.js"),
        );
        write(
            &r.workdir.join(".claude/settings.json"),
            &hook_settings("node b.js"),
        );
        write(
            &r.workdir.join(".claude/settings.local.json"),
            &serde_json::json!({"hooks": {"Stop": [
                {"hooks": [{"type": "command", "command": "node c.js"},
                           {"type": "prompt", "prompt": "no command here"}]}
            ]}})
            .to_string(),
        );
        write(&r.managed_settings, &hook_settings("node d.js"));
        let layers = read_layers(&r);
        assert_eq!(layers.len(), 4);
        let found = hooks(&layers);
        assert_eq!(found.len(), 4);
        let by_source = |s: Source| found.iter().find(|h| h.source == s).unwrap();
        for (s, script) in [
            (Source::Personal, "a.js"),
            (Source::Project, "b.js"),
            (Source::ProjectLocal, "c.js"),
            (Source::Organization, "d.js"),
        ] {
            let h = by_source(s);
            assert_eq!(h.kind, ItemKind::Hook);
            assert!(
                h.id.starts_with(&format!("{}:hook:", s.as_str())),
                "{}",
                h.id
            );
            assert!(
                h.detail.ends_with(&format!("node {script}")),
                "{}",
                h.detail
            );
            let file = if s == Source::ProjectLocal {
                "settings.local.json"
            } else if s == Source::Organization {
                "managed-settings.json"
            } else {
                "settings.json"
            };
            assert!(h.path.as_ref().unwrap().ends_with(file));
            assert_eq!(
                h.repo_relative,
                matches!(s, Source::Project | Source::ProjectLocal)
            );
        }
        let local = by_source(Source::ProjectLocal);
        assert_eq!(local.detail, "Stop · any · node c.js");
        assert!(local.id.contains(":hook:Stop:*:"));
        assert!(by_source(Source::Project)
            .id
            .contains(":hook:PreToolUse:Bash:"));
    }

    #[test]
    fn an_invalid_settings_file_is_a_layer_with_a_problem_not_a_missing_layer() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(&r.workdir.join(".claude/settings.json"), "{ not json");
        let layers = read_layers(&r);
        assert_eq!(
            layers.len(),
            1,
            "a missing file is no layer, a broken one is"
        );
        assert_eq!(layers[0].source, Source::Project);
        assert!(layers[0].value.is_null());
        assert!(layers[0].problem.as_deref().is_some_and(|p| !p.is_empty()));
        assert!(hooks(&layers).is_empty());
    }

    #[test]
    fn hook_detail_shows_the_program_and_script_path_only() {
        let cases = [
            (
                r#"node "$CLAUDE_PROJECT_DIR/.claude/hooks/protect-gates.mjs""#,
                "PreToolUse · Bash · node $CLAUDE_PROJECT_DIR/.claude/hooks/protect-gates.mjs",
            ),
            (
                r#"curl -H "Authorization: Bearer sk-x" https://e"#,
                "PreToolUse · Bash · curl",
            ),
            ("TOKEN=abc ./run.sh --key k", "PreToolUse · Bash · ./run.sh"),
            (r#"python3 -c "print(1)""#, "PreToolUse · Bash · python3"),
        ];
        for (command, expected) in cases {
            let got = hook_detail("PreToolUse", Some("Bash"), command);
            assert_eq!(got, expected, "{command}");
            for secret in ["sk-x", "abc", "Bearer", "print"] {
                assert!(!got.contains(secret), "{got} leaks {secret}");
            }
        }
        assert_eq!(
            hook_detail("Stop", None, "node x.js"),
            "Stop · any · node x.js"
        );
        assert_eq!(
            hook_detail("Stop", Some(""), "node x.js"),
            "Stop · any · node x.js"
        );
    }

    #[test]
    fn env_names_are_read_and_values_are_never_kept() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(
            &r.home.join(".claude/settings.json"),
            r#"{"env": {"API_TOKEN": "s3cret-value", "DEBUG": "1"}}"#,
        );
        let names = env_names(&read_layers(&r));
        assert_eq!(
            names,
            vec![
                (Source::Personal, "API_TOKEN".to_string()),
                (Source::Personal, "DEBUG".to_string())
            ]
        );
        assert!(!format!("{names:?}").contains("s3cret"));
    }

    #[test]
    fn model_effort_and_output_style_follow_settings_precedence() {
        let d = tempfile::tempdir().unwrap();
        let r = roots(d.path());
        write(
            &r.home.join(".claude/settings.json"),
            r#"{"model":"p","effortLevel":"low","outputStyle":"Explanatory","enabledPlugins":{"a@m":true,"b@m":true}}"#,
        );
        write(
            &r.workdir.join(".claude/settings.json"),
            r#"{"model":"proj","effortLevel":"medium","enabledPlugins":{"b@m":false}}"#,
        );
        write(
            &r.workdir.join(".claude/settings.local.json"),
            r#"{"model":"local"}"#,
        );
        let layers = read_layers(&r);
        assert_eq!(
            model_setting(&layers),
            Some(("local".into(), Source::ProjectLocal))
        );
        assert_eq!(
            effort_setting(&layers),
            Some(("medium".into(), Source::Project))
        );
        assert_eq!(
            output_style(&layers),
            Some(("Explanatory".into(), Source::Personal))
        );
        write(&r.managed_settings, r#"{"model":"org"}"#);
        assert_eq!(
            model_setting(&read_layers(&r)),
            Some(("org".into(), Source::Organization))
        );
        let plugins = enabled_plugins(&layers);
        assert_eq!(plugins["a@m"], (true, Source::Personal));
        assert_eq!(plugins["b@m"], (false, Source::Project));
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(model_setting(&read_layers(&roots(empty.path()))), None);
    }
}
