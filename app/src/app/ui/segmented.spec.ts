import { render } from '../../testing/render';
import { Segmented } from './segmented';

describe('Segmented', () => {
  it('marks the current value and writes the clicked one back', async () => {
    const { container, fixture } = await render(Segmented, {
      options: [
        { value: 'append', label: 'Append' },
        { value: 'replace', label: 'Replace' },
      ],
      value: 'append',
    });
    const buttons = [...container.querySelectorAll('button')];
    expect(container.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(buttons[0].getAttribute('role')).toBe('radio');
    expect(buttons[0].getAttribute('aria-checked')).toBe('true');
    expect(buttons[1].getAttribute('aria-checked')).toBe('false');
    expect(buttons[0].getAttribute('data-state')).toBe('on');
    expect(buttons[1].getAttribute('data-state')).toBe('off');
    buttons[1].click();
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('replace');
    expect(buttons[1].getAttribute('data-state')).toBe('on');
  });
});
