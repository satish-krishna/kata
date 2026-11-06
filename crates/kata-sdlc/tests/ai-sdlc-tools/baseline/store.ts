// The baseline store: how each of a repository's checks did on a base commit, kept on this machine in the master
// repository's common git folder, `ai-sdlc/<system>/.baselines/<repo>.json`. It is shared by every change of the
// system, so a baseline taken once for a base commit is reused by every build on that commit. An entry counts only
// for its base commit and its signature (the checks and their scripts), so a changed check takes a new baseline. The
// folder name starts with a dot, so it is never taken for a change's ledger folder.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitPath } from '../git/git.ts';

/** One check on the base. A check that could not run is never stored, so `outcome` is passed or failed. */
export type BaselineHook = { id: string; outcome: 'passed' | 'failed'; exitCode: number | null; ids: string[] | null; output: string };

export type BaselineEntry = { base: string; signature: string; at: string; hooks: BaselineHook[] };

type Store = { version: 1; repo: string; entries: BaselineEntry[] };

const KEEP = 20;

export const baselineFile = (master: string, system: string, repo: string): string => gitPath(master, join('ai-sdlc', system, '.baselines', `${repo}.json`), true);

function read(file: string, repo: string): Store {
  if (!existsSync(file)) return { version: 1, repo, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Store;
    return Array.isArray(parsed.entries) ? parsed : { version: 1, repo, entries: [] };
  } catch {
    return { version: 1, repo, entries: [] };
  }
}

/** Writes by renaming a finished file into place, so a reader never sees half a store. */
function write(file: string, store: Store): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(store, null, 2) + '\n');
  renameSync(temp, file);
}

export function findEntry(master: string, system: string, repo: string, base: string, signature: string): BaselineEntry | null {
  return read(baselineFile(master, system, repo), repo).entries.find((e) => e.base === base && e.signature === signature) ?? null;
}

/** Stores an entry, replacing one for the same base and signature, keeping the newest 20. */
export function saveEntry(master: string, system: string, repo: string, entry: BaselineEntry): void {
  const file = baselineFile(master, system, repo);
  const store = read(file, repo);
  const others = store.entries.filter((e) => !(e.base === entry.base && e.signature === entry.signature));
  write(file, { ...store, entries: [...others, entry].slice(-KEEP) });
}

export function dropEntry(master: string, system: string, repo: string, base: string, signature: string): void {
  const file = baselineFile(master, system, repo);
  if (!existsSync(file)) return;
  const store = read(file, repo);
  write(file, { ...store, entries: store.entries.filter((e) => !(e.base === base && e.signature === signature)) });
}
