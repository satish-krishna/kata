// The strictTemplates auditor (Part 4, the build-time freeloader).
//
// strictTemplates is not a lint rule and not an AST kind; it is the Angular
// compiler's own template type-checker. So its "counter" is the compiler: layer
// strictTemplates on over the app tsconfig, build, and count the template type
// diagnostics. gate-off output (built loosely) may carry latent errors; gate-on
// output should carry zero, because the agent's own strict build already failed
// on them and forced the fix. The compiler is a legitimate independent auditor
// here because it is the graph that already exists, not something the gate computes.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const TSCONFIG = join(ROOT, 'tsconfig.json');

function setStrictTemplates(on) {
  const original = readFileSync(TSCONFIG, 'utf8');
  const cfg = JSON.parse(original);
  cfg.angularCompilerOptions = cfg.angularCompilerOptions ?? {};
  cfg.angularCompilerOptions.strictTemplates = on;
  writeFileSync(TSCONFIG, JSON.stringify(cfg, null, 2) + '\n');
  return original;
}

// Set (or clear) strictTemplates in the app tsconfig and return the original
// text. The driver calls this to put the gate-on condition into strict mode
// before the agent's own build runs.
export function setStrictTemplatesOption(on) {
  return setStrictTemplates(on);
}

// Run a strict build over whatever code is currently in the tree and return the
// template-type-error audit. Restores tsconfig.json afterward by default.
export function strictTemplateCheck({ restore = true } = {}) {
  const original = setStrictTemplates(true);
  let output = '';
  let passed = true;
  try {
    output = execFileSync('npm run build', {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
  } catch (err) {
    passed = false;
    output = (err.stdout ?? '') + (err.stderr ?? '');
  } finally {
    if (restore) writeFileSync(TSCONFIG, original);
  }
  // Count Angular/TS diagnostics. Template type errors surface as NG#### codes or
  // as TS errors located inside a template; count both, best-effort.
  const errorLines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /(?:error\s+)?(NG|TS)\d{3,}/.test(l));
  return { passed, errorCount: errorLines.length, sample: errorLines.slice(0, 12) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(strictTemplateCheck(), null, 2) + '\n');
}
