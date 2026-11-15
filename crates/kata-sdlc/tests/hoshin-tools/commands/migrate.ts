// migrate --json [--write] [--master <path>] [--workspace <path>]
// Moves one workspace on this machine from ai-sdlc's names to hoshin's (workspace/migrate.ts). Without --write it
// changes nothing and prints what it would do. It prints one line:
// `{ "workspace", "master", "layout", "write", "steps", "kept", "manual", "problems" }`.
//   steps: `{ "step": "marker"|"copy"|"state"|"instructions", "path", "to", "status", "detail" }`, in the order they are
//   taken. status: done (--write did it), would (a dry run would), current (nothing to do), manual (the engineer does
//   it by hand; the detail says how), refused (the detail says why).
//   kept: the paths left in the old copies folder. manual: what the engineer still does by hand. problems: one
//   sentence per refusal.
// Exit 0 when `problems` is empty, 1 when a step was refused (nothing was changed unless a step failed midway), 2 when
// it cannot run (no marker of either name, not a git repository, git failed).
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { EXIT } from '../common/types.ts';
import { migrate as run } from '../workspace/migrate.ts';

export const migrate: Command = {
  usage: 'migrate --json [--write] [--master <path>] [--workspace <path>]',
  run(args) {
    const o = parseOptions(args, { values: ['master', 'workspace'], flags: ['json', 'write'] });
    if (!o.flags.has('json') || o.positional.length > 0) throw new UsageError();
    const out = run(process.cwd(), { ...(o.values.master ? { master: o.values.master } : {}), ...(o.values.workspace ? { workspace: o.values.workspace } : {}) }, o.flags.has('write'));
    printJson(out);
    return out.problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
  },
};
