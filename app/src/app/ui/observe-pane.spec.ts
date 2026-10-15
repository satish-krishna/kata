import { render } from '../../testing/render';
import type { PermissionRecord, StreamEvent } from '../lib/events';
import { defaultSpec } from '../lib/spec';
import { ObservePane } from './observe-pane';

/* The pane is the wiring between the run store's data and the components that
 * draw it. The card and the row are each covered in isolation elsewhere; what
 * only this file can catch is the pane handing them the wrong data, or not
 * rendering them at all. */

const PENDING: PermissionRecord = {
  id: 'p1',
  tool: 'Bash',
  input_summary: 'git -C ./.kata/wt-3f9a diff --stat',
  decided: null,
  at: 0,
};

const DECIDED_BY_POLICY: StreamEvent = {
  type: 'permission.decided',
  id: 'd1',
  tool: 'Bash',
  input_summary: 'dotnet test --filter AuthTests.LoginExpiry',
  allow: true,
  decided_by: 'unmatched-policy',
};

async function renderPane(over: Record<string, unknown> = {}) {
  const r = await render(ObservePane, {
    state: 'running',
    events: [],
    spec: defaultSpec(),
    summary: null,
    asks: [],
    permissions: [],
    ...over,
  });
  const answer = vi.fn();
  const decide = vi.fn();
  r.fixture.componentInstance.answer.subscribe(answer);
  r.fixture.componentInstance.decide.subscribe(decide);
  const text = () => r.container.textContent ?? '';
  const button = (name: string) =>
    Array.from(r.container.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === name)!;
  const order = (a: string, b: string) =>
    [...r.container.querySelectorAll('.k-event, .k-ask')].map((el) => (el.classList.contains('k-ask') ? a : b));
  return { ...r, answer, decide, text, button, order };
}

describe('ObservePane - the approval card', () => {
  it('renders a card for an undecided permission record', async () => {
    const m = await renderPane({ state: 'awaiting', permissions: [PENDING] });
    expect(m.text()).toContain('Allow this tool call?');
    expect(m.text()).toContain('Bash');
    expect(m.text()).toContain('git -C ./.kata/wt-3f9a diff --stat');
    expect(m.text()).toContain('awaiting your decision');
  });

  it("forwards the operator's verdict to decide with the record's id", async () => {
    const m = await renderPane({ state: 'awaiting', permissions: [PENDING] });
    m.button('Allow · resume').click();
    await m.fixture.whenStable();
    expect(m.decide).toHaveBeenCalledWith({ id: 'p1', allow: true, message: null });
  });

  it('renders a settled record read-only, with no way to decide it again', async () => {
    const m = await renderPane({
      permissions: [{ ...PENDING, decided: { allow: false, message: 'not on this branch' } }],
    });
    expect(m.text()).toContain('denied · run resumed');
    expect(m.text()).toContain('not on this branch');
    expect(m.container.querySelector('textarea')).toBeNull();
    expect(m.button('Deny').disabled).toBe(true);
    expect(m.decide).not.toHaveBeenCalled();
  });

  it('keeps multiple checks distinct rather than collapsing them', async () => {
    const m = await renderPane({
      state: 'awaiting',
      permissions: [
        PENDING,
        { id: 'p2', tool: 'Write', input_summary: 'src/Auth/TokenValidator.cs', decided: null, at: 0 },
      ],
    });
    expect(m.text().split('Allow this tool call?').length - 1).toBe(2);
    expect(m.text()).toContain('git -C ./.kata/wt-3f9a diff --stat');
    expect(m.text()).toContain('src/Auth/TokenValidator.cs');
  });
});

describe('ObservePane - the audit row', () => {
  it('renders an auto-resolved allow as a success row naming the rule', async () => {
    const { container } = await renderPane({ events: [DECIDED_BY_POLICY] });
    const row = container.querySelector('.k-event--result-ok');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('allowed');
    expect(row!.textContent).toContain('dotnet test --filter AuthTests.LoginExpiry');
    expect(row!.textContent).toContain('unmatched-policy');
  });

  it('renders an auto-resolved deny as an error row', async () => {
    const { container } = await renderPane({
      events: [{ ...DECIDED_BY_POLICY, id: 'd2', allow: false, decided_by: 'unmatched-policy' }],
    });
    const row = container.querySelector('.k-event--result-err');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('denied');
    expect(row!.textContent).toContain('unmatched-policy');
  });

  it('shows an audit row and an open card together - the two paths are independent', async () => {
    const m = await renderPane({ state: 'awaiting', events: [DECIDED_BY_POLICY], permissions: [PENDING] });
    expect(m.container.querySelector('.k-event--result-ok')).not.toBeNull();
    expect(m.text()).toContain('Allow this tool call?');
  });
});

