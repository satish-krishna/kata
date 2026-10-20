import type { CheckResult } from '@bindings/CheckResult';
import type { RepoChecks } from '@bindings/RepoChecks';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import { canConfirm, checkLabel, checkTone, reviewState, type DoneReport } from './sdlc-done';

const SCOPE = { workspaceId: 'w1', system: 'claims', change: 'c1' };
const link = (over: Partial<RunLink> = {}): RunLink => ({
  workspace_id: 'w1', system: 'claims', change: 'c1', stage: 'review', run_id: 'r1', started_at: 100, heads: { a: '1111111' }, ...over,
});
const record = (id: string, exit: number | null | undefined): RunRecord => ({ id, kata: 'k', started_at: 100, isolation: 'none', exit });
const HEADS = { a: '1111111' };

const result = (kind: 'Passed' | 'Failed' | 'CouldNotRun'): CheckResult => ({
  name: 'cargo test', argv: ['cargo', 'test'], tail: '',
  outcome: kind === 'Passed' ? { kind } : kind === 'Failed' ? { kind, exit: 1 } : { kind, reason: 'timed out' },
});
const checks = (...results: CheckResult[]): RepoChecks => ({ repo: 'a', results, none: results.length === 0 });

const report = (over: Partial<DoneReport> = {}): DoneReport => ({
  account: 'demo-user', notReady: null,
  repos: [{ repo: 'a', base: 'main', checks: [], result: checks(result('Passed')) }],
  offenders: [], departures: [], review: { at: 1, findings: [] }, checksPath: '/k/claims.toml', checksError: null, ...over,
});

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

describe('checkLabel', () => {
  it('names each outcome', () => {
    expect(checkLabel(checks(result('Passed')))).toBe('passed');
    expect(checkLabel(checks(result('Passed'), result('Failed')))).toBe('failed');
    expect(checkLabel(checks(result('CouldNotRun')))).toBe('could not run');
    expect(checkLabel(checks())).toBe('no checks');
    expect(checkLabel(null)).toBe('not run');
  });

  it('colors them with the andon set', () => {
    expect(checkTone('passed')).toBe('success');
    expect(checkTone('failed')).toBe('error');
    expect(checkTone('could not run')).toBe('warning');
    expect(checkTone('no checks')).toBe('idle');
  });
});

describe('canConfirm', () => {
  it('holds when everything passed, open findings included', () => {
    expect(canConfirm(report())).toBe(true);
    expect(canConfirm(report({ review: { at: 1, findings: [{ severity: 'high', text: 'x' }, { severity: null, text: 'y' }] } }))).toBe(true);
  });

  it('treats no checks as passing', () => {
    expect(canConfirm(report({ repos: [{ repo: 'a', base: 'main', checks: [], result: checks() }] }))).toBe(true);
  });

  it.each([
    ['not ready', { notReady: 'Not signed in' }],
    ['a checks error', { checksError: 'bad file' }],
    ['an offender', { offenders: [{ repo: 'a', hash: 'abc1234', subject: 's' }] }],
    ['no review', { review: { missing: 'none' } }],
    ['an unfinished review', { review: { missing: 'unfinished' } }],
    ['a stale review', { review: { missing: 'stale' } }],
    ['a repository without a result', { repos: [{ repo: 'a', base: 'main', checks: [], result: null }] }],
    ['a failed check', { repos: [{ repo: 'a', base: 'main', checks: [], result: checks(result('Failed')) }] }],
    ['a check that could not run', { repos: [{ repo: 'a', base: 'main', checks: [], result: checks(result('CouldNotRun')) }] }],
  ] as [string, Partial<DoneReport>][])('is blocked by %s', (_name, over) => {
    expect(canConfirm(report(over))).toBe(false);
  });
});
