use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunSpec {
    #[serde(default = "default_schema_version")]
    pub schema: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    pub workdir: String,
    #[serde(default)]
    pub identity: Identity,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginConfig>,
    #[serde(default)]
    pub model: Model,
    #[serde(default)]
    pub leash: Leash,
}

impl Default for RunSpec {
    fn default() -> Self {
        Self {
            schema: default_schema_version(),
            name: String::new(),
            description: None,
            task: String::new(),
            context: None,
            workdir: String::new(),
            identity: Identity::default(),
            skills: Vec::new(),
            plugins: BTreeMap::new(),
            model: Model::default(),
            leash: Leash::default(),
        }
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Identity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub mode: IdentityMode,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "lowercase"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum IdentityMode {
    #[default]
    Append,
    Replace,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PluginConfig {
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<bool>,
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<Vec<String>>"))]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<String>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Model {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Leash {
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<u32>"))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub isolation: Isolation,
}

impl Default for Leash {
    fn default() -> Self {
        Self { max_turns: default_max_turns(), timeout_secs: None, isolation: Isolation::None }
    }
}

fn default_max_turns() -> u32 { 12 }

fn default_schema_version() -> u32 { 1 }

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "lowercase"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Isolation {
    #[default]
    None,
    Worktree,
}

#[derive(Debug, thiserror::Error)]
pub enum SpecError {
    #[error("reading {0}: {1}")]
    Io(String, std::io::Error),
    #[error("parsing TOML: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("serializing TOML: {0}")]
    TomlSer(#[from] toml::ser::Error),
    #[error("parsing JSON: {0}")]
    Json(#[from] serde_json::Error),
}

/// Load a spec from disk. `.json` parses as JSON; anything else as TOML.
pub fn load(path: &Path) -> Result<RunSpec, SpecError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| SpecError::Io(path.display().to_string(), e))?;
    let spec = if path.extension().and_then(|e| e.to_str()) == Some("json") {
        serde_json::from_str(&text)?
    } else {
        toml::from_str(&text)?
    };
    Ok(spec)
}

/// Canonical TOML serialization of a spec.
pub fn to_toml(spec: &RunSpec) -> Result<String, SpecError> {
    Ok(toml::to_string(spec)?)
}

/// Save a spec to disk. `.json` writes pretty JSON; anything else writes TOML.
pub fn save(path: &Path, spec: &RunSpec) -> Result<(), SpecError> {
    let text = if path.extension().and_then(|e| e.to_str()) == Some("json") {
        serde_json::to_string_pretty(spec)?
    } else {
        to_toml(spec)?
    };
    std::fs::write(path, text).map_err(|e| SpecError::Io(path.display().to_string(), e))
}

/// Pure structural validation (no filesystem access).
pub fn validate(spec: &RunSpec) -> Result<(), Vec<String>> {
    let mut errs = Vec::new();
    if spec.schema != 1 {
        errs.push(format!("unsupported schema version {} (expected 1)", spec.schema));
    }
    if spec.name.trim().is_empty() { errs.push("name is required".into()); }
    if spec.task.trim().is_empty() { errs.push("task is required".into()); }
    if spec.workdir.trim().is_empty() { errs.push("workdir is required".into()); }
    if spec.leash.max_turns == 0 { errs.push("leash.max_turns must be >= 1".into()); }
    if errs.is_empty() { Ok(()) } else { Err(errs) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_toml() -> &'static str {
        r#"
schema = 1
name = "demo"
task = "do the thing"
workdir = "/tmp/work"
"#
    }

    #[test]
    fn parses_minimal_spec_with_defaults() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert_eq!(spec.name, "demo");
        assert_eq!(spec.task, "do the thing");
        assert_eq!(spec.leash.max_turns, 12); // default
        assert_eq!(spec.leash.isolation, Isolation::None);
        assert_eq!(spec.identity.mode, IdentityMode::Append);
        assert!(spec.skills.is_empty());
        assert!(spec.plugins.is_empty());
        assert!(spec.model.id.is_none());
    }

    #[test]
    fn parses_full_spec_including_plugins_table() {
        let toml = r#"
schema = 1
name = "triage"
task = "triage it"
context = "extra"
workdir = "/repo"
skills = ["triage-flaky-test"]

[identity]
system_prompt = "you triage"
mode = "replace"

[plugins.github-tools]
mcp = true
env = ["GITHUB_TOKEN"]

[plugins.doc-writer]

[model]
id = "claude-sonnet-4-6"

[leash]
max_turns = 8
timeout_secs = 600
isolation = "worktree"
"#;
        let spec: RunSpec = toml::from_str(toml).unwrap();
        assert_eq!(spec.identity.mode, IdentityMode::Replace);
        assert_eq!(spec.skills, vec!["triage-flaky-test"]);
        assert_eq!(spec.plugins.len(), 2);
        assert_eq!(spec.plugins["github-tools"].env, vec!["GITHUB_TOKEN"]);
        assert_eq!(spec.plugins["github-tools"].mcp, Some(true));
        assert!(spec.plugins.contains_key("doc-writer"));
        assert_eq!(spec.model.id.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(spec.leash.isolation, Isolation::Worktree);
        assert_eq!(spec.leash.timeout_secs, Some(600));
    }

    #[test]
    fn toml_round_trips() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        let text = toml::to_string(&spec).unwrap();
        let again: RunSpec = toml::from_str(&text).unwrap();
        assert_eq!(spec, again);
    }

    #[test]
    fn json_parses_same_shape() {
        let json = r#"{"schema":1,"name":"j","task":"t","workdir":"/w"}"#;
        let spec: RunSpec = serde_json::from_str(json).unwrap();
        assert_eq!(spec.name, "j");
        assert_eq!(spec.leash.max_turns, 12);
    }

    #[test]
    fn validate_flags_missing_required_fields() {
        let spec = RunSpec { schema: 1, name: " ".into(), task: "".into(), workdir: "".into(), ..Default::default() };
        let errs = validate(&spec).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("name")));
        assert!(errs.iter().any(|e| e.contains("task")));
        assert!(errs.iter().any(|e| e.contains("workdir")));
    }

