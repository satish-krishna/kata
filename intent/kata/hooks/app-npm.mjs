// Runs one of Kata's npm scripts in app/ with extra arguments, for a build.finish hook. Hooks start with no shell, and on
// Windows npm is a .cmd that only a shell can start, so this script starts it. The hook runs in the repository's root.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const [script, ...rest] = process.argv.slice(2);
if (!/^[a-z][a-z:-]*$/.test(script ?? '') || rest.some((a) => !/^--?[a-z][a-z=-]*$/.test(a))) {
  process.stderr.write(`usage: node app-npm.mjs <script> [--flag ...]\n`);
  process.exit(2);
}
const args = rest.length > 0 ? ` -- ${rest.join(' ')}` : '';
const r = spawnSync(`npm run ${script}${args}`, { cwd: join(process.cwd(), 'app'), stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
