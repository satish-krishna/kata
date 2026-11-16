// A team's branch and pull request naming, and the rules for branch names and commit scopes.
import { readFileSync } from 'node:fs';
import { CouldNotRun } from '../common/types.ts';

/** The team's naming patterns as a marker holds them; either string may be missing. */
export type NamingSetting = { branch?: string; pullRequestTitle?: string };

export type NamingRead = { declared: false } | { declared: true; setting: NamingSetting };

export type NamingValues = { type: string; scope: string; change: string; title?: string };

export type RenderedNames = { branch: string; pullRequestTitle: string | null };

const PARTS = ['type', 'scope', 'slug', 'change', 'title'];
const SAMPLE = { type: 'feat', scope: 'PROJ-123', change: '2026-01-01-sample' };

/** Reads `systems.<system>.naming` from a marker file. A marker that is not JSON is a program failure. */
export function readNaming(markerPath: string, system: string): NamingRead {
  let text: string;
  try {
    text = readFileSync(markerPath, 'utf8');
  } catch (e) {
    throw new CouldNotRun(`${markerPath}: cannot read the marker: ${(e as Error).message}`);
  }
  return namingFromText(text, system, markerPath);
}

/** Reads `systems.<system>.naming` from a marker's text, such as the copy committed on the base branch. */
export function namingFromText(text: string, system: string, markerPath: string): NamingRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CouldNotRun(`${markerPath}: cannot read the marker: ${(e as Error).message}`);
  }
  const systems = (raw as { systems?: unknown } | null)?.systems;
  const entry =
    systems !== null && typeof systems === 'object' ? (systems as Record<string, unknown>)[system] : undefined;
  if (entry === null || typeof entry !== 'object') {
    throw new CouldNotRun(`${markerPath}: the marker lists no system "${system}"`);
  }
  if (!('naming' in entry)) return { declared: false };
  const naming = (entry as { naming?: unknown }).naming;
  const setting: NamingSetting = {};
  if (naming !== null && typeof naming === 'object') {
    const { branch, pullRequestTitle } = naming as Record<string, unknown>;
    if (typeof branch === 'string') setting.branch = branch;
    if (typeof pullRequestTitle === 'string') setting.pullRequestTitle = pullRequestTitle;
  }
  return { declared: true, setting };
}

/** Why git, or the tool driving the build, would refuse a branch name; empty when the name is usable. */
export function checkBranchName(name: string): string[] {
  if (name === '') return ['a branch name cannot be empty'];
  if (name.startsWith('-')) return ['a branch name cannot start with -'];
  if (name.startsWith('change/pending-')) return ['names starting "change/pending-" are reserved for the tool driving the build'];
  const problems: string[] = [];
  if (name.includes(' ')) problems.push('a branch name cannot contain a space');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) problems.push('a branch name cannot contain a control character');
  if (/[~^:?*[\\]/.test(name)) problems.push('a branch name cannot contain any of ~ ^ : ? * [ \\');
  if (name.includes('..')) problems.push('a branch name cannot contain ".."');
  if (name.includes('@{')) problems.push('a branch name cannot contain "@{"');
  if (name === 'HEAD') problems.push('a branch name cannot be "HEAD"');
  if (name === '@') problems.push('a branch name cannot be "@"');
  const segments = name.split('/');
  if (segments.some((s) => s === '')) problems.push('a branch name cannot contain an empty path segment');
  if (segments.some((s) => s.startsWith('.'))) problems.push('a branch name cannot have a path segment starting with "."');
  if (segments.some((s) => s.endsWith('.lock'))) problems.push('a branch name cannot end in ".lock"');
  if (name.endsWith('.')) problems.push('a branch name cannot end in "."');
  return problems;
}

/** Why a scope is not usable; empty when it is accepted as typed. The first rule that applies is reported. */
export function checkScope(scope: string): string[] {
  if (scope === '') return ['a scope cannot be empty'];
  if (scope.length > 64) return ['a scope can be at most 64 characters'];
  if (scope.includes(' ')) return ['a scope cannot contain a space'];
  if (/[()]/.test(scope)) return ['a scope cannot contain parentheses'];
  if (!/^[A-Za-z0-9]/.test(scope)) return ['a scope must start with a letter or a digit'];
  if (!/^[A-Za-z0-9._-]*$/.test(scope)) return ['a scope can hold only letters, digits, "-", "_" and "."'];
  if (scope.includes('..')) return ['a scope cannot contain ".."'];
  if (scope === 'HEAD') return ['a scope cannot be "HEAD"'];
  if (scope.endsWith('.')) return ['a scope cannot end in "."'];
  if (scope.endsWith('.lock')) return ['a scope cannot end in ".lock"'];
  return [];
}

function slugOf(change: string): string {
  return change.replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

function fill(pattern: string, parts: Record<string, string>): string {
  return pattern.replace(/\{([^{}]*)\}/g, (whole, part: string) => (Object.hasOwn(parts, part) ? (parts[part] as string) : whole));
}

function partsOf(values: NamingValues): Record<string, string> {
  const parts: Record<string, string> = {
    type: values.type,
    scope: values.scope,
    change: values.change,
    slug: slugOf(values.change),
  };
  if (values.title !== undefined) parts.title = values.title;
  return parts;
}

/** Checks a setting; every problem is reported, in a fixed order. */
export function checkNaming(setting: NamingSetting): string[] {
  const problems: string[] = [];
  const { branch, pullRequestTitle } = setting;
  if (!branch || !pullRequestTitle) {
    problems.push('a naming setting needs both a branch pattern and a pull request title pattern');
  }
  const unknown = new Set<string>();
  for (const pattern of [branch, pullRequestTitle]) {
    for (const m of (pattern ?? '').matchAll(/\{([^{}]*)\}/g)) {
      if (!PARTS.includes(m[1] as string)) unknown.add(m[1] as string);
    }
  }
  for (const part of unknown) problems.push(`"${part}" is not a known part of a name`);
  if (branch && /\{title\}/.test(branch)) problems.push('the title can only be used in the pull request title');
  if (branch && !/{(slug|change|scope)}/.test(branch)) {
    problems.push('the branch pattern needs {slug}, {change} or {scope}, so that each change gets its own branch');
  }
  if (branch) {
    const sample = fill(branch, { ...partsOf(SAMPLE), title: 'title' });
    for (const p of checkBranchName(sample)) problems.push(`branch pattern "${branch}": ${p}`);
  }
  return problems;
}

/** Fills the patterns. Rendering never validates; callers check the branch with checkBranchName. */
export function renderNaming(setting: NamingSetting, values: NamingValues): RenderedNames {
  const parts = partsOf(values);
  return {
    branch: fill(setting.branch ?? '', parts),
    pullRequestTitle: values.title === undefined ? null : fill(setting.pullRequestTitle ?? '', parts),
  };
}
