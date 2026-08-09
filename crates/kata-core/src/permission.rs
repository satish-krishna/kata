//! Permission rule matching for `[permissions] mode = "prompt"` runs.
//!
//! When a run cannot use `--dangerously-skip-permissions` — typically because
//! the machine's managed settings set `permissions.disableBypassPermissionsMode`
//! — the engine instead points claude at Kata's own MCP tool with
//! `--permission-prompt-tool`. Every call claude would have prompted a human
//! about arrives here as a `(tool, input)` pair, and this module answers it from
//! the spec's `allow` / `deny` rules.
//!
//! The rule grammar mirrors claude's own (`Tool` or `Tool(specifier)`) so a spec
//! author does not have to learn a second one, but the matching happens
//! **engine-side**: the prompt tool is the last step of claude's evaluation
//! chain, so a rule here can never widen what managed deny rules already block —
//! those calls never reach us.

use serde_json::Value;

/// One parsed permission rule: a tool-name pattern plus an optional specifier
/// pattern matched against the call's target (a Bash command, a file path, …).
/// Both patterns support `*` as a wildcard for any run of characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub tool: String,
    pub specifier: Option<String>,
}

/// Parse `Tool` or `Tool(specifier)`. Returns `None` for a malformed rule: an
/// empty tool name, or an unbalanced/misplaced parenthesis. `validate` uses this
/// to reject a bad rule at spec-load time rather than at permission time.
///
/// Ported to TypeScript as `ruleIsWellFormed` in `app/src/lib/mock.ts` for the
/// Workbench's browser-only validation fallback; keep the two in step.
pub fn parse_rule(raw: &str) -> Option<Rule> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match raw.find('(') {
        None => {
            if raw.contains(')') {
                return None;
            }
            Some(Rule {
                tool: raw.to_string(),
                specifier: None,
            })
        }
        Some(open) => {
            if !raw.ends_with(')') {
                return None;
            }
            let tool = raw[..open].trim();
            if tool.is_empty() {
                return None;
            }
            let spec = &raw[open + 1..raw.len() - 1];
            Some(Rule {
                tool: tool.to_string(),
                specifier: Some(spec.trim().to_string()),
            })
        }
    }
}

/// Glob match supporting `*` (any run of characters, including none) anywhere in
/// `pattern`. Every other character matches literally. Case-sensitive, matching
/// claude's own rule semantics.
fn glob_matches(pattern: &str, text: &str) -> bool {
    // Iterative two-pointer backtracking: linear in the common case, and never
    // recurses, so a pathological pattern cannot blow the stack.
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut resume) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            resume = ti;
            pi += 1;
        } else if let Some(s) = star {
            // Backtrack: let the last `*` swallow one more character.
            pi = s + 1;
            resume += 1;
            ti = resume;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// The string a rule's specifier is matched against for a given tool call.
///
/// Mirrors what an operator would read on an approval card: the command for a
/// shell call, the path for a file call, the query for a search. Anything else
/// falls back to the compact JSON of the whole input, so a specifier can still
/// pin an unusual tool without the engine needing to know its schema.
pub fn target_of(tool: &str, input: &Value) -> String {
    let field = |name: &str| input.get(name).and_then(|v| v.as_str());
    let base = tool.rsplit("__").next().unwrap_or(tool);
    let picked = match base {
        "Bash" | "BashOutput" => field("command"),
        "Read" | "Write" | "Edit" | "NotebookEdit" => field("file_path"),
        "Glob" | "Grep" => field("pattern"),
        "WebFetch" => field("url"),
        "WebSearch" => field("query"),
        _ => None,
    };
    match picked {
        Some(s) => s.to_string(),
        None => match input {
            Value::Null => String::new(),
            other => other.to_string(),
        },
    }
}

fn rule_matches(rule: &Rule, tool: &str, input: &Value) -> bool {
    if !glob_matches(&rule.tool, tool) {
        return false;
    }
    match &rule.specifier {
        None => true,
        Some(spec) => glob_matches(spec, &target_of(tool, input)),
    }
}

/// Which list resolved a call, for the audit trail on `permission.decided`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Matched {
    Allow,
    Deny,
}

