import type { RepoState } from '@bindings/RepoState';
import type { TaskStatus } from '@bindings/TaskStatus';
import { repoSituation, situationView, taskState, type ClockFacts, type Situation, type SituationFacts, type TaskState } from './build-state';
import { stopMessage } from './sdlc';

const ready = (task: string): RepoState => ({ kind: 'ready', task });
const waitingOn = (task: string, onTask: string, onRepo: string): RepoState => ({ kind: 'waiting', task, onTask, onRepo });
const done: RepoState = { kind: 'done' };

const facts = (over: Partial<SituationFacts>): SituationFacts => ({
  live: false,
  stop: null,
  state: null,
  firstUnfinished: null,
  session: 'none',
  stage: 'build-ready',
  latestExit: 'no-run',
  ...over,
});

type Case = { name: string; facts: SituationFacts; expected: Situation | 'impossible' };

const SITUATION_CASES: Case[] = [
  { name: 'row 1: live with a stop', facts: facts({ live: true, stop: { task: 'T1', reason: 'r' }, state: ready('T1'), session: 'this' }), expected: 'impossible' },
  { name: 'row 2: live without a session', facts: facts({ live: true, state: ready('T1') }), expected: 'impossible' },
  { name: 'row 3: live, ready T1', facts: facts({ live: true, state: ready('T1'), session: 'this' }), expected: { kind: 'working', task: 'T1' } },
  { name: 'row 4: live, waiting', facts: facts({ live: true, state: waitingOn('T2', 'T1', 'api'), session: 'this' }), expected: { kind: 'working', task: null } },
  { name: 'row 4: live, done', facts: facts({ live: true, state: done, session: 'this' }), expected: { kind: 'working', task: null } },
  { name: 'row 4: live, master', facts: facts({ live: true, state: null, session: 'this' }), expected: { kind: 'working', task: null } },
  { name: 'row 5: stopped by the driver', facts: facts({ stop: { task: 'T2', reason: 'Stopped: nobody answered' }, state: ready('T2'), session: 'this' }), expected: { kind: 'stopped', task: 'T2', reason: 'Stopped: nobody answered', from: 'driver' } },
  { name: 'row 5: stopped by the driver, repository finished', facts: facts({ stop: { task: '', reason: 'x' }, state: done, session: 'this' }), expected: { kind: 'stopped', task: '', reason: 'x', from: 'driver' } },
  { name: 'row 6: stop without a session', facts: facts({ stop: { task: 'T2', reason: 'r' }, state: ready('T2') }), expected: 'impossible' },
  { name: 'row 7: waiting', facts: facts({ state: waitingOn('T2', 'T1', 'api') }), expected: { kind: 'waiting', task: 'T2', onTask: 'T1', onRepo: 'api' } },
  { name: 'row 7: waiting, this session', facts: facts({ state: waitingOn('T2', 'T1', 'api'), session: 'this' }), expected: { kind: 'waiting', task: 'T2', onTask: 'T1', onRepo: 'api' } },
  { name: 'row 8: done', facts: facts({ state: done, stage: 'build-finished' }), expected: { kind: 'finished' } },
  { name: 'row 9: master', facts: facts({ state: null }), expected: { kind: 'idle' } },
  { name: 'row 10: ready, this session', facts: facts({ state: ready('T1'), session: 'this', stage: 'build-stopped', latestExit: 1 }), expected: { kind: 'not-started', task: 'T1' } },
  { name: 'row 11: ready, build-ready', facts: facts({ state: ready('T1'), stage: 'build-ready' }), expected: { kind: 'not-started', task: 'T1' } },
  { name: 'row 12: ready, build-stopped, no run', facts: facts({ state: ready('T1'), stage: 'build-stopped', latestExit: 'no-run' }), expected: { kind: 'stopped', task: 'T1', reason: null, from: 'records' } },
  { name: 'row 13: ready, build-stopped, exit 0', facts: facts({ state: ready('T1'), stage: 'build-stopped', latestExit: 0 }), expected: { kind: 'stopped', task: 'T1', reason: null, from: 'records' } },
  { name: 'row 14: ready, build-stopped, exit 124', facts: facts({ state: ready('T1'), stage: 'build-stopped', latestExit: 124 }), expected: { kind: 'stopped', task: 'T1', reason: stopMessage(124, null), from: 'records' } },
  { name: 'row 14: ready, build-stopped, exit 1', facts: facts({ state: ready('T1'), stage: 'build-stopped', latestExit: 1 }), expected: { kind: 'stopped', task: 'T1', reason: 'Stopped: the agent failed', from: 'records' } },
  { name: 'row 14: ready, build-stopped, null exit', facts: facts({ state: ready('T1'), stage: 'build-stopped', latestExit: null }), expected: { kind: 'stopped', task: 'T1', reason: 'Stopped: the agent failed', from: 'records' } },
  { name: 'row 14: ready, build-stopped, exit 130', facts: facts({ state: ready('T1'), stage: 'build-stopped', latestExit: 130 }), expected: { kind: 'stopped', task: 'T1', reason: 'Stopped: cancelled', from: 'records' } },
  { name: 'row 15: ready, build-finished', facts: facts({ state: ready('T1'), stage: 'build-finished' }), expected: 'impossible' },
];

