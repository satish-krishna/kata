import { TestBed } from '@angular/core/testing';
import type { CheckResult } from '@bindings/CheckResult';
import type { RepoChecks } from '@bindings/RepoChecks';
import { render } from '../../testing/render';
import type { DoneReport } from '../lib/sdlc-done';
import { DoneDialog } from './done-dialog';

const CHANGE = '2026-10-19-build-demo';
const passed: CheckResult = { name: 'cargo test', argv: ['cargo', 'test'], outcome: { kind: 'Passed' }, tail: 'ok' };
const checks = (repo: string, ...results: CheckResult[]): RepoChecks => ({ repo, results, none: results.length === 0 });
const SPEC = { repo: 'claims-core', name: 'cargo test', argv: ['cargo', 'test'], timeout_secs: 600 };

const report = (over: Partial<DoneReport> = {}): DoneReport => ({
  account: 'demo-user',
  notReady: null,
  repos: [
    { repo: 'claims-core', base: 'main', checks: [SPEC], result: checks('claims-core', passed) },
    { repo: 'customer-portal', base: 'main', checks: [], result: checks('customer-portal') },
  ],
  offenders: [],
  departures: [],
  review: { at: Date.UTC(2026, 9, 19, 9, 30, 0), findings: [] },
  checksPath: '/home/demo/.kata/checks/claims.toml',
  checksError: null,
  ...over,
});

const dialog = () => document.body.querySelector('[role="dialog"]')!;
const text = () => dialog().textContent!.replace(/\s+/g, ' ');
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label) as HTMLButtonElement | undefined;
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};
const open = async (r: DoneReport = report()) => {
  const out = await render(DoneDialog, { report: r, change: CHANGE });
  await settle();
  return out;
};

