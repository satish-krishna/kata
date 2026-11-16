// Finds the workspace and the master repository, or the change's own copy of it. The rules are in
// plugin/references/workspace.md, section 2.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { CouldNotRun } from '../common/types.ts';
import { LEGACY_MARKER, MARKER, readMarker, type Layout } from './marker.ts';

/**
 * Where the workspace and the master repository are. `master` is null whenever `problems` is not empty. `layout` is the
 * master's layout: `workspace` unless its marker says single-repo (and for a refusal before a master was identified).
 */
export type Resolution = {
  workspace: string | null;
  master: string | null;
  masterIsCopy: boolean;
  problems: string[];
  layout: Layout;
};

export type ResolveOptions = { master?: string; workspace?: string };

/** The marker file names a master may hold. */
type Markers = readonly string[];

/** Both names a master's marker has had, for `migrate`. */
export const ANY_MARKER: Markers = [MARKER, LEGACY_MARKER];

/** Runs git in `dir`; null when git fails there (not a repository, for example). Git missing is a program failure. */
function git(dir: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.error) throw new CouldNotRun(`cannot run git: ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}`);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The canonical form of a path, so two spellings of one folder compare equal (case and links on Windows). */
export function real(path: string): string {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return resolve(path);
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const holdsMarker = (folder: string, markers: Markers): boolean => markers.some((m) => existsSync(join(folder, m)));

/** The layout a folder's marker names. A marker that cannot be read says nothing here: it counts as the default layout. */
function layoutOf(folder: string, markers: Markers): Layout {
  try {
    const file = markers.map((m) => join(folder, m)).find((f) => existsSync(f));
    return file !== undefined && readMarker(file).layout === 'single-repo' ? 'single-repo' : 'workspace';
  } catch {
    return 'workspace';
  }
}

/** The root of the git repository `dir` is in, or null when it is in none. */
function toplevel(dir: string): string | null {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top === null ? null : real(top);
}

/** The git directory of the worktree and the git directory all its worktrees share. They differ in a linked worktree. */
export function gitDirs(dir: string): { gitDir: string; common: string } | null {
  // `--path-format` needs git 2.31, and an older git echoes an option it does not know, so it is not used: the common
  // directory may be relative, and is relative to `dir`. Anything but exactly two lines is not an answer.
  const lines = (git(dir, ['rev-parse', '--absolute-git-dir', '--git-common-dir']) ?? '').split(/\r?\n/);
  const [gitDir, common] = lines;
  if (lines.length !== 2 || !gitDir || !common || gitDir.startsWith('-') || common.startsWith('-')) return null;
  return { gitDir: real(gitDir), common: real(resolve(dir, common)) };
}

/**
 * The folder the master repository's own checkout sits in, from its shared git directory: the parent of
 * `core.worktree` when set; the folder holding a bare repository (whose checkouts are all linked worktrees); the
 * parent of the folder holding a `.git` directory. Null when the git directory is kept apart from any checkout and
 * names none (`git init --separate-git-dir`); `git worktree list` reports the git directory itself then, so it is not used.
 */
function repositoryWorkspace(common: string): string | null {
  const configured = git(common, ['config', '--get', 'core.worktree']);
  if (configured) return dirname(real(resolve(common, configured)));
  if (git(common, ['config', '--get', '--bool', 'core.bare']) === 'true') return dirname(common);
  return basename(common) === '.git' ? dirname(dirname(common)) : null;
}

/** The immediate child folders of the workspace that hold `.hoshin.json`, each with its shared git directory. */
function masterFolders(workspace: string, markers: Markers): { folder: string; common: string | null }[] {
  let entries: string[];
  try {
    entries = readdirSync(workspace, { withFileTypes: true })
      // A link to a folder (a junction on Windows) is a child folder too, as it is to the shell.
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isFolder(join(workspace, e.name))))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return entries
    .map((name) => real(join(workspace, name)))
    .filter((folder) => holdsMarker(folder, markers))
    .map((folder) => ({ folder, common: gitDirs(folder)?.common ?? null }));
}

const noMaster = (workspace: string) =>
  `No master repository found in \`${workspace}\`. An engineer needs to run the hoshin setup skill first.`;
