#!/usr/bin/env node
// Kata-owned dispatcher: runs one of angular-jig's PostToolUse hooks only for
// edits inside the Angular Workbench, and stays silent for every other path.
// Usage: node .claude/hooks/web-ng-gate.mjs <hook-file-name>
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

const child = spawn(process.execPath, [join(WEB_ROOT, '.claude', 'hooks', hookName)], {
  cwd: WEB_ROOT,
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.on('error', () => {});
child.stdin.end(raw);
child.on('close', (code) => process.exit(code ?? 1));
