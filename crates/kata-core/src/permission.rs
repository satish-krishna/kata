//! Rule syntax and call rendering for `[permissions] mode = "prompt"` runs.
//!
//! Kata does **not** match rules. The spec's `allow` / `deny` are written into a
//! generated settings file (see `run.rs`) and claude enforces them itself. That
//! is deliberate: claude resolves a call against its settings *before* it would
//! consult `--permission-prompt-tool`, and it auto-approves a set of read-only
//! commands (`git status`, `cat`, `ls`) without consulting anything. A matcher
//! living here would therefore be blind to exactly the calls a `deny` most needs
//! to cover, and would duplicate claude's matching semantics badly enough to
//! drift from them.
//!
//! What remains here is what the engine genuinely owns:
//!
//! - [`parse_rule`] — syntax validation, so `spec::validate` rejects a malformed
//!   rule at load time rather than letting claude ignore it at run time.
//! - [`target_of`] — rendering a call's target (the shell command, the file path)
//!   for the `permission.*` events an operator reads.
//!
//! The grammar is claude's own (`Tool` or `Tool(specifier)`, `*` as a wildcard,
//! space before the `*` for prefix matching) because the rules are handed to
//! claude verbatim.

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
}
