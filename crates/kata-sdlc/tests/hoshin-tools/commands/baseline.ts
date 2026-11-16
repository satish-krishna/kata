// baseline show|retake --json --change <change> --repo <repo> [--system <s>] [--master <path>] [--workspace <path>]
// baseline approve --json --change <change> --repo <repo> --hook <id> [--system <s>] [--master <path>] [--workspace <path>]
// The baseline of a repository's checks (the blocking before hooks of build.finish that apply to it): how each did on
// the base commit, the merge-base of the repository's head and its base branch. `show` runs nothing; `retake` drops
// the stored baseline for that commit and takes it again, which needs a working tree without uncommitted files. Both
// print `{ base, taken, reused, hooks: [{ id, outcome, ids }], needsApproval, approved, problems }`; `taken` is false
// when there is no baseline (none stored yet, no checks, or the master repository, which never has one).
// `needsApproval` lists the checks that failed on the base without saying what failed and are not approved for this
// change; `approve` approves one of them for this change's build of the repository at this base commit and prints
// `{ approved: { hook, base } | null, problems }`. Only the engineer runs approve and retake; the guard refuses them
// to the agent. Exit 0, 1 when it cannot be taken or approved, 2 when a check could not run on the base (nothing is
// stored then).
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { EXIT } from '../common/types.ts';
import { readHookConfig } from '../events/config.ts';
import { eventContext, type EventContext } from '../events/context.ts';
import { approve, approvedHooks, ledgerOf, needsApproval } from '../baseline/approvals.ts';
import { storedBaseline, takeBaseline, type Taken } from '../baseline/take.ts';

function print(ctx: EventContext | null, taken: Taken): number {
  const hooks = (taken.entry?.hooks ?? []).map(({ id, outcome, ids }) => ({ id, outcome, ids }));
  const approved = ctx && taken.base ? approvedHooks(ledgerOf(ctx), taken.base) : [];
  const needed = taken.entry ? needsApproval(taken.entry, approved) : [];
  printJson({ base: taken.base, taken: taken.entry !== null, reused: taken.reused, hooks, needsApproval: needed, approved, problems: taken.problems });
  if (taken.outcome === 'could-not-run') return EXIT.COULD_NOT_RUN;
  return taken.outcome === 'passed' ? EXIT.PASS : EXIT.PROBLEMS;
}

export const baseline: Command = {
  usage: 'baseline show|retake|approve --json --change c --repo r [--hook id] [--system s] [--master p] [--workspace p]',
  async run(args) {
    const o = parseOptions(args, { values: ['change', 'repo', 'hook', 'system', 'master', 'workspace'], flags: ['json'] });
    const [verb] = o.positional;
    if (o.positional.length !== 1 || !['show', 'retake', 'approve'].includes(verb as string) || !o.flags.has('json') || !o.values.change || !o.values.repo) throw new UsageError();
    if ((verb === 'approve') !== (o.values.hook !== undefined)) throw new UsageError();
    const ctx = eventContext(process.cwd(), {
      event: 'build.finish',
      change: o.values.change,
      repo: o.values.repo,
      ...(o.values.system ? { system: o.values.system } : {}),
      options: { ...(o.values.master ? { master: o.values.master } : {}), ...(o.values.workspace ? { workspace: o.values.workspace } : {}) },
      extra: {},
    });
    const config = readHookConfig(ctx.master, ctx.system);
    if (config.problems.length > 0) return print(null, { base: null, entry: null, reused: false, outcome: 'could-not-run', problems: config.problems.map((p) => `the hook configuration on the base branch: ${p}`) });
    if (verb === 'approve') {
      const stored = storedBaseline(ctx, config);
      const problems = stored.problems.length > 0 ? stored.problems : approve(ctx, stored.entry, o.values.hook as string);
      printJson({ approved: problems.length === 0 && stored.base ? { hook: o.values.hook, base: stored.base } : null, problems });
      return problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
    }
    return print(ctx, verb === 'retake' ? await takeBaseline(ctx, config, { retake: true }) : storedBaseline(ctx, config));
  },
};
