// resolve --json [--master <path>] [--workspace <path>]
// Prints the workspace and the master repository this session works in, and whether the master is a change's own
// copy: `{ "workspace", "master", "masterIsCopy", "problems" }`. Every skill starts with it; the rules are in
// workspace/resolve.ts and plugin/references/workspace.md. Exit 0 when resolved, 1 when refused.
import { printJson, UsageError, type Command } from '../common/command.ts';
import { EXIT } from '../common/types.ts';
import { resolveWorkspace, type ResolveOptions } from '../workspace/resolve.ts';

/** Each of --master and --workspace at most once, each with a value. */
function options(args: string[]): ResolveOptions {
  const out: ResolveOptions = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if ((key !== '--master' && key !== '--workspace') || value === undefined) throw new UsageError();
    const name = key === '--master' ? 'master' : 'workspace';
    if (out[name] !== undefined) throw new UsageError();
    out[name] = value;
  }
  return out;
}

export const resolve: Command = {
  usage: 'resolve --json [--master <path>] [--workspace <path>]',
  run(args) {
    if (args[0] !== '--json') throw new UsageError();
    const out = resolveWorkspace(process.cwd(), options(args.slice(1)));
    printJson(out);
    return out.problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
  },
};