/// Resolve a call against the spec's rules. `None` means no rule matched and the
/// caller must fall back to `permissions.unmatched`.
///
/// Deny is evaluated before allow, matching claude's own precedence: a broad
/// deny cannot carry allowlist exceptions, so `deny = ["Bash(rm *)"]` blocks
/// `rm -rf /` even alongside `allow = ["Bash"]`.
pub fn decide(allow: &[String], deny: &[String], tool: &str, input: &Value) -> Option<Matched> {
    for raw in deny {
        if let Some(rule) = parse_rule(raw) {
            if rule_matches(&rule, tool, input) {
                return Some(Matched::Deny);
            }
        }
    }
    for raw in allow {
        if let Some(rule) = parse_rule(raw) {
            if rule_matches(&rule, tool, input) {
                return Some(Matched::Allow);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_bare_tool_and_specifier_forms() {
        assert_eq!(
            parse_rule("Read"),
            Some(Rule {
                tool: "Read".into(),
                specifier: None
            })
        );
        assert_eq!(
            parse_rule("Bash(git status)"),
            Some(Rule {
                tool: "Bash".into(),
                specifier: Some("git status".into())
            })
        );
        // An empty specifier is legal and matches only an empty target.
        assert_eq!(
            parse_rule("Bash()"),
            Some(Rule {
                tool: "Bash".into(),
                specifier: Some(String::new())
            })
        );
    }

    #[test]
    fn rejects_malformed_rules() {
        for bad in ["", "   ", "Bash(git status", "Bash)", "(git)", "Bash(a)b"] {
            assert!(parse_rule(bad).is_none(), "{bad:?} must not parse");
        }
    }

    #[test]
    fn glob_matches_prefix_infix_and_exact() {
        assert!(glob_matches("git *", "git status"));
        assert!(glob_matches("git *", "git "));
        assert!(!glob_matches("git *", "git"));
        assert!(glob_matches("*", "anything at all"));
        assert!(glob_matches("mcp__github__get_*", "mcp__github__get_issue"));
        assert!(!glob_matches(
            "mcp__github__get_*",
            "mcp__github__list_issues"
        ));
        assert!(glob_matches("npm run *test*", "npm run unit-test-fast"));
        assert!(glob_matches("exact", "exact"));
        assert!(!glob_matches("exact", "exactly"));
    }

    // The classic backtracking trap: many stars against a long non-matching
    // subject. Must terminate (and say no) rather than hang the run loop.
    #[test]
    fn glob_terminates_on_pathological_pattern() {
        let pattern = "*a*a*a*a*a*a*b";
        let text = "a".repeat(200);
        assert!(!glob_matches(pattern, &text));
    }

    #[test]
    fn bare_tool_rule_matches_every_call_to_that_tool() {
        let allow = vec!["Read".to_string()];
        assert_eq!(
            decide(&allow, &[], "Read", &json!({"file_path": "/etc/hosts"})),
            Some(Matched::Allow)
        );
        assert_eq!(decide(&allow, &[], "Write", &json!({})), None);
    }

    #[test]
    fn specifier_matches_the_bash_command() {
        let allow = vec!["Bash(git *)".to_string()];
        assert_eq!(
            decide(&allow, &[], "Bash", &json!({"command": "git status"})),
            Some(Matched::Allow)
        );
        assert_eq!(
            decide(&allow, &[], "Bash", &json!({"command": "rm -rf /"})),
            None
        );
    }

    #[test]
    fn deny_wins_over_a_broader_allow() {
        let allow = vec!["Bash".to_string()];
        let deny = vec!["Bash(rm *)".to_string()];
        assert_eq!(
            decide(&allow, &deny, "Bash", &json!({"command": "rm -rf /"})),
            Some(Matched::Deny)
        );
        assert_eq!(
            decide(&allow, &deny, "Bash", &json!({"command": "ls"})),
            Some(Matched::Allow)
        );
    }

    #[test]
    fn target_is_the_readable_field_per_tool() {
        assert_eq!(target_of("Bash", &json!({"command": "ls -la"})), "ls -la");
        assert_eq!(target_of("Read", &json!({"file_path": "/a/b"})), "/a/b");
        assert_eq!(target_of("Grep", &json!({"pattern": "TODO"})), "TODO");
        assert_eq!(
            target_of("WebFetch", &json!({"url": "https://x.test"})),
            "https://x.test"
        );
        // An unknown tool falls back to the whole input, so a rule can still pin it.
        assert_eq!(target_of("Weird", &json!({"a": 1})), r#"{"a":1}"#);
    }

    #[test]
    fn mcp_tool_names_match_by_glob_and_by_base_name_target() {
        let allow = vec!["mcp__github__*".to_string()];
        assert_eq!(
            decide(&allow, &[], "mcp__github__list_issues", &json!({})),
            Some(Matched::Allow)
        );
        assert_eq!(
            decide(&allow, &[], "mcp__gitlab__list_issues", &json!({})),
            None
        );
    }

    #[test]
    fn unparseable_rules_are_inert_rather_than_matching_everything() {
        // `validate` rejects these at load time; if one somehow reaches here it
        // must never be treated as a wildcard.
        let deny = vec!["Bash(unclosed".to_string()];
        assert_eq!(
            decide(&[], &deny, "Bash", &json!({"command": "ls"})),
            None,
            "a malformed rule must not match"
        );
    }

    #[test]
    fn no_rules_leaves_the_call_unmatched() {
        assert_eq!(decide(&[], &[], "Bash", &json!({"command": "ls"})), None);
    }
}
