#!/usr/bin/env node
// Kata-owned dispatcher: runs one of angular-jig's PostToolUse hooks only for
// edits inside the Angular Workbench, and stays silent for every other path.
// Usage: node .claude/hooks/web-ng-gate.mjs <hook-file-name>
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Task 15 changes this to `app` at the swap.
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'web-ng');

const hookName = process.argv[2] ?? '';
if (!hookName || /[\/]/.test(hookName) || hookName.includes('..')) {
  process.stderr.write(`web-ng-gate: invalid hook file name "${hookName}"\n`);
  process.exit(1);
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let file = null;
try {
  const input = JSON.parse(raw).tool_input ?? {};
  file = input.file_path ?? input.notebook_path ?? null;
} catch {
  process.exit(0);
}
if (!file) process.exit(0);

const norm = (p) => resolve(String(p)).replaceAll(sep, '/').toLowerCase();
const root = norm(WEB_ROOT);
const target = norm(file);
if (target !== root && !target.startsWith(root + '/')) process.exit(0);

const hookPath = join(WEB_ROOT, '.claude', 'hooks', hookName);
if (!existsSync(hookPath)) {
  process.stderr.write(`web-ng-gate: hook file not found for ${hookName}: ${hookPath}
`);
  process.exit(2);
}

const child = spawn(process.execPath, [hookPath], {
  cwd: WEB_ROOT,
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.on('error', (err) => {
  process.stderr.write(`web-ng-gate: ${hookName} failed to start (${err.message}); failing closed.
`);
  process.exit(2);
});
child.stdin.on('error', () => {});
child.stdin.end(raw);
child.on('close', (code, signal) => {
  if (code === null) {
    process.stderr.write(`web-ng-gate: ${hookName} was killed by ${signal}; failing closed.
`);
    process.exit(2);
  }
  process.exit(code);
});
