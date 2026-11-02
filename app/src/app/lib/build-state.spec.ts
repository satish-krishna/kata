import { hms, ms, situationView, type ClockFacts, type Situation } from './build-state';

const clockOf = (over: Partial<ClockFacts> = {}): ClockFacts => ({ workSecs: null, limitSecs: 7200, waitSecs: null, unseen: 0, ...over });
const working: Situation = { kind: 'working', task: 'T1' };

describe('situationView', () => {
  it('heads a working repository with its task, the work clock against the limit and the unseen count', () => {
    const v = situationView(working, clockOf({ workSecs: 720, unseen: 3 }));
    expect(v).toMatchObject({ tone: 'success', label: 'Working · T1', clock: 'work 0:12:00 of 2:00:00', paused: null, unseen: 3, stopLine: null });
    expect(v.situation).toEqual(working);
  });

  it('shows no clock before a run exists', () => {
    expect(situationView({ kind: 'not-started', task: 'T1' }, clockOf()).clock).toBeNull();
  });

  it('says Waiting for you, in the warning tone, with the paused clock, while a question is open', () => {
    const v = situationView(working, clockOf({ workSecs: 720, waitSecs: 75 }));
    expect(v).toMatchObject({ tone: 'warning', label: 'Waiting for you', clock: 'work 0:12:00 of 2:00:00', paused: '1:15 waiting (not counted)' });
  });

  it('names the stop once, as a line that reads after the repository name', () => {
    const stopped = situationView({ kind: 'stopped', task: 'T2', reason: 'Stopped: nobody answered' }, clockOf());
    expect(stopped).toMatchObject({ tone: 'error', label: 'Stopped at T2', stopLine: 'stopped: nobody answered' });
    expect(situationView({ kind: 'stopped', task: 'T1', reason: null }, clockOf()).stopLine).toBe('stopped');
  });

  it('words every other situation', () => {
    expect(situationView({ kind: 'waiting', task: 'T2', onTask: 'T1', onRepo: 'api' }, clockOf())).toMatchObject({ tone: 'idle', label: 'Waiting for T1 in api' });
    expect(situationView({ kind: 'finished' }, clockOf())).toMatchObject({ tone: 'success', label: 'Finished' });
    expect(situationView({ kind: 'idle' }, clockOf())).toMatchObject({ tone: 'idle', label: 'Idle' });
  });
});

describe('the clocks', () => {
  it('writes seconds as h:mm:ss and m:ss', () => {
    expect(hms(3725)).toBe('1:02:05');
    expect(hms(-4)).toBe('0:00:00');
    expect(ms(75)).toBe('1:15');
  });
});
