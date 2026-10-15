import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import angular from 'angular-eslint';
import freeloader from './freeloader-index.mjs';
import { tally } from '../counter/freeloader-counter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fx = (n) => join(repoRoot, 'harness', 'counter', 'fixtures', n);

function lintHtml(code) {
  return new Linter().verify(
    code,
    {
      files: ['**/*.html'],
      plugins: { freeloader },
      languageOptions: { parser: angular.templateParser },
      linterOptions: { noInlineConfig: true },
      rules: {
        'freeloader/no-legacy-control-flow': 'error',
        'freeloader/no-ng-class-style': 'error',
      },
    },
    { filename: 'x.html' },
  );
}

const byId = (ms) => {
  const o = {};
  for (const m of ms) o[m.messageId] = (o[m.messageId] ?? 0) + 1;
  return o;
};

describe('freeloader gate: template rules', () => {
  it('flags the dirty fixture with the exact messageId spread', () => {
    const ms = lintHtml(readFileSync(fx('part4-dirty.html'), 'utf8'));
    expect(ms.some((m) => m.fatal)).toBe(false);
    expect(byId(ms)).toEqual({ legacyControlFlow: 2, ngClassStyle: 2 });
  });

  it('passes the clean fixture with zero reports', () => {
    expect(lintHtml(readFileSync(fx('part4-clean.html'), 'utf8'))).toEqual([]);
  });

  it('agrees with the independent counter on the same fixture bytes', () => {
    const gate = lintHtml(readFileSync(fx('part4-dirty.html'), 'utf8')).length;
    const counter = tally([fx('part4-dirty.html')]).totals.all;
    expect(gate).toBe(counter);
  });
});
