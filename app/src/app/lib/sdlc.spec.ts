import type { CatalogEntry } from "@bindings/CatalogEntry";
import type { ChangeInfo } from "@bindings/ChangeInfo";
import type { OutOfDate } from "@bindings/OutOfDate";
import type { Settings } from "@bindings/Settings";
import type { Stage } from "@bindings/Stage";
import type { WorkspaceScan } from "@bindings/WorkspaceScan";
import type { KataEvent, RunDetail } from "./events";
import { validateLocal } from "./mock";
import { DONE_LABEL, changeLabel, fixProgramFailed, actionLabel, actionLabelAt,buildPreviewFor, givenFor, safetyRules, actionsFor, actionsForChange, feedbackRequired, hasAiSdlcPlugin, isBuildRun, primaryAction, restrictedFor, reviewFindings, revisits, specFor, stageLabel, stopMessage, transcriptRunId, type BuildPreviewKind, type BuildPreviewPlan, type BuildRun, type Restricted, type RunContext, type StageAction } from "./sdlc";

const plugin = (name: string): CatalogEntry => ({
  kind: "plugin", name, description: "", source: "user", path: `/p/${name}`, provides: [], mcp_servers: [],
});
const skill = (name: string): CatalogEntry => ({ ...plugin(name), kind: "skill" });
const both = [plugin("ai-sdlc"), plugin("superpowers")];
const bypass: Settings = { mode: null, remember: false, permission_mode: "bypass" };
const prompt: Settings = { ...bypass, permission_mode: "prompt" };
const ctx: RunContext = { folder: "/ws", system: "commerce", change: "2026-10-12-photos" };

const ACTIONS: Record<Stage, string[]> = {
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
  "plan-out-of-date": [],
  "plan-unreadable": [],
  "plan-superseded": ["rerun-plan"],
  "build-ready": ["start-build", "reopen-intent"],
  "build-stopped": ["continue-build", "another-round"],
  "build-finished": ["declare-done", "another-round", "run-review"],
  "fix-in-progress": [],
  "fix-unsettled": [],
  "fix-awaiting": [],
  "fix-accepting": [],
  "fix-needs-plugin": [],
};

const changeAt = (stage: Stage, outOfDate: OutOfDate | null = null): ChangeInfo => ({
  system: "commerce", change: "2026-10-12-photos", stage, scope: "commerce", out_of_date: outOfDate, plan_unreadable: false, plan_unreadable_reason: null, track: 'full', fix_row: null,
  intent: { exists: true, committed: true, status: "accepted", head_status: "accepted" },
  spec: { exists: true, committed: true, status: "accepted", head_status: "accepted" },
  plan: { exists: true, committed: true, status: "accepted", head_status: "accepted" },
  build: { tasks: 2, finished: 0, repos: 1 },
});

describe("actionsFor", () => {
  for (const [stage, actions] of Object.entries(ACTIONS)) {
    it(stage, () => expect(actionsFor(stage as Stage)).toEqual(actions));
  }
});

describe("plan and build actions", () => {
  it("plan-awaiting offers accept, rerun, reopen and no build (R1.1)", () => {
    const got = actionsFor("plan-awaiting");
    expect(got).toEqual(["accept-plan", "rerun-plan", "reopen-intent"]);
    expect(got).not.toContain("start-build");
    expect(got).not.toContain("continue-build");
  });

  it("declare-done only in build-finished (R11.4)", () => {
    for (const stage of Object.keys(ACTIONS) as Stage[]) {
      expect(actionsFor(stage).includes("declare-done")).toBe(stage === "build-finished");
    }
    expect(actionsForChange(changeAt("build-stopped"))).not.toContain("declare-done");
  });

  it("out-of-date actions follow the cause", () => {
    expect(actionsForChange(changeAt("plan-out-of-date", "spec-pin"))).toEqual(["reopen-spec"]);
    expect(actionsForChange(changeAt("plan-out-of-date", "intent-reopened"))).toEqual([]);
    expect(actionsForChange(changeAt("plan-out-of-date", "spec-reopened"))).toEqual([]);
    expect(actionsForChange(changeAt("plan-out-of-date", "plan-pin"))).toEqual(["rerun-plan"]);
    expect(actionsForChange(changeAt("plan-out-of-date", "no-tasks"))).toEqual(["rerun-plan"]);
    expect(actionsForChange(changeAt("build-ready"))).toEqual(["start-build", "reopen-intent"]);
  });
});

const fixAt = (stage: Stage, outOfDate: OutOfDate | null = null, finished = 0): ChangeInfo => ({
  ...changeAt(stage, outOfDate),
  track: "fix",
  build: { tasks: 2, finished, repos: 1 },
});

const FIX_RESTRICTED = ["continue-intent", "accept-intent", "reject-intent", "commit-acceptance", "start-spec", "continue-spec", "accept-spec", "reopen-spec", "reopen-intent", "start-plan", "rerun-plan", "accept-plan"];

