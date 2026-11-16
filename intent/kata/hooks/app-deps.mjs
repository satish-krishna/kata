// Installs the Workbench's npm packages for a build.start hook, when app/node_modules is missing. Each change builds in
// its own copy, a fresh git worktree, and node_modules is git-ignored, so a new copy has none: without this, every
// Node.js check fails on the baseline for want of packages rather than for anything in the code. It runs `npm ci`, which
// installs exactly the lockfile and writes nothing tracked, so the working tree stays clean for the baseline. Hooks
// start with no shell, and on Windows npm is a .cmd that only a shell can start, so this script starts it. The hook runs
// in the repository's root.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const app = join(process.cwd(), 'app');
if (existsSync(join(app, 'node_modules'))) {
  process.stdout.write('app-deps: app/node_modules exists, nothing to install\n');
  process.exit(0);
}
process.stdout.write('app-deps: app/node_modules is missing, running npm ci\n');
const r = spawnSync('npm ci', { cwd: app, stdio: 'inherit', shell: true });
if (r.error) process.stderr.write(`app-deps: cannot run npm (${r.error.message})\n`);
process.exit(r.status ?? 1);
