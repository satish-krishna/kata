import { describe, it, test, expect } from "vitest";
import { terminalStateFor, type KataEvent } from "./events";

describe("terminalStateFor", () => {
  it("maps run.completed (ok) to success", () => {
    const ev: KataEvent = { type: "run.completed", exit_code: 0, is_error: false, num_turns: 2, cost_usd: 0.02, duration_ms: 100, result: "ok" };
    expect(terminalStateFor(ev)).toBe("success");
  });
  it("maps run.completed (error) to error", () => {
    const ev: KataEvent = { type: "run.completed", exit_code: 1, is_error: true, num_turns: 1, cost_usd: null, duration_ms: 100, result: "boom" };
    expect(terminalStateFor(ev)).toBe("error");
  });
  it("maps run.error to error", () => {
    expect(terminalStateFor({ type: "run.error", message: "timed out" })).toBe("error");
  });
  it("maps run.cancelled to warning", () => {
    expect(terminalStateFor({ type: "run.cancelled" })).toBe("warning");
  });
  it("returns null for streaming events", () => {
    expect(terminalStateFor({ type: "assistant.text", text: "hi" })).toBeNull();
    expect(terminalStateFor({ type: "run.started", spec: "n", model: null, workdir: "/w", isolation: "none" })).toBeNull();
  });
  it("accepts a null result on run.completed", () => {
    const ev: KataEvent = { type: "run.completed", exit_code: 0, is_error: false, num_turns: 0, cost_usd: null, duration_ms: 0, result: null };
    expect(terminalStateFor(ev)).toBe("success");
  });
});

test("KataEvent union accepts run.diff and run.started worktree fields", () => {
  const started: KataEvent = {
    type: "run.started", spec: "s", model: null, workdir: "/w",
    isolation: "worktree", worktree: "/home/u/.kata/worktrees/s-abc", branch: "kata/s-abc",
  };
  const diff: KataEvent = {
    type: "run.diff", worktree: "/home/u/.kata/worktrees/s-abc", branch: "kata/s-abc",
    files: [{ status: "A", path: "new.txt" }], insertions: 2, deletions: 0,
  };
  expect(started.type).toBe("run.started");
  expect(diff.type).toBe("run.diff");
});
