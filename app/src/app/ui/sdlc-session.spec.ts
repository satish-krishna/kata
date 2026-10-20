import { render } from '../../testing/render';
import { seedSpec } from '../lib/mock';
import { SdlcSession } from './sdlc-session';

const base = {
  title: 'Starting a change',
  finished: null,
  elapsed: 75,
  deadlineSecs: null,
  closeBlocked: false,
  state: 'running',
  events: [],
  spec: seedSpec(),
  summary: null,
  asks: [],
  permissions: [],
};
const mount = (inputs: Record<string, unknown> = {}) => render(SdlcSession, { ...base, ...inputs });
const button = (c: HTMLElement, name: string) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === name);

describe('SdlcSession', () => {
  it('is the page main region, titled by the run, with the elapsed clock and the observe pane', async () => {
    const { container } = await mount();
    const main = container.querySelector('main')!;
    expect(main.querySelector('h1')!.textContent!.trim()).toBe('Starting a change');
    expect(main.getAttribute('aria-labelledby')).toBe(main.querySelector('h1')!.id);
    expect(container.textContent).toContain('1:15');
    expect(container.querySelector('app-observe-pane')).not.toBeNull();
  });

  it('offers Cancel, and no Close, while the run is live', async () => {
    const { container, fixture } = await mount();
    const cancel = vi.fn();
    fixture.componentInstance.cancel.subscribe(cancel);
    expect(button(container, 'Close')).toBeUndefined();
    button(container, 'Cancel')!.click();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('offers Close, and no Cancel, once the run has ended', async () => {
    const { container, fixture } = await mount({ finished: 'success', state: 'success' });
    const close = vi.fn();
    fixture.componentInstance.close.subscribe(close);
    expect(button(container, 'Cancel')).toBeUndefined();
    button(container, 'Close')!.click();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('holds Close while something still needs a decision', async () => {
    const { container } = await mount({ finished: 'warning', state: 'warning', closeBlocked: true });
    expect(button(container, 'Close')!.disabled).toBe(true);
  });

  it('names the answer deadline while a question waits', async () => {
    const { container } = await mount({ deadlineSecs: 90 });
    expect(container.textContent).toContain('exits 123 if unanswered in 1:30');
  });

  it('drops the answer deadline once the run has ended', async () => {
    const { container } = await mount({ deadlineSecs: 90, finished: 'warning', state: 'warning' });
    expect(container.textContent).not.toContain('exits 123');
  });
});
