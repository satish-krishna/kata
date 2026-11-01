// stale --json --system <s> [--repo <repo>]... [--master <path>] [--workspace <path>]
// Prints whether each repository's context file is behind its repository, the staleness rule of workspace reference
// section 7: `{ "system", "repos": [{ "repo", "path", "checkedOut", "context", "exists", "sourceCommit", "behind",
// "stale", "reason" }], "problems" }`, the repositories in the marker's order (`--repo`, repeatable, narrows them).
// workspace/stale.ts holds the rules; GRAMMAR.md ("Staleness of context") defines every field. It only reads.
// Exit 0 when printed, whatever is stale; 2 when it could not run (no master, an unknown system or repository).
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { EXIT } from '../common/types.ts';
import { staleContexts } from '../workspace/stale.ts';

export const stale: Command = {
  usage: 'stale --json --system <s> [--repo <repo>]... [--master <path>] [--workspace <path>]',
  run(args) {
    // --repo may repeat; every other option is parsed once.
    const repos: string[] = [];
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--repo') {
        rest.push(args[i] as string);
        continue;
      }
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError();
      repos.push(value);
    }
    const o = parseOptions(rest, { values: ['system', 'master', 'workspace'], flags: ['json'] });
    const system = o.values['system'];
    if (!o.flags.has('json') || o.positional.length > 0 || system === undefined) throw new UsageError();
    printJson(staleContexts(process.cwd(), { ...o.values, system, repos }));
    return EXIT.PASS;
  },
};
