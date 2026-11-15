// The cheap listing of a system's changes: name, title, track, where each is held, and whether it is finished. It
// shares change discovery and the finished rule with `state` (place.ts, finished.ts), so the two always agree, and
// reads only the intents: never a spec, plan, build log, product repository, or `git status`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolveOptions } from '../workspace/resolve.ts';
import { finishedOf, type Finished } from './finished.ts';
import { placeChanges, titleAndTrack } from './place.ts';
import type { SystemRead } from './system-read.ts';

export type ListedChange = { change: string; title: string | null; track: 'full' | 'fix'; master: string; inCopy: boolean; finished: Finished };

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Every change of a system, sorted by name, from the repository that holds it. */
export function listChanges(cwd: string, options: ResolveOptions & { system?: string }): { system: string; changes: ListedChange[]; problems: string[] } {
  const place = placeChanges(cwd, options);
  const finished = finishedOf(place);
  const changes = place.placed.map(({ change, top, inCopy }) => {
    const file = join(top, 'intent', place.system, change, 'intent.md');
    const headName = `HEAD:intent/${place.system}/${change}/intent.md`;
    const head = (place.reads.get(top) as SystemRead).headText(`intent/${place.system}/${change}/intent.md`);
    const { title, track } = titleAndTrack(readText(file), head, file, headName);
    return { change, title, track, master: top, inCopy, finished: finished.get(change) ?? null };
  });
  return { system: place.system, changes, problems: [] };
}
