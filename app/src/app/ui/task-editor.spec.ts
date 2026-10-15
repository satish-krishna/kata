import { render } from '../../testing/render';
import { TaskEditor } from './task-editor';

const area = () => document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task"]')!;
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label)!;
const ctrlEnter = () => area().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
const type = async (v: string, fixture: { whenStable(): Promise<unknown> }) => {
  area().value = v;
  area().dispatchEvent(new Event('input', { bubbles: true }));
  await fixture.whenStable();
};

describe('TaskEditor', () => {
  it('opens a titled dialog seeded with the task', async () => {
    await render(TaskEditor, { task: 'fix the bug' });
    expect(document.body.querySelector('.k-dialog')!.getAttribute('aria-label')).toBe('Re-run with a new task');
    expect(document.body.textContent).toContain('Re-run · new task');
    expect(area().value).toBe('fix the bug');
  });

  it('emits cancel on Escape', async () => {
    const { fixture } = await render(TaskEditor, { task: 'x' });
    let n = 0;
    fixture.componentInstance.cancel.subscribe(() => n++);
    area().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(n).toBe(1);
  });

  it('emits nothing on Ctrl+Enter with a blank draft', async () => {
    const { fixture } = await render(TaskEditor, { task: 'x' });
    const got: string[] = [];
    fixture.componentInstance.run.subscribe((v) => got.push(v));
    await type('   ', fixture);
    ctrlEnter();
    expect(got).toEqual([]);
    expect(button('Run').disabled).toBe(true);
  });

  it('emits run with the draft on Ctrl+Enter and on the Run button', async () => {
    const { fixture } = await render(TaskEditor, { task: 'x' });
    const got: string[] = [];
    fixture.componentInstance.run.subscribe((v) => got.push(v));
    await type('new task', fixture);
    ctrlEnter();
    button('Run').click();
    expect(got).toEqual(['new task', 'new task']);
  });

  it('emits cancel from the Cancel button', async () => {
    const { fixture } = await render(TaskEditor, { task: 'x' });
    let n = 0;
    fixture.componentInstance.cancel.subscribe(() => n++);
    button('Cancel').click();
    expect(n).toBe(1);
  });
});