describe("actions of a fix (R4.1, R7.3)", () => {
  const rows: [Stage, OutOfDate | null, string[]][] = [
    ["fix-in-progress", null, ["finish-fix-draft"]],
    ["fix-unsettled", null, []],
    ["fix-awaiting", null, ["accept-fix", "change-fix"]],
    ["fix-accepting", null, ["accept-fix", "change-fix"]],
    ["fix-needs-plugin", null, []],
    ["rejected", null, []],
    ["build-ready", null, ["start-build", "reopen-fix"]],
    ["build-ready", "plan-pin", ["start-build", "reopen-fix"]],
    ["build-stopped", null, ["continue-build", "another-round", "reopen-fix"]],
    ["build-finished", null, ["declare-done", "another-round", "run-review", "reopen-fix"]],
    ["plan-out-of-date", "spec-pin", ["reopen-fix"]],
    ["plan-out-of-date", "intent-reopened", ["reopen-fix"]],
    ["plan-out-of-date", "spec-reopened", ["reopen-fix"]],
    ["plan-out-of-date", "plan-pin", ["reopen-fix"]],
    ["plan-out-of-date", "no-tasks", ["reopen-fix"]],
    ["plan-unreadable", null, []],
    ["plan-superseded", null, []],
    ["intent-in-progress", null, []],
    ["intent-awaiting", null, []],
    ["intent-accepted-uncommitted", null, []],
    ["spec-ready", null, []],
    ["spec-awaiting", null, []],
    ["spec-accepted-uncommitted", null, []],
    ["plan-ready", null, []],
    ["plan-awaiting", null, []],
    ["plan-accepted-uncommitted", null, []],
  ];
  for (const [stage, outOfDate, expected] of rows) {
    it(`${stage} ${outOfDate ?? "-"}`, () => {
      const got = actionsForChange(drafted(fixAt(stage, outOfDate)));
      expect(got).toEqual(expected);
      for (const banned of FIX_RESTRICTED) expect(got).not.toContain(banned);
    });
  }

  const drafted = (c: ChangeInfo): ChangeInfo => ({ ...c, intent: { ...c.intent, status: "draft", head_status: "draft" } });

  const awaiting = (row: number | null, finished = 0, intentStatus = "draft"): ChangeInfo => ({
    ...fixAt("fix-awaiting", null, finished),
    fix_row: row,
    intent: { exists: true, committed: true, status: intentStatus, head_status: intentStatus },
  });

  it("a fix awaiting acceptance offers the full pipeline at row 6 alone", () => {
    expect(actionsForChange(awaiting(6))).toEqual(["accept-fix", "change-fix", "full-pipeline-instead"]);
    expect(actionsForChange(awaiting(7))).toEqual(["accept-fix", "change-fix"]);
    expect(actionsForChange(awaiting(null))).toEqual(["accept-fix", "change-fix"]);
  });

  it("the row decides, whatever the build count or the intent status say", () => {
    expect(actionsForChange(awaiting(6, 1))).toEqual(["accept-fix", "change-fix", "full-pipeline-instead"]);
    expect(actionsForChange(awaiting(6, 0, "accepted"))).toEqual(["accept-fix", "change-fix", "full-pipeline-instead"]);
    expect(actionsForChange(awaiting(7, 0, "draft"))).toEqual(["accept-fix", "change-fix"]);
  });

  it("a fix that needs the plugin is labelled so, as a warning, with no actions", () => {
    expect(stageLabel("fix-needs-plugin")).toEqual({ step: "intent", text: "Fix · needs ai-sdlc 0.13.0", tone: "warning" });
    expect(actionsForChange(fixAt("fix-needs-plugin"))).toEqual([]);
  });

  it("feedback is required for changing a fix, and for reopening one except when its plan is out of date on a broken pin", () => {
    for (const stage of Object.keys(ACTIONS) as Stage[]) {
      for (const action of actionsForChange(fixAt(stage, "spec-pin"))) {
        const expected = action === "change-fix" || (action === "reopen-fix" && stage !== "plan-out-of-date");
        expect(feedbackRequired(action, stage, "spec-pin"), `${action} at ${stage}`).toBe(expected);
      }
    }
    expect(feedbackRequired("change-fix", "fix-awaiting", null)).toBe(true);
    expect(feedbackRequired("change-fix", "fix-accepting", null)).toBe(true);
    expect(feedbackRequired("accept-fix", "fix-accepting", null)).toBe(false);
    expect(feedbackRequired("reopen-fix", "build-ready", null)).toBe(true);
    expect(feedbackRequired("finish-fix-draft", "fix-in-progress", null)).toBe(false);
    expect(feedbackRequired("continue-spec", "spec-awaiting", null)).toBe(false);
  });

  it.each<[OutOfDate, boolean]>([
    ["intent-reopened", true],
    ["spec-reopened", true],
    ["spec-pin", false],
    ["plan-pin", false],
    ["no-tasks", true],
  ])("reopening a fix at plan-out-of-date because of %s requires feedback: %s", (cause, expected) => {
    expect(feedbackRequired("reopen-fix", "plan-out-of-date", cause)).toBe(expected);
  });

  it("a closed fix is labeled as closed (R7.3)", () => {
    expect(stageLabel("rejected").text).toBe("Closed · rejected");
  });

  it("the fix stages are labeled and sort with early work", () => {
    expect(stageLabel("fix-in-progress")).toEqual({ step: "intent", text: "Fix · changes not recorded", tone: "warning" });
    expect(stageLabel("fix-unsettled")).toEqual({ step: "intent", text: "Fix · statuses not settled", tone: "warning" });
    expect(stageLabel("fix-awaiting")).toEqual({ step: "intent", text: "Fix · awaiting acceptance", tone: "warning" });
    expect(stageLabel("fix-accepting")).toEqual({ step: "plan", text: "Fix · acceptance stopped", tone: "warning" });
  });

  it("a program failure at fix-unsettled reads could not be read; row 2 keeps not settled (F5)", () => {
    const at = (fix_row: number | null) => ({ track: "fix" as const, stage: "fix-unsettled" as const, fix_row });
    expect(fixProgramFailed(at(null))).toBe(true);
    expect(fixProgramFailed(at(2))).toBe(false);
    expect(fixProgramFailed({ track: "full", stage: "fix-unsettled", fix_row: null })).toBe(false);
    expect(fixProgramFailed({ track: "fix", stage: "fix-needs-plugin", fix_row: null })).toBe(false);
    expect(changeLabel(at(null))).toEqual({ step: "intent", text: "Fix · could not be read", tone: "warning" });
    expect(changeLabel(at(2)).text).toBe("Fix · statuses not settled");
  });

  it("labels the fix actions", () => {
    expect(actionLabel("accept-fix")).toBe("Accept fix");
    expect(actionLabelAt("accept-fix", "fix-accepting")).toBe("Finish acceptance");
    expect(actionLabelAt("accept-fix", "fix-awaiting")).toBe("Accept fix");
    expect(actionLabelAt("start-build", "fix-awaiting")).toBe("Start build");
    expect(actionLabel("finish-fix-draft")).toBe("Finish the draft");
    expect(actionLabel("change-fix")).toBe("Change the fix");
    expect(actionLabel("reopen-fix")).toBe("Reopen the fix");
    expect(actionLabel("full-pipeline-instead")).toBe("Take the full pipeline instead");
  });

  it("finishing the draft, changing and reopening open the feedback box", () => {
    for (const a of ["finish-fix-draft", "change-fix", "reopen-fix"] as const) expect(revisits(a)).toBe(true);
    for (const a of ["accept-fix", "full-pipeline-instead"] as const) expect(revisits(a)).toBe(false);
  });

  it("the primary action is the first of the list that fits", () => {
    expect(primaryAction(["finish-fix-draft"])).toBe("finish-fix-draft");
    expect(primaryAction(["accept-fix", "change-fix", "full-pipeline-instead"])).toBe("accept-fix");
    expect(primaryAction(["reopen-fix"])).toBeNull();
  });
});