describe('repoSituation', () => {
  it('decides every row of the situation table', () => {
    for (const c of SITUATION_CASES) {
      if (c.expected === 'impossible') expect(() => repoSituation(c.facts), c.name).toThrow();
      else expect(repoSituation(c.facts), c.name).toEqual(c.expected);
    }
  });
});

const task = (id: string, row: TaskStatus['row'] = null): TaskStatus => ({ id, name: id, repo: 'api', dependsOn: [], text: `### ${id}`, row });
const committed = (id: string, departure: string | null): TaskStatus => task(id, { task: id, repo: 'api', commits: [], departure });

type TaskCase = { name: string; task: TaskStatus; situation: Situation; expected: TaskState | 'impossible' };

const TASK_CASES: TaskCase[] = [
  { name: 'committed, any situation, no departure', task: committed('T1', null), situation: { kind: 'idle' }, expected: { kind: 'done', departure: null } },
  { name: 'committed, working on another task, with departure', task: committed('T1', 'used X'), situation: { kind: 'working', task: 'T2' }, expected: { kind: 'done', departure: 'used X' } },
  { name: 'committed, finished', task: committed('T1', null), situation: { kind: 'finished' }, expected: { kind: 'done', departure: null } },
  { name: 'working, its task', task: task('T1'), situation: { kind: 'working', task: 'T1' }, expected: { kind: 'running' } },
  { name: 'working, another task', task: task('T2'), situation: { kind: 'working', task: 'T1' }, expected: { kind: 'not-started' } },
  { name: 'working, task null', task: task('T2'), situation: { kind: 'working', task: null }, expected: { kind: 'not-started' } },
  { name: 'waiting, its task', task: task('T2'), situation: { kind: 'waiting', task: 'T2', onTask: 'T1', onRepo: 'api' }, expected: { kind: 'waiting', onTask: 'T1', onRepo: 'api' } },
  { name: 'waiting, a later task', task: task('T3'), situation: { kind: 'waiting', task: 'T2', onTask: 'T1', onRepo: 'api' }, expected: { kind: 'not-started' } },
  { name: 'stopped, its task', task: task('T2'), situation: { kind: 'stopped', task: 'T2', reason: 'Stopped: nobody answered', from: 'driver' }, expected: { kind: 'stopped', reason: 'Stopped: nobody answered' } },
  { name: 'stopped, its task, no reason', task: task('T2'), situation: { kind: 'stopped', task: 'T2', reason: null, from: 'records' }, expected: { kind: 'stopped', reason: null } },
  { name: 'stopped, another task', task: task('T3'), situation: { kind: 'stopped', task: 'T2', reason: 'r', from: 'driver' }, expected: { kind: 'not-started' } },
  { name: 'not started, its task', task: task('T1'), situation: { kind: 'not-started', task: 'T1' }, expected: { kind: 'not-started' } },
  { name: 'not started, another task', task: task('T2'), situation: { kind: 'not-started', task: 'T1' }, expected: { kind: 'not-started' } },
  { name: 'no row, finished', task: task('T1'), situation: { kind: 'finished' }, expected: 'impossible' },
  { name: 'no row, idle', task: task('T1'), situation: { kind: 'idle' }, expected: 'impossible' },
  // R3.1 Examples rows
  { name: 'R3.1 working on this task, not committed: running', task: task('T2'), situation: { kind: 'working', task: 'T2' }, expected: { kind: 'running' } },
  { name: 'R3.1 waiting for a task in another repository, not committed: waiting on that task in that repository', task: task('T2'), situation: { kind: 'waiting', task: 'T2', onTask: 'T1', onRepo: 'web' }, expected: { kind: 'waiting', onTask: 'T1', onRepo: 'web' } },
  { name: 'R3.1 stopped at this task, not committed: stopped, with the reason', task: task('T2'), situation: { kind: 'stopped', task: 'T2', reason: 'Stopped: reached the time limit', from: 'driver' }, expected: { kind: 'stopped', reason: 'Stopped: reached the time limit' } },
  { name: 'R3.1 stopped at an earlier task, not committed: not started', task: task('T3'), situation: { kind: 'stopped', task: 'T2', reason: 'r', from: 'driver' }, expected: { kind: 'not-started' } },
  { name: 'R3.1 working on an earlier task, not committed: not started', task: task('T3'), situation: { kind: 'working', task: 'T2' }, expected: { kind: 'not-started' } },
  { name: 'R3.1 any state, committed: done, with its departure', task: committed('T2', 'swapped the library'), situation: { kind: 'working', task: 'T3' }, expected: { kind: 'done', departure: 'swapped the library' } },
];

