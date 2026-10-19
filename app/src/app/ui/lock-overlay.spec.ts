import { TestBed } from '@angular/core/testing';
import { render } from '../../testing/render';
import type { LockView } from '../core/lock/lock.store';
import { LockOverlay } from './lock-overlay';

const RUN: LockView = { kind: 'run', title: 'Reading context' };
const dialog = () => document.body.querySelector('[role="dialog"]');
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};

describe('LockOverlay', () => {
  it('renders nothing while there is no view', async () => {
    await render(LockOverlay, { view: null });
    expect(dialog()).toBeNull();
  });

  it('opens as a labelled modal dialog when a view arrives', async () => {
    const { fixture } = await render(LockOverlay, { view: null });
    fixture.componentRef.setInput('view', RUN);
    await settle();
    const d = dialog()!;
    expect(d).not.toBeNull();
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe('Reading context');
    expect(d.textContent).toContain('Reading context');
  });

  it('stays open on Escape', async () => {
    await render(LockOverlay, { view: RUN });
    await settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(dialog()).not.toBeNull();
  });

  it('stays open on a backdrop click', async () => {
    await render(LockOverlay, { view: RUN });
    await settle();
    document.body.querySelector<HTMLElement>('.cdk-overlay-backdrop')?.click();
    await settle();
    expect(dialog()).not.toBeNull();
  });

  it('closes when the view clears', async () => {
    const { fixture } = await render(LockOverlay, { view: RUN });
    await settle();
    fixture.componentRef.setInput('view', null);
    await settle();
    await settle();
    expect(dialog()).toBeNull();
  });

  it('emits cancel from the panel', async () => {
    const { fixture } = await render(LockOverlay, { view: RUN });
    await settle();
    const cancel = vi.fn();
    fixture.componentInstance.cancel.subscribe(cancel);
    Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Cancel')!.click();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