describe("actions of a full-pipeline change are unchanged (R13.1)", () => {
  const rows: [Stage, OutOfDate | null, string[]][] = [
    ["intent-awaiting", null, ["continue-intent", "accept-intent", "reject-intent"]],
    ["spec-awaiting", null, ["continue-spec", "accept-spec", "reopen-intent"]],
    ["plan-awaiting", null, ["accept-plan", "rerun-plan", "reopen-intent"]],
    ["build-ready", null, ["start-build", "reopen-intent"]],
    ["build-stopped", null, ["continue-build", "another-round"]],
    ["build-finished", null, ["declare-done", "another-round", "run-review"]],
    ["rejected", null, []],
    ["plan-superseded", null, ["rerun-plan"]],
    ["plan-unreadable", null, []],
    ["plan-out-of-date", "spec-pin", ["reopen-spec"]],
    ["plan-out-of-date", "plan-pin", ["rerun-plan"]],
  ];
  for (const [stage, outOfDate, expected] of rows) {
    it(`${stage} ${outOfDate ?? "-"}`, () => expect(actionsForChange(changeAt(stage, outOfDate))).toEqual(expected));
  }
});

describe("stageLabel", () => {
  it("build stage labels (R14.1)", () => {
    expect(stageLabel("build-ready")).toMatchObject({ step: "build", text: "Build · ready to start" });
    expect(stageLabel("build-stopped")).toMatchObject({ step: "build", text: "Build · in progress (stopped)" });
    expect(stageLabel("build-finished")).toMatchObject({ step: "build", text: "Build · finished, not yet done" });
    expect(stageLabel("plan-awaiting").text).toBe("Plan · awaiting acceptance");
    expect(stageLabel("plan-accepted-uncommitted").text).toBe("Plan · accepted, not committed");
    expect(stageLabel("plan-out-of-date").text).toBe("Plan · out of date");
    expect(DONE_LABEL).toEqual({ step: "done", text: "Done · pull requests open", tone: "success" });
  });

  it("gives every stage non-empty text", () => {
    for (const s of Object.keys(ACTIONS)) expect(stageLabel(s as Stage).text.length).toBeGreaterThan(0);
  });
  it("maps representative stages", () => {
    expect(stageLabel("rejected")).toMatchObject({ step: "closed", tone: "error" });
    expect(stageLabel("plan-awaiting")).toMatchObject({ step: "plan", tone: "warning" });
    expect(stageLabel("spec-awaiting")).toMatchObject({ step: "spec", tone: "warning" });
    expect(stageLabel("intent-in-progress").step).toBe("intent");
  });
});

describe("hasAiSdlcPlugin", () => {
  it("needs a plugin entry, not a skill", () => {
    expect(hasAiSdlcPlugin(both)).toBe(true);
    expect(hasAiSdlcPlugin([skill("ai-sdlc")])).toBe(false);
    expect(hasAiSdlcPlugin([])).toBe(false);
  });
});

describe("specFor", () => {
  it("setup", () => {
    const s = specFor("setup", null, { folder: "/ws", system: "", change: null }, bypass, both);
    expect(s.name).toBe("sdlc-setup");
    expect(s.workdir).toBe("/ws");
    expect(s.task).toBe("Use the ai-sdlc setup skill.");
    expect(Object.keys(s.plugins)).toEqual(["ai-sdlc"]);
    expect(s.interactive.answer_timeout_secs).toBe(3600);
    expect(s.permissions.mode).toBe("bypass");
    expect(s.interactive.enabled).toBe(false);
  });
  it("runs outside the empty room, so the operator's claude login applies", () => {
    const s = specFor("intent", null, { folder: "/ws", system: "commerce", change: null, idea: "x" }, bypass, both);
    expect(s.auth).toEqual({ bare: false, token_env: null });
  });
  it("gets a six-hour wall clock, since a build outlasts the engine's 30-minute default", () => {
    const s = specFor("plan", null, ctx, bypass, both);
    expect(s.leash.timeout_secs).toBe(6 * 60 * 60);
  });
  it("runs the document kinds under the classifier when the setting is auto", () => {
    const autoSettings: Settings = { ...bypass, permission_mode: "auto" };
    const intent = specFor("intent", null, { ...ctx, change: null, idea: "x" }, autoSettings, both);
    const context = specFor("context", null, { ...ctx, change: null, repos: ["a"] }, autoSettings, both);
    for (const s of [intent, context]) {
      expect(s.permissions.mode).toBe("auto");
      expect(s.permissions.allow).toEqual([]);
      expect(s.permissions.deny).toEqual([]);
      expect(s.interactive.enabled).toBe(true);
    }
  });
  it("setup with a system", () => {
    const s = specFor("setup", null, { folder: "/ws", system: "commerce", change: null }, bypass, both);
    expect(s.task).toBe("Use the ai-sdlc setup skill. System: commerce");
  });
  it("context", () => {
    const s = specFor("context", null, { ...ctx, change: null, repos: ["a", "b"] }, bypass, both);
    expect(s.name).toBe("sdlc-commerce-context");
    expect(s.task).toBe(
      "Use the ai-sdlc context skill for system commerce, repositories: a, b. Refresh each existing context file, even one that is current.",
    );
  });
  it("new intent", () => {
    const s = specFor("intent", null, { ...ctx, change: null, idea: "photo upload" }, bypass, both);
    expect(s.name).toBe("sdlc-commerce-new-intent");
    expect(s.task).toBe("Use the ai-sdlc intent skill for system commerce. The idea: photo upload");
  });
  it("continue and reopen intent", () => {
    const c = specFor("intent", "continue-intent", ctx, bypass, both);
    expect(c.name).toBe("sdlc-commerce-2026-10-12-photos-intent");
    expect(c.task).toBe(
      "Use the ai-sdlc intent skill for system commerce on the existing change folder 2026-10-12-photos. Resume the draft.",
    );
    const r = specFor("intent", "reopen-intent", ctx, bypass, both);
    expect(r.task).toBe(c.task + " The user has already confirmed reopening this accepted intent; do not ask again.");
  });
  it("spec", () => {
    const s = specFor("spec", "start-spec", ctx, bypass, both);
    expect(s.name).toBe("sdlc-commerce-2026-10-12-photos-spec");
    expect(s.task).toBe("Use the ai-sdlc spec skill for system commerce on change folder 2026-10-12-photos.");
    expect(Object.keys(s.plugins)).toEqual(["ai-sdlc"]);
  });
  it("plan loads only ai-sdlc, even when superpowers is installed", () => {
    for (const catalog of [both, [plugin("ai-sdlc")]]) {
      const s = specFor("plan", "start-plan", ctx, bypass, catalog);
      expect(s.name).toBe("sdlc-commerce-2026-10-12-photos-plan");
      expect(s.task).toBe("Use the ai-sdlc plan skill for system commerce on change folder 2026-10-12-photos.");
      expect(Object.keys(s.plugins)).toEqual(["ai-sdlc"]);
    }
  });
  it("rerun plan carries the confirmation", () => {
    const s = specFor("plan", "rerun-plan", ctx, bypass, both);
    expect(s.task).toBe(
      "Use the ai-sdlc plan skill for system commerce on change folder 2026-10-12-photos. " +
        "The user has already confirmed replacing the existing plan; do not ask again.",
    );
  });
  it("reopen spec carries the confirmation and touches only the spec", () => {
    const s = specFor("spec", "reopen-spec", ctx, bypass, both);
    expect(s.name).toBe("sdlc-commerce-2026-10-12-photos-spec");
    expect(s.task).toBe(
      "Use the ai-sdlc spec skill for system commerce on change folder 2026-10-12-photos. " +
        "The user has already confirmed reopening this accepted spec; do not ask again.",
    );
  });
  it("continue spec carries the confirmation to regenerate", () => {
    expect(specFor("spec", "continue-spec", ctx, bypass, both).task).toBe(
      "Use the ai-sdlc spec skill for system commerce on change folder 2026-10-12-photos. " +
        "The user has already confirmed regenerating the spec; do not ask again.",
    );
  });
  it("appends the operator's feedback as its own block, and nothing when it is blank", () => {
    const withFeedback = specFor("spec", "reopen-spec", { ...ctx, feedback: "  R3 is wrong: compress, do not refuse.\nKeep R1.  " }, bypass, both);
    const plain = specFor("spec", "reopen-spec", ctx, bypass, both);
    expect(withFeedback.task).toBe(`${plain.task}\n\nOperator feedback:\nR3 is wrong: compress, do not refuse.\nKeep R1.`);
    expect(specFor("spec", "reopen-spec", { ...ctx, feedback: "   " }, bypass, both).task).toBe(plain.task);
  });
  it("names the actions that revisit a document", () => {
    const all = Object.values(ACTIONS).flat().filter((a, i, xs) => xs.indexOf(a) === i) as StageAction[];
    expect(all.filter(revisits).sort()).toEqual(["continue-intent", "continue-spec", "reopen-intent", "reopen-spec", "rerun-plan"]);
  });
  it("prompt mode enables interactive and asks on unmatched", () => {
    const s = specFor("spec", "start-spec", ctx, prompt, both);
    expect(s.permissions.mode).toBe("prompt");
    expect(s.permissions.unmatched).toBe("ask");
    expect(s.interactive.enabled).toBe(true);
    expect(s.interactive.answer_timeout_secs).toBe(3600);
  });
  it("every spec passes validateLocal in both permission modes", () => {
    for (const settings of [bypass, prompt]) {
      const specs = [
        specFor("setup", null, { folder: "/ws", system: "", change: null }, settings, both),
        specFor("context", null, { ...ctx, change: null, repos: ["a"] }, settings, both),
        specFor("intent", null, { ...ctx, change: null, idea: "x" }, settings, both),
        specFor("intent", "reopen-intent", ctx, settings, both),
        specFor("spec", "start-spec", ctx, settings, both),
        specFor("plan", "rerun-plan", ctx, settings, [plugin("ai-sdlc")]),
      ];
      for (const s of specs) expect(validateLocal(s)).toEqual([]);
    }
  });
});

