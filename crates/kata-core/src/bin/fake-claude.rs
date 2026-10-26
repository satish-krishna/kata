//! Test stand-in for the real `claude` CLI. Ignores all args except behavior
//! controlled by env vars, and emits canned stream-json on stdout.
//!
//! KATA_FAKE_MODE = "ok" (default) | "sleep" | "fail" | "manyturns" | "writefile" | "stderr" | "blockstdin" | "closestdio" | "ask" | "approve" | "budget" | "envreport" | "settingsecho" | "argsfiles" | "subagent" | "hooks" | "noinit" | "consoleprobe" | "consoleprobe-relay"
use std::io::Write;
use std::{thread, time::Duration};

fn main() {
    let mode = std::env::var("KATA_FAKE_MODE").unwrap_or_else(|_| "ok".into());
    let mut out = std::io::stdout();
    // The start report, in the shape of tests/fixtures/claude-init.json (fields
    // the engine does not read are left out). Its model differs from any spec's.
    if mode != "noinit" {
        let init = serde_json::json!({
            "type": "system",
            "subtype": "init",
            "model": "claude-fake-1",
            "permissionMode": "bypassPermissions",
            "output_style": "default",
            "skills": ["fake-skill"],
            "plugins": [
                {"name": "fake-plugin", "path": "<plugin-path>", "source": "fake-plugin@fake"},
                {"name": "cc-plugin-fake", "path": "builtin", "source": "cc-plugin-fake@builtin"}
            ],
            "mcp_servers": [
                {"name": "kata-ask", "status": "connected"},
                {"name": "claude.ai Fake", "source": "claudeai", "status": "needs-auth"}
            ]
        });
        let _ = writeln!(out, "{init}");
        let _ = out.flush();
    }

    match mode.as_str() {
        "noinit" => {
            // A run that ends without ever sending the start report.
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#
            );
            let _ = out.flush();
        }
        "hooks" => {
            // The hook lifecycle `--include-hook-events` adds: a hook starts and
            // responds (shapes from tests/fixtures/claude-hook-events.jsonl,
            // with a matcher in `hook_name`), then the run lingers briefly so a
            // test can change the setup on disk while it is live.
            for subtype in ["hook_started", "hook_response"] {
                let _ = writeln!(
                    out,
                    r#"{{"type":"system","subtype":"{subtype}","hook_id":"h1","hook_name":"PreToolUse:Bash","hook_event":"PreToolUse","session_id":"s"}}"#
                );
            }
            let _ = out.flush();
            thread::sleep(Duration::from_millis(400));
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#
            );
            let _ = out.flush();
        }
        "consoleprobe-relay" => {
            // Runs without a console (the test starts it detached) and starts the probe the way
            // KATA_RELAY_HIDDEN says: through kata_core::proc, or as a plain Command (control).
            let exe = std::env::current_exe().unwrap();
            let mut cmd = if std::env::var_os("KATA_RELAY_HIDDEN").is_some() {
                kata_core::proc::hidden_command(&exe).unwrap()
            } else {
                // Test code: the control child without the hidden flag.
                #[allow(clippy::disallowed_methods)]
                std::process::Command::new(&exe)
            };
            let output = cmd
                .env("KATA_FAKE_MODE", "consoleprobe")
                .stdin(std::process::Stdio::null())
                .output()
                .unwrap();
            let _ = out.write_all(&output.stdout);
            let _ = out.flush();
        }
        "consoleprobe" | "consoleprobe-child" => {
            let prefix = if mode == "consoleprobe" { "" } else { "child-" };
            let _ = writeln!(out, "{prefix}window={}", console_window());
            let _ = out.flush();
            if mode == "consoleprobe" {
                // Test code: a plain Command with no flags shows what a child inherits.
                #[allow(clippy::disallowed_methods)]
                let status = std::process::Command::new(std::env::current_exe().unwrap())
                    .env("KATA_FAKE_MODE", "consoleprobe-child")
                    .status();
                let _ = status;
            }
        }
        "sleep" => {
            if let Some(path) = std::env::var_os("KATA_FAKE_PIDFILE") {
                let _ = std::fs::write(path, std::process::id().to_string());
            }
            let _ = writeln!(
                out,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"working"}}]}}}}"#
            );
            let _ = out.flush();
            thread::sleep(Duration::from_secs(60));
        }
        "fail" => {
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"error","is_error":true,"num_turns":1,"total_cost_usd":0.0,"result":"boom"}}"#
            );
            let _ = out.flush();
            std::process::exit(1);
        }
        "manyturns" => {
            // Emit assistant turns on a slow drip so the engine's turn cap fires
            // before the process finishes on its own.
            for i in 1..=10 {
                let _ = writeln!(
                    out,
                    r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"turn {i}"}}]}}}}"#
                );
                let _ = out.flush();
                thread::sleep(Duration::from_millis(200));
            }
        }
        "splitturns" => {
            // Real claude's shape: each content block of one message is its own
            // line sharing message.id, a redacted thinking block first.
            for i in 1..=10 {
                let _ = writeln!(
                    out,
                    r#"{{"type":"assistant","message":{{"id":"m{i}","content":[{{"type":"thinking","thinking":"","signature":"s"}}]}}}}"#
                );
                let _ = writeln!(
                    out,
                    r#"{{"type":"assistant","message":{{"id":"m{i}","content":[{{"type":"text","text":"turn {i}"}}]}}}}"#
                );
                let _ = out.flush();
                thread::sleep(Duration::from_millis(200));
            }
        }
        "blockstdin" => {
            // Block until stdin reaches EOF, then complete. With an inherited,
            // open-but-idle stdin this never returns on its own; with Stdio::null()
            // the read EOFs immediately. Proves Kata hands claude a
            // non-interactive stdin so it can't hang waiting for input.
            use std::io::Read;
            let mut buf = String::new();
            let _ = std::io::stdin().read_to_string(&mut buf);
            let _ = writeln!(
                out,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"hi"}}]}}}}"#
            );
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#
            );
            let _ = out.flush();
        }
        "stderr" => {
            // Write a human-readable diagnostic to stderr (as the real claude does
            // for things like "Not logged in"), then complete normally on stdout.
            let mut err = std::io::stderr();
            let _ = writeln!(err, "diagnostic from claude on stderr");
            let _ = err.flush();
            let _ = writeln!(
                out,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"hi"}}]}}}}"#
            );
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#
            );
            let _ = out.flush();
        }
        "closestdio" => {
            // Close stdout+stderr so the parent's reader threads hit EOF (the
            // channel disconnects), then keep running. Exercises the run loop's
            // "streams closed but child still alive" path: the child must be
            // reaped by the deadline, not blocked on forever in child.wait().
            #[cfg(unix)]
            unsafe {
                use std::os::fd::{FromRawFd, OwnedFd};
                drop(OwnedFd::from_raw_fd(1));
                drop(OwnedFd::from_raw_fd(2));
            }
            #[cfg(windows)]
            unsafe {
                use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
                let ho = std::io::stdout().as_raw_handle();
                let he = std::io::stderr().as_raw_handle();
                drop(OwnedHandle::from_raw_handle(ho));
                drop(OwnedHandle::from_raw_handle(he));
            }
            thread::sleep(Duration::from_secs(5));
        }
        "ask" => {
            // Play the role of the `kata mcp-ask` MCP server: connect to the
            // engine's ask bridge on KATA_ASK_PORT, send a question frame, then
            // block reading the answer line. With no answer (the deadline test)
            // this blocks forever and the engine reaps the run with exit 123.
            use std::io::{BufRead, BufReader, Write as _};
            use std::net::TcpStream;
            let port: u16 = std::env::var("KATA_ASK_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            // The suppressed ask_user tool_use keeps starts_turn=true so
            // the engine counts the turn but emits no tool.use event.
            let _ = writeln!(
                out,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"toolu_ask","name":"mcp__kata-ask__ask_user","input":{{"questions":[]}}}}]}}}}"#
            );
            let _ = out.flush();
            if let Ok(sock) = TcpStream::connect(("127.0.0.1", port)) {
                let mut write_half = sock.try_clone().expect("clone sock");
                let _ = writeln!(
                    write_half,
                    r#"{{"kind":"ask","questions":[{{"kind":"text","header":"h","question":"q?"}}]}}"#
                );
                let _ = write_half.flush();
                // Wait (possibly forever — exercises the answer-deadline) for the answer.
                let mut reader = BufReader::new(sock);
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
            }
            let _ = writeln!(
                out,
                r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"toolu_ask","content":"answered"}}]}}}}"#
            );
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#
            );
            let _ = out.flush();
        }
        "approve" => {
            // Play the role of the `kata mcp-ask` server serving `approve_tool`:
            // ask the engine to approve one Bash call, then report the verdict
            // back on the stream so a test can assert it reached the child. With
            // no decision (the deadline test) the read blocks and the engine
            // reaps the run with exit 123.
            //
            // KATA_FAKE_TOOL / KATA_FAKE_TOOL_INPUT override the call being
            // approved, so one mode covers allow rules, deny rules, and the
            // unmatched policy.
            use std::io::{BufRead, BufReader, Write as _};
            use std::net::TcpStream;
            let port: u16 = std::env::var("KATA_ASK_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let tool = std::env::var("KATA_FAKE_TOOL").unwrap_or_else(|_| "Bash".into());
            let input = std::env::var("KATA_FAKE_TOOL_INPUT")
                .unwrap_or_else(|_| r#"{"command":"rm -rf build/"}"#.into());
            let mut verdict = String::from("(no verdict)");
            if let Ok(sock) = TcpStream::connect(("127.0.0.1", port)) {
                let mut write_half = sock.try_clone().expect("clone sock");
                let _ = writeln!(
                    write_half,
                    r#"{{"kind":"approve","tool":"{tool}","input":{input}}}"#
                );
                let _ = write_half.flush();
                let mut reader = BufReader::new(sock);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) > 0 {
                    // Render a stable summary rather than echoing the raw frame:
                    // the bridge frame is engine-internal and free to change, and
                    // a golden fixture must not pin it.
                    let v: serde_json::Value =
                        serde_json::from_str(line.trim()).unwrap_or(serde_json::Value::Null);
                    let word = if v["allow"].as_bool().unwrap_or(false) {
                        "allow"
                    } else {
                        "deny"
                    };
                    verdict = match v["message"].as_str().filter(|m| !m.is_empty()) {
                        Some(m) => format!("verdict: {word} - {m}"),
                        None => format!("verdict: {word}"),
                    };
                }
            }
            // The verdict rides back as assistant text so the test can assert
            // that the engine's decision actually reached the child.
            let text = serde_json::json!({
                "type": "assistant",
                "message": { "content": [{ "type": "text", "text": verdict }] }
            });
            let _ = writeln!(out, "{text}");
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#
            );
            let _ = out.flush();
        }
        "budget" => {
            // Mirror real claude hitting --max-budget-usd: one assistant turn, then
            // a terminal result tagged error_max_budget_usd with a non-zero spend,
            // and a generic exit 1. The engine must override that 1 to exit 122.
            let _ = writeln!(
                out,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"working"}}]}}}}"#
            );
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"error_max_budget_usd","is_error":true,"num_turns":1,"total_cost_usd":0.05,"result":null,"errors":["Reached maximum budget ($0.01)"]}}"#
            );
            let _ = out.flush();
            std::process::exit(1);
        }
        "envreport" => {
            // Report the child's effective environment so a test can assert on what
            // Kata actually handed the child. KATA_ENV_PROBE names the variables to
            // report (comma-separated); each is emitted as one assistant-text line
            // "ENV <name>=<value>", or "ENV <name>=<unset>" when absent.
            let probe = std::env::var("KATA_ENV_PROBE").unwrap_or_default();
            for name in probe.split(',').filter(|s| !s.is_empty()) {
                let val = std::env::var(name).unwrap_or_else(|_| "<unset>".into());
                let line = serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [
                        { "type": "text", "text": format!("ENV {name}={val}") }
                    ]}
                });
                let _ = writeln!(out, "{line}");
            }
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#
            );
            let _ = out.flush();
        }
        "settingsecho" => {
            // Report the `--settings <path>` claude was given, so a test can
            // assert on the *content* Kata generated without depending on the
            // temp dir surviving the run. Finds the flag in argv (fake-claude
            // otherwise ignores its args) and echoes the file's raw bytes back
            // as one assistant-text line prefixed "SETTINGS ".
            let args: Vec<String> = std::env::args().collect();
            let settings_path = args
                .iter()
                .position(|a| a == "--settings")
                .and_then(|i| args.get(i + 1));
            let body = match settings_path {
                Some(p) => {
                    std::fs::read_to_string(p).unwrap_or_else(|e| format!("<read error: {e}>"))
                }
                None => "<no --settings flag>".into(),
            };
            let line = serde_json::json!({
                "type": "assistant",
                "message": { "content": [
                    { "type": "text", "text": format!("SETTINGS {body}") }
                ]}
            });
            let _ = writeln!(out, "{line}");
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#
            );
            let _ = out.flush();
        }
        "argsfiles" => {
            // Report what Kata passed, as stderr lines the engine surfaces as log
            // events: `ARGV <json array>`, `SETTINGS <file body>` and `MCP <file
            // body>` for the files named by `--settings` and `--mcp-config`, and
            // one `PLUGINDIR <json array>` per `--plugin-dir` listing every file
            // (relative, forward slashes) under it, because that folder is gone
            // after the run, then `CWD <path>` and `ADDDIRMD <value>`: the
            // child's working folder and its value of
            // `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` (empty when unset).
            let args: Vec<String> = std::env::args().skip(1).collect();
            let mut err = std::io::stderr();
            let _ = writeln!(err, "ARGV {}", serde_json::json!(args));
            let value_of = |flag: &str| {
                args.iter()
                    .position(|a| a == flag)
                    .and_then(|i| args.get(i + 1))
            };
            for (flag, tag) in [("--settings", "SETTINGS"), ("--mcp-config", "MCP")] {
                if let Some(p) = value_of(flag) {
                    let body = std::fs::read_to_string(p)
                        .unwrap_or_else(|e| format!("<read error: {e}>"))
                        .replace(['\r', '\n'], " ");
                    let _ = writeln!(err, "{tag} {body}");
                }
            }
            fn walk(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>) {
                let Ok(rd) = std::fs::read_dir(dir) else {
                    return;
                };
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(base, &p, out);
                    } else if let Ok(rel) = p.strip_prefix(base) {
                        out.push(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
            // One `PLUGINDIR` line per `--plugin-dir`, in the order passed.
            for dir in args
                .windows(2)
                .filter(|w| w[0] == "--plugin-dir")
                .map(|w| &w[1])
            {
                let base = std::path::PathBuf::from(dir);
                let mut files = Vec::new();
                walk(&base, &base, &mut files);
                files.sort();
                let _ = writeln!(err, "PLUGINDIR {}", serde_json::json!(files));
            }
            let _ = writeln!(
                err,
                "CWD {}",
                std::env::current_dir().unwrap_or_default().display()
            );
            let _ = writeln!(
                err,
                "ADDDIRMD {}",
                std::env::var("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD").unwrap_or_default()
            );
            let _ = err.flush();
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#
            );
            let _ = out.flush();
        }
        "writefile" => {
            // Write a file into cwd so a worktree-isolated run produces a real diff.
            let _ = std::fs::write("agent-made.txt", "line1\nline2\n");
            let _ = writeln!(
                out,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"wrote a file"}}]}}}}"#
            );
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#
            );
            let _ = out.flush();
        }
        "subagent" => {
            // One Agent call whose subagent reads a file, mirroring a real
            // claude 2.1.296 stream: inner messages carry parent_tool_use_id,
            // and the Agent result's content is an array of text blocks.
            for line in [
                r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_A","name":"Agent","input":{"description":"Read probe","subagent_type":"general-purpose","prompt":"Read probe.txt"}}]}}"#,
                r#"{"type":"user","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"text","text":"Read probe.txt"}]}}"#,
                r#"{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"text","text":"reading"},{"type":"tool_use","id":"toolu_B","name":"Read","input":{"file_path":"probe.txt"}}]}}"#,
                r#"{"type":"user","parent_tool_use_id":"toolu_A","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_B","content":"1\thello"}]}}"#,
                r#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_A","content":[{"type":"text","text":"probe.txt says hello"}]}]}}"#,
                r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"done"}]}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":0.01,"result":"done"}"#,
            ] {
                let _ = writeln!(out, "{line}");
            }
            let _ = out.flush();
        }
        _ => {
            let _ = writeln!(
                out,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"hi"}}]}}}}"#
            );
            let _ = writeln!(
                out,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":"echo hi"}}}}]}}}}"#
            );
            let _ = writeln!(
                out,
                r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":2,"total_cost_usd":0.02,"result":"done"}}"#
            );
            let _ = out.flush();
        }
    }
}

/// 1 when this process has a console window, else 0.
#[cfg(windows)]
fn console_window() -> u8 {
    // SAFETY: GetConsoleWindow takes no arguments and only reads process state.
    u8::from(!unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() }.is_null())
}

#[cfg(not(windows))]
fn console_window() -> u8 {
    0
}