describe('DoneDialog', () => {
  it('renders nothing without a report', async () => {
    await render(DoneDialog, { report: null, change: CHANGE });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('says who is signed in and that every origin is a GitHub repository', async () => {
    await open();
    expect(text()).toContain('Signed in to github.com as demo-user · every origin is a GitHub repository');
  });

  it('lists each repository with its branch and the checks as they will run, and where they are set (R16.3)', async () => {
    await open();
    const rows = Array.from(dialog().querySelectorAll('tbody tr')).map((r) => r.textContent!.replace(/\s+/g, ' '));
    expect(rows[0]).toContain('claims-core');
    expect(rows[0]).toContain(`change/${CHANGE} → main`);
    expect(rows[0]).toContain('cargo test');
    expect(rows[0]).toContain('passed');
    expect(text()).toContain('Checks from /home/demo/.kata/checks/claims.toml');
  });

  it('no checks counts as passing and says so (R11.3)', async () => {
    await open();
    const rows = Array.from(dialog().querySelectorAll('tbody tr')).map((r) => r.textContent!.replace(/\s+/g, ' '));
    expect(rows[1]).toContain('customer-portal');
    expect(rows[1]).toContain('no checks');
    expect(button('Open pull requests')!.disabled).toBe(false);
  });

  it('a failed check blocks confirm and shows its last lines (R11.2)', async () => {
    const failed: CheckResult = { name: 'cargo test', argv: ['cargo', 'test'], outcome: { kind: 'Failed', exit: 101 }, tail: 'assertion failed: left == right' };
    await open(report({ repos: [{ repo: 'claims-core', base: 'main', checks: [SPEC], result: checks('claims-core', failed) }] }));
    expect(text()).toContain('claims-core · cargo test · last 50 lines');
    expect(text()).toContain('assertion failed: left == right');
    expect(text()).toContain('cargo test · exit 101');
    expect(dialog().querySelector('tbody .k-status--error')).not.toBeNull();
    expect(button('Open pull requests')!.disabled).toBe(true);
    expect(button('Another round')).toBeTruthy();
  });

  it('could not run is amber and says fix the machine (R11.6)', async () => {
    const lost: CheckResult = { name: 'cargo test', argv: ['cargo', 'test'], outcome: { kind: 'CouldNotRun', reason: 'cargo is not on this machine' }, tail: '' };
    await open(report({ repos: [{ repo: 'claims-core', base: 'main', checks: [SPEC], result: checks('claims-core', lost) }] }));
    expect(text()).toContain('cargo is not on this machine');
    expect(text()).toContain('Fix the environment, not the code.');
    expect(dialog().querySelector('tbody .k-status--warning')).not.toBeNull();
    expect(dialog().querySelector('tbody .k-status--error')).toBeNull();
    expect(button('Open pull requests')!.disabled).toBe(true);
  });

  it('an offending commit blocks confirm and offers another round (R11.5)', async () => {
    const { fixture } = await open(report({ offenders: [{ repo: 'claims-core', hash: 'abc1234def', subject: 'fix stuff' }] }));
    expect(text()).toContain('Commits that break the commit rules');
    expect(text()).toContain('claims-core');
    expect(text()).toContain('abc1234');
    expect(text()).toContain('fix stuff');
    expect(button('Open pull requests')!.disabled).toBe(true);
    let rounds = 0;
    fixture.componentInstance.anotherRound.subscribe(() => rounds++);
    button('Another round')!.click();
    expect(rounds).toBe(1);
  });

  it.each([
    ['Not signed in to github.com. Run gh auth login, then declare done again.'],
    ['app has no GitHub remote'],
    ['GitHub could not be reached. Try again later.'],
  ])('not ready blocks confirm with the reason (R12.1): %s', async (reason) => {
    await open(report({ account: null, notReady: reason, repos: [{ repo: 'claims-core', base: 'main', checks: [SPEC], result: null }] }));
    expect(text()).toContain(reason);
    expect(dialog().querySelector('.k-status--error')).not.toBeNull();
    expect(button('Open pull requests')!.disabled).toBe(true);
  });

  it("done dialog lists departures with the plan's text before confirm (R9.2)", async () => {
    await open(report({ departures: [{ task: 'T2', repo: 'customer-portal', planText: 'Add the photo picker to the report form', departure: 'Reused the existing file picker.' }] }));
    expect(text()).toContain('Departures from the plan');
    expect(text()).toContain('T2');
    expect(text()).toContain('Add the photo picker to the report form');
    expect(text()).toContain('Reused the existing file picker.');
  });

  it('a bad checks file blocks done and says where (R16.2)', async () => {
    await open(report({
      checksError: '/home/demo/.kata/checks/claims.toml:4:1: a check has no time limit',
      repos: [{ repo: 'claims-core', base: 'main', checks: [], result: null }],
    }));
    expect(text()).toContain('/home/demo/.kata/checks/claims.toml:4:1: a check has no time limit');
    expect(button('Open pull requests')!.disabled).toBe(true);
  });

  it('done dialog shows the findings most serious first before confirm (R20.1)', async () => {
    await open(report({ review: { at: Date.UTC(2026, 9, 19, 9, 30, 0), findings: [{ severity: 'high', text: 'Limit not enforced on retry' }, { severity: 'low', text: 'Message has no test' }] } }));
    const items = Array.from(dialog().querySelectorAll('.k-findings__text')).map((e) => e.textContent!.trim());
    expect(items).toEqual(['Limit not enforced on retry', 'Message has no test']);
    expect(text()).toContain('Reviewed at');
  });

  it('open findings do not block Open pull requests (R20.2)', async () => {
    const { fixture } = await open(report({ review: { at: 1, findings: [{ severity: 'high', text: 'a' }, { severity: 'low', text: 'b' }] } }));
    const confirm = button('Open pull requests')!;
    expect(confirm.disabled).toBe(false);
    expect(button('Another round')).toBeTruthy();
    let confirmed = 0;
    fixture.componentInstance.confirm.subscribe(() => confirmed++);
    confirm.click();
    expect(confirmed).toBe(1);
  });

  it('offers no Another round when nothing blocks and nothing was found', async () => {
    await open();
    expect(button('Another round')).toBeUndefined();
    expect(button('Run review')).toBeUndefined();
  });

  it.each([
    ['none', 'The change has not been reviewed.'],
    ['unfinished', 'The review did not finish.'],
    ['stale', 'The work changed since it was reviewed.'],
  ] as const)('done needs a finished review of the current heads (R20.3): %s', async (missing, words) => {
    const { fixture } = await open(report({ review: { missing } }));
    expect(text()).toContain(words);
    expect(button('Open pull requests')!.disabled).toBe(true);
    let reviews = 0;
    fixture.componentInstance.runReview.subscribe(() => reviews++);
    button('Run review')!.click();
    expect(reviews).toBe(1);
  });

  it('emits cancel from Cancel', async () => {
    const { fixture } = await open();
    let cancelled = 0;
    fixture.componentInstance.cancel.subscribe(() => cancelled++);
    button('Cancel')!.click();
    expect(cancelled).toBe(1);
  });
});
