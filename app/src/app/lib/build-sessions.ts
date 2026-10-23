import type { BuildStatus } from '@bindings/BuildStatus';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { TaskLink } from '@bindings/TaskLink';
import type { TaskStatus } from '@bindings/TaskStatus';
import type { RunState, RunSummary } from './events';

export type Pick = { kind: 'repo'; repo: string } | { kind: 'task'; task: string } | { kind: 'review' };
export type SessionRef = { runId: string; startedAt: number };
type Summary = { exit_code: RunSummary['exit_code']; num_turns: RunSummary['num_turns']; cost_usd?: RunSummary['cost_usd'] };

export const outcomeOf = (_state: RunState, _summary: Summary | null): string => {
  throw new Error('not implemented');
};
export const repoSessions = (
  _links: RunLink[],
  _scope: { workspaceId: string; system: string; change: string },
): Map<string, RunLink[]> => {
  throw new Error('not implemented');
};
export const newlyRecorded = (_before: BuildStatus, _after: BuildStatus, _repo: string): string[] => {
  throw new Error('not implemented');
};
export const recordOutcome = (_record: RunRecord | null): string => {
  throw new Error('not implemented');
};
export const sessionsFor = (
  _pick: Pick,
  _tasks: TaskStatus[],
  _sessions: Map<string, SessionRef[]>,
  _taskLinks: TaskLink[],
): { sessions: SessionRef[]; unknown: boolean } => {
  throw new Error('not implemented');
};
