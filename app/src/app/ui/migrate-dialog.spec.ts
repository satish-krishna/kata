import { TestBed } from '@angular/core/testing';
import type { MigratePlan } from '@bindings/MigratePlan';
import { render } from '../../testing/render';
import { MigrateDialog } from './migrate-dialog';

const plan = (over: Partial<MigratePlan> = {}): MigratePlan => ({
  workspace: 'D:/ws',
  master: 'D:/ws/docs',
  write: false,
  steps: [
    { step: 'marker', path: 'D:/ws/docs/.ai-sdlc.json', to: 'D:/ws/docs/.hoshin.json', status: 'would', detail: null },
    { step: 'instructions', path: 'D:/ws/CLAUDE.md', to: null, status: 'manual', detail: 'edit it by hand' },
  ],
  kept: ['D:/ws/.ai-sdlc/old'],
  manual: [],
  problems: [],
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
const open = async (inputs: Record<string, unknown> = {}) => {
  const out = await render(MigrateDialog, { open: true, plan: plan(), done: false, canMigrate: true, error: null, ...inputs });
  await settle();
  return out;
};

describe('MigrateDialog', () => {
  it('renders nothing while closed', async () => {
    await render(MigrateDialog, { open: false, plan: plan(), done: false, canMigrate: true, error: null });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('lists each step as step, path, arrow, target and its status, then the kept paths', async () => {
    await open();
    expect(text()).toContain('marker D:/ws/docs/.ai-sdlc.json → D:/ws/docs/.hoshin.json');
    expect(text()).toContain('would');
    expect(text()).toContain('instructions D:/ws/CLAUDE.md');
    expect(text()).toContain('edit it by hand');
    expect(text()).toContain('D:/ws/.ai-sdlc/old');
  });

  it('shows every problem and disables Migrate while there is one', async () => {
    await open({ canMigrate: false, plan: plan({ problems: ['a change is mid-build'] }) });
    expect(text()).toContain('a change is mid-build');
    expect(button('Migrate')!.disabled).toBe(true);
  });

  it('enables Migrate without problems and emits migrate on click', async () => {
    const { fixture } = await open();
    const seen: string[] = [];
    fixture.componentInstance.migrate.subscribe(() => seen.push('migrate'));
    expect(button('Migrate')!.disabled).toBe(false);
    button('Migrate')!.click();
    expect(seen).toEqual(['migrate']);
  });

  it('disables Migrate when the host says it cannot run', async () => {
    await open({ canMigrate: false });
    expect(button('Migrate')!.disabled).toBe(true);
  });

  it('cannot be cancelled while the migration runs', async () => {
    await open({ busy: true, canMigrate: false });
    expect(button('Cancel')!.disabled).toBe(true);
  });

  it('can be cancelled when idle', async () => {
    await open();
    expect(button('Cancel')!.disabled).toBe(false);
  });

  it('shows the refusal as an alert', async () => {
    await open({ error: 'A run is working in this workspace.' });
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('A run is working in this workspace.');
  });

  it('after the migration shows the manual list under "Still to do by hand" and offers Close, not Migrate', async () => {
    await open({ done: true, plan: plan({ write: true, manual: ['Push the branches.'] }) });
    expect(text()).toContain('Still to do by hand');
    expect(text()).toContain('Push the branches.');
    expect(button('Migrate')).toBeUndefined();
    expect(button('Close')).toBeDefined();
  });
});
