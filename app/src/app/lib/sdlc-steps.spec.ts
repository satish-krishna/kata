import { describe, expect, it } from 'vitest';
import type { ChangeKey } from '@bindings/ChangeKey';
import { sameStepChange } from './sdlc-steps';

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
