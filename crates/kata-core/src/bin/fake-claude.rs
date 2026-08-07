//! Test stand-in for the real `claude` CLI. Ignores all args except behavior
//! controlled by env vars, and emits canned stream-json on stdout.
//!
//! KATA_FAKE_MODE = "ok" (default) | "sleep" | "fail" | "manyturns" | "writefile" | "stderr" | "blockstdin" | "closestdio" | "ask" | "approve" | "budget" | "envreport"
use std::io::Write;
use std::{thread, time::Duration};

fn main() {
    let mode = std::env::var("KATA_FAKE_MODE").unwrap_or_else(|_| "ok".into());
    let mut out = std::io::stdout();
    let _ = writeln!(out, r#"{{"type":"system","subtype":"init"}}"#);
    let _ = out.flush();

    match mode.as_str() {
        "sleep" => {
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
            // The suppressed ask_user tool_use keeps is_assistant_message=true so
            // the engine counts the turn but emits no tool.use event.
            let _ = writeln!(
                out,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"mcp__kata-ask__ask_user","input":{{"questions":[]}}}}]}}}}"#
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
