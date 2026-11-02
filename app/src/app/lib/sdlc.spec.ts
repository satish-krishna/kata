import type { CatalogEntry } from "@bindings/CatalogEntry";
import type { Settings } from "@bindings/Settings";
import type { Stage } from "@bindings/Stage";
import type { WorkspaceScan } from "@bindings/WorkspaceScan";
import type { KataEvent, RunDetail } from "./events";
import { validateLocal } from "./mock";
import { actionLabel, actionLabelAt, buildPreviewFor, givenFor, safetyRules, hasAiSdlcPlugin, isBuildRun, primaryAction, restrictedFor, reviewFindings, specFor, transcriptRunId, type BuildPreviewKind, type BuildPreviewPlan, type Restricted, type RunContext, type StageAction } from "./sdlc";

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
  "build-ready": ["start-build", "reopen-spec", "reopen-intent"],
  "build-stopped": ["continue-build", "another-round", "reopen-spec", "reopen-intent"],
  "build-finished": ["declare-done", "another-round", "run-review", "reopen-spec", "reopen-intent"],
  "fix-in-progress": [],
  "fix-unsettled": [],
  "fix-awaiting": [],
  "fix-accepting": [],
  "fix-needs-plugin": [],
};

describe("action labels of a fix", () => {
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

  it("the primary action is the first of the list that fits", () => {
    expect(primaryAction(["finish-fix-draft"])).toBe("finish-fix-draft");
    expect(primaryAction(["accept-fix", "change-fix", "full-pipeline-instead"])).toBe("accept-fix");
    expect(primaryAction(["reopen-fix"])).toBeNull();
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
    expect((ACTIONS["spec-awaiting"] as StageAction[]).map(actionLabel)).toEqual(["Continue spec", "Accept spec", "Reopen intent"]);
    expect(actionLabel("commit-acceptance")).toBe("Commit acceptance");
    expect(actionLabel("rerun-plan")).toBe("Re-run plan");
    expect(actionLabel("reopen-spec")).toBe("Reopen spec");
  });

  it("picks one primary: accept, then commit, then start, then continue; never reopen or re-run", () => {
    expect(primaryAction(ACTIONS["intent-awaiting"] as StageAction[])).toBe("accept-intent");
    expect(primaryAction(ACTIONS["spec-accepted-uncommitted"] as StageAction[])).toBe("commit-acceptance");
    expect(primaryAction(ACTIONS["spec-ready"] as StageAction[])).toBe("start-spec");
    expect(primaryAction(ACTIONS["intent-in-progress"] as StageAction[])).toBe("continue-intent");
    expect(primaryAction(ACTIONS["plan-awaiting"] as StageAction[])).toBe("accept-plan");
    expect(primaryAction(ACTIONS["build-finished"] as StageAction[])).toBe("declare-done");
    expect(primaryAction(ACTIONS["build-stopped"] as StageAction[])).toBe("continue-build");
    expect(primaryAction(ACTIONS["plan-superseded"] as StageAction[])).toBeNull();
    expect(primaryAction(ACTIONS["rejected"] as StageAction[])).toBeNull();
  });
});

