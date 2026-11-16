// Records what a task's test does at the commit that adds it, before any production code: the program runs the
// test (and the compile command before it) itself, so red is observed, never reported. The commands come from the
// accepted plan as committed in HEAD of the change's master, never from the working tree.
import { relative } from 'node:path';
import { readPlan } from '../documents/plan.ts';
import { emptyLedger, ledgerFolder, readLedger, writeLedger, type RedRecord } from '../events/ledger.ts';
import { uncommittedOf, type EventContext } from '../events/context.ts';
import { runProcess } from '../events/process.ts';
import { baseRevision, commitOf, commitsWithTrailer, gitOut, mergeBase, showFile } from '../git/git.ts';
import { appFolders, appPathspec, isSingleRepo } from '../workspace/apps.ts';

const DEFAULT_TIMEOUT_SECONDS = 600;

/** The seconds a command may run: HOSHIN_RED_TIMEOUT when it is a positive whole number (for tests), else 600. */
function timeoutSeconds(): number {
  const text = process.env['HOSHIN_RED_TIMEOUT'] ?? '';
  return /^[1-9]\d*$/.test(text) ? Number(text) : DEFAULT_TIMEOUT_SECONDS;
}

/** Full SHAs, oldest first, of the commits from the merge base with the base branch to HEAD that carry `Plan-Task: <task>`. */
export function taskCommits(ctx: EventContext, task: string): string[] {
  if (ctx.base === null) return [];
  const baseRev = baseRevision(ctx.root, ctx.base);
  if (baseRev === null || commitOf(ctx.root, 'HEAD') === null) return [];
  const from = mergeBase(ctx.root, baseRev, 'HEAD');
  if (from === null) return [];
  const folder = isSingleRepo(ctx.master) ? (appFolders(ctx.master, ctx.system)[ctx.repo] ?? null) : null;
  const pathspec = ctx.repo === 'master' || folder === null ? [] : appPathspec(folder);
  return commitsWithTrailer(ctx.root, from, 'HEAD', 'Plan-Task', pathspec)
    .filter((c) => c.values.includes(task))
    .map((c) => c.sha);
}

/** The commit's type: its subject before the first `(` or `:`. */
const typeOf = (root: string, sha: string): string => ((gitOut(root, ['log', '-1', '--format=%s', sha]) ?? '').split(/[(:]/)[0] ?? '').trim();

const refuse = (problem: string): { record: null; problems: string[] } => ({ record: null, problems: [problem] });

/**
 * Runs the task's compile command, then its test command, at the clean test commit in HEAD, and stores what happened
 * in the repository's ledger. `record` is null, with the reason in `problems`, when nothing was run.
 */
export async function recordRed(ctx: EventContext, task: string): Promise<{ record: RedRecord | null; problems: string[] }> {
  const planPath = relative(ctx.master, `${ctx.folder}/plan.md`).split('\\').join('/');
  const text = showFile(ctx.master, 'HEAD', planPath);
  const found = text === null ? undefined : readPlan(text, planPath, null);
  const entry = found?.kind === 'plan' ? found.document.tasks.find((t) => t.id === task) : undefined;
  if (entry === undefined) return refuse(`${task} is not a task of the plan committed in HEAD of the master repository`);
  if (entry.test === null) return refuse(`${task} has no test command in the accepted plan; the plan skill names it in the task's test field`);
  const head = commitOf(ctx.root, 'HEAD');
  if (head === null || !taskCommits(ctx, task).includes(head)) return refuse(`HEAD (${(head ?? '').slice(0, 7)}) is not a commit of ${task}: red is recorded on the commit that adds ${task}'s failing test`);
  const type = typeOf(ctx.root, head);
  if (type !== 'test') return refuse(`HEAD (${head.slice(0, 7)}) is a ${type} commit: red is recorded on the commit that adds ${task}'s failing test, before any production code`);
  const production = taskCommits(ctx, task).slice(0, -1).find((sha) => typeOf(ctx.root, sha) !== 'test');
  if (production !== undefined) return refuse(`${task} already has production commits before HEAD (${production.slice(0, 7)}): red is recorded only before the task's first production commit`);
  const uncommitted = uncommittedOf(ctx);
  if (uncommitted.length > 0) return refuse(`${ctx.repo} has uncommitted files: ${uncommitted.join(', ')}; red is recorded on a clean test commit`);

  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const options = { cwd: ctx.repoPath, env, input: '', timeoutSeconds: timeoutSeconds() };
  let ran = entry.compile === null ? null : await runProcess(entry.compile, options);
  let outcome: RedRecord['outcome'];
  if (ran !== null && ran.outcome !== 'passed') {
    outcome = ran.outcome === 'failed' ? 'could-not-compile' : 'could-not-run';
  } else {
    ran = await runProcess(entry.test, options);
    outcome = ran.outcome === 'failed' ? 'failed' : ran.outcome;
  }
  const record: RedRecord = { task, commit: head, compile: entry.compile, test: entry.test, outcome, exitCode: ran.exitCode, output: ran.output, at: new Date().toISOString() };
  const folder = ledgerFolder(ctx.master, ctx.system, ctx.change);
  const ledger = readLedger(folder, ctx.repo) ?? emptyLedger(ctx.system, ctx.change, ctx.repo, ctx.repoPath);
  writeLedger(folder, { ...ledger, reds: [...(ledger.reds ?? []), record] });
  return { record, problems: [] };
}
