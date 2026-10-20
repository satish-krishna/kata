import type { CatalogEntry } from "@bindings/CatalogEntry";
import type { ChangeInfo } from "@bindings/ChangeInfo";
import type { OutOfDate } from "@bindings/OutOfDate";
import type { Settings } from "@bindings/Settings";
import type { Stage } from "@bindings/Stage";
import type { KataEvent, RunDetail } from "./events";
import { validateLocal } from "./mock";
import { DONE_LABEL, actionLabel, actionsFor, actionsForChange, canBuild, hasAiSdlcPlugin, primaryAction, reviewFindings, revisits, runCounts, specFor, splitFrontMatter, stageLabel, stopMessage, transcriptRunId, type BuildRun, type RunContext, type StageAction } from "./sdlc";

const plugin = (name: string): CatalogEntry => ({
  kind: "plugin", name, description: "", source: "user", path: `/p/${name}`, provides: [], mcp_servers: [],
});
const skill = (name: string): CatalogEntry => ({ ...plugin(name), kind: "skill" });
const both = [plugin("ai-sdlc"), plugin("superpowers")];
const bypass: Settings = { mode: null, remember: false, permission_mode: "bypass" };
const prompt: Settings = { ...bypass, permission_mode: "prompt" };
const ctx: RunContext = { folder: "/ws", system: "claims", change: "2026-10-12-fnol" };

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
  "plan-superseded": ["rerun-plan"],
  "build-ready": ["start-build", "reopen-intent"],
  "build-stopped": ["continue-build", "another-round"],
  "build-finished": ["declare-done", "another-round", "run-review"],
};

const changeAt = (stage: Stage, outOfDate: OutOfDate | null = null): ChangeInfo => ({
  system: "claims", change: "2026-10-12-fnol", stage, scope: "claims", out_of_date: outOfDate,
  intent: { exists: true, committed: true, status: "accepted" },
  spec: { exists: true, committed: true, status: "accepted" },
  plan: { exists: true, committed: true, status: "accepted" },
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
    const s = specFor("intent", null, { folder: "/ws", system: "claims", change: null, idea: "x" }, bypass, both);
    expect(s.auth).toEqual({ bare: false, token_env: null });
  });
  it("gets a six-hour wall clock, since a build outlasts the engine's 30-minute default", () => {
    const s = specFor("plan", null, ctx, bypass, both);
    expect(s.leash.timeout_secs).toBe(6 * 60 * 60);
  });
  it("setup with a system", () => {
    const s = specFor("setup", null, { folder: "/ws", system: "claims", change: null }, bypass, both);
    expect(s.task).toBe("Use the ai-sdlc setup skill. System: claims");
  });
  it("context", () => {
    const s = specFor("context", null, { ...ctx, change: null, repos: ["a", "b"] }, bypass, both);
    expect(s.name).toBe("sdlc-claims-context");
    expect(s.task).toBe(
      "Use the ai-sdlc context skill for system claims, repositories: a, b. Refresh each existing context file, even one that is current.",
    );
  });
  it("new intent", () => {
    const s = specFor("intent", null, { ...ctx, change: null, idea: "photo upload" }, bypass, both);
    expect(s.name).toBe("sdlc-claims-new-intent");
    expect(s.task).toBe("Use the ai-sdlc intent skill for system claims. The idea: photo upload");
  });
  it("continue and reopen intent", () => {
    const c = specFor("intent", "continue-intent", ctx, bypass, both);
    expect(c.name).toBe("sdlc-claims-2026-10-12-fnol-intent");
    expect(c.task).toBe(
      "Use the ai-sdlc intent skill for system claims on the existing change folder 2026-10-12-fnol. Resume the draft.",
    );
    const r = specFor("intent", "reopen-intent", ctx, bypass, both);
    expect(r.task).toBe(c.task + " The user has already confirmed reopening this accepted intent; do not ask again.");
  });
  it("spec", () => {
    const s = specFor("spec", "start-spec", ctx, bypass, both);
    expect(s.name).toBe("sdlc-claims-2026-10-12-fnol-spec");
    expect(s.task).toBe("Use the ai-sdlc spec skill for system claims on change folder 2026-10-12-fnol.");
    expect(Object.keys(s.plugins)).toEqual(["ai-sdlc"]);
  });
  it("plan loads only ai-sdlc, even when superpowers is installed", () => {
    for (const catalog of [both, [plugin("ai-sdlc")]]) {
      const s = specFor("plan", "start-plan", ctx, bypass, catalog);
      expect(s.name).toBe("sdlc-claims-2026-10-12-fnol-plan");
      expect(s.task).toBe("Use the ai-sdlc plan skill for system claims on change folder 2026-10-12-fnol.");
      expect(Object.keys(s.plugins)).toEqual(["ai-sdlc"]);
    }
  });
  it("rerun plan carries the confirmation", () => {
    const s = specFor("plan", "rerun-plan", ctx, bypass, both);
    expect(s.task).toBe(
      "Use the ai-sdlc plan skill for system claims on change folder 2026-10-12-fnol. " +
        "The user has already confirmed replacing the existing plan; do not ask again.",
    );
  });
  it("reopen spec carries the confirmation and touches only the spec", () => {
    const s = specFor("spec", "reopen-spec", ctx, bypass, both);
    expect(s.name).toBe("sdlc-claims-2026-10-12-fnol-spec");
    expect(s.task).toBe(
      "Use the ai-sdlc spec skill for system claims on change folder 2026-10-12-fnol. " +
        "The user has already confirmed reopening this accepted spec; do not ask again.",
    );
  });
  it("continue spec carries the confirmation to regenerate", () => {
    expect(specFor("spec", "continue-spec", ctx, bypass, both).task).toBe(
      "Use the ai-sdlc spec skill for system claims on change folder 2026-10-12-fnol. " +
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
    const evs = [log("other"), log("transcript: C:\\Users\\x\\.kata\\runs\\sdlc-claims-x-spec-20261018T101500Z.jsonl")];
    expect(transcriptRunId(evs)).toBe("sdlc-claims-x-spec-20261018T101500Z");
  });
  it("extracts the stem from a POSIX path", () => {
    expect(transcriptRunId([log("transcript: /home/x/.kata/runs/abc.jsonl")])).toBe("abc");
  });
  it("returns null without a transcript event", () => {
    expect(transcriptRunId([log("hello")])).toBeNull();
    expect(transcriptRunId([])).toBeNull();
  });
});

