import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { countTemplateSource, tally } from './freeloader-counter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => join(here, 'fixtures', n);
const tallyOf = (vs) => {
  const t = {};
  for (const v of vs) t[v.kind] = (t[v.kind] ?? 0) + 1;
  return t;
};

describe('freeloader vocabulary counter', () => {
  it('tallies legacy control flow and ngClass/ngStyle on the dirty fixture', () => {
    const vs = countTemplateSource(readFileSync(fx('part4-dirty.html'), 'utf8'), { file: 'd.html' });
    expect(tallyOf(vs)).toEqual({ 'legacy-control-flow': 2, 'ng-class-style': 2 });
  });

  it('passes the clean fixture (native control flow, class/style bindings)', () => {
    expect(countTemplateSource(readFileSync(fx('part4-clean.html'), 'utf8'), { file: 'c.html' })).toEqual([]);
  });

  it('is deterministic: same bytes in, identical tally out', () => {
    const a = JSON.stringify(tally([fx('part4-dirty.html')]));
    const b = JSON.stringify(tally([fx('part4-dirty.html')]));
    expect(a).toBe(b);
  });
});
