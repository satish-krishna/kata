// state --json [--system <s>] [--change <c> | --open] [--master <path>] [--workspace <path>]
// Prints where every change of a system stands, in the master and in every change's copy: each document's facts
// (status in HEAD and in the working tree, uncommitted changes, source pins), the scenarios, tasks, build logs and
// review, the fix-state result of a light-track change, and per skill (`ready`) whether it may work on the change,
// whether the change is waiting for it, and which acceptances to record. `{ "system", "changes", "problems" }`.
// `--open` prints only the changes whose `finished` is null, each exactly as without it, and reads only those.
// changes/state.ts holds the rules; GRAMMAR.md ("Where a change stands") defines every field. It only reads.
// Exit 0 when printed, 2 when it could not run (no master, an unknown system, no such change, git failing).
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { EXIT } from '../common/types.ts';
import { changeStates } from '../changes/state.ts';

export const state: Command = {
  usage: 'state --json [--system <s>] [--change <c> | --open] [--master <path>] [--workspace <path>]',
  run(args) {
    const o = parseOptions(args, { values: ['system', 'change', 'master', 'workspace'], flags: ['json', 'open'] });
    if (!o.flags.has('json') || o.positional.length > 0 || (o.flags.has('open') && o.values.change !== undefined)) throw new UsageError();
    printJson(changeStates(process.cwd(), { ...o.values, ...(o.flags.has('open') ? { open: true } : {}) }));
    return EXIT.PASS;
  },
};