const severalMasters = (folders: string[], markers: Markers) =>
  `Found more than one master repository (${folders.map((f) => `\`${f}\``).join(', ')}). A workspace has exactly one. Remove the extra ${markers.map((m) => `\`${m}\``).join(' or ')} files.`;

const refused = (workspace: string | null, problem: string, layout: Layout = 'workspace'): Resolution => ({
  workspace,
  master: null,
  masterIsCopy: false,
  problems: [problem],
  layout,
});

/**
 * Resolves the workspace and the master repository for a session whose directory is `cwd`.
 *
 * With neither option, and `cwd` not inside a copy, this is the rule every skill followed before copies existed: the
 * workspace is the parent of the current repository's root (or `cwd` itself outside a repository), and the master is
 * its one child folder holding `.hoshin.json`. A copy is a linked worktree of the master repository; when `cwd` is
 * inside one, or `--master` names one, the copy is the master and the workspace is found from the repository instead.
 *
 * In the single-repo layout the session's repository (or the one `--master` names) is the master itself, whatever else
 * the workspace holds, and the workspace is the parent of its main checkout.
 */
export function resolveWorkspace(cwd: string, options: ResolveOptions, markers: Markers = [MARKER]): Resolution {
  if (options.workspace !== undefined && !isFolder(options.workspace)) {
    return refused(null, `\`${resolve(options.workspace)}\` does not exist.`);
  }
  const workspaceOption = options.workspace === undefined ? undefined : real(options.workspace);
  const sessionTop = toplevel(cwd);

  if (options.master !== undefined) return withMaster(options.master, workspaceOption, sessionTop, markers);
  if (sessionTop !== null && holdsMarker(sessionTop, markers)) {
    if (layoutOf(sessionTop, markers) === 'single-repo') return withMaster(sessionTop, workspaceOption, sessionTop, markers);
    const dirs = gitDirs(sessionTop);
    if (dirs !== null && dirs.gitDir !== dirs.common) return withMaster(sessionTop, workspaceOption, sessionTop, markers);
  }

  // A session started in the workspace folder itself is in the workspace, even when that folder sits inside another
  // repository (a home folder kept under git): a folder with a master repository among its children is a workspace.
  const here = real(cwd);
  const startedInWorkspace = sessionTop !== null && here !== sessionTop && masterFolders(here, markers).length > 0;
  const workspace = workspaceOption ?? (sessionTop === null || startedInWorkspace ? here : dirname(sessionTop));
  const folders = masterFolders(workspace, markers).map((m) => m.folder);
  if (folders.length === 0) return refused(workspace, noMaster(workspace));
  if (folders.length > 1) return refused(workspace, severalMasters(folders, markers));
  const master = folders[0] as string;
  return { workspace, master, masterIsCopy: false, problems: [], layout: layoutOf(master, markers) };
}

/** The master named by `--master`, or the copy the session is in, checked against the workspace's master. */
function withMaster(path: string, workspaceOption: string | undefined, sessionTop: string | null, markers: Markers): Resolution {
  if (!isFolder(path)) return refused(workspaceOption ?? null, `\`${resolve(path)}\` does not exist.`);
  const master = real(path);
  const dirs = toplevel(master) === master ? gitDirs(master) : null;
  if (dirs === null) return refused(workspaceOption ?? null, `\`${master}\` is not the root of a git repository.`);
  if (!holdsMarker(master, markers)) {
    return refused(workspaceOption ?? null, `\`${master}\` holds no ${markers.join(' or ')}, so it is not a master repository or a copy of one.`);
  }

  // The repository is its own master: no other master is looked for among the workspace's children.
  if (layoutOf(master, markers) === 'single-repo') {
    const workspace = workspaceOption ?? repositoryWorkspace(dirs.common);
    if (workspace === null) {
      return refused(
        null,
        `Cannot tell where the main checkout of \`${master}\` is: its git directory, \`${dirs.common}\`, is kept apart from any checkout. Pass --workspace <path>.`,
        'single-repo',
      );
    }
    return { workspace, master, masterIsCopy: dirs.gitDir !== dirs.common, problems: [], layout: 'single-repo' };
  }

  // A session in another repository (a product repository) is in the workspace already: its parent folder, as ever.
  // A repository that holds the master below it is not a product repository but one the workspace sits in (a home
  // folder kept under git), so it says nothing about the workspace. Otherwise the workspace is the parent of the
  // master repository's main checkout.
  const sessionCommon = sessionTop === null ? null : (gitDirs(sessionTop)?.common ?? null);
  const holdsMaster = sessionTop !== null && master.startsWith(sessionTop + sep);
  let workspace = workspaceOption ?? null;
  if (workspace === null && sessionTop !== null && sessionCommon !== null && sessionCommon !== dirs.common && !holdsMaster) {
    workspace = dirname(sessionTop);
  }
  if (workspace === null) {
    workspace = repositoryWorkspace(dirs.common);
    if (workspace === null) {
      return refused(
        null,
        `Cannot tell where the main checkout of \`${master}\` is: its git directory, \`${dirs.common}\`, is kept apart from any checkout. Pass --workspace <path>.`,
      );
    }
  }

  const folders = masterFolders(workspace, markers);
  const same = folders.filter((f) => f.common === dirs.common);
  const others = folders.filter((f) => f.common !== dirs.common);
  if (same.length === 0) {
    if (others.length === 0) return refused(workspace, noMaster(workspace));
    if (others.length > 1) return refused(workspace, severalMasters(others.map((f) => f.folder), markers));
    return refused(
      workspace,
      `\`${master}\` is not a worktree of the master repository in \`${workspace}\` (\`${(others[0] as { folder: string }).folder}\`); they are different git repositories.`,
    );
  }
  if (others.length > 0) {
    return refused(workspace, severalMasters([...same.map((f) => f.folder), ...others.map((f) => f.folder)], markers));
  }
  return { workspace, master, masterIsCopy: dirs.gitDir !== dirs.common, problems: [], layout: 'workspace' };
}

/**
 * The folder name of the master repository in the workspace, as the workspace instructions write it: the master's
 * own folder when it is the main checkout there; when it is a copy, the workspace folder that is a worktree of the
 * same repository (its main checkout first), never the copy's own name.
 */
export function masterFolderName(workspace: string, master: string, markers: Markers = [MARKER]): string {
  const dirs = gitDirs(master);
  const own = real(master);
  if (dirs === null) return basename(own);
  const same = masterFolders(real(workspace), markers).filter((f) => f.common === dirs.common);
  const main = same.find((f) => gitDirs(f.folder)?.gitDir === dirs.common);
  const named = main ?? same.find((f) => f.folder !== own) ?? same[0];
  return basename(named?.folder ?? own);
}
