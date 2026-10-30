import { TestBed } from '@angular/core/testing';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import { SdlcStagesStore, stageKey } from './sdlc-stages.store';

const doc = { exists: false, committed: false, status: null, head_status: null };
const info = (change: string, stage: ChangeInfo['stage'] = 'plan-ready', system = 'commerce'): ChangeInfo => ({
  system, change, intent: doc, spec: doc, plan: doc, stage, build: { tasks: 0, finished: 0, repos: 0 }, scope: system, out_of_date: null, plan_unreadable: false, plan_unreadable_reason: null, track: 'full', fix_row: null,
});

describe('SdlcStagesStore', () => {
  const store = () => TestBed.inject(SdlcStagesStore);

  it('starts empty and keeps what it is given per workspace', () => {
    const s = store();
    expect(s.rows('a')).toEqual({});
    s.put('a', info('c1'));
    s.put('b', info('c2'));
    expect(Object.keys(s.rows('a'))).toEqual([stageKey('commerce', 'c1')]);
    expect(s.rows('a')[stageKey('commerce', 'c1')]).toEqual({ info: info('c1'), error: null, checking: false });
    expect(Object.keys(s.rows('b'))).toEqual([stageKey('commerce', 'c2')]);
  });

  it('marks every stored row as being checked until its fresh value arrives', () => {
    const s = store();
    s.put('a', info('c1'));
    s.put('a', info('c2'));
    s.markChecking('a');
    expect(Object.values(s.rows('a')).map((r) => r.checking)).toEqual([true, true]);
    s.put('a', info('c1', 'plan-awaiting'));
    expect(s.rows('a')[stageKey('commerce', 'c1')]).toEqual({ info: info('c1', 'plan-awaiting'), error: null, checking: false });
    expect(s.rows('a')[stageKey('commerce', 'c2')].checking).toBe(true);
    s.settle('a');
    expect(Object.values(s.rows('a')).map((r) => r.checking)).toEqual([false, false]);
  });

  it('keeps the error of a change that could not be read in place of its stage', () => {
    const s = store();
    s.put('a', info('c1'));
    s.putError('a', 'commerce', 'c1', 'the folder is gone');
    expect(s.rows('a')[stageKey('commerce', 'c1')]).toEqual({ info: null, error: 'the folder is gone', checking: false });
  });

  it('forgets a workspace that is cleared, and only that one', () => {
    const s = store();
    s.put('a', info('c1'));
    s.put('b', info('c2'));
    s.clear('a');
    expect(s.rows('a')).toEqual({});
    expect(Object.keys(s.rows('b')).length).toBe(1);
  });

  it('is never saved: a new session starts empty', () => {
    store().put('a', info('c1'));
    TestBed.resetTestingModule();
    expect(store().rows('a')).toEqual({});
  });
});
