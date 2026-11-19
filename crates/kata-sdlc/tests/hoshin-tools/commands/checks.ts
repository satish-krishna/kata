// checks --json --change <change> [--repo r] [--system s] [--master p] [--workspace p]
// Prints the check events of a change, grouped by run, each check's state decided by the program. Runs nothing and writes nothing.
// `{ "system", "change", "runs": [{ "run", "event", "repo", "phase", "checks": [...] }], "problems": [] }`.
// Exit 0, or 1 when `problems` is not empty (the output is still complete).
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { CouldNotRun, EXIT } from '../common/types.ts';
import { checksFile } from '../events/check-log.ts';
import { readChecks } from '../events/check-read.ts';
import { findChangeLedger } from '../events/context.ts';
import { resolveWorkspace } from '../workspace/resolve.ts';

export const checks: Command = {
  usage: 'checks --json --change <change> [--repo r] [--system s] [--master p] [--workspace p]',
  run(args) {
    const o = parseOptions(args, { values: ['change', 'repo', 'system', 'master', 'workspace'], flags: ['json'] });
    if (!o.flags.has('json') || !o.values.change || o.positional.length > 0) throw new UsageError();
    const r = resolveWorkspace(process.cwd(), { ...(o.values.master ? { master: o.values.master } : {}), ...(o.values.workspace ? { workspace: o.values.workspace } : {}) });
    if (r.master === null || r.workspace === null) throw new CouldNotRun(r.problems.join('\n'));
    const found = findChangeLedger(r.master, r.workspace, o.values.change, o.values.system);
    const { runs, problems } = readChecks(checksFile(found.master, found.system, o.values.change), o.values.repo ? { repo: o.values.repo } : {});
    printJson({ system: found.system, change: o.values.change, runs, problems });
    return problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
  },
};
