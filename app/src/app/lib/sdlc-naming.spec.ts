import { WORK_TYPES, defaultWorkType, orderedWorkTypes } from './sdlc-naming';

describe('work types', () => {
  it('lists the eleven types in the order the requirement names them (R4.1)', () => {
    expect([...WORK_TYPES]).toEqual(['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']);
  });

  it('defaults to feat for the full pipeline and fix for triage (R4.1)', () => {
    expect(defaultWorkType('full')).toBe('feat');
    expect(defaultWorkType('decide')).toBe('fix');
  });

  it('offers the route default first, then the others in the listed order (R4.1)', () => {
    expect(orderedWorkTypes('full')).toEqual(['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']);
    expect(orderedWorkTypes('decide')).toEqual(['fix', 'feat', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']);
  });
});
