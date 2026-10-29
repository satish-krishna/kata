import type { RepoRow } from '../lib/sdlc-workspace';
import { render } from '../../testing/render';
import { ReposTable } from './repos-table';

const rows: RepoRow[] = [
  { name: 'claims-intent', role: 'master', system: 'claims', context: null },
  { name: 'claims-core', role: 'product', system: 'claims', context: { kind: 'fresh' } },
  { name: 'customer-portal', role: 'product', system: 'claims', context: { kind: 'stale', commits: 14 } },
  { name: 'ledger', role: 'product', system: 'claims', context: { kind: 'missing' } },
  { name: 'billing-api', role: 'not-checked-out', system: 'claims', context: { kind: 'notCheckedOut' } },
];
const text = (c: HTMLElement) => c.textContent!.replace(/\s+/g, ' ');
const runButtons = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>('button')).filter((b) => / context for /.test(b.getAttribute('aria-label') ?? ''));

describe('ReposTable', () => {
  it('shows each repo with its role and a labelled context state', async () => {
    const { container } = await render(ReposTable, { rows, marker: '.ai-sdlc.json · 1 system' });
    const t = text(container);
    expect(t).toContain('claims-intent');
    expect(t).toContain('master');
    expect(t).toContain('fresh');
    expect(t).toContain('stale · 14 commits');
    expect(t).toContain('missing');
    expect(t).toContain('not checked out');
    expect(t).toContain('.ai-sdlc.json · 1 system');
  });

  it('lets only the context cell wrap, so the table fits its pane at the 1024 minimum width', async () => {
    const { container } = await render(ReposTable, { rows, marker: '' });
    const row = container.querySelector<HTMLElement>('tbody tr')!;
    const wraps = Array.from(row.children).map((td) => td.classList.contains('whitespace-normal'));
    expect(wraps).toEqual([false, false, true, false]);
  });

  it('offers Refresh context on fresh and stale rows, Run context on missing ones, nothing on the rest', async () => {
    const { container } = await render(ReposTable, { rows, marker: '' });
    expect(runButtons(container).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Refresh context for claims-core',
      'Refresh context for customer-portal',
      'Run context for ledger',
    ]);
    expect(runButtons(container).map((b) => b.textContent!.trim())).toEqual(['Refresh context', 'Refresh context', 'Run context']);
  });

  it('emits the repo name when Run context is clicked', async () => {
    const { fixture, container } = await render(ReposTable, { rows, marker: '' });
    const got: string[] = [];
    fixture.componentInstance.runContext.subscribe((n) => got.push(n));
    runButtons(container)[0].click();
    expect(got).toEqual(['claims-core']);
  });

  it('disables Run context while the app is locked', async () => {
    const { container } = await render(ReposTable, { rows, marker: '', disabled: true });
    expect(runButtons(container).every((b) => b.disabled)).toBe(true);
  });

  it('offers View on every product repo with a context file to read, and emits its name', async () => {
    const { fixture, container } = await render(ReposTable, { rows, marker: '' });
    const views = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b.textContent!.trim() === 'View');
    expect(views.map((b) => b.getAttribute('aria-label'))).toEqual([
      'View context of claims-core',
      'View context of customer-portal',
      'View context of billing-api',
    ]);
    const got: string[] = [];
    fixture.componentInstance.viewContext.subscribe((n) => got.push(n));
    views[1].click();
    expect(got).toEqual(['customer-portal']);
  });
});
