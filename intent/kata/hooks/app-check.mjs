// Runs one of Kata's app checks (an npm script in app/) for a build.finish hook. Hooks start with no shell, and on
// Windows npm is a .cmd that only a shell can start, so this script starts it. The hook runs in the repository's root.
// Order matters: check:responsive does a production build, check:interaction, check:build and check:start-flow serve that
// build without building, and check:boot then does its own development build into the same dist/ folder.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const script = process.argv[2];
if (!/^check:[a-z-]+$/.test(script ?? '')) {
  process.stderr.write(`usage: node app-check.mjs check:<name>\n`);
  process.exit(2);
}
const r = spawnSync(`npm run ${script}`, { cwd: join(process.cwd(), 'app'), stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
