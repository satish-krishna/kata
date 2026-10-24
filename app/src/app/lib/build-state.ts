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

/** A task's state when its repository's situation could not be decided: done if the build log has its row, else not started. */
export function fallbackTaskState(task: TaskStatus): TaskState {
  return task.row !== null ? { kind: 'done', departure: task.row.departure } : { kind: 'not-started' };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Seconds as `h:mm:ss`. */
export const hms = (secs: number): string => {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
/** Seconds as `m:ss`. */
export const ms = (secs: number): string => `${Math.floor(Math.max(0, secs) / 60)}:${pad(Math.floor(Math.max(0, secs)) % 60)}`;

/** The clock facts of one heading: seconds of work so far (null before any run), the limit, seconds of the wait in progress (null when not waiting), and unseen events. */
export interface ClockFacts {
  workSecs: number | null;
  limitSecs: number;
  waitSecs: number | null;
  unseen: number;
}

type Tone = 'success' | 'warning' | 'error' | 'idle';

/** A repository's heading as the build page says it. `situation` is null when the facts were impossible and the heading is a fallback. */
export interface SituationView {
  situation: Situation | null;
  tone: Tone;
  label: string;
  clock: string | null;
  paused: string | null;
  unseen: number;
  stopLine: string | null;
}

/** The heading a repository gets when its facts are a combination the table calls impossible. */
export const FALLBACK_HEADING = 'Cannot tell where this stands';

const headingOf = (s: Situation): { tone: Tone; label: string } => {
  switch (s.kind) {
    case 'working':
      return { tone: 'success', label: s.task === null ? 'Working' : `Working · ${s.task}` };
    case 'waiting':
      return { tone: 'idle', label: `Waiting for ${s.onTask} in ${s.onRepo}` };
    case 'stopped':
      return { tone: 'error', label: `Stopped at ${s.task}` };
    case 'not-started':
      return { tone: 'idle', label: 'Not started' };
    case 'finished':
      return { tone: 'success', label: 'Finished' };
    case 'idle':
      return { tone: 'idle', label: 'Idle' };
  }
};

/** The one line that says a repository stopped and why, to read after its name: "stopped: the agent failed". */
const stopLineOf = (reason: string | null): string => {
  const why = (reason ?? '').replace(/^Stopped:\s*/i, '').trim();
  return why === '' ? 'stopped' : `stopped: ${why}`;
};

/**
 * The one owner of how a repository's heading says where it stands: its label and tone, the work clock against the limit,
 * the wait in progress, the unseen count and the single stop line (R2.1, R6.1). A combination the situation table calls
 * impossible gives a fallback heading instead of throwing, so one inconsistent input never breaks the page.
 */
export function situationView(facts: SituationFacts, clock: ClockFacts): SituationView {
  const shared = {
    clock: clock.workSecs === null ? null : `work ${hms(clock.workSecs)} of ${hms(clock.limitSecs)}`,
    unseen: clock.unseen,
  };
  let situation: Situation;
  try {
    situation = repoSituation(facts);
  } catch {
    return { situation: null, tone: 'warning', label: FALLBACK_HEADING, paused: null, stopLine: null, ...shared };
  }
  const waiting = situation.kind === 'working' && clock.waitSecs !== null;
  const heading = waiting ? { tone: 'warning' as const, label: 'Waiting for you' } : headingOf(situation);
  return {
    situation,
    ...heading,
    ...shared,
    paused: waiting ? `${ms(clock.waitSecs!)} waiting (not counted)` : null,
    stopLine: situation.kind === 'stopped' ? stopLineOf(situation.reason) : null,
  };
}