describe('ObservePane - the empty state', () => {
  it('shows the empty state when nothing has arrived', async () => {
    const m = await renderPane();
    expect(m.text()).toMatch(/normalized event stream renders here/);
  });

  it('does not show the empty state when only a permission card is present', async () => {
    const m = await renderPane({ state: 'awaiting', permissions: [PENDING] });
    expect(m.text()).not.toMatch(/normalized event stream renders here/);
  });
});

describe('ObservePane - a card renders where the check happened', () => {
  it('splices the card between the events it sat between, not at the end', async () => {
    const m = await renderPane({
      state: 'awaiting',
      events: [DECIDED_BY_POLICY, { ...DECIDED_BY_POLICY, id: 'd2' }],
      permissions: [{ ...PENDING, at: 1 }],
    });
    expect(m.order('card', 'event')).toEqual(['event', 'card', 'event']);
  });

  it('puts a card before every event when it arrived first', async () => {
    const m = await renderPane({
      state: 'awaiting',
      events: [DECIDED_BY_POLICY],
      permissions: [{ ...PENDING, at: 0 }],
    });
    expect(m.order('card', 'event')).toEqual(['card', 'event']);
  });

  it('keeps a card whose position outran the stream rather than dropping it', async () => {
    const m = await renderPane({ state: 'awaiting', events: [], permissions: [{ ...PENDING, at: 7 }] });
    expect(m.text()).toContain('Allow this tool call?');
  });
});

describe('ObservePane - asks render where they happened too', () => {
  const ASK = {
    id: 'q1',
    questions: [{ kind: 'text' as const, header: 'scope', question: 'Fix or isolate?', optional: false }],
    answers: null,
    at: 1,
  };

  it('splices an ask between the events it sat between', async () => {
    const m = await renderPane({
      state: 'awaiting',
      events: [DECIDED_BY_POLICY, { ...DECIDED_BY_POLICY, id: 'd2' }],
      asks: [ASK],
    });
    expect(m.order('panel', 'event')).toEqual(['event', 'panel', 'event']);
  });

  it('orders a permission and an ask deterministically at the same position', async () => {
    const m = await renderPane({
      state: 'awaiting',
      events: [DECIDED_BY_POLICY],
      permissions: [{ ...PENDING, at: 1 }],
      asks: [{ ...ASK, at: 1 }],
    });
    const panels = [...m.container.querySelectorAll('.k-ask')];
    expect(panels).toHaveLength(2);
    expect(panels[0].textContent).toContain('Allow this tool call?');
    expect(panels[1].textContent).toContain('Fix or isolate?');
  });

  it('forwards an answer to answer with the ask id', async () => {
    const m = await renderPane({ state: 'awaiting', asks: [ASK] });
    const ta = m.container.querySelector('textarea')!;
    ta.value = 'isolate';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await m.fixture.whenStable();
    m.button('Send answer · resume').click();
    await m.fixture.whenStable();
    expect(m.answer).toHaveBeenCalledWith({ id: 'q1', answers: [['isolate']] });
  });

  it('keeps an open ask panel (and what was typed) when more events arrive', async () => {
    const m = await renderPane({ state: 'awaiting', asks: [ASK] });
    const ta = m.container.querySelector('textarea')!;
    ta.value = 'half-typed';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await m.fixture.whenStable();
    m.fixture.componentRef.setInput('events', [DECIDED_BY_POLICY]);
    m.fixture.componentRef.setInput('asks', [{ ...ASK, at: 0 }]);
    await m.fixture.whenStable();
    expect(m.container.querySelector('textarea')).toBe(ta);
    expect(ta.value).toBe('half-typed');
  });
});