describe("transcriptRunId", () => {
  const log = (message: string): KataEvent => ({ type: "log", level: "info", message });
  it("extracts the stem from a Windows path", () => {
    const evs = [log("other"), log("transcript: C:\\Users\\x\\.kata\\runs\\sdlc-commerce-x-spec-20261018T101500Z.jsonl")];
    expect(transcriptRunId(evs)).toBe("sdlc-commerce-x-spec-20261018T101500Z");
  });
  it("extracts the stem from a POSIX path", () => {
    expect(transcriptRunId([log("transcript: /home/x/.kata/runs/abc.jsonl")])).toBe("abc");
  });
  it("returns null without a transcript event", () => {
    expect(transcriptRunId([log("hello")])).toBeNull();
    expect(transcriptRunId([])).toBeNull();
  });
});

describe("actionLabel and primaryAction", () => {
  it("labels every action in sentence case", () => {
    expect(actionsFor("spec-awaiting").map(actionLabel)).toEqual(["Continue spec", "Accept spec", "Reopen intent"]);
    expect(actionLabel("commit-acceptance")).toBe("Commit acceptance");
    expect(actionLabel("rerun-plan")).toBe("Re-run plan");
    expect(actionLabel("reopen-spec")).toBe("Reopen spec");
  });

  it("picks one primary: accept, then commit, then start, then continue; never reopen or re-run", () => {
    expect(primaryAction(actionsFor("intent-awaiting"))).toBe("accept-intent");
    expect(primaryAction(actionsFor("spec-accepted-uncommitted"))).toBe("commit-acceptance");
    expect(primaryAction(actionsFor("spec-ready"))).toBe("start-spec");
    expect(primaryAction(actionsFor("intent-in-progress"))).toBe("continue-intent");
    expect(primaryAction(actionsFor("plan-awaiting"))).toBe("accept-plan");
    expect(primaryAction(actionsFor("build-finished"))).toBe("declare-done");
    expect(primaryAction(actionsFor("build-stopped"))).toBe("continue-build");
    expect(primaryAction(actionsFor("plan-superseded"))).toBeNull();
    expect(primaryAction(actionsFor("rejected"))).toBeNull();
  });
});

