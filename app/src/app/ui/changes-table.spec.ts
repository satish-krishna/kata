import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { DocState } from '@bindings/DocState';
import { render } from '../../testing/render';
import { ChangesTable } from './changes-table';

const doc = (status: string | null): DocState =>
  status === null ? { exists: false, committed: false, status: null } : { exists: true, committed: true, status };
const change = (name: string, stage: ChangeInfo['stage']): ChangeInfo =>
  ({ system: 'claims', change: name, intent: doc('accepted'), spec: doc(null), plan: doc(null), stage, build: { tasks: 0, finished: 0, repos: 0 }, scope: 'claims', out_of_date: null, plan_unreadable: false });

const text = (c: HTMLElement) => c.textContent!.replace(/\s+/g, ' ');
const buttons = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('button'));

describe('ChangesTable', () => {
  it('groups changes by system and shows each stage as a labelled status', async () => {
    const { container } = await render(ChangesTable, {
      changes: [change('2026-10-12-fnol', 'spec-awaiting'), change('2026-10-09-reassign', 'plan-awaiting')],
      others: [], lastRuns: {},
    });
    expect(container.querySelector('[data-testid="system-claims"]')).not.toBeNull();
    expect(text(container)).toContain('2026-10-12-fnol');
    expect(text(container)).toContain('Spec · awaiting acceptance');
    expect(text(container)).toContain('Plan · awaiting acceptance');
    expect(container.querySelectorAll('.k-status__dot').length).toBe(2);
  });

  it('shows the last run time, or a dash when the change has never run', async () => {
    const { container } = await render(ChangesTable, {
      changes: [change('c1', 'plan-ready'), change('c2', 'plan-ready')],
      others: [], lastRuns: { 'claims/c1': 1792281600 },
    });
    const rows = Array.from(container.querySelectorAll('tbody tr')).filter((r) => r.querySelector('td')).map((r) => text(r as HTMLElement));
    expect(rows[0]).toContain('2026-10-18 00:00');
    expect(rows[1]).toContain('—');
  });

  it('renders the other-branches group by folder name with no stage', async () => {
    const { container } = await render(ChangesTable, { changes: [change('c1', 'plan-ready')], others: ['2026-10-17-claim-notes'], lastRuns: {} });
    const group = container.querySelector('[data-testid="other-branches"]')!;
    expect(group).not.toBeNull();
    expect(text(group as HTMLElement)).toContain('In progress on other branches');
    expect(text(group as HTMLElement)).toContain('2026-10-17-claim-notes');
    expect(group.querySelectorAll('.k-status').length).toBe(0);
  });

  it('omits the other-branches group when there are none', async () => {
    const { container } = await render(ChangesTable, { changes: [change('c1', 'plan-ready')], others: [], lastRuns: {} });
    expect(container.querySelector('[data-testid="other-branches"]')).toBeNull();
  });

  it('says so when there are no changes at all', async () => {
    const { container } = await render(ChangesTable, { changes: [], others: [], lastRuns: {} });
    expect(text(container)).toContain('No changes yet');
  });

  it('emits open for a change and openOther for a branch', async () => {
    const c = change('c1', 'plan-ready');
    const { fixture, container } = await render(ChangesTable, { changes: [c], others: ['other-one'], lastRuns: {} });
    const got: unknown[] = [];
    fixture.componentInstance.open.subscribe((v) => got.push(v));
    fixture.componentInstance.openOther.subscribe((v) => got.push(v));
    buttons(container).find((b) => b.getAttribute('aria-label') === 'Open change c1')!.click();
    buttons(container).find((b) => b.getAttribute('aria-label') === 'Switch to branch change/other-one')!.click();
    expect(got).toEqual([c, 'other-one']);
  });

  it('disables opening while the app is locked', async () => {
    const { container } = await render(ChangesTable, { changes: [change('c1', 'plan-ready')], others: ['o'], lastRuns: {}, disabled: true });
    expect(buttons(container).every((b) => b.disabled)).toBe(true);
  });
});
