use crate::assemble::Assembled;
use crate::spec::{IdentityMode, RunSpec};

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeInvocation {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Env vars to set on the child, resolved by name from the current process env.
    pub env: Vec<(String, String)>,
}

pub fn build_invocation(spec: &RunSpec, assembled: &Assembled) -> ClaudeInvocation {
    let program = std::env::var("KATA_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string());

    let mut args: Vec<String> = Vec::new();
    if spec.auth.bare {
        args.push("--bare".into());
    }
    args.push("-p".into());
    args.push(compose_prompt(spec));

    if let Some(sp) = spec.identity.system_prompt.as_ref().filter(|s| !s.trim().is_empty()) {
        match spec.identity.mode {
            IdentityMode::Append => {
                if let Some(file) = &assembled.system_prompt_file {
                    args.push("--append-system-prompt-file".into());
                    args.push(file.clone());
                }
            }
            IdentityMode::Replace => {
                args.push("--system-prompt".into());
                args.push(sp.clone());
            }
        }
    }

    if let Some(dir) = &assembled.plugin_dir {
        args.push("--plugin-dir".into());
        args.push(dir.clone());
    }

    if let Some(id) = &spec.model.id {
        args.push("--model".into());
        args.push(id.clone());
    }

    args.push("--output-format".into());
    args.push("stream-json".into());
    args.push("--verbose".into()); // claude requires --verbose with stream-json under --print
    args.push("--dangerously-skip-permissions".into());
    // NOTE: claude 2.1.x has NO --max-turns flag; the turn cap is enforced
    // engine-side in run.rs (kill the child when turns exceed leash.max_turns).

    let mut env = Vec::new();
    for cfg in spec.plugins.values() {
        for name in &cfg.env {
            if let Ok(val) = std::env::var(name) {
                env.push((name.clone(), val));
            }
        }
    }

    // The empty room has no ambient credentials, so a bare run forwards the API
    // key named by auth.token_env (resolved from the host env) as the standard
    // ANTHROPIC_API_KEY. When not bare, claude uses the user's logged-in session.
    if spec.auth.bare {
        if let Some(name) = spec.auth.token_env.as_ref().filter(|n| !n.trim().is_empty()) {
            if let Ok(val) = std::env::var(name) {
                if !val.trim().is_empty() {
                    env.push(("ANTHROPIC_API_KEY".into(), val));
                }
            }
        }
    }

    ClaudeInvocation { program, args, cwd: spec.workdir.clone(), env }
}

fn compose_prompt(spec: &RunSpec) -> String {
    match spec.context.as_ref().map(|c| c.trim()).filter(|c| !c.is_empty()) {
        Some(ctx) => format!("{}\n\n{}", spec.task.trim(), ctx),
        None => spec.task.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assemble::Assembled;
    use crate::spec::*;

    fn spec() -> RunSpec {
        let mut s = RunSpec { schema: 1, name: "n".into(), task: "do it".into(), workdir: "/repo".into(), ..Default::default() };
        s.leash.max_turns = 8;
        s
    }

    fn assembled_with(plugin_dir: Option<&str>, sys: Option<&str>) -> Assembled {
        Assembled::for_test(plugin_dir.map(String::from), sys.map(String::from))
    }

    #[test]
    fn base_command_has_bare_print_streamjson_verbose_bypass() {
        let inv = build_invocation(&spec(), &assembled_with(None, None));
        assert_eq!(inv.cwd, "/repo");
        assert!(inv.args.contains(&"--bare".to_string()));
        assert!(inv.args.contains(&"-p".to_string()));
        assert!(inv.args.windows(2).any(|w| w[0] == "--output-format" && w[1] == "stream-json"));
        assert!(inv.args.contains(&"--verbose".to_string()));
        assert!(inv.args.contains(&"--dangerously-skip-permissions".to_string()));
        // claude 2.1.x has no --max-turns flag; the engine enforces the cap instead
        assert!(!inv.args.iter().any(|a| a == "--max-turns"));
        // no plugin dir, no system prompt, no model
        assert!(!inv.args.iter().any(|a| a == "--plugin-dir"));
        assert!(!inv.args.iter().any(|a| a == "--model"));
        assert!(!inv.args.iter().any(|a| a.starts_with("--append-system-prompt")));
    }

    #[test]
    fn prompt_is_task_then_context() {
        let mut s = spec();
        s.context = Some("background".into());
        let inv = build_invocation(&s, &assembled_with(None, None));
        let p_idx = inv.args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(inv.args[p_idx + 1], "do it\n\nbackground");
    }

    #[test]
    fn append_mode_uses_system_prompt_file() {
        let mut s = spec();
        s.identity.system_prompt = Some("you triage".into());
        s.identity.mode = IdentityMode::Append;
        let inv = build_invocation(&s, &assembled_with(None, Some("/tmp/system.txt")));
        assert!(inv.args.windows(2).any(|w| w[0] == "--append-system-prompt-file" && w[1] == "/tmp/system.txt"));
    }

    #[test]
    fn replace_mode_passes_prompt_inline() {
        let mut s = spec();
        s.identity.system_prompt = Some("be terse".into());
        s.identity.mode = IdentityMode::Replace;
        let inv = build_invocation(&s, &assembled_with(None, None));
        assert!(inv.args.windows(2).any(|w| w[0] == "--system-prompt" && w[1] == "be terse"));
    }

    #[test]
    fn includes_plugin_dir_and_model_when_present() {
        let mut s = spec();
        s.model.id = Some("claude-sonnet-4-6".into());
        let inv = build_invocation(&s, &assembled_with(Some("/tmp/kit"), None));
        assert!(inv.args.windows(2).any(|w| w[0] == "--plugin-dir" && w[1] == "/tmp/kit"));
        assert!(inv.args.windows(2).any(|w| w[0] == "--model" && w[1] == "claude-sonnet-4-6"));
    }

    #[test]
    fn bare_flag_omitted_when_disabled() {
        let mut s = spec();
        s.auth.bare = false;
        let inv = build_invocation(&s, &assembled_with(None, None));
        assert!(!inv.args.contains(&"--bare".to_string()));
    }

    #[test]
    fn forwards_token_env_as_api_key_when_bare() {
        std::env::set_var("KATA_TEST_APIKEY", "sk-test-123");
        let mut s = spec();
        s.auth.bare = true;
        s.auth.token_env = Some("KATA_TEST_APIKEY".into());
        let inv = build_invocation(&s, &assembled_with(None, None));
        assert!(inv.env.iter().any(|(k, v)| k == "ANTHROPIC_API_KEY" && v == "sk-test-123"));
        std::env::remove_var("KATA_TEST_APIKEY");
    }

    #[test]
    fn ignores_token_env_when_not_bare() {
        std::env::set_var("KATA_TEST_APIKEY2", "sk-test-456");
        let mut s = spec();
        s.auth.bare = false;
        s.auth.token_env = Some("KATA_TEST_APIKEY2".into());
        let inv = build_invocation(&s, &assembled_with(None, None));
        assert!(!inv.env.iter().any(|(k, _)| k == "ANTHROPIC_API_KEY"));
        std::env::remove_var("KATA_TEST_APIKEY2");
    }

    #[test]
    fn forwards_named_env_vars_when_set() {
        std::env::set_var("KATA_TEST_TOKEN", "secret");
        let mut s = spec();
        let cfg = PluginConfig { env: vec!["KATA_TEST_TOKEN".into(), "KATA_TEST_ABSENT".into()], ..Default::default() };
        s.plugins.insert("gh".into(), cfg);
        let inv = build_invocation(&s, &assembled_with(None, None));
        assert!(inv.env.iter().any(|(k, v)| k == "KATA_TEST_TOKEN" && v == "secret"));
        assert!(!inv.env.iter().any(|(k, _)| k == "KATA_TEST_ABSENT"));
        std::env::remove_var("KATA_TEST_TOKEN");
    }
}
