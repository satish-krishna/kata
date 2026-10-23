import type { BuildStatus } from '@bindings/BuildStatus';
import type { BuildPhase } from '../sdlc/build/build-driver';
import type { Situation } from './build-state';
import {
  buildActions,
  buildStage,
  repoAction,
  shownAreas,
  taskGroups,
  type BuildStage,
  type StageFacts,
} from './build-stage';

type Ready = StageFacts['stage'];

describe('build-stage', () => {
  it('buildStage decides every row of the stage table', () => {
    const facts = (done: boolean, phase: BuildPhase | 'none', anyStopped: boolean, stage: Ready): StageFacts => ({ done, phase, anyStopped, stage });
    const rows: Array<[StageFacts, BuildStage]> = [
      [facts(true, 'none', false, 'build-finished'), 'done'],
      [facts(true, 'none', true, 'build-finished'), 'done'],
      [facts(false, 'building', false, 'build-ready'), 'running'],
      [facts(false, 'building', false, 'build-finished'), 'running'],
      [facts(false, 'building', true, 'build-ready'), 'running-one-stopped'],
      [facts(false, 'building', true, 'build-stopped'), 'running-one-stopped'],
      [facts(false, 'reviewing', false, 'build-finished'), 'reviewing'],
      [facts(false, 'reviewing', true, 'build-ready'), 'reviewing'],
      [facts(false, 'stopped', false, 'build-stopped'), 'stopped'],
      [facts(false, 'stopped', true, 'build-ready'), 'stopped'],
      [facts(false, 'cancelled', false, 'build-ready'), 'cancelled'],
      [facts(false, 'cancelled', true, 'build-stopped'), 'cancelled'],
      [facts(false, 'finished', false, 'build-finished'), 'review-finished'],
      [facts(false, 'finished', true, 'build-ready'), 'review-finished'],
      [facts(false, 'none', false, 'build-ready'), 'not-started'],
      [facts(false, 'none', true, 'build-ready'), 'not-started'],
      [facts(false, 'none', false, 'build-stopped'), 'stopped'],
      [facts(false, 'none', true, 'build-stopped'), 'stopped'],
      [facts(false, 'none', false, 'build-finished'), 'review-finished'],
      [facts(false, 'none', true, 'build-finished'), 'review-finished'],
    ];
    for (const [f, expected] of rows) expect(buildStage(f), JSON.stringify(f)).toBe(expected);
    // impossible rows
    expect(() => buildStage(facts(true, 'none', false, 'build-ready'))).toThrow();
    expect(() => buildStage(facts(true, 'none', true, 'build-stopped'))).toThrow();
    for (const phase of ['building', 'reviewing', 'stopped', 'finished', 'cancelled'] as const) {
      expect(() => buildStage(facts(true, phase, false, 'build-finished')), phase).toThrow();
    }
  });

  it('buildActions gives each stage its actions', () => {
    expect(buildActions('not-started')).toEqual(['start-build', 'reopen-intent']);
    expect(buildActions('running')).toEqual(['cancel-build']);
    expect(buildActions('running-one-stopped')).toEqual(['cancel-build']);
    expect(buildActions('reviewing')).toEqual(['cancel-build']);
    expect(buildActions('stopped')).toEqual(['continue-build', 'another-round']);
    expect(buildActions('cancelled')).toEqual(['continue-build', 'another-round']);
    expect(buildActions('review-finished')).toEqual(['declare-done', 'another-round', 'run-review']);
    expect(buildActions('done')).toEqual([]);
  });

  it('repoAction decides every row of the repository action table', () => {
    const none = { live: false, stopped: false };
    const rows: Array<[Situation, 'cancel' | 'continue' | null]> = [
      [{ kind: 'working', task: 'T1' }, 'cancel'],
      [{ kind: 'stopped', task: 'T1', reason: null, from: 'driver' }, 'continue'],
      [{ kind: 'stopped', task: 'T1', reason: null, from: 'records' }, null],
      [{ kind: 'waiting', task: 'T2', onTask: 'T1', onRepo: 'a' }, null],
      [{ kind: 'not-started', task: 'T1' }, null],
      [{ kind: 'finished' }, null],
      [{ kind: 'idle' }, null],
    ];
    for (const [s, expected] of rows) expect(repoAction(s, 'api', none), s.kind).toBe(expected);
    expect(repoAction({ kind: 'idle' }, 'review', { live: true, stopped: false })).toBe('cancel');
    expect(repoAction({ kind: 'idle' }, 'review', { live: false, stopped: true })).toBe('continue');
    expect(repoAction({ kind: 'idle' }, 'review', none)).toBeNull();
  });

  it('shownAreas decides every row of the area table', () => {
    const area = (stage: BuildStage, hasSessions: boolean, hasChanges: boolean) => shownAreas({ stage, hasSessions, hasChanges });
    expect(area('not-started', false, false)).toEqual({ activity: false, files: false });
    expect(area('not-started', false, true)).toEqual({ activity: false, files: true });
    expect(area('not-started', true, false)).toEqual({ activity: true, files: false });
    expect(area('not-started', true, true)).toEqual({ activity: true, files: true });
    const others: BuildStage[] = ['running', 'running-one-stopped', 'stopped', 'cancelled', 'reviewing', 'review-finished', 'done'];
    for (const stage of others) {
      for (const hasSessions of [false, true]) {
        expect(area(stage, hasSessions, false), stage).toEqual({ activity: true, files: false });
        expect(area(stage, hasSessions, true), stage).toEqual({ activity: true, files: true });
      }
    }
  });

  it('taskGroups lists the plan repositories in order and the master last', () => {
    const repo = (name: string) => ({ repo: name, firstUnfinished: null, state: { kind: 'done' }, tasks: 1, finished: 1 }) as BuildStatus['repos'][number];
    const task = (id: string, r: string) => ({ id, name: id, repo: r, dependsOn: [], text: '', row: null }) as BuildStatus['tasks'][number];
    const status = (repos: string[], tasks: Array<[string, string]>): BuildStatus =>
      ({ tasks: tasks.map(([i, r]) => task(i, r)), repos: repos.map(repo), departures: [], hasTasks: true, problems: [], logLayouts: [] }) as BuildStatus;

    const s = status(['intent', 'api', 'web'], [['T1', 'api'], ['T2', 'web']]);
    expect(taskGroups(s, 'intent', false)).toEqual(['api', 'web']);
    expect(taskGroups(s, 'intent', true)).toEqual(['api', 'web', 'intent']);
    const named = status(['intent', 'api', 'web'], [['T1', 'intent'], ['T2', 'web']]);
    expect(taskGroups(named, 'intent', false)).toEqual(['api', 'web', 'intent']);
    expect(taskGroups(status(['api'], [['T1', 'api']]), 'intent', true)).toEqual(['api', 'intent']);
  });
});
