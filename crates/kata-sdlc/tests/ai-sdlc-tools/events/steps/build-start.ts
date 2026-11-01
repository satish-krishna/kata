// build.start: before a repository's first task, the repository is put on the change's branch. It must have a base
// branch, and be on its base branch, already on the change's branch, or on another change's branch with no active
// build. On any branch but the change's it must have no uncommitted files, since switching would carry them onto the
// change's branch. Another change's branch is one a change of the system names (its change.yml, branch.md, or
// change/<change>), in the master's checkout or any change copy; its build is active in the repository when the
// repository's `active-build.json` names it and its build.finish has not passed at the repository's head. Without
// one, the repository is handed to this change without a manual switch; the commits stay on their branch. A branch
// no change names is never switched off. Already on the change's branch,
// uncommitted files are a build in progress (a session that stopped mid-task): it passes and names them in
// `details.uncommitted`, a list that is empty when the repository is clean, so the build can decide what to do with
// them. In the master repository listed as one of the system's product repositories, ai-sdlc's own files
// (`intent/` and `.ai-sdlc.json`, which another run may be writing) do not count as uncommitted. A change branch
// that already exists is reused only when every commit on it beyond the base carries the change's scope and the
// ai-sdlc trailer, so unrelated work under the same name is never built on. Otherwise the branch is created off
// the base (or from the remote's copy, when the change was pushed from another machine). The master repository,
// when it is one of the system's repositories, is built in the change's copy, which is already on the branch.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { branchOf } from '../../changes/record.ts';
import { changeScope, commitRuleProblems } from '../../changes/scope.ts';
import { latest, ledgerFolder, readLedger } from '../ledger.ts';
import { baseRevision, checkedOutIn, commitOf, commitsBeyondBase, currentBranch, git, gitPath, hasLocalBranch, hasRemoteBranch, mainCheckout } from '../../git/git.ts';
import { uncommittedFiles } from '../../workspace/own-files.ts';
import { copiesFolder, type EventContext } from '../context.ts';
import type { Step } from './step.ts';

/** The record the Stop gate reads to know which change a session's repository is building. */
export type ActiveBuild = { system: string; change: string; repo: string; master: string; workspace: string };

export const activeBuildFile = (repoPath: string): string => gitPath(repoPath, 'ai-sdlc/active-build.json');

function startingPoint(ctx: EventContext, branch: string): string | null {
  if (hasLocalBranch(ctx.repoPath, branch)) return `refs/heads/${branch}`;
  if (hasRemoteBranch(ctx.repoPath, branch)) return `refs/remotes/origin/${branch}`;
  return null;
}

function activeBuild(repoPath: string): ActiveBuild | null {
  const file = activeBuildFile(repoPath);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ActiveBuild;
  } catch {
    return null;
  }
}

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

/** The change of the system whose branch this is, from the master's checkout and every change copy; null for none. */
function changeOnBranch(ctx: EventContext, branch: string): string | null {
  const holders = [mainCheckout(ctx.master), ...(isDir(copiesFolder(ctx.workspace)) ? readdirSync(copiesFolder(ctx.workspace)).map((c) => join(copiesFolder(ctx.workspace), c)) : [])];
  for (const holder of holders) {
    const system = join(holder, 'intent', ctx.system);
    if (!isDir(system)) continue;
    for (const name of readdirSync(system)) {
      const folder = join(system, name);
      if (name === ctx.change || !existsSync(join(folder, 'intent.md'))) continue;
      if (branchOf(folder) === branch) return name;
    }
  }
  return null;
}

/**
 * Why the repository cannot be handed over from the other change's branch it is on, or null when it can: the branch
 * belongs to another change of the system, and that change has no active build here (the repository's
 * `active-build.json` does not name it, or its build.finish passed at the repository's head).
 */
function handOffRefusal(ctx: EventContext): string | null {
  if (ctx.branch === null) return '';
  const owner = changeOnBranch(ctx, ctx.branch);
  if (owner === null) return '';
  const active = activeBuild(ctx.repoPath);
  if (active === null || active.change !== owner || active.system !== ctx.system) return null;
  const finished = ctx.head === null ? null : latest(readLedger(ledgerFolder(ctx.master, active.system, active.change), ctx.repo), 'build.finish', ctx.head);
  return finished?.outcome === 'passed' ? null : `; it is the branch of ${owner}, whose build is active here and has not finished at its head (its build.finish has not passed there)`;
}

export const buildStart: Step = {
  reusePassed: false,
  check(ctx) {
    const branch = branchOf(ctx.folder);
    if (ctx.repo === 'master') {
      return currentBranch(ctx.master) === branch ? [] : [`the master repository is built in the change's copy, on ${branch}; ${ctx.master} is on ${currentBranch(ctx.master) ?? 'a detached HEAD'}`];
    }
    if (ctx.base === null || baseRevision(ctx.repoPath, ctx.base) === null) return [`${ctx.repo} has no base branch (the remote's default, main or master) on this machine`];
    const dirty = ctx.branch === branch ? [] : uncommittedFiles(ctx.repoPath);
    if (dirty.length > 0) return [`${ctx.repo} has uncommitted files: ${dirty.join(', ')}. Commit or put them away first; nothing was switched.`];
    const elsewhere = checkedOutIn(ctx.repoPath, branch);
    if (elsewhere !== null && elsewhere !== ctx.repoPath && ctx.branch !== branch) return [`${branch} is checked out in another worktree of ${ctx.repo}, ${elsewhere}`];
    if (ctx.branch !== ctx.base && ctx.branch !== branch) {
      const why = handOffRefusal(ctx);
      if (why !== null) return [`${ctx.repo} is on ${ctx.branch ?? 'a detached HEAD'}, not on its base branch ${ctx.base} or the change's branch ${branch}${why}`];
    }
    const from = startingPoint(ctx, branch);
    if (from !== null) {
      const strangers = commitRuleProblems(commitsBeyondBase(ctx.repoPath, from, ctx.base), changeScope(ctx.master, ctx.system, ctx.folder));
      if (strangers.length > 0) return [`${ctx.repo} already has a branch ${branch} with work that is not this change's, so the build touches nothing. Pick a new branch name for the change (change rename). The commits: ${strangers.join('; ')}`];
    }
    return [];
  },
  act(ctx) {
    const branch = branchOf(ctx.folder);
    const from = ctx.branch;
    let created = false;
    if (ctx.repo !== 'master' && ctx.branch !== branch) {
      const start = startingPoint(ctx, branch);
      const args = start === null ? ['checkout', '--quiet', '-b', branch, baseRevision(ctx.repoPath, ctx.base as string) as string] : start.startsWith('refs/heads/') ? ['checkout', '--quiet', branch] : ['checkout', '--quiet', '-b', branch, '--track', start];
      const r = git(ctx.repoPath, args);
      if (!r.ok) return { problems: [`git could not put ${ctx.repo} on ${branch}: ${r.stderr.trim()}`] };
      created = start === null;
    }
    ctx.branch = currentBranch(ctx.repoPath);
    ctx.head = commitOf(ctx.repoPath, 'HEAD');
    const active: ActiveBuild = { system: ctx.system, change: ctx.change, repo: ctx.repo, master: ctx.master, workspace: ctx.workspace };
    const file = activeBuildFile(ctx.repoPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(active, null, 2) + '\n');
    return { problems: [], details: { branch, created, uncommitted: uncommittedFiles(ctx.repoPath), from } };
  },
};
