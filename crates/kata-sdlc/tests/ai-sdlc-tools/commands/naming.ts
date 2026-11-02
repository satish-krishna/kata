// naming --json <marker> <system> [--type <t> --scope <s> --change <c> [--title <t>]]
// Prints a system's team naming setting from the marker, its problems, and, given the values, the branch name and
// pull request title it gives. Exit 0 when the setting has no problems, 1 when it has.
import { printJson, UsageError, type Command } from '../common/command.ts';
import { EXIT } from '../common/types.ts';
import { checkNaming, readNaming, renderNaming } from '../workspace/naming.ts';

type Report = { declared: boolean; setting: unknown; problems: string[]; names?: unknown };

function report(markerPath: string, system: string, options: string[]): Report {
  const values: Record<string, string> = {};
  for (let i = 0; i < options.length; i += 2) {
    const key = (options[i] ?? '').replace(/^--/, '');
    const value = options[i + 1];
    if (!['type', 'scope', 'change', 'title'].includes(key) || value === undefined) throw new UsageError();
    values[key] = value;
  }
  const read = readNaming(markerPath, system);
  if (!read.declared) return { declared: false, setting: null, problems: [] };
  const problems = checkNaming(read.setting);
  const out: Report = { declared: true, setting: read.setting, problems };
  const { type, scope, change, title } = values;
  if (problems.length === 0 && type !== undefined && scope !== undefined && change !== undefined) {
    out.names = renderNaming(read.setting, title === undefined ? { type, scope, change } : { type, scope, change, title });
  }
  return out;
}

export const naming: Command = {
  usage: 'naming --json <marker> <system> [--type t --scope s --change c --title t]',
  run(args) {
    if (args.length < 3 || args[0] !== '--json') throw new UsageError();
    const out = report(args[1] as string, args[2] as string, args.slice(3));
    printJson(out);
    return out.problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
  },
};