describe("build run-specs", () => {
  it("are composed by the backend, so the TypeScript composition refuses to make one", () => {
    expect(() => specFor("build", null, ctx, bypass, both)).toThrow();
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
    const common = ["No push", "No use of GitHub's command-line tool", "No change of remotes"];
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
  const restricted: Restricted = { workspaceFolder: WS, masterRepo: "intent-repo", systemRepos: ["kata", "api"] };
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
    expect(specFor("triage", null, startCtx, bypass, both, restricted).task).toBe(
      "Use the ai-sdlc start skill for system commerce. The change: Photos fail to upload. The person running this is both the engineer and the product owner and may take either route. If the route is the light track and the person takes it, run the fix skill in this session; the engineer accepts the fix later in the Workbench, so do not ask for acceptance.",
    );
    expect(specFor("fix", "accept-fix", wsCtx, bypass, both, restricted).task).toBe(
      "Use the ai-sdlc fix skill for system commerce with --accept 2026-10-23-fix-it. The engineer accepted this fix in the Workbench.",
    );
    expect(specFor("fix", null, wsCtx, bypass, both, restricted).task).toBe(
      "Use the ai-sdlc fix skill for system commerce on change folder 2026-10-23-fix-it. The engineer accepts the fix later in the Workbench, so do not ask for acceptance.",
    );
    expect(specFor("setup", null, { folder: WS, system: "", change: null, instructions: true }, bypass, both).task).toBe(
      "Use the ai-sdlc setup skill with --instructions.",
    );
  });

  it("the intent and triage task carries scope:<value> (R4.2)", () => {
    const intent = specFor("intent", null, { folder: WS, system: "commerce", change: null, idea: "photo upload", scope: "PROJ-123" }, bypass, both);
    expect(intent.task).toBe("Use the ai-sdlc intent skill for system commerce. The idea: photo upload scope:PROJ-123");
    const triage = specFor("triage", null, { ...startCtx, scope: "PROJ-123" }, bypass, both, restricted);
    expect(triage.task).toContain("The change: Photos fail to upload scope:PROJ-123\nThe person running this");
    for (const task of [intent.task, triage.task]) {
      const end = task.indexOf("scope:PROJ-123") + "scope:PROJ-123".length;
      expect(task.charAt(end)).toMatch(/^(\s|)$/);
    }
  });

  it("the intent and triage task carries no scope without a naming setting (R2.1)", () => {
    expect(specFor("intent", null, { folder: WS, system: "commerce", change: null, idea: "photo upload" }, bypass, both).task).not.toContain("scope:");
    expect(specFor("triage", null, startCtx, bypass, both, restricted).task).not.toContain("scope:");
  });

  it("the naming setup task names the system (R1.1)", () => {
    const s = specFor("setup", null, { folder: WS, system: "commerce", change: null, naming: true }, bypass, both);
    expect(s.task).toBe("Use the ai-sdlc setup skill with --naming. System: commerce");
  });

  it("appends operator feedback as it does for every other kind", () => {
    const s = specFor("fix", null, { ...wsCtx, feedback: "  narrower  " }, bypass, both, restricted);
    expect(s.task.endsWith("\n\nOperator feedback:\nnarrower")).toBe(true);
  });

  it("holds a start and a fix run to the same restrictions whatever the permission setting (R15.1, R15.2)", () => {
    const deny = [
      "Bash(git push:*)",
      "Bash(gh:*)",
      "Bash(git remote:*)",
      "Edit(//d/ws/kata/**)",
      "Edit(//d/ws/api/**)",
    ];
    const specs = [
      specFor("triage", null, startCtx, bypass, both, restricted),
      specFor("triage", null, startCtx, prompt, both, restricted),
      specFor("triage", null, startCtx, auto, both, restricted),
      specFor("fix", null, wsCtx, bypass, both, restricted),
      specFor("fix", null, wsCtx, prompt, both, restricted),
      specFor("fix", "accept-fix", wsCtx, auto, both, restricted),
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
    expect(specFor("triage", null, startCtx, bypass, both, restricted).given?.build).toBe(false);
  });

  it("refuses to build a start or fix spec without its restriction", () => {
    expect(() => specFor("triage", null, startCtx, bypass, both)).toThrow();
    expect(() => specFor("fix", null, wsCtx, bypass, both)).toThrow();
  });

  it("restrictedFor names the master and the product repositories the build protects", () => {
    expect(restrictedFor(WS, scan())).toEqual(restricted);
    expect(() => restrictedFor(WS, scan({ master: { kind: "none" } }))).toThrow();
    expect(() => restrictedFor(WS, scan({ master: { kind: "many", repos: ["a", "b"] } }))).toThrow();
  });
});