    #[test]
    fn validate_rejects_unknown_schema_and_zero_turns() {
        let mut spec = RunSpec { schema: 99, name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        spec.leash.max_turns = 0;
        let errs = validate(&spec).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("schema")));
        assert!(errs.iter().any(|e| e.contains("max_turns")));
    }

    #[test]
    fn validate_passes_minimal() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert!(validate(&spec).is_ok());
    }

    #[test]
    fn schema_defaults_to_v1_when_omitted_or_default() {
        // Programmatic default is a valid v1 spec, not schema 0.
        let d = RunSpec { name: "n".into(), task: "t".into(), workdir: "/w".into(), ..Default::default() };
        assert_eq!(d.schema, 1);
        assert!(validate(&d).is_ok());

        // A spec file that omits `schema` parses as v1.
        let spec: RunSpec = toml::from_str("name = \"x\"\ntask = \"t\"\nworkdir = \"/w\"\n").unwrap();
        assert_eq!(spec.schema, 1);
    }

    fn full_spec() -> RunSpec {
        let mut plugins = std::collections::BTreeMap::new();
        plugins.insert(
            "github-tools".to_string(),
            PluginConfig { mcp: Some(true), env: vec!["GITHUB_TOKEN".into()] },
        );
        RunSpec {
            schema: 1,
            name: "triage".into(),
            description: Some("desc".into()),
            task: "do it".into(),
            context: Some("ctx".into()),
            workdir: "/repo".into(),
            identity: Identity { system_prompt: Some("you triage".into()), mode: IdentityMode::Replace },
            skills: vec!["triage-flaky-test".into()],
            plugins,
            model: Model { id: Some("claude-sonnet-4-6".into()) },
            leash: Leash { max_turns: 8, timeout_secs: Some(600), isolation: Isolation::Worktree },
        }
    }

    #[test]
    fn save_then_load_round_trips_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("spec.toml");
        let spec = full_spec();
        save(&path, &spec).unwrap();
        let again = load(&path).unwrap();
        assert_eq!(spec, again);
    }

    #[test]
    fn save_then_load_round_trips_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("spec.json");
        let spec = full_spec();
        save(&path, &spec).unwrap();
        let again = load(&path).unwrap();
        assert_eq!(spec, again);
    }

    #[test]
    fn to_toml_emits_parseable_text() {
        let text = to_toml(&full_spec()).unwrap();
        let again: RunSpec = toml::from_str(&text).unwrap();
        assert_eq!(again.name, "triage");
    }
}
