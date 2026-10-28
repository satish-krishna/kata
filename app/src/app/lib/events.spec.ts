import { terminalStateFor, statusForExit, isStreamEvent, gutterFor, variantFor, bodyFor, givenFrom, GIVEN_STATUS_LABEL, messageBox, refusalText, pendingKind, messagesFrom, type GivenStatus, type KataEvent, type RunState, type PendingKind, type MessageRefusal, type MessageBoxView, type AskRecord, type PermissionRecord } from "./events";
import { runGivenFixture } from "./library";

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
    expect(isStreamEvent({ type: "log", level: "info", message: "x" })).toBe(true);
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

describe("generated KataEvent types", () => {
  it("accepts one representative event per family", () => {
    const events: KataEvent[] = [
      { type: "run.started", spec: "s", model: null, workdir: "/w", isolation: "none" },
      { type: "log", level: "info", message: "hi" },
      { type: "turn", n: 1 },
      { type: "assistant.text", text: "hello" },
      { type: "tool.use", name: "Bash", input_summary: "ls" },
      { type: "tool.result", name: "Bash", ok: true, summary: "ok" },
      { type: "run.completed", exit_code: 0, is_error: false, num_turns: 2, cost_usd: 0.01, duration_ms: 100, result: "done" },
      { type: "run.diff", worktree: "/wt", branch: "b", files: [{ status: "M", path: "a.rs" }], insertions: 1, deletions: 0 },
      { type: "ask.requested", id: "q1", questions: [{ kind: "select", header: "h", question: "?", options: [{ label: "A" }] }] },
      { type: "ask.answered", id: "q1", answers: [["A"]] },
      { type: "run.error", message: "boom", exit_code: 125 },
      { type: "run.cancelled", exit_code: 130 },
    ];
    expect(events).toHaveLength(12);
    expect(isStreamEvent({ type: "assistant.text", text: "x" })).toBe(true);
    expect(statusForExit(0)).toBe("success");
  });
});


describe("permission.decided rows", () => {
  const decided = (allow: boolean, decided_by: string) =>
    ({
      type: "permission.decided",
      id: "p1",
      tool: "Bash",
      input_summary: "rm -rf build/",
      allow,
      decided_by,
    }) as const;

  it("is a stream row, while permission.requested is not", () => {
    expect(isStreamEvent(decided(true, "unmatched-policy"))).toBe(true);
    expect(
      isStreamEvent({
        type: "permission.requested",
        id: "p1",
        tool: "Bash",
        input_summary: "rm -rf build/",
      }),
    ).toBe(false);
  });

  it("labels the gutter by the verdict and colours it with the andon set", () => {
    expect(gutterFor(decided(true, "unmatched-policy"))).toBe("allowed");
    expect(gutterFor(decided(false, "unmatched-policy"))).toBe("denied");
    expect(variantFor(decided(true, "unmatched-policy"))).toBe("result-ok");
    expect(variantFor(decided(false, "unmatched-policy"))).toBe("result-err");
  });

  it("names the tool, the target, and what decided it", () => {
    const body = bodyFor(decided(false, "unmatched-policy"));
    expect(body).toContain("Bash");
    expect(body).toContain("rm -rf build/");
    expect(body).toContain("unmatched-policy");
  });
});

