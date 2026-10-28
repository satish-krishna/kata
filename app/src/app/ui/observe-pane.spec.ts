import { render } from '../../testing/render';
import type { PermissionRecord, StreamEvent } from '../lib/events';
import { defaultSpec } from '../lib/spec';
import { runGivenFixture } from '../lib/library';
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
    expect(m.container.querySelector('hlm-empty')).not.toBeNull();
    expect(m.container.querySelector('hlm-empty')!.textContent).toContain(
      'Press Run to drive claude -p to completion. The normalized event stream renders here.',
    );
  });

  it('does not show the empty state when only a permission card is present', async () => {
    const m = await renderPane({ state: 'awaiting', permissions: [PENDING] });
    expect(m.container.querySelector('hlm-empty')).toBeNull();
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
    const ta = m.container.querySelector<HTMLInputElement>('input[hlmQuestionnaireInput]')!;
    ta.value = 'isolate';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await m.fixture.whenStable();
    m.button('Send answer · resume').click();
    await m.fixture.whenStable();
    expect(m.answer).toHaveBeenCalledWith({ id: 'q1', answers: [['isolate']] });
  });

  it('keeps an open ask panel (and what was typed) when more events arrive', async () => {
    const m = await renderPane({ state: 'awaiting', asks: [ASK] });
    const ta = m.container.querySelector<HTMLInputElement>('input[hlmQuestionnaireInput]')!;
    ta.value = 'half-typed';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await m.fixture.whenStable();
    m.fixture.componentRef.setInput('events', [DECIDED_BY_POLICY]);
    m.fixture.componentRef.setInput('asks', [{ ...ASK, at: 0 }]);
    await m.fixture.whenStable();
    expect(m.container.querySelector('input[hlmQuestionnaireInput]')).toBe(ta);
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

  it('leaves the model and isolation meta out when the run has no spec', async () => {
    const m = await renderPane({ spec: null });
    expect(m.container.querySelector('.wb-status__meta')).toBeNull();
    expect(m.container.querySelector('.k-badge--warning')).toBeNull();
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

describe('ObservePane - the stream scroller', () => {
  const ASK = {
    id: 'q1',
    questions: [{ kind: 'text' as const, header: 'scope', question: 'Fix or isolate?', optional: false }],
    answers: null,
    at: 1,
  };

  // jsdom has no layout, so the viewport's geometry is stood in for: a 500px
  // window over 2000px of content. Items report their bottom edge at the end
  // of the content; the viewport reports itself at the origin.
  function geometry(el: HTMLElement, start: number) {
    let top = start;
    Object.defineProperty(el, 'scrollHeight', { get: () => 2000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => 500, configurable: true });
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v) => (top = v), configurable: true });
    el.scrollTo = ((opts: ScrollToOptions) => {
      top = opts.top ?? top;
    }) as typeof el.scrollTo;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const bottom = this === el ? 500 : 2000;
      return { top: 0, bottom, left: 0, right: 0, width: 0, height: bottom, x: 0, y: 0, toJSON: () => ({}) };
    });
    return () => top;
  }
  const settle = async (m: { fixture: { whenStable(): Promise<unknown> } }) => {
    await m.fixture.whenStable();
    await new Promise((r) => setTimeout(r, 80));
  };
  const viewportOf = (c: HTMLElement) => c.querySelector('[data-slot="message-scroller-viewport"]') as HTMLElement;

  afterEach(() => vi.restoreAllMocks());

  it('renders the stream as a scroll region named Event stream', async () => {
    const m = await renderPane();
    const region = m.container.querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('Event stream');
  });

  it('keeps the stream out of the live region so arrivals are not announced', async () => {
    const m = await renderPane({ events: [DECIDED_BY_POLICY] });
    const content = m.container.querySelector('[data-slot="message-scroller-content"]');
    expect(content?.getAttribute('aria-live')).toBe('off');
  });

  it('gives each stream item its trackKey as a message id', async () => {
    const m = await renderPane({ state: 'awaiting', events: [DECIDED_BY_POLICY], asks: [ASK] });
    const ids = [...m.container.querySelectorAll('[data-slot="message-scroller-item"]')].map((el) =>
      el.getAttribute('data-message-id'),
    );
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => !!id)).toBe(true);
    expect(ids[1]).toMatch(/:open$/);
  });

  it('offers a Scroll to latest event button', async () => {
    const m = await renderPane();
    expect(m.container.querySelector('button[aria-label="Scroll to latest event"]')).not.toBeNull();
  });

  it('follows the tail when the reader has not scrolled away', async () => {
    const m = await renderPane({ events: [DECIDED_BY_POLICY] });
    const top = geometry(viewportOf(m.container), 0);
    m.fixture.componentRef.setInput('events', [DECIDED_BY_POLICY, { ...DECIDED_BY_POLICY, id: 'd2' }]);
    await settle(m);
    expect(top()).toBeGreaterThan(0);
  });

  it('does not pull a reader who scrolled up when an event or a pause arrives', async () => {
    const m = await renderPane({ events: [DECIDED_BY_POLICY] });
    const el = viewportOf(m.container);
    const top = geometry(el, 1500);
    el.dispatchEvent(new Event('wheel'));
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    await settle(m);

    m.fixture.componentRef.setInput('events', [DECIDED_BY_POLICY, { ...DECIDED_BY_POLICY, id: 'd2' }]);
    await settle(m);
    expect(top()).toBe(0);

    m.fixture.componentRef.setInput('state', 'awaiting');
    m.fixture.componentRef.setInput('asks', [ASK]);
    await settle(m);
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

describe('ObservePane - pauses left open when the run ends', () => {
  const ask = {
    id: 'q1',
    questions: [{ kind: 'text' as const, header: 'scope', question: 'Fix or isolate?', optional: false }],
    answers: null,
    at: 0,
  };

  it('offers no way to answer an ask or decide a check once the run is over', async () => {
    const m = await renderPane({ state: 'warning', asks: [ask], permissions: [PENDING] });
    expect(m.text()).toContain('Fix or isolate?');
    expect(m.text()).toContain('not answered · run ended');
    expect(m.text()).toContain('not decided · run ended');
    expect(m.container.querySelectorAll('.k-ask button')).toHaveLength(0);
  });

  it('keeps the open ask answerable while the run is paused on it', async () => {
    const m = await renderPane({ state: 'awaiting', asks: [ask] });
    expect(m.button('Send answer · resume')).toBeDefined();
  });
});

describe('ObservePane unseen marker', () => {
  const events: StreamEvent[] = [
    { type: 'turn', n: 1 },
    { type: 'assistant.text', text: 'first seen' },
    { type: 'assistant.text', text: 'second seen' },
    { type: 'assistant.text', text: 'first unseen' },
    { type: 'assistant.text', text: 'second unseen' },
  ];

  it('marks the first event the engineer has not seen with how many are new below', async () => {
    const { container } = await renderPane({ events, unseenFrom: 3 });
    const marker = container.querySelector('[data-unseen]')!;
    expect(marker.textContent!.replace(/\s+/g, ' ').trim()).toBe('2 new below');
    expect(marker.closest('hlm-message-scroller-item')!.textContent).toContain('first unseen');
    expect(container.querySelectorAll('[data-unseen]')).toHaveLength(1);
  });

  it('has no marker when nothing is unseen', async () => {
    const { container } = await renderPane({ events, unseenFrom: null });
    expect(container.querySelector('[data-unseen]')).toBeNull();
  });
});

describe('ObservePane - what the run was given', () => {
  const { type: _type, ...given } = runGivenFixture;

  it('a switched-off item that loaded raises a warning on the live run', async () => {
    const { container } = await renderPane({ given });
    const status = container.querySelector('.wb-status')!;
    const warning = status.querySelector('[data-given-warning]')!;
    expect(warning).not.toBeNull();
    expect(warning.textContent).toContain('repo-conventions was switched off, but Claude loaded it');
    expect(warning.querySelector('.k-status__dot')).not.toBeNull();
  });

  it('offers the Given button on every run, and no warning when nothing went wrong', async () => {
    const { container } = await renderPane({ given: { ...given, warnings: [] } });
    expect(container.querySelector('.wb-status [data-given-button]')).not.toBeNull();
    expect(container.querySelector('[data-given-warning]')).toBeNull();
  });

  it('offers the Given button before the run has reported anything', async () => {
    const { container } = await renderPane();
    expect(container.querySelector('.wb-status [data-given-button]')).not.toBeNull();
  });
});

describe('ObservePane - operator messages and the message box', () => {
  const ev = (text: string): StreamEvent => ({ type: 'assistant.text', text }) as StreamEvent;
  const MSG = { id: 'm1', text: 'Stop editing the parser', sent_at: 1_700_000_000_000, read_at: null, at: 1 };
  const field = (m: { container: HTMLElement }) => m.container.querySelector('app-message-box input') as HTMLInputElement | null;
  const sendButton = (m: { container: HTMLElement }) => m.container.querySelector('app-message-box button') as HTMLButtonElement | null;
  const clock = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  it('an accepted message shows as waiting at the point it was sent', async () => {
    const m = await renderPane({ events: [ev('first'), ev('second')], messages: [MSG] });
    const rows = [...m.container.querySelectorAll('.k-event, app-operator-message')].map((el) => (el.tagName === 'APP-OPERATOR-MESSAGE' ? 'msg' : 'event'));
    expect(rows).toEqual(['event', 'msg', 'event']);
    const entry = m.container.querySelector('app-operator-message')!.textContent ?? '';
    expect(entry).toContain('Stop editing the parser');
    expect(entry).toContain('waiting');
    expect(entry).toContain(`sent ${clock(MSG.sent_at)}`);
  });

  it('a read message shows its read time', async () => {
    const read = MSG.sent_at + 4000;
    const m = await renderPane({ events: [ev('first')], messages: [{ ...MSG, read_at: read }] });
    const entry = m.container.querySelector('app-operator-message')!.textContent ?? '';
    expect(entry).toContain(`read ${clock(read)}`);
    expect(entry).not.toContain('waiting');
  });

  it('the message box says the agent reads it before its next step', async () => {
    const m = await renderPane({ state: 'running' });
    expect(m.text()).toContain('The agent reads this before its next step.');
  });

  it('sending is disabled while a question is open and enabled after it is answered', async () => {
    const ask = { id: 'q1', questions: [{ kind: 'text', header: 'H', question: 'Which?' }], answers: null, at: 0 };
    const m = await renderPane({ state: 'awaiting', asks: [ask] });
    expect(field(m)!.disabled).toBe(true);
    expect(sendButton(m)!.disabled).toBe(true);
    expect(m.text()).toContain('Answer the question first');
    m.fixture.componentRef.setInput('state', 'running');
    m.fixture.componentRef.setInput('asks', [{ ...ask, answers: [['x']] }]);
    await m.fixture.whenStable();
    expect(field(m)!.disabled).toBe(false);
  });

  it.each(['success', 'warning', 'error'])('an ended run (%s) has no message box', async (state) => {
    const m = await renderPane({ state });
    expect(m.container.querySelector('app-message-box')).toBeNull();
  });

  it('a refusal shows its text and puts the message back', async () => {
    const m = await renderPane({ state: 'running', refusal: { id: 'r1', reason: 'run-ending', text: 'my words' } });
    expect(m.text()).toContain('Not sent: the run is ending');
    expect(field(m)!.value).toBe('my words');
  });

  it('emits say when the box sends', async () => {
    const m = await renderPane({ state: 'running' });
    const say = vi.fn();
    m.fixture.componentInstance.say.subscribe(say);
    const f = field(m)!;
    f.value = 'hello';
    f.dispatchEvent(new Event('input'));
    await m.fixture.whenStable();
    sendButton(m)!.click();
    expect(say).toHaveBeenCalledWith('hello');
  });
});
