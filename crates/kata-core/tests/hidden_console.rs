//! A program the ai-sdlc plugin starts (git, gh) opens no console window when the plugin runs under a
//! hidden node. The plugin calls Node's `spawnSync` without `windowsHide`, so this proves the
//! grandchild's console is hidden anyway.
#![cfg(windows)]

#[test]
fn a_grandchild_of_a_hidden_node_has_no_visible_console() {
    let fake = env!("CARGO_BIN_EXE_fake-claude");
    // The same call shape as the plugin's tools/git/git.ts: spawnSync, no windowsHide.
    let script = r#"
const { spawnSync } = require('node:child_process');
const r = spawnSync(process.env.KATA_PROBE_EXE, [], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, KATA_FAKE_MODE: 'console-report' },
});
process.stdout.write(r.stdout);
"#;
    let output = kata_core::proc::hidden_command("node")
        .unwrap()
        .arg("-e")
        .arg(script)
        .env("KATA_PROBE_EXE", fake)
        .stdin(std::process::Stdio::null())
        .output()
        .expect("node starts");
    assert!(output.status.success(), "{output:?}");
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hidden");
}
