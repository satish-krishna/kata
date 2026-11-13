import { describe, expect, it } from 'vitest';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { StepKind } from '@bindings/StepKind';
import { CHANGE_STEPS, HOME_STEPS, isStep, sameStepChange, stepOf, stepRef, stopWords, type ChangeStep } from './sdlc-steps';

const KEY: ChangeKey = { workspace: { key: 'd:/ws', name: 'ws' }, system: 'commerce', change: '2026-01-01-a' };

describe('sameStepChange', () => {
  it('is true for the same system and change', () => {
    expect(sameStepChange(KEY, { system: 'commerce', change: '2026-01-01-a' })).toBe(true);
  });

  it('is false for the same change name in another system', () => {
    expect(sameStepChange(KEY, { system: 'other', change: '2026-01-01-a' })).toBe(false);
  });

  it('is false for another change in the same system', () => {
    expect(sameStepChange(KEY, { system: 'commerce', change: '2026-01-01-b' })).toBe(false);
  });
});

describe('the step the page picks', () => {
  const key = (change: string, system = 'commerce'): ChangeKey => ({ workspace: { key: 'w', name: 'w' }, system, change });
  const step = (change: string, kind: StepKind, system = 'commerce'): ChangeStep => ({ change: key(change, system), kind, label: `${change} is running` });

  it('picks the step of the change, of a wanted kind, and no other', () => {
    const running = [step('a', 'preparingBuild'), step('b', { accepting: 'spec' }), step('b', 'preparingReview', 'other')];
    expect(stepOf(running, { system: 'commerce', change: 'a' }, ['preparing'])?.label).toBe('a is running');
    expect(stepOf(running, { system: 'commerce', change: 'a' }, CHANGE_STEPS)).toBeNull();
    expect(stepOf(running, { system: 'commerce', change: 'b' }, CHANGE_STEPS)?.kind).toEqual({ accepting: 'spec' });
    expect(stepOf(running, { system: 'commerce', change: 'b' }, HOME_STEPS)).toBeNull();
    expect(stepOf(running, { system: 'commerce', change: 'c' }, ['preparing'])).toBeNull();
  });

  it('a preparation of a build or of a review is a preparing step', () => {
    expect(isStep('preparingBuild', 'preparing')).toBe(true);
    expect(isStep('preparingReview', 'preparing')).toBe(true);
    expect(isStep('starting', 'preparing')).toBe(false);
  });

  it.each<[StepKind, string]>([
    ['preparingBuild', 'Stop preparing the build'],
    ['preparingReview', 'Stop preparing the build'],
    ['starting', 'Stop starting the change'],
    ['renaming', 'Stop renaming the branch'],
    ['removingCopy', 'Stop removing the copy'],
    [{ accepting: 'plan' }, 'Stop accepting the plan'],
    [{ rejecting: 'intent' }, 'Stop rejecting the intent'],
    ['rejectingFix', 'Stop rejecting the fix'],
    ['declaringDone', 'Stop declaring the change done'],
  ])('Stop for %j says %s', (kind, words) => {
    expect(stopWords(kind)).toBe(words);
  });

  it('Stop is sent for the change of the step itself, in the workspace folder the page holds', () => {
    expect(stepRef(step('a', 'starting'), 'D:/ws')).toEqual({ workspace: 'D:/ws', system: 'commerce', change: 'a' });
  });
});
