/* The normalized KataEvent protocol relayed by the engine (generated from
 * schema/kata-events.schema.json). The Tauri backend emits these over the
 * `kata://event` channel; the Observe pane renders one EventRow per
 * streaming event and a Summary block on `run.completed`. */

import type { RunRecord } from "@bindings/RunRecord";
export type { RunRecord };
/** One past run: its record plus its full event stream. `KataEvent` is
 *  generated from the published schema (`schema/kata-events.schema.json`);
 *  this wrapper stays hand-written. */
export type RunDetail = { record: RunRecord; events: KataEvent[] };

import type {
  GivenStatus,
  KataEvent,
  Question,
  QuestionKind,
  QuestionOption,
  DiffFile,
} from "@bindings/kata-events";
export type { GivenStatus, KataEvent, Question, QuestionKind, QuestionOption, DiffFile };

/** What a run was given, as its last `run.given` event recorded it. */
export type RunGiven = Omit<Extract<KataEvent, { type: "run.given" }>, "type">;

/** The words for each status the engine reports. The frontend labels a status and never computes one. */
export const GIVEN_STATUS_LABEL: Record<GivenStatus, string> = {
  "given": "given",
  "passed-not-loaded": "passed by Kata, not loaded by Claude",
  "given-failed-to-connect": "given, failed to connect",
  "given-fired": "given, fired",
  "given-not-fired": "given, has not fired",
  "given-unconfirmed": "given, Claude does not confirm this kind",
  "switched-off-but-loaded": "switched off, but Claude loaded it",
  "switched-off-but-fired": "switched off, but it fired",
  "switched-off": "switched off",
  "switched-off-unconfirmed": "switched off, Claude does not confirm this kind",
  "loaded-source-unknown": "loaded by Claude, source unknown",
  "loaded-source-unknown-failed-to-connect": "loaded by Claude, source unknown, failed to connect",
  "fired-source-unknown": "fired, source unknown",
  "passed-no-start-report": "passed by Kata, Claude made no start report",
  "switched-off-no-start-report": "switched off, Claude made no start report",
};

/** The last `run.given` of a transcript, or `not-recorded` when the run made none (a run from before the view existed). */
export function givenFrom(events: readonly KataEvent[]): RunGiven | "not-recorded" {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "run.given") return { items: ev.items, settings: ev.settings, env: ev.env, warnings: ev.warnings, ...(ev.options ? { options: ev.options } : {}) };
  }
  return "not-recorded";
}

/** The terminal event carrying the run summary. */
export type RunSummary = Extract<KataEvent, { type: "run.completed" }>;
/** Everything that renders as a row in the stream (meta + terminal events excluded).
 *  `permission.decided` IS a row: a check settled by a rule or the unmatched
 *  policy never opened a card, so the row is the only place it shows up. When a
 *  card *is* open, the run store resolves it instead of pushing a row. */
export type StreamEvent = Exclude<
  KataEvent,
  { type: "run.started" | "run.completed" | "run.error" | "run.cancelled" | "run.diff" | "run.given" | "ask.requested" | "ask.answered" | "permission.requested" | "message.sent" | "message.read" | "message.refused" }
>;

const NON_ROW_TYPES = new Set([
  "run.started", "run.completed", "run.error", "run.cancelled", "run.diff", "run.given", "ask.requested", "ask.answered",
  "permission.requested", "message.sent", "message.read", "message.refused",
]);
/** Narrow a KataEvent to the row-renderable subset (for the event log). */
export function isStreamEvent(ev: KataEvent): ev is StreamEvent {
  return !NON_ROW_TYPES.has(ev.type);
}

/** Andon state from a final exit code. 0 = success; the leash family
 *  (122-125) and cancel (130) are "stopped" (amber); any other non-zero is
 *  error; null (no terminal event recorded) is treated as error. Exit code is
 *  the authoritative signal — used identically for live runs and history. */
export function statusForExit(exit: number | null): RunState {
  if (exit === null) return "error";
  if (exit === 0) return "success";
  if (exit === 122 || exit === 123 || exit === 124 || exit === 125 || exit === 130) return "warning";
  return "error";
}

/** Terminal run state for an event, or null if the event is a streaming row. */
export function terminalStateFor(ev: KataEvent): RunState | null {
  switch (ev.type) {
    case "run.completed": return statusForExit(ev.exit_code);
    case "run.error": return statusForExit(ev.exit_code);
    case "run.cancelled": return statusForExit(ev.exit_code);
    default: return null;
  }
}

export type RunState = "idle" | "running" | "awaiting" | "success" | "warning" | "error";

export const STATUS_LABEL: Record<RunState, string> = {
  idle: "Idle",
  running: "Running",
  awaiting: "Awaiting",
  success: "Completed",
  error: "Error",
  warning: "Stopped",
};

