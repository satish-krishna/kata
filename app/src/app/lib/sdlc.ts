/* Pure AI-SDLC stage logic: which actions a stage offers, how it is labeled,
 * how a stage run-spec is built, and how a run's transcript id is found.
 * No Angular, no I/O. */

import type { CatalogEntry } from "@bindings/CatalogEntry";
import type { ChangeInfo } from "@bindings/ChangeInfo";
import type { Given } from "@bindings/Given";
import type { PluginConfig } from "@bindings/PluginConfig";
import type { RunLink } from "@bindings/RunLink";
import type { RunRecord } from "@bindings/RunRecord";
import type { RunSpec } from "@bindings/RunSpec";
import type { Settings } from "@bindings/Settings";
import type { Stage } from "@bindings/Stage";
import type { KataEvent, RunDetail } from "./events";
import { defaultSpec } from "./spec";

/** The plugins an AI-SDLC run cannot work without; passed to `previewRun` so the preview locks them on. */
export const SDLC_REQUIRED_PLUGINS: readonly string[] = ['ai-sdlc'] as const;

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
  // The plan could not be read, so nothing may be built or rewritten from what is shown; the list says why.
  "plan-unreadable": [],
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
 * reopened; a reopened intent or spec keeps its own stage, so it only reaches here from older data and has
 * no action; any other cause means the plan is rewritten.
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
  "plan-unreadable": { step: "plan", text: "Plan · could not be read", tone: "warning" },
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

/** One build run: a repository's run or the whole-change review, with everything its run-spec needs. */
export type BuildRun = {
  target: { repo: string } | "review";
  timeoutSecs: number;
  instructions: string | null;
  workspaceFolder: string;
  /** Folder name of the master repository, inside the workspace folder. */
  masterRepo: string;
  /** Folder names of the system's product repositories, inside the workspace folder. */
  systemRepos: string[];
  /** Absolute path of Kata's checks folder; no build run may edit it. */
  checksDir: string;
  continueOnLeftovers: boolean;
};

export const DEFAULT_BUILD_SECS = 7200;

const AI_SDLC = "ai-sdlc";

/** The text of a repository's stop (R6.1). The cancelled fact decides first, and a cancelled stop carries no error text; the exit code only tells the other stops apart. */
export function stopMessage(exit: number | null, error: string | null, cancelled = false): string {
  if (cancelled) return "Stopped: cancelled";
  const base =
    exit === 124 ? "Stopped: reached the time limit"
    : exit === 130 ? "Stopped: cancelled"
    : exit === 123 ? "Stopped: nobody answered"
    : "Stopped: the agent failed";
  return error ? `${base} · ${error}` : base;
}

const BUILD_DENY = ["Bash(git push:*)", "Bash(gh:*)", "Bash(git remote:*)"];
const GITHUB_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"];

const slashes = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * A path in claude's absolute-path rule form: `//` then the path with forward slashes. On Windows claude
 * matches only the colon-less, lowercase-drive form (`D:\ws` becomes `//d/ws`). T36's proofs in
 * `crates/kata-core/tests/run_it.rs` copy the rule strings built here.
 */
function rulePath(p: string): string {
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(slashes(p));
  const rest = drive ? `${drive[1].toLowerCase()}/${slashes(p).slice(drive[0].length)}` : slashes(p).replace(/^\/+/, "");
  return `//${rest}`;
}