describe("build run-specs", () => {
  const run = (over: Partial<BuildRun> = {}): BuildRun => ({
    target: { repo: "app" },
    timeoutSecs: 7200,
    instructions: null,
    workspaceFolder: "/home/u/ws",
    masterRepo: "master",
    systemRepos: ["master", "app", "api"],
    checksDir: "/home/u/.kata/checks/commerce",
    continueOnLeftovers: false,
    ...over,
  });
  const build = (r: BuildRun, settings: Settings = bypass) =>
    specFor("build", null, { ...ctx, folder: r.workspaceFolder }, settings, both, r);

  it("each repository run carries its own time limit (R2.6)", () => {
    const app = build(run({ target: { repo: "app" }, timeoutSecs: 4 * 3600 }));
    const api = build(run({ target: { repo: "api" }, timeoutSecs: 4 * 3600 }));
    expect(app.leash.timeout_secs).toBe(14400);
    expect(api.leash.timeout_secs).toBe(14400);
    expect(build(run({ target: { repo: "api" }, timeoutSecs: 600 })).leash.timeout_secs).toBe(600);
    expect(app.name).toBe("sdlc-commerce-2026-10-12-photos-build-app");
  });

  it("build spec has no turn cap and no budget (R2.3)", () => {
    const s = build(run());
    expect(s.leash.max_turns ?? null).toBeNull();
    expect(s.leash.max_budget_usd ?? null).toBeNull();
  });

  it("build spec is interactive with an answer deadline (R4.1)", () => {
    expect(build(run()).interactive).toEqual({ enabled: true, answer_timeout_secs: 3600 });
  });

  it("build spec runs under auto even when settings say bypass", () => {
    for (const settings of [bypass, prompt]) {
      for (const r of [run(), run({ target: "review" })]) {
        const s = build(r, settings);
        expect(s.permissions.mode).toBe("auto");
        expect(s.permissions.ask ?? []).toEqual([]);
        expect(Object.keys(s.plugins)).toEqual(["ai-sdlc"]);
        expect(validateLocal(s)).toEqual([]);
      }
    }
  });

  it("build spec denies push, gh and remote edits and strips GitHub tokens (R4.3)", () => {
    const s = build(run());
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["Bash(git push:*)", "Bash(gh:*)", "Bash(git remote:*)"]));
    expect(s.env_remove).toEqual(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]);
  });

  it("build spec denies edits to the parse cache folder, next to the checks folder (T12)", () => {
    const posix = build(run({ checksDir: "/home/u/.kata/workbench/checks" }));
    expect(posix.permissions.deny).toContain("Edit(//home/u/.kata/workbench/parse-cache/**)");
    const win = build(run({ checksDir: "C:\\Users\\u\\.kata\\workbench\\checks", workspaceFolder: "D:\\ws" }));
    expect(win.permissions.deny).toContain("Edit(//c/Users/u/.kata/workbench/parse-cache/**)");
  });

  it("build spec denies edits to the checks folder (R11.7)", () => {
    const posix = build(run({ checksDir: "/home/u/.kata/checks/commerce" }));
    expect(posix.permissions.deny).toContain("Edit(//home/u/.kata/checks/commerce/**)");
    const win = build(run({ checksDir: "C:\\Users\\u\\.kata\\checks\\commerce", workspaceFolder: "D:\\ws" }));
    expect(win.permissions.deny).toContain("Edit(//c/Users/u/.kata/checks/commerce/**)");
    expect(win.workdir).toBe("D:/ws/app");
    expect(win.permissions.allow).toContain("Read(//d/ws/**)");
    expect((win.permissions.deny ?? []).concat(win.permissions.allow ?? []).some((r) => r.startsWith("Write("))).toBe(false);
    expect(validateLocal(win)).toEqual([]);
  });

  it("a repository run starts inside its repository (R18.1)", () => {
    const app = build(run({ target: { repo: "app" } }));
    const api = build(run({ target: { repo: "api" } }));
    expect(app.workdir).toBe("/home/u/ws/app");
    expect(api.workdir).toBe("/home/u/ws/api");
    expect(app.auth.bare).toBe(false);
    expect(build(run({ target: { repo: "master" } })).workdir).toBe("/home/u/ws/master");
    expect(build(run({ target: "review" })).workdir).toBe("/home/u/ws/master");
  });

  it("a repository run cannot edit another repository but can write its own log (R18.5)", () => {
    const s = build(run({ target: { repo: "app" } }));
    const log = "//home/u/ws/master/intent/commerce/2026-10-12-photos/build/app.md";
    const build_ = "//home/u/ws/master/intent/commerce/2026-10-12-photos/build";
    expect(s.permissions.deny).toContain("Edit(//home/u/ws/api/**)");
    expect(s.permissions.deny).not.toContain("Edit(//home/u/ws/app/**)");
    expect(s.permissions.deny).toEqual(expect.arrayContaining([`Edit(${build_}/api.md)`, `Edit(${build_}/master.md)`]));
    expect(s.permissions.deny).not.toContain(`Edit(${log})`);
    expect((s.permissions.deny ?? []).some((d) => d.includes("build/**") || d.startsWith("Write("))).toBe(false);
    expect(s.permissions.allow).toEqual(["Read(//home/u/ws/**)", `Edit(${log})`]);
  });

  it("a repository run cannot rewrite the change's review document (F7)", () => {
    const review = "Edit(//home/u/ws/master/intent/commerce/2026-10-12-photos/build/review.md)";
    expect(build(run({ target: { repo: "app" } })).permissions.deny).toContain(review);
    expect(build(run({ target: { repo: "master" } })).permissions.deny).toContain(review);
    expect(build(run({ target: "review" })).permissions.deny).not.toContain(review);
  });

  const MASTER_LOG_DIR = "//home/u/ws/master/intent/commerce/2026-10-12-photos";

  it("the review run may edit only build/review.md", () => {
    const s = build(run({ target: "review" }));
    const deny = s.permissions.deny ?? [];
    expect(s.permissions.allow).toEqual(["Read(//home/u/ws/**)", `Edit(${MASTER_LOG_DIR}/build/review.md)`]);
    // Deny beats allow in claude, so no deny may cover the document, and the rest of the change stays closed.
    expect(deny).not.toContain("Edit(//home/u/ws/**)");
    expect(deny.some((d) => d.includes("build/**") || d.startsWith("Write("))).toBe(false);
    expect(deny).toEqual(expect.arrayContaining(["Edit(//home/u/ws/app/**)", "Edit(//home/u/ws/api/**)"]));
    expect(deny).toEqual(expect.arrayContaining([`Edit(${MASTER_LOG_DIR}/build/app.md)`, `Edit(${MASTER_LOG_DIR}/build/api.md)`, `Edit(${MASTER_LOG_DIR}/build/master.md)`]));
    expect(deny).toEqual(expect.arrayContaining([`Edit(${MASTER_LOG_DIR}/spec.md)`, `Edit(${MASTER_LOG_DIR}/plan.md)`, `Edit(${MASTER_LOG_DIR}/intent.md)`]));
    expect(deny).toEqual(expect.arrayContaining(["Bash(git push:*)", "Bash(gh:*)", "Bash(git remote:*)"]));
  });

  it("the review run is named for its change", () => {
    const s = build(run({ target: "review" }));
    expect(s.name).toBe("sdlc-commerce-2026-10-12-photos-review");
  });

  it("build task hands the repository run to the ai-sdlc build skill (R5.1)", () => {
    const s = build(run());
    expect(s.task).toBe("Use the ai-sdlc build skill for system commerce on change folder 2026-10-12-photos with --repo app.");
    expect(build(run({ target: "review" })).task).toBe("Use the ai-sdlc build skill for system commerce on change folder 2026-10-12-photos with --review.");
    expect(s.task).not.toMatch(/commit|order|log|test/i);
    expect(build(run({ continueOnLeftovers: true })).task).toBe(
      `${s.task} The engineer has already confirmed continuing on top of the uncommitted edits the previous run left; do not ask again.`,
    );
  });

  it("a round's run carries the instructions inside the picked repository (R8.1)", () => {
    const s = build(run({ target: { repo: "api" }, instructions: "  rename the status field to state \n" }));
    expect(s.workdir).toBe("/home/u/ws/api");
    expect(s.task.endsWith("\n\nInstructions from the engineer for this run:\nrename the status field to state")).toBe(true);
    expect(build(run({ instructions: "   " })).task).not.toContain("Instructions");
    expect(build(run({ target: "review", instructions: "x" })).task).not.toContain("Instructions");
  });

  it("throws without a build run", () => {
    expect(() => specFor("build", null, ctx, bypass, both)).toThrow();
  });
});

