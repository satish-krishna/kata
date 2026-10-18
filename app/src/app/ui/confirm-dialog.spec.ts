import { render } from '../../testing/render';
import { ConfirmDialog } from './confirm-dialog';

const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label)!;

describe('ConfirmDialog', () => {
  it('renders nothing while closed', async () => {
    await render(ConfirmDialog, { open: false, message: 'Discard changes?' });
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('is an alert dialog named by the message, with the default Confirm label', async () => {
    await render(ConfirmDialog, { open: true, message: 'Discard changes?' });
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const title = dialog.querySelector('[data-slot="alert-dialog-title"]')!;
    expect(title.textContent).toContain('Discard changes?');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(button('Confirm')).toBeTruthy();
  });

  it('emits confirm with a custom label and cancel from Cancel', async () => {
    const { fixture } = await render(ConfirmDialog, { open: true, message: 'Discard changes?', confirmLabel: 'Discard' });
    const got: string[] = [];
    fixture.componentInstance.confirm.subscribe(() => got.push('confirm'));
    fixture.componentInstance.cancel.subscribe(() => got.push('cancel'));
    button('Discard').click();
    button('Cancel').click();
    expect(got).toEqual(['confirm', 'cancel']);
  });

  it('emits cancel on Escape', async () => {
    const { fixture } = await render(ConfirmDialog, { open: true, message: 'Discard changes?' });
    let n = 0;
    fixture.componentInstance.cancel.subscribe(() => n++);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(n).toBe(1);
  });
});
