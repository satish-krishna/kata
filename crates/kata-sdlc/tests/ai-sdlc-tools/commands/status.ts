// status --json --change <change> [--system <s>] [--master <path>] [--workspace <path>]
// Prints the ledger of a change: every event run recorded on this machine, per repository, each marked `current`
// when the repository's head (or, for doc.accept, the document's last commit) is still the one it was recorded at.
// `{ "system", "change", "repos": [{ "repo", "path", "head", "runs": [...] }] }`. Exit 0.
import { join } from 'node:path';
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { CouldNotRun, EXIT } from '../common/types.ts';
import { findChange } from '../events/context.ts';
import { ledgerFolder, readLedgers } from '../events/ledger.ts';
import { commitOf, gitOut } from '../git/git.ts';
import { appFolders, currentAppHead, isSingleRepo } from '../workspace/apps.ts';
import { resolveWorkspace } from '../workspace/resolve.ts';

export const status: Command = {
  usage: 'status --json --change <change> [--system s] [--master p] [--workspace p]',
  run(args) {
    const o = parseOptions(args, { values: ['change', 'system', 'master', 'workspace'], flags: ['json'] });
    if (!o.flags.has('json') || !o.values.change || o.positional.length > 0) throw new UsageError();
    const r = resolveWorkspace(process.cwd(), { ...(o.values.master ? { master: o.values.master } : {}), ...(o.values.workspace ? { workspace: o.values.workspace } : {}) });
    if (r.master === null || r.workspace === null) throw new CouldNotRun(r.problems.join('\n'));
    const found = findChange(r.master, r.workspace, o.values.change, o.values.system);
    const folder = join(found.master, 'intent', found.system, o.values.change);
    const single = isSingleRepo(found.master);
    const apps = single ? appFolders(found.master, found.system) : {};
    const repos = readLedgers(ledgerFolder(found.master, found.system, o.values.change)).map((l) => {
      // An app's ledger is keyed by the app's head; the master's (and every default-layout one) by HEAD.
      const head = single && l.repo in apps ? currentAppHead(found.master, found.master, found.system, l.repo) : commitOf(l.path, 'HEAD');
      const runs = l.runs.map((run) => {
        const now = run.event === 'doc.accept' ? gitOut(found.master, ['log', '-1', '--format=%H', '--', join(folder, run.subject ?? '')]) : head;
        return { ...run, current: run.key === now };
      });
      return { repo: l.repo, path: l.path, head, runs };
    });
    printJson({ system: found.system, change: o.values.change, repos });
    return EXIT.PASS;
  },
};
