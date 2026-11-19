// The read side of the check log: turns `checks.jsonl` into runs of checks, each check's state decided here, so no client
// parses the file or applies the abandoned rule itself. Reads only; the log is written by check-log.ts.
import { existsSync, readFileSync } from 'node:fs';
import type { CheckLine, CheckPhase } from './check-log.ts';
import type { EventName } from './config.ts';

/** `ended` has an end line; `running` has a start and no end; `abandoned` has a start, no end, and is no longer running when read; a check whose end line arrives later reads `ended` from then on. */
export type CheckState = 'ended' | 'running' | 'abandoned';

export type CheckRead = {
  check: string;
  state: CheckState;
  startedAt: string;
  endedAt: string | null;
  timeout: number | null;
  outcome: CheckLine['outcome'] | null;
  ids: string[] | null;
  blocks: boolean | null;
};

export type CheckRun = { run: string; event: EventName; repo: string; phase: CheckPhase; checks: CheckRead[] };

/** Whether a process exists. Signal 0 throws ESRCH for a dead pid; EPERM means it exists but is not ours. `kill` is injectable for tests. */
export const pidAlive = (pid: number, kill: (pid: number, signal: number) => unknown = process.kill): boolean => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

type Open = CheckRead & { pid: number | null; at: number };

/**
 * Reads the check log at `file`. A missing file gives no runs. Only complete lines are read (a half-written tail is
 * skipped), a line of an unknown type or an end with no start is skipped silently, and a complete line that is not a check
 * event adds a problem and is skipped. `now` and `alive` are injectable for tests.
 */
export function readChecks(file: string, options: { repo?: string; now?: number; alive?: (pid: number) => boolean } = {}): { runs: CheckRun[]; problems: string[] } {
  const now = options.now ?? Date.now();
  const alive = options.alive ?? pidAlive;
  const problems: string[] = [];
  if (!existsSync(file)) return { runs: [], problems };
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  const runs = new Map<string, { run: CheckRun; opens: Open[] }>();
  complete.split('\n').slice(0, -1).forEach((raw, i) => {
    if (raw.trim() === '') return;
    let line: Partial<CheckLine> | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) line = parsed as Partial<CheckLine>;
    } catch {
      // Reported below.
    }
    if (line === null || typeof line.type !== 'string') return void problems.push(`line ${i + 1} of ${file} is not a check event`);
    if (line.type !== 'check-start' && line.type !== 'check-end') return;
    const isString = (v: unknown): boolean => typeof v === 'string';
    const whole = isString(line.run) && isString(line.check) && isString(line.at) && isString(line.repo) && isString(line.phase) && isString(line.event) && (line.type === 'check-end' || (typeof line.timeout === 'number' && Number.isFinite(line.timeout)));
    if (!whole) return void problems.push(`line ${i + 1} of ${file} is not a check event`);
    const runId = line.run as string;
    const known = runs.get(runId);
    if (line.type === 'check-start') {
      const entry = known ?? { run: { run: runId, event: line.event as EventName, repo: line.repo as string, phase: line.phase as CheckPhase, checks: [] }, opens: [] };
      runs.set(runId, entry);
      const check: Open = { check: line.check as string, state: 'running', startedAt: line.at as string, endedAt: null, timeout: line.timeout ?? null, outcome: null, ids: null, blocks: null, pid: line.pid ?? null, at: Date.parse(line.at as string) };
      entry.run.checks.push(check);
      entry.opens.push(check);
      return;
    }
    const open = known?.opens.find((c) => c.check === line.check && c.state === 'running');
    if (open === undefined) return;
    open.state = 'ended';
    open.endedAt = line.at as string;
    open.outcome = line.outcome ?? null;
    open.ids = line.ids ?? null;
    open.blocks = line.blocks ?? null;
  });
  const ordered = [...runs.values()];
  ordered.forEach(({ run, opens }, index) => {
    const superseded = ordered.slice(index + 1).some((later) => later.run.repo === run.repo && later.run.phase === run.phase);
    for (const c of opens) {
      if (c.state !== 'running') continue;
      const expired = c.timeout !== null && c.at + c.timeout * 1000 <= now;
      // A pid that is not a positive integer is not a process (kill(0) would signal our own process group).
      const gone = c.pid !== null && !(Number.isInteger(c.pid) && c.pid > 0 && alive(c.pid));
      if (superseded || expired || gone) c.state = 'abandoned';
    }
  });
  const kept = ordered.map((e) => e.run).filter((r) => options.repo === undefined || r.repo === options.repo);
  for (const run of kept) run.checks = (run.checks as Open[]).map(({ pid: _pid, at: _at, ...check }) => check);
  return { runs: kept, problems };
}
