// Which changes a system has and where each one is held: the master and every change copy of it, working tree and
// `HEAD`. `state` and `list` both start here, so they never disagree about what exists or where.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CouldNotRun } from '../common/types.ts';
import { changeHolders, copiesFolder, findChange } from '../events/context.ts';
import { readMarker } from '../workspace/marker.ts';
import { gitDirs, real, resolveWorkspace } from '../workspace/resolve.ts';
import { fieldOf, gitMaybe } from './fix-state.ts';
import type { StateOptions } from './state.ts';
import { SystemRead } from './system-read.ts';

export type Placed = { change: string; top: string; inCopy: boolean };

export type Placement = {
  system: string;
  master: string;
  workspace: string;
  masterIsCopy: boolean;
  /** The real path of every folder in the copies folder that is a worktree of the master's repository. */
  copies: string[];
  reads: Map<string, SystemRead>;
  placed: Placed[];
};

type Dirs = Map<string, ReturnType<typeof gitDirs>>;

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

function dirsOf(dirs: Dirs, dir: string): ReturnType<typeof gitDirs> {
  if (!dirs.has(dir)) dirs.set(dir, gitDirs(dir));
  return dirs.get(dir) ?? null;
}

/** The changes of a system a repository holds: folders with an `intent.md` in the working tree or in `HEAD`. */
function changesIn(top: string, system: string, read: SystemRead): Set<string> {
  const base = join(top, 'intent', system);
  const names = new Set<string>();
  if (isDir(base)) for (const name of readdirSync(base)) if (existsSync(join(base, name, 'intent.md'))) names.add(name);
  const prefix = `intent/${system}/`;
  for (const path of read.headBlobs.keys()) {
    const rest = path.startsWith(prefix) ? path.slice(prefix.length).split('/') : [];
    if (rest.length === 2 && rest[1] === 'intent.md') names.add(rest[0] as string);
  }
  return names;
}

/** Every change copy in the workspace that is a worktree of the master's repository. */
function copiesOf(workspace: string, master: string, dirs: Dirs): string[] {
  const common = dirsOf(dirs, master)?.common;
  const folder = copiesFolder(workspace);
  if (common === undefined || !isDir(folder)) return [];
  return readdirSync(folder)
    .sort()
    .map((name) => real(join(folder, name)))
    .filter((dir) => isDir(dir) && gitMaybe(dir, ['rev-parse', '--show-prefix'])?.trim() === '' && dirsOf(dirs, dir)?.common === common);
}

/**
 * Resolves the workspace, the master and the system, finds every copy and the changes each repository holds, and places
 * each change (or only `options.change`) in the repository that holds it. `dirs` is a cache of git directories the
 * caller may share with its own lookups.
 */
export function placeChanges(cwd: string, options: StateOptions, dirs: Dirs = new Map()): Placement {
  const resolution = resolveWorkspace(cwd, { ...(options.master ? { master: options.master } : {}), ...(options.workspace ? { workspace: options.workspace } : {}) });
  if (resolution.master === null || resolution.workspace === null) throw new CouldNotRun(resolution.problems.join('\n'));
  const { master, workspace } = resolution;
  const systems = Object.keys(readMarker(join(master, '.ai-sdlc.json')).systems);
  let system: string;
  if (options.system !== undefined) {
    if (!systems.includes(options.system)) throw new CouldNotRun(`the marker lists no system ${options.system}`);
    system = options.system;
  } else if (options.change !== undefined) {
    system = findChange(master, workspace, options.change).system;
  } else if (systems.length === 1) {
    system = systems[0] as string;
  } else {
    throw new CouldNotRun(`the marker lists ${systems.length === 0 ? 'no systems' : `several systems (${systems.join(', ')})`}; pass --system <system>`);
  }

  // Every repository that may hold a change: the master and every copy of it, each with the changes it holds.
  const copies = copiesOf(workspace, master, dirs);
  const repos = [...new Set([master, ...copies])];
  const reads = new Map(repos.map((top) => [top, new SystemRead(top, system)]));
  const holds = new Map(repos.map((top) => [top, changesIn(top, system, reads.get(top) as SystemRead)]));
  const names = options.change !== undefined ? [options.change] : [...new Set([...holds.values()].flatMap((s) => [...s]))].sort();

  const placed = names.map((change) => {
    // The change's own copy first, then the master (the order findChange uses), then any other copy.
    const order = [...new Set([...changeHolders(master, workspace, change).map(real), ...repos])].filter((top) => holds.has(top));
    const top = order.find((t) => holds.get(t)?.has(change));
    if (top === undefined) throw new CouldNotRun(`no change ${change} in system ${system} in ${master} or a copy of it`);
    return { change, top, inCopy: top === master ? resolution.masterIsCopy : true };
  });
  return { system, master, workspace, masterIsCopy: resolution.masterIsCopy, copies, reads, placed };
}

/** The title and track of a change from its intent's front matter: the working text, else the `HEAD` text. */
export function titleAndTrack(working: string | null, head: string | null, file: string, headName: string): { title: string | null; track: 'full' | 'fix' } {
  const fromIntent = (field: string): unknown => {
    const value = working === null ? undefined : fieldOf(working, file, field);
    if (value !== undefined && value !== null) return value;
    return head === null ? undefined : fieldOf(head, headName, field);
  };
  const title = fromIntent('title');
  return { title: title === undefined || title === null ? null : String(title), track: fromIntent('track') === 'fix' ? 'fix' : 'full' };
}
