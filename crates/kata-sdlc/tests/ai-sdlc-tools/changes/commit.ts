// Every commit an ai-sdlc skill makes: which repository it goes to, which of the paths given go in, the documents
// checked first, the Conventional Commits header from the commit table, the trailers, and the commit itself. The rules
// were plugin/references/workspace.md section 8; the skills now only name the kind and the paths.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CouldNotRun, type ParsedReview } from '../common/types.ts';
import { formatProblem } from '../common/problems.ts';
import { checkFiles } from '../commands/check.ts';
import { readReview } from '../documents/review.ts';
import { findChange, systemRepos } from '../events/context.ts';
import { changedPaths, commitPaths, currentBranch, existsAt, showFile } from '../git/git.ts';
import { readMarker } from '../workspace/marker.ts';
import { real, resolveWorkspace, type ResolveOptions } from '../workspace/resolve.ts';
import { entriesOf } from './progress.ts';
import { COMMIT_TYPES } from './record.ts';
import { changeScope, systemScope } from './scope.ts';

/** The documents of a change, in the order they are written; a kind checks every one up to the last it may change. */
type Checked = 'none' | 'spec' | 'plan' | 'build' | 'review';

type KindRule = { needs: 'system' | 'none' | 'change' | 'work'; check: Checked; subject?: string };

/** The commit table: what each kind needs, what it checks, and the subject of the change-level kinds. */
export const KINDS: Record<string, KindRule> = {
  setup: { needs: 'system', check: 'none' },
  instructions: { needs: 'none', check: 'none' },
  context: { needs: 'system', check: 'none' },
  'intent-draft': { needs: 'change', check: 'none', subject: 'draft intent' },
  'intent-reopen': { needs: 'change', check: 'none', subject: 'reopen intent' },
  spec: { needs: 'change', check: 'spec', subject: 'write spec' },
  'spec-reopen': { needs: 'change', check: 'spec', subject: 'reopen spec' },
  plan: { needs: 'change', check: 'plan', subject: 'write plan' },
  'build-log': { needs: 'change', check: 'build' },
  review: { needs: 'change', check: 'review' },
  'fix-draft': { needs: 'change', check: 'plan', subject: 'draft fix' },
  'fix-reopen': { needs: 'change', check: 'plan', subject: 'reopen fix' },
  'accept-intent': { needs: 'change', check: 'none', subject: 'accept intent' },
  'accept-spec': { needs: 'change', check: 'plan', subject: 'accept spec' },
  'accept-plan': { needs: 'change', check: 'plan', subject: 'accept plan' },
  'reject-intent': { needs: 'change', check: 'none', subject: 'reject intent' },
  'reject-fix': { needs: 'change', check: 'none', subject: 'reject fix' },
  work: { needs: 'work', check: 'none' },
};

/** The header every commit must have; one that does not match is a bug in this program. */
export const HEADER = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\s]+\))?!?: \S.*$/;

export const TRAILER = 'Generated-By: ai-sdlc';

export type CommitRequest = {
  kind: string;
  system?: string;
  change?: string;
  repo?: string;
  task?: string;
  type?: string;
  subject?: string;
  options: ResolveOptions;
  /** The paths as given: absolute, or relative to `cwd`. */
  paths: string[];
  cwd: string;
};

export type CommitOutcome = {
  committed: boolean;
  repository: string;
  sha: string | null;
  header: string | null;
  paths: string[];
  reason: null | 'nothing changed' | 'check failed' | 'git refused';
  problems: string[];
};

/** Where the commit goes and what decides its header. */
type Target = { repository: string; system: string; scope: string; folder: string | null; change: string | null };

function need(value: string | undefined, option: string, kind: string): string {
  if (value === undefined || value === '') throw new CouldNotRun(`--kind ${kind} needs ${option}`);
  return value;
}