describe("stopMessage", () => {
  it("maps each exit code (R6.1)", () => {
    expect(stopMessage(124, null)).toBe("Stopped: reached the time limit");
    expect(stopMessage(130, null)).toBe("Stopped: cancelled");
    expect(stopMessage(123, null)).toBe("Stopped: nobody answered");
    expect(stopMessage(1, null)).toBe("Stopped: the agent failed");
    expect(stopMessage(null, null)).toBe("Stopped: the agent failed");
    expect(stopMessage(1, "boom")).toBe("Stopped: the agent failed · boom");
    expect(stopMessage(124, "late")).toBe("Stopped: reached the time limit · late");
  });

  it("says cancelled first when the run was cancelled, whatever the exit code", () => {
    expect(stopMessage(0, null, true)).toBe("Stopped: cancelled");
    expect(stopMessage(1, null, true)).toBe("Stopped: cancelled");
    expect(stopMessage(124, null, true)).toBe("Stopped: cancelled");
    expect(stopMessage(null, null, true)).toBe("Stopped: cancelled");
    expect(stopMessage(1, "boom", true)).toBe("Stopped: cancelled");
  });
});

describe("stopMessage table", () => {
  it("stopMessage decides every row of the stop reason table", () => {
    const rows: [boolean, number | null, boolean, string | null, string][] = [
      [true, 0, true, null, "Stopped: cancelled"],
      [true, 1, false, "boom", "Stopped: cancelled"],
      [true, 124, true, "late", "Stopped: cancelled"],
      [true, null, false, null, "Stopped: cancelled"],
      [false, 124, true, null, "Stopped: reached the time limit"],
      [false, 124, false, null, "Stopped: reached the time limit"],
      [false, 124, true, "late", "Stopped: reached the time limit · late"],
      [false, 130, true, null, "Stopped: cancelled"],
      [false, 130, false, "x", "Stopped: cancelled · x"],
      [false, 123, true, null, "Stopped: nobody answered"],
      [false, 123, false, null, "Stopped: nobody answered"],
      [false, 0, false, null, "Stopped: ended without its task being recorded"],
      [false, 0, false, "boom", "Stopped: ended without its task being recorded · boom"],
      [false, 0, true, null, "Stopped: the agent failed"],
      [false, 0, true, "review failed", "Stopped: the agent failed · review failed"],
      [false, 1, true, null, "Stopped: the agent failed"],
      [false, 1, false, null, "Stopped: the agent failed"],
      [false, null, true, "boom", "Stopped: the agent failed · boom"],
      [false, null, false, null, "Stopped: the agent failed"],
    ];
    for (const [cancelled, exit, recorded, error, text] of rows) {
      expect(stopMessage(exit, error, cancelled, recorded), JSON.stringify([cancelled, exit, recorded, error])).toBe(text);
    }
  });
});

describe("reviewFindings", () => {
  const detail = (result: string | null | undefined, extra: KataEvent[] = []): RunDetail => ({
    record: {} as RunDetail["record"],
    events: [...extra, { type: "run.completed", exit_code: 0, is_error: false, num_turns: 1, cost_usd: 0, duration_ms: 1, result } as unknown as KataEvent],
  });

  it("splits a numbered closing text into findings, in the order written when none names a severity", () => {
    const got = reviewFindings(detail("2 findings. 1. The upload limit is duplicated in commerce-core and customer-portal. 2. The refusal message has no test."));
    expect(got).toEqual([
      { severity: null, text: "The upload limit is duplicated in commerce-core and customer-portal." },
      { severity: null, text: "The refusal message has no test." },
    ]);
  });

  it("reads one finding per line from a numbered or bulleted list", () => {
    const got = reviewFindings(detail("Findings:\n1. First thing\n2. Second thing\n"));
    expect(got.map((f) => f.text)).toEqual(["First thing", "Second thing"]);
    expect(reviewFindings(detail("- one\n- two")).map((f) => f.text)).toEqual(["one", "two"]);
  });

  it("puts the most serious first, keeping the written order within a severity, and drops the severity tag from the text", () => {
    const got = reviewFindings(detail("1. [Low] Rename the helper\n2. [High] The limit is not enforced on retry\n3. **Medium**: No test for the refusal\n4. [High] A second serious one"));
    expect(got).toEqual([
      { severity: "high", text: "The limit is not enforced on retry" },
      { severity: "high", text: "A second serious one" },
      { severity: "medium", text: "No test for the refusal" },
      { severity: "low", text: "Rename the helper" },
    ]);
  });

  it("does not split on a number out of sequence", () => {
    const got = reviewFindings(detail("1. Upgrade to version 3. Then retest. 2. Another"));
    expect(got.map((f) => f.text)).toEqual(["Upgrade to version 3. Then retest.", "Another"]);
  });

  it("is one finding when the text is not a list, and none when it says there are none", () => {
    expect(reviewFindings(detail("The retry loop never stops."))).toEqual([{ severity: null, text: "The retry loop never stops." }]);
    expect(reviewFindings(detail("No findings."))).toEqual([]);
    expect(reviewFindings(detail("No issues found; the change matches the plan."))).toEqual([]);
  });

  it("is empty without a closing text, and reads the last run.completed", () => {
    expect(reviewFindings(detail(null))).toEqual([]);
    expect(reviewFindings(detail(undefined))).toEqual([]);
    expect(reviewFindings({ record: {} as RunDetail["record"], events: [] })).toEqual([]);
    const twice = detail("1. new one", [{ type: "run.completed", exit_code: 0, result: "1. old one" } as unknown as KataEvent]);
    expect(reviewFindings(twice).map((f) => f.text)).toEqual(["new one"]);
  });
});