describe("splitFrontMatter", () => {
  it("separates a leading front-matter block into one mono line and the body", () => {
    const out = splitFrontMatter("---\nstatus: accepted\ndate: 2026-10-12\n---\n# Title\n\nBody\n");
    expect(out.frontMatter).toBe("status: accepted · date: 2026-10-12");
    expect(out.body).toBe("# Title\n\nBody\n");
  });

  it("returns the whole text as the body when there is no front matter", () => {
    expect(splitFrontMatter("# Title\n")).toEqual({ frontMatter: null, body: "# Title\n" });
    expect(splitFrontMatter("---\nstatus: draft\n# never closed")).toEqual({ frontMatter: null, body: "---\nstatus: draft\n# never closed" });
  });

  it("handles Windows line endings", () => {
    const out = splitFrontMatter("---\r\nstatus: draft\r\n---\r\n# T\r\n");
    expect(out.frontMatter).toBe("status: draft");
    expect(out.body).toBe("# T\r\n");
  });
});

describe("runCounts", () => {
  const link = (stage: string, run_id: string, change = "c1", system = "claims", workspace_id = "ws") =>
    ({ workspace_id, system, change, stage, run_id, started_at: 1 });
  const rec = (id: string, kata: string) => ({ id, kata, started_at: 1, isolation: "none" });

  it("counts linked runs per stage for this workspace, system and change only", () => {
    const links = [link("intent", "a"), link("intent", "b"), link("spec", "c"), link("spec", "x", "other"), link("plan", "y", "c1", "claims", "ws2")];
    expect(runCounts(links, [], "ws", "claims", "c1")).toEqual({ intent: 2, spec: 1, plan: 0, build: 0, review: 0 });
  });

  it("adds history records that carry the stage's deterministic name and are not already linked", () => {
    const links = [link("spec", "r1")];
    const records = [rec("r1", "sdlc-claims-c1-spec"), rec("r2", "sdlc-claims-c1-spec"), rec("r3", "sdlc-claims-c1-plan"), rec("r4", "sdlc-claims-other-spec")];
    expect(runCounts(links, records, "ws", "claims", "c1")).toEqual({ intent: 0, spec: 2, plan: 1, build: 0, review: 0 });
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
    checksDir: "/home/u/.kata/checks/claims",
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
    expect(app.name).toBe("sdlc-claims-2026-10-12-fnol-build-app");
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

  it("build spec denies edits to the checks folder (R11.7)", () => {
    const posix = build(run({ checksDir: "/home/u/.kata/checks/claims" }));
    expect(posix.permissions.deny).toContain("Edit(//home/u/.kata/checks/claims/**)");
    const win = build(run({ checksDir: "C:\\Users\\u\\.kata\\checks\\claims", workspaceFolder: "D:\\ws" }));
    expect(win.permissions.deny).toContain("Edit(//c/Users/u/.kata/checks/claims/**)");
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
    const log = "//home/u/ws/master/intent/claims/2026-10-12-fnol/build/app.md";
    const build_ = "//home/u/ws/master/intent/claims/2026-10-12-fnol/build";
    expect(s.permissions.deny).toContain("Edit(//home/u/ws/api/**)");
    expect(s.permissions.deny).not.toContain("Edit(//home/u/ws/app/**)");
    expect(s.permissions.deny).toEqual(expect.arrayContaining([`Edit(${build_}/api.md)`, `Edit(${build_}/master.md)`]));
    expect(s.permissions.deny).not.toContain(`Edit(${log})`);
    expect((s.permissions.deny ?? []).some((d) => d.includes("build/**") || d.startsWith("Write("))).toBe(false);
    expect(s.permissions.allow).toEqual(["Read(//home/u/ws/**)", `Edit(${log})`]);
  });

  it("the review run changes nothing", () => {
    const s = build(run({ target: "review" }));
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["Edit(//home/u/ws/**)"]));
    expect(s.permissions.allow).toEqual(["Read(//home/u/ws/**)"]);
    expect(s.name).toBe("sdlc-claims-2026-10-12-fnol-review");
  });

  it("build task hands the repository run to the ai-sdlc build skill (R5.1)", () => {
    const s = build(run());
    expect(s.task).toBe("Use the ai-sdlc build skill for system claims on change folder 2026-10-12-fnol with --repo app.");
    expect(build(run({ target: "review" })).task).toBe("Use the ai-sdlc build skill for system claims on change folder 2026-10-12-fnol with --review.");
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
    expect(stopMessage(1, "boom", true)).toBe("Stopped: cancelled · boom");
  });
});