/** Uppercase gutter label for a stream row. */
export function gutterFor(ev: StreamEvent): string {
  switch (ev.type) {
    case "assistant.text": return "assistant";
    case "tool.use": return "tool";
    case "tool.result": return "result";
    case "turn": return `turn ${ev.n}`;
    case "log": return "log";
    case "permission.decided": return ev.allow ? "allowed" : "denied";
  }
}

/** EventRow variant suffix → `.k-event--<variant>`. */
export function variantFor(ev: StreamEvent): string {
  switch (ev.type) {
    case "assistant.text": return "assistant";
    case "tool.use": return "tooluse";
    case "tool.result": return ev.ok ? "result-ok" : "result-err";
    case "turn": return "turn";
    case "log": return "log";
    // Andon reuse: an allowed call reads like a good result, a denied one like
    // a bad one. Never the accent — status colour is never the accent.
    case "permission.decided": return ev.allow ? "result-ok" : "result-err";
  }
}

/** The textual body for a stream row (turn rows render a divider instead). */
export function bodyFor(ev: StreamEvent): string {
  switch (ev.type) {
    case "assistant.text": return ev.text;
    case "tool.use": return ev.input_summary;
    case "tool.result": return ev.summary;
    case "log": return ev.message;
    case "turn": return "";
    case "permission.decided": return permissionBody(ev);
  }
}

type PermissionDecided = Extract<KataEvent, { type: "permission.decided" }>;
/** One-line audit body: what was decided, on what, and by which rule. */
export function permissionBody(ev: PermissionDecided): string {
  const target = ev.input_summary ? ` ${ev.input_summary}` : "";
  return `${ev.tool}${target} · ${ev.decided_by}`;
}

export type AskRecord = {
  id: string;
  questions: Question[];
  answers: string[][] | null;
  /** How many stream events preceded this ask, so the Observe pane can render
   *  the panel where it happened rather than after the whole transcript. */
  at: number;
};

/** A permission check the operator has to settle, plus its verdict once given. */
export type PermissionRecord = {
  id: string;
  tool: string;
  input_summary: string;
  decided: { allow: boolean; message: string | null } | null;
  /** How many stream events preceded this check. The Observe pane splices the
   *  card back in at that position so it reads where it happened, rather than
   *  piling every card at the end of the transcript. */
  at: number;
};

/** A message the operator sent to a running agent. `at` is the number of stream rows before it was sent. */
export type MessageRecord = { id: string; text: string; sent_at: number; read_at: number | null; at: number };
/** A message the engine refused, kept so the box can say why and give the text back. */
export type MessageRefusal = { id: string; reason: string; text: string };
export type PendingKind = "ask" | "approval" | "none";
export type MessageBoxView = { shown: boolean; enabled: boolean; note: string; restore: string | null; restoreId?: string };

/** Fold one event into the messages. A read for an unknown id is ignored; any other event leaves them as they were. */
export function foldMessage(records: MessageRecord[], ev: KataEvent, at: number): MessageRecord[] {
  if (ev.type === "message.sent") return [...records, { id: ev.id, text: ev.text, sent_at: ev.sent_at, read_at: null, at }];
  if (ev.type === "message.read") return records.map((m) => (m.id === ev.id ? { ...m, read_at: ev.read_at } : m));
  return records;
}

/** The messages of a whole transcript, each placed by the number of stream rows before it. */
export function messagesFrom(events: KataEvent[]): MessageRecord[] {
  let records: MessageRecord[] = [];
  let rows = 0;
  for (const ev of events) {
    records = foldMessage(records, ev, rows);
    if (isStreamEvent(ev)) rows++;
  }
  return records;
}

export function refusalText(reason: string): string {
  switch (reason) {
    case "waiting-on-operator": return "Not sent: answer the agent first";
    case "run-ending": return "Not sent: the run is ending";
    case "repeated": return "Not sent: already sent";
    default: return "Not sent";
  }
}

export function pendingKind(asks: AskRecord[], permissions: PermissionRecord[]): PendingKind {
  if (asks.some((a) => a.answers === null)) return "ask";
  if (permissions.some((p) => p.decided === null)) return "approval";
  return "none";
}

/** What the message box shows for a run. The send button also needs non-blank text; the component adds that. */
export function messageBox(state: RunState, pending: PendingKind, refusal: MessageRefusal | null): MessageBoxView {
  if (state === "running") {
    return refusal
      ? { shown: true, enabled: true, note: refusalText(refusal.reason), restore: refusal.text, restoreId: refusal.id }
      : { shown: true, enabled: true, note: "The agent reads this before its next step.", restore: null };
  }
  if (state === "awaiting") {
    return { shown: true, enabled: false, note: pending === "approval" ? "Decide the approval first" : "Answer the question first", restore: null };
  }
  return { shown: false, enabled: false, note: "", restore: null };
}
