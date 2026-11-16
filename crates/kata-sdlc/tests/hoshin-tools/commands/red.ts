// red show --json --change <change> --repo <repo> --task T<n> [--system <s>] [--master <path>] [--workspace <path>]
// Prints `{ task, observed, reason, record, problems }`: whether red was observed for the task, from the newest
// `red record`, and the reason when it was not. It runs no command. Exit 0 whenever it printed, 2 when it could not run.
//
// red record --json --change <change> --repo <repo> --task T<n> [--system <s>] [--master <path>] [--workspace <path>]
// Runs a task's compile command (when the plan names one) and then its test command at HEAD, which must be the clean
// `test` commit that adds the task's failing test, and records what happened in the change's ledger. The commands
// come from the plan as committed in HEAD of the change's master. Prints
// `{ task, commit, outcome, exitCode, output, problems }`: `outcome` is `failed` (red observed), `passed`,
// `could-not-compile` or `could-not-run`, and null when the command refused and ran nothing. Exit 0 when red was
// observed, 1 when the test passed, did not compile or the command refused, 2 when a command could not start or timed
// out. HOSHIN_RED_TIMEOUT sets each command's time limit in seconds (default 600); it exists for tests.
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { EXIT } from '../common/types.ts';
import { eventContext } from '../events/context.ts';
import { recordRed } from '../red/record.ts';
import { redVerdict } from '../red/verdict.ts';

export const red: Command = {
  usage: 'red record|show --json --change c --repo r --task T<n> [--system s] [--master p] [--workspace p]',
  async run(args) {
    const o = parseOptions(args, { values: ['change', 'repo', 'task', 'system', 'master', 'workspace'], flags: ['json'] });
    const task = o.values.task;
    if (o.positional.length !== 1 || (o.positional[0] !== 'record' && o.positional[0] !== 'show') || !o.flags.has('json') || !o.values.change || !o.values.repo || !task || !/^T\d+$/.test(task)) throw new UsageError();
    const ctx = eventContext(process.cwd(), {
      event: 'build.start',
      change: o.values.change,
      repo: o.values.repo,
      ...(o.values.system ? { system: o.values.system } : {}),
      options: { ...(o.values.master ? { master: o.values.master } : {}), ...(o.values.workspace ? { workspace: o.values.workspace } : {}) },
      extra: {},
    });
    if (o.positional[0] === 'show') {
      printJson({ task, ...redVerdict(ctx, task), problems: [] });
      return EXIT.PASS;
    }
    const { record, problems } = await recordRed(ctx, task);
    printJson({ task, commit: record?.commit ?? null, outcome: record?.outcome ?? null, exitCode: record?.exitCode ?? null, output: record?.output ?? '', problems });
    if (record === null || record.outcome === 'passed' || record.outcome === 'could-not-compile') return EXIT.PROBLEMS;
    return record.outcome === 'failed' ? EXIT.PASS : EXIT.COULD_NOT_RUN;
  },
};
