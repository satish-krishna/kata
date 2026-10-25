import type { InstructionsState } from '@bindings/InstructionsState';
import { render } from '../../testing/render';
import { InstructionsRow } from './instructions-row';

const text = (c: HTMLElement) => c.textContent!.replace(/\s+/g, ' ');
const button = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button');
const status = (c: HTMLElement) => c.querySelector<HTMLElement>('.k-status');

describe('InstructionsRow', () => {
  const cases: [InstructionsState, string, string, string | null][] = [
    ['missing', 'missing', 'warning', 'Write instructions'],
    ['out-of-date', 'out of date', 'warning', 'Refresh instructions'],
    ['current', 'current', 'success', null],
  ];

  it.each(cases)('shows %s with its word, tone and button', async (state, word, tone, label) => {
    const { container } = await render(InstructionsRow, { state });
    expect(text(container)).toContain('Workspace instructions');
    expect(status(container)!.textContent!.trim()).toBe(word);
    expect(status(container)!.classList.contains(`k-status--${tone}`)).toBe(true);
    expect(status(container)!.querySelector('.k-status__dot')).not.toBeNull();
    expect(button(container)?.textContent!.trim() ?? null).toBe(label);
  });

  it('emits refresh when the button is clicked', async () => {
    const { fixture, container } = await render(InstructionsRow, { state: 'out-of-date' });
    let n = 0;
    fixture.componentInstance.refresh.subscribe(() => n++);
    button(container)!.click();
    expect(n).toBe(1);
  });

  it('disables the button while another task runs', async () => {
    const { container } = await render(InstructionsRow, { state: 'missing', disabled: true });
    expect(button(container)!.disabled).toBe(true);
  });
});
