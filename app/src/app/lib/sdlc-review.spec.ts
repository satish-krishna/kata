import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { Finding } from './sdlc';
import { shownReview } from './sdlc-review';

const found = (id: string, severity: 'high' | 'medium' | 'low', text: string) => ({ id, severity, file: 'src/a.ts', line: 4, text });
const record = (...reviews: ReviewRecord['reviews']): ReviewRecord => ({ layout: 2, reviews, problems: [], master_moved: [] });
const review = (number: number, reviewed_at: string, findings: ReviewRecord['reviews'][number]['findings'], commits: Record<string, string> = { app: '840fa0c' }) => ({ number, reviewed_at, commits, findings });

const WORDS: Finding[] = [
  { severity: null, text: 'T1 done in abc1234' },
  { severity: null, text: 'T2 done in def5678' },
];

describe('shownReview', () => {
  it('shows the latest review of the document and ignores the run words (document present, findings, words present)', () => {
    const got = shownReview(record(review(1, '2026-10-22', [found('F1', 'high', 'The limit is not enforced on retry.'), found('F2', 'low', 'A typo.')])), WORDS);
    expect(got).toEqual({
      kind: 'document',
      latest: {
        number: 1,
        reviewedAt: '2026-10-22',
        repos: ['app'],
        findings: [
          { id: 'F1', severity: 'high', file: 'src/a.ts', line: 4, text: 'The limit is not enforced on retry.' },
          { id: 'F2', severity: 'low', file: 'src/a.ts', line: 4, text: 'A typo.' },
        ],
      },
      earlier: [],
    });
  });

  it('shows reviewed with nothing found when the latest review has no findings (document present, none found)', () => {
    const got = shownReview(record(review(1, '2026-10-22', [])), null);
    expect(got).toEqual({ kind: 'document', latest: { number: 1, reviewedAt: '2026-10-22', repos: ['app'], findings: [] }, earlier: [] });
  });

  it('shows the latest review with the earlier ones available, newest first', () => {
    const got = shownReview(
      record(
        review(1, '2026-10-22', [found('F1', 'high', 'one')]),
        review(2, '2026-10-23', [found('F1', 'medium', 'two')]),
        review(3, '2026-10-24', []),
      ),
      WORDS,
    );
    expect(got.kind).toBe('document');
    if (got.kind !== 'document') return;
    expect(got.latest).toMatchObject({ number: 3, findings: [] });
    expect(got.earlier.map((r) => [r.number, r.findings.map((f) => f.text)])).toEqual([
      [2, ['two']],
      [1, ['one']],
    ]);
  });

  it('reads the run words as the older layout when there is no document (document absent, words present)', () => {
    expect(shownReview(null, WORDS)).toEqual({ kind: 'words', findings: WORDS });
  });

  it('says there is no review yet (document absent, words absent)', () => {
    expect(shownReview(null, null)).toEqual({ kind: 'none' });
  });
});

describe('shownReview: repositories and finding fields (R8.1, R8.2)', () => {
  it('lists the repositories of the section in the order the document records them', () => {
    const got = shownReview(record(review(1, '2026-10-22', [], { web: 'aaaaaaa', api: 'bbbbbbb' })), null);
    expect(got.kind === 'document' && got.latest.repos).toEqual(['web', 'api']);
  });

  it('copies the repository, concern and rule of a finding from the document', () => {
    const f = { id: 'F1', severity: 'high' as const, file: 'src/a.ts', line: 4, text: 'Breaks the rule.', repo: 'web', concern: 'convention' as const, rule: 'CONTRIBUTING.md:18' };
    const got = shownReview(record(review(1, '2026-10-22', [f])), null);
    expect(got.kind === 'document' && got.latest.findings).toEqual([f]);
  });
});
