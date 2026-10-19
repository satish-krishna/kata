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
  Array.from(c.querySelectorAll<HTMLButtonElement>('button')).filter((b) => (b.getAttribute('aria-label') ?? '').startsWith('Run context'));

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

  it('offers Run context only on stale and missing rows', async () => {
    const { container } = await render(ReposTable, { rows, marker: '' });
    expect(runButtons(container).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Run context for customer-portal',
      'Run context for ledger',
    ]);
  });

  it('emits the repo name when Run context is clicked', async () => {
    const { fixture, container } = await render(ReposTable, { rows, marker: '' });
    const got: string[] = [];
    fixture.componentInstance.runContext.subscribe((n) => got.push(n));
    runButtons(container)[0].click();
    expect(got).toEqual(['customer-portal']);
  });

  it('disables Run context while the app is locked', async () => {
    const { container } = await render(ReposTable, { rows, marker: '', disabled: true });
    expect(runButtons(container).every((b) => b.disabled)).toBe(true);
  });
});
