// Finds and reads the master repository's marker, `.ai-sdlc.json`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CouldNotRun } from '../common/types.ts';

/** The master repository's `.ai-sdlc.json`: the systems and the repositories each one lists. */
export type Marker = { systems: Record<string, { repos: string[] }> };

/** Reads a marker file. A file that is not a marker is a program failure, not a document problem. */
export function readMarker(path: string): Marker {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new CouldNotRun(`${path}: cannot read the marker: ${(e as Error).message}`);
  }
  const systems: Marker['systems'] = {};
  const listed = (raw as { systems?: unknown } | null)?.systems;
  if (listed === null || typeof listed !== 'object' || Array.isArray(listed)) {
    throw new CouldNotRun(`${path}: the marker lists no systems`);
  }
  for (const [name, value] of Object.entries(listed as Record<string, unknown>)) {
    const repos = (value as { repos?: unknown } | null)?.repos;
    systems[name] = { repos: Array.isArray(repos) ? repos.filter((r): r is string => typeof r === 'string') : [] };
  }
  return { systems };
}

/** Finds `.ai-sdlc.json` by walking up from the folder of `file`; null when no folder above holds one. */
export function findMarker(file: string): Marker | null {
  let dir = dirname(resolve(file));
  for (;;) {
    const candidate = join(dir, '.ai-sdlc.json');
    if (existsSync(candidate)) return readMarker(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
