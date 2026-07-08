use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunSpec {
    /// Run-spec format version. Currently always 1.
    #[serde(default = "default_schema_version")]
    pub schema: u32,
    /// Run name; also the source for the transcript and bundle slug.
    pub name: String,
    /// Human note describing the run. Ignored by the engine.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The prompt handed to the agent.
    pub task: String,
    /// Extra context prepended to the task.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Directory the run executes in.
    pub workdir: String,
    /// System-prompt identity: append to or replace the default system prompt.
    #[serde(default)]
    pub identity: Identity,
    /// Skills to vendor into the disposable kit.
    #[serde(default)]
    pub skills: Vec<String>,
    /// Plugins to vendor into the disposable kit, keyed by plugin name.
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginConfig>,
    /// Model selection for the run.
    #[serde(default)]
    pub model: Model,
    /// The leash: turn cap, wall-clock timeout, budget ceiling, and isolation.
    #[serde(default)]
    pub leash: Leash,
    /// Auth and empty-room ("bare") settings.
    #[serde(default)]
    pub auth: Auth,
    /// Interactive-run settings (the `ask_user` tool).
    #[serde(default)]
    pub interactive: Interactive,
    /// Environment variables to set on the spawned `claude` child, overriding any
    /// value inherited from the parent process, forwarded by a plugin, or derived
    /// from `auth.token_env`. Applied per run to the child only; the host process
    /// environment is never mutated. `BTreeMap` keeps serialization deterministic.
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<BTreeMap<String, String>>"))]
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Environment variable names to unset on the spawned `claude` child, even if
    /// present in the parent process environment or set by an earlier layer.
    /// Applied last, so removal wins.
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<Vec<String>>"))]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env_remove: Vec<String>,
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
            auth: Auth::default(),
            interactive: Interactive::default(),
            env: BTreeMap::new(),
            env_remove: Vec::new(),
        }
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Identity {
    /// A system prompt to append to, or replace, the default.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// How `system_prompt` combines with the default: append or replace.
    #[serde(default)]
    pub mode: IdentityMode,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "lowercase"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum IdentityMode {
    /// Append the spec's system prompt to the default.
    #[default]
    Append,
    /// Replace the default system prompt entirely.
    Replace,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PluginConfig {
    /// Whether the plugin exposes an MCP server to wire in. Unset = inherit the plugin's own default.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<bool>,
    /// Environment variable names to forward to the plugin, resolved from the parent environment.
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<Vec<String>>"))]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<String>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Model {
    /// Model id (e.g. `opus`). Unset uses claude's default.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Leash {
    /// Turn cap (exit 125). Unset = unbounded, limited only by the timeout.
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<u32>"))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    /// Wall-clock cap in seconds (exit 124). Unset applies the 1800s default.
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<u32>"))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    /// Spend ceiling in USD (exit 122). Must be > 0 when set.
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<f64>"))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_budget_usd: Option<f64>,
    /// Isolation mode: run in place, or branch off HEAD into a worktree.
    #[serde(default)]
    pub isolation: Isolation,
}

impl Default for Leash {
    fn default() -> Self {
        Self {
            max_turns: None,
            timeout_secs: None,
            max_budget_usd: None,
            isolation: Isolation::None,
        }
    }
}

/// Wall-clock cap applied when a spec leaves `timeout_secs` unset, so a hung run
/// is always reaped instead of running forever.
pub const DEFAULT_TIMEOUT_SECS: u64 = 1800;

impl Leash {
    /// The wall-clock timeout the engine will enforce: the spec's explicit value,
    /// or [`DEFAULT_TIMEOUT_SECS`] when unset. Never unbounded.
    pub fn effective_timeout_secs(&self) -> u64 {
        self.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS)
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Auth {
    /// Run in the empty room (`--bare`). Default true.
    #[serde(default = "default_bare")]
    pub bare: bool,
    /// Env var holding the API token; forwarded to `ANTHROPIC_API_KEY` under bare mode.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_env: Option<String>,
}

impl Default for Auth {
    fn default() -> Self {
        Self {
            bare: default_bare(),
            token_env: None,
        }
    }
}

fn default_bare() -> bool {
    true
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Interactive {
    /// Opt-in gate. When false, the engine never wires the ask_user tool, so
    /// claude cannot pause — behaviour is identical to a non-interactive run.
    #[serde(default)]
    pub enabled: bool,
    /// How long the engine waits on the operator's answer before reaping the run
    /// (exit 123). Unset = wait indefinitely until answered or cancelled.
    #[cfg_attr(feature = "ts", ts(optional = nullable, as = "Option<u32>"))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_timeout_secs: Option<u64>,
}

fn default_schema_version() -> u32 {
    1
}

/// Render the canonical run-spec JSON Schema: the schemars output with a stable
/// root `title`, a `specSchemaVersion` stamp, the `schema` field pinned to
/// `const: 1`, and a trailing newline. This exact string is what
/// `schema/kata-runspec.schema.json` must contain.
#[cfg(feature = "schema")]
pub fn generate_runspec_schema_json() -> String {
    let mut root = serde_json::to_value(schemars::schema_for!(RunSpec)).unwrap();
    let obj = root.as_object_mut().unwrap();
    obj.insert("title".to_string(), serde_json::json!("Kata run-spec"));
    obj.insert("specSchemaVersion".to_string(), serde_json::json!(1));
    // Pin the format-version field so `schema = 2` is flagged by editors.
    if let Some(schema_field) = obj
        .get_mut("properties")
        .and_then(|p| p.as_object_mut())
        .and_then(|props| props.get_mut("schema"))
        .and_then(|s| s.as_object_mut())
    {
        schema_field.insert("const".to_string(), serde_json::json!(1));
    }
    let mut s = serde_json::to_string_pretty(&root).unwrap();
    s.push('\n');
    s
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[cfg_attr(feature = "ts", ts(rename_all = "lowercase"))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Isolation {
    /// Run in `workdir` directly, no isolation.
    #[default]
    None,
    /// Branch off HEAD into a git worktree and run there. Requires a git workdir.
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
    let text =
        std::fs::read_to_string(path).map_err(|e| SpecError::Io(path.display().to_string(), e))?;
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

/// Environment variable names the engine injects into or reads from the `claude`
/// child and depends on for correctness. A spec must not set or unset these via
/// `env` / `env_remove`, since doing so would silently break the affected run
/// (e.g. stripping `KATA_ASK_PORT` disconnects the interactive ask bridge).
const RESERVED_CHILD_ENV: &[&str] = &["KATA_ASK_PORT"];

/// Render a curated starter run-spec as TOML text, wired to the schema via the
/// given `#:schema` directive on its first line. The three required fields are
/// filled with placeholders; a small set of high-value optionals are present and
/// commented. Everything else is left to editor autocomplete. The output parses
/// as a `RunSpec` and passes `validate`.
pub fn starter_toml(schema_directive: &str) -> String {
    format!(
        "{schema_directive}\n\
         schema = 1\n\
         name = \"my-run\"\n\
         task = \"Describe the job for the agent here.\"\n\
         # Directory the run executes in. Set this to your project's path.\n\
         workdir = \".\"\n\
         \n\
         [leash]\n\
         # Turn cap (exit 125). Unset = unbounded, limited only by the timeout.\n\
         # max_turns = 30\n\
         # Wall-clock cap in seconds (exit 124). Unset applies the 1800s default.\n\
         # timeout_secs = 1800\n\
         \n\
         [model]\n\
         # Model id (e.g. \"opus\"). Unset uses claude's default.\n\
         # id = \"opus\"\n\
         \n\
         [interactive]\n\
         # Give the agent an ask_user tool so it can pause for your input.\n\
         # enabled = true\n"
    )
}

/// Pure structural validation (no filesystem access).
pub fn validate(spec: &RunSpec) -> Result<(), Vec<String>> {
    let mut errs = Vec::new();
    if spec.schema != 1 {
        errs.push(format!(
            "unsupported schema version {} (expected 1)",
            spec.schema
        ));
    }
    if spec.name.trim().is_empty() {
        errs.push("name is required".into());
    }
    if spec.task.trim().is_empty() {
        errs.push("task is required".into());
    }
    if spec.workdir.trim().is_empty() {
        errs.push("workdir is required".into());
    }
    if spec.leash.max_turns == Some(0) {
        errs.push("leash.max_turns must be >= 1 when set".into());
    }
    if let Some(b) = spec.leash.max_budget_usd {
        // Reject non-finite (NaN/±inf) too: `b <= 0.0` is false for NaN, so a
        // non-finite budget would otherwise pass and later emit an invalid
        // `--max-budget-usd NaN`/`inf` argument.
        if !b.is_finite() || b <= 0.0 {
            errs.push("leash.max_budget_usd must be > 0".into());
        }
    }
    // Environment override layers must be well-formed and unambiguous. Note the
    // checks below are byte-exact: on Windows environment names fold case at
    // runtime, so `PATH`/`path` collide there but not here — matching the spec's
    // "exact variable names only" rule rather than the OS's platform-specific one.
    for key in spec.env.keys() {
        if key.trim().is_empty() {
            errs.push("env has an empty or whitespace-only key".into());
        } else if key.contains('=') {
            errs.push(format!(
                "env key '{key}' contains '=', which is not a valid variable name"
            ));
        } else if RESERVED_CHILD_ENV.contains(&key.as_str()) {
            errs.push(format!(
                "env key '{key}' is reserved by the engine and cannot be set"
            ));
        }
    }
    for name in &spec.env_remove {
        if name.trim().is_empty() {
            errs.push("env_remove has an empty or whitespace-only name".into());
        } else if RESERVED_CHILD_ENV.contains(&name.as_str()) {
            errs.push(format!(
                "env_remove name '{name}' is reserved by the engine and cannot be unset"
            ));
        }
    }
    // A key set and unset at once is ambiguous; the two fields must be disjoint.
    for key in spec.env.keys() {
        if spec.env_remove.contains(key) {
            errs.push(format!(
                "'{key}' appears in both env and env_remove; the two must be disjoint"
            ));
        }
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "schema")]
    #[test]
    fn runspec_schema_pins_version_and_carries_docs() {
        let json: serde_json::Value =
            serde_json::from_str(&super::generate_runspec_schema_json()).unwrap();
        assert_eq!(json["title"], "Kata run-spec");
        assert_eq!(json["specSchemaVersion"], 1);
        // The `schema` field is pinned so an editor flags a wrong format version.
        assert_eq!(json["properties"]["schema"]["const"], 1);
        // Field doc comments must survive as descriptions (editor hover text).
        assert_eq!(
            json["properties"]["workdir"]["description"],
            "Directory the run executes in."
        );
    }

    #[cfg(feature = "schema")]
    #[test]
    fn runspec_schema_artifact_is_fresh() {
        let generated = super::generate_runspec_schema_json();
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../schema/kata-runspec.schema.json"
        );
        if std::env::var_os("KATA_BLESS_SCHEMA").is_some() {
            let p = std::path::Path::new(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, &generated).unwrap();
            return;
        }
        let committed = std::fs::read_to_string(path).unwrap_or_else(|_| {
            panic!("schema/kata-runspec.schema.json missing — regenerate with \
                    KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema runspec_schema_artifact_is_fresh")
        });
        assert_eq!(
            committed, generated,
            "schema drift — regenerate with KATA_BLESS_SCHEMA=1 cargo test -p kata-core --features schema runspec_schema_artifact_is_fresh"
        );
    }

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
        assert_eq!(spec.leash.max_turns, None); // default: unlimited
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
        assert_eq!(spec.leash.max_turns, None);
    }

    #[test]
    fn validate_flags_missing_required_fields() {
        let spec = RunSpec {
            schema: 1,
            name: " ".into(),
            task: "".into(),
            workdir: "".into(),
            ..Default::default()
        };
        let errs = validate(&spec).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("name")));
        assert!(errs.iter().any(|e| e.contains("task")));
        assert!(errs.iter().any(|e| e.contains("workdir")));
    }

    #[test]
    fn validate_rejects_unknown_schema_and_zero_turns() {
        let mut spec = RunSpec {
            schema: 99,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.leash.max_turns = Some(0);
        let errs = validate(&spec).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("schema")));
        assert!(errs.iter().any(|e| e.contains("max_turns")));
    }

    #[test]
    fn validate_accepts_unset_max_turns() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.leash.max_turns = None; // unlimited
        assert!(validate(&spec).is_ok());
    }

    #[test]
    fn effective_timeout_defaults_when_unset() {
        let leash = Leash::default();
        assert_eq!(
            leash.timeout_secs, None,
            "default leash leaves timeout unset"
        );
        assert_eq!(
            leash.effective_timeout_secs(),
            DEFAULT_TIMEOUT_SECS,
            "an unset timeout must fall back to the default cap, never infinity"
        );
    }

    #[test]
    fn effective_timeout_honors_explicit_value() {
        let leash = Leash {
            timeout_secs: Some(42),
            ..Default::default()
        };
        assert_eq!(leash.effective_timeout_secs(), 42);
    }

    #[test]
    fn validate_passes_minimal() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert!(validate(&spec).is_ok());
    }

    #[test]
    fn schema_defaults_to_v1_when_omitted_or_default() {
        // Programmatic default is a valid v1 spec, not schema 0.
        let d = RunSpec {
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        assert_eq!(d.schema, 1);
        assert!(validate(&d).is_ok());

        // A spec file that omits `schema` parses as v1.
        let spec: RunSpec =
            toml::from_str("name = \"x\"\ntask = \"t\"\nworkdir = \"/w\"\n").unwrap();
        assert_eq!(spec.schema, 1);
    }

    fn full_spec() -> RunSpec {
        let mut plugins = std::collections::BTreeMap::new();
        plugins.insert(
            "github-tools".to_string(),
            PluginConfig {
                mcp: Some(true),
                env: vec!["GITHUB_TOKEN".into()],
            },
        );
        RunSpec {
            schema: 1,
            name: "triage".into(),
            description: Some("desc".into()),
            task: "do it".into(),
            context: Some("ctx".into()),
            workdir: "/repo".into(),
            identity: Identity {
                system_prompt: Some("you triage".into()),
                mode: IdentityMode::Replace,
            },
            skills: vec!["triage-flaky-test".into()],
            plugins,
            model: Model {
                id: Some("claude-sonnet-4-6".into()),
            },
            leash: Leash {
                max_turns: Some(8),
                timeout_secs: Some(600),
                max_budget_usd: None,
                isolation: Isolation::Worktree,
            },
            auth: Auth {
                bare: false,
                token_env: Some("ANTHROPIC_API_KEY".into()),
            },
            interactive: Interactive::default(),
            env: BTreeMap::new(),
            env_remove: Vec::new(),
        }
    }

    #[test]
    fn auth_defaults_to_bare_with_no_token() {
        let auth = Auth::default();
        assert!(auth.bare, "bare must default to true (the empty room)");
        assert_eq!(auth.token_env, None);
    }

    #[test]
    fn auth_absent_in_toml_defaults_to_bare() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert!(spec.auth.bare);
        assert_eq!(spec.auth.token_env, None);
    }

    #[test]
    fn auth_parses_explicit_table() {
        let toml = r#"
schema = 1
name = "a"
task = "t"
workdir = "/w"

[auth]
bare = false
token_env = "MY_KEY"
"#;
        let spec: RunSpec = toml::from_str(toml).unwrap();
        assert!(!spec.auth.bare);
        assert_eq!(spec.auth.token_env.as_deref(), Some("MY_KEY"));
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

    #[test]
    fn interactive_defaults_off() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert!(!spec.interactive.enabled, "interactive must default off");
        assert_eq!(spec.interactive.answer_timeout_secs, None);
    }

    #[test]
    fn interactive_parses_explicit_table() {
        let toml = r#"
schema = 1
name = "a"
task = "t"
workdir = "/w"

[interactive]
enabled = true
answer_timeout_secs = 600
"#;
        let spec: RunSpec = toml::from_str(toml).unwrap();
        assert!(spec.interactive.enabled);
        assert_eq!(spec.interactive.answer_timeout_secs, Some(600));
    }

    #[test]
    fn parses_max_budget_usd() {
        let toml = r#"
schema = 1
name = "a"
task = "t"
workdir = "/w"

[leash]
max_budget_usd = 5.0
"#;
        let spec: RunSpec = toml::from_str(toml).unwrap();
        assert_eq!(spec.leash.max_budget_usd, Some(5.0));
    }

    #[test]
    fn budget_defaults_to_none() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert_eq!(spec.leash.max_budget_usd, None);
    }

    #[test]
    fn validate_rejects_nonpositive_budget() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.leash.max_budget_usd = Some(0.0);
        let errs = validate(&spec).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("max_budget_usd")));
    }

    #[test]
    fn validate_accepts_positive_budget() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.leash.max_budget_usd = Some(2.5);
        assert!(validate(&spec).is_ok());
    }

    #[test]
    fn env_fields_default_empty_and_absent_in_toml() {
        let spec: RunSpec = toml::from_str(minimal_toml()).unwrap();
        assert!(spec.env.is_empty(), "env must default empty");
        assert!(spec.env_remove.is_empty(), "env_remove must default empty");
    }

    #[test]
    fn parses_env_and_env_remove_tables() {
        let toml = r#"
schema = 1
name = "a"
task = "t"
workdir = "/w"

env_remove = ["ANTHROPIC_API_KEY"]

[env]
ANTHROPIC_BASE_URL = "http://127.0.0.1:4000"
ANTHROPIC_AUTH_TOKEN = "proxy-token-value"
"#;
        let spec: RunSpec = toml::from_str(toml).unwrap();
        assert_eq!(
            spec.env.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("http://127.0.0.1:4000")
        );
        assert_eq!(
            spec.env.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str),
            Some("proxy-token-value")
        );
        assert_eq!(spec.env_remove, vec!["ANTHROPIC_API_KEY".to_string()]);
    }

    #[test]
    fn env_round_trips_through_toml_and_json() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.env
            .insert("ANTHROPIC_BASE_URL".into(), "http://x".into());
        spec.env_remove.push("ANTHROPIC_API_KEY".into());

        let toml_again: RunSpec = toml::from_str(&to_toml(&spec).unwrap()).unwrap();
        assert_eq!(spec, toml_again);

        let json_again: RunSpec =
            serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
        assert_eq!(spec, json_again);
    }

    #[test]
    fn validate_rejects_env_key_in_both_env_and_env_remove() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.env.insert("DUP".into(), "v".into());
        spec.env_remove.push("DUP".into());
        let errs = validate(&spec).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("DUP")),
            "a key in both env and env_remove must be rejected: {errs:?}"
        );
    }

    #[test]
    fn validate_rejects_empty_or_whitespace_env_key() {
        for bad in ["", "   "] {
            let mut spec = RunSpec {
                schema: 1,
                name: "n".into(),
                task: "t".into(),
                workdir: "/w".into(),
                ..Default::default()
            };
            spec.env.insert(bad.into(), "v".into());
            let errs = validate(&spec).unwrap_err();
            assert!(
                errs.iter().any(|e| e.contains("env")),
                "empty env key {bad:?} must be rejected: {errs:?}"
            );
        }
    }

    #[test]
    fn validate_rejects_empty_or_whitespace_env_remove_name() {
        for bad in ["", "   "] {
            let mut spec = RunSpec {
                schema: 1,
                name: "n".into(),
                task: "t".into(),
                workdir: "/w".into(),
                ..Default::default()
            };
            spec.env_remove.push(bad.into());
            let errs = validate(&spec).unwrap_err();
            assert!(
                errs.iter().any(|e| e.contains("env_remove")),
                "empty env_remove name {bad:?} must be rejected: {errs:?}"
            );
        }
    }

    #[test]
    fn validate_rejects_env_key_containing_equals() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.env.insert("A=B".into(), "v".into());
        let errs = validate(&spec).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("=")),
            "an env key containing '=' must be rejected: {errs:?}"
        );
    }

    #[test]
    fn validate_rejects_reserved_name_in_env() {
        // The engine injects KATA_ASK_PORT into the interactive child; letting a
        // spec set it would override the ask-bridge port and silently break the run.
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.env.insert("KATA_ASK_PORT".into(), "9999".into());
        let errs = validate(&spec).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("KATA_ASK_PORT")),
            "a reserved name in env must be rejected: {errs:?}"
        );
    }

    #[test]
    fn validate_rejects_reserved_name_in_env_remove() {
        // Stripping KATA_ASK_PORT would silently break the interactive ask bridge.
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.env_remove.push("KATA_ASK_PORT".into());
        let errs = validate(&spec).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("KATA_ASK_PORT")),
            "a reserved name in env_remove must be rejected: {errs:?}"
        );
    }

    #[test]
    fn validate_accepts_disjoint_nonempty_env() {
        let mut spec = RunSpec {
            schema: 1,
            name: "n".into(),
            task: "t".into(),
            workdir: "/w".into(),
            ..Default::default()
        };
        spec.env
            .insert("ANTHROPIC_BASE_URL".into(), "http://x".into());
        spec.env_remove.push("ANTHROPIC_API_KEY".into());
        assert!(validate(&spec).is_ok());
    }

    #[test]
    fn validate_rejects_nonfinite_budget() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut spec = RunSpec {
                schema: 1,
                name: "n".into(),
                task: "t".into(),
                workdir: "/w".into(),
                ..Default::default()
            };
            spec.leash.max_budget_usd = Some(bad);
            let errs = validate(&spec).unwrap_err();
            assert!(
                errs.iter().any(|e| e.contains("max_budget_usd")),
                "non-finite budget {bad} must be rejected"
            );
        }
    }

    #[test]
    fn starter_toml_is_valid_and_carries_the_directive() {
        let directive = "#:schema https://example.test/kata-runspec.schema.json";
        let text = super::starter_toml(directive);
        // First line is the schema directive.
        assert_eq!(text.lines().next().unwrap(), directive);
        // Parses as a RunSpec (the directive is a TOML comment, so it is ignored).
        let spec: RunSpec = toml::from_str(&text).unwrap();
        // And is structurally valid.
        validate(&spec).expect("starter must validate");
        // Sanity: the required fields are present and non-empty.
        assert!(!spec.name.trim().is_empty());
        assert!(!spec.task.trim().is_empty());
        assert!(!spec.workdir.trim().is_empty());
    }
}
