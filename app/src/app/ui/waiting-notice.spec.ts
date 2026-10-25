import { render } from '../../testing/render';
import { WaitingNotice, type WaitingItem } from './waiting-notice';

const ASK: WaitingItem = { repo: 'api', kind: 'answer', countdown: '59:30', waited: '1:23' };
const APPROVAL: WaitingItem = { repo: 'app', kind: 'approval', countdown: '0:45', waited: '0:07' };
const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const mount = (inputs: Record<string, unknown> = {}) => render(WaitingNotice, { items: [ASK], ...inputs });

describe('WaitingNotice', () => {
  it('names the repository, what the agent waits for and how long it waits, per run', async () => {
    const { container } = await mount({ items: [ASK, APPROVAL] });
    const lines = Array.from(container.querySelectorAll('[data-waiting]')).map((e) => norm(e.textContent));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('The agent in api is waiting for your answer.');
    expect(lines[0]).toContain('It stops if nobody answers within 59:30.');
    expect(lines[1]).toContain('The agent in app is waiting for your approval.');
    expect(lines[1]).toContain('It stops if nobody answers within 0:45.');
  });

  it('says how long the agent has waited, in the full and the compact form, with or without a deadline', async () => {
    const items = [ASK, { ...APPROVAL, countdown: null }];
    const full = await mount({ items });
    const lines = Array.from(full.container.querySelectorAll('[data-waiting]')).map((e) => norm(e.textContent));
    expect(lines[0]).toContain('The agent in api is waiting for your answer. It has waited 1:23.');
    expect(lines[1]).toContain('The agent in app is waiting for your approval. It has waited 0:07.');
    expect(lines[1]).not.toContain('It stops if');
  });

  it('says how long the agent has waited in the compact form too', async () => {
    const items = [ASK, { ...APPROVAL, countdown: null }];
    const compact = await mount({ compact: true, items });
    const short = Array.from(compact.container.querySelectorAll('[data-waiting]')).map((e) => norm(e.textContent));
    expect(short[0]).toContain('The agent in api is waiting for you. It has waited 1:23.');
    expect(short[1]).toContain('The agent in app is waiting for you. It has waited 0:07.');
  });

  it('shows an amber dot with the words, never the colour alone', async () => {
    const { container } = await mount();
    expect(container.querySelector('.k-status--warning .k-status__dot')).not.toBeNull();
  });

  it('leaves the countdown out when the run has no deadline', async () => {
    const { container } = await mount({ items: [{ ...ASK, countdown: null }] });
    expect(norm(container.textContent)).toContain('The agent in api is waiting for your answer.');
    expect(norm(container.textContent)).not.toContain('It stops if');
  });

  it('says where to go with a button per run, and reports the repository on click', async () => {
    const { container, fixture } = await mount({ items: [ASK, APPROVAL] });
    const went = vi.fn();
    fixture.componentInstance.goTo.subscribe(went);
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((b) => norm(b.textContent))).toEqual(['Go to api', 'Go to app']);
    buttons[1].click();
    expect(went).toHaveBeenCalledWith('app');
  });

  it('cannot be dismissed', async () => {
    const { container } = await mount();
    expect(Array.from(container.querySelectorAll('button')).map((b) => norm(b.textContent))).toEqual(['Go to api']);
  });

  it('compact is one line per run that says the agent waits for you', async () => {
    const { container } = await mount({ compact: true, items: [ASK, APPROVAL] });
    const lines = Array.from(container.querySelectorAll('[data-waiting]')).map((e) => norm(e.textContent));
    expect(lines).toEqual([
      'The agent in api is waiting for you. It has waited 1:23. Go to api',
      'The agent in app is waiting for you. It has waited 0:07. Go to app',
    ]);
  });

  it('shows nothing when no run waits', async () => {
    const { container } = await mount({ items: [] });
    expect(container.querySelector('[data-waiting]')).toBeNull();
  });
});
