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
export function locateFinding(f: { file?: string; line?: number; repo?: string }, repos: RepoPaths[], part: Part): FindingOutcome {
  const file = f.file?.trim().replaceAll('\\', '/');
  if (!file) return { kind: 'no-file' };
  const line = f.line ?? null;
  const [first, ...rest] = file.split('/');
  const named = rest.length > 0 ? repos.find((r) => r.repo === first) : undefined;
  const path = named ? rest.join('/') : file;
  const having = (named ? [named] : repos).filter((r) => r.whole.includes(path));
  if (having.length === 0) return { kind: 'not-in-change' };
  if (having.length > 1) return { kind: 'choose', repos: having.map((r) => r.repo), path, line };
  const [only] = having;
  return { kind: 'show', repo: only.repo, path, line, switchToWhole: !only[part].includes(path) };
}
