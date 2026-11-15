// Approvals: a check that already fails on the base commit and does not say what failed could hide a new failure,
// so a build may go on with it only when the engineer approves it, with `baseline approve`, which the guard keeps
// from the agent. An approval is kept in the change's ledger for one repository, one check and one base commit:
// it lasts for this change's build of that repository, and a new base commit or another change asks again.
import { resolve } from 'node:path';
import type { EventContext } from '../events/context.ts';
import { emptyLedger, ledgerFolder, readLedger, writeLedger, type RepoLedger } from '../events/ledger.ts';
import type { BaselineEntry } from './store.ts';

/** The checks approved at a base commit. */
export const approvedHooks = (ledger: RepoLedger | null, base: string): string[] => (ledger?.approvals ?? []).filter((a) => a.base === base).map((a) => a.hook);

/** The checks that failed on the base without saying what failed and have no approval: what stops a build. */
export const needsApproval = (entry: BaselineEntry, approved: string[]): string[] => entry.hooks.filter((h) => h.outcome === 'failed' && h.ids === null && !approved.includes(h.id)).map((h) => h.id);

export const ledgerOf = (ctx: EventContext): RepoLedger | null => readLedger(ledgerFolder(ctx.master, ctx.system, ctx.change), ctx.repo);

/**
 * What stops a build on a check that needs approval, with the command for the engineer. The command names the
 * program by its absolute path, since the engineer may run it in a terminal where no plugin folder is on the PATH.
 */
export const approvalProblem = (ctx: EventContext, base: string, hook: string): string =>
  `check ${hook} already fails on the base (${base.slice(0, 7)}) and does not say what failed, so a new failure in it could not be told from the old one. Fix it on the base branch, or, if you accept it for this build, run: node "${resolve(process.argv[1] as string)}" baseline approve --json --change ${ctx.change} --repo ${ctx.repo} --hook ${hook}`;

/** Records the approval of a check at the entry's base commit; why it cannot be approved otherwise. */
export function approve(ctx: EventContext, entry: BaselineEntry | null, hook: string): string[] {
  if (entry === null) return [`${ctx.repo} has no baseline at its base commit yet; build.start takes it, or baseline retake`];
  const check = entry.hooks.find((h) => h.id === hook);
  if (!check) return [`${hook} is not one of ${ctx.repo}'s checks in its baseline (${entry.hooks.map((h) => h.id).join(', ') || 'none'})`];
  if (check.outcome === 'passed') return [`check ${hook} passes on the base, so there is nothing to approve`];
  if (check.ids !== null) return [`check ${hook} says what failed on the base (${check.ids.join(', ')}), so build.finish compares it without an approval`];
  const folder = ledgerFolder(ctx.master, ctx.system, ctx.change);
  const ledger = readLedger(folder, ctx.repo) ?? emptyLedger(ctx.system, ctx.change, ctx.repo, ctx.repoPath);
  if (approvedHooks(ledger, entry.base).includes(hook)) return [];
  writeLedger(folder, { ...ledger, approvals: [...(ledger.approvals ?? []), { hook, base: entry.base, at: new Date().toISOString() }] });
  return [];
}
