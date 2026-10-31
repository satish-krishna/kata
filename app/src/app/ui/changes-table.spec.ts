import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { DocState } from '@bindings/DocState';
import { TestBed } from '@angular/core/testing';
import { render } from '../../testing/render';
import type { ChangeRow } from '../core/sdlc/sdlc-stages.store';
import { ChangesTable } from './changes-table';

const doc = (status: string | null): DocState =>
  status === null ? { exists: false, committed: false, status: null, head_status: null } : { exists: true, committed: true, status, head_status: status };
const row = (name: string, over: Partial<ChangeRow> = {}): ChangeRow => ({ system: 'commerce', change: name, title: null, info: null, error: null, checking: false, ...over });
const staged = (name: string, stage: ChangeInfo['stage']): ChangeRow => row(name, { info: change(name, stage) });
const change = (name: string, stage: ChangeInfo['stage']): ChangeInfo =>
  ({ system: 'commerce', change: name, intent: doc('accepted'), spec: doc(null), plan: doc(null), stage, build: { tasks: 0, finished: 0, repos: 0 }, scope: 'commerce', out_of_date: null, plan_unreadable: false, plan_unreadable_reason: null, track: 'full', fix_row: null });

const text = (c: HTMLElement) => c.textContent!.replace(/\s+/g, ' ');
const buttons = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('button'));

describe('ChangesTable', () => {
  it('groups changes by system and shows each stage as a labelled status', async () => {
    const { container } = await render(ChangesTable, {
      rows: [staged('2026-10-12-photos', 'spec-awaiting'), staged('2026-10-09-reassign', 'plan-awaiting')],
      others: [], lastRuns: {},
    });
    expect(container.querySelector('[data-testid="system-commerce"]')).not.toBeNull();
    expect(text(container)).toContain('2026-10-12-photos');
    expect(text(container)).toContain('Spec · awaiting acceptance');
    expect(text(container)).toContain('Plan · awaiting acceptance');
    expect(container.querySelectorAll('.k-status__dot').length).toBe(2);
  });

  it('shows the last run time, or a dash when the change has never run', async () => {
    const { container } = await render(ChangesTable, {
      rows: [staged('c1', 'plan-ready'), staged('c2', 'plan-ready')],
      others: [], lastRuns: { 'commerce/c1': 1792281600 },
    });
    const rows = Array.from(container.querySelectorAll('tbody tr')).filter((r) => r.querySelector('td')).map((r) => text(r as HTMLElement));
    expect(rows[0]).toContain('2026-10-18 00:00');
    expect(rows[1]).toContain('—');
  });

  it('renders the other-branches group by folder name with no stage', async () => {
    const { container } = await render(ChangesTable, { rows: [staged('c1', 'plan-ready')], others: ['2026-10-17-product-notes'], lastRuns: {} });
    const group = container.querySelector('[data-testid="other-branches"]')!;
    expect(group).not.toBeNull();
    expect(text(group as HTMLElement)).toContain('In progress on other branches');
    expect(text(group as HTMLElement)).toContain('2026-10-17-product-notes');
    expect(group.querySelectorAll('.k-status').length).toBe(0);
  });

  it('tags an other branch that needs a name', async () => {
    const { container } = await render(ChangesTable, { rows: [], others: ['2026-11-02-password-reset', '2026-10-17-product-notes'], needsName: ['2026-11-02-password-reset'] });
    const tags = container.querySelectorAll('[data-testid="needs-name"]');
    expect(tags.length).toBe(1);
    expect(tags[0].textContent).toContain('Branch needs a name');
    expect(tags[0].previousElementSibling!.textContent).toContain('2026-11-02-password-reset');
  });

  it('omits the other-branches group when there are none', async () => {
    const { container } = await render(ChangesTable, { rows: [staged('c1', 'plan-ready')], others: [], lastRuns: {} });
    expect(container.querySelector('[data-testid="other-branches"]')).toBeNull();
  });

  it('says so when there are no changes at all', async () => {
    const { container } = await render(ChangesTable, { rows: [], others: [], lastRuns: {} });
    expect(text(container)).toContain('No changes yet');
  });

  it('emits open for a change and openOther for a branch', async () => {
    const { fixture, container } = await render(ChangesTable, { rows: [staged('c1', 'plan-ready')], others: ['other-one'], lastRuns: {} });
    const got: unknown[] = [];
    fixture.componentInstance.open.subscribe((v) => got.push(v));
    fixture.componentInstance.openOther.subscribe((v) => got.push(v));
    buttons(container).find((b) => b.getAttribute('aria-label') === 'Open change c1')!.click();
    buttons(container).find((b) => b.getAttribute('aria-label') === 'Switch to branch change/other-one')!.click();
    expect(got).toEqual([{ system: 'commerce', change: 'c1' }, 'other-one']);
  });

  it('disables opening while the app is locked', async () => {
    const { container } = await render(ChangesTable, { rows: [staged('c1', 'plan-ready')], others: ['o'], lastRuns: {}, disabled: true });
    expect(buttons(container).every((b) => b.disabled)).toBe(true);
  });
});

describe('ChangesTable rows while stages are read (R1.1, R2.1, R5.1)', () => {
  it('shows Reading in place of the stage for a change whose stage is not read yet, and the change still opens', async () => {
    const { fixture, container } = await render(ChangesTable, { rows: [row('c1')], others: [], lastRuns: {} });
    const rowText = text(container.querySelector('tbody tr:nth-child(2)') as HTMLElement);
    expect(rowText).toContain('c1');
    expect(rowText).toContain('Reading');
    const got: unknown[] = [];
    fixture.componentInstance.open.subscribe((v) => got.push(v));
    const open = buttons(container).find((b) => b.getAttribute('aria-label') === 'Open change c1')!;
    expect(open.disabled).toBe(false);
    open.click();
    expect(got).toEqual([{ system: 'commerce', change: 'c1' }]);
  });

  it('shows a stored stage as it is, and marks it as being checked while a pass reads it again', async () => {
    const info = change('c1', 'plan-awaiting');
    const checked = await render(ChangesTable, { rows: [row('c1', { info, checking: true })], others: [], lastRuns: {} });
    expect(text(checked.container)).toContain('Plan · awaiting acceptance');
    expect(text(checked.container)).toContain('checking');
    TestBed.resetTestingModule();
    const settled = await render(ChangesTable, { rows: [row('c1', { info })], others: [], lastRuns: {} });
    expect(text(settled.container)).toContain('Plan · awaiting acceptance');
    expect(text(settled.container)).not.toContain('checking');
    expect(text(settled.container)).not.toContain('Reading');
  });

  it('shows the error of a change that could not be read in place of its stage', async () => {
    const { container } = await render(ChangesTable, { rows: [row('c1', { error: 'worker panicked' })], others: [], lastRuns: {} });
    expect(text(container)).toContain('worker panicked');
  });
});
