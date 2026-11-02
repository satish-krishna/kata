import { render } from '../../testing/render';
import type { RunningLine } from '../../bindings/RunningLine';
import { CloseDialog } from './close-dialog';

const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label)!;

const running: RunningLine[] = [
  { change: 'A', what: 'building in kata' },
  { change: 'B', what: 'writing its spec' },
];

describe('CloseDialog', () => {
  it('renders nothing while there is no question', async () => {
    await render(CloseDialog, { running: null });
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('the close dialog names each running change and answers', async () => {
    const { fixture } = await render(CloseDialog, { running });
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog).not.toBeNull();
    const title = dialog.querySelector('[data-slot="alert-dialog-title"]')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    const items = Array.from(dialog.querySelectorAll('li')).map((li) => li.textContent!.replace(/\s+/g, ' ').trim());
    expect(items).toEqual(['A: building in kata', 'B: writing its spec']);

    const got: string[] = [];
    fixture.componentInstance.stopAll.subscribe(() => got.push('stop-all'));
    fixture.componentInstance.keepWorking.subscribe(() => got.push('keep-working'));
    button('Stop all and close').click();
    button('Keep working').click();
    expect(got).toEqual(['stop-all', 'keep-working']);
  });

  it('a run outside any change is listed by what it does alone, and Escape keeps working', async () => {
    const { fixture } = await render(CloseDialog, { running: [{ change: null, what: 'a Workbench run' }] });
    const items = Array.from(document.body.querySelectorAll('[role="alertdialog"] li')).map((li) => li.textContent!.trim());
    expect(items).toEqual(['a Workbench run']);
    let n = 0;
    fixture.componentInstance.keepWorking.subscribe(() => n++);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(n).toBe(1);
  });
});
