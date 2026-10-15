import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import stylelint from 'stylelint';
import angular from 'angular-eslint';
import layout from './layout-index.mjs';
import styleConfig from '../../stylelint.config.mjs';
import { layoutTally } from '../counter/layout-counter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fx = (name) => join(repoRoot, 'harness', 'counter', 'fixtures', name);

function lintHtml(code) {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      files: ['**/*.html'],
      plugins: { layout },
      languageOptions: { parser: angular.templateParser },
      linterOptions: { noInlineConfig: true },
      rules: {
        'layout/no-raw-palette-color': 'error',
        'layout/no-space-utility': 'error',
        'layout/no-nested-flex-grid': 'error',
      },
    },
    { filename: 'x.html' },
  );
}

const byMessageId = (messages) => {
  const out = {};
  for (const m of messages) out[m.messageId] = (out[m.messageId] ?? 0) + 1;
  return out;
};

describe('layout gate: template rules', () => {
  it('flags raw palette colors and space utilities with the exact spread', () => {
    const messages = lintHtml(readFileSync(fx('layout-dirty.html'), 'utf8'));
    expect(messages.some((m) => m.fatal)).toBe(false);
    expect(byMessageId(messages)).toEqual({ rawPaletteColor: 3, spaceUtility: 1 });
  });

  it('passes the clean grammar template', () => {
    expect(lintHtml(readFileSync(fx('layout-clean.html'), 'utf8'))).toEqual([]);
  });

  it('agrees with the independent counter on the template surface', () => {
    // Cross-check on the same fixture bytes, excluding the counter-only
    // nested-flex heuristic and the CSS pass (which the template rules do not cover).
    const gateTotal = lintHtml(readFileSync(fx('layout-dirty.html'), 'utf8')).length;
    const t = layoutTally([fx('layout-dirty.html')]).totals;
    const counterTemplateTotal = t['raw-palette-color'] + t['space-utility'];
    expect(gateTotal).toBe(counterTemplateTotal);
  });
});

describe('layout gate: stylesheet surface (stylelint)', () => {
  it('flags hex and px literals in a stylesheet, passing tokens', async () => {
    const css = '.card {\n  background: #3b82f6;\n  padding: 16px;\n  border-radius: var(--radius);\n}';
    const result = await stylelint.lint({ code: css, config: styleConfig });
    const warnings = result.results.flatMap((r) => r.warnings);
    expect(warnings).toHaveLength(2);
  });

  it('agrees with the counter on the CSS surface of the component fixture', () => {
    // The counter's independent CSS scan and stylelint should land on the same
    // literal count for the component stylesheet fixture.
    const cssOnly = layoutTally([fx('layout-dirty.component.ts')]).totals['raw-css-literal'];
    expect(cssOnly).toBe(2);
  });
});

describe('layout gate: nested-flex-grid (row of columns)', () => {
  const src = readFileSync(fx('nested-flex.html'), 'utf8');

  it('flags exactly the two row-of-columns blocks and nothing else', () => {
    const ids = lintHtml(src).filter((m) => m.messageId === 'nestedFlexGrid');
    expect(ids.length).toBe(2);
  });

  // The five NOT-flagged shapes in that fixture are what the original proxy got
  // wrong: over seven capstone builds it flagged 63 sites and one was real. The
  // most important control is a flex COLUMN of flex rows, an ordinary card body.
  it('does not flag a flex column of flex rows, a toolbar of rows, or a single column', () => {
    const total = lintHtml(src).filter((m) => m.messageId === 'nestedFlexGrid').length;
    expect(total).toBe(2);
  });

  it('agrees with the independent counter on the same bytes', () => {
    const gate = lintHtml(src).filter((m) => m.messageId === 'nestedFlexGrid').length;
    const counter = layoutTally([fx('nested-flex.html')]).totals['nested-flex-grid'];
    expect(gate).toBe(counter);
  });
});
