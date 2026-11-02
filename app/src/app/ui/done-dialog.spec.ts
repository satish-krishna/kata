import { TestBed } from '@angular/core/testing';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import { render } from '../../testing/render';
import type { DoneReport } from '../lib/sdlc-done';
import { DoneDialog } from './done-dialog';

const CHANGE = '2026-10-19-build-demo';
const passed: RepoCheckView = { repo: 'commerce-core', view: { kind: 'passed', hooks: [{ id: 'unit', outcome: 'passed' }] }, summary: 'The checks passed.' };

const report = (over: Partial<DoneReport> = {}): DoneReport => ({
  repos: [
    { repo: 'commerce-core', base: 'main', view: passed },
    { repo: 'customer-portal', base: 'main', view: { repo: 'customer-portal', view: { kind: 'noChecks' }, summary: 'This repository has no checks.' } },
  ],
  branch: null,
  departures: [],
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
  it("no tick box, and nothing about findings, for the plugin to answer (R7.2)", async () => {
    await open();
    expect(dialog().querySelector('[role="checkbox"]')).toBeNull();
    expect(text()).not.toContain('unresolved');
    expect(button('Open pull requests')!.disabled).toBe(false);
  });

  it('renders nothing without a report', async () => {
    await render(DoneDialog, { report: null, change: CHANGE });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
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

  it("done dialog lists departures with the plan's text before confirm (R9.2)", async () => {
    await open(report({ departures: [{ task: 'T2', repo: 'customer-portal', planText: 'Add the photo picker to the product form', departure: 'Reused the existing file picker.' }] }));
    expect(text()).toContain('Departures from the plan');
    expect(text()).toContain('T2');
    expect(text()).toContain('Add the photo picker to the product form');
    expect(text()).toContain('Reused the existing file picker.');
  });

  it('renders the departures as markdown', async () => {
    await open(report({
      departures: [{ task: 'T2', repo: 'customer-portal', planText: 'Add `PhotoPicker`', departure: 'Reused **the existing** picker.' }],
    }));
    expect(Array.from(dialog().querySelectorAll('code')).map((c) => c.textContent)).toEqual(['PhotoPicker']);
    expect(dialog().querySelector('strong')!.textContent).toBe('the existing');
    expect(text()).not.toContain('`');
  });

  it('emits confirm from Open pull requests', async () => {
    const { fixture } = await open();
    let confirmed = 0;
    fixture.componentInstance.confirm.subscribe(() => confirmed++);
    button('Open pull requests')!.click();
    expect(confirmed).toBe(1);
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
