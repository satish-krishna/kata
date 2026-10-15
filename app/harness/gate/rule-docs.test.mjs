import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import seal from './index.mjs';
import layout from './layout-index.mjs';
import shape from './component-shape-index.mjs';
import freeloader from './freeloader-index.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const allRules = Object.entries({
  ...seal.rules, ...layout.rules, ...shape.rules, ...freeloader.rules,
});

describe('every rule points at a doc that exists', () => {
  it('registers 27 rules across the four plugins', () => {
    expect(allRules.length).toBe(27);
  });

  it.each(allRules)('%s has a docs url resolving to a real file', (name, rule) => {
    const url = rule.meta?.docs?.url;
    expect(url, `${name} has no docs url`).toBeTruthy();
    expect(url).toBe(`harness/rules/${name}.md`);
    expect(existsSync(join(repoRoot, url)), `${url} does not exist`).toBe(true);
  });
});
