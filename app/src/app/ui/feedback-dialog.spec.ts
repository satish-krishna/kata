import { TestBed } from '@angular/core/testing';
import { render } from '../../testing/render';
import { FeedbackDialog } from './feedback-dialog';

const dialog = () => document.body.querySelector('[role="dialog"]');
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label)!;
const box = () => dialog()!.querySelector<HTMLTextAreaElement>('textarea')!;
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};

async function mount(action: string | null, required = false) {
  const out = await render(FeedbackDialog, { action, required });
  await settle();
  const run = vi.fn();
  const cancel = vi.fn();
  out.fixture.componentInstance.run.subscribe(run);
  out.fixture.componentInstance.cancel.subscribe(cancel);
  return { ...out, run, cancel };
}

describe('FeedbackDialog', () => {
  it('renders nothing while no revisit is waiting', async () => {
    await mount(null);
    expect(dialog()).toBeNull();
  });

  it('is titled by the action and asks what should change, as an optional field', async () => {
    await mount('Reopen spec');
    expect(dialog()!.textContent).toContain('Reopen spec');
    expect(box().getAttribute('aria-label')).toBe('What should change?');
    expect(button('Run').disabled).toBe(false);
  });

  it('runs with the typed corrections, trimmed', async () => {
    const { run } = await mount('Re-run plan');
    box().value = '  Split task 3 in two.  ';
    box().dispatchEvent(new Event('input'));
    await settle();
    button('Run').click();
    expect(run).toHaveBeenCalledWith('Split task 3 in two.');
  });

  it('runs with no corrections when the box is left empty', async () => {
    const { run } = await mount('Continue spec');
    button('Run').click();
    expect(run).toHaveBeenCalledWith('');
  });

  it('cancels without running', async () => {
    const { run, cancel } = await mount('Reopen intent');
    button('Cancel').click();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  describe('a refused Run (WCAG AA)', () => {
    const refuse = async () => {
      const out = await mount('Change the fix', true);
      await settle();
      button('Run').click();
      await settle();
      return out;
    };

    it('marks the textarea invalid and links it to the message', async () => {
      const { run } = await refuse();
      expect(run).not.toHaveBeenCalled();
      expect(box().getAttribute('aria-invalid')).toBe('true');
      const id = box().getAttribute('aria-describedby');
      expect(id).toBeTruthy();
      expect(document.getElementById(id!)!.textContent).toContain('Write what should change.');
    });

    it('announces the message in a polite live region', async () => {
      await refuse();
      const message = document.getElementById(box().getAttribute('aria-describedby')!)!;
      expect(message.closest('[aria-live="polite"]')).not.toBeNull();
    });

    it('moves focus to the textarea', async () => {
      await refuse();
      expect(document.activeElement).toBe(box());
    });

    it('clears when the engineer types', async () => {
      await refuse();
      expect(box().getAttribute('aria-invalid')).toBe('true');
      box().value = 'x';
      box().dispatchEvent(new Event('input'));
      await settle();
      expect(box().getAttribute('aria-invalid')).not.toBe('true');
    });
  });
});
