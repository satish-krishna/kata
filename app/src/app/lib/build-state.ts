import type { RepoState } from '@bindings/RepoState';
import type { TaskStatus } from '@bindings/TaskStatus';
import { stopMessage } from './sdlc';

export interface SituationFacts {
  live: boolean;
  stop: { task: string; reason: string } | null;
  state: RepoState | null;
  firstUnfinished: string | null;
  session: 'this' | 'none';
  stage: 'build-ready' | 'build-stopped' | 'build-finished';
  latestExit: number | null | 'no-run';
}

export type Situation =
  | { kind: 'working'; task: string | null }
  | { kind: 'waiting'; task: string; onTask: string; onRepo: string }
  | { kind: 'stopped'; task: string; reason: string | null; from: 'driver' | 'records' }
  | { kind: 'not-started'; task: string }
  | { kind: 'finished' }
  | { kind: 'idle' };

export type TaskState =
  | { kind: 'done'; departure: string | null }
  | { kind: 'running' }
  | { kind: 'waiting'; onTask: string; onRepo: string }
  | { kind: 'stopped'; reason: string | null }
  | { kind: 'not-started' };

/** Where one repository stands in the build (R3.1). A combination the table calls impossible throws. */
export function repoSituation(f: SituationFacts): Situation {
  const { live, stop, state } = f;
  if (live) {
    if (stop) throw new Error('a repository cannot be live and stopped');
    if (f.session === 'none') throw new Error('a run is live in a page that began no driver');
    return { kind: 'working', task: state?.kind === 'ready' ? state.task : null };
  }
  if (stop) {
    if (f.session === 'none') throw new Error('a stop exists only in a driver begun on this page');
    return { kind: 'stopped', task: stop.task, reason: stop.reason, from: 'driver' };
  }
  if (state === null) return { kind: 'idle' };
  if (state.kind === 'done') return { kind: 'finished' };
  if (state.kind === 'waiting') return { kind: 'waiting', task: state.task, onTask: state.onTask, onRepo: state.onRepo };
  if (f.session === 'this' || f.stage === 'build-ready') return { kind: 'not-started', task: state.task };
  if (f.stage === 'build-finished') throw new Error('a finished build has no ready repository');
  // The latest run's exit 0 cannot say why it ended: it may have ended waiting on a task recorded since.
  const reason = f.latestExit === 'no-run' || f.latestExit === 0 ? null : stopMessage(f.latestExit, null);
  return { kind: 'stopped', task: state.task, reason, from: 'records' };
}

/** What one task shows, from its build log row and its own repository's situation (R3.1). */
export function taskState(task: TaskStatus, situation: Situation): TaskState {
  if (task.row !== null) return { kind: 'done', departure: task.row.departure };
  switch (situation.kind) {
    case 'working':
      return situation.task === task.id ? { kind: 'running' } : { kind: 'not-started' };
    case 'waiting':
      return situation.task === task.id ? { kind: 'waiting', onTask: situation.onTask, onRepo: situation.onRepo } : { kind: 'not-started' };
    case 'stopped':
      return situation.task === task.id ? { kind: 'stopped', reason: situation.reason } : { kind: 'not-started' };
    case 'not-started':
      return { kind: 'not-started' };
    case 'finished':
    case 'idle':
      throw new Error(`a task without a row in a ${situation.kind} repository`);
  }
}
