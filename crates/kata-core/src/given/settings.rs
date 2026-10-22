//! The settings layers Claude Code reads, and what the resolver takes from them.
//! Nothing here returns an environment value or a full hook command.

use super::{ItemKind, ResolveRoots, Source};
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

pub fn read_layers(_roots: &ResolveRoots) -> Vec<SettingsLayer> {
    Vec::new()
}

pub fn hook_detail(_event: &str, _matcher: Option<&str>, _command: &str) -> String {
    String::new()
}

pub fn hooks(_layers: &[SettingsLayer]) -> Vec<ItemFacts> {
    Vec::new()
}

pub fn env_names(_layers: &[SettingsLayer]) -> Vec<(Source, String)> {
    Vec::new()
}

pub fn model_setting(_layers: &[SettingsLayer]) -> Option<(String, Source)> {
    None
}

pub fn effort_setting(_layers: &[SettingsLayer]) -> Option<(String, Source)> {
    None
}

pub fn output_style(_layers: &[SettingsLayer]) -> Option<(String, Source)> {
    None
}

pub fn enabled_plugins(_layers: &[SettingsLayer]) -> BTreeMap<String, (bool, Source)> {
    BTreeMap::new()
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
