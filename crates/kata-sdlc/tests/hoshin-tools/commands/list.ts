// list --json [--system <s>] [--master <path>] [--workspace <path>]
// Prints each change of a system, sorted by name: `{ "system", "changes": [{ "change", "title", "track", "master",
// "inCopy", "finished" }], "problems": [] }`. It reads only the intents, so it is cheap; `state` gives the rest.
// changes/list.ts holds the code; GRAMMAR.md ("Listing a system's changes") defines every field. It only reads.
// Exit 0 when printed, 2 when it could not run (no master, an unknown system, several systems without --system).
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { EXIT } from '../common/types.ts';
import { listChanges } from '../changes/list.ts';

export const list: Command = {
  usage: 'list --json [--system <s>] [--master <path>] [--workspace <path>]',
  run(args) {
    const o = parseOptions(args, { values: ['system', 'master', 'workspace'], flags: ['json'] });
    if (!o.flags.has('json') || o.positional.length > 0) throw new UsageError();
    printJson(listChanges(process.cwd(), o.values));
    return EXIT.PASS;
  },
};