describe("givenFrom", () => {
  const log: KataEvent = { type: "log", level: "info", message: "x" };
  const later = { ...runGivenFixture, warnings: ["later"] };

  it("takes the last run.given", () => {
    const got = givenFrom([log, runGivenFixture, log, later]);
    expect(got).not.toBe("not-recorded");
    expect(got === "not-recorded" ? [] : got.warnings).toEqual(["later"]);
  });

  it("a run without run.given reads not recorded", () => {
    expect(givenFrom([log, { type: "turn", n: 1 }])).toBe("not-recorded");
    expect(givenFrom([])).toBe("not-recorded");
  });

  it("every GivenStatus has its label", () => {
    const expected: Record<GivenStatus, string> = {
      "given": "given",
      "passed-not-loaded": "passed by Kata, not loaded by Claude",
      "given-failed-to-connect": "given, failed to connect",
      "given-fired": "given, fired",
      "given-not-fired": "given, has not fired",
      "given-unconfirmed": "given, Claude does not confirm this kind",
      "switched-off-but-loaded": "switched off, but Claude loaded it",
      "switched-off-but-fired": "switched off, but it fired",
      "switched-off": "switched off",
      "switched-off-unconfirmed": "switched off, Claude does not confirm this kind",
      "loaded-source-unknown": "loaded by Claude, source unknown",
      "loaded-source-unknown-failed-to-connect": "loaded by Claude, source unknown, failed to connect",
      "fired-source-unknown": "fired, source unknown",
      "passed-no-start-report": "passed by Kata, Claude made no start report",
      "switched-off-no-start-report": "switched off, Claude made no start report",
    };
    expect(GIVEN_STATUS_LABEL).toEqual(expected);
  });
});

describe("message helpers", () => {
  const sent = (id: string, text: string, sent_at: number): KataEvent => ({ type: "message.sent", id, text, sent_at });
  const read = (id: string, read_at: number): KataEvent => ({ type: "message.read", id, read_at });
  const log: KataEvent = { type: "log", level: "info", message: "x" };

  it("messageBox decides each reachable row", () => {
    const refusal = { id: "m", reason: "repeated", text: "again" };
    const hidden = { shown: false, enabled: false, note: "", restore: null };
    const cases: [string, RunState, PendingKind, MessageRefusal | null, MessageBoxView][] = [
      ["1 idle", "idle", "none", null, hidden],
      ["2 running", "running", "none", null, { shown: true, enabled: true, note: "The agent reads this before its next step.", restore: null }],
      ["3 running refused", "running", "none", refusal, { shown: true, enabled: true, note: "Not sent: already sent", restore: "again" }],
      ["5 awaiting ask", "awaiting", "ask", null, { shown: true, enabled: false, note: "Answer the question first", restore: null }],
      ["5 awaiting ask refused", "awaiting", "ask", refusal, { shown: true, enabled: false, note: "Answer the question first", restore: null }],
      ["6 awaiting approval", "awaiting", "approval", null, { shown: true, enabled: false, note: "Decide the approval first", restore: null }],
      ["8 success", "success", "none", null, hidden],
      ["8 warning", "warning", "none", refusal, hidden],
      ["8 error", "error", "ask", null, hidden],
    ];
    for (const [name, state, pending, ref, want] of cases) expect(messageBox(state, pending, ref), name).toEqual(want);
  });

  it("refusalText words the known reasons", () => {
    expect(refusalText("waiting-on-operator")).toBe("Not sent: answer the agent first");
    expect(refusalText("run-ending")).toBe("Not sent: the run is ending");
    expect(refusalText("repeated")).toBe("Not sent: already sent");
    expect(refusalText("weird")).toBe("Not sent");
  });

  it("pendingKind finds an open ask, then an open approval", () => {
    const ask = (answers: string[][] | null): AskRecord => ({ id: "a", questions: [], answers, at: 0 });
    const perm = (decided: PermissionRecord["decided"]): PermissionRecord => ({ id: "p", tool: "Bash", input_summary: "", decided, at: 0 });
    expect(pendingKind([ask(null)], [])).toBe("ask");
    expect(pendingKind([ask([[]])], [perm(null)])).toBe("approval");
    expect(pendingKind([ask([[]])], [perm({ allow: true, message: null })])).toBe("none");
    expect(pendingKind([], [])).toBe("none");
  });

  it("messagesFrom folds a transcript, counting stream rows for at", () => {
    const refused: KataEvent = { type: "message.refused", id: "m9", reason: "repeated", text: "t" };
    const got = messagesFrom([log, sent("m1", "one", 10), refused, read("m1", 12), log, sent("m2", "two", 20), read("zz", 30)]);
    expect(got).toEqual([
      { id: "m1", text: "one", sent_at: 10, read_at: 12, at: 1 },
      { id: "m2", text: "two", sent_at: 20, read_at: null, at: 2 },
    ]);
  });
});
