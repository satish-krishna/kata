// Parity gate: capture the Angular build with the same view list as the frozen
// baseline and fail on any view whose pixels differ by more than 0.1%.
// Local gate only (baseline is Windows-rendered; CI's Linux Chrome differs).
//   npm run check:parity                 all views
//   npm run check:parity -- --only a,b   named views only
import { spawn, execSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { VIEWS, captureAll } from '../parity/capture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THRESHOLD = 0.001;
const USAGE = 'usage: npm run check:parity [-- --only name,name]';
const onlyArg = process.argv.indexOf('--only');
const onlyValue = onlyArg >= 0 ? process.argv[onlyArg + 1] : undefined;
if (onlyArg >= 0 && (!onlyValue || onlyValue.startsWith('--'))) {
  console.error(`--only needs a comma-separated view list
${USAGE}`);
  process.exit(1);
}
const only = onlyArg >= 0 ? new Set(onlyValue.split(',').filter(Boolean)) : null;
if (only) {
  const valid = VIEWS.map((v) => v.name);
  const unknown = [...only].filter((n) => !valid.includes(n));
  if (unknown.length || only.size === 0) {
    console.error(`unknown view(s): ${unknown.join(', ') || '(none given)'}
valid views: ${valid.join(', ')}
${USAGE}`);
    process.exit(1);
  }
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
  for (const v of VIEWS) {
    const a = PNG.sync.read(await readFile(join(root, 'parity', 'baseline', `${v.name}.png`)));
    const b = PNG.sync.read(await readFile(join(actualDir, `${v.name}.png`)));
    if (a.width !== b.width || a.height !== b.height) { console.log(`FAIL ${v.name}: size ${b.width}x${b.height} vs ${a.width}x${a.height}`); failed++; continue; }
    const diff = new PNG({ width: a.width, height: a.height });
    const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    const ratio = n / (a.width * a.height);
    if (ratio > THRESHOLD) { failed++; await writeFile(join(diffDir, `${v.name}.png`), PNG.sync.write(diff)); }
    console.log(`${ratio > THRESHOLD ? 'FAIL' : 'ok  '} ${v.name}: ${(ratio * 100).toFixed(3)}%`);
  }
} finally { stop(server); }
if (failed) { console.error(`\n${failed} view(s) differ; see parity/diff/`); process.exit(1); }
console.log('\nparity: all views match');