/** Only `Edit(path)` rules are checked by claude's file permissions; they cover Write and every other editing tool. */
function buildPermissions(run: BuildRun, ctx: RunContext) {
  const ws = slashes(run.workspaceFolder);
  const deny = [...BUILD_DENY, `Edit(${rulePath(run.checksDir)}/**)`];
  const allow = [`Read(${rulePath(ws)}/**)`];
  const changeDir = `${ws}/${run.masterRepo}/intent/${ctx.system}/${ctx.change}`;
  const buildDir = `${changeDir}/build`;
  if (run.target === "review") {
    // The review records its findings in the change's review document and edits nothing else. Deny beats allow in
    // claude, so the workspace cannot be denied as a whole: every product repository and every other document of
    // the change is denied by name instead.
    const repos = new Set([...run.systemRepos, run.masterRepo]);
    for (const other of repos) {
      if (other !== run.masterRepo) deny.push(`Edit(${rulePath(`${ws}/${other}`)}/**)`);
      deny.push(`Edit(${rulePath(`${buildDir}/${other}.md`)})`);
    }
    for (const doc of ["intent.md", "spec.md", "plan.md"]) deny.push(`Edit(${rulePath(`${changeDir}/${doc}`)})`);
    allow.push(`Edit(${rulePath(`${buildDir}/review.md`)})`);
  } else {
    const repo = run.target.repo;
    // Deny beats allow in claude, so a `build/**` deny would block this run's own log; deny the others by name.
    const repos = new Set([...run.systemRepos, run.masterRepo]);
    for (const other of repos) {
      if (other === repo) continue;
      deny.push(`Edit(${rulePath(`${buildDir}/${other}.md`)})`);
      if (other !== run.masterRepo) deny.push(`Edit(${rulePath(`${ws}/${other}`)}/**)`);
    }
    // Earlier reviews are the review run's record; a build run does not rewrite them.
    deny.push(`Edit(${rulePath(`${buildDir}/review.md`)})`);
    allow.push(`Edit(${rulePath(`${buildDir}/${repo}.md`)})`);
  }
  return { deny, allow };
}

function buildTask(run: BuildRun, ctx: RunContext): string {
  const flag = run.target === "review" ? "--review" : `--repo ${run.target.repo}`;
  let task = `Use the ai-sdlc build skill for system ${ctx.system} on change folder ${ctx.change} with ${flag}.`;
  if (run.continueOnLeftovers) {
    task += " The engineer has already confirmed continuing on top of the uncommitted edits the previous run left; do not ask again.";
  }
  const instructions = run.instructions?.trim() ?? "";
  if (run.target !== "review" && instructions) task += `\n\nInstructions from the engineer for this run:\n${instructions}`;
  return task;
}

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
      throw new Error("a build run-spec is made from its BuildRun");
  }
}

const SDLC_TIMEOUT_SECS = 6 * 60 * 60;

/**
 * The run-spec of one build run. Always auto: bypass forbids the deny rules that keep an agent from publishing,
 * and `settings.permission_mode` does not apply. No turn cap and no budget; the time limit is per run.
 */
function buildSpec(ctx: RunContext, run: BuildRun): RunSpec {
  const spec = defaultSpec();
  const ws = slashes(run.workspaceFolder);
  const repo = run.target === "review" ? run.masterRepo : run.target.repo;
  spec.name = `sdlc-${ctx.system}-${ctx.change}-${run.target === "review" ? "review" : `build-${run.target.repo}`}`;
  spec.task = buildTask(run, ctx);
  spec.workdir = `${ws}/${repo}`;
  spec.plugins = { [AI_SDLC]: {} };
  spec.auth = { bare: false, token_env: null };
  spec.interactive = { enabled: true, answer_timeout_secs: 3600 };
  spec.leash.timeout_secs = run.timeoutSecs;
  spec.leash.max_turns = null;
  spec.leash.max_budget_usd = null;
  spec.env_remove = [...GITHUB_TOKENS];
  const { allow, deny } = buildPermissions(run, ctx);
  spec.permissions = { mode: "auto", allow, deny, ask: [], unmatched: "ask" };
  return spec;
}

/** Build the run-spec for one AI-SDLC run. Always bypass-valid: allow/deny/ask stay empty. */
export function specFor(
  kind: SdlcKind,
  action: StageAction | null,
  ctx: RunContext,
  settings: Settings,
  catalog: CatalogEntry[],
  run?: BuildRun,
): RunSpec {
  if (kind === "build") {
    if (!run) throw new Error("a build run-spec needs its BuildRun");
    return buildSpec(ctx, run);
  }
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

/** A leading `---` front-matter block: its lines and the text after it, or null when the document has none. */
function frontMatterBlock(text: string): { lines: string[]; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? { lines: m[1].split(/\r?\n/), body: text.slice(m[0].length) } : null;
}

/**
 * A document's front matter as `[key, value]` fields in the order written, and the text after the block. A value is
 * the raw scalar text: a list stays as written (`[kata@7226252]`). Lines that are not `key: value` are skipped.
 */
export function parseFrontMatter(text: string): { fields: [string, string][]; body: string } {
  const block = frontMatterBlock(text);
  if (!block) return { fields: [], body: text };
  const fields: [string, string][] = [];
  for (const line of block.lines) {
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*?)\s*$/.exec(line);
    if (m) fields.push([m[1], m[2]]);
  }
  return { fields, body: block.body };
}

