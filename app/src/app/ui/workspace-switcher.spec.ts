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
const items = () => Array.from(document.body.querySelectorAll<HTMLElement>('hlm-select-item'));
const trigger = (c: HTMLElement) => c.querySelector<HTMLElement>('button[aria-label="Switch workspace"]')!;
const open = async (c: HTMLElement) => {
  trigger(c).focus();
  trigger(c).click();
  await settle();
};
const itemWith = (text: string) => items().find((i) => i.textContent!.includes(text))!;

describe('WorkspaceSwitcher', () => {
  beforeAll(() => {
    // jsdom has neither ResizeObserver (CDK overlay positioning) nor scrollIntoView (select highlight).
    Element.prototype.scrollIntoView ??= () => {};
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('shows the current workspace on the trigger and keeps the list closed', async () => {
    const { container } = await render(WorkspaceSwitcher, { workspaces: [A, B], current: A, missing: [], counts: {} });
    expect(trigger(container).textContent).toContain('acme-claims');
    expect(items().length).toBe(0);
  });

  it('lists every workspace with its folder and change count, and flags a missing folder', async () => {
    const { container } = await render(WorkspaceSwitcher, {
      workspaces: [A, B], current: A, missing: ['old-billing'], counts: { 'acme-claims': 3 },
    });
    await open(container);
    const acme = itemWith('acme-claims').textContent!.replace(/\s+/g, ' ');
    const billing = itemWith('old-billing').textContent!.replace(/\s+/g, ' ');
    expect(acme).toContain('D:/Work/acme-claims');
    expect(acme).toContain('3 changes');
    expect(acme).not.toContain('folder missing');
    expect(billing).toContain('folder missing');
  });

  it('ends with Add workspace and Remove from list', async () => {
    const { container } = await render(WorkspaceSwitcher, { workspaces: [A], current: A, missing: [], counts: {} });
    await open(container);
    expect(items().slice(-2).map((i) => i.textContent!.trim())).toEqual(['Add workspace…', 'Remove from list…']);
  });

  it('emits select with the id of the chosen workspace and shows the current one again', async () => {
    const { fixture, container } = await render(WorkspaceSwitcher, { workspaces: [A, B], current: A, missing: [], counts: {} });
    const picked: string[] = [];
    fixture.componentInstance.select.subscribe((id) => picked.push(id));
    await open(container);
    itemWith('old-billing').click();
    await settle();
    expect(picked).toEqual(['old-billing']);
    expect(trigger(container).textContent).toContain('acme-claims');
  });

  it('emits add and remove from the footer items', async () => {
    const { fixture, container } = await render(WorkspaceSwitcher, { workspaces: [A], current: A, missing: [], counts: {} });
    const got: string[] = [];
    fixture.componentInstance.add.subscribe(() => got.push('add'));
    fixture.componentInstance.remove.subscribe(() => got.push('remove'));
    await open(container);
    itemWith('Add workspace').click();
    await settle();
    await open(container);
    itemWith('Remove from list').click();
    await settle();
    expect(got).toEqual(['add', 'remove']);
  });

  it('shows a placeholder and cannot remove when there is no current workspace', async () => {
    const { container } = await render(WorkspaceSwitcher, { workspaces: [], current: null, missing: [], counts: {} });
    expect(trigger(container).textContent).toContain('No workspace');
    await open(container);
    expect(itemWith('Remove from list').hasAttribute('data-disabled')).toBe(true);
  });
});
