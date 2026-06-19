import { describe, it, test, expect } from "vitest";
import { terminalStateFor, statusForExit, isStreamEvent, type KataEvent } from "./events";

describe("statusForExit", () => {
  it("maps exit codes to andon states", () => {
    expect(statusForExit(0)).toBe("success");
    expect(statusForExit(122)).toBe("warning");
    expect(statusForExit(125)).toBe("warning");
    expect(statusForExit(130)).toBe("warning");
    expect(statusForExit(1)).toBe("error");
    expect(statusForExit(2)).toBe("error");
    expect(statusForExit(null)).toBe("error");
  });
});

describe("terminalStateFor", () => {
  it("derives from exit_code for terminal events, null for rows", () => {
    expect(terminalStateFor({ type: "run.completed", exit_code: 0, is_error: false, num_turns: 1, cost_usd: null, duration_ms: 1, result: null })).toBe("success");
    expect(terminalStateFor({ type: "run.error", message: "x", exit_code: 125 })).toBe("warning");
    expect(terminalStateFor({ type: "run.cancelled", exit_code: 130 })).toBe("warning");
    expect(terminalStateFor({ type: "turn", n: 1 })).toBeNull();
  });
  it("maps run.completed (ok) to success", () => {
    const ev: KataEvent = { type: "run.completed", exit_code: 0, is_error: false, num_turns: 2, cost_usd: 0.02, duration_ms: 100, result: "ok" };
    expect(terminalStateFor(ev)).toBe("success");
  });
  it("maps run.completed (error exit) to error", () => {
    const ev: KataEvent = { type: "run.completed", exit_code: 1, is_error: true, num_turns: 1, cost_usd: null, duration_ms: 100, result: "boom" };
    expect(terminalStateFor(ev)).toBe("error");
  });
  it("maps run.error to error (non-leash exit)", () => {
    expect(terminalStateFor({ type: "run.error", message: "timed out", exit_code: 1 })).toBe("error");
  });
  it("maps run.cancelled (exit 130) to warning", () => {
    expect(terminalStateFor({ type: "run.cancelled", exit_code: 130 })).toBe("warning");
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

describe("isStreamEvent", () => {
  it("accepts stream rows, rejects meta/terminal events", () => {
    expect(isStreamEvent({ type: "turn", n: 1 })).toBe(true);
    expect(isStreamEvent({ type: "log", message: "x" })).toBe(true);
    expect(isStreamEvent({ type: "run.started", spec: "s", model: null, workdir: "/w", isolation: "none" })).toBe(false);
    expect(isStreamEvent({ type: "run.completed", exit_code: 0, is_error: false, num_turns: 1, cost_usd: null, duration_ms: 1, result: null })).toBe(false);
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
