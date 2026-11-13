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
// So is an app in the single-repo layout: the copy holds every app, so the step only checks that it is on the
// change's branch (it switches nothing), refuses while another app of the change is being built in it and has not
// finished at its head (one app at a time), and counts only the app's own uncommitted files.
// Once the event's after hooks have run (so whatever they install is there), the step takes the baseline of the
// repository's checks on its base commit, or reuses the stored one, and fails, asking the engineer, when a check
// already fails there without saying what failed and has no approval for this change.
import { approvalProblem, approvedHooks, ledgerOf, needsApproval } from '../../baseline/approvals.ts';
import { recoverInterrupted, storedBaseline, takeBaseline } from '../../baseline/take.ts';
import { CouldNotRun } from '../../common/types.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { branchOf } from '../../changes/record.ts';
import { changeScope, commitRuleProblems } from '../../changes/scope.ts';
import { latest, ledgerFolder, readLedger } from '../ledger.ts';
import { appFolders, appHead, isSingleRepo } from '../../workspace/apps.ts';
import { baseRevision, checkedOutIn, commitsBeyondBase, currentBranch, git, gitPath, hasLocalBranch, hasRemoteBranch, mainCheckout } from '../../git/git.ts';
import { uncommittedFiles } from '../../workspace/own-files.ts';
import { copiesFolder, headOf, uncommittedOf, type EventContext } from '../context.ts';
import type { Step } from './step.ts';

/** The record the Stop gate reads to know which change a session's repository is building. */
export type ActiveBuild = { system: string; change: string; repo: string; master: string; workspace: string };

/** Where the build in a git repository is recorded: its own git folder, which a worktree (a change's copy) has to itself. */
export const activeBuildFile = (root: string): string => gitPath(root, 'ai-sdlc/active-build.json');

function startingPoint(ctx: EventContext, branch: string): string | null {
  if (hasLocalBranch(ctx.repoPath, branch)) return `refs/heads/${branch}`;
  if (hasRemoteBranch(ctx.repoPath, branch)) return `refs/remotes/origin/${branch}`;
  return null;
}

function activeBuild(root: string): ActiveBuild | null {
  const file = activeBuildFile(root);
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
  const active = activeBuild(ctx.root);
  if (active === null || active.change !== owner || active.system !== ctx.system) return null;
  const finished = ctx.head === null ? null : latest(readLedger(ledgerFolder(ctx.master, active.system, active.change), ctx.repo), 'build.finish', ctx.head);
  return finished?.outcome === 'passed' ? null : `; it is the branch of ${owner}, whose build is active here and has not finished at its head (its build.finish has not passed there)`;
}

/**
 * In the single-repo layout, why this app cannot start: another app of the change is being built in the copy (its
 * `active-build.json` names it) and its latest build.finish has not passed at that app's current head. Null when it can.
 */
function otherAppRefusal(ctx: EventContext): string | null {
  const active = activeBuild(ctx.root);
  if (active === null || active.system !== ctx.system || active.change !== ctx.change || active.repo === ctx.repo) return null;
  const folder = appFolders(ctx.master, ctx.system)[active.repo];
  if (folder === undefined || ctx.base === null) return null;
  let head: string;
  try {
    head = appHead(ctx.root, 'HEAD', folder, ctx.base);
  } catch (e) {
    if (!(e instanceof CouldNotRun)) throw e;
    return '`' + active.repo + '` is being built in this copy, and its head cannot be read; build one app at a time';
  }
  const finished = latest(readLedger(ledgerFolder(ctx.master, ctx.system, ctx.change), active.repo), 'build.finish', head);
  return finished?.outcome === 'passed' ? null : '`' + active.repo + '` is being built in this copy; build one app at a time';
}

export const buildStart: Step = {
  reusePassed: false,
  check(ctx) {
    const branch = branchOf(ctx.folder);
    if (isSingleRepo(ctx.master) && ctx.repo !== 'master') {
      const stuck = recoverInterrupted(ctx.root);
      if (stuck !== null) return [stuck];
      if (currentBranch(ctx.root) !== branch) return [`${ctx.repo} is built in the change's copy, on ${branch}; ${ctx.root} is on ${currentBranch(ctx.root) ?? 'a detached HEAD'}`];
      const other = otherAppRefusal(ctx);
      return other === null ? [] : [other];
    }
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
    if (ctx.repo !== 'master' && !isSingleRepo(ctx.master) && ctx.branch !== branch) {
      const start = startingPoint(ctx, branch);
      const args = start === null ? ['checkout', '--quiet', '-b', branch, baseRevision(ctx.repoPath, ctx.base as string) as string] : start.startsWith('refs/heads/') ? ['checkout', '--quiet', branch] : ['checkout', '--quiet', '-b', branch, '--track', start];
      const r = git(ctx.repoPath, args);
      if (!r.ok) return { problems: [`git could not put ${ctx.repo} on ${branch}: ${r.stderr.trim()}`] };
      created = start === null;
    }
    ctx.branch = currentBranch(ctx.repoPath);
    ctx.head = headOf(ctx);
    const active: ActiveBuild = { system: ctx.system, change: ctx.change, repo: ctx.repo, master: ctx.master, workspace: ctx.workspace };
    const file = activeBuildFile(ctx.root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(active, null, 2) + '\n');
    return { problems: [], details: { branch, created, uncommitted: uncommittedOf(ctx), from } };
  },
  async finish(ctx, config) {
    // A build resumed mid-task may hold uncommitted files; with no stored baseline it cannot be taken now, so
    // build.finish takes it once everything is committed, rather than this run refusing to resume.
    const stored = storedBaseline(ctx, config);
    if (stored.base !== null && stored.entry === null && uncommittedOf(ctx).length > 0) {
      return { problems: [], details: { baseline: { base: stored.base, deferred: `${ctx.repo} has uncommitted files, so build.finish takes the baseline` } } };
    }
    const taken = await takeBaseline(ctx, config);
    if (taken.problems.length > 0) return { problems: taken.problems, outcome: taken.outcome === 'could-not-run' ? 'could-not-run' : 'failed', ...(taken.fault ? { failed: { ...taken.fault, onFailure: 'stop' as const } } : {}) };
    if (taken.entry === null || taken.base === null) return { problems: [] };
    const base = taken.base;
    const approved = approvedHooks(ledgerOf(ctx), base);
    const failing = taken.entry.hooks.filter((h) => h.outcome === 'failed').map(({ id, ids }) => ({ id, ids }));
    const baseline = { base, reused: taken.reused, failing, approved: failing.map((f) => f.id).filter((id) => approved.includes(id)) };
    const waiting = needsApproval(taken.entry, approved);
    if (waiting.length === 0) return { problems: [], details: { baseline } };
    const first = taken.entry.hooks.find((h) => h.id === waiting[0]);
    return { problems: waiting.map((id) => approvalProblem(ctx, base, id)), details: { baseline }, failed: { id: waiting[0] as string, onFailure: 'stop', output: first?.output ?? '' } };
  },
};
