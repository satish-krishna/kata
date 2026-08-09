/* The normalized KataEvent protocol relayed by the engine (generated from
 * schema/kata-events.schema.json). The Tauri backend emits these over the
 * `kata://event` channel; the Observe pane renders one EventRow per
 * streaming event and a Summary block on `run.completed`. */

import type { RunRecord } from "../bindings/RunRecord";
export type { RunRecord };
/** One past run: its record plus its full event stream. `KataEvent` is
 *  generated from the published schema (`schema/kata-events.schema.json`);
 *  this wrapper stays hand-written. */
export type RunDetail = { record: RunRecord; events: KataEvent[] };

import type {
  KataEvent,
  Question,
  QuestionKind,
  QuestionOption,
  DiffFile,
} from "../bindings/kata-events";
export type { KataEvent, Question, QuestionKind, QuestionOption, DiffFile };

/** The terminal event carrying the run summary. */
export type RunSummary = Extract<KataEvent, { type: "run.completed" }>;
/** Everything that renders as a row in the stream (meta + terminal events excluded).
 *  `permission.decided` IS a row: a check settled by a rule or the unmatched
 *  policy never opened a card, so the row is the only place it shows up. When a
 *  card *is* open, the run store resolves it instead of pushing a row. */
export type StreamEvent = Exclude<
  KataEvent,
  { type: "run.started" | "run.completed" | "run.error" | "run.cancelled" | "run.diff" | "ask.requested" | "ask.answered" | "permission.requested" }
>;

const NON_ROW_TYPES = new Set([
  "run.started", "run.completed", "run.error", "run.cancelled", "run.diff", "ask.requested", "ask.answered",
  "permission.requested",
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