describe("canBuild", () => {
  const withSkill: CatalogEntry[] = [{ ...plugin("ai-sdlc"), provides: ["skill:build"] }];
  it("needs the build skill and 0.6.0 or later", () => {
    expect(canBuild(withSkill, "0.6.0")).toBe(true);
    expect(canBuild(withSkill, "0.10.1")).toBe(true);
    expect(canBuild(withSkill, "1.0.0")).toBe(true);
    expect(canBuild(withSkill, "0.5.9")).toBe(false);
    expect(canBuild(withSkill, null)).toBe(false);
    expect(canBuild([{ ...plugin("ai-sdlc"), provides: ["skill:plan"] }], "0.6.0")).toBe(false);
    expect(canBuild([], "0.6.0")).toBe(false);
  });
});

describe("runCounts for build", () => {
  it("counts build:<repo> links as build and review links as review", () => {
    const link = (stage: string, run_id: string) => ({ workspace_id: "ws", system: "claims", change: "c1", stage, run_id, started_at: 1 });
    const got = runCounts([link("build:app", "a"), link("build:api", "b"), link("review", "c"), link("spec", "d")], [], "ws", "claims", "c1");
    expect(got).toEqual({ intent: 0, spec: 1, plan: 0, build: 2, review: 1 });
  });
});

describe("reviewFindings", () => {
  const detail = (result: string | null | undefined, extra: KataEvent[] = []): RunDetail => ({
    record: {} as RunDetail["record"],
    events: [...extra, { type: "run.completed", exit_code: 0, is_error: false, num_turns: 1, cost_usd: 0, duration_ms: 1, result } as unknown as KataEvent],
  });

  it("splits a numbered closing text into findings, in the order written when none names a severity", () => {
    const got = reviewFindings(detail("2 findings. 1. The upload limit is duplicated in claims-core and customer-portal. 2. The refusal message has no test."));
    expect(got).toEqual([
      { severity: null, text: "The upload limit is duplicated in claims-core and customer-portal." },
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
