import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { layoutTally, layoutCountFile } from './layout-counter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(here, 'fixtures', name);

describe('layout counter: templates', () => {
  it('tallies raw palette colors and space utilities', () => {
    const result = layoutTally([fx('layout-dirty.html')]);
    // raw-palette-color: bg-blue-50, text-gray-700, border-gray-200 = 3
    // space-utility:     space-y-4                                   = 1
    // bg-card/text-card-foreground/border-border are semantic tokens: not flagged.
    expect(result.totals).toEqual({
      'raw-palette-color': 3,
      'space-utility': 1,
      'raw-css-literal': 0,
      'nested-flex-grid': 0,
      all: 4,
    });
  });

  it('fires the nested-flex heuristic on a flex-of-flex', () => {
    const result = layoutTally([fx('layout-nested.html')]);
    expect(result.totals['nested-flex-grid']).toBe(1);
    expect(result.totals['raw-palette-color']).toBe(0);
  });

  it('passes a clean template (tokens and grid) with zero violations', () => {
    expect(layoutCountFile(fx('layout-clean.html'))).toEqual([]);
  });
});

describe('layout counter: stylesheet pass', () => {
  it('flags raw hex and px in a component styles block, not tokens', () => {
    const result = layoutTally([fx('layout-dirty.component.ts')]);
    // background: #3b82f6 (color) + padding: 16px (spacing) = 2; var(--radius) passes.
    expect(result.totals).toEqual({
      'raw-palette-color': 0,
      'space-utility': 0,
      'raw-css-literal': 2,
      'nested-flex-grid': 0,
      all: 2,
    });
  });

  it('counts a styleUrl stylesheet once and skips a px in a comment', () => {
    const result = layoutTally([fx('layout-styleurl.component.ts'), fx('layout-styleurl.css')]);
    expect(result.totals['raw-css-literal']).toBe(1);
    expect(result.totals.all).toBe(1);
  });
});

describe('layout counter: output contract', () => {
  it('is deterministic across repeated runs', () => {
    const a = JSON.stringify(layoutTally([fx('layout-dirty.html'), fx('layout-dirty.component.ts')]));
    const b = JSON.stringify(layoutTally([fx('layout-dirty.html'), fx('layout-dirty.component.ts')]));
    expect(a).toBe(b);
  });
});

describe('layout counter: nested-flex-grid (row of columns)', () => {
  it('counts only the row-of-columns blocks', () => {
    // Hand-counted in the fixture header. The direction is the entire rule: a
    // row of columns is a grid, a column of rows is a card body.
    expect(layoutTally([fx('nested-flex.html')]).totals['nested-flex-grid']).toBe(2);
  });
});