function target(req: CommitRequest, rule: KindRule): Target {
  const resolution = resolveWorkspace(req.cwd, req.options);
  if (resolution.master === null || resolution.workspace === null) throw new CouldNotRun(resolution.problems.join('\n') || 'no master repository');
  const master = resolution.master;
  const workspace = resolution.workspace;
  if (rule.needs === 'system' || rule.needs === 'none') {
    const systems = Object.keys(readMarker(join(master, '.ai-sdlc.json')).systems);
    const system = rule.needs === 'system' ? need(req.system, '--system <system>', req.kind) : systems[0];
    if (system === undefined) throw new CouldNotRun('the marker lists no systems');
    if (!systems.includes(system)) throw new CouldNotRun(`the marker lists no system ${system}`);
    return { repository: real(master), system, scope: systemScope(master, system), folder: null, change: null };
  }
  const change = need(req.change, '--change <change>', req.kind);
  const found = findChange(master, workspace, change, req.system);
  const folder = join(found.master, 'intent', found.system, change);
  const scope = changeScope(found.master, found.system, folder);
  if (rule.needs === 'change') return { repository: real(found.master), system: found.system, scope, folder, change };
  const repo = need(req.repo, '--repo <repo>', req.kind);
  const repos = systemRepos(found.master, workspace, found.system);
  if (!repos.includes(repo)) throw new CouldNotRun(`${repo} is not a repository of system ${found.system} (${repos.join(', ') || 'none'})`);
  const path = join(workspace, repo);
  if (!existsSync(join(path, '.git'))) throw new CouldNotRun(`${repo} is not checked out in ${workspace}`);
  return { repository: real(path), system: found.system, scope, folder, change };
}

/** The real form of a path that may not exist (a deleted file): its nearest existing folder made real. */
function realish(path: string): string {
  if (existsSync(path)) return real(path);
  const parent = dirname(path);
  return parent === path ? path : join(realish(parent), basename(path));
}

/**
 * Each path relative to the repository, with `/`; a path outside it cannot be committed there. A relative path is read
 * from the session's directory, and, when nothing is there but the repository has it, from the repository's own root.
 */
function inRepository(repository: string, paths: string[], cwd: string): string[] {
  const outside = (rel: string) => rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return paths.map((p) => {
    let rel = relative(repository, realish(resolve(cwd, p)));
    if (outside(rel) && !isAbsolute(p) && !existsSync(resolve(cwd, p)) && existsSync(resolve(repository, p))) rel = relative(repository, realish(resolve(repository, p)));
    if (outside(rel)) throw new CouldNotRun(`${p} is not inside ${repository}, where --kind commits`);
    return rel.split(sep).join('/');
  });
}

/** The change's documents a kind checks before committing, those that exist. */
function documentsToCheck(folder: string, check: Checked): string[] {
  if (check === 'none') return [];
  const order: Checked[] = ['spec', 'plan', 'build', 'review'];
  const upTo = order.indexOf(check);
  const files: string[] = [join(folder, 'spec.md')];
  if (upTo >= 1) files.push(join(folder, 'plan.md'));
  const build = join(folder, 'build');
  if (upTo >= 2 && existsSync(build)) files.push(...readdirSync(build).filter((f) => f.endsWith('.md') && f !== 'review.md').sort().map((f) => join(build, f)));
  if (upTo >= 3) files.push(join(build, 'review.md'));
  return files.filter((f) => existsSync(f));
}

/** The files among the paths that `check` takes for setup: the marker and a system's hook configuration. */
function setupFiles(repository: string, paths: string[]): string[] {
  return paths.filter((p) => p === '.ai-sdlc.json' || /^intent\/[^/]+\/hooks\.json$/.test(p)).map((p) => join(repository, p));
}

/** The tasks the build logs among the paths add against HEAD, in document order. */
function addedEntries(t: Target, paths: string[]): string[] {
  const logs = paths.filter((p) => /\/build\/[^/]+\.md$/.test(p) && !p.endsWith('/build/review.md'));
  return logs.flatMap((p) => {
    const file = join(t.repository, p);
    if (!existsSync(file)) return [];
    const before = showFile(t.repository, 'HEAD', p);
    const had = before === null ? new Set<string>() : entriesOf(before, file);
    return [...entriesOf(readFileSync(file, 'utf8'), file)].filter((task) => !had.has(task));
  });
}

