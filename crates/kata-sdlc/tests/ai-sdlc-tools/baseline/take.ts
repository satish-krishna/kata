// Taking a repository's baseline: how each of its checks (the blocking before hooks of build.finish that apply to
// it) does on the base commit, the merge-base of its head and its base branch. The checks run in the repository
// itself, never in a fresh worktree, so its installed dependencies and build output are there: in place when the
// head is the base commit, as in every fresh build, and otherwise on a detached checkout of the base commit, with the
// branch put back whatever happens. Either way the working tree must hold no uncommitted files, since a baseline is
// shared by every change on that commit. Every check runs, whatever the others do. A check that could not run is a
// fault of the machine: nothing is stored, and the next run takes the baseline again. The master repository, built
// in a change's copy where other builds commit at the same time, gets no baseline. In the single-repo layout the
// checks of an app run in its folder, but the base is checked out in the copy as a whole (the one git repository),
// restored to the change's branch afterwards, and only the app's own files count as uncommitted; the cleanup after a
// baseline is scoped to the app's folder, so another app's untracked files stay.
import { hooksFor, type Hook, type HookConfig } from '../events/config.ts';
import { uncommittedOf, type EventContext } from '../events/context.ts';
import { runHook } from '../events/runner.ts';
import { exportScripts } from '../events/scripts.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { baseRevision, commitOf, currentBranch, git, gitOut, gitPath, mergeBase, trackedChanges } from '../git/git.ts';
import { appFolders, appPathspec, isSingleRepo, uncommittedInApp } from '../workspace/apps.ts';
import { uncommittedFiles } from '../workspace/own-files.ts';
import { dropEntry, findEntry, saveEntry, type BaselineEntry, type BaselineHook } from './store.ts';

export type Taken = {
  /** The base commit, or null when there is none (no base branch, or the master repository). */
  base: string | null;
  entry: BaselineEntry | null;
  reused: boolean;
  outcome: 'passed' | 'failed' | 'could-not-run';
  problems: string[];
  /** The check that could not run on the base, with its output, when that is why there is no baseline. */
  fault?: { id: string; output: string };
};

/** A repository's checks: the blocking before hooks of build.finish that apply to it. */
export const checksOf = (config: HookConfig, repo: string): Hook[] => hooksFor(config, 'build.finish', 'before', repo).filter((h) => h.blocking);

/** What a baseline is valid for besides its base commit: the checks, and the hook scripts as committed. */
export function signatureOf(config: HookConfig, master: string, system: string, checks: Hook[]): string {
  const tree = (path: string) => (config.revision === null ? null : gitOut(master, ['rev-parse', `${config.revision}:${path}`]));
  return JSON.stringify({ checks: checks.map(({ id, run, timeout }) => ({ id, run, timeout })), trees: [tree('intent/hooks'), tree(`intent/${system}/hooks`)] });
}

/**
 * Where the repository was before a detached baseline, kept in its git folder until it is back there, so a run that
 * was killed on the base commit (its own process ended, so no `finally` ran) is put back by the next one.
 */
type Restore = { branch: string; head: string; /** The app's folder in the single-repo layout: only its files are cleaned and counted. */ folder?: string };
const restoreFile = (root: string): string => gitPath(root, 'ai-sdlc/baseline-restore.json');

/** The app folder a baseline of this event is scoped to, or null: the whole repository, as in the default layout. */
const folderOf = (ctx: EventContext): string | null => (ctx.repo === 'master' || !isSingleRepo(ctx.master) ? null : appFolders(ctx.master, ctx.system)[ctx.repo] ?? null);

function writeRestore(root: string, where: Restore): void {
  const file = restoreFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(where) + '\n');
}

/**
 * Puts the repository back on its branch after a detached baseline, whatever the checks left: a plain checkout, then,
 * when git refuses (a check changed a tracked file, or left an untracked one the branch tracks), a forced one and a
 * clean of untracked files, both safe because the working tree was clean before the detach. Ignored files stay.
 * Returns why it is not back (branch, commit and a clean tree, all checked), or null when it is.
 */
function restore(root: string, where: Restore): string | null {
  // In the single-repo layout a check that changed a tracked file anywhere in the copy (a root lockfile, say) leaves it
  // modified on the branch, so those count too, not only the app folder's own files.
  const dirty = (): string[] => (where.folder === undefined ? uncommittedFiles(root) : [...new Set([...uncommittedInApp(root, where.folder), ...trackedChanges(root)])]);
  if (!git(root, ['checkout', '--quiet', where.branch]).ok) git(root, ['checkout', '--quiet', '--force', where.branch]);
  if (currentBranch(root) === where.branch) git(root, ['clean', '-fdq', ...(where.folder === undefined ? [] : ['--', ...appPathspec(where.folder)])]);
  const back = currentBranch(root) === where.branch && commitOf(root, 'HEAD') === where.head && dirty().length === 0;
  if (!back) {
    const now = currentBranch(root);
    const files = dirty();
    const lead = `${root} could not be put back on ${where.branch} at ${where.head.slice(0, 7)} after its baseline: it is on ${now ?? 'a detached HEAD'} with ${files.join(', ') || 'no uncommitted files'}.`;
    // On the branch at its head, only the files are wrong: a checkout would change nothing.
    const advice = now === where.branch && commitOf(root, 'HEAD') === where.head
      ? 'The checks changed tracked files there; restore or discard them (git restore) before going on'
      : `Check out ${where.branch} at ${where.head.slice(0, 7)} there before going on`;
    return `${lead} ${advice}; nothing was stored.`;
  }
  rmSync(restoreFile(root), { force: true });
  return null;
}

