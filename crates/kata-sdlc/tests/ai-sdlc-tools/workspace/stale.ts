// `stale --json`: whether each repository's context file is behind its repository (workspace reference section 7).
// A context file records its repository's commit in `source_commit`; it is stale when the repository has commits
// after it that touch product files. ai-sdlc's own files never count, so the master listed as one of the system's
// repositories is not made stale by its own documents. GRAMMAR.md ("Staleness of context") defines every field.
// It only reads.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CouldNotRun } from '../common/types.ts';
import { parseFrontMatter } from '../documents/front-matter.ts';
import { systemRepos } from '../events/context.ts';
import { commitOf, countCommits } from '../git/git.ts';
import { excludingOwnFiles } from './own-files.ts';
import { resolveWorkspace, type ResolveOptions } from './resolve.ts';

export type StaleReason = 'missing' | 'not-checked-out' | 'no-source-commit' | 'unknown-commit' | 'behind' | 'current';

export type RepoStaleness = {
  repo: string;
  path: string;
  checkedOut: boolean;
  context: string;
  exists: boolean;
  sourceCommit: string | null;
  behind: number | null;
  stale: boolean;
  reason: StaleReason;
};

export type StaleResult = { system: string; repos: RepoStaleness[]; problems: string[] };

export type StaleOptions = ResolveOptions & { system: string; repos?: string[] };

/** The context file's `source_commit`, or null when it has none or its front matter cannot be read. */
function sourceCommitOf(file: string): string | null {
  try {
    const value = parseFrontMatter(readFileSync(file, 'utf8'), file).data['source_commit'];
    if (value === undefined || value === null) return null;
    const sha = String(value).trim();
    return sha === '' ? null : sha;
  } catch (e) {
    if (e instanceof CouldNotRun || (e as NodeJS.ErrnoException).code !== undefined) return null;
    throw e;
  }
}

function staleness(master: string, workspace: string, system: string, repo: string): RepoStaleness {
  const path = join(workspace, repo);
  const context = join(master, 'intent', system, 'context', `${repo}.md`);
  const checkedOut = existsSync(join(path, '.git'));
  const exists = existsSync(context);
  const sourceCommit = exists ? sourceCommitOf(context) : null;
  const entry = (behind: number | null, stale: boolean, reason: StaleReason): RepoStaleness => ({ repo, path, checkedOut, context, exists, sourceCommit, behind, stale, reason });
  if (!exists) return entry(null, false, 'missing');
  if (!checkedOut) return entry(null, false, 'not-checked-out');
  if (sourceCommit === null) return entry(null, true, 'no-source-commit');
  const commit = sourceCommit.startsWith('-') ? null : commitOf(path, sourceCommit);
  if (commit === null) return entry(null, true, 'unknown-commit');
  const behind = countCommits(path, commit, 'HEAD', ['.', ...excludingOwnFiles()]);
  if (behind === null) return entry(null, true, 'unknown-commit');
  return behind > 0 ? entry(behind, true, 'behind') : entry(0, false, 'current');
}

/** The staleness of every context file of a system (or of `options.repos`), in the marker's order. */
export function staleContexts(cwd: string, options: StaleOptions): StaleResult {
  const resolution = resolveWorkspace(cwd, { ...(options.master ? { master: options.master } : {}), ...(options.workspace ? { workspace: options.workspace } : {}) });
  if (resolution.master === null || resolution.workspace === null) throw new CouldNotRun(resolution.problems.join('\n'));
  const { master, workspace } = resolution;
  const all = systemRepos(master, workspace, options.system);
  const unknown = (options.repos ?? []).filter((r) => !all.includes(r));
  if (unknown.length > 0) throw new CouldNotRun(`${unknown.join(', ')} ${unknown.length === 1 ? 'is not a repository' : 'are not repositories'} of system ${options.system} (${all.join(', ') || 'none'})`);
  const repos = options.repos === undefined || options.repos.length === 0 ? all : all.filter((r) => options.repos?.includes(r));
  return { system: options.system, repos: repos.map((repo) => staleness(master, workspace, options.system, repo)), problems: [] };
}
