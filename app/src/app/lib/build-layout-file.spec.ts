import { describe, expect, it } from 'vitest';
import { defaultArrangement, type LayoutMode } from './build-layout';
import { readLayoutFile, writeLayoutFile } from './build-layout-file';

const MODES: LayoutMode[] = ['overview', 'watch', 'changes', 'review'];
const allDefaults = () => Object.fromEntries(MODES.map((m) => [m, defaultArrangement(m)]));
const fileWith = (watch: unknown) => ({ version: 1, modes: { ...allDefaults(), watch } });

describe('layout file', () => {
  it('round trips the four defaults', () => {
    const read = readLayoutFile(writeLayoutFile(allDefaults()));
    for (const m of MODES) expect(read[m]).toEqual(defaultArrangement(m));
  });

  it('writes only the modes given', () => {
    expect(writeLayoutFile({ watch: defaultArrangement('watch') })).toEqual({ version: 1, modes: { watch: defaultArrangement('watch') } });
  });

  it.each([null, 'text', []])('gives four nulls for %j', (raw) => {
    expect(readLayoutFile(raw)).toEqual({ overview: null, watch: null, changes: null, review: null });
  });

  it('gives four nulls for another version', () => {
    expect(readLayoutFile({ ...writeLayoutFile(allDefaults()), version: 2 })).toEqual({ overview: null, watch: null, changes: null, review: null });
  });

  const w = defaultArrangement('watch');
  const cases: Record<string, unknown> = {
    'leaves out findings': { ...w, tucked: w.tucked.filter((t) => t.area !== 'findings') },
    'lists tasks twice': { ...w, right: ['tasks'] },
    'names the place top': { ...w, tucked: [{ area: 'files', edge: 'right', back: 'top' }, w.tucked[1]] },
    'names the area logs': { ...w, right: ['logs'] },
    'has a size "300"': { ...w, sizes: { ...w.sizes, left: '300' } },
    'has a size of 100': { ...w, sizes: { ...w.sizes, left: 100 } },
  };
  it.each(Object.keys(cases))('an entry that %s gives null for watch only', (name) => {
    const read = readLayoutFile(fileWith(cases[name]));
    expect(read.watch).toBeNull();
    for (const m of MODES.filter((x) => x !== 'watch')) expect(read[m]).toEqual(defaultArrangement(m));
  });

  it('ignores unknown extra keys', () => {
    const read = readLayoutFile({ ...fileWith({ ...defaultArrangement('watch'), extra: 1 }), other: true });
    expect(read.watch).toEqual(defaultArrangement('watch'));
    expect(Object.keys(read.watch!)).not.toContain('extra');
  });
});
