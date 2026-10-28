import { reduce, IDLE, type RunSnapshot } from './reduce';
import type { KataEvent } from '../../lib/events';
import { runGivenFixture } from '../../lib/library';

const running: RunSnapshot = { ...IDLE, state: 'running' };
const log = (message: string): KataEvent => ({ type: 'log', level: 'info', message });

describe('reduce', () => {
  it('does not mutate the input snapshot', () => {
    const before = structuredClone(running);
    reduce(running, log('x'));
    expect(running).toEqual(before);
  });

  it('returns a new events array when a row is appended', () => {
    const next = reduce(running, log('x'));
    expect(next.events).not.toBe(running.events);
    expect(next.events).toHaveLength(1);
  });

  it('stamps an ask with the number of rows before it', () => {
    const withRow = reduce(running, log('x'));
    const next = reduce(withRow, { type: 'ask.requested', id: 'a', questions: [] });
    expect(next.asks[0].at).toBe(1);
    expect(next.state).toBe('awaiting');
  });

  it('pushes a permission.decided with no open card into the stream', () => {
    const ev = { type: 'permission.decided', id: 'p', tool: 'Bash', input_summary: 'ls', allow: true, decided_by: 'rule' } as const;
    const next = reduce(running, ev);
    expect(next.events).toEqual([ev]);
    expect(next.state).toBe('running');
  });

  it('settles run.completed with exit 0 as success and keeps the summary', () => {
    const ev = { type: 'run.completed', exit_code: 0 } as never;
    const next = reduce(running, ev);
    expect(next.state).toBe('success');
    expect(next.summary).toBe(ev);
  });

  it('moves running to awaiting on ask.requested and back on ask.answered, keeping the record', () => {
    const q = { kind: 'text', header: 'h', question: 'q?', optional: false } as const;
    const asked = reduce(running, { type: 'ask.requested', id: 'q1', questions: [q] });
    expect(asked.state).toBe('awaiting');
    expect(asked.asks).toHaveLength(1);
    expect(asked.asks[0].answers).toBeNull();
    const answered = reduce(asked, { type: 'ask.answered', id: 'q1', answers: [['some text']] });
    expect(answered.state).toBe('running');
    expect(answered.asks).toHaveLength(1);
    expect(answered.asks[0].answers).toEqual([['some text']]);
    expect(answered.asks.find((a) => a.answers === null)).toBeUndefined();
  });

  it('pauses on permission.requested and resolves the card on the operator decision', () => {
    const asked = reduce(running, { type: 'permission.requested', id: 'p1', tool: 'Bash', input_summary: 'rm -rf build/' });
    expect(asked.state).toBe('awaiting');
    expect(asked.permissions).toHaveLength(1);
    expect(asked.permissions[0].decided).toBeNull();
    expect(asked.events).toHaveLength(0);
    const decided = reduce(asked, {
      type: 'permission.decided', id: 'p1', tool: 'Bash', input_summary: 'rm -rf build/',
      allow: false, decided_by: 'operator', message: 'not on this branch',
    });
    expect(decided.state).toBe('running');
    expect(decided.permissions[0].decided).toEqual({ allow: false, message: 'not on this branch' });
    expect(decided.events).toHaveLength(0);
  });

  it('turns run.error into an error log row and an error state', () => {
    const next = reduce(running, { type: 'run.error', message: 'bad', exit_code: 1 } as never);
    expect(next.state).toBe('error');
    expect(next.events.at(-1)).toEqual({ type: 'log', level: 'error', message: 'bad' });
  });

  it('ignores run.started', () => {
    expect(reduce(running, { type: 'run.started' } as never)).toBe(running);
  });
});

describe('reduce - run.given', () => {
  it("run.given replaces the snapshot's given and is not a stream event", () => {
    const first = reduce(running, runGivenFixture);
    expect(first.given).toEqual({ items: runGivenFixture.items, settings: runGivenFixture.settings, env: runGivenFixture.env, warnings: runGivenFixture.warnings });
    expect(first.events).toEqual([]);
    const second = reduce(first, { ...runGivenFixture, warnings: [] });
    expect(second.given?.warnings).toEqual([]);
    expect(second.events).toEqual([]);
  });
});

describe('reduce - messages', () => {
  const sent = (id: string, text: string, sent_at: number): KataEvent => ({ type: 'message.sent', id, text, sent_at });

  it('message.sent adds a waiting message with its send time', () => {
    const withRow = reduce(running, log('x'));
    const next = reduce(withRow, sent('m1', 'hi', 1000));
    expect(next.messages).toEqual([{ id: 'm1', text: 'hi', sent_at: 1000, read_at: null, at: 1 }]);
  });

  it('message.read marks it read with its time', () => {
    const next = reduce(reduce(running, sent('m1', 'hi', 1000)), { type: 'message.read', id: 'm1', read_at: 2000 });
    expect(next.messages[0].read_at).toBe(2000);
    expect(next.messages[0].sent_at).toBe(1000);
  });

  it('messages keep the order they were sent', () => {
    const next = reduce(reduce(running, sent('m1', 'Use the lexer tests', 1)), sent('m2', 'Skip the docs', 2));
    expect(next.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('message.refused sets the refusal and adds no message; the next send clears it', () => {
    const refused = reduce(running, { type: 'message.refused', id: 'm1', reason: 'run-ending', text: 'hi' });
    expect(refused.refusal).toEqual({ id: 'm1', reason: 'run-ending', text: 'hi' });
    expect(refused.messages).toEqual([]);
    expect(reduce(refused, sent('m2', 'again', 5)).refusal).toBeNull();
  });

  it('message events never become stream rows', () => {
    let s = reduce(running, sent('m1', 'hi', 1));
    s = reduce(s, { type: 'message.read', id: 'm1', read_at: 2 });
    s = reduce(s, { type: 'message.refused', id: 'm2', reason: 'repeated', text: 'x' });
    expect(s.events).toEqual([]);
  });
});
