// Compares one captured view with its baseline.
// Returns { name, ratio, status }; status is ok, fail, updated or new.
// In update mode the capture becomes the baseline, no diff image is written and nothing fails.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export async function compareView({ name, baselineDir, actualDir, diffDir, update, threshold }) {
  const baselinePath = join(baselineDir, `${name}.png`);
  const actualPath = join(actualDir, `${name}.png`);
  const b = PNG.sync.read(await readFile(actualPath));
  let a = null;
  try {
    a = PNG.sync.read(await readFile(baselinePath));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (update && (!a || a.width !== b.width || a.height !== b.height)) {
    await adopt(actualPath, baselinePath);
    return { name, ratio: null, status: 'new' };
  }
  if (!a) throw new Error(`no baseline for ${name}`);
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`FAIL ${name}: size ${b.width}x${b.height} vs ${a.width}x${a.height}`);
    return { name, ratio: null, status: 'fail' };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const ratio = n / (a.width * a.height);
  if (update) {
    await adopt(actualPath, baselinePath);
    return { name, ratio, status: 'updated' };
  }
  const failed = ratio > threshold;
  if (failed) await writeFile(join(diffDir, `${name}.png`), PNG.sync.write(diff));
  console.log(`${failed ? 'FAIL' : 'ok  '} ${name}: ${(ratio * 100).toFixed(3)}%`);
  return { name, ratio, status: failed ? 'fail' : 'ok' };
}

async function adopt(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}
