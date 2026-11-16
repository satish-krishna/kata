// Runs Kata's speed targets for a build.finish hook: stages the engine as the app's sidecar, then runs the kata-app
// test speed_targets with KATA_SPEED_CHECK=1 (without it the test skips itself). A hook entry has no env field, so
// this script sets the variable. The hook runs in the repository's root; the staged binary under
// app/src-tauri/binaries/ is git-ignored, so the check leaves the working tree clean.
import { spawnSync } from 'node:child_process';

const run = (program, args, env) => spawnSync(program, args, { stdio: 'inherit', env: { ...process.env, ...env } });

const staged = run(process.execPath, ['app/scripts/stage-sidecar.mjs']);
if (staged.status !== 0) {
  process.stderr.write(`speed-check: staging the sidecar failed (${staged.error?.message ?? `exit ${staged.status}`})\n`);
  process.exit(staged.status || 1);
}
const tested = run('cargo', ['test', '-p', 'kata-app', 'speed_targets', '--', '--nocapture'], { KATA_SPEED_CHECK: '1' });
if (tested.error) process.stderr.write(`speed-check: cannot run cargo (${tested.error.message})\n`);
process.exit(tested.status ?? 1);
