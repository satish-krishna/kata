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

  it('renders a turn as a separator marker carrying "turn N"', async () => {
    const { container } = await render(EventRow, {
      ev: { type: 'turn', n: 3 } as unknown as StreamEvent,
    });
    const marker = container.querySelector('hlm-marker');
    expect(marker).not.toBeNull();
    expect(marker!.getAttribute('data-variant')).toBe('separator');
    expect(marker!.textContent!.trim()).toBe('turn 3');
    expect(container.querySelector('.k-event__turn-rule')).toBeNull();
    // the marker carries the label; no second "turn 3" gutter
    expect(container.textContent!.match(/turn 3/g)).toHaveLength(1);
  });

  it('renders no marker for non-turn rows', async () => {
    const { container } = await render(EventRow, {
      ev: { type: 'log', level: 'info', message: 'hello' } as StreamEvent,
    });
    expect(container.querySelector('hlm-marker')).toBeNull();
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