describe('taskState', () => {
  it('decides every row of the task state table', () => {
    for (const c of TASK_CASES) {
      if (c.expected === 'impossible') expect(() => taskState(c.task, c.situation), c.name).toThrow();
      else expect(taskState(c.task, c.situation), c.name).toEqual(c.expected);
    }
  });
});

const clockOf = (over: Partial<ClockFacts> = {}): ClockFacts => ({ workSecs: null, limitSecs: 7200, waitSecs: null, unseen: 0, ...over });

describe('situationView', () => {
  const working = facts({ live: true, state: ready('T1'), session: 'this' });

  it('heads a working repository with its task, the work clock against the limit and the unseen count', () => {
    const v = situationView(working, clockOf({ workSecs: 720, unseen: 3 }));
    expect(v).toMatchObject({ tone: 'success', label: 'Working · T1', clock: 'work 0:12:00 of 2:00:00', paused: null, unseen: 3, stopLine: null });
    expect(v.situation).toEqual({ kind: 'working', task: 'T1' });
  });

  it('shows no clock before a run exists', () => {
    expect(situationView(facts({ state: ready('T1'), stage: 'build-ready' }), clockOf()).clock).toBeNull();
  });

  it('says Waiting for you, in the warning tone, with the paused clock, while a question is open', () => {
    const v = situationView(working, clockOf({ workSecs: 720, waitSecs: 75 }));
    expect(v).toMatchObject({ tone: 'warning', label: 'Waiting for you', clock: 'work 0:12:00 of 2:00:00', paused: '1:15 waiting (not counted)' });
  });

  it('names the stop once, as a line that reads after the repository name', () => {
    const driver = situationView(facts({ stop: { task: 'T2', reason: 'Stopped: nobody answered' }, state: ready('T2'), session: 'this' }), clockOf());
    expect(driver).toMatchObject({ tone: 'error', label: 'Stopped at T2', stopLine: 'stopped: nobody answered' });
    const records = situationView(facts({ state: ready('T1'), stage: 'build-stopped', latestExit: 1 }), clockOf());
    expect(records.stopLine).toBe('stopped: the agent failed');
    const unknown = situationView(facts({ state: ready('T1'), stage: 'build-stopped', latestExit: 0 }), clockOf());
    expect(unknown.stopLine).toBe('stopped');
  });

  it('returns a fallback heading, and does not throw, for a combination the table calls impossible', () => {
    for (const c of SITUATION_CASES.filter((c) => c.expected === 'impossible')) {
      const v = situationView(c.facts, clockOf());
      expect(v.situation, c.name).toBeNull();
      expect(v.tone, c.name).toBe('warning');
      expect(v.label, c.name).toBe('Cannot tell where this stands');
      expect(v.stopLine, c.name).toBeNull();
    }
  });
});
