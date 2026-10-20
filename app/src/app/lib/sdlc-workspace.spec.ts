import type { ContextState } from '@bindings/ContextState';
import type { RunLink } from '@bindings/RunLink';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import {
  contextAction, contextLabel, folderName, formatWhen, isSetUp, lastRunTimes, masterPath, productRepos, repoRows, systemOf,
} from './sdlc-workspace';

const scan = (over: Partial<WorkspaceScan> = {}): WorkspaceScan => ({
  folder: '/ws',
  repos: ['claims-intent', 'customer-portal'],
  master: { kind: 'one', repo: 'claims-intent', committed: true },
  marker: { version: 1, systems: { claims: { repos: ['customer-portal', 'billing-api'] } } },
  marker_error: null,
  ...over,
});

describe('sdlc-workspace', () => {
  it('joins the master path with a forward slash and drops a trailing separator', () => {
    expect(masterPath('D:\\Work\\acme\\', 'claims-intent')).toBe('D:\\Work\\acme/claims-intent');
    expect(masterPath('/ws', 'm')).toBe('/ws/m');
  });

  it('names a workspace after its folder', () => {
    expect(folderName('D:\\Work\\acme-claims\\')).toBe('acme-claims');
    expect(folderName('/a/b')).toBe('b');
  });

  it('is set up only with one committed master and a readable marker', () => {
    expect(isSetUp(scan())).toBe(true);
    expect(isSetUp(scan({ master: { kind: 'one', repo: 'm', committed: false } }))).toBe(false);
    expect(isSetUp(scan({ marker: null }))).toBe(false);
    expect(isSetUp(scan({ marker_error: 'bad json' }))).toBe(false);
    expect(isSetUp(scan({ master: { kind: 'many', repos: ['a', 'b'] } }))).toBe(false);
  });

  it('finds the system that lists a repo, and the product repos', () => {
    expect(systemOf(scan(), 'customer-portal')).toBe('claims');
    expect(systemOf(scan(), 'nope')).toBeNull();
    expect(productRepos(scan())).toEqual(['customer-portal']);
  });

  it('lists the master first, then checked-out repos, then repos the marker names but are absent', () => {
    const rows = repoRows(scan(), { 'customer-portal': { kind: 'stale', commits: 3 }, 'billing-api': { kind: 'notCheckedOut' } });
    expect(rows.map((r) => [r.name, r.role])).toEqual([
      ['claims-intent', 'master'],
      ['customer-portal', 'product'],
      ['billing-api', 'not-checked-out'],
    ]);
    expect(rows[0].context).toBeNull();
    expect(rows[1].system).toBe('claims');
  });

  it('words every context state and offers Run context when missing and Refresh context once a file exists', () => {
    expect(contextLabel({ kind: 'fresh' })).toEqual({ text: 'fresh', tone: 'success' });
    expect(contextLabel({ kind: 'stale', commits: 1 }).text).toBe('stale · 1 commit');
    expect(contextLabel({ kind: 'stale', commits: 14 }).text).toBe('stale · 14 commits');
    expect(contextLabel({ kind: 'missing' }).tone).toBe('error');
    expect(contextLabel({ kind: 'notCheckedOut' }).text).toBe('not checked out');
    expect(contextLabel(null).text).toBe('—');
    const states: (ContextState | null)[] = [{ kind: 'fresh' }, { kind: 'stale', commits: 2 }, { kind: 'missing' }, { kind: 'notCheckedOut' }, null];
    expect(states.map(contextAction)).toEqual(['Refresh context', 'Refresh context', 'Run context', null, null]);
  });

  it('keeps the latest run start per change for one workspace', () => {
    const link = (workspace_id: string, change: string, started_at: number): RunLink =>
      ({ workspace_id, system: 'claims', change, stage: 'spec', run_id: 'r', started_at });
    expect(lastRunTimes([link('a', 'c1', 5), link('a', 'c1', 9), link('b', 'c1', 99), link('a', 'c2', 1)], 'a')).toEqual({
      'claims/c1': 9, 'claims/c2': 1,
    });
  });

  it('formats a run time in UTC', () => {
    expect(formatWhen(1792281600)).toBe('2026-10-18 00:00');
  });
});
