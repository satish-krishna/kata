// Apps in the single-repo layout: one repository holds every app, each in a folder, and an app plays the role a
// repository plays in the default layout. This file maps names to folders and paths, and files and commits to apps.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { baseBranch, baseRevision, changedFilesBetween, commitOf, lastCommitTouching, mergeBase } from '../git/git.ts';
import { CouldNotRun } from '../common/types.ts';
import { excludingOwnFiles, uncommittedFiles } from './own-files.ts';
import { readMarker } from './marker.ts';

/** Whether the master's marker says the single-repo layout; false when the marker is missing. */
export function isSingleRepo(master: string): boolean {
  const file = join(master, '.ai-sdlc.json');
  return existsSync(file) && readMarker(file).layout === 'single-repo';
}

/** The system's apps: name to folder, relative to the repository root, in the marker's order. */
export function appFolders(master: string, system: string): Record<string, string> {
  return readMarker(join(master, '.ai-sdlc.json')).systems[system]?.apps ?? {};
}

/** The pathspecs for an app: its folder, leaving out ai-sdlc's own files (which matters for the folder `.`). */
export const appPathspec = (folder: string): string[] => [folder, ...excludingOwnFiles()];

/**
 * The uncommitted files of an app: those of the repository at `root` (ai-sdlc's own files left out) that lie in the
 * app's folder, as paths relative to the root. Another app's uncommitted files are not the app's.
 */
export function uncommittedInApp(root: string, folder: string): string[] {
  const all = uncommittedFiles(root);
  return folder === '.' ? all : all.filter((p) => p === folder || p.startsWith(`${folder}/`));
}

/**
 * The path of a repository by name. In the default layout it is `<workspace>/<name>`; in the single-repo layout it is
 * the app's folder inside `master`, which is the change's copy when the caller has one.
 */
export function repoPathOf(master: string, workspace: string, system: string, name: string): string {
  if (!isSingleRepo(master)) return join(workspace, name);
  const folder = appFolders(master, system)[name];
  if (folder === undefined) throw new CouldNotRun(`system ${system} has no app ${name}`);
  return join(master, folder);
}

/**
 * The product repositories a change's branch can exist in, as name and path, for those on this machine. In the default
 * layout that is each listed repository in the workspace. In the single-repo layout there are none: the apps are
 * folders of the one repository, the master (or its copy), which callers handle as `master`, so an app name never names
 * a repository, even when a folder of that name sits in the workspace.
 */
export function productRepositories(master: string, workspace: string, repos: string[]): { repo: string; path: string }[] {
  if (isSingleRepo(master)) return [];
  return repos.map((r) => ({ repo: r, path: join(workspace, r) })).filter((r) => existsSync(r.path));
}

/**
 * An app's head: the latest commit reachable from `rev`, beyond the merge base of `base` and `rev`, that touches the
 * app's folder; the merge base itself when none does.
 */
export function appHead(root: string, rev: string, folder: string, base: string): string {
  const fork = mergeBase(root, baseRevision(root, base) ?? base, rev);
  if (fork === null) throw new CouldNotRun(`${base} and ${rev} have no common commit in ${root}`);
  return lastCommitTouching(root, `${fork}..${rev}`, appPathspec(folder)) ?? fork;
}

/**
 * The head of a named app at `root`'s HEAD, against the repository's base branch (as events/context.ts does); null when
 * the app is not the system's, the repository has no base branch (named but neither local nor fetched counts), or it
 * has no commit yet. A git failure still stops the program.
 */
export function currentAppHead(root: string, master: string, system: string, app: string): string | null {
  const folder = appFolders(master, system)[app];
  const base = baseBranch(root);
  if (folder === undefined || base === null || baseRevision(root, base) === null || commitOf(root, 'HEAD') === null) return null;
  return appHead(root, 'HEAD', folder, base);
}

/** The system's apps with a changed file between the merge base of `base` and `rev` and `rev`, in the marker's order. */
export function touchedApps(root: string, system: string, master: string, base: string, rev: string): string[] {
  const fork = mergeBase(root, baseRevision(root, base) ?? base, rev);
  if (fork === null) throw new CouldNotRun(`${base} and ${rev} have no common commit in ${root}`);
  return Object.entries(appFolders(master, system))
    .filter(([, folder]) => changedFilesBetween(root, fork, rev, appPathspec(folder)).length > 0)
    .map(([name]) => name);
}