describe("the unreadable plan stage (F20)", () => {
  it("offers no action, so no build can start from it", () => {
    expect(actionsFor("plan-unreadable" as Stage)).toEqual([]);
  });
  it("is labeled as a plan that could not be read, in the warning tone", () => {
    expect(stageLabel("plan-unreadable" as Stage)).toEqual({ step: "plan", text: "Plan · could not be read", tone: "warning" });
  });
});

describe("what a build's preview asks and which runs its choices reach", () => {
  const TABLE: [BuildPreviewKind, BuildPreviewPlan][] = [
    ["start", { asksTimeLimit: true, asksRound: false, sections: "all-repos-and-review", appliesTo: "build", limitSource: "engineer" }],
    ["continue-all", { asksTimeLimit: true, asksRound: false, sections: "all-repos-and-review", appliesTo: "repos-then-build", limitSource: "engineer" }],
    ["continue-one", { asksTimeLimit: false, asksRound: false, sections: "one-repo", appliesTo: "repo-then-build", limitSource: "build" }],
    ["round", { asksTimeLimit: true, asksRound: true, sections: "one-repo", appliesTo: "round-then-build", limitSource: "engineer" }],
    ["manual-review", { asksTimeLimit: false, asksRound: false, sections: "review", appliesTo: "this-review", limitSource: "kata" }],
  ];

  it.each(TABLE)("buildPreviewFor decides every row of the build preview table: %s", (kind, plan) => {
    expect(buildPreviewFor(kind)).toEqual(plan);
  });

  it("the build's preview lists the safety rules read-only", () => {
    const common = ["No push", "No use of GitHub's command-line tool", "No change of remotes", "No edit of the checks folder"];
    expect(safetyRules("repo")).toEqual([...common, "No edit of another repository or its build log"]);
    expect(safetyRules("review")).toEqual([...common, "No edit of any repository or build log, except the review document"]);
  });

  it("the build's choices reach a run as its given section: shared items for every run, a project item only in its own folder", () => {
    const off = new Set([
      "personal:tool-server:github",
      "d:/ws/commerce-core|project:tool-server:commerce-core-db",
      "d:/ws/customer-portal|project:tool-server:customer-portal-db",
      "personal:plugin:superpowers@claude-plugins-official",
      "run-spec:skill:doc-writer",
      "personal:instruction:CLAUDE.md",
    ]);
    expect(givenFor(off, "D:\\ws\\commerce-core\\")).toEqual({
      hooks: [],
      skills: ["run-spec:skill:doc-writer"],
      plugins: ["personal:plugin:superpowers@claude-plugins-official"],
      instructions: ["personal:instruction:CLAUDE.md"],
      tool_servers: ["personal:tool-server:github", "project:tool-server:commerce-core-db"],
    });
    expect(givenFor(new Set(), "D:/ws/commerce-core")).toEqual({ hooks: [], skills: [], plugins: [], instructions: [], tool_servers: [] });
  });
});

describe("what kind of run a spec is", () => {
  const buildRun = (target: BuildRun["target"]): BuildRun => ({
    target,
    timeoutSecs: 7200,
    instructions: null,
    workspaceFolder: "/home/u/ws",
    masterRepo: "master",
    systemRepos: ["master", "app"],
    checksDir: "/home/u/.kata/checks/commerce",
    continueOnLeftovers: false,
  });

  it("every AI-SDLC spec requires the ai-sdlc plugin", () => {
    const notBuilds = [
      specFor("setup", null, { folder: "/ws", system: "", change: null }, bypass, both),
      specFor("context", null, { ...ctx, change: null, repos: ["a"] }, bypass, both),
      specFor("intent", null, { ...ctx, change: null, idea: "x" }, bypass, both),
      specFor("spec", "start-spec", ctx, bypass, both),
      specFor("plan", "start-plan", ctx, bypass, both),
      specFor("plan", "start-plan", ctx, prompt, both),
    ];
    for (const s of notBuilds) {
      expect(s.given?.required_plugins).toEqual(["ai-sdlc"]);
      expect(s.given?.build).toBe(false);
      expect(s.given).toMatchObject({ hooks: [], skills: [], plugins: [], instructions: [], tool_servers: [] });
    }
    // A repository's run and the review are build runs; the review a build starts by itself is built the same way.
    for (const target of [{ repo: "app" }, "review" as const]) {
      const s = specFor("build", null, ctx, bypass, both, buildRun(target));
      expect(s.given?.required_plugins).toEqual(["ai-sdlc"]);
      expect(s.given?.build).toBe(true);
      expect(s.given?.hooks).toEqual([]);
    }
  });

  it("isBuildRun decides every run kind", () => {
    expect(isBuildRun("setup")).toBe(false);
    expect(isBuildRun("context")).toBe(false);
    expect(isBuildRun("intent")).toBe(false);
    expect(isBuildRun("spec")).toBe(false);
    expect(isBuildRun("plan")).toBe(false);
    expect(isBuildRun("build")).toBe(true);
    expect(isBuildRun("start")).toBe(true);
    expect(isBuildRun("continue-all")).toBe(true);
    expect(isBuildRun("continue-one")).toBe(true);
    expect(isBuildRun("round")).toBe(true);
    expect(isBuildRun("manual-review")).toBe(true);
  });
});

