// Finds and reads the master repository's marker, `.ai-sdlc.json`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CouldNotRun } from '../common/types.ts';

/** `workspace`: a master repository beside product repositories. `single-repo`: one repository holding the apps and `intent/`. */
export type Layout = 'workspace' | 'single-repo';

/**
 * The master repository's `.ai-sdlc.json`: the layout and the systems. A system lists `repos` in the `workspace`
 * layout and `apps` (name to folder, `/`-separated and without a trailing slash) in the `single-repo` layout; the
 * other one is empty.
 */
export type Marker = { layout: Layout; systems: Record<string, { repos: string[]; apps: Record<string, string> }> };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An app or repository name: starts with a letter or a digit, then letters, digits, `.`, `_` and `-`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * An app folder with `/` separators, no `./` segments, no repeated or trailing slash; `.` stays `.`.
 * Null for a folder that is not a relative path inside the repository: not a string, empty, absolute, holding `\` or `..`.
 */
export function normalizeFolder(folder: unknown): string | null {
  if (typeof folder !== 'string' || folder.trim() === '') return null;
  if (folder.includes('\\') || folder.startsWith('/') || /^[A-Za-z]:/.test(folder)) return null;
  const parts = folder.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) return null;
  return parts.length === 0 ? '.' : parts.join('/');
}

/** Whether `inner` is `outer` or inside it; neither is `.`. */
const within = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}/`);

/**
 * The problems with a parsed marker's layout and apps, one sentence each, naming the field or the app. Problems with
 * a folder's existence are not here: they need the base branch, so `check` finds them. A marker that is not an
 * object or lists no systems has no problems here; `readMarker` refuses it.
 */
export function markerProblems(raw: unknown): string[] {
  if (!isObject(raw) || !isObject(raw.systems)) return [];
  const problems: string[] = [];
  const layout = raw.layout === undefined ? 'workspace' : raw.layout;
  if (layout !== 'workspace' && layout !== 'single-repo') {
    problems.push(`layout must be "workspace" or "single-repo", not ${JSON.stringify(layout)}`);
    return problems;
  }
  const systems = Object.entries(raw.systems);
  if (layout === 'workspace') {
    for (const [name, system] of systems) {
      if (isObject(system) && system.apps !== undefined) problems.push(`system ${name}: apps is only for the "single-repo" layout; the default layout lists repos`);
    }
    return problems;
  }
  if (systems.length !== 1) problems.push(`the "single-repo" layout needs exactly one system, found ${systems.length}`);
  for (const [name, system] of systems) {
    const at = `system ${name}`;
    const body = isObject(system) ? system : {};
    if (body.repos !== undefined) problems.push(`${at}: repos is not allowed in the "single-repo" layout; list apps instead`);
    if (!isObject(body.apps) || Object.keys(body.apps).length === 0) {
      problems.push(`${at}: apps must map at least one app name to a folder`);
      continue;
    }
    const folders: [string, string][] = [];
    for (const [app, folder] of Object.entries(body.apps)) {
      if (app === 'master') problems.push(`${at}: app master: the name master is reserved for the master repository`);
      else if (!NAME.test(app)) problems.push(`${at}: app "${app}": a name must start with a letter or a digit and hold only letters, digits, ".", "_" and "-"`);
      const normal = normalizeFolder(folder);
      if (normal === null) problems.push(`${at}: app ${app}: the folder ${JSON.stringify(folder)} must be a relative path inside the repository, with "/" separators and no ".."`);
      else folders.push([app, normal]);
    }
    if (folders.length > 1) {
      for (const [app, folder] of folders) {
        if (folder === '.') problems.push(`${at}: app ${app}: the folder "." (the whole repository) is allowed only when it is the system's only app`);
      }
    }
    for (const [app, folder] of folders) {
      if (folder === '.') continue;
      for (const [other, otherFolder] of folders) {
        if (other !== app && otherFolder !== '.' && within(folder, otherFolder)) {
          problems.push(`${at}: app ${app}: the folder ${folder} is ${folder === otherFolder ? 'the same as' : 'inside'} the folder ${otherFolder} of app ${other}`);
        }
      }
    }
  }
  return problems;
}

/** Reads a marker file. A file that is not a marker is a program failure, not a document problem; `markerProblems` reports the rest. */
export function readMarker(path: string): Marker {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new CouldNotRun(`${path}: cannot read the marker: ${(e as Error).message}`);
  }
  const systems: Marker['systems'] = {};
  const listed = (raw as { systems?: unknown } | null)?.systems;
  if (listed === null || typeof listed !== 'object' || Array.isArray(listed)) {
    throw new CouldNotRun(`${path}: the marker lists no systems`);
  }
  const layout: Layout = (raw as { layout?: unknown }).layout === 'single-repo' ? 'single-repo' : 'workspace';
  for (const [name, value] of Object.entries(listed as Record<string, unknown>)) {
    const repos = (value as { repos?: unknown } | null)?.repos;
    const listedApps = (value as { apps?: unknown } | null)?.apps;
    const apps: Record<string, string> = {};
    if (layout === 'single-repo' && isObject(listedApps)) {
      for (const [app, folder] of Object.entries(listedApps)) {
        const normal = normalizeFolder(folder);
        if (normal !== null) apps[app] = normal;
      }
    }
    systems[name] = { repos: Array.isArray(repos) ? repos.filter((r): r is string => typeof r === 'string') : [], apps };
  }
  return { layout, systems };
}

/** Finds `.ai-sdlc.json` by walking up from the folder of `file`; null when no folder above holds one. */
export function findMarker(file: string): Marker | null {
  let dir = dirname(resolve(file));
  for (;;) {
    const candidate = join(dir, '.ai-sdlc.json');
    if (existsSync(candidate)) return readMarker(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