/**
 * Puts back a repository that a killed baseline run left on the base commit, as its restore record says; null when
 * there is nothing to put back or it is back, otherwise why not.
 */
export function recoverInterrupted(root: string): string | null {
  const file = restoreFile(root);
  if (!existsSync(file)) return null;
  let where: Restore;
  try {
    where = JSON.parse(readFileSync(file, 'utf8')) as Restore;
  } catch {
    rmSync(file, { force: true });
    return null;
  }
  if (currentBranch(root) === where.branch) {
    rmSync(file, { force: true });
    return null;
  }
  return restore(root, where);
}

/** The merge-base of the repository's head and its base branch, or null. */
export function baseCommitOf(ctx: EventContext): string | null {
  if (ctx.base === null) return null;
  const revision = baseRevision(ctx.root, ctx.base);
  return revision === null ? null : mergeBase(ctx.root, 'HEAD', revision);
}

/** The stored baseline at the repository's base commit, without running anything. */
export function storedBaseline(ctx: EventContext, config: HookConfig): Taken {
  const checks = checksOf(config, ctx.repo);
  if (ctx.repo === 'master' || checks.length === 0) return { base: null, entry: null, reused: false, outcome: 'passed', problems: [] };
  const base = baseCommitOf(ctx);
  if (base === null) return { base: null, entry: null, reused: false, outcome: 'failed', problems: [`${ctx.repo} has no base branch on this machine, so its checks have no baseline`] };
  const entry = findEntry(ctx.master, ctx.system, ctx.repo, base, signatureOf(config, ctx.master, ctx.system, checks));
  return { base, entry, reused: entry !== null, outcome: 'passed', problems: [] };
}

/** The baseline at the repository's base commit: the stored one, or taken now. `retake` drops a stored one first. */
export async function takeBaseline(ctx: EventContext, config: HookConfig, options: { retake?: boolean } = {}): Promise<Taken> {
  const stored = storedBaseline(ctx, config);
  if (stored.base === null) return stored;
  const base = stored.base;
  const checks = checksOf(config, ctx.repo);
  const signature = signatureOf(config, ctx.master, ctx.system, checks);
  if (options.retake) dropEntry(ctx.master, ctx.system, ctx.repo, base, signature);
  else if (stored.entry !== null) return stored;

  const none = (outcome: Taken['outcome'], problems: string[]): Taken => ({ base, entry: null, reused: false, outcome, problems });
  const dirty = uncommittedOf(ctx);
  if (dirty.length > 0) return none('failed', [`${ctx.repo} has uncommitted files, so the baseline of its checks cannot be taken; commit, ignore or remove them: ${dirty.join(', ')}`]);
  const head = commitOf(ctx.root, 'HEAD');
  const atBase = head === base;
  if (!atBase && (ctx.branch === null || head === null)) return none('failed', [`${ctx.repo} is on a detached HEAD, so the baseline of its checks cannot be taken`]);

  const folder = folderOf(ctx);
  // Checking out the base moves the whole copy, so changes to tracked files anywhere in it (another app's, or
  // ai-sdlc's own) would be carried along or lost; only untracked files of other apps may stay.
  if (!atBase && folder !== null) {
    const tracked = trackedChanges(ctx.root);
    if (tracked.length > 0) return none('failed', [`${ctx.root} has uncommitted changes to tracked files, so the base commit cannot be checked out for the baseline of ${ctx.repo}'s checks; commit or put them away: ${tracked.join(', ')}`]);
  }
  const scripts = exportScripts(ctx.master, config.revision, ctx.system);
  const records = [];
  let restored: string | null = null;
  try {
    if (!atBase) {
      writeRestore(ctx.root, { branch: ctx.branch as string, head: head as string, ...(folder === null ? {} : { folder }) });
      const out = git(ctx.root, ['checkout', '--quiet', '--detach', base]);
      if (!out.ok) return none('failed', [`git could not check out the base commit ${base.slice(0, 7)} of ${ctx.repo}: ${out.stderr.trim()}`]);
    }
    // On the base, the branch is not checked out: a check that looks it up must not find it.
    const asFinish: EventContext = { ...ctx, event: 'build.finish', head: base, branch: atBase ? ctx.branch : null };
    for (const check of checks) records.push(await runHook(check, asFinish, scripts, {}, { AI_SDLC_BASELINE: '1' }));
  } finally {
    if (!atBase) restored = restore(ctx.root, { branch: ctx.branch as string, head: head as string, ...(folder === null ? {} : { folder }) });
    scripts.remove();
  }
  if (restored !== null) return none('could-not-run', [restored]);

  const fault = records.find((r) => r.outcome === 'could-not-run');
  if (fault) return { ...none('could-not-run', [`check ${fault.id} could not run on the base commit ${base.slice(0, 7)}, so no baseline was stored`]), fault: { id: fault.id, output: fault.output } };
  const hooks: BaselineHook[] = records.map((r) => ({ id: r.id, outcome: r.outcome === 'passed' ? 'passed' : 'failed', exitCode: r.exitCode, ids: r.ids ?? null, output: r.output }));
  const entry: BaselineEntry = { base, signature, at: new Date().toISOString(), hooks };
  saveEntry(ctx.master, ctx.system, ctx.repo, entry);
  return { base, entry, reused: false, outcome: 'passed', problems: [] };
}
