// Tests for protect-gates.mjs: run with `node --test .claude/hooks/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const guard = join(here, 'protect-gates.mjs');

function run(payload) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [guard], { input, encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr };
}
const edit = (rel, tool = 'Edit') => run({ tool_name: tool, tool_input: { file_path: join(repo, rel) } });

const GUARDED = [
  'app/eslint.config.mjs',
  'app/stylelint.config.mjs',
  'app/harness/gate/rules/primitive-vocabulary.ts',
  'app/harness/gate/rules/no-raw-control.ts',
  '.claude/hooks/protect-gates.mjs',
  '.claude/hooks/protect-gates.test.mjs',
];

for (const rel of GUARDED) {
  test(`denies an edit to ${rel}`, () => {
    const r = edit(rel);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /protect-gates/);
  });
}

test('denies Write, MultiEdit and NotebookEdit too', () => {
  for (const tool of ['Write', 'MultiEdit']) assert.equal(edit('app/eslint.config.mjs', tool).code, 2);
  assert.equal(
    run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: join(repo, 'app/stylelint.config.mjs') } }).code,
    2,
  );
});

test('matches regardless of slash direction and drive-letter case', () => {
  const p = join(repo, 'app/eslint.config.mjs').replace(/\//g, '\\');
  const flipped = p.charAt(0) === p.charAt(0).toUpperCase() ? p.charAt(0).toLowerCase() + p.slice(1) : p;
  const r = run({ tool_name: 'Edit', tool_input: { file_path: process.platform === 'win32' ? flipped : join(repo, 'app/eslint.config.mjs') } });
  assert.equal(r.code, 2);
});

test('resolves .. segments before matching', () => {
  const sneaky = join(repo, 'app/src/../eslint.config.mjs');
  assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: sneaky } }).code, 2);
});

const FREE = [
  'app/package.json',
  'app/tsconfig.json',
  'app/tsconfig.app.json',
  '.mcp.json',
  '.claude/settings.json',
  'app/harness/gate/rules/no-raw-icon.ts',
  'app/harness/rules/no-raw-control.md',
  'app/src/app/app.ts',
  'app/eslint.config.mjs.bak',
  'crates/kata-core/src/run.rs',
];

for (const rel of FREE) {
  test(`allows an edit to ${rel}`, () => {
    const r = edit(rel);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
  });
}

test('fails closed on an unparseable payload', () => {
  assert.equal(run('not json').code, 2);
});

test('fails closed when a write tool carries no path', () => {
  assert.equal(run({ tool_name: 'Edit', tool_input: {} }).code, 2);
});

test('ignores tools that do not write files', () => {
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: join(repo, 'app/eslint.config.mjs') } }).code, 0);
});