/** The message paragraphs: the header first, the trailers last. */
function message(req: CommitRequest, t: Target, paths: string[]): string[] {
  const docs = (subject: string): string[] => [`docs(${t.scope}): ${subject} ${t.change}`, TRAILER];
  const rule = KINDS[req.kind] as KindRule;
  if (rule.subject) return docs(rule.subject);
  switch (req.kind) {
    case 'setup':
      return [`chore(${t.scope}): set up ai-sdlc for ${t.system}`, TRAILER];
    case 'instructions':
      return [`chore(${t.scope}): refresh workspace instructions`, TRAILER];
    case 'context': {
      const prefix = `intent/${t.system}/context/`;
      const repos = paths.filter((p) => p.startsWith(prefix) && p.endsWith('.md') && !p.slice(prefix.length).includes('/')).map((p) => p.slice(prefix.length, -'.md'.length));
      if (repos.length === 0) throw new CouldNotRun(`--kind context commits intent/${t.system}/context/<repo>.md files, and no path given is one`);
      const verb = paths.every((p) => existsAt(t.repository, 'HEAD', p)) ? 'refresh' : 'build';
      if (repos.length <= 3) return [`docs(${t.scope}): ${verb} context for ${repos.join(', ')}`, TRAILER];
      return [`docs(${t.scope}): ${verb} context for ${repos.length} repositories`, repos.join(', '), TRAILER];
    }
    case 'build-log': {
      const tasks = addedEntries(t, paths);
      if (tasks.length === 0) throw new CouldNotRun('--kind build-log commits new build log entries, and the build logs given add none against HEAD');
      return docs(`log ${tasks.join(', ')} of`);
    }
    case 'review': {
      const file = join(t.folder as string, 'build', 'review.md');
      if (!existsSync(file)) throw new CouldNotRun(`${file} does not exist`);
      const result = readReview(readFileSync(file, 'utf8'), file);
      const n = (result.document as ParsedReview).reviews.length;
      if (n === 0) throw new CouldNotRun(`${file} has no ## Review section`);
      return docs(`record review ${n} of`);
    }
    default: {
      // work
      const trailers = req.task === undefined ? TRAILER : `${TRAILER}\nPlan-Task: ${req.task}`;
      return [`${req.type}(${t.scope}): ${req.subject}`, trailers];
    }
  }
}

function checkWorkOptions(req: CommitRequest): void {
  const type = need(req.type, '--type <type>', req.kind);
  need(req.subject, '--subject <text>', req.kind);
  if (!COMMIT_TYPES.includes(type)) throw new CouldNotRun(`--type must be one of ${COMMIT_TYPES.join(', ')}`);
  if (req.task !== undefined && !/^T\d+$/.test(req.task)) throw new CouldNotRun(`--task must be a plan task, T<n>, not ${req.task}`);
}

/** Makes the commit. A request that cannot be made (exit 2) throws CouldNotRun; everything else is the outcome. */
export function commitKind(req: CommitRequest): CommitOutcome {
  const rule = KINDS[req.kind];
  if (rule === undefined) throw new CouldNotRun(`unknown --kind ${req.kind}: one of ${Object.keys(KINDS).join(', ')}`);
  if (req.paths.length === 0) throw new CouldNotRun('name the paths to commit after --');
  if (rule.needs === 'work') checkWorkOptions(req);
  const t = target(req, rule);
  const given = [...new Set(inRepository(t.repository, req.paths, req.cwd))];
  const out = (fields: Partial<CommitOutcome>): CommitOutcome => ({ committed: false, repository: t.repository, sha: null, header: null, paths: [], reason: null, problems: [], ...fields });

  const paths = changedPaths(t.repository, given);
  if (paths.length === 0) return out({ reason: 'nothing changed' });

  const checked = req.kind === 'setup' ? setupFiles(t.repository, paths) : t.folder ? documentsToCheck(t.folder, rule.check) : [];
  if (checked.length > 0) {
    const problems = checkFiles(checked);
    if (problems.length > 0) return out({ paths, reason: 'check failed', problems: problems.map(formatProblem) });
  }

  const paragraphs = message(req, t, paths);
  const header = paragraphs[0] as string;
  if (!HEADER.test(header)) throw new CouldNotRun(`the header "${header}" is not a Conventional Commits header; this is a bug in the ai-sdlc program, or --subject is not a subject`);

  if (currentBranch(t.repository) === null) return out({ header, paths, reason: 'git refused', problems: [`HEAD is detached in ${t.repository}: check out a branch before committing`] });
  const committed = commitPaths(t.repository, paths, paragraphs);
  if (!committed.ok) return out({ header, paths, reason: 'git refused', problems: [committed.error] });
  return out({ committed: true, sha: committed.sha, header, paths });
}
