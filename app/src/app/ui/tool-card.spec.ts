import { render } from '../../testing/render';
import { within } from '@testing-library/dom';
import type { StreamEvent } from '../lib/events';
import { pairToolEvents, type ToolCall } from '../lib/toolcards';
import { ToolCard } from './tool-card';

const callOf = (events: Record<string, unknown>[]): ToolCall => {
  const it = pairToolEvents(events as unknown as StreamEvent[])[0];
  if (it.kind !== 'call') throw new Error('not a call');
  return it.call;
};
const use = (name: string, input?: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'tool.use',
  name,
  input_summary: `${name} summary`,
  id: 'i',
  ...(input !== undefined ? { input } : {}),
  ...extra,
});
const res = (name: string, ok = true, extra: Record<string, unknown> = {}) => ({
  type: 'tool.result',
  name,
  ok,
  summary: `${name} result summary`,
  id: 'i',
  ...extra,
});
const raw = { normalizer: (s: string) => s };

describe('ToolCard', () => {
  it('renders an Edit open, as a diff, with a status label', async () => {
    const { container } = await render(ToolCard, {
      call: callOf([
        use('Edit', { file_path: 'src/claim.rs', old_string: 'if now > t {', new_string: 'if now >= t {' }),
        res('Edit'),
      ]),
    });
    const q = within(container);
    expect(q.getByText('src/claim.rs')).toBeTruthy();
    expect(q.getByText('ok')).toBeTruthy();
    expect(container.querySelector('[data-slot=code-block-line][data-variant=removed]')!.textContent).toContain('if now > t {');
    expect(container.querySelector('[data-slot=code-block-line][data-variant=added]')!.textContent).toContain('if now >= t {');
  });

  it('renders a Read collapsed and opens it on click', async () => {
    const { container, fixture } = await render(ToolCard, {
      call: callOf([use('Read', { file_path: 'a.rs' }), res('Read', true, { output: '1\tfn main() {}' })]),
    });
    const q = within(container);
    expect(q.queryByText('1\tfn main() {}', raw)).toBeNull();
    const row = q.getByRole('button', { name: /Read/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    row.click();
    await fixture.whenStable();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(q.getByText('1\tfn main() {}', raw)).toBeTruthy();
  });

  it('opens a failed Edit and shows the error under the diff', async () => {
    const { container } = await render(ToolCard, {
      call: callOf([
        use('Edit', { file_path: 'a.rs', old_string: 'x', new_string: 'y' }),
        res('Edit', false, { output: 'old_string not found' }),
      ]),
    });
    const q = within(container);
    expect(q.getByText('error')).toBeTruthy();
    expect(q.getByText('old_string not found')).toBeTruthy();
  });

  it('shows a running call with its label and no body', async () => {
    const { container } = await render(ToolCard, { call: callOf([use('Bash', { command: 'cargo test' })]) });
    const q = within(container);
    expect(q.getByText('running…')).toBeTruthy();
    expect(q.getByRole('button', { name: /Bash/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('renders a TodoWrite as a checklist', async () => {
    const { container } = await render(ToolCard, {
      call: callOf([
        use('TodoWrite', {
          todos: [
            { content: 'reproduce', status: 'completed' },
            { content: 'fix', status: 'in_progress' },
            { content: 'ship', status: 'pending' },
          ],
        }),
        res('TodoWrite'),
      ]),
    });
    expect(within(container).getByText('1 / 3')).toBeTruthy();
    expect(container.querySelector('.k-toolcard__todo-item--completed')!.textContent).toContain('reproduce');
    expect(container.querySelector('.k-toolcard__todo-item--in_progress')!.textContent).toContain('fix');
  });

  it('nests a subagent calls inside its body', async () => {
    const { container, fixture } = await render(ToolCard, {
      call: callOf([
        use('Agent', { subagent_type: 'Explore', description: 'find checks', prompt: 'Find every expiry check' }, { id: 'A' }),
        { type: 'tool.use', name: 'Grep', input_summary: 'expires_at', id: 'B', parent_id: 'A', input: { pattern: 'expires_at' } },
        { type: 'tool.result', name: 'Grep', ok: true, summary: '7', id: 'B', parent_id: 'A', output: 'a.rs:1' },
        { type: 'tool.result', name: 'Agent', ok: true, summary: 'done', id: 'A', output: 'lease.rs has the bug' },
      ]),
    });
    const q = within(container);
    q.getByRole('button', { name: /Agent/ }).click();
    await fixture.whenStable();
    expect(q.getByText('Find every expiry check')).toBeTruthy();
    expect(q.getByRole('button', { name: /Grep/ })).toBeTruthy();
    expect(q.getByText('lease.rs has the bug')).toBeTruthy();
  });

  it('matches the older Task name for subagents', async () => {
    const { container } = await render(ToolCard, {
      call: callOf([use('Task', { subagent_type: 'general-purpose', description: 'look' })]),
    });
    expect(within(container).getByText('general-purpose: look')).toBeTruthy();
  });

  it('shows summaries when the run carried no payloads', async () => {
    const { container, fixture } = await render(ToolCard, { call: callOf([use('Edit'), res('Edit')]) });
    const q = within(container);
    q.getByRole('button', { name: /Edit/ }).click();
    await fixture.whenStable();
    expect(q.getAllByText('Edit summary').length).toBeGreaterThan(0);
    expect(q.getByText('Edit result summary')).toBeTruthy();
  });

  it('marks a truncated output', async () => {
    const { container, fixture } = await render(ToolCard, {
      call: callOf([use('Read', { file_path: 'big.min.js' }), res('Read', true, { output: 'x', truncated: true })]),
    });
    const q = within(container);
    q.getByRole('button', { name: /Read/ }).click();
    await fixture.whenStable();
    expect(q.getByText('… truncated at 256 KB')).toBeTruthy();
  });

  it('skips non-object MultiEdit elements instead of crashing', async () => {
    const { container } = await render(ToolCard, {
      call: callOf([
        use('MultiEdit', { file_path: 'a.rs', edits: [null, { old_string: 'a', new_string: 'b' }] }),
        res('MultiEdit'),
      ]),
    });
    expect(container.querySelectorAll('app-diff-body hlm-code-block')).toHaveLength(1);
  });

  it('exposes the row as the .k-toolcard__row button the parity capture clicks', async () => {
    const { container } = await render(ToolCard, { call: callOf([use('Read', { file_path: 'a.rs' }), res('Read')]) });
    const row = container.querySelector('.k-toolcard__row') as HTMLButtonElement;
    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });
  it('the row is a collapsible trigger wired to its body', async () => {
    const { container, fixture } = await render(ToolCard, {
      call: callOf([use('Read', { file_path: 'a.rs' }), res('Read', true, { output: 'x' })]),
    });
    const row = container.querySelector('.k-toolcard__row') as HTMLButtonElement;
    const body = container.querySelector('[data-slot=trace-collapsible-content]') as HTMLElement;
    expect(body.id).not.toBe('');
    expect(row.getAttribute('aria-controls')).toBe(body.id);
    expect(row.getAttribute('aria-expanded')).toBe('false');
    row.click();
    await fixture.whenStable();
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('a closed card renders no body content and its body is inert', async () => {
    const { container } = await render(ToolCard, {
      call: callOf([use('Read', { file_path: 'a.rs' }), res('Read', true, { output: 'x' })]),
    });
    expect(container.querySelector('pre[hlmCodeBlockContent]')).toBeNull();
    expect(container.querySelector('[data-slot=trace-collapsible-content]')!.hasAttribute('inert')).toBe(true);
  });

  it('a call that turns to error after render opens itself, and the operator click still wins', async () => {
    const running = callOf([use('Read', { file_path: 'a.rs' })]);
    const failed = callOf([use('Read', { file_path: 'a.rs' }), res('Read', false, { output: 'boom' })]);
    const { container, fixture } = await render(ToolCard, { call: running });
    const row = container.querySelector('.k-toolcard__row') as HTMLButtonElement;
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fixture.componentRef.setInput('call', failed);
    await fixture.whenStable();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(within(container).getByText('boom')).toBeTruthy();
    row.click();
    await fixture.whenStable();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-slot=trace-collapsible-content]')!.hasAttribute('inert')).toBe(true);
  });

  it.each([
    ['ok', [use('Read', { file_path: 'a.rs' }), res('Read')]],
    ['error', [use('Read', { file_path: 'a.rs' }), res('Read', false)]],
    ['running…', [use('Read', { file_path: 'a.rs' })]],
  ])('the status label %s is visible beside the dot', async (label, events) => {
    const { container } = await render(ToolCard, { call: callOf(events as Record<string, unknown>[]) });
    const row = container.querySelector('.k-toolcard__row') as HTMLElement;
    expect(within(row).getByText(label)).toBeTruthy();
    expect(row.querySelector('.k-toolcard__dot')).not.toBeNull();
  });
});
