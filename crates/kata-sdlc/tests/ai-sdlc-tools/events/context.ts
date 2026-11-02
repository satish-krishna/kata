// Works out what an event runs on: the workspace, the master repository (the change's copy when it has one), the
// change and its system, and the repository with its branch, base branch and head. Everything comes from the
// workspace on disk and the arguments, never from what an agent says.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import { CouldNotRun } from '../common/types.ts';
import { baseBranch, commitOf, currentBranch, topLevel } from '../git/git.ts';
import { readMarker } from '../workspace/marker.ts';
import { resolveWorkspace, type ResolveOptions } from '../workspace/resolve.ts';
import { PER_REPOSITORY, type EventName } from './config.ts';

export type EventContext = {
  event: EventName;
  workspace: string;
  /** The master repository the change lives in: the change's copy when it has one. */
  master: string;
  system: string;
  change: string;
  /** The change's folder in the master. */
  folder: string;
  /** The repository the event runs in: a product repository's name, or `master`. */
  repo: string;
  repoPath: string;
  branch: string | null;
  base: string | null;
  head: string | null;
  /** The system's product repositories, as the marker lists them (every one in the workspace when it lists none). */
  repos: string[];
  /** Arguments an event's own step uses: `document` for doc.accept, `task` for task.done. */
  extra: Record<string, string>;
};

/** Where copies of the master live: `<workspace>/.ai-sdlc/copies/<change>/`. */
export const copiesFolder = (workspace: string): string => join(workspace, '.ai-sdlc', 'copies');

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

/** The systems whose `intent/<system>/<change>` exists in a master. */
function systemsHolding(master: string, change: string): string[] {
  const intent = join(master, 'intent');
  if (!isDir(intent)) return [];
  return readdirSync(intent).filter((s) => isDir(join(intent, s, change)));
}

/** A system's product repositories: the marker's list, or every repository in the workspace except the master. */
export function systemRepos(master: string, workspace: string, system: string): string[] {
  const marker = readMarker(join(master, '.ai-sdlc.json'));
  const entry = marker.systems[system];
  if (!entry) throw new CouldNotRun(`the marker lists no system ${system}`);
  if (entry.repos.length > 0) return entry.repos;
  return readdirSync(workspace).filter((name) => !name.startsWith('.') && existsSync(join(workspace, name, '.git')) && !existsSync(join(workspace, name, '.ai-sdlc.json')));
}

/**
 * Where to look for a change, first match wins: the change's own copy (`<workspace>/.ai-sdlc/copies/<change>/`), whose
 * documents are the change's latest, then the resolved master. `findChange` and `state` both decide by this order.
 */
export function changeHolders(master: string, workspace: string, change: string): string[] {
  const own = join(copiesFolder(workspace), change);
  return [...new Set([own, master].filter(isDir).map((p) => resolvePath(p)))];
}

/** Finds the master holding the change: the change's copy in the workspace, else the resolved master. */
export function findChange(master: string, workspace: string, change: string, system?: string): { master: string; system: string } {
  const candidates = changeHolders(master, workspace, change);
  for (const m of candidates) {
    const systems = system ? systemsHolding(m, change).filter((s) => s === system) : systemsHolding(m, change);
    if (systems.length === 1) return { master: m, system: systems[0] as string };
    if (systems.length > 1) throw new CouldNotRun(`${change} is a change of several systems (${systems.join(', ')}); pass --system`);
  }
  throw new CouldNotRun(`no change ${change}${system ? ` in system ${system}` : ''} in ${master}${candidates.length > 1 ? ' or its copy' : ''}`);
}

export type ContextArgs = { event: EventName; change: string; system?: string; repo?: string; options: ResolveOptions; extra: Record<string, string> };

export function eventContext(cwd: string, args: ContextArgs): EventContext {
  const resolution = resolveWorkspace(cwd, args.options);
  if (resolution.master === null || resolution.workspace === null) throw new CouldNotRun(resolution.problems.join('\n'));
  const workspace = resolution.workspace;
  const found = findChange(resolution.master, workspace, args.change, args.system);
  const repos = systemRepos(found.master, workspace, found.system);
  let repo = 'master';
  if (PER_REPOSITORY.includes(args.event)) {
    if (args.repo) repo = args.repo;
    else {
      const top = topLevel(cwd);
      if (top === null || resolvePath(top, '..') !== resolvePath(workspace)) throw new CouldNotRun(`${args.event} runs in one repository: pass --repo <repo>, or run it from inside the repository`);
      repo = basename(top);
    }
    if (repo !== 'master' && !repos.includes(repo)) throw new CouldNotRun(`${repo} is not a repository of system ${found.system} (${repos.join(', ') || 'none'})`);
  }
  const repoPath = repo === 'master' ? found.master : join(workspace, repo);
  if (!existsSync(join(repoPath, '.git'))) throw new CouldNotRun(`${repo} is not checked out in ${workspace}`);
  return {
    event: args.event,
    workspace,
    master: found.master,
    system: found.system,
    change: args.change,
    folder: join(found.master, 'intent', found.system, args.change),
    repo,
    repoPath,
    branch: currentBranch(repoPath),
    base: baseBranch(repoPath),
    head: commitOf(repoPath, 'HEAD'),
    repos,
    extra: args.extra,
  };
}
