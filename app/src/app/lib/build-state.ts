export type Situation =
  | { kind: 'working'; task: string | null }
  | { kind: 'waiting'; task: string; onTask: string; onRepo: string }
  | { kind: 'stopped'; task: string; reason: string | null }
  | { kind: 'not-started'; task: string }
  | { kind: 'finished' }
  | { kind: 'idle' };

export type TaskState =
  | { kind: 'done'; departure: string | null }
  | { kind: 'running' }
  | { kind: 'waiting'; onTask: string; onRepo: string }
  | { kind: 'stopped'; reason: string | null }
  | { kind: 'not-started' };

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

/** A repository's heading as the build page says it. */
export interface SituationView {
  situation: Situation;
  tone: Tone;
  label: string;
  clock: string | null;
  paused: string | null;
  unseen: number;
  stopLine: string | null;
}

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
 * How a repository's heading says where it stands, given the situation the backend's state puts it in: its label and tone, the work clock
 * against the limit, the wait in progress, the unseen count and the single stop line (R2.1, R6.1).
 */
export function situationView(situation: Situation, clock: ClockFacts): SituationView {
  const shared = {
    clock: clock.workSecs === null ? null : `work ${hms(clock.workSecs)} of ${hms(clock.limitSecs)}`,
    unseen: clock.unseen,
  };
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
