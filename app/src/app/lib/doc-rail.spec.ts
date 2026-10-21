import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { RunRecord } from '@bindings/RunRecord';
import { docStatus, recentRuns, runTime, usedBy } from './doc-rail';

const secs = (y: number, mo: number, d: number, h: number, mi: number) => Math.floor(new Date(y, mo, d, h, mi).getTime() / 1000);
const record = (id: string, started_at: number, exit?: number | null): RunRecord => ({ id, kata: 'sdlc-claims-c1-intent', started_at, isolation: 'none', exit });

describe('docStatus', () => {
  it.each([
    ['accepted', 'Accepted', 'success'],
    ['draft', 'Draft', 'warning'],
    ['superseded', 'Superseded', 'error'],
    ['rejected', 'Rejected', 'error'],
    ['unknown', 'Unknown', 'idle'],
    ['in-review', 'In review', 'idle'],
  ] as const)('reads %s as the word %s with a %s dot', (raw, text, tone) => {
    expect(docStatus(raw)).toEqual({ text, tone });
  });

  it('has nothing to say for a missing or blank status', () => {
    expect(docStatus(null)).toBeNull();
    expect(docStatus(undefined)).toBeNull();
    expect(docStatus('  ')).toBeNull();
  });
});

describe('runTime', () => {
  it('writes a start time as month, day and 24-hour time in the local zone', () => {
    expect(runTime(secs(2026, 9, 20, 10, 5))).toBe('Oct 20 10:05');
    expect(runTime(secs(2026, 0, 3, 7, 30))).toBe('Jan 3 07:30');
    expect(runTime(secs(2026, 11, 31, 23, 59))).toBe('Dec 31 23:59');
  });
});

describe('recentRuns', () => {
  const runs = [
    record('r5', secs(2026, 9, 20, 10, 5), 0),
    record('r4', secs(2026, 9, 19, 22, 41), 1),
    record('r3', secs(2026, 9, 19, 18, 12)),
    record('r2', secs(2026, 9, 18, 9, 0), 0),
    record('r1', secs(2026, 9, 17, 9, 0), 0),
  ];

  it('keeps the first three runs it is given, in order, with the total of all of them', () => {
    const got = recentRuns(runs, 'Intent');
    expect(got.total).toBe(5);
    expect(got.rows.map((r) => r.id)).toEqual(['r5', 'r4', 'r3']);
    expect(got.rows[0]).toEqual({ id: 'r5', kind: 'Intent', time: 'Oct 20 10:05', tone: 'success' });
  });

  it('marks a run that exited nonzero as an error and one with no exit recorded as idle', () => {
    const got = recentRuns(runs, 'Spec');
    expect(got.rows.map((r) => r.tone)).toEqual(['success', 'error', 'idle']);
    expect(got.rows.every((r) => r.kind === 'Spec')).toBe(true);
  });

  it('is empty when there are no runs', () => {
    expect(recentRuns([], 'Plan')).toEqual({ rows: [], total: 0 });
  });
});

describe('usedBy', () => {
  const change = (spec: ChangeInfo['spec'], plan: ChangeInfo['plan']) => ({ spec, plan }) as ChangeInfo;
  const doc = (status: string | null): ChangeInfo['spec'] => (status === null ? { exists: false, committed: false, status: null } : { exists: true, committed: true, status });

  it('names spec.md with its status for the intent, and plan.md with its status for the spec', () => {
    const c = change(doc('draft'), doc('accepted'));
    expect(usedBy('intent', c)).toEqual({ name: 'spec.md', status: { text: 'Draft', tone: 'warning' } });
    expect(usedBy('spec', c)).toEqual({ name: 'plan.md', status: { text: 'Accepted', tone: 'success' } });
  });

  it('names nothing for the plan, and nothing for a document that does not exist yet', () => {
    expect(usedBy('plan', change(doc('draft'), doc('accepted')))).toBeNull();
    expect(usedBy('intent', change(doc(null), doc(null)))).toBeNull();
    expect(usedBy('spec', change(doc('draft'), doc(null)))).toBeNull();
  });
});
