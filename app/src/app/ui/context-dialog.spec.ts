import { TestBed } from '@angular/core/testing';
import type { ContextView, RepoRow } from '../lib/sdlc-workspace';
import { render } from '../../testing/render';
import { ContextDialog } from './context-dialog';

const rows: RepoRow[] = [
  { name: 'claims-core', role: 'product', system: 'claims', context: { kind: 'fresh' } },
  { name: 'customer-portal', role: 'product', system: 'claims', context: { kind: 'stale', commits: 14 } },
  { name: 'ledger', role: 'product', system: 'claims', context: { kind: 'missing' } },
];
const CONTEXT = '---\nrepo: claims-core\nsource_commit: 4f1c9e2\n---\n# claims-core\n\nThe claims service.\n\n## Stack\n\n- .NET 8\n\n## Modules\n\nIntake and lifecycle.\n';

const dialog = () => document.body.querySelector('[role="dialog"]')!;
const text = () => dialog().textContent!.replace(/\s+/g, ' ');
const buttons = () => Array.from(dialog().querySelectorAll<HTMLButtonElement>('button'));
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};
const open = async (view: ContextView | null, disabled = false) => {
  const out = await render(ContextDialog, { view, disabled });
  await settle();
  return out;
};

afterEach(() => TestBed.resetTestingModule());

describe('ContextDialog', () => {
  it('renders the context file as markdown, with its sections outlined and its front matter in the rail', async () => {
    await open({ repo: 'claims-core', rows, text: CONTEXT });
    const doc = dialog().querySelector('[data-testid="context-doc"]')!;
    expect(doc.querySelector('.k-md h1')!.textContent).toBe('claims-core');
    expect(doc.querySelector('.k-md li')!.textContent).toBe('.NET 8');
    expect(doc.textContent).not.toContain('source_commit: 4f1c9e2');
    const toc = Array.from(doc.querySelectorAll('.k-docview__toclink')).map((b) => b.textContent!.trim());
    expect(toc).toEqual(['Stack', 'Modules']);
    const fields = Array.from(doc.querySelectorAll('.k-docview__fields dt')).map((d) => d.textContent);
    expect(fields).toEqual(['repo', 'source_commit']);
    expect(doc.querySelector('[data-testid="recent-runs"]')).toBeNull();
  });

  it('lists every repo with its context state and marks the picked one', async () => {
    await open({ repo: 'customer-portal', rows, text: CONTEXT });
    const list = Array.from(dialog().querySelectorAll<HTMLButtonElement>('nav[aria-label="Repositories"] button'));
    expect(list.map((b) => b.textContent!.replace(/\s+/g, ' ').trim())).toEqual(['claims-core fresh', 'customer-portal stale · 14 commits', 'ledger missing']);
    expect(list.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'true', null]);
    expect(dialog().querySelector('.k-ctxview__head')!.textContent).toContain('stale · 14 commits');
  });

  it('suggests running context only where a run is possible, and closes from its Close button', async () => {
    const notCheckedOut: RepoRow = { name: 'billing-api', role: 'not-checked-out', system: 'claims', context: { kind: 'notCheckedOut' } };
    const { fixture } = await open({ repo: 'billing-api', rows: [...rows, notCheckedOut], text: null });
    expect(text()).toContain('billing-api has no context file yet');
    expect(text()).not.toContain('Run context');
    let closed = 0;
    fixture.componentInstance.close.subscribe(() => (closed += 1));
    buttons().find((b) => b.textContent!.trim() === 'Close')!.click();
    expect(closed).toBe(1);
  });

  it('emits the repo picked in the list', async () => {
    const { fixture } = await open({ repo: 'claims-core', rows, text: CONTEXT });
    const got: string[] = [];
    fixture.componentInstance.pick.subscribe((r) => got.push(r));
    buttons().find((b) => b.textContent!.includes('ledger'))!.click();
    expect(got).toEqual(['ledger']);
  });

  it('says so while the file is read, and when the repo has none', async () => {
    const { fixture } = await open({ repo: 'claims-core', rows, text: undefined });
    expect(text()).toContain('Reading the context');
    fixture.componentRef.setInput('view', { repo: 'ledger', rows, text: null });
    await settle();
    expect(text()).toContain('ledger has no context file yet');
    expect(text()).toContain('intent/claims/context/ledger.md');
  });

  it('offers Refresh or Run context for the picked repo as the one primary action, disabled while locked', async () => {
    const { fixture } = await open({ repo: 'ledger', rows, text: null });
    const got: string[] = [];
    fixture.componentInstance.runContext.subscribe((r) => got.push(r));
    const run = buttons().find((b) => b.getAttribute('aria-label') === 'Run context for ledger')!;
    run.click();
    expect(got).toEqual(['ledger']);
    fixture.componentRef.setInput('view', { repo: 'claims-core', rows, text: CONTEXT });
    fixture.componentRef.setInput('disabled', true);
    await settle();
    expect(buttons().find((b) => b.getAttribute('aria-label') === 'Refresh context for claims-core')!.disabled).toBe(true);
  });
});
