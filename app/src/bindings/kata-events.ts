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
      /**
       * Isolation branch (`kata/<slug>-<id>`) — present only when isolated.
       */
      branch?: string | null;
      /**
       * Changeset partitioned by file extension, sorted by `file_type`.
       * A partition of the totals above: summing `by_type[*].insertions`
       * equals `insertions` (same for deletions). `#[serde(default)]` so a
       * pre-enhancement `run.diff` transcript line still deserializes (as []).
       */
      by_type?: DiffTypeStat[];
      deletions: number;
      files: DiffFile[];
      insertions: number;
      type: "run.diff";
      /**
       * Absolute worktree path — present only for a worktree-isolated run.
       */
      worktree?: string | null;
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
      /**
       * Total cost claude reported, if a `result` line arrived. `None` when
       * the leash killed the child before it could report (timeout, cancel,
       * turn cap); present on the budget path (exit 122).
       */
      cost_usd?: number | null;
      /**
       * Wall-clock run duration in milliseconds. `#[serde(default)]` so a
       * pre-1.1.0 transcript line that predates this field still deserializes
       * (as 0) instead of being dropped from run history.
       */
      duration_ms?: number;
      exit_code: number;
      message: string;
      type: "run.error";
    }
  | {
      /**
       * Almost always `None`: a cancelled child is killed before it reports
       * a cost. Kept for symmetry with the other terminal events.
       */
      cost_usd?: number | null;
      /**
       * Wall-clock run duration in milliseconds. `#[serde(default)]` so a
       * pre-1.1.0 transcript line that predates this field still deserializes
       * (as 0) instead of being dropped from run history.
       */
      duration_ms?: number;
      exit_code: number;
      type: "run.cancelled";
    };
export type QuestionKind = "confirm" | "select" | "text";

/**
 * Per-file-type slice of a run's changeset. Part of the `run.diff` payload.
 * `file_type` is a lowercased file extension; `""` means no extension.
 */
export interface DiffTypeStat {
  deletions: number;
  /**
   * Lowercased file extension ("rs", "ts", "md"); "" for files with no
   * extension (Makefile, LICENSE, .gitignore).
   */
  file_type: string;
  /**
   * Number of changed files of this type.
   */
  files: number;
  insertions: number;
}
/**
 * One changed file in a run's changeset. Part of the `run.diff` event
 * payload; produced by `crate::changeset::diff_at`.
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
 * One question in an `ask.requested` batch. Part of the published event
 * schema (`schema/kata-events.schema.json`); the app's TS type is generated
 * from that schema, not hand-mirrored.
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
