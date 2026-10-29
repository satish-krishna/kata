import { TestBed } from '@angular/core/testing';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { render } from '../../testing/render';
import { SdlcSettingsDialog } from './sdlc-settings-dialog';

const SETTINGS: Settings = { mode: 'sdlc', remember: true, permission_mode: 'bypass' };
const WS: WorkspaceEntry = { id: 'a', name: 'a', folder: '/a', base_branch: 'main', last_opened: 1 };
const dialog = () => document.body.querySelector('[role="dialog"]');
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label)!;
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};

describe('SdlcSettingsDialog', () => {
  it('renders nothing while closed', async () => {
    await render(SdlcSettingsDialog, { open: false, settings: SETTINGS, workspace: WS });
    expect(dialog()).toBeNull();
  });

  it('shows the permission mode as a segmented choice and the base branch as text', async () => {
    await render(SdlcSettingsDialog, { open: true, settings: SETTINGS, workspace: WS });
    await settle();
    const radios = Array.from(dialog()!.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.textContent!.trim())).toEqual(['bypass', 'prompt']);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    expect(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Base branch"]')!.value).toBe('main');
  });

  it('saves prompt mode with the unchanged base branch', async () => {
    const { fixture } = await render(SdlcSettingsDialog, { open: true, settings: SETTINGS, workspace: WS });
    await settle();
    const got: unknown[] = [];
    fixture.componentInstance.save.subscribe((v) => got.push(v));
    button('prompt').click();
    await settle();
    button('Save').click();
    expect(got).toEqual([{ settings: { ...SETTINGS, permission_mode: 'prompt' }, baseBranch: 'main' }]);
  });

  it('saves auto mode with the unchanged base branch', async () => {
    const { fixture } = await render(SdlcSettingsDialog, { open: true, settings: SETTINGS, workspace: WS });
    await settle();
    const got: unknown[] = [];
    fixture.componentInstance.save.subscribe((v) => got.push(v));
    button('auto').click();
    await settle();
    button('Save').click();
    expect(got).toEqual([{ settings: { ...SETTINGS, permission_mode: 'auto' }, baseBranch: 'main' }]);
  });

  it('saves an edited base branch, trimmed', async () => {
    const { fixture } = await render(SdlcSettingsDialog, { open: true, settings: SETTINGS, workspace: WS });
    await settle();
    const got: { baseBranch: string | null }[] = [];
    fixture.componentInstance.save.subscribe((v) => got.push(v));
    const input = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Base branch"]')!;
    input.value = '  develop ';
    input.dispatchEvent(new Event('input'));
    await settle();
    button('Save').click();
    expect(got[0].baseBranch).toBe('develop');
  });

  it('has no base-branch field and saves null without a workspace', async () => {
    const { fixture } = await render(SdlcSettingsDialog, { open: true, settings: SETTINGS, workspace: null });
    await settle();
    expect(dialog()!.querySelector('input[aria-label="Base branch"]')).toBeNull();
    const got: { baseBranch: string | null }[] = [];
    fixture.componentInstance.save.subscribe((v) => got.push(v));
    button('Save').click();
    expect(got[0].baseBranch).toBeNull();
  });

  it('cannot save an empty base branch', async () => {
    await render(SdlcSettingsDialog, { open: true, settings: SETTINGS, workspace: WS });
    await settle();
    const input = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Base branch"]')!;
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('emits cancel from Cancel', async () => {
    const { fixture } = await render(SdlcSettingsDialog, { open: true, settings: SETTINGS, workspace: WS });
    await settle();
    let n = 0;
    fixture.componentInstance.cancel.subscribe(() => n++);
    button('Cancel').click();
    expect(n).toBe(1);
  });
});
