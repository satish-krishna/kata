import { TestBed } from '@angular/core/testing';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { render } from '../../testing/render';
import { WorkspaceSwitcher } from './workspace-switcher';

const ws = (id: string, folder: string): WorkspaceEntry => ({ id, name: id, folder, base_branch: 'main', last_opened: 1 });
const A = ws('acme-claims', 'D:/Work/acme-claims');
const B = ws('old-billing', 'D:/Gone/old-billing');

const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};
const radios = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
const items = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
const trigger = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[aria-label^="Switch workspace"]')!;
const open = async (c: HTMLElement) => {
  trigger(c).click();
  await settle();
};
const radioWith = (text: string) => radios().find((i) => i.textContent!.includes(text))!;
const itemWith = (text: string) => items().find((i) => i.textContent!.includes(text))!;
const base = { workspaces: [A, B], current: A, missing: [], counts: {} };

describe('WorkspaceSwitcher', () => {
  beforeAll(() => {
    // jsdom has no ResizeObserver (CDK overlay positioning).
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });
  afterEach(() => document.body.querySelectorAll('.cdk-overlay-container').forEach((n) => (n.innerHTML = '')));

  it('names the current workspace on the trigger and keeps the menu closed', async () => {
    const { container } = await render(WorkspaceSwitcher, base);
    expect(trigger(container).textContent).toContain('acme-claims');
    expect(radios().length).toBe(0);
  });

  it('carries the workspace name in its title and its accessible name, since the name can be cut', async () => {
    const { container } = await render(WorkspaceSwitcher, base);
    expect(trigger(container).getAttribute('aria-label')).toBe('Switch workspace, acme-claims');
    expect(trigger(container).getAttribute('title')).toBe('acme-claims');
  });

  it('names the missing workspace the same way', async () => {
    const { container } = await render(WorkspaceSwitcher, { ...base, workspaces: [], current: null });
    expect(trigger(container).getAttribute('aria-label')).toBe('Switch workspace, No workspace');
    expect(trigger(container).getAttribute('title')).toBe('No workspace');
  });

  it('lists every workspace with its folder and change count, and flags a missing folder', async () => {
    const { container } = await render(WorkspaceSwitcher, { ...base, missing: ['old-billing'], counts: { 'acme-claims': 3 } });
    await open(container);
    const acme = radioWith('acme-claims').textContent!.replace(/\s+/g, ' ');
    const billing = radioWith('old-billing').textContent!.replace(/\s+/g, ' ');
    expect(acme).toContain('D:/Work/acme-claims');
    expect(acme).toContain('3 changes');
    expect(acme).not.toContain('folder missing');
    expect(billing).toContain('folder missing');
  });

  it('checks the current workspace', async () => {
    const { container } = await render(WorkspaceSwitcher, base);
    await open(container);
    expect(radioWith('acme-claims').getAttribute('aria-checked')).toBe('true');
    expect(radioWith('old-billing').getAttribute('aria-checked')).toBe('false');
  });

  it('emits select with the id of another workspace, and nothing for the current one', async () => {
    const { fixture, container } = await render(WorkspaceSwitcher, base);
    const picked: string[] = [];
    fixture.componentInstance.select.subscribe((id) => picked.push(id));
    await open(container);
    radioWith('acme-claims').click();
    await open(container);
    radioWith('old-billing').click();
    await settle();
    expect(picked).toEqual(['old-billing']);
  });

  it('ends with Add workspace… and Remove from list…, which emit', async () => {
    const { fixture, container } = await render(WorkspaceSwitcher, base);
    const got: string[] = [];
    fixture.componentInstance.add.subscribe(() => got.push('add'));
    fixture.componentInstance.remove.subscribe(() => got.push('remove'));
    await open(container);
    expect(items().map((i) => i.textContent!.trim())).toEqual(['Add workspace…', 'Remove from list…']);
    itemWith('Add workspace').click();
    await open(container);
    itemWith('Remove from list').click();
    expect(got).toEqual(['add', 'remove']);
  });

  it('offers only Add workspace… when there is no workspace yet', async () => {
    const { container } = await render(WorkspaceSwitcher, { workspaces: [], current: null, missing: [], counts: {} });
    expect(trigger(container).textContent).toContain('No workspace');
    await open(container);
    expect(radios().length).toBe(0);
    expect(items().map((i) => i.textContent!.trim())).toEqual(['Add workspace…']);
  });

  it('disables the trigger while locked', async () => {
    const { container } = await render(WorkspaceSwitcher, { ...base, locked: true });
    expect(trigger(container).disabled).toBe(true);
  });
});

describe('WorkspaceSwitcher without counts (R3.1)', () => {
  it('lists the other workspaces by name and folder only, with no change count input', async () => {
    const { fixture, container } = await render(WorkspaceSwitcher, { workspaces: [A, B], current: A, missing: ['old-billing'] });
    expect('counts' in fixture.componentInstance).toBe(false);
    trigger(container).click();
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    const rows = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).map((i) => i.textContent!.replace(/\s+/g, ' '));
    expect(rows.some((t) => /\d+ changes?/.test(t))).toBe(false);
    expect(rows.find((t) => t.includes('old-billing'))).toContain('folder missing');
  });
});
