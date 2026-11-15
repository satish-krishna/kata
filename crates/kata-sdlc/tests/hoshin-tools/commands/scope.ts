// scope --json <value>
// Prints why a change's commit scope would be refused: `{ "problems": [...] }`. The scope is kept as typed.
// Exit 0 when it is usable, 1 when it is not.
import { printJson, UsageError, type Command } from '../common/command.ts';
import { EXIT } from '../common/types.ts';
import { checkScope } from '../workspace/naming.ts';

export const scope: Command = {
  usage: 'scope --json <value>',
  run(args) {
    if (args.length !== 2 || args[0] !== '--json') throw new UsageError();
    const problems = checkScope(args[1] as string);
    printJson({ problems });
    return problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
  },
};
