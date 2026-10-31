import { TestBed } from '@angular/core/testing';
import type { Settings } from '@bindings/Settings';
import { render } from '../../testing/render';
import { SdlcSettingsDialog } from './sdlc-settings-dialog';

const SETTINGS: Settings = { mode: 'sdlc', remember: true, permission_mode: 'bypass' };
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
    await render(SdlcSettingsDialog, { open: false, settings: SETTINGS });
    expect(dialog()).toBeNull();
  });

  it('shows the permission mode as a segmented choice and no base-branch field', async () => {
    await render(SdlcSettingsDialog, { open: true, settings: SETTINGS });
    await settle();
    const radios = Array.from(dialog()!.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.textContent!.trim())).toEqual(['auto', 'bypass', 'prompt']);
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    expect(dialog()!.querySelector('input[aria-label="Base branch"]')).toBeNull();
    expect(dialog()!.textContent).not.toContain('Base branch');
  });

  it('saves prompt mode and only the settings', async () => {
    const { fixture } = await render(SdlcSettingsDialog, { open: true, settings: SETTINGS });
    await settle();
    const got: unknown[] = [];
    fixture.componentInstance.save.subscribe((v) => got.push(v));
    button('prompt').click();
    await settle();
    button('Save').click();
    expect(got).toEqual([{ settings: { ...SETTINGS, permission_mode: 'prompt' } }]);
  });

  it('saves auto mode and only the settings', async () => {
    const { fixture } = await render(SdlcSettingsDialog, { open: true, settings: SETTINGS });
    await settle();
    const got: unknown[] = [];
    fixture.componentInstance.save.subscribe((v) => got.push(v));
    button('auto').click();
    await settle();
    button('Save').click();
    expect(got).toEqual([{ settings: { ...SETTINGS, permission_mode: 'auto' } }]);
  });

  it('emits cancel from Cancel', async () => {
    const { fixture } = await render(SdlcSettingsDialog, { open: true, settings: SETTINGS });
    await settle();
    let n = 0;
    fixture.componentInstance.cancel.subscribe(() => n++);
    button('Cancel').click();
    expect(n).toBe(1);
  });
});
