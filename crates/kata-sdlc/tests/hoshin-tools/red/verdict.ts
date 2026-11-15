// Turns the newest `red record` for a task into the verdict the build coordinator copies into the build log: was red
// observed, and if not, why not. It reads the ledger and git only; it runs no command.
import { ledgerFolder, readLedger, type RedRecord } from '../events/ledger.ts';
import type { EventContext } from '../events/context.ts';
import { taskCommits } from './record.ts';

export type RedVerdict = { observed: boolean; reason: string | null; record: RedRecord | null };

/** The verdict from the newest record for `task`, the first row that applies. */
export function redVerdict(ctx: EventContext, task: string): RedVerdict {
  const all = (readLedger(ledgerFolder(ctx.master, ctx.system, ctx.change), ctx.repo)?.reds ?? []).filter((r) => r.task === task);
  const record = all[all.length - 1] ?? null;
  if (record === null) return { observed: false, reason: `no red recorded for ${task} on this machine`, record };
  const at = record.commit.slice(0, 7);
  const commits = taskCommits(ctx, task);
  if (!commits.includes(record.commit)) return { observed: false, reason: `red was recorded at ${at}, which is not a commit of ${task} on this branch`, record };
  if (record.outcome === 'passed') return { observed: false, reason: `the test passed at ${at}, before the production code`, record };
  if (record.outcome === 'could-not-compile') return { observed: false, reason: `the test did not compile at ${at}`, record };
  if (record.outcome === 'could-not-run') return { observed: false, reason: `the test could not run at ${at}`, record };
  return { observed: true, reason: null, record };
}
