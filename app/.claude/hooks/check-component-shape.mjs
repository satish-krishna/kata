#!/usr/bin/env node
// PostToolUse component-shape gate (Part 3, the capstone's MVVM rules, and the
// capstone-residue rules added after the capstone run). When the agent edits a
// component .ts or an .html template under src/, enforce the component-shape
// rules: the typescript-eslint rules on component classes (no hand-set
// changeDetection, no .subscribe in a component or ViewModel, no FormsModule,
// no restated validator, no data-service inject in a src/app/ui/ component, no
// reactive forms, the four MVVM rules - no providedIn ViewModel, no state
// signal or form() outside the ViewModel, no direct data-service inject in a
// feature component, no injected-but-unprovided ViewModel - and the four
// capstone-residue rules - no explicit standalone, no NgIconsModule, no NgIcon
// import left unregistered) and the ngModel and orphan-ng-submit rules on
// templates (including inline templates via processInlineTemplates). On any
// violation, exit 2 with a corrective message.
//
// It builds its own eslint config for the shape rules rather than loading the
// repo's, so it can lint a single edited file without a full project pass. The
// same rules are ALSO enabled in the repo config, so `npm run lint` and CI
// enforce them for human authors too -- this hook is the edit-time half, not
// the only half. The counter is the independent auditor; this is enforcement.
//
// That means the rule list exists twice: here, and in the repo config. Adding a
// shape rule to one and not the other makes the gate and the lint run disagree
// about the house rules, and nothing detects the divergence. If that becomes a
// real problem, extract the rules object to a module both import.
//
// Fails closed on an unparseable payload.

import { ESLint } from 'eslint';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import angular from 'angular-eslint';
import tseslint from 'typescript-eslint';
import shape from '../../harness/gate/component-shape-index.mjs';
import { logFiring } from './_hook-log.mjs';
import { docsPointersFor, formatDocPointerBlock } from './rule-docs.mjs';
import {
  SHAPE_FORMS_GUIDANCE,
  FORMS_RULE_IDS,
  MVVM_GUIDANCE,
  MVVM_RULE_IDS,
  ICON_GUIDANCE,
  ICON_RULE_IDS,
  SUBMIT_GUIDANCE,
  SUBMIT_RULE_IDS,
} from './shape-guidance.mjs';

const hookDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(hookDir, '..', '..');

const shapeEslintConfig = [
  { ignores: ['dist/**', '.angular/**', 'node_modules/**', 'coverage/**', 'libs/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser, parserOptions: { project: false } },
    processor: angular.processInlineTemplates,
    plugins: { shape },
    linterOptions: { noInlineConfig: true },
    rules: {
      'shape/no-hand-set-change-detection': 'error',
      'shape/no-component-subscribe': 'error',
      'shape/no-forms-module': 'error',
      'shape/no-restated-validator': 'error',
      'shape/no-presentational-inject': 'error',
      'shape/no-reactive-form': 'error',
      'shape/no-root-provided-view-model': 'error',
      'shape/no-state-outside-view-model': 'error',
      'shape/no-feature-inject-data': 'error',
      'shape/no-unprovided-view-model': 'error',
      'shape/no-explicit-standalone': 'error',
      'shape/no-legacy-icon-module': 'error',
      'shape/no-unregistered-icon': 'error',
    },
  },
  {
    files: ['**/*.html'],
    languageOptions: { parser: angular.templateParser },
    plugins: { shape },
    linterOptions: { noInlineConfig: true },
    rules: { 'shape/no-ng-model': 'error', 'shape/no-orphan-ng-submit': 'error' },
  },
];

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write('check-component-shape: could not parse hook payload; failing closed.\n');
    process.exit(2);
  }

  const file = payload.tool_input?.file_path ?? payload.tool_input?.filePath ?? null;
  if (!file) process.exit(0);
  const normalized = String(file).replaceAll('\\', '/');
  if (!/\.(html|ts)$/.test(normalized)) process.exit(0);
  if (!/(^|\/)src\//.test(normalized)) process.exit(0);

  const messages = [];
  const ruleIds = new Set();
  let eslint;
  let results;
  try {
    eslint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: shapeEslintConfig });
    results = await eslint.lintFiles([file]);
    for (const r of results) {
      for (const m of r.messages) {
        if (m.severity === 2) {
          messages.push(`${normalized}:${m.line}:${m.column}  ${m.message}`);
          if (m.ruleId) ruleIds.add(m.ruleId);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`check-component-shape: eslint failed (${err?.message ?? err}).\n`);
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
  logFiring('component-shape', normalized, messages, pointers.map((p) => p.ruleId));

  const formsFired = [...ruleIds].some((id) => FORMS_RULE_IDS.has(id));
  const mvvmFired = [...ruleIds].some((id) => MVVM_RULE_IDS.has(id));
  const iconsFired = [...ruleIds].some((id) => ICON_RULE_IDS.has(id));
  const submitFired = [...ruleIds].some((id) => SUBMIT_RULE_IDS.has(id));
  let guidance = '';
  if (formsFired) guidance += '\n' + SHAPE_FORMS_GUIDANCE + '\n';
  if (mvvmFired) guidance += '\n' + MVVM_GUIDANCE + '\n';
  if (iconsFired) guidance += '\n' + ICON_GUIDANCE + '\n';
  if (submitFired) guidance += '\n' + SUBMIT_GUIDANCE + '\n';
  if (!guidance) guidance = '\n\nFix the above before continuing.\n';

  const docLines = pointers.map((p) => `  ${p.ruleId}  ->  ${p.url}`);

  process.stderr.write(
    `Component-shape gate blocked this edit: ${messages.length} violation(s).\n` +
      messages.map((m) => `  ${m}`).join('\n') +
      `\n` +
      formatDocPointerBlock(docLines) +
      `Component shape (see harness/component-shape-spec.md): no hand-set changeDetection or explicit standalone ` +
      `(both are Angular v20+/v22+ defaults), no .subscribe in a component or ViewModel (use the async pipe or toSignal), ` +
      `template-driven forms are not used (no FormsModule, no ngModel), ` +
      `validation lives in the zod schema (validateStandardSchema, not a restated per-field validator), a presentational ` +
      `(src/app/ui/) component injects no data service, and a feature component owns its state and its data access through a ` +
      `component-scoped ViewModel: it holds no signal()/computed()/linkedSignal()/form() of its own, it injects no data service ` +
      `directly, its ViewModel carries no providedIn, and the component provides whatever ViewModel it injects. Icons import ` +
      `NgIcon (never NgIconsModule) and are registered with provideIcons; a form submits through submit(this.form, ...), never ` +
      `(ngSubmit).` +
      guidance,
  );
  process.exit(2);
}

main();
