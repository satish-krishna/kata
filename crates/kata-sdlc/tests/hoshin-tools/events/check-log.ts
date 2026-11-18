// The check log: one JSON line per check start and end, appended to `checks.jsonl` beside the change's ledger, so a
// tool that did not start the run can show a check's progress while it runs, reading it through `checks` (check-read.ts)
// rather than tailing the file. The log is
// best-effort: a write that fails never changes a run's outcome, it is reported once as a problem.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EventName, Hook } from './config.ts';
import type { EventContext } from './context.ts';
import { ledgerFolder, type HookRecord } from './ledger.ts';

/** Whether the check ran on the base commit (`baseline`) or on the change's head (`head`). */
export type CheckPhase = 'baseline' | 'head';

export type CheckLine = {
  type: 'check-start' | 'check-end';
  /** One run of an event, the same on every line the run writes. */
  run: string;
  event: EventName;
  repo: string;
  check: string;
  phase: CheckPhase;
  at: string;
  /** The next two are on `check-start` only: the writing program's process ID and the hook's timeout in seconds, so a reader can tell a start that was abandoned from one still running. */
  pid?: number;
  timeout?: number;
  /** The next three are on `check-end` only. */
  outcome?: HookRecord['outcome'];
  ids?: string[] | null;
  blocks?: boolean | null;
};

export const checksFile = (master: string, system: string, change: string): string => join(ledgerFolder(master, system, change), 'checks.jsonl');

export type CheckLog = {
  run: string;
  start(check: string, phase: CheckPhase, timeout: number): void;
  end(check: string, phase: CheckPhase, record: HookRecord, blocks: boolean | null): void;
};

/**
 * Opens the log of one run. A write that fails adds one problem to `problems`, and later failures add nothing, from this
 * log or from another run's log sharing the sink (a baseline and the head run of one event fail the same way).
 */
export function openCheckLog(ctx: EventContext, problems: string[]): CheckLog {
  const run = randomUUID();
  const file = checksFile(ctx.master, ctx.system, ctx.change);
  let reported = false;
  const write = (line: Omit<CheckLine, 'run' | 'event' | 'repo' | 'at'>): void => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ run, event: ctx.event, repo: ctx.repo, at: new Date().toISOString(), ...line }) + '\n');
    } catch (error) {
      if (reported) return;
      reported = true;
      const problem = `check events could not be written to ${file}: ${error instanceof Error ? error.message : String(error)}`;
      if (!problems.includes(problem)) problems.push(problem);
    }
  };
  return {
    run,
    start: (check, phase, timeout) => write({ type: 'check-start', check, phase, pid: process.pid, timeout }),
    end: (check, phase, record, blocks) => write({ type: 'check-end', check, phase, outcome: record.outcome, ids: record.ids, blocks }),
  };
}

/**
 * Runs one check between its start and end lines. If `run` throws after the start line, the end line is still written as
 * `could-not-run` before the error propagates, so the start is never left without an end by an error the program saw.
 */
export async function loggedCheck(log: CheckLog | undefined, check: string, phase: CheckPhase, timeout: number, blocksOnThrow: boolean | null, run: () => Promise<HookRecord>): Promise<HookRecord> {
  log?.start(check, phase, timeout);
  try {
    return await run();
  } catch (error) {
    log?.end(check, phase, { id: check, when: 'before', outcome: 'could-not-run', exitCode: null, output: '', ids: null }, blocksOnThrow);
    throw error;
  }
}

/** A check is a blocking before hook of `build.finish`: the hooks whose verdict decides whether the build may finish. */
export const isCheck = (event: EventName, hook: Hook): boolean => event === 'build.finish' && hook.when === 'before' && hook.blocking;
