// build.finish: once every task for a repository has a build log entry, the repository's checks run. A team's
// checks are the blocking before hooks of build.finish that name the repository; this step only adds what the
// plugin owns, before any of them: every task logged, and every commit on the branch beyond the base carrying the
// change's scope and the ai-sdlc trailer. A repository with no checks passes.
import { branchOf } from '../../changes/record.ts';
import { unloggedTasks } from '../../changes/progress.ts';
import { changeScope, commitRuleProblems } from '../../changes/scope.ts';
import { commitsBeyondBase } from '../../git/git.ts';
import type { Step } from './step.ts';

export const buildFinish: Step = {
  reusePassed: true,
  check(ctx) {
    const missing = unloggedTasks(ctx.folder, ctx.repo);
    if (missing === null) return [`${ctx.change} has no plan that reads cleanly`];
    if (missing.length > 0) return [`${ctx.repo} still has tasks without a build log entry: ${missing.join(', ')}`];
    const branch = branchOf(ctx.folder);
    if (ctx.branch !== branch) return [`${ctx.repo} is on ${ctx.branch ?? 'a detached HEAD'}, not on the change's branch ${branch}`];
    if (ctx.base === null) return [`${ctx.repo} has no base branch on this machine`];
    const broken = commitRuleProblems(commitsBeyondBase(ctx.repoPath, 'HEAD', ctx.base), changeScope(ctx.master, ctx.system, ctx.folder));
    return broken.length > 0 ? [`commits on ${branch} break the commit rules (references/workspace.md, section 8): ${broken.join('; ')}`] : [];
  },
};