describe('ObservePane - tool calls', () => {
  it('renders a paired call as one rail row, not two log rows', async () => {
    const m = await renderPane({
      events: [
        { type: 'tool.use', name: 'Read', input_summary: 'src/a.rs', id: 't1', input: { file_path: 'src/a.rs' } },
        { type: 'tool.result', name: 'Read', ok: true, summary: '12 lines', id: 't1', output: '1\tfn a() {}' },
      ],
    });
    expect(m.container.querySelectorAll('.k-toolcard__row')).toHaveLength(1);
    expect(m.text()).toContain('ok');
    expect(m.text()).not.toContain('12 lines');
  });

  it('still renders id-less events from old transcripts as log rows', async () => {
    const m = await renderPane({ events: [{ type: 'tool.use', name: 'Bash', input_summary: 'ls -la' }] });
    expect(m.text()).toContain('ls -la');
  });
});

describe('ObservePane - status and summary', () => {
  it('shows the run state label and the model', async () => {
    const m = await renderPane({ state: 'running' });
    expect(m.container.querySelector('.k-status--running')?.textContent).toContain('Running');
    expect(m.container.querySelector('.wb-status__meta')?.textContent).toContain('default');
  });

  it('badges a worktree run', async () => {
    const spec = defaultSpec();
    spec.leash.isolation = 'worktree';
    const m = await renderPane({ spec });
    expect(m.container.querySelector('.k-badge--warning')?.textContent).toContain('worktree');
  });

  it('renders the summary stats and result', async () => {
    const m = await renderPane({
      state: 'success',
      summary: {
        type: 'run.completed',
        exit_code: 0,
        is_error: false,
        num_turns: 3,
        cost_usd: 0.0123,
        duration_ms: 4500,
        result: 'all done',
      },
    });
    const s = m.container.querySelector('.wb-summary')!;
    expect(s.querySelector('.k-badge--success')).not.toBeNull();
    expect(s.textContent).toContain('$0.012');
    expect(s.textContent).toContain('4.5s');
    expect(s.querySelector('.wb-summary__result')?.textContent).toContain('all done');
  });
});

describe('ObservePane - auto-scroll', () => {
  function geometry(el: HTMLElement, h: { top: number; height: number; client: number }) {
    let top = h.top;
    Object.defineProperty(el, 'scrollHeight', { get: () => h.height, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => h.client, configurable: true });
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v) => (top = v), configurable: true });
    return () => top;
  }

  it('sticks to the bottom when new events arrive and the reader is at the bottom', async () => {
    const m = await renderPane();
    const el = m.container.querySelector('.wb-stream') as HTMLElement;
    const top = geometry(el, { top: 0, height: 500, client: 500 });
    m.fixture.componentRef.setInput('events', [DECIDED_BY_POLICY]);
    await m.fixture.whenStable();
    expect(top()).toBe(500);
  });

  it('does not yank a reader who scrolled up', async () => {
    const m = await renderPane();
    const el = m.container.querySelector('.wb-stream') as HTMLElement;
    const top = geometry(el, { top: 0, height: 2000, client: 500 });
    el.dispatchEvent(new Event('scroll'));
    m.fixture.componentRef.setInput('events', [DECIDED_BY_POLICY]);
    await m.fixture.whenStable();
    expect(top()).toBe(0);
  });
});

describe('ObservePane - settling replays the enter animation', () => {
  it('remounts the wrapper of a permission when it settles', async () => {
    const m = await renderPane({ state: 'awaiting', permissions: [PENDING] });
    const before = m.container.querySelector('.wb-event-enter');
    m.fixture.componentRef.setInput('permissions', [{ ...PENDING, decided: { allow: true, message: null } }]);
    await m.fixture.whenStable();
    const after = m.container.querySelector('.wb-event-enter');
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it('remounts the wrapper of an ask when it is answered', async () => {
    const ask = {
      id: 'q1',
      questions: [{ kind: 'text' as const, header: 'scope', question: 'Fix or isolate?', optional: false }],
      answers: null,
      at: 0,
    };
    const m = await renderPane({ state: 'awaiting', asks: [ask] });
    const before = m.container.querySelector('.wb-event-enter');
    m.fixture.componentRef.setInput('asks', [{ ...ask, answers: [['isolate']] }]);
    await m.fixture.whenStable();
    const after = m.container.querySelector('.wb-event-enter');
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });
});
