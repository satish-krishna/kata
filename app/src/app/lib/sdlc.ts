/* Pure AI-SDLC stage logic: which actions a stage offers, how it is labeled,
 * how a stage run-spec is built, and how a run's transcript id is found.
 * No Angular, no I/O. */

import type { CatalogEntry } from "@bindings/CatalogEntry";
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
  | "reopen-intent";

const ACTIONS: Record<Stage, StageAction[]> = {
  "intent-in-progress": ["continue-intent"],
  "intent-awaiting": ["continue-intent", "accept-intent", "reject-intent"],
  "intent-accepted-uncommitted": ["commit-acceptance", "continue-intent"],
  rejected: [],
  "spec-ready": ["start-spec", "reopen-intent"],
  "spec-awaiting": ["continue-spec", "accept-spec", "reopen-intent"],
  "spec-accepted-uncommitted": ["commit-acceptance", "continue-spec"],
  "plan-ready": ["start-plan", "reopen-intent"],
  "plan-written": ["rerun-plan", "reopen-intent"],
  "plan-superseded": ["start-plan"],
};

/** The spec's "Stage derivation and actions" table, Actions column, in order. */
export function actionsFor(stage: Stage): StageAction[] {
  return [...ACTIONS[stage]];
}

export type StageLabel = {
  step: "intent" | "spec" | "plan" | "closed";
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
  "plan-written": { step: "plan", text: "Plan · written", tone: "success" },
  "plan-superseded": { step: "plan", text: "Plan · superseded", tone: "warning" },
};

export function stageLabel(stage: Stage): StageLabel {
  return { ...LABELS[stage] };
}

export type RunContext = {
  folder: string;
  system: string;
  change: string | null;
  idea?: string;
  repos?: string[];
};

export type SdlcKind = "setup" | "context" | "intent" | "spec" | "plan";

const AI_SDLC = "ai-sdlc";
const SUPERPOWERS = "superpowers";

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

function taskFor(kind: SdlcKind, action: StageAction | null, ctx: RunContext, catalog: CatalogEntry[]): string {
  const { system, change } = ctx;
  switch (kind) {
    case "setup":
      return system ? `Use the ai-sdlc setup skill. System: ${system}` : "Use the ai-sdlc setup skill.";
    case "context":
      return `Use the ai-sdlc context skill for system ${system}, repositories: ${(ctx.repos ?? []).join(", ")}.`;
    case "intent": {
      if (change === null) return `Use the ai-sdlc intent skill for system ${system}. The idea: ${ctx.idea ?? ""}`;
      const resume = `Use the ai-sdlc intent skill for system ${system} on the existing change folder ${change}. Resume the draft.`;
      return action === "reopen-intent"
        ? `${resume} The user has already confirmed reopening this accepted intent; do not ask again.`
        : resume;
    }
    case "spec":
      return `Use the ai-sdlc spec skill for system ${system} on change folder ${change}.`;
    case "plan": {
      let task = `Use the ai-sdlc plan skill for system ${system} on change folder ${change}.`;
      if (!hasPlugin(catalog, SUPERPOWERS)) task += " --standalone";
      if (action === "rerun-plan") task += " The user has already confirmed replacing the existing plan; do not ask again.";
      return task;
    }
  }
}

/** Build the run-spec for one AI-SDLC run. Always bypass-valid: allow/deny/ask stay empty. */
export function specFor(
  kind: SdlcKind,
  action: StageAction | null,
  ctx: RunContext,
  settings: Settings,
  catalog: CatalogEntry[],
): RunSpec {
  const spec = defaultSpec();
  const plugins: Record<string, PluginConfig> = { [AI_SDLC]: {} };
  if (kind === "plan" && hasPlugin(catalog, SUPERPOWERS)) plugins[SUPERPOWERS] = {};
  spec.name = nameFor(kind, ctx);
  spec.task = taskFor(kind, action, ctx, catalog);
  spec.workdir = ctx.folder;
  spec.plugins = plugins;
  // Outside the empty room: `--bare` ignores the operator's claude login and accepts only an API key.
  spec.auth = { bare: false, token_env: null };
  spec.interactive = { enabled: false, answer_timeout_secs: 3600 };
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
  "reopen-intent": "Reopen intent",
};

export function actionLabel(action: StageAction): string {
  return LABEL[action];
}

const PRIMARY_ORDER: RegExp[] = [/^accept-/, /^commit-acceptance$/, /^start-/, /^continue-/];

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
