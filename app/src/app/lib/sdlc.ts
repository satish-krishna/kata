/* Pure AI-SDLC stage logic: which actions a stage offers, how it is labeled,
 * how a stage run-spec is built, and how a run's transcript id is found.
 * No Angular, no I/O. */

import type { CatalogEntry } from "@bindings/CatalogEntry";
import type { ChangeInfo } from "@bindings/ChangeInfo";
import type { PluginConfig } from "@bindings/PluginConfig";
import type { RunLink } from "@bindings/RunLink";
import type { RunRecord } from "@bindings/RunRecord";
import type { RunSpec } from "@bindings/RunSpec";
import type { Settings } from "@bindings/Settings";
import type { Stage } from "@bindings/Stage";
import type { KataEvent } from "./events";
import { defaultSpec } from "./spec";

export type StageAction =
  | "continue-intent"
  | "accept-intent"
  | "reject-intent"
  | "commit-acceptance"
  | "start-spec"
  | "continue-spec"
  | "accept-spec"
  | "start-plan"
  | "rerun-plan"
  | "reopen-spec"
  | "reopen-intent"
  | "accept-plan"
  | "start-build"
  | "continue-build"
  | "another-round"
  | "run-review"
  | "declare-done";

const ACTIONS: Record<Stage, StageAction[]> = {
  "intent-in-progress": ["continue-intent"],
  "intent-awaiting": ["continue-intent", "accept-intent", "reject-intent"],
  "intent-accepted-uncommitted": ["commit-acceptance", "continue-intent"],
  rejected: [],
  "spec-ready": ["start-spec", "reopen-intent"],
  "spec-awaiting": ["continue-spec", "accept-spec", "reopen-intent"],
  "spec-accepted-uncommitted": ["commit-acceptance", "continue-spec"],
  "plan-ready": ["start-plan", "reopen-spec", "reopen-intent"],
  "plan-awaiting": ["accept-plan", "rerun-plan", "reopen-intent"],
  "plan-accepted-uncommitted": ["commit-acceptance", "rerun-plan"],
  // The actions depend on the cause; see `actionsForChange`.
  "plan-out-of-date": [],
  "plan-superseded": ["rerun-plan"],
  "build-ready": ["start-build", "reopen-intent"],
  "build-stopped": ["continue-build", "another-round"],
  "build-finished": ["declare-done", "another-round", "run-review"],
};

const REVISITS: readonly StageAction[] = ["continue-intent", "reopen-intent", "continue-spec", "reopen-spec", "rerun-plan"];

/** True for an action that regenerates a document that already exists, so the operator can say what should change. */
export function revisits(action: StageAction): boolean {
  return REVISITS.includes(action);
}

/** The spec's "Stage derivation and actions" table, Actions column, in order. */
export function actionsFor(stage: Stage): StageAction[] {
  return [...ACTIONS[stage]];
}

/**
 * The actions of a change. An out-of-date plan depends on its cause: a broken spec pin means the spec is
 * reopened; a reopened intent or spec is settled on its own tab; any other cause means the plan is rewritten.
 */
export function actionsForChange(c: ChangeInfo): StageAction[] {
  if (c.stage !== "plan-out-of-date") return actionsFor(c.stage);
  switch (c.out_of_date) {
    case "spec-pin":
      return ["reopen-spec"];
    case "intent-reopened":
    case "spec-reopened":
      return [];
    default:
      return ["rerun-plan"];
  }
}

export type StageLabel = {
  step: "intent" | "spec" | "plan" | "build" | "done" | "closed";
  text: string;
  tone: "success" | "warning" | "muted" | "error";
};

const LABELS: Record<Stage, StageLabel> = {
  "intent-in-progress": { step: "intent", text: "Intent · in progress (not committed)", tone: "muted" },
  "intent-awaiting": { step: "intent", text: "Intent · awaiting acceptance", tone: "warning" },
  "intent-accepted-uncommitted": { step: "intent", text: "Intent · accepted, not committed", tone: "warning" },
  rejected: { step: "closed", text: "Closed · rejected", tone: "error" },
  "spec-ready": { step: "spec", text: "Spec · ready to start", tone: "muted" },
  "spec-awaiting": { step: "spec", text: "Spec · awaiting acceptance", tone: "warning" },
  "spec-accepted-uncommitted": { step: "spec", text: "Spec · accepted, not committed", tone: "warning" },
  "plan-ready": { step: "plan", text: "Plan · ready to start", tone: "muted" },
  "plan-awaiting": { step: "plan", text: "Plan · awaiting acceptance", tone: "warning" },
  "plan-accepted-uncommitted": { step: "plan", text: "Plan · accepted, not committed", tone: "warning" },
  "plan-out-of-date": { step: "plan", text: "Plan · out of date", tone: "warning" },
  "plan-superseded": { step: "plan", text: "Plan · superseded", tone: "warning" },
  "build-ready": { step: "build", text: "Build · ready to start", tone: "muted" },
  "build-stopped": { step: "build", text: "Build · in progress (stopped)", tone: "warning" },
  "build-finished": { step: "build", text: "Build · finished, not yet done", tone: "success" },
};

