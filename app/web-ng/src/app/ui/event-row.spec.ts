import { render } from '../../testing/render';
import type { StreamEvent } from '../lib/events';
import { EventRow } from './event-row';

describe('EventRow markdown routing', () => {
  it('renders assistant.text markdown through MarkdownBody (shows .k-md and <strong>)', async () => {
    const { container } = await render(EventRow, {
      ev: { type: 'assistant.text', text: 'Result is **success**.' } as StreamEvent,
    });
    expect(container.querySelector('.k-md')).not.toBeNull();
    expect(container.querySelector('strong')).not.toBeNull();
    expect(container.querySelector('strong')!.textContent).toBe('success');
  });

  it('renders tool.result as plain text, no .k-md wrapper', async () => {
    const { container } = await render(EventRow, {
      ev: { type: 'tool.result', name: 'Bash', ok: true, summary: '27 passed / 3 failed' } as StreamEvent,
    });
    expect(container.querySelector('.k-md')).toBeNull();
    expect(container.textContent).toContain('27 passed / 3 failed');
  });

  it('renders log events as plain text, no .k-md wrapper', async () => {
    const { container } = await render(EventRow, {
      ev: { type: 'log', level: 'info', message: 'assembled plugin-dir: 1 skill' } as StreamEvent,
    });
    expect(container.querySelector('.k-md')).toBeNull();
    expect(container.textContent).toContain('assembled plugin-dir');
  });

  it('renders a turn as a divider rule with no inline style', async () => {
    const { container } = await render(EventRow, {
      ev: { type: 'turn', n: 2 } as unknown as StreamEvent,
    });
    const rule = container.querySelector('.k-event__turn-rule');
    expect(rule).not.toBeNull();
    expect(rule!.getAttribute('style')).toBeNull();
  });

  it('keeps assistant raw HTML inert', async () => {
    const { container } = await render(EventRow, {
      ev: { type: 'assistant.text', text: '<img src=x onerror=alert(1)><script>alert(1)</script>ok' } as StreamEvent,
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('ok');
  });
});
