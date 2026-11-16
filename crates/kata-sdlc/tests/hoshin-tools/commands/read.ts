// read --json <file>
// Prints one document as JSON, in the shape schema/read-result.schema.json describes: its kind, layout, parsed
// content and problems. Exit 0 when it has no problems, 1 when it has, 2 when it could not run.
import { printJson, UsageError, type Command } from '../common/command.ts';
import { EXIT } from '../common/types.ts';
import { readDocument } from '../documents/read.ts';

export const read: Command = {
  usage: 'read --json <file>',
  run(args) {
    if (args.length !== 2 || args[0] !== '--json') throw new UsageError();
    const result = readDocument(args[1] as string);
    printJson(result);
    return result.problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
  },
};