/** Which of a change's three documents exist on disk. */
export type DocsPresent = Record<"intent" | "spec" | "plan", boolean>;

export type RunStage = "intent" | "spec" | "plan" | "build" | "review";

/** The stage a transcript link belongs to: `build:<repo>` is the build; an unknown stage belongs to none. */
function linkStage(stage: string): RunStage | null {
  if (stage.startsWith("build:")) return "build";
  return stage === "intent" || stage === "spec" || stage === "plan" || stage === "review" ? stage : null;
}

/**
 * The runs of one stage of a change, newest first: the transcript links recorded for it, plus history records that
 * carry the stage's deterministic run name and are not linked yet (the fallback for a run whose link was never
 * written). A link whose record is gone is listed under that deterministic name, so it still counts.
 */
export function stageRuns(
  links: readonly RunLink[],
  records: readonly RunRecord[],
  workspaceId: string,
  system: string,
  change: string,
  stage: RunStage,
): RunRecord[] {
  const prefix = `sdlc-${system}-${change}-`;
  const byId = new Map(records.map((r) => [r.id, r]));
  const mine = links.filter((l) => l.workspace_id === workspaceId && l.system === system && l.change === change);
  const linked = new Set(mine.map((l) => l.run_id));
  const out = new Map<string, RunRecord>();
  for (const l of mine) {
    if (linkStage(l.stage) !== stage || out.has(l.run_id)) continue;
    const kata = `${prefix}${l.stage.replace(":", "-")}`;
    out.set(l.run_id, byId.get(l.run_id) ?? { id: l.run_id, kata, started_at: l.started_at, isolation: "none" });
  }
  for (const r of records) {
    if (linked.has(r.id) || out.has(r.id)) continue;
    const own = stage === "build" ? r.kata.startsWith(`${prefix}build-`) : r.kata === `${prefix}${stage}`;
    if (own) out.set(r.id, r);
  }
  return [...out.values()].sort((a, b) => b.started_at - a.started_at);
}

export type PillStep = "intent" | "spec" | "plan" | "build";
export type PillTone = "success" | "warning" | "error" | "idle";
/** One stage pill of the change toolbar. `ariaLabel` is set only where the visible text alone does not say enough. */
export type StagePill = {
  step: PillStep;
  title: string;
  text: string;
  tone: PillTone;
  disabled: boolean;
  /** The pill the change is at now (`aria-current="step"`). */
  current: boolean;
  ariaLabel: string | null;
};

const PILL_STEPS: readonly { step: PillStep; title: string }[] = [
  { step: "intent", title: "Intent" },
  { step: "spec", title: "Spec" },
  { step: "plan", title: "Plan" },
  { step: "build", title: "Build" },
];

/**
 * The four stage pills of a change. The current step shows the stage's label and tone; steps before it read as
 * accepted and steps after it as not started. A rejected change is closed on the intent step and a done change sits
 * on the build step. A document pill is disabled until its document exists. The Build pill is locked until the plan
 * is accepted, then disabled until a repository has the change's branch.
 */
export function stagePills(stage: Stage, done: boolean, docs: DocsPresent, build: { hasBranch: boolean }): StagePill[] {
  const label = done ? DONE_LABEL : stageLabel(stage);
  const accepted = label.step === "build" || label.step === "done";
  const sitsOn = label.step === "closed" ? "intent" : label.step === "done" ? "build" : label.step;
  const at = PILL_STEPS.findIndex((p) => p.step === sitsOn);
  const tone: PillTone = label.tone === "muted" ? "idle" : label.tone;
  return PILL_STEPS.map(({ step, title }, i) => {
    const current = i === at;
    if (step === "build") {
      const disabled = !accepted || !build.hasBranch;
      if (!accepted) return { step, title, text: "Build · locked", tone: "idle", disabled: true, current, ariaLabel: null };
      return { step, title, text: done ? "Build · done" : label.text, tone: done ? "success" : tone, disabled, current, ariaLabel: null };
    }
    const disabled = !docs[step];
    if (current) return { step, title, text: label.text, tone, disabled, current, ariaLabel: null };
    if (i < at) return { step, title, text: title, tone: "success", disabled, current, ariaLabel: `${title}, accepted` };
    return { step, title, text: `${title} · not started`, tone: "idle", disabled, current, ariaLabel: null };
  });
}

