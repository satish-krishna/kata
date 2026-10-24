import type { Part } from '@bindings/Part';

/** What the Changes view does when the engineer picks a finding. */
export type FindingOutcome =
  | { kind: 'no-file' }
  | { kind: 'not-in-change' }
  | { kind: 'choose'; repos: string[]; path: string; line: number | null }
  | { kind: 'show'; repo: string; path: string; line: number | null; switchToWhole: boolean };

/** One repository's changed files for each part of the change, as repository-relative paths. */
export type RepoPaths = { repo: string; whole: string[]; committed: string[]; uncommitted: string[] };

/**
 * Finds where a finding's file is in the change. A path whose first folder is a listed repository's name is looked up,
 * without that folder, in that repository only; any other path is looked up in every repository. A finding with a line
 * but no file names nothing.
 */
export function locateFinding(_f: { file?: string; line?: number }, _repos: RepoPaths[], _part: Part): FindingOutcome {
  throw new Error('not implemented');
}
