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

async function mount(action: string | null) {
  const out = await render(FeedbackDialog, { action });
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
});
