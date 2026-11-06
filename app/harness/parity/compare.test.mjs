import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { compareView } from '../../parity/compare.mjs';

function png(w, h, pixels = {}) {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const v = pixels[i] ?? 255;
    p.data.set([v, v, v, 255], i * 4);
  }
  return PNG.sync.write(p);
}

describe('compareView', () => {
  let dir, baselineDir, actualDir, diffDir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'parity-'));
    baselineDir = join(dir, 'baseline');
    actualDir = join(dir, 'actual');
    diffDir = join(dir, 'diff');
    for (const d of [baselineDir, actualDir, diffDir]) await mkdir(d);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('update mode reports the drift and writes the capture as the baseline', async () => {
    await writeFile(join(baselineDir, 'v.png'), png(4, 4));
    const capture = png(4, 4, { 5: 0 });
    await writeFile(join(actualDir, 'v.png'), capture);

    const r = await compareView({ name: 'v', baselineDir, actualDir, diffDir, update: true, threshold: 0.001 });

    expect(r.status).toBe('updated');
    expect(r.ratio).toBe(1 / 16);
    expect(Buffer.compare(await readFile(join(baselineDir, 'v.png')), capture)).toBe(0);
    await expect(access(join(diffDir, 'v.png'))).rejects.toThrow();
  });
});
