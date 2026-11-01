import type { ChangeOffer } from '@bindings/ChangeOffer';
import type { LabelTone } from '@bindings/LabelTone';
import { render } from '../../testing/render';
import { ChangesTable, type ChangeRow } from './changes-table';

const offerOf = (text: string, tone: LabelTone = 'muted'): ChangeOffer => ({ stage: 'plan-ready', label: { step: 'plan', text, tone }, actions: [] });
const row = (name: string, over: Partial<ChangeRow> = {}): ChangeRow => ({ system: 'commerce', change: name, title: null, offer: offerOf('Plan · ready to start'), ...over });
const LABELS: Record<string, string> = { 'spec-awaiting': 'Spec · awaiting acceptance', 'plan-awaiting': 'Plan · awaiting acceptance', 'plan-ready': 'Plan · ready to start' };
const staged = (name: string, stage: string): ChangeRow => row(name, { offer: offerOf(LABELS[stage], 'warning') });

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

describe('ChangesTable rows from the answer of the plugin (R1.4)', () => {
  it('shows the label in each offer with its tone, and the change still opens', async () => {
    const rows = [
      row('c1', { offer: offerOf('Plan · could not be read', 'warning') }),
      row('c2', { offer: offerOf('Closed · rejected', 'error') }),
      row('c3', { offer: offerOf('Spec · ready to start', 'muted') }),
    ];
    const { fixture, container } = await render(ChangesTable, { rows, others: [], lastRuns: {} });
    expect(text(container)).toContain('Plan · could not be read');
    expect(text(container)).toContain('Closed · rejected');
    expect(container.querySelector('.k-status--warning')).not.toBeNull();
    expect(container.querySelector('.k-status--error')).not.toBeNull();
    expect(container.querySelector('.k-status--idle')).not.toBeNull();
    const got: unknown[] = [];
    fixture.componentInstance.open.subscribe((v) => got.push(v));
    const open = buttons(container).find((b) => b.getAttribute('aria-label') === 'Open change c1')!;
    expect(open.disabled).toBe(false);
    open.click();
    expect(got).toEqual([{ system: 'commerce', change: 'c1' }]);
  });
});
