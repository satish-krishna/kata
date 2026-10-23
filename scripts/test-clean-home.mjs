// Runs `cargo test` with HOME and USERPROFILE pointed at an empty folder, the way CI sees the machine.
// A test that only passes because this machine has a plugin, a skill or a Kata home installed fails here
// instead of on CI. KATA_HOME is cleared too, so the store falls back to the empty home.
//
// Usage: node scripts/test-clean-home.mjs [cargo test arguments...]
// e.g.   node scripts/test-clean-home.mjs --workspace
//        node scripts/test-clean-home.mjs -p kata-app --lib preview_run
//
// The toolchain stays reachable: RUSTUP_HOME and CARGO_HOME are pinned to their current values before
// the home moves, since rustup and cargo otherwise look for them under the home. The opt-in real-claude
// smoke test (KATA_SMOKE_REAL) needs an authenticated claude, so it cannot pass under this script.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = join(repo, 'target', 'clean-home');
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const env = {
  ...process.env,
  RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
  CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
  HOME: home,
  USERPROFILE: home,
};
delete env.KATA_HOME;

const result = spawnSync('cargo', ['test', ...process.argv.slice(2)], { cwd: repo, env, stdio: 'inherit', shell: false });
if (result.error) {
  console.error(`could not start cargo: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
