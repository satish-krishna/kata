import { TestBed } from '@angular/core/testing';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { WorkspaceCandidate } from '../lib/sdlc-workspace';
import { render } from '../../testing/render';
import { AddWorkspaceDialog } from './add-workspace-dialog';

const SCAN: WorkspaceScan = {
  folder: 'D:/Work/acme-claims',
  repos: ['claims-intent', 'customer-portal'],
  master: { kind: 'one', repo: 'claims-intent', committed: true },
  marker: { version: 1, systems: { claims: { repos: ['customer-portal', 'billing-api'] } } },
  marker_error: null,
};
const candidate = (scan: Partial<WorkspaceScan> = {}): WorkspaceCandidate => ({
  folder: 'D:/Work/acme-claims',
  name: 'acme-claims',
  scan: { ...SCAN, ...scan },
  contexts: { 'customer-portal': { kind: 'stale', commits: 14 }, 'billing-api': { kind: 'notCheckedOut' } },
  baseBranch: 'main',
});
const dialog = () => document.body.querySelector('[role="dialog"]');
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label);
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};
const text = () => dialog()!.textContent!.replace(/\s+/g, ' ');

describe('AddWorkspaceDialog', () => {
  it('renders nothing without a candidate', async () => {
    await render(AddWorkspaceDialog, { candidate: null });
    expect(dialog()).toBeNull();
  });

  it('shows the folder, base branch, systems, and each repo with its role and context', async () => {
    await render(AddWorkspaceDialog, { candidate: candidate() });
    await settle();
    const t = text();
    expect(t).toContain('D:/Work/acme-claims');
    expect(t).toContain('main');
    expect(t).toContain('claims');
    expect(t).toContain('claims-intent');
    expect(t).toContain('master');
    expect(t).toContain('stale · 14 commits');
    expect(t).toContain('billing-api');
    expect(t).toContain('not checked out');
  });

  it('emits add from Add workspace and cancel from Cancel', async () => {
    const { fixture } = await render(AddWorkspaceDialog, { candidate: candidate() });
    await settle();
    const got: string[] = [];
    fixture.componentInstance.add.subscribe(() => got.push('add'));
    fixture.componentInstance.cancel.subscribe(() => got.push('cancel'));
    button('Add workspace')!.click();
    button('Cancel')!.click();
    expect(got).toEqual(['add', 'cancel']);
  });

  it('says so and offers no Add when the folder has no git repos', async () => {
    await render(AddWorkspaceDialog, { candidate: candidate({ repos: [], master: { kind: 'none' }, marker: null }) });
    await settle();
    expect(text()).toContain('No git repositories found');
    expect(button('Add workspace')).toBeUndefined();
  });

  it('lists every marker when more than one repo holds .ai-sdlc.json and offers no Add', async () => {
    await render(AddWorkspaceDialog, { candidate: candidate({ master: { kind: 'many', repos: ['intent-a', 'intent-b'] } }) });
    await settle();
    const t = text();
    expect(t).toContain('exactly one');
    expect(t).toContain('intent-a');
    expect(t).toContain('intent-b');
    expect(button('Add workspace')).toBeUndefined();
  });
});
