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
      /**
       * `id` of the subagent call this text was written inside; absent at
       * the top level.
       */
      parent_id?: string | null;
      text: string;
      type: "assistant.text";
    }
  | {
      /**
       * claude's `tool_use_id`. Pairs this call with its `tool.result`.
       * Emitted on every run; absent only in transcripts written before it
       * existed, or when claude sent none.
       */
      id?: string | null;
      /**
       * Raw tool input. Only under `kata run --full-payloads`; omitted, with
       * `truncated` set, when its serialized form exceeds `PAYLOAD_CAP_BYTES`.
       */
      input?: {
        [k: string]: unknown;
      };
      input_summary: string;
      name: string;
      /**
       * `id` of the subagent call this call was made inside; absent at the
       * top level.
       */
      parent_id?: string | null;
      truncated?: boolean;
      type: "tool.use";
    }
  | {
      /**
       * The `id` of the `tool.use` this result answers.
       */
      id?: string | null;
      name: string;
      ok: boolean;
      /**
       * The tool's output flattened to text. Only under
       * `kata run --full-payloads`; cut at `PAYLOAD_CAP_BYTES` with
       * `truncated` set.
       */
      output?: string | null;
      parent_id?: string | null;
      summary: string;
      truncated?: boolean;
      type: "tool.result";
    }
  | {
      n: number;
      /**
       * Set when the assistant message came from inside a subagent: the
       * `id` of the `tool.use` that spawned it. Omitted at the top level.
       */
      parent_id?: string | null;
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
      env: EnvName[];
      items: GivenItem[];
      settings: RunSettings;
      type: "run.given";
      warnings: string[];
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
      id: string;
      /**
       * The call's target rendered for a human: the shell command, the file
       * path, the query — whatever the decision actually turns on.
       */
      input_summary: string;
      /**
       * The tool claude wants to use, e.g. `Bash` or `mcp__github__list_issues`.
       */
      tool: string;
      type: "permission.requested";
    }
  | {
      allow: boolean;
      /**
       * What resolved it: `unmatched-policy`, `operator`, or `engine` (one of
       * Kata's own bridge tools, which are exempt from the rules). A rule can
       * never appear here — the spec's `allow`/`deny` are enforced by claude
       * from the generated settings file, and a call they resolve never
       * reaches Kata. Treat an unrecognized value as "something else decided".
       */
      decided_by: string;
      /**
       * Correlates with a preceding `permission.requested`, when there was one.
       */
      id: string;
      /**
       * Same rendering as `permission.requested.input_summary`, repeated here
       * so an auto-resolved check is legible on its own.
       */
      input_summary: string;
      /**
       * The reason handed back to claude on a denial.
       */
      message?: string | null;
      tool: string;
      type: "permission.decided";
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
/**
 * Where an item comes from. `ProjectLocal` is `.claude/settings.local.json`,
 * `CLAUDE.local.md` and the local MCP scope in `~/.claude.json`; it displays as
 * "project" but keeps its own identity.
 */
export type Source = "personal" | "project" | "project-local" | "plugin" | "organization" | "kata" | "run-spec";
/**
 * The kind of thing a run starts with that can be switched off.
 */
export type ItemKind = "hook" | "skill" | "plugin" | "instruction" | "tool-server";
/**
 * Why an item is locked on. Every variant but `FollowsPlugin` carries the
 * one-line reason text the row shows.
 */
export type LockReason =
  | {
      kind: "kata";
      text: string;
    }
  | {
      kind: "required";
      text: string;
    }
  | {
      kind: "organization";
      text: string;
    }
  | {
      kind: "unswitchable";
      text: string;
    }
  | {
      kind: "follows-plugin";
      plugin: string;
    };
/**
 * One variant per distinct text the view shows. The frontend maps each to its
 * words.
 */
export type GivenStatus =
  | "given"
  | "passed-not-loaded"
  | "given-failed-to-connect"
  | "given-fired"
  | "given-not-fired"
  | "given-unconfirmed"
  | "switched-off-but-loaded"
  | "switched-off-but-fired"
  | "switched-off"
  | "switched-off-unconfirmed"
  | "loaded-source-unknown"
  | "loaded-source-unknown-failed-to-connect"
  | "fired-source-unknown"
  | "passed-no-start-report"
  | "switched-off-no-start-report";
/**
 * Where a setting's value comes from.
 */
export type SettingSource =
  | ("run-spec" | "personal" | "project" | "project-local" | "organization" | "claude-default" | "kata-default")
  | "claude-report";
export type QuestionKind = "confirm" | "select" | "text";

/**
 * The name of an environment variable the run sees. Never its value.
 */
export interface EnvName {
  /**
   * True for the variable that holds the API key (`auth.token_env`).
   */
  api_key: boolean;
  name: string;
  source: Source;
}
/**
 * One row of the view: the resolved item (without its path) and its status.
 * `source` is `None` for a row Claude reported that Kata did not know.
 */
export interface GivenItem {
  brought_by?: string | null;
  detail: string;
  id: string;
  kind: ItemKind;
  lock?: LockReason | null;
  name: string;
  off: boolean;
  source?: Source | null;
  status: GivenStatus;
}
/**
 * The settings of R17.1 the engine can resolve. The build's safety rules come
 * from the Workbench.
 */
export interface RunSettings {
  answer_deadline: RunSetting;
  effort: RunSetting;
  empty_room: RunSetting;
  model: RunSetting;
  permission_posture: RunSetting;
  spending_ceiling: RunSetting;
  time_limit: RunSetting;
  turn_cap: RunSetting;
}
/**
 * One setting. `value` is `None` when nothing is set: "none" for a cap or a
 * deadline, Claude's own default for the model and the effort level.
 */
export interface RunSetting {
  source: SettingSource;
  value?: string | null;
}
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
   * Path relative to the run's working directory (the worktree when isolated, the workdir otherwise).
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
