//! Test stand-in for the real `claude` CLI. Ignores all args except behavior
//! controlled by env vars, and emits canned stream-json on stdout.
//!
//! KATA_FAKE_MODE = "ok" (default) | "sleep" | "fail" | "manyturns" | "writefile"
use std::io::Write;
use std::{thread, time::Duration};

fn main() {
    let mode = std::env::var("KATA_FAKE_MODE").unwrap_or_else(|_| "ok".into());
    let mut out = std::io::stdout();
    let _ = writeln!(out, r#"{{"type":"system","subtype":"init"}}"#);
    let _ = out.flush();

    match mode.as_str() {
        "sleep" => {
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"working"}}]}}}}"#);
            let _ = out.flush();
            thread::sleep(Duration::from_secs(60));
        }
        "fail" => {
            let _ = writeln!(out, r#"{{"type":"result","subtype":"error","is_error":true,"num_turns":1,"total_cost_usd":0.0,"result":"boom"}}"#);
            let _ = out.flush();
            std::process::exit(1);
        }
        "manyturns" => {
            // Emit assistant turns on a slow drip so the engine's turn cap fires
            // before the process finishes on its own.
            for i in 1..=10 {
                let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"turn {i}"}}]}}}}"#);
                let _ = out.flush();
                thread::sleep(Duration::from_millis(200));
            }
        }
        "writefile" => {
            // Write a file into cwd so a worktree-isolated run produces a real diff.
            let _ = std::fs::write("agent-made.txt", "line1\nline2\n");
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"wrote a file"}}]}}}}"#);
            let _ = writeln!(out, r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#);
            let _ = out.flush();
        }
        _ => {
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"hi"}}]}}}}"#);
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":"echo hi"}}}}]}}}}"#);
            let _ = writeln!(out, r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":2,"total_cost_usd":0.02,"result":"done"}}"#);
            let _ = out.flush();
        }
    }
}
