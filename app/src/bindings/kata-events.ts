/* Generated from schema/kata-events.schema.json by 'npm run gen:events'. DO NOT EDIT. */

export type KataEvent =
  | {
      branch?: string | null;
      isolation: string;
      model?: string | null;
      spec: string;
      type: "run.started";
      workdir: string;
      worktree?: string | null;
    }
  | {
      level: string;
      message: string;
      type: "log";
    }
  | {
      text: string;
      type: "assistant.text";
    }
  | {
      input_summary: string;
      name: string;
      type: "tool.use";
    }
  | {
      name: string;
      ok: boolean;
      summary: string;
      type: "tool.result";
    }
  | {
      n: number;
      type: "turn";
    }
  | {
      cost_usd?: number | null;
      duration_ms: number;
      exit_code: number;
      is_error: boolean;
      num_turns: number;
      result?: string | null;
      type: "run.completed";
    }
  | {
      branch: string;
      deletions: number;
      files: DiffFile[];
      insertions: number;
      type: "run.diff";
      worktree: string;
    }
  | {
      id: string;
      questions: Question[];
      type: "ask.requested";
    }
  | {
      answers: string[][];
      id: string;
      type: "ask.answered";
    }
  | {
      exit_code: number;
      message: string;
      type: "run.error";
    }
  | {
      exit_code: number;
      type: "run.cancelled";
    };
export type QuestionKind = "confirm" | "select" | "text";

/**
 * One changed file in a worktree-isolation diff summary. Part of the
 * `run.diff` event payload; also produced by `crate::worktree::diff`.
 */
export interface DiffFile {
  /**
   * Path relative to the worktree root.
   */
  path: string;
  /**
   * Git short status for the change: "A" | "M" | "D" | "R" | ...
   */
  status: string;
}
/**
 * One question in an `ask.requested` batch. Mirrored by hand in
 * `app/src/lib/events.ts` (events are not ts-rs exported).
 */
export interface Question {
  header: string;
  kind: QuestionKind;
  multi_select?: boolean;
  optional?: boolean;
  options?: QuestionOption[];
  placeholder?: string | null;
  question: string;
}
export interface QuestionOption {
  description?: string | null;
  label: string;
}