/** The label of a change that is done: its pull requests are open. Not a stage; the Workbench records it. */
export const DONE_LABEL: StageLabel = { step: "done", text: "Done · pull requests open", tone: "success" };

export function stageLabel(stage: Stage): StageLabel {
  return { ...LABELS[stage] };
}

export type RunContext = {
  folder: string;
  system: string;
  change: string | null;
  idea?: string;
  repos?: string[];
  /** The operator's corrections for a revisit, passed to the skill as `Operator feedback:`. */
  feedback?: string;
};

export type SdlcKind = "setup" | "context" | "intent" | "spec" | "plan" | "build";

const AI_SDLC = "ai-sdlc";

const hasPlugin = (catalog: CatalogEntry[], name: string): boolean =>
  catalog.some((e) => e.kind === "plugin" && e.name === name);

export function hasAiSdlcPlugin(catalog: CatalogEntry[]): boolean {
  return hasPlugin(catalog, AI_SDLC);
}

function nameFor(kind: SdlcKind, ctx: RunContext): string {
  switch (kind) {
    case "setup":
      return "sdlc-setup";
    case "context":
      return `sdlc-${ctx.system}-context`;
    default:
      return `sdlc-${ctx.system}-${ctx.change ?? "new"}-${kind}`;
  }
}

function taskFor(kind: SdlcKind, action: StageAction | null, ctx: RunContext): string {
  const { system, change } = ctx;
  switch (kind) {
    case "setup":
      return system ? `Use the ai-sdlc setup skill. System: ${system}` : "Use the ai-sdlc setup skill.";
    case "context":
      return `Use the ai-sdlc context skill for system ${system}, repositories: ${(ctx.repos ?? []).join(", ")}. Refresh each existing context file, even one that is current.`;
    case "intent": {
      if (change === null) return `Use the ai-sdlc intent skill for system ${system}. The idea: ${ctx.idea ?? ""}`;
      const resume = `Use the ai-sdlc intent skill for system ${system} on the existing change folder ${change}. Resume the draft.`;
      return action === "reopen-intent"
        ? `${resume} The user has already confirmed reopening this accepted intent; do not ask again.`
        : resume;
    }
    case "spec": {
      const task = `Use the ai-sdlc spec skill for system ${system} on change folder ${change}.`;
      if (action === "reopen-spec") return `${task} The user has already confirmed reopening this accepted spec; do not ask again.`;
      if (action === "continue-spec") return `${task} The user has already confirmed regenerating the spec; do not ask again.`;
      return task;
    }
    case "plan": {
      let task = `Use the ai-sdlc plan skill for system ${system} on change folder ${change}.`;
      if (action === "rerun-plan") task += " The user has already confirmed replacing the existing plan; do not ask again.";
      return task;
    }
    case "build":
      return "";
  }
}

const SDLC_TIMEOUT_SECS = 6 * 60 * 60;

/** Build the run-spec for one AI-SDLC run. Always bypass-valid: allow/deny/ask stay empty. */
export function specFor(
  kind: SdlcKind,
  action: StageAction | null,
  ctx: RunContext,
  settings: Settings,
  catalog: CatalogEntry[],
  run?: BuildRun,
): RunSpec {
  void run;
  const spec = defaultSpec();
  const plugins: Record<string, PluginConfig> = { [AI_SDLC]: {} };
  spec.name = nameFor(kind, ctx);
  const feedback = ctx.feedback?.trim() ?? "";
  spec.task = taskFor(kind, action, ctx) + (feedback ? `\n\nOperator feedback:\n${feedback}` : "");
  spec.workdir = ctx.folder;
  spec.plugins = plugins;
  // Outside the empty room: `--bare` ignores the operator's claude login and accepts only an API key.
  spec.auth = { bare: false, token_env: null };
  spec.interactive = { enabled: false, answer_timeout_secs: 3600 };
  // A build works task by task through a whole plan and outlasts the engine's 30-minute default.
  spec.leash.timeout_secs = SDLC_TIMEOUT_SECS;
  if (settings.permission_mode === "prompt") {
    spec.permissions = { mode: "prompt", allow: [], deny: [], unmatched: "ask" };
    spec.interactive.enabled = true;
  }
  return spec;
}

