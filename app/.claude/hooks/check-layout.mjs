#!/usr/bin/env node
// PostToolUse layout gate (Part 2). When the agent edits a template or a
// stylesheet under src/, enforce the layout grammar: the angular-eslint layout
// rules on templates (literal values, presentation on raw elements) and
// stylelint on stylesheets (colors and spacing must be design tokens, not
// literals). On any violation, exit 2 with a corrective message.
//
// Self-contained: it builds its own eslint config for the layout rules and does
// not touch the repo's eslint.config.mjs (which stays the sealing baseline), so
// the layout rules are enforced only when this hook is registered (gate-on).
// The counter is the independent auditor; this is the enforcement.
//
// Fails closed on an unparseable payload.

import { ESLint } from 'eslint';
import stylelint from 'stylelint';
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import angular from 'angular-eslint';
import tseslint from 'typescript-eslint';
import layout from '../../harness/gate/layout-index.mjs';
import styleConfig from '../../stylelint.config.mjs';
import { logFiring } from './_hook-log.mjs';
import { docsPointersFor, formatDocPointerBlock } from './rule-docs.mjs';

const hookDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(hookDir, '..', '..');

const layoutEslintConfig = [
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
    plugins: { layout },
    linterOptions: { noInlineConfig: true },
    rules: {
      'layout/no-raw-palette-color': 'error',
      'layout/no-space-utility': 'error',
      'layout/no-nested-flex-grid': 'error',
    },
  },
];

function extractStyles(sourceText) {
  const sf = ts.createSourceFile('c.ts', sourceText, ts.ScriptTarget.Latest, true);
  const styles = [];
  const styleUrls = [];
  const lit = (n) =>
    ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n) ? n : null;
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && n.name) {
      const k = n.name.getText(sf);
      const init = n.initializer;
      if ((k === 'styles' || k === 'styleUrls') && ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) {
          const l = lit(el);
          if (!l) continue;
          if (k === 'styles') styles.push(l.text);
          else styleUrls.push(l.text);
        }
      } else if (k === 'styleUrl' && lit(init)) {
        styleUrls.push(init.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { styles, styleUrls };
}

async function styleViolations(cssBlocks) {
  const out = [];
  for (const { code, where } of cssBlocks) {
    const result = await stylelint.lint({ code, config: styleConfig });
    for (const r of result.results) {
      for (const w of r.warnings) out.push(`${where}:${w.line}  ${w.text}`);
    }
  }
  return out;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write('check-layout: could not parse hook payload; failing closed.\n');
    process.exit(2);
  }

  const file = payload.tool_input?.file_path ?? payload.tool_input?.filePath ?? null;
  if (!file) process.exit(0);
  const normalized = String(file).replaceAll('\\', '/');
  if (!/\.(html|ts|css)$/.test(normalized)) process.exit(0);
  if (!/(^|\/)src\//.test(normalized)) process.exit(0);

  const messages = [];

  // eslint and results stay in scope beyond this block so the eslint (not the
  // stylelint) half of the violations can later be traced back to a docs url.
  let eslint;
  let results;

  // Template surface (angular-eslint layout rules), for .html and inline templates in .ts.
  if (/\.(html|ts)$/.test(normalized)) {
    try {
      eslint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: layoutEslintConfig });
      results = await eslint.lintFiles([file]);
      for (const r of results) {
        for (const m of r.messages) {
          if (m.severity === 2) messages.push(`${normalized}:${m.line}:${m.column}  ${m.message}`);
        }
      }
    } catch (err) {
      process.stderr.write(`check-layout: eslint failed (${err?.message ?? err}).\n`);
      process.exit(2);
    }
  }

  // Stylesheet surface (stylelint tokens-not-literals).
  try {
    const cssBlocks = [];
    if (normalized.endsWith('.css')) {
      cssBlocks.push({ code: readFileSync(file, 'utf8'), where: normalized });
    } else if (normalized.endsWith('.ts')) {
      const src = readFileSync(file, 'utf8');
      const { styles, styleUrls } = extractStyles(src);
      styles.forEach((code, i) => cssBlocks.push({ code, where: `${normalized} styles[${i}]` }));
      for (const url of styleUrls) {
        const cssPath = join(dirname(file), url);
        if (existsSync(cssPath)) cssBlocks.push({ code: readFileSync(cssPath, 'utf8'), where: url });
      }
    }
    messages.push(...(await styleViolations(cssBlocks)));
  } catch (err) {
    process.stderr.write(`check-layout: stylelint failed (${err?.message ?? err}).\n`);
    process.exit(2);
  }

  if (messages.length === 0) process.exit(0);

  // Pointers exist only for the eslint half: stylelint warnings carry no rule
  // metadata and no docs url, so the stylelint lines above stay exactly as
  // they are. A missing or unreadable doc must never turn this into a soft
  // failure: on any error, drop the pointer block and still block the edit.
  let pointers = [];
  try {
    if (eslint && results) {
      pointers = docsPointersFor(eslint, results);
    }
  } catch {
    pointers = [];
  }
  const docLines = pointers.map((p) => `  ${p.ruleId}  ->  ${p.url}`);

  // Stylelint warnings carry no eslint ruleId, but a firing must not vanish
  // from the count for that: extract the rule name stylelint appends in
  // parentheses at the end of its warning text (e.g.
  // "(scale-unlimited/declaration-strict-value)").
  const stylelintRules = messages
    .map((m) => m.match(/\(([^()]+)\)\s*$/)?.[1])
    .filter(Boolean);
  logFiring('check-layout', normalized, messages, [...pointers.map((p) => p.ruleId), ...stylelintRules]);

  process.stderr.write(
    `Layout gate blocked this edit: ${messages.length} violation(s).\n` +
      messages.map((m) => `  ${m}`).join('\n') +
      `\n` +
      formatDocPointerBlock(docLines) +
      `Layout is a grammar (see harness/layout-grammar-spec.md): grid for regions, flex for inline runs, ` +
      `spacing with gap, and colors and sizes as tokens. The documented shape:\n` +
      `  Good: <div class="grid grid-cols-2 gap-4">   <div class="flex items-center gap-2">   background: var(--card)\n` +
      `  Bad:  class="space-y-4"   class="bg-blue-500"   background: #3b82f6   padding: 16px\n` +
      `Fix the above before continuing.\n`,
  );
  process.exit(2);
}

main();