export type Severity = "critical" | "high" | "medium" | "low";
/** One finding of the review, with the severity its text opens with, if it names one. */
export type Finding = { severity: Severity | null; text: string; id?: string; file?: string; line?: number };



const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_WORDS: Record<string, Severity> = {
  critical: "critical", blocker: "critical", high: "high", major: "high", medium: "medium", moderate: "medium", low: "low", minor: "low", nit: "low",
};
const WORDS = Object.keys(SEVERITY_WORDS).join("|");
// A tag opens an item as [High], (high), **High**, or High: / High -.
const SEVERITY_TAG = new RegExp(
  String.raw`^\s*(?:[\[(]\s*(${WORDS})\s*[\])]|\*\*\s*(${WORDS})\s*\*\*|(${WORDS})(?=\s*[:\u2013-]))\s*[:\u2013-]?\s*`,
  "i",
);
const NO_FINDINGS = /^\s*no\s+(?:issues|findings|problems|concerns)\b/i;

/** The items of a list numbered 1, 2, 3 in order, on one line or several; null when the text has no such list. */
function numberedItems(text: string): string[] | null {
  const marks: { start: number; end: number }[] = [];
  let from = 0;
  for (let n = 1; ; n++) {
    const re = new RegExp(String.raw`(^|\s)${n}[.)]\s+`, "g");
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) break;
    marks.push({ start: m.index, end: m.index + m[0].length });
    from = m.index + m[0].length;
  }
  if (marks.length === 0) return null;
  return marks.map((m, i) => text.slice(m.end, marks[i + 1]?.start ?? text.length).trim());
}

/** The items of a `-`, `*` or bullet list, one per line, with a wrapped line joined to the item above it. */
function bulletItems(text: string): string[] | null {
  const items: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*\u2022]\s+(.*)$/.exec(line);
    if (m) items.push(m[1].trim());
    else if (items.length > 0 && line.trim() !== "") items[items.length - 1] += ` ${line.trim()}`;
  }
  return items.length > 0 ? items : null;
}

function asFinding(item: string): Finding {
  const m = SEVERITY_TAG.exec(item);
  if (!m) return { severity: null, text: item };
  const word = (m[1] ?? m[2] ?? m[3]).toLowerCase();
  return { severity: SEVERITY_WORDS[word], text: item.slice(m[0].length).trim() };
}

/**
 * The review's findings, most serious first, read from the closing text of its `run.completed`.
 * The text is a list numbered in order or bulleted; a severity tag at the start of an item ranks it.
 * Items without a tag rank as medium, and equal ranks keep the order written.
 */
export function reviewFindings(detail: RunDetail): Finding[] {
  let result = "";
  for (let i = detail.events.length - 1; i >= 0; i--) {
    const ev = detail.events[i];
    if (ev.type === "run.completed") {
      result = (ev.result ?? "").trim();
      break;
    }
  }
  if (result === "") return [];
  const items = numberedItems(result) ?? bulletItems(result);
  if (items === null) return NO_FINDINGS.test(result) ? [] : [asFinding(result)];
  const rank = (f: Finding) => SEVERITY_RANK[f.severity ?? "medium"];
  return items
    .filter((t) => t !== "")
    .map(asFinding)
    .map((f, index) => ({ f, index }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.index - b.index)
    .map(({ f }) => f);
}

// Stubs: the build's preview is specified by tests first.
export type BuildPreviewKind = "start" | "continue-all" | "continue-one" | "round" | "manual-review";
export type BuildPreviewPlan = {
  asksTimeLimit: boolean;
  asksRound: boolean;
  sections: "all-repos-and-review" | "one-repo" | "review";
  appliesTo: "build" | "repo-then-build" | "repos-then-build" | "round-then-build" | "this-review";
  limitSource: "engineer" | "build" | "kata";
};
export function buildPreviewFor(_kind: BuildPreviewKind): BuildPreviewPlan {
  throw new Error("not implemented");
}
export function safetyRules(_target: "repo" | "review"): string[] {
  return [];
}
export function givenFor(_off: ReadonlySet<string>, _workdir: string): Given {
  throw new Error("not implemented");
}
