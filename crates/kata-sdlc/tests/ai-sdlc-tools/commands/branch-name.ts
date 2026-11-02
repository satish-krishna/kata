// branch-name --json <name>
// Prints why git, or the tool driving the build, would refuse a branch name: `{ "problems": [...] }`.
// Exit 0 when the name is usable, 1 when it is not.
import { printJson, UsageError, type Command } from '../common/command.ts';
import { EXIT } from '../common/types.ts';
import { checkBranchName } from '../workspace/naming.ts';

export const branchName: Command = {
  usage: 'branch-name --json <name>',
  run(args) {
    if (args.length !== 2 || args[0] !== '--json') throw new UsageError();
    const problems = checkBranchName(args[1] as string);
    printJson({ problems });
    return problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
  },
};
