import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import { reviewState } from './sdlc-done';

const SCOPE = { workspaceId: 'w1', system: 'commerce', change: 'c1' };
const link = (over: Partial<RunLink> = {}): RunLink => ({
  workspace_id: 'w1', system: 'commerce', change: 'c1', stage: 'review', run_id: 'r1', started_at: 100, heads: { a: '1111111' }, ...over,
});
const record = (id: string, exit: number | null | undefined): RunRecord => ({ id, kata: 'k', started_at: 100, isolation: 'none', steered: false, exit });
const HEADS = { a: '1111111' };

describe('reviewState', () => {
  it('is none when the change has no review link', () => {
    expect(reviewState([], [], HEADS, SCOPE)).toEqual({ kind: 'none' });
    const others = [link({ stage: 'build:a' }), link({ change: 'other' }), link({ workspace_id: 'w2' })];
    expect(reviewState(others, [record('r1', 0)], HEADS, SCOPE)).toEqual({ kind: 'none' });
  });

  it('is unfinished when the review run did not exit 0', () => {
    expect(reviewState([link()], [record('r1', 1)], HEADS, SCOPE)).toEqual({ kind: 'unfinished' });
    expect(reviewState([link()], [record('r1', null)], HEADS, SCOPE)).toEqual({ kind: 'unfinished' });
    expect(reviewState([link()], [], HEADS, SCOPE)).toEqual({ kind: 'unfinished' });
  });

  it('is stale when the heads differ from the heads at review time', () => {
    expect(reviewState([link()], [record('r1', 0)], { a: '2222222' }, SCOPE)).toEqual({ kind: 'stale' });
    expect(reviewState([link({ heads: undefined })], [record('r1', 0)], HEADS, SCOPE)).toEqual({ kind: 'stale' });
  });

  it('is current for the latest review whose heads match', () => {
    const older = link({ run_id: 'r0', started_at: 50, heads: { a: '0000000' } });
    const got = reviewState([link(), older], [record('r1', 0), record('r0', 0)], HEADS, SCOPE);
    expect(got).toEqual({ kind: 'current', link: link() });
  });

  it('judges only the latest review', () => {
    const older = link({ run_id: 'r0', started_at: 50 });
    const newer = link({ run_id: 'r2', started_at: 200 });
    expect(reviewState([older, newer], [record('r0', 0), record('r2', 1)], HEADS, SCOPE)).toEqual({ kind: 'unfinished' });
  });
});

describe('reviewState with a review document', () => {
  const section = { number: 1, reviewed_at: '2026-10-19', commits: { a: '1111111' }, findings: [] };
  const problem = { file: 'build/review.md', line: 14, message: 'finding F1 has no file' };

  it('is current for a document that passes', () => {
    const document = { layout: 2, reviews: [section], problems: [], master_moved: [] };
    expect(reviewState([], [], HEADS, SCOPE, document, 'm')).toMatchObject({ kind: 'current-document' });
  });

  it('a review document with problems is not a current review, so done stays blocked (F6)', () => {
    const document = { layout: 2, reviews: [section], problems: [problem], master_moved: [] };
    expect(reviewState([], [], HEADS, SCOPE, document, 'm')).toEqual({ kind: 'invalid' });
    expect(reviewState([link()], [record('r1', 0)], HEADS, SCOPE, document, 'm')).toEqual({ kind: 'invalid' });
  });
});

describe('reviewState with a review document', () => {
  const doc = (...commits: Record<string, string>[]) => ({
    layout: 2,
    problems: [],
    master_moved: [] as string[],
    reviews: commits.map((c, i) => ({ number: i + 1, reviewed_at: '2026-10-22', commits: c, findings: [] })),
  });
  const FULL = { a: '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', master: '9999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };

  it('reads the latest review commits against the heads and not the run exit code', () => {
    const got = reviewState([link()], [record('r1', 1)], FULL, SCOPE, doc({ a: '0000000' }, { a: '1111111' }), 'master');
    expect(got).toMatchObject({ kind: 'current-document', review: { number: 2 } });
  });

  it('is stale when a reviewed repository moved since the review', () => {
    const got = reviewState([], [], { a: '2222222cccccccccccccccccccccccccccccccc' }, SCOPE, doc({ a: '1111111' }), 'master');
    expect(got).toEqual({ kind: 'stale' });
  });

  it('does not judge the master by its head, since recording the review commits there', () => {
    const got = reviewState([], [], FULL, SCOPE, doc({ a: '1111111', master: '0123456' }), 'master');
    expect(got).toMatchObject({ kind: 'current-document' });
  });

  it('is none when the document holds no review', () => {
    expect(reviewState([link()], [record('r1', 0)], FULL, SCOPE, doc(), 'master')).toEqual({ kind: 'none' });
  });
});

describe('reviewState judges the master repository by what it committed since the review (F17)', () => {
  const FULL = { a: '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', master: '9999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
  const document = (movedInMaster: string[]) => ({
    layout: 2,
    problems: [],
    reviews: [{ number: 1, reviewed_at: '2026-10-22', commits: { a: '1111111', master: '0123456' }, findings: [] }],
    master_moved: movedInMaster,
  });

  it('a master that gained a product commit after the review makes the review stale', () => {
    expect(reviewState([], [], FULL, SCOPE, document(['plugin/tools/ai-sdlc.ts']), 'master')).toEqual({ kind: 'stale' });
  });

  it('a master that gained only the review document commit leaves the review current', () => {
    expect(reviewState([], [], FULL, SCOPE, document([]), 'master')).toMatchObject({ kind: 'current-document' });
  });
});
