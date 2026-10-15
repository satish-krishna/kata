import { render } from '../../testing/render';
import { PromptDialog } from './prompt-dialog';

const input = () => document.body.querySelector<HTMLInputElement>('input[aria-label="Save as preset"]')!;
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label)!;
const type = async (v: string, fixture: { whenStable(): Promise<unknown> }) => {
  input().value = v;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await fixture.whenStable();
};

describe('PromptDialog', () => {
  it('renders nothing while closed', async () => {
    await render(PromptDialog, { open: false, title: 'Save as preset' });
    expect(input()).toBeNull();
  });

  it('shows a titled dialog with the input focused and Save disabled until text is typed', async () => {
    const { fixture } = await render(PromptDialog, { open: true, title: 'Save as preset', placeholder: 'Preset name' });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Save as preset');
    expect(input().placeholder).toBe('Preset name');
    expect(document.activeElement).toBe(input());
    expect(button('Save').disabled).toBe(true);
    await type('  name  ', fixture);
    expect(button('Save').disabled).toBe(false);
  });

  it('confirms the trimmed draft on Save and on Enter', async () => {
    const { fixture } = await render(PromptDialog, { open: true, title: 'Save as preset' });
    const got: string[] = [];
    fixture.componentInstance.confirm.subscribe((v) => got.push(v));
    await type(' one ', fixture);
    button('Save').click();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(got).toEqual(['one', 'one']);
  });

  it('does not confirm a blank draft on Enter', async () => {
    const { fixture } = await render(PromptDialog, { open: true, title: 'Save as preset' });
    const got: string[] = [];
    fixture.componentInstance.confirm.subscribe((v) => got.push(v));
    await type('   ', fixture);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(got).toEqual([]);
  });

  it('emits cancel from the Cancel button', async () => {
    const { fixture } = await render(PromptDialog, { open: true, title: 'Save as preset' });
    let n = 0;
    fixture.componentInstance.cancel.subscribe(() => n++);
    button('Cancel').click();
    expect(n).toBe(1);
  });
});
