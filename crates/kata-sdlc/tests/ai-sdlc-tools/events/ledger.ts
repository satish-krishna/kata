// The ledger: what every event run of a change did, kept on this machine in the master repository's git folder,
// `<git common dir>/ai-sdlc/<system>/<change>/<repo>.json`. Inside the git folder it is never committed, every copy
// of the master shares it, and it sits outside every working tree. One file per repository, because builds of
// different repositories run at the same time. A result counts only at the commit it was recorded at (its key).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitPath } from '../git/git.ts';
import type { EventName } from './config.ts';

export type HookRecord = { id: string; when: 'before' | 'after'; outcome: 'passed' | 'failed' | 'could-not-run'; exitCode: number | null; output: string };

export type EventRecord = {
  event: EventName;
  repo: string;
  /** What the result is about: the repository's head commit, or for doc.accept the document's commit. */
  key: string;
  /** For doc.accept, the document; for task.done, the task. */
  subject: string | null;
  outcome: Outcome;
  at: string;
  hooks: HookRecord[];
  problems: string[];
  /** The blocking hook that failed, and what it asks for. */
  failed: { id: string; onFailure: 'fix' | 'stop' } | null;
};

export type Outcome = 'passed' | 'failed' | 'refused' | 'could-not-run';

export type RepoLedger = {
  version: 1;
  system: string;
  change: string;
  repo: string;
  /** The repository's folder, so a reader can tell whether a result is still at its head. */
  path: string;
  runs: EventRecord[];
  /** How many times the Stop gate blocked a stop for one hook at one key: `<hook id>@<key>`. */
  gateBlocks: Record<string, number>;
};

/** The ledger folder of one change, in the master repository's common git folder. */
export const ledgerFolder = (master: string, system: string, change: string): string => gitPath(master, join('ai-sdlc', system, change), true);

const fileOf = (folder: string, repo: string): string => join(folder, `${repo}.json`);

export function readLedger(folder: string, repo: string): RepoLedger | null {
  const file = fileOf(folder, repo);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RepoLedger;
  } catch {
    return null;
  }
}

/** Every repository's ledger of one change. */
export function readLedgers(folder: string): RepoLedger[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const l = readLedger(folder, f.slice(0, -'.json'.length));
      return l ? [l] : [];
    });
}

/** Writes by renaming a finished file into place, so a reader never sees half a ledger. */
export function writeLedger(folder: string, ledger: RepoLedger): void {
  mkdirSync(folder, { recursive: true });
  const file = fileOf(folder, ledger.repo);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(ledger, null, 2) + '\n');
  renameSync(temp, file);
}

export function emptyLedger(system: string, change: string, repo: string, path: string): RepoLedger {
  return { version: 1, system, change, repo, path, runs: [], gateBlocks: {} };
}

/** The newest record of an event in a repository at a key, for a subject when given. */
export function latest(ledger: RepoLedger | null, event: EventName, key: string | null, subject: string | null = null): EventRecord | null {
  if (!ledger) return null;
  for (let i = ledger.runs.length - 1; i >= 0; i--) {
    const r = ledger.runs[i] as EventRecord;
    if (r.event === event && (key === null || r.key === key) && (subject === null || r.subject === subject)) return r;
  }
  return null;
}

/** Keeps the newest 200 runs, so a long change does not grow its ledger without end. */
export function appendRun(ledger: RepoLedger, record: EventRecord): RepoLedger {
  return { ...ledger, runs: [...ledger.runs, record].slice(-200) };
}