const TRANSCRIPT = "transcript: ";

/** The run id (transcript file stem) from the first `transcript: <path>` log event. */
export function transcriptRunId(events: readonly KataEvent[]): string | null {
  for (const ev of events) {
    if (ev.type === "log" && ev.message.startsWith(TRANSCRIPT)) {
      const path = ev.message.slice(TRANSCRIPT.length).trim();
      const file = path.split(/[\\/]/).pop() ?? "";
      const stem = file.replace(/\.[^.]*$/, "");
      return stem || null;
    }
  }
  return null;
}

const LABEL: Record<StageAction, string> = {
  "continue-intent": "Continue intent",
  "accept-intent": "Accept intent",
  "reject-intent": "Reject intent",
  "commit-acceptance": "Commit acceptance",
  "start-spec": "Start spec",
  "continue-spec": "Continue spec",
  "accept-spec": "Accept spec",
  "start-plan": "Start plan",
  "rerun-plan": "Re-run plan",
  "reopen-spec": "Reopen spec",
  "reopen-intent": "Reopen intent",
  "accept-plan": "Accept plan",
  "start-build": "Start build",
  "continue-build": "Continue build",
  "another-round": "Another round",
  "run-review": "Run review",
  "declare-done": "Declare done",
};

export function actionLabel(action: StageAction): string {
  return LABEL[action];
}

const PRIMARY_ORDER: RegExp[] = [/^accept-/, /^commit-acceptance$/, /^start-/, /^continue-/, /^declare-done$/];

/** The one primary action of a view: accept, commit, start, then continue. Reopen, re-run and reject are never primary. */
export function primaryAction(actions: readonly StageAction[]): StageAction | null {
  for (const rule of PRIMARY_ORDER) {
    const hit = actions.find((a) => rule.test(a));
    if (hit) return hit;
  }
  return null;
}

/** Split a leading `---` front-matter block off a document. The block becomes one `key: value · key: value` line. */
export function splitFrontMatter(text: string): { frontMatter: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontMatter: null, body: text };
  const line = m[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").join(" · ");
  return { frontMatter: line === "" ? null : line, body: text.slice(m[0].length) };
}

export type StepCounts = Record<"intent" | "spec" | "plan", number>;
/** Which of a change's three documents exist on disk. */
export type DocsPresent = Record<keyof StepCounts, boolean>;

/**
 * Runs so far per stage: the transcript links recorded for this change, plus history records that carry the
 * stage's deterministic run name and are not linked yet (the fallback for a run whose link was never written).
 */
export function runCounts(
  links: readonly RunLink[],
  records: readonly RunRecord[],
  workspaceId: string,
  system: string,
  change: string,
): StepCounts {
  const out: StepCounts = { intent: 0, spec: 0, plan: 0 };
  const linked = new Set<string>();
  for (const l of links) {
    if (l.workspace_id !== workspaceId || l.system !== system || l.change !== change) continue;
    linked.add(l.run_id);
    if (l.stage === "intent" || l.stage === "spec" || l.stage === "plan") out[l.stage] += 1;
  }
  for (const r of records) {
    if (linked.has(r.id)) continue;
    for (const stage of ["intent", "spec", "plan"] as const) {
      if (r.kata === `sdlc-${system}-${change}-${stage}`) out[stage] += 1;
    }
  }
  return out;
}

export type BuildRun = {
  target: { repo: string } | "review";
  timeoutSecs: number;
  instructions: string | null;
  workspaceFolder: string;
  masterRepo: string;
  systemRepos: string[];
  checksDir: string;
  continueOnLeftovers: boolean;
};
export const DEFAULT_BUILD_SECS = 7200;
export function canBuild(_catalog: CatalogEntry[], _version: string | null): boolean {
  return false;
}
export function stopMessage(_exit: number | null, _error: string | null): string {
  return "";
}
