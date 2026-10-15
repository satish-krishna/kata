#!/usr/bin/env node
// PostToolUse freeloader gate (Part 4, the edit-time vocabulary half). When the
// agent edits a template-bearing file under src/, enforce native control flow and
// class/style bindings, straight from Angular's CLAUDE.md: no *ngIf/*ngFor/
// *ngSwitch, no ngClass/ngStyle. The strictTemplates freeloader is a whole-program
// compiler check enforced at the build, not here. Exit 2 with a corrective message
// that hands back the documented fix.
//
// Fails closed on an unparseable payload.

import { ESLint } from 'eslint';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import angular from 'angular-eslint';
import tseslint from 'typescript-eslint';
import freeloader from '../../harness/gate/freeloader-index.mjs';
import { logFiring } from './_hook-log.mjs';
import { docsPointersFor, formatDocPointerBlock } from './rule-docs.mjs';

const hookDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(hookDir, '..', '..');

const config = [
  { ignores: ['dist/**', '.angular/**', 'node_modules/**', 'coverage/**', 'libs/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser, parserOptions: { project: false } },
    processor: angular.processInlineTemplates,
    linterOptions: { noInlineConfig: true },
  },
  {
    files: ['**/*.html'],
    languageOptions: { parser: angular.templateParser },
    plugins: { freeloader },
    linterOptions: { noInlineConfig: true },
    rules: {
      'freeloader/no-legacy-control-flow': 'error',
      'freeloader/no-ng-class-style': 'error',
    },
  },
];

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write('check-freeloader: could not parse hook payload; failing closed.\n');
    process.exit(2);
  }

  const file = payload.tool_input?.file_path ?? payload.tool_input?.filePath ?? null;
  if (!file) process.exit(0);
  const normalized = String(file).replaceAll('\\', '/');
  if (!/\.(html|ts)$/.test(normalized)) process.exit(0);
  if (!/(^|\/)src\//.test(normalized)) process.exit(0);

  const messages = [];
  let eslint;
  let results;
  try {
    eslint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: config });
    results = await eslint.lintFiles([file]);
    for (const r of results) {
      for (const m of r.messages) {
        if (m.severity === 2) messages.push(`${normalized}:${m.line}:${m.column}  ${m.message}`);
      }
    }
  } catch (err) {
    process.stderr.write(`check-freeloader: eslint failed (${err?.message ?? err}).\n`);
    process.exit(2);
  }

  if (messages.length === 0) process.exit(0);

  // A missing or unreadable doc must never turn this into a soft failure: on
  // any error, drop the pointer block and still block the edit.
  let pointers = [];
  try {
    pointers = docsPointersFor(eslint, results);
  } catch {
    pointers = [];
  }
  const docLines = pointers.map((p) => `  ${p.ruleId}  ->  ${p.url}`);

  logFiring('freeloader', normalized, messages, pointers.map((p) => p.ruleId));

  process.stderr.write(
    `Template modernity gate blocked this edit: ${messages.length} violation(s).\n` +
      messages.map((m) => `  ${m}`).join('\n') +
      `\n` +
      formatDocPointerBlock(docLines) +
      `Use native control flow and bindings (Angular's CLAUDE.md). The documented shape:\n` +
      `  Good: @if (x) {} / @for (h of xs; track h.id) {}   [class.active]="isActive()"   [style.width.px]="w()"\n` +
      `  Bad:  *ngIf / *ngFor / *ngSwitch   [ngClass]="..."   [ngStyle]="..."\n` +
      `Fix the above before continuing.\n`,
  );
  process.exit(2);
}

main();
