import { TestBed } from '@angular/core/testing';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import { render } from '../../testing/render';
import type { DoneReport } from '../lib/sdlc-done';
import { DoneDialog } from './done-dialog';

const CHANGE = '2026-10-19-build-demo';
const passed: RepoCheckView = { repo: 'commerce-core', view: { kind: 'passed', hooks: [{ id: 'unit', outcome: 'passed' }] }, summary: 'The checks passed.' };

const report = (over: Partial<DoneReport> = {}): DoneReport => ({
  account: 'demo-user',
  notReady: null,
  repos: [
    { repo: 'commerce-core', base: 'main', view: passed },
    { repo: 'customer-portal', base: 'main', view: { repo: 'customer-portal', view: { kind: 'noChecks' }, summary: 'This repository has no checks.' } },
  ],
  branch: null,
  offenders: [],
  departures: [],
  review: { at: Date.UTC(2026, 9, 19, 9, 30, 0), findings: [] },
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
  it('holds Open pull requests on a high-severity finding until the engineer acknowledges it (R20.4)', async () => {
    const findings = [
      { severity: 'high' as const, text: 'The change cannot do what it was built for.' },
      { severity: 'low' as const, text: 'A comment is out of date.' },
    ];
    await open(report({ review: { at: Date.UTC(2026, 9, 19, 9, 30, 0), findings } }));
    expect(button('Open pull requests')!.disabled).toBe(true);
    expect(text()).toContain('1 high-severity finding is unresolved.');
    expect(button('Another round')).toBeDefined();
    const box = dialog().querySelector<HTMLElement>('[role="checkbox"]')!;
    expect(box.closest('label')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('Open the pull requests with it unresolved');
    box.click();
    await settle();
    expect(button('Open pull requests')!.disabled).toBe(false);
  });

  it("no tick box for a high finding: whether it is refused is the plugin's answer (R7.2)", async () => {
    await open(report({ review: { at: Date.UTC(2026, 9, 19, 9, 30, 0), findings: [{ severity: 'high', text: 'The change cannot do what it was built for.' }] } }));
    expect(dialog().querySelector('[role="checkbox"]')).toBeNull();
    expect(text()).not.toContain('unresolved');
    expect(button('Open pull requests')!.disabled).toBe(false);
  });

  it('asks for no acknowledgement when no finding is high', async () => {
    await open(report({ review: { at: Date.UTC(2026, 9, 19, 9, 30, 0), findings: [{ severity: 'medium', text: 'x' }] } }));
    expect(dialog().querySelector('[role="checkbox"]')).toBeNull();
    expect(button('Open pull requests')!.disabled).toBe(false);
  });

  it('renders nothing without a report', async () => {
    await render(DoneDialog, { report: null, change: CHANGE });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('says who is signed in and that every origin is a GitHub repository', async () => {
    await open();
    expect(text()).toContain('Signed in to github.com as demo-user · every origin is a GitHub repository');
  });

  it("lists each repository with its branch, and shows the checks the plugin recorded for each", async () => {
    await open();
    const rows = Array.from(dialog().querySelectorAll('tbody tr')).map((r) => r.textContent!.replace(/s+/g, ' '));
    expect(rows[0]).toContain('commerce-core');
    expect(rows[0]).toContain(`change/${CHANGE} → main`);
    expect(text()).toContain('commerce-core · checks');
    expect(text()).toContain('The checks passed.');
    expect(text()).toContain('This repository has no checks.');
    expect(button('Open pull requests')!.disabled).toBe(false);
  });

  it("a failed check is shown with its output, in the plugin's words, and does not hold the dialog: the event runs the stale ones and refuses with the check", async () => {
    const failed: RepoCheckView = { repo: 'commerce-core', view: { kind: 'failedStop', id: 'unit', output: 'assertion failed: left == right' }, summary: 'unit failed. The build stopped here.' };
    await open(report({ repos: [{ repo: 'commerce-core', base: 'main', view: failed }] }));
    expect(text()).toContain('unit failed. The build stopped here.');
    expect(dialog().querySelector('pre')!.textContent).toBe('assertion failed: left == right');
    expect(dialog().querySelector('.k-check .k-status--error')).not.toBeNull();
    expect(button('Open pull requests')!.disabled).toBe(false);
  });

  it('an offending commit blocks confirm and offers another round (R11.5)', async () => {
    const { fixture } = await open(report({ offenders: [{ repo: 'commerce-core', hash: 'abc1234def', subject: 'fix stuff' }] }));
    expect(text()).toContain('Commits that break the commit rules');
    expect(text()).toContain('commerce-core');
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
    await open(report({ account: null, notReady: reason, repos: [{ repo: 'commerce-core', base: 'main', view: null }] }));
    expect(text()).toContain(reason);
    expect(dialog().querySelector('.k-status--error')).not.toBeNull();
    expect(button('Open pull requests')!.disabled).toBe(true);
  });

  it("done dialog lists departures with the plan's text before confirm (R9.2)", async () => {
    await open(report({ departures: [{ task: 'T2', repo: 'customer-portal', planText: 'Add the photo picker to the product form', departure: 'Reused the existing file picker.' }] }));
    expect(text()).toContain('Departures from the plan');
    expect(text()).toContain('T2');
    expect(text()).toContain('Add the photo picker to the product form');
    expect(text()).toContain('Reused the existing file picker.');
  });

  it('renders the departures and the findings as markdown', async () => {
    await open(report({
      departures: [{ task: 'T2', repo: 'customer-portal', planText: 'Add `PhotoPicker`', departure: 'Reused **the existing** picker.' }],
      review: { at: 1, findings: [{ severity: 'low', text: 'Rename `x` to `count`.' }] },
    }));
    expect(Array.from(dialog().querySelectorAll('code')).map((c) => c.textContent)).toEqual(['PhotoPicker', 'x', 'count']);
    expect(dialog().querySelector('strong')!.textContent).toBe('the existing');
    expect(text()).not.toContain('`');
  });

  it('done dialog shows the findings most serious first before confirm (R20.1)', async () => {
    await open(report({ review: { at: Date.UTC(2026, 9, 19, 9, 30, 0), findings: [{ severity: 'high', text: 'Limit not enforced on retry' }, { severity: 'low', text: 'Message has no test' }] } }));
    const items = Array.from(dialog().querySelectorAll('.k-findings__text')).map((e) => e.textContent!.trim());
    expect(items).toEqual(['Limit not enforced on retry', 'Message has no test']);
    expect(text()).toContain('Reviewed at');
  });

  it('open medium and low findings do not block Open pull requests (R20.2)', async () => {
    const { fixture } = await open(report({ review: { at: 1, findings: [{ severity: 'medium', text: 'a' }, { severity: 'low', text: 'b' }] } }));
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

describe('DoneDialog, the branch', () => {
  it('shows the resolved branch, not change/<change>', async () => {
    await open(report({ branch: 'feat/PROJ-123-reset' }));
    const rows = Array.from(dialog().querySelectorAll('tbody tr')).map((r) => r.textContent!.replace(/\s+/g, ' '));
    expect(rows[0]).toContain('feat/PROJ-123-reset → main');
    expect(rows[0]).not.toContain(`change/${CHANGE}`);
  });
});
