import type { KataEvent, StreamEvent, RunSummary, RunState, PermissionRecord, AskRecord } from '../../lib/events';
import { terminalStateFor } from '../../lib/events';

export type { AskRecord };

export type RunSnapshot = {
  state: RunState;
  events: StreamEvent[];
  summary: RunSummary | null;
  asks: AskRecord[];
  permissions: PermissionRecord[];
};

export const IDLE: RunSnapshot = { state: 'idle', events: [], summary: null, asks: [], permissions: [] };

/** The Observe pane's state machine as a pure function. Always returns new
 *  arrays rather than mutating, because a signal only notifies on a new reference. */
export function reduce(s: RunSnapshot, ev: KataEvent): RunSnapshot {
  switch (ev.type) {
    case 'run.started':
    case 'run.diff':
      return s;
    case 'ask.requested':
      return { ...s, state: 'awaiting', asks: [...s.asks, { id: ev.id, questions: ev.questions, answers: null, at: s.events.length }] };
    case 'ask.answered':
      return { ...s, state: 'running', asks: s.asks.map((a) => (a.id === ev.id ? { ...a, answers: ev.answers } : a)) };
    case 'permission.requested':
      return {
        ...s,
        state: 'awaiting',
        permissions: [...s.permissions, { id: ev.id, tool: ev.tool, input_summary: ev.input_summary, decided: null, at: s.events.length }],
      };
    case 'permission.decided':
      // A check that opened a card resolves it; one settled by a rule or the
      // unmatched policy never paused the run, so it lands in the stream.
      if (!s.permissions.some((p) => p.id === ev.id)) return { ...s, events: [...s.events, ev] };
      return {
        ...s,
        state: 'running',
        permissions: s.permissions.map((p) => (p.id === ev.id ? { ...p, decided: { allow: ev.allow, message: ev.message ?? null } } : p)),
      };
    case 'run.completed':
      return settle({ ...s, summary: ev }, ev);
    case 'run.error':
      return settle({ ...s, events: [...s.events, { type: 'log', level: 'error', message: ev.message }] }, ev);
    case 'run.cancelled':
      return settle(s, ev);
    default:
      return { ...s, events: [...s.events, ev] };
  }
}

function settle(s: RunSnapshot, ev: KataEvent): RunSnapshot {
  const terminal = terminalStateFor(ev);
  return terminal ? { ...s, state: terminal } : s;
}
