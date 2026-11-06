// build.finish: once every task for a repository has a build log entry, the repository's checks run. A team's
// checks are the blocking before hooks of build.finish that name the repository; this step only adds what the
// plugin owns, before any of them: every task logged, and every commit on the branch beyond the base carrying the
// change's scope and the ai-sdlc trailer. A repository with no checks passes.
//
// Each check is judged against the baseline: how it did on the base commit (taken now when none is stored). A
// failure that was already there does not block: one that says what failed (its IDs) passes when it has no ID the
// base did not have, and one that does not say passes only with the engineer's approval for this build. A check
// that passed on the base, or is new, blocks on any failure, as without a baseline. `details.baseline` lists the
// checks the change fixed, the ones still failing with the same IDs, and the approved ones.
import { approvalProblem, approvedHooks, ledgerOf } from '../../baseline/approvals.ts';
import { recoverInterrupted, takeBaseline } from '../../baseline/take.ts';
import { branchOf } from '../../changes/record.ts';
import { unloggedTasks } from '../../changes/progress.ts';
import { changeScope, commitRuleProblems } from '../../changes/scope.ts';
import { commitOf, commitsBeyondBase, currentBranch } from '../../git/git.ts';
import type { Judge, Step } from './step.ts';

export const buildFinish: Step = {
  reusePassed: true,
  check(ctx) {
    // A baseline run killed on the base commit left the repository there: put it back before anything else.
    const stuck = recoverInterrupted(ctx.repoPath);
    if (stuck !== null) return [stuck];
    ctx.branch = currentBranch(ctx.repoPath);
    ctx.head = commitOf(ctx.repoPath, 'HEAD');
    const missing = unloggedTasks(ctx.folder, ctx.repo);
    if (missing === null) return [`${ctx.change} has no plan that reads cleanly`];
    if (missing.length > 0) return [`${ctx.repo} still has tasks without a build log entry: ${missing.join(', ')}`];
    const branch = branchOf(ctx.folder);
    if (ctx.branch !== branch) return [`${ctx.repo} is on ${ctx.branch ?? 'a detached HEAD'}, not on the change's branch ${branch}`];
    if (ctx.base === null) return [`${ctx.repo} has no base branch on this machine`];
    const broken = commitRuleProblems(commitsBeyondBase(ctx.repoPath, 'HEAD', ctx.base), changeScope(ctx.master, ctx.system, ctx.folder));
    return broken.length > 0 ? [`commits on ${branch} break the commit rules (references/workspace.md, section 8): ${broken.join('; ')}`] : [];
  },
  async prepare(ctx, config) {
    const taken = await takeBaseline(ctx, config);
    if (taken.problems.length > 0) return { problems: taken.problems, outcome: taken.outcome === 'could-not-run' ? 'could-not-run' : 'failed', ...(taken.fault ? { failed: { ...taken.fault, onFailure: 'stop' as const } } : {}) };
    if (taken.entry === null || taken.base === null) return { problems: [] };
    const base = taken.base;
    const onBase = new Map(taken.entry.hooks.map((h) => [h.id, h]));
    const approved = approvedHooks(ledgerOf(ctx), base);
    const summary = { base, reused: taken.reused, fixed: [] as string[], stillFailing: [] as { id: string; ids: string[] }[], approved: [] as string[] };
    const judge: Judge = (hook, record) => {
      const before = onBase.get(hook.id);
      const wasRed = before?.outcome === 'failed';
      if (record.outcome === 'passed') {
        if (wasRed) summary.fixed.push(hook.id);
        return { allow: true };
      }
      if (!before || !wasRed) return { allow: false };
      if (before.ids === null) {
        if (!approved.includes(hook.id)) return { allow: false, problem: approvalProblem(ctx, base, hook.id), onFailure: 'stop' };
        summary.approved.push(hook.id);
        return { allow: true };
      }
      const now = record.ids ?? null;
      if (now === null) return { allow: false, problem: `check ${hook.id} failed on the base saying what failed (${before.ids.join(', ')}), and now fails without saying, so it could not be compared with the base` };
      const added = now.filter((id) => !(before.ids as string[]).includes(id));
      if (added.length > 0) return { allow: false, problem: `check ${hook.id} has new failures since the base (${base.slice(0, 7)}): ${added.join(', ')}` };
      summary.stillFailing.push({ id: hook.id, ids: now });
      return { allow: true };
    };
    return { problems: [], details: { baseline: summary }, judge };
  },
};
