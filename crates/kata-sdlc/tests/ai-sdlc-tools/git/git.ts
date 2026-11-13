// Every git call the program makes for branches, commits, pushes and the hook configuration goes through this file,
// so what the plugin does to a repository can be read in one place. It runs the git program, so the repository's own
// configuration applies: its hooks, signing, filters and credentials. Nothing here passes --no-verify.
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { CouldNotRun } from '../common/types.ts';

/** Paths printed as they are, and no lock taken for a refresh nobody asked for. */
const OPTIONS = ['-c', 'core.quotepath=off', '--no-optional-locks'];

export type GitResult = { ok: boolean; status: number | null; stdout: string; stderr: string };

/** Runs git in `cwd`. A git that cannot start is a program failure; a git that fails is a result. */
export function git(cwd: string, args: string[], input?: string): GitResult {
  const r = spawnSync('git', [...OPTIONS, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) throw new CouldNotRun(`cannot run git: ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}`);
  return { ok: r.status === 0, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** git's trimmed output, or null when it failed. */
export function gitOut(cwd: string, args: string[]): string | null {
  const r = git(cwd, args);
  return r.ok ? r.stdout.trim() : null;
}

/** git's trimmed output; a failure stops the program with git's own message. */
export function gitMust(cwd: string, args: string[], what: string): string {
  const r = git(cwd, args);
  if (!r.ok) throw new CouldNotRun(`${what} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** The repository's top folder, or null outside a repository. */
export const topLevel = (dir: string): string | null => gitOut(dir, ['rev-parse', '--show-toplevel']);

/** The absolute path of a file in the repository's git folder, shared by all its worktrees when `common` is set. */
export function gitPath(dir: string, path: string, common = false): string {
  const out = gitMust(dir, common ? ['rev-parse', '--git-common-dir'] : ['rev-parse', '--git-dir'], 'git rev-parse');
  const base = isAbsolute(out) ? out : resolve(dir, out);
  return resolve(base, path);
}

/** The checked-out branch, or null on a detached HEAD. */
export const currentBranch = (dir: string): string | null => gitOut(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

/** The commit a revision names, or null when it names none. */
export const commitOf = (dir: string, rev: string): string | null => gitOut(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);

export const hasLocalBranch = (dir: string, name: string): boolean => commitOf(dir, `refs/heads/${name}`) !== null;
export const hasRemoteBranch = (dir: string, name: string): boolean => commitOf(dir, `refs/remotes/origin/${name}`) !== null;

/** The base branch: the remote's default, else main, else master, as the build and Kata always found it. */
export function baseBranch(dir: string): string | null {
  const remoteHead = gitOut(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead) return remoteHead.replace(/^origin\//, '');
  for (const name of ['main', 'master']) if (hasLocalBranch(dir, name) || hasRemoteBranch(dir, name)) return name;
  return null;
}

/** The revision to read the base branch from: the local branch, else the remote's copy. */
export function baseRevision(dir: string, base: string): string | null {
  if (hasLocalBranch(dir, base)) return `refs/heads/${base}`;
  if (hasRemoteBranch(dir, base)) return `refs/remotes/origin/${base}`;
  return null;
}

/** A file as committed at `rev`, or null when it is not there. */
export function showFile(dir: string, rev: string, path: string): string | null {
  const r = git(dir, ['show', `${rev}:${path}`]);
  return r.ok ? r.stdout : null;
}

/** The files under `path` at `rev`, with their modes (100755 for an executable). */
export function listFiles(dir: string, rev: string, path: string): { path: string; mode: string }[] {
  const out = gitOut(dir, ['ls-tree', '-r', '--full-tree', rev, '--', path]);
  if (!out) return [];
  return out.split('\n').flatMap((line) => {
    const m = line.match(/^(\d+) blob [0-9a-f]+\t(.+)$/);
    return m ? [{ mode: m[1] as string, path: m[2] as string }] : [];
  });
}

/** Uncommitted or untracked paths, leaving out the given pathspecs. */
export function dirtyPaths(dir: string, exclude: string[] = []): string[] {
  // Not trimmed: each line starts with its two status columns, the first of which may be a space.
  const r = git(dir, ['status', '--porcelain', '--', '.', ...exclude.map((p) => `:(exclude)${p}`)]);
  if (!r.ok) throw new CouldNotRun(`git status failed in ${dir}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.split('\n').filter((line) => line.length > 3).map((line) => line.slice(3));
}

/** Every branch name on this machine, local and last fetched from the remote, without `origin/`. */
export function branchNames(dir: string): string[] {
  const out = gitOut(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']) ?? '';
  const names = out.split('\n').filter(Boolean).map((ref) => ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, ''));
  return [...new Set(names.filter((n) => n !== 'HEAD'))];
}

export type Commit = { sha: string; subject: string; generatedBy: string[] };

/** Commits on `branch` that are on neither the local nor the remote base branch, newest first. */
export function commitsBeyondBase(dir: string, branch: string, base: string): Commit[] {
  const not = [`refs/heads/${base}`, `refs/remotes/origin/${base}`].filter((ref) => commitOf(dir, ref) !== null);
  const out = gitMust(dir, ['log', '--format=%H%x1f%s%x1f%(trailers:key=Generated-By,valueonly,separator=%x1d)%x1e', branch, ...(not.length ? ['--not', ...not] : [])], 'git log');
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((record) => {
    const [sha = '', subject = '', trailers = ''] = record.split('\x1f');
    return { sha, subject, generatedBy: trailers.split('\x1d').map((t) => t.trim()).filter(Boolean) };
  });
}

/** Whether `ancestor` is reachable from `descendant`. */
export const isAncestor = (dir: string, ancestor: string, descendant: string): boolean => git(dir, ['merge-base', '--is-ancestor', ancestor, descendant]).ok;

/** The main checkout of a repository, whichever of its worktrees `dir` is. */
export function mainCheckout(dir: string): string {
  const out = gitMust(dir, ['worktree', 'list', '--porcelain'], 'git worktree list');
  const first = out.split('\n').find((l) => l.startsWith('worktree '));
  if (!first) throw new CouldNotRun(`git worktree list printed no worktree in ${dir}`);
  return first.slice('worktree '.length);
}

/** Whether a branch is checked out in any worktree of the repository. */
export function checkedOutIn(dir: string, branch: string): string | null {
  const out = gitOut(dir, ['worktree', 'list', '--porcelain']) ?? '';
  let path: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/** The paths among `paths` (relative to the repository root) that `git status` lists as changed, untracked or deleted. */
export function changedPaths(dir: string, paths: string[]): string[] {
  const out = git(dir, ['--literal-pathspecs', 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths]);
  if (!out.ok) throw new CouldNotRun(`git status failed in ${dir}: ${(out.stderr || out.stdout).trim()}`);
  const listed: string[] = [];
  const fields = out.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] as string;
    if (entry.length < 4) continue;
    listed.push(entry.slice(3));
    // A rename or copy is followed by the path it came from.
    if (entry[0] === 'R' || entry[0] === 'C') listed.push(fields[++i] as string);
  }
  return paths.filter((p) => listed.some((l) => l === p || l.startsWith(p.endsWith('/') ? p : `${p}/`)));
}

/** Whether `path` is in the tree of `rev`. */
export const existsAt = (dir: string, rev: string, path: string): boolean => git(dir, ['--literal-pathspecs', 'cat-file', '-e', `${rev}:${path}`]).ok;

/** Whether git failed because another process holds the repository's index.lock. */
const lockHeld = (r: GitResult): boolean => !r.ok && /index\.lock'?:? File exists|Unable to create '[^']*index\.lock'/.test(r.stderr + r.stdout);

/** How long to wait between tries while index.lock is held, and how many retries: about ten seconds in all. */
const LOCK_WAIT_MS = 2000;
const LOCK_RETRIES = 5;

/** Runs git, trying again while another process holds index.lock. */
function gitWaitingForLock(dir: string, args: string[]): GitResult {
  let r = git(dir, args);
  for (let i = 0; i < LOCK_RETRIES && lockHeld(r); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    r = git(dir, args);
  }
  return r;
}

export type CommitResult = { ok: true; sha: string } | { ok: false; error: string; output: string };

/**
 * Stages exactly `paths` and commits only them, each message argument one paragraph, so anything else staged stays as
 * it was. The repository's hooks run (never --no-verify); a held index.lock is waited for, about ten seconds.
 */
export function commitPaths(dir: string, paths: string[], paragraphs: string[]): CommitResult {
  const fail = (r: GitResult): CommitResult => ({ ok: false, error: (r.stderr || r.stdout).trim(), output: r.stdout + r.stderr });
  const added = gitWaitingForLock(dir, ['--literal-pathspecs', 'add', '-A', '--', ...paths]);
  if (!added.ok) return fail(added);
  const committed = gitWaitingForLock(dir, ['--literal-pathspecs', 'commit', '--quiet', ...paragraphs.flatMap((p) => ['-m', p]), '--', ...paths]);
  if (!committed.ok) return fail(committed);
  return { ok: true, sha: gitMust(dir, ['rev-parse', 'HEAD'], 'git rev-parse') };
}

/** The best common ancestor of two revisions, or null when they have none. */
export const mergeBase = (dir: string, a: string, b: string): string | null => gitOut(dir, ['merge-base', a, b]);

/** How many commits `rev-list --count <from>..<to>` finds that touch `paths` (pathspecs), or null when git cannot count them. */
export function countCommits(dir: string, from: string, to: string, paths: string[]): number | null {
  const out = gitOut(dir, ['rev-list', '--count', `${from}..${to}`, '--', ...paths]);
  return out === null || !/^\d+$/.test(out) ? null : Number(out);
}

/** The commits after `from` up to `to`, oldest first, each with the values of its `key` trailer; with `paths`, only those touching them. */
export function commitsWithTrailer(dir: string, from: string, to: string, key: string, paths: string[] = []): { sha: string; values: string[] }[] {
  const out = gitMust(dir, ['log', '--reverse', `--format=%H%x1f%(trailers:key=${key},valueonly,separator=%x1d)%x1e`, `${from}..${to}`, ...(paths.length > 0 ? ['--', ...paths] : [])], 'git log');
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((record) => {
    const [sha = '', trailers = ''] = record.split('\x1f');
    return { sha, values: trailers.split('\x1d').map((t) => t.trim()).filter(Boolean) };
  });
}

/** The newest commit in `range` (`a..b`) that touches `pathspec`, or null when none does; a git failure stops the program. */
export function lastCommitTouching(dir: string, range: string, pathspec: string[]): string | null {
  const out = git(dir, ['log', '-1', '--format=%H', range, '--', ...pathspec]);
  if (!out.ok) throw new CouldNotRun(`git log failed in ${dir}: ${(out.stderr || out.stdout).trim()}`);
  const sha = out.stdout.trim();
  return sha === '' ? null : sha;
}

/** The tracked files anywhere in the repository that have uncommitted changes (untracked files are left out). */
export function trackedChanges(dir: string): string[] {
  // Not trimmed: each line starts with its two status columns, the first of which may be a space.
  const r = git(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (!r.ok) throw new CouldNotRun(`git status failed in ${dir}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.split('\n').filter((line) => line.length > 3).map((line) => line.slice(3));
}

/** The files that differ between two revisions among `pathspec`, in git's order. */
export function changedFilesBetween(dir: string, from: string, to: string, pathspec: string[]): string[] {
  const out = git(dir, ['diff', '--name-only', '-z', from, to, '--', ...pathspec]);
  if (!out.ok) throw new CouldNotRun(`git diff failed in ${dir}: ${(out.stderr || out.stdout).trim()}`);
  return out.stdout.split('\0').filter(Boolean);
}