describe("triage and fix run-specs (T8)", () => {
  const WS = "D:\\ws";
  const CHECKS = "C:\\Users\\u\\.kata\\workbench\\checks";
  const restricted: Restricted = { workspaceFolder: WS, masterRepo: "intent-repo", systemRepos: ["kata", "api"], checksDir: CHECKS };
  const scan = (over: Partial<WorkspaceScan> = {}): WorkspaceScan => ({
    folder: WS,
    repos: ["intent-repo", "kata", "api"],
    master: { kind: "one", repo: "intent-repo", committed: true },
    marker: null,
    marker_error: null,
    ...over,
  });
  // The auto setting is not in the generated type yet; the spec must not depend on the setting at all.
  const auto = { ...bypass, permission_mode: "auto" } as unknown as Settings;
  const wsCtx: RunContext = { folder: WS, system: "commerce", change: "2026-10-23-fix-it" };
  const startCtx: RunContext = { folder: WS, system: "commerce", change: null, idea: "Photos fail to upload" };

  it("writes the four task texts out in full", () => {
    expect(specFor("triage", null, startCtx, bypass, both, undefined, restricted).task).toBe(
      "Use the ai-sdlc start skill for system commerce. The change: Photos fail to upload. The person running this is both the engineer and the product owner and may take either route. If the route is the light track and the person takes it, run the fix skill in this session; the engineer accepts the fix later in the Workbench, so do not ask for acceptance.",
    );
    expect(specFor("fix", "accept-fix", wsCtx, bypass, both, undefined, restricted).task).toBe(
      "Use the ai-sdlc fix skill for system commerce with --accept 2026-10-23-fix-it. The engineer accepted this fix in the Workbench.",
    );
    expect(specFor("fix", null, wsCtx, bypass, both, undefined, restricted).task).toBe(
      "Use the ai-sdlc fix skill for system commerce on change folder 2026-10-23-fix-it. The engineer accepts the fix later in the Workbench, so do not ask for acceptance.",
    );
    expect(specFor("setup", null, { folder: WS, system: "", change: null, instructions: true }, bypass, both).task).toBe(
      "Use the ai-sdlc setup skill with --instructions.",
    );
  });

  it("appends operator feedback as it does for every other kind", () => {
    const s = specFor("fix", null, { ...wsCtx, feedback: "  narrower  " }, bypass, both, undefined, restricted);
    expect(s.task.endsWith("\n\nOperator feedback:\nnarrower")).toBe(true);
  });

  it("holds a start and a fix run to the same restrictions whatever the permission setting (R15.1, R15.2)", () => {
    const deny = [
      "Bash(git push:*)",
      "Bash(gh:*)",
      "Bash(git remote:*)",
      "Edit(//c/Users/u/.kata/workbench/checks/**)",
      "Edit(//d/ws/kata/**)",
      "Edit(//d/ws/api/**)",
    ];
    const specs = [
      specFor("triage", null, startCtx, bypass, both, undefined, restricted),
      specFor("triage", null, startCtx, prompt, both, undefined, restricted),
      specFor("triage", null, startCtx, auto, both, undefined, restricted),
      specFor("fix", null, wsCtx, bypass, both, undefined, restricted),
      specFor("fix", null, wsCtx, prompt, both, undefined, restricted),
      specFor("fix", "accept-fix", wsCtx, auto, both, undefined, restricted),
    ];
    for (const s of specs) {
      expect(s.permissions.mode).toBe("auto");
      expect([...(s.permissions.deny ?? [])].sort()).toEqual([...deny].sort());
      expect(s.permissions.allow).toEqual(["Read(//d/ws/**)"]);
      expect(s.permissions.ask ?? []).toEqual([]);
      expect(s.permissions.unmatched).toBe("ask");
      expect(s.interactive).toEqual({ enabled: true, answer_timeout_secs: 3600 });
      expect(s.env_remove).toEqual(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]);
      expect(s.workdir).toBe(WS);
      expect(s.leash.timeout_secs).toBe(6 * 60 * 60);
      expect(s.given?.build).toBe(false);
      expect(validateLocal(s)).toEqual([]);
    }
    for (const kind of ["triage", "fix"] as const) {
      const [a, b, c] = specs.filter((s) => s.name.endsWith(`-${kind}`));
      expect(b).toEqual(a);
      expect(c.permissions).toEqual(a.permissions);
    }
  });

  it("tells a triage or fix run from a build run (the kind `start` names the build preview)", () => {
    expect(isBuildRun("triage")).toBe(false);
    expect(isBuildRun("fix")).toBe(false);
    expect(specFor("triage", null, startCtx, bypass, both, undefined, restricted).given?.build).toBe(false);
  });

  it("refuses to build a start or fix spec without its restriction", () => {
    expect(() => specFor("triage", null, startCtx, bypass, both)).toThrow();
    expect(() => specFor("fix", null, wsCtx, bypass, both)).toThrow();
  });

  it("restrictedFor names the master and the product repositories the build protects", () => {
    expect(restrictedFor(WS, scan(), CHECKS)).toEqual(restricted);
    expect(() => restrictedFor(WS, scan({ master: { kind: "none" } }), CHECKS)).toThrow();
    expect(() => restrictedFor(WS, scan({ master: { kind: "many", repos: ["a", "b"] } }), CHECKS)).toThrow();
  });

  it("leaves the permissions of a repository run and a review run as they were", () => {
    const run: BuildRun = {
      target: { repo: "app" }, timeoutSecs: 7200, instructions: null, workspaceFolder: "/home/u/ws", masterRepo: "master",
      systemRepos: ["master", "app", "api"], checksDir: "/home/u/.kata/checks/commerce", continueOnLeftovers: false,
    };
    const d = "//home/u/ws/master/intent/commerce/2026-10-12-photos";
    const base = [
      "Bash(git push:*)", "Bash(gh:*)", "Bash(git remote:*)", "Edit(//home/u/.kata/checks/commerce/**)", "Edit(//home/u/.kata/checks/parse-cache/**)",
    ];
    const repoRun = specFor("build", null, { ...ctx, folder: run.workspaceFolder }, bypass, both, run).permissions;
    expect([...(repoRun.deny ?? [])].sort()).toEqual(
      [...base, "Edit(//home/u/ws/api/**)", `Edit(${d}/build/master.md)`, `Edit(${d}/build/api.md)`, `Edit(${d}/build/review.md)`].sort(),
    );
    expect(repoRun.allow).toEqual(["Read(//home/u/ws/**)", `Edit(${d}/build/app.md)`]);
    const review = specFor("build", null, { ...ctx, folder: run.workspaceFolder }, bypass, both, { ...run, target: "review" }).permissions;
    expect([...(review.deny ?? [])].sort()).toEqual(
      [
        ...base, "Edit(//home/u/ws/app/**)", "Edit(//home/u/ws/api/**)",
        `Edit(${d}/build/master.md)`, `Edit(${d}/build/app.md)`, `Edit(${d}/build/api.md)`,
        `Edit(${d}/intent.md)`, `Edit(${d}/spec.md)`, `Edit(${d}/plan.md)`,
      ].sort(),
    );
    expect(review.allow).toEqual(["Read(//home/u/ws/**)", `Edit(${d}/build/review.md)`]);
  });

  it("builds the same run-spec for a fix change as for a full one, since the build takes no track (R11.1)", () => {
    const run: BuildRun = {
      target: { repo: "kata" }, timeoutSecs: 7200, instructions: null, workspaceFolder: WS, masterRepo: "intent-repo",
      systemRepos: ["intent-repo", "kata", "api"], checksDir: CHECKS, continueOnLeftovers: false,
    };
    const full = { ...changeAt("build-ready"), track: "full" as const };
    const fix = { ...changeAt("build-ready"), track: "fix" as const };
    const forChange = (c: ChangeInfo) => specFor("build", null, { folder: WS, system: c.system, change: c.change }, bypass, both, run);
    expect(forChange(fix)).toEqual(forChange(full));
  });
});
