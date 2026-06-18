/* The normalized KataEvent protocol relayed by the engine (mirrors
 * kata-core::event). The Tauri backend emits these over the `kata://event`
 * channel; the Observe pane renders one EventRow per streaming event and a
 * Summary block on `run.completed`. */

export type KataEvent =
  | { type: "run.started"; spec: string; model: string | null; workdir: string; isolation: string; worktree?: string | null; branch?: string | null }
  | { type: "log"; level?: string; message: string }
  | { type: "turn"; n: number }
  | { type: "assistant.text"; text: string }
  | { type: "tool.use"; name: string; input_summary: string }
  | { type: "tool.result"; name: string; ok: boolean; summary: string }
  | {
      type: "run.completed";
      exit_code: number;
      is_error: boolean;
      num_turns: number;
      cost_usd: number | null;
      duration_ms: number;
      result: string | null;
    }
  | { type: "run.diff"; worktree: string; branch: string; files: { status: string; path: string }[]; insertions: number; deletions: number }
  | { type: "ask.requested"; id: string; questions: Question[] }
  | { type: "ask.answered"; id: string; answers: string[][] }
  | { type: "run.error"; message: string }
  | { type: "run.cancelled" };

export type QuestionKind = "confirm" | "select" | "text";
export type QuestionOption = { label: string; description?: string };
export type Question = {
  kind: QuestionKind;
  header: string;
  question: string;
  options?: QuestionOption[];
  multi_select?: boolean;
  optional?: boolean;
  placeholder?: string;
};

/** The terminal event carrying the run summary. */
export type RunSummary = Extract<KataEvent, { type: "run.completed" }>;
/** Everything that renders as a row in the stream (meta + terminal events excluded). */
export type StreamEvent = Exclude<
  KataEvent,
  { type: "run.started" | "run.completed" | "run.error" | "run.cancelled" | "run.diff" | "ask.requested" | "ask.answered" }
>;

/** Terminal run state for an event, or null if the event is a streaming row. */
export function terminalStateFor(ev: KataEvent): RunState | null {
  switch (ev.type) {
    case "run.completed": return ev.is_error ? "error" : "success";
    case "run.error": return "error";
    case "run.cancelled": return "warning";
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
  }
}
