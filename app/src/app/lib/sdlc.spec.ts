import type { CatalogEntry } from "@bindings/CatalogEntry";
import type { Settings } from "@bindings/Settings";
import type { Stage } from "@bindings/Stage";
import type { KataEvent } from "./events";
import { validateLocal } from "./mock";
import { actionLabel, actionsFor, hasAiSdlcPlugin, primaryAction, runCounts, specFor, splitFrontMatter, stageLabel, transcriptRunId, type RunContext } from "./sdlc";

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
  "plan-ready": ["start-plan", "reopen-intent"],
  "plan-written": ["rerun-plan", "reopen-intent"],
  "plan-superseded": ["start-plan"],
};

describe("actionsFor", () => {
  for (const [stage, actions] of Object.entries(ACTIONS)) {
    it(stage, () => expect(actionsFor(stage as Stage)).toEqual(actions));
  }
});

describe("stageLabel", () => {
  it("gives every stage non-empty text", () => {
    for (const s of Object.keys(ACTIONS)) expect(stageLabel(s as Stage).text.length).toBeGreaterThan(0);
  });
  it("maps representative stages", () => {
    expect(stageLabel("rejected")).toMatchObject({ step: "closed", tone: "error" });
    expect(stageLabel("plan-written")).toMatchObject({ step: "plan", tone: "success" });
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
  it("setup with a system", () => {
    const s = specFor("setup", null, { folder: "/ws", system: "claims", change: null }, bypass, both);
    expect(s.task).toBe("Use the ai-sdlc setup skill. System: claims");
  });
  it("context", () => {
    const s = specFor("context", null, { ...ctx, change: null, repos: ["a", "b"] }, bypass, both);
    expect(s.name).toBe("sdlc-claims-context");
    expect(s.task).toBe("Use the ai-sdlc context skill for system claims, repositories: a, b.");
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
  it("plan with superpowers", () => {
    const s = specFor("plan", "start-plan", ctx, bypass, both);
    expect(s.name).toBe("sdlc-claims-2026-10-12-fnol-plan");
    expect(s.task).toBe("Use the ai-sdlc plan skill for system claims on change folder 2026-10-12-fnol.");
    expect(Object.keys(s.plugins).sort()).toEqual(["ai-sdlc", "superpowers"]);
  });
  it("plan without superpowers is standalone", () => {
    const s = specFor("plan", "start-plan", ctx, bypass, [plugin("ai-sdlc")]);
    expect(s.task).toBe("Use the ai-sdlc plan skill for system claims on change folder 2026-10-12-fnol. --standalone");
    expect(Object.keys(s.plugins)).toEqual(["ai-sdlc"]);
  });
  it("rerun plan carries the confirmation", () => {
    const s = specFor("plan", "rerun-plan", ctx, bypass, both);
    expect(s.task).toBe(
      "Use the ai-sdlc plan skill for system claims on change folder 2026-10-12-fnol. " +
        "The user has already confirmed replacing the existing plan; do not ask again.",
    );
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
    expect(runCounts(links, [], "ws", "claims", "c1")).toEqual({ intent: 2, spec: 1, plan: 0 });
  });

  it("adds history records that carry the stage's deterministic name and are not already linked", () => {
    const links = [link("spec", "r1")];
    const records = [rec("r1", "sdlc-claims-c1-spec"), rec("r2", "sdlc-claims-c1-spec"), rec("r3", "sdlc-claims-c1-plan"), rec("r4", "sdlc-claims-other-spec")];
    expect(runCounts(links, records, "ws", "claims", "c1")).toEqual({ intent: 0, spec: 2, plan: 1 });
  });
});

describe("actionLabel and primaryAction", () => {
  it("labels every action in sentence case", () => {
    expect(actionsFor("spec-awaiting").map(actionLabel)).toEqual(["Continue spec", "Accept spec", "Reopen intent"]);
    expect(actionLabel("commit-acceptance")).toBe("Commit acceptance");
    expect(actionLabel("rerun-plan")).toBe("Re-run plan");
  });

  it("picks one primary: accept, then commit, then start, then continue; never reopen or re-run", () => {
    expect(primaryAction(actionsFor("intent-awaiting"))).toBe("accept-intent");
    expect(primaryAction(actionsFor("spec-accepted-uncommitted"))).toBe("commit-acceptance");
    expect(primaryAction(actionsFor("spec-ready"))).toBe("start-spec");
    expect(primaryAction(actionsFor("intent-in-progress"))).toBe("continue-intent");
    expect(primaryAction(actionsFor("plan-written"))).toBeNull();
    expect(primaryAction(actionsFor("rejected"))).toBeNull();
  });
});
