// Every GitHub call the program makes goes through this file: the sign-in check, finding a change's open pull request,
// opening one, and reading a pull request's state. It runs the GitHub command-line tool, `gh`, under the engineer's
// own sign-in, so the plugin holds no token of its own. Only change.done and `change show --refresh` use it.
import { spawnSync } from 'node:child_process';
import { CouldNotRun } from '../common/types.ts';

export type GhResult = { ok: boolean; stdout: string; stderr: string };

export function gh(cwd: string, args: string[]): GhResult {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    throw new CouldNotRun(code === 'ENOENT' ? 'declaring a change done needs the GitHub command-line tool, gh, which is not installed or not on PATH' : `cannot run gh: ${code ?? r.error.message}`);
  }
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

/** The GitHub host of a remote address, or null for an address that names no host (a local path). */
export function hostOf(remote: string): string | null {
  const scp = remote.match(/^[\w.-]+@([\w.-]+):/);
  if (scp) return scp[1] as string;
  try {
    const url = new URL(remote);
    return url.protocol === 'file:' ? null : url.hostname || null;
  } catch {
    return null;
  }
}

/** Why the engineer is not signed in to a host, or null when they are. */
export function signInProblem(cwd: string, host: string | null): string | null {
  const r = gh(cwd, ['auth', 'status', ...(host ? ['--hostname', host] : [])]);
  return r.ok ? null : `you are not signed in to GitHub${host ? ` on ${host}` : ''} with gh: run gh auth login${host ? ` --hostname ${host}` : ''}`;
}

export type PullRequestRef = { url: string; number: number };

const numberOf = (url: string): number => Number(url.match(/\/pull\/(\d+)/)?.[1] ?? NaN);

/** The open pull request whose head is the branch, if there is one. */
export function openPullRequest(cwd: string, branch: string): PullRequestRef | null {
  const r = gh(cwd, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1']);
  if (!r.ok) throw new CouldNotRun(`gh could not list pull requests in ${cwd}: ${r.stderr.trim()}`);
  const list = JSON.parse(r.stdout || '[]') as { number: number; url: string }[];
  return list[0] ? { url: list[0].url, number: list[0].number } : null;
}

/** Opens a pull request; its address, or why it could not be opened. */
export function openNew(cwd: string, pr: { base: string; head: string; title: string; body: string }): PullRequestRef | string {
  const r = gh(cwd, ['pr', 'create', '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body', pr.body]);
  if (!r.ok) return (r.stderr || r.stdout).trim();
  const url = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  return /^https?:\/\//.test(url) && !Number.isNaN(numberOf(url)) ? { url, number: numberOf(url) } : `gh printed no pull request address: ${r.stdout.trim()}`;
}

/** A pull request's state as GitHub has it now: OPEN, MERGED or CLOSED; null when it cannot be read. */
export function stateOf(cwd: string, url: string): string | null {
  const r = gh(cwd, ['pr', 'view', url, '--json', 'state']);
  if (!r.ok) return null;
  try {
    return (JSON.parse(r.stdout) as { state?: string }).state ?? null;
  } catch {
    return null;
  }
}
