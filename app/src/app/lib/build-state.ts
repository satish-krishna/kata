import type { RepoState } from '@bindings/RepoState';
import type { TaskStatus } from '@bindings/TaskStatus';

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

export function repoSituation(f: SituationFacts): Situation {
  void f;
  throw new Error('not implemented');
}

export function taskState(task: TaskStatus, situation: Situation): TaskState {
  void task;
  void situation;
  throw new Error('not implemented');
}
