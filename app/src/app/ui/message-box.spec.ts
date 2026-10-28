import { render } from '../../testing/render';
import type { MessageBoxView } from '../lib/events';
import { MessageBox } from './message-box';

const RUNNING: MessageBoxView = { shown: true, enabled: true, note: 'The agent reads this before its next step.', restore: null };

async function mount(view: MessageBoxView = RUNNING) {
  const r = await render(MessageBox, { view });
  const send = vi.fn();
  r.fixture.componentInstance.send.subscribe(send);
  const field = () => r.container.querySelector('input') as HTMLInputElement;
  const button = () => r.container.querySelector('button') as HTMLButtonElement;
  const type = async (value: string) => {
    field().value = value;
    field().dispatchEvent(new Event('input'));
    await r.fixture.whenStable();
  };
  return { ...r, send, field, button, type };
}

describe('MessageBox', () => {
  it('shows the note', async () => {
    const m = await mount();
    expect(m.container.textContent).toContain('The agent reads this before its next step.');
  });

  it('cannot send blank text', async () => {
    const m = await mount();
    expect(m.button().disabled).toBe(true);
    await m.type('   ');
    expect(m.button().disabled).toBe(true);
    m.button().click();
    expect(m.send).not.toHaveBeenCalled();
  });

  it('sends the text with Enter and clears the field', async () => {
    const m = await mount();
    await m.type('Stop editing the parser');
    expect(m.button().disabled).toBe(false);
    m.field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await m.fixture.whenStable();
    expect(m.send).toHaveBeenCalledWith('Stop editing the parser');
    expect(m.field().value).toBe('');
  });

  it('sends with the button too', async () => {
    const m = await mount();
    await m.type('go on');
    m.button().click();
    await m.fixture.whenStable();
    expect(m.send).toHaveBeenCalledWith('go on');
    expect(m.field().value).toBe('');
  });

  it('disables the field and the button when the view is disabled', async () => {
    const m = await mount({ shown: true, enabled: false, note: 'Answer the question first', restore: null });
    expect(m.field().disabled).toBe(true);
    expect(m.button().disabled).toBe(true);
  });

  it('puts a restored text back in the field', async () => {
    const m = await mount();
    m.fixture.componentRef.setInput('view', { ...RUNNING, note: 'Not sent', restore: 'my words' });
    await m.fixture.whenStable();
    expect(m.field().value).toBe('my words');
  });
});
