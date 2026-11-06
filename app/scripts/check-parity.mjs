// Parity gate: capture the Angular build with the same view list as the frozen
// baseline and fail on any view whose pixels differ by more than 0.1%.
// Local gate only (baseline is Windows-rendered; CI's Linux Chrome differs).
//   npm run check:parity                 all views
//   npm run check:parity -- --only a,b   named views only
//   npm run check:parity -- --update --only name,name   update the baseline for named views
import { spawn, execSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIEWS, captureAll } from '../parity/capture.mjs';
import { compareView } from '../parity/compare.mjs';
import { parseOptions } from '../parity/options.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THRESHOLD = 0.001;
let only;
let update;
try {
  ({ only, update } = parseOptions(process.argv.slice(2), VIEWS.map((v) => v.name)));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

async function serve() {
  const child = spawn('npx', ['ng', 'serve', '--port', '4317', '--configuration', 'production'], { cwd: root, shell: true });
  let seen = '';
  try {
    await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('ng serve did not start in 180s')), 180000);
      child.stdout.on('data', (d) => {
        // ng colors "Local" and ":" separately, so strip ANSI before matching.
        seen += String(d).replace(/\u001b\[[0-9;]*m/g, '');
        if (/Local:\s+http/.test(seen)) { clearTimeout(t); ok(); }
      });
      child.on('exit', (c) => fail(new Error(`ng serve exited ${c}`)));
    });
  } catch (e) { stop(child); throw e; }
  return child;
}

// `shell: true` puts a shell between us and ng, so child.kill() would leave ng
// serving on the port. Kill the whole tree.
function stop(child) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    else child.kill();
  } catch { /* already gone */ }
}

const actualDir = join(root, 'parity', 'actual');
const diffDir = join(root, 'parity', 'diff');
await rm(actualDir, { recursive: true, force: true });
await rm(diffDir, { recursive: true, force: true });
await mkdir(diffDir, { recursive: true });
if (only) VIEWS.splice(0, VIEWS.length, ...VIEWS.filter((v) => only.has(v.name)));
if (VIEWS.length === 0) { console.error('no views to compare'); process.exit(1); }

const server = await serve();
let failed = 0;
try {
  await captureAll('http://localhost:4317', actualDir);
  const baselineDir = join(root, 'parity', 'baseline');
  for (const v of VIEWS) {
    const r = await compareView({ name: v.name, baselineDir, actualDir, diffDir, update, threshold: THRESHOLD });
    if (update) console.log(r.status === 'new' ? `new ${v.name}` : `updated ${v.name}: ${(r.ratio * 100).toFixed(3)}%`);
    else if (r.status === 'fail') failed++;
  }
} finally { stop(server); }
if (update) {
  console.log(`\nparity: re-blessed ${VIEWS.length} view(s); review the PNG diff before committing`);
  process.exit(0);
}
if (failed) { console.error(`\n${failed} view(s) differ; see parity/diff/`); process.exit(1); }
console.log('\nparity: all views match');
