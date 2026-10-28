import { render } from '../../testing/render';
import type { MessageRecord } from '../lib/events';
import { OperatorMessage } from './operator-message';

const clock = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const SENT = 1_700_000_000_000;
const READ = SENT + 5_000;
const rec = (read_at: number | null): MessageRecord => ({ id: 'm1', text: 'look at the lexer', sent_at: SENT, read_at, at: 0 });

describe('OperatorMessage', () => {
  it('shows the text, the waiting label and the send time', async () => {
    const { container } = await render(OperatorMessage, { record: rec(null) });
    const t = container.textContent ?? '';
    expect(t).toContain('look at the lexer');
    expect(t).toContain('waiting');
    expect(t).toContain(`sent ${clock(SENT)}`);
    expect(t).not.toContain('read ');
  });

  it('shows the read label and the read time once read', async () => {
    const { container } = await render(OperatorMessage, { record: rec(READ) });
    const t = container.textContent ?? '';
    expect(t).toContain(`read ${clock(READ)}`);
    expect(t).not.toContain('waiting');
  });

  it('pairs the waiting label with a status dot', async () => {
    const { container } = await render(OperatorMessage, { record: rec(null) });
    const badge = container.querySelector('[data-message-state="waiting"]');
    expect(badge?.querySelector('.k-status__dot')).not.toBeNull();
  });

  it('pairs the read label with a status dot', async () => {
    const { container } = await render(OperatorMessage, { record: rec(READ) });
    const badge = container.querySelector('[data-message-state="read"]');
    expect(badge?.querySelector('.k-status__dot')).not.toBeNull();
  });
});
