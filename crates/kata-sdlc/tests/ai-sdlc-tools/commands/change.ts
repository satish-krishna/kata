// change start --json --system <s> --change <YYYY-MM-DD-slug> --type <t> --scope <scope> [--title <t>] [--branch <name>]
// change rename --json --change <c> --to <name>
// change remove --json --change <c> [--abandon]
// change show --json --change <c> [--refresh]
// (each also takes --master <path> and --workspace <path>)
//
// start runs the change.start event: it names the change's branch, creates it off the master's base branch, makes
// the change's own copy of the master in `<workspace>/.ai-sdlc/copies/<change>/`, and commits `change.yml` there.
// It prints the event's outcome with `details.branch` and `details.copy`: every later step of the change works in
// that copy. rename moves the branch in every repository that has it; remove takes away the copy and the merged
// branches once the change is done (refusing, with nothing removed, a copy with uncommitted files), and with
// --abandon drops a change nothing was done in, or a rejected one (its copy and its local branches, forced, keeping a
// rejected change's master branch; changes/remove.ts says when it refuses); show prints the record, `repos` (every repository of
// the system: its `path`, whether it is `checkedOut`, its current `branch` and its `base`, null when there is none),
// and with --refresh each pull request's state on GitHub now (`states`, by address: OPEN, MERGED, CLOSED, or null
// when gh cannot read it). Exit 0 done, 1 refused, 2 could not run.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions, type Parsed } from '../common/options.ts';
import { CouldNotRun, EXIT } from '../common/types.ts';
import { removeChange } from '../changes/remove.ts';
import { renameBranch } from '../changes/rename.ts';
import { branchOf, readRecord } from '../changes/record.ts';
import { changeScope } from '../changes/scope.ts';
import { copiesFolder, findChange, systemRepos, type EventContext } from '../events/context.ts';
import { runEvent } from '../events/runner.ts';
import { baseBranch, commitOf, currentBranch, mainCheckout } from '../git/git.ts';
import { stateOf } from '../git/gh.ts';
import { readMarker } from '../workspace/marker.ts';
import { resolveWorkspace } from '../workspace/resolve.ts';

const PLACES = ['master', 'workspace'];

function resolved(o: Parsed): { master: string; workspace: string } {
  const r = resolveWorkspace(process.cwd(), { ...(o.values.master ? { master: o.values.master } : {}), ...(o.values.workspace ? { workspace: o.values.workspace } : {}) });
  if (r.master === null || r.workspace === null) throw new CouldNotRun(r.problems.join('\n'));
  return { master: r.master, workspace: r.workspace };
}

async function start(args: string[]): Promise<number> {
  const o = parseOptions(args, { values: ['system', 'change', 'type', 'scope', 'title', 'branch', ...PLACES], flags: ['json'] });
  const { system, change, type, scope } = o.values;
  if (!o.flags.has('json') || !system || !change || !type || !scope || o.positional.length > 0) throw new UsageError();
  const { workspace, master: resolvedMaster } = resolved(o);
  const master = mainCheckout(resolvedMaster);
  if (!readMarker(join(master, '.ai-sdlc.json')).systems[system]) throw new CouldNotRun(`the marker lists no system ${system}`);
  const extra: Record<string, string> = { type, scope };
  if (o.values.title) extra.title = o.values.title;
  if (o.values.branch) extra.branch = o.values.branch;
  const ctx: EventContext = {
    event: 'change.start',
    workspace,
    master,
    system,
    change,
    folder: join(copiesFolder(workspace), change, 'intent', system, change),
    repo: 'master',
    repoPath: master,
    branch: currentBranch(master),
    base: baseBranch(master),
    head: commitOf(master, 'HEAD'),
    repos: systemRepos(master, workspace, system),
    extra,
  };
  const outcome = await runEvent(ctx);
  printJson(outcome);
  if (outcome.outcome === 'passed') return EXIT.PASS;
  return outcome.outcome === 'could-not-run' ? EXIT.COULD_NOT_RUN : EXIT.PROBLEMS;
}

function located(o: Parsed) {
  const change = o.values.change;
  if (!o.flags.has('json') || !change || o.positional.length > 0) throw new UsageError();
  const { workspace, master } = resolved(o);
  const found = findChange(master, workspace, change, o.values.system);
  return { workspace, master: found.master, system: found.system, change, repos: systemRepos(found.master, workspace, found.system), folder: join(found.master, 'intent', found.system, change) };
}

function rename(args: string[]): number {
  const o = parseOptions(args, { values: ['change', 'system', 'to', ...PLACES], flags: ['json'] });
  if (!o.values.to) throw new UsageError();
  const c = located(o);
  const out = renameBranch({ ...c, to: o.values.to, scope: changeScope(c.master, c.system, c.folder) });
  printJson({ change: c.change, from: out.from, to: o.values.to, renamed: out.renamed, problems: out.problems });
  return out.problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
}

function remove(args: string[]): number {
  const o = parseOptions(args, { values: ['change', 'system', ...PLACES], flags: ['json', 'abandon'] });
  const c = located(o);
  const out = removeChange({ ...c, copy: join(copiesFolder(c.workspace), c.change), abandon: o.flags.has('abandon') });
  printJson({ change: c.change, ...out });
  return out.problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
}

function show(args: string[]): number {
  const o = parseOptions(args, { values: ['change', 'system', ...PLACES], flags: ['json', 'refresh'] });
  const c = located(o);
  const record = readRecord(c.folder);
  const states = o.flags.has('refresh') && record ? Object.fromEntries(record.pullRequests.map((p) => [p.url, stateOf(c.master, p.url)])) : null;
  const repos = Object.fromEntries(c.repos.map((name) => {
    const path = join(c.workspace, name);
    const checkedOut = existsSync(join(path, '.git'));
    return [name, { path, checkedOut, branch: checkedOut ? currentBranch(path) : null, base: checkedOut ? baseBranch(path) : null }];
  }));
  printJson({ change: c.change, system: c.system, master: c.master, branch: branchOf(c.folder), record, repos, ...(states ? { states } : {}) });
  return EXIT.PASS;
}

export const change: Command = {
  usage: [
    'change start --json --system s --change c --type t --scope s [--title t] [--branch name]',
    'change rename --json --change c --to name',
    'change remove --json --change c [--abandon]',
    'change show --json --change c [--refresh]',
  ].join('\n       node ai-sdlc.ts '),
  run(args) {
    const [sub, ...rest] = args;
    if (sub === 'start') return start(rest);
    if (sub === 'rename') return rename(rest);
    if (sub === 'remove') return remove(rest);
    if (sub === 'show') return show(rest);
    throw new UsageError();
  },
};
