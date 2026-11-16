// fix-state --json <change folder>...
// Prints where a light-track fix stands: which of its documents are drafted, accepted or changed since, and which
// row of the fix skill's state table that makes. One folder prints its state, and a folder that cannot be read
// exits with 2; several folders print one entry each and exit 0.
import { printJson, UsageError, type Command } from '../common/command.ts';
import { EXIT } from '../common/types.ts';
import { fixState as stateOf, fixStates } from '../changes/fix-state.ts';

export const fixState: Command = {
  usage: 'fix-state --json <change folder>...',
  run(args) {
    if (args.length < 2 || args[0] !== '--json') throw new UsageError();
    const folders = args.slice(1);
    printJson(folders.length === 1 ? stateOf(folders[0] as string) : fixStates(folders));
    return EXIT.PASS;
  },
};
