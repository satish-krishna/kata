// Renames a change's branch everywhere it exists: the master (and so the change's copy, which follows it) and every
// product repository that has it. Every check runs before anything moves, and a failure undoes what moved. The
// change's record is then updated and committed in the copy.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, dirtyPaths, hasLocalBranch, checkedOutIn } from '../git/git.ts';
import { branchClashes, type Repository } from '../workspace/branches.ts';
import { checkBranchName } from '../workspace/naming.ts';
import { readRecord, writeRecord } from './record.ts';

export type RenameInput = { master: string; workspace: string; system: string; change: string; repos: string[]; to: string; scope: string };

export function renameBranch(input: RenameInput): { problems: string[]; renamed: string[]; from: string | null } {
  const folder = join(input.master, 'intent', input.system, input.change);
  const record = readRecord(folder);
  if (!record) return { problems: [`${input.change} has no change.yml in ${input.master}; only a change started with change start can be renamed`], renamed: [], from: null };
  const from = record.branch;
  const problems: string[] = [];
  if (input.to === from) problems.push(`the change's branch is already ${from}`);
  problems.push(...checkBranchName(input.to).map((p) => `${input.to}: ${p}`));
  const products: Repository[] = input.repos.map((r) => ({ repo: r, path: join(input.workspace, r) })).filter((r) => existsSync(r.path));
  const holders = products.filter((r) => hasLocalBranch(r.path, from));
  problems.push(...branchClashes(input.to, [{ repo: 'master', path: input.master }, ...products], from));
  if (dirtyPaths(input.master).length > 0) problems.push(`the change's copy ${input.master} has uncommitted files`);
  for (const r of holders) {
    const where = checkedOutIn(r.path, from);
    if (where !== null && dirtyPaths(where).length > 0) problems.push(`${r.repo} has ${from} checked out with uncommitted files`);
  }
  if (problems.length > 0) return { problems, renamed: [], from };
  const done: Repository[] = [];
  for (const r of [{ repo: 'master', path: input.master }, ...holders]) {
    const moved = git(r.path, ['branch', '-m', from, input.to]);
    if (!moved.ok) {
      for (const back of done.reverse()) git(back.path, ['branch', '-m', input.to, from]);
      return { problems: [`git could not rename ${from} in ${r.repo}: ${moved.stderr.trim()}; nothing was renamed`], renamed: [], from };
    }
    done.push(r);
  }
  const file = writeRecord(folder, { ...record, branch: input.to });
  const header = `docs(${input.scope}): rename branch ${input.change}`;
  const committed = git(input.master, ['commit', '--quiet', '-m', header, '-m', 'Generated-By: ai-sdlc', '--', file]);
  if (!committed.ok) problems.push(`the branch is renamed, but the commit "${header}" failed: ${(committed.stderr || committed.stdout).trim()}`);
  return { problems, renamed: done.map((r) => r.repo), from };
}
