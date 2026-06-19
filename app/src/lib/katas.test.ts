import { describe, it, expect } from "vitest";
import { kataViews, withTask, appendContext } from "./katas";
import type { RunSpec } from "../bindings/RunSpec";
import type { RunRecord } from "./events";

const spec = (name: string, over: Partial<RunSpec> = {}): RunSpec => ({
  schema: 1, name, task: "t", workdir: "/w",
  identity: { mode: "append" }, skills: [], plugins: {}, model: {},
  leash: { max_turns: 12, isolation: "none" }, auth: { bare: true }, interactive: { enabled: false },
  ...over,
} as RunSpec);

const rec = (kata: string, exit: number | null): RunRecord => ({
  id: `${kata}-x`, kata, started_at: 1, isolation: "none", exit, turns: null, cost_usd: null, duration_ms: null, result: null,
});

describe("kataViews", () => {
  it("joins katas with run aggregates", () => {
    const katas = [spec("a", { skills: ["s1"], plugins: { p1: {} } as RunSpec["plugins"], description: "desc-a", leash: { max_turns: 12, isolation: "worktree" } }), spec("b")];
    // runs newest-first (as list_runs returns)
    const runs = [rec("a", 0), rec("a", 125), rec("b", 1)];
    const views = kataViews(katas, runs);
    const a = views.find((v) => v.name === "a")!;
    expect(a.kit).toBe(2);          // 1 skill + 1 plugin
    expect(a.isolation).toBe("worktree");
    expect(a.description).toBe("desc-a");
    expect(a.runs).toBe(2);
    expect(a.lastState).toBe("success"); // newest a-run exit 0
    expect(a.lastExit).toBe(0);
    const b = views.find((v) => v.name === "b")!;
    expect(b.runs).toBe(1);
    expect(b.lastState).toBe("error");
  });
  it("a kata with no runs has null last outcome", () => {
    const views = kataViews([spec("lonely")], []);
    expect(views[0].runs).toBe(0);
    expect(views[0].lastState).toBeNull();
    expect(views[0].lastExit).toBeNull();
  });
});

describe("withTask", () => {
  it("returns a copy with the task overridden", () => {
    const s = spec("a");
    const out = withTask(s, "new task");
    expect(out.task).toBe("new task");
    expect(s.task).toBe("t"); // original untouched
  });
});

describe("appendContext", () => {
  it("appends with a blank-line separator, or sets when empty", () => {
    expect(appendContext("", "body")).toBe("body");
    expect(appendContext(null, "body")).toBe("body");
    expect(appendContext("existing", "body")).toBe("existing\n\nbody");
  });
});
