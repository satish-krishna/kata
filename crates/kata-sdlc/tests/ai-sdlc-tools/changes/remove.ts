// Removes what a change left on this machine: its copy of the master and its local branches.
//
// Once the change is done (no --abandon), the copy goes, and the change's local branch in each repository where git
// agrees the branch is merged. A branch git does not see as merged (a squash merge, or work not yet merged) is kept
// and named, never forced.
//
// With or without --abandon, a copy with uncommitted files (modified, staged or untracked; ignored files do not count)
// is refused and nothing is removed. The refusal is git's own: the copy is removed with `git worktree remove` and
// never forced, so git checks the copy at the moment it removes it, and a file written after a caller's own check
// still stops it. The branches are deleted only after the copy is gone.
//
// With --abandon, it drops a change nothing was done in: the copy goes, and the change's local branch in the master
// and in every product repository is deleted with -D. It refuses, removing nothing, when change.yml records a pull
// request, when a product repository's change branch has commits beyond its base or is checked out, when the
// master's change branch has commits beyond its base other than the program's own `start change <change>` commit,
// or when the copy has uncommitted files. A change whose intent is rejected in the copy's HEAD (the `reject-intent`
// commit) may have documents on the master's change branch: they are the record of the rejection, so that branch is
// kept and named in `kept`, never deleted; every other rule still holds.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { baseBranch, checkedOutIn, commitsBeyondBase, dirtyPaths, git, hasLocalBranch, mainCheckout, showFile } from '../git/git.ts';
import { readRecord, type ChangeRecord } from './record.ts';
import { statusOf } from './fix-state.ts';

export type RemoveInput = { master: string; workspace: string; system: string; change: string; repos: string[]; copy: string; abandon?: boolean };

export type RemoveOutput = { problems: string[]; removed: string[]; kept: string[] };

const refuse = (problems: string[]): RemoveOutput => ({ problems, removed: [], kept: [] });

/** Whether the intent in the copy's HEAD is rejected: its documents then record a decision, not work. */
function rejected(input: RemoveInput): boolean {
  const path = `intent/${input.system}/${input.change}/intent.md`;
  const text = showFile(input.copy, 'HEAD', path);
  return text !== null && statusOf(text, path) === 'rejected';
}

/** Why a change cannot be abandoned: anything that shows work was done in it. */
function workDone(input: RemoveInput, record: ChangeRecord, isRejected: boolean): string[] {
  const problems: string[] = [];
  for (const pr of record.pullRequests) problems.push(`change.yml records a pull request: ${pr.url}; a change with a pull request is not abandoned, close the pull request and remove the change once it is done`);
  const own = `docs(${record.scope}): start change ${input.change}`;
  const master = commitsBeyondBase(input.copy, record.branch, record.base).filter((c) => !(c.subject === own && c.generatedBy.includes('ai-sdlc')));
  if (master.length > 0 && !isRejected) problems.push(`the master's change branch ${record.branch} has commits beyond ${record.base}: ${master.map((c) => c.subject).join('; ')}`);
  for (const repo of input.repos) {
    const path = join(input.workspace, repo);
    if (!existsSync(path) || !hasLocalBranch(path, record.branch)) continue;
    const base = baseBranch(path);
    if (base === null) {
      problems.push(`${repo} has no base branch (the remote's default, main or master) to compare ${record.branch} with`);
      continue;
    }
    const commits = commitsBeyondBase(path, record.branch, base);
    if (commits.length > 0) problems.push(`${repo}'s change branch ${record.branch} has commits beyond ${base}: ${commits.map((c) => c.subject).join('; ')}`);
    const where = checkedOutIn(path, record.branch);
    if (where !== null) problems.push(`${repo} has ${record.branch} checked out in ${where}; switch it to ${base} first`);
  }
  const dirty = dirtyPaths(input.copy);
  if (dirty.length > 0) problems.push(`the change's copy has uncommitted files: ${dirty.join(', ')}`);
  return problems;
}

export function removeChange(input: RemoveInput): RemoveOutput {
  const record = readRecord(join(input.copy, 'intent', input.system, input.change));
  if (!existsSync(input.copy) || !record) return refuse([`${input.change} has no copy with a change.yml at ${input.copy}`]);
  const main = mainCheckout(input.copy);
  const isRejected = input.abandon === true && rejected(input);
  if (input.abandon) {
    const problems = workDone(input, record, isRejected);
    if (problems.length > 0) return refuse(problems);
  }
  // Never --force: git refuses a copy with modified or untracked files as it removes it.
  const gone = git(main, ['worktree', 'remove', input.copy]);
  if (!gone.ok) {
    const dirty = existsSync(input.copy) ? dirtyPaths(input.copy) : [];
    return refuse([dirty.length > 0 ? `the change's copy has uncommitted files: ${dirty.join(', ')}` : `git could not remove the copy: ${gone.stderr.trim()}`]);
  }
  const removed = ['copy'];
  const kept: string[] = [];
  for (const [repo, path] of [['master', main], ...input.repos.map((r) => [r, join(input.workspace, r)])] as [string, string][]) {
    if (!existsSync(path) || !hasLocalBranch(path, record.branch)) continue;
    if (repo === 'master' && isRejected) {
      kept.push(`master: ${record.branch} (it records the rejected intent)`);
      continue;
    }
    const r = git(path, ['branch', '--quiet', input.abandon ? '-D' : '-d', record.branch]);
    if (r.ok) removed.push(`${repo}: ${record.branch}`);
    else kept.push(`${repo}: ${record.branch} (${r.stderr.trim().split('\n')[0]})`);
  }
  return { problems: [], removed, kept };
}
