// commit --json --kind <kind> [--system <s>] [--change <c>] [--repo <repo> [--task T<n>] --type <type> --subject "<text>"] [--master <path>] [--workspace <path>] -- <path>...
// Makes the commit a skill asks for: in the master (the change's copy when it has one), or for `--kind work` in
// `<workspace>/<repo>`; only the paths given that git status lists; the change's documents checked first; the header
// and trailers from the commit table in changes/commit.ts. Prints one JSON line, `{ "committed", "repository", "sha",
// "header", "paths", "reason", "problems" }`. Exit 0 committed or nothing changed, 1 when the check failed or git
// refused (a hook, no identity, a detached HEAD, index.lock held too long), 2 when it could not run.
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { EXIT } from '../common/types.ts';
import { commitKind } from '../changes/commit.ts';

const USAGE = 'commit --json --kind <kind> [--system <s>] [--change <c>] [--repo <repo> [--task T<n>] --type <type> --subject "<text>"] [--master <path>] [--workspace <path>] -- <path>...';

export const commit: Command = {
  usage: USAGE,
  run(args) {
    const split = args.indexOf('--');
    if (split === -1) throw new UsageError();
    const parsed = parseOptions(args.slice(0, split), { values: ['kind', 'system', 'change', 'repo', 'task', 'type', 'subject', 'master', 'workspace'], flags: ['json'] });
    const paths = args.slice(split + 1);
    if (!parsed.flags.has('json') || parsed.positional.length > 0 || parsed.values.kind === undefined || paths.length === 0) throw new UsageError();
    const v = parsed.values;
    const outcome = commitKind({
      kind: v.kind as string,
      system: v.system,
      change: v.change,
      repo: v.repo,
      task: v.task,
      type: v.type,
      subject: v.subject,
      options: { ...(v.master !== undefined ? { master: v.master } : {}), ...(v.workspace !== undefined ? { workspace: v.workspace } : {}) },
      paths,
      cwd: process.cwd(),
    });
    printJson(outcome);
    return outcome.reason === 'check failed' || outcome.reason === 'git refused' ? EXIT.PROBLEMS : EXIT.PASS;
  },
};
