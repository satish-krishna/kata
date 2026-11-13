// Works out what an event runs on: the workspace, the master repository (the change's copy when it has one), the
// change and its system, and the repository with its branch, base branch and head. Everything comes from the
// workspace on disk and the arguments, never from what an agent says.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { CouldNotRun } from '../common/types.ts';
import { baseBranch, commitOf, currentBranch, topLevel } from '../git/git.ts';
import { recoverInterrupted } from '../baseline/take.ts';
import { appFolders, appHead, isSingleRepo, repoPathOf, uncommittedInApp } from '../workspace/apps.ts';
import { uncommittedFiles } from '../workspace/own-files.ts';
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
  /** Where the event's commands run: the repository, or in the single-repo layout the app's folder inside it. */
  repoPath: string;
  /** The git repository: `repoPath` in the default layout, the repository root (the change's copy) in the single-repo layout. */
  root: string;
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
  if (isSingleRepo(master)) return Object.keys(appFolders(master, system));
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
  // A baseline killed on the base commit left the change's copy detached there, without the change's folder, so the
  // change cannot be found until the copy is back on its branch: put it back first.
  if (isSingleRepo(resolution.master)) {
    const copy = join(copiesFolder(workspace), args.change);
    if (existsSync(join(copy, '.git'))) recoverInterrupted(copy);
  }
  const found = findChange(resolution.master, workspace, args.change, args.system);
  const repos = systemRepos(found.master, workspace, found.system);
  const single = isSingleRepo(found.master);
  let repo = 'master';
  if (PER_REPOSITORY.includes(args.event)) {
    if (args.repo) repo = args.repo;
    else if (single) {
      const inferred = appAt(found.master, found.system, cwd);
      if (inferred === null) throw new CouldNotRun(`${args.event} runs in one repository: pass --repo <repo>, or run it from inside the repository`);
      repo = inferred;
    } else {
      const top = topLevel(cwd);
      if (top === null || resolvePath(top, '..') !== resolvePath(workspace)) throw new CouldNotRun(`${args.event} runs in one repository: pass --repo <repo>, or run it from inside the repository`);
      repo = basename(top);
    }
    if (repo !== 'master' && !repos.includes(repo)) throw new CouldNotRun(`${repo} is not ${single ? 'an app' : 'a repository'} of system ${found.system} (${repos.join(', ') || 'none'})`);
  }
  // In the single-repo layout every event runs in the one repository (the change's copy); `root` is that repository,
  // and `repoPath` is the app's folder in it for a per-repository event. In the default layout the two are the same.
  const repoPath = repo === 'master' ? found.master : repoPathOf(found.master, workspace, found.system, repo);
  const root = single ? found.master : repoPath;
  if (!existsSync(join(root, '.git'))) throw new CouldNotRun(`${repo} is not checked out in ${workspace}`);
  const context: EventContext = {
    event: args.event,
    workspace,
    master: found.master,
    system: found.system,
    change: args.change,
    folder: join(found.master, 'intent', found.system, args.change),
    repo,
    repoPath,
    root,
    branch: currentBranch(root),
    base: baseBranch(root),
    head: null,
    repos,
    extra: args.extra,
  };
  context.head = headOf(context);
  return context;
}

/** The app whose folder holds `cwd` in a single-repo master (the change's copy when it has one), or null. */
function appAt(master: string, system: string, cwd: string): string | null {
  const real = (p: string): string => (existsSync(p) ? realpathSync(p) : resolvePath(p));
  const here = real(cwd);
  for (const [name, folder] of Object.entries(appFolders(master, system))) {
    const inside = relative(real(join(master, folder)), here);
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) return name;
  }
  return null;
}

/**
 * The commit an event's results are keyed by. In the single-repo layout, for an app, it is the app's head (the latest
 * commit on the branch touching its folder, else the merge base), so a commit elsewhere in the repository does not
 * make the app's results stale; otherwise it is the repository's HEAD. Every step that moves HEAD and wants the new
 * key calls this instead of reading HEAD itself.
 */
export function headOf(ctx: EventContext): string | null {
  if (ctx.repo === 'master' || !isSingleRepo(ctx.master)) return commitOf(ctx.repoPath, 'HEAD');
  const folder = appFolders(ctx.master, ctx.system)[ctx.repo];
  if (folder === undefined || ctx.base === null || commitOf(ctx.root, 'HEAD') === null) return null;
  return appHead(ctx.root, 'HEAD', folder, ctx.base);
}

/**
 * The uncommitted files an event holds against its repository. In the single-repo layout, for an app, they are the
 * ones in the app's folder (paths relative to the repository root); another app's do not count. Otherwise they are
 * the repository's, leaving out ai-sdlc's own files when it is the master.
 */
export function uncommittedOf(ctx: EventContext): string[] {
  if (ctx.repo === 'master' || !isSingleRepo(ctx.master)) return uncommittedFiles(ctx.repoPath);
  const folder = appFolders(ctx.master, ctx.system)[ctx.repo];
  return folder === undefined ? uncommittedFiles(ctx.root) : uncommittedInApp(ctx.root, folder);
}
