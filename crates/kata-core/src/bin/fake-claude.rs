//! Test stand-in for the real `claude` CLI. Ignores all args except behavior
//! controlled by env vars, and emits canned stream-json on stdout.
//!
//! KATA_FAKE_MODE = "ok" (default) | "sleep" | "fail" | "manyturns" | "writefile" | "stderr" | "blockstdin" | "closestdio"
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
        "blockstdin" => {
            // Block until stdin reaches EOF, then complete. With an inherited,
            // open-but-idle stdin this never returns on its own; with Stdio::null()
            // the read EOFs immediately. Proves Kata hands claude a
            // non-interactive stdin so it can't hang waiting for input.
            use std::io::Read;
            let mut buf = String::new();
            let _ = std::io::stdin().read_to_string(&mut buf);
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"hi"}}]}}}}"#);
            let _ = writeln!(out, r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#);
            let _ = out.flush();
        }
        "stderr" => {
            // Write a human-readable diagnostic to stderr (as the real claude does
            // for things like "Not logged in"), then complete normally on stdout.
            let mut err = std::io::stderr();
            let _ = writeln!(err, "diagnostic from claude on stderr");
            let _ = err.flush();
            let _ = writeln!(out, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"hi"}}]}}}}"#);
            let _ = writeln!(out, r#"{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.0,"result":"done"}}"#);
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
