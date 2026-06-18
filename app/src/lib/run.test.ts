/* Vitest unit tests for the run store — state transitions driven by KataEvent. */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api module so the store doesn't try real Tauri/browser calls.
vi.mock("./api", () => ({
  onRunEvent: vi.fn(() => Promise.resolve(() => {})),
  runSpec: vi.fn(() => Promise.resolve()),
  cancelRun: vi.fn(() => Promise.resolve()),
  submitAnswer: vi.fn(() => Promise.resolve()),
}));

// Import after mocking so the store picks up the mocked api.
const { runStore, startRun, cancelRun, submitAnswer } = await import("./run.svelte");

describe("run store — ask.requested / ask.answered transitions", () => {
  beforeEach(async () => {
    // Reset to idle by starting and immediately checking we can manipulate state.
    // We reach into the store directly since we own the test environment.
    runStore.state = "idle";
    runStore.events = [];
    runStore.summary = null;
    runStore.asks = [];
  });

  it("transitions running → awaiting on ask.requested, then awaiting → running on ask.answered; answered record persists", async () => {
    const api = await import("./api");
    let capturedHandle: ((ev: import("./events").KataEvent) => void) | null = null;

    // Capture the handle callback that startRun registers.
    vi.mocked(api.onRunEvent).mockImplementationOnce((cb) => {
      capturedHandle = cb;
      return Promise.resolve(() => {});
    });

    // Start a dummy run so state = "running" and the handle is live.
    const spec = {
      schema: 1 as const,
      name: "test",
      description: null,
      task: "do something",
      context: null,
      workdir: "/tmp",
      identity: { system_prompt: null, mode: "append" as const },
      skills: [],
      plugins: {},
      model: { id: null },
      leash: { max_turns: 5, timeout_secs: null, isolation: "none" as const },
      auth: { bare: true, token_env: null },
      interactive: { enabled: true, answer_timeout_secs: null },
    };
    await startRun(spec);

    expect(runStore.state).toBe("running");
    expect(capturedHandle).not.toBeNull();

    // Feed ask.requested — expect state → awaiting and asks list populated.
    capturedHandle!({
      type: "ask.requested",
      id: "q1",
      questions: [
        {
          kind: "select",
          header: "scope",
          question: "Fix the flake, or just isolate it?",
          options: [
            { label: "Isolate only", description: "as instructed" },
            { label: "Fix it", description: "change prod code" },
          ],
          multi_select: false,
        },
      ],
    });

    expect(runStore.state).toBe("awaiting");
    expect(runStore.asks).toHaveLength(1);
    expect(runStore.asks[0].id).toBe("q1");
    expect(runStore.asks[0].questions).toHaveLength(1);
    expect(runStore.asks[0].answers).toBeNull();

    // Feed ask.answered — expect state → running and record persists with answers set (NOT cleared).
    capturedHandle!({ type: "ask.answered", id: "q1", answers: [["Isolate only"]] });

    expect(runStore.state).toBe("running");
    // The asks list still has the record (it is NOT removed).
    expect(runStore.asks).toHaveLength(1);
    expect(runStore.asks[0].id).toBe("q1");
    expect(runStore.asks[0].answers).toEqual([["Isolate only"]]);
  });

  it("active-pending ask is null after ask.answered", async () => {
    const api = await import("./api");
    let capturedHandle: ((ev: import("./events").KataEvent) => void) | null = null;

    vi.mocked(api.onRunEvent).mockImplementationOnce((cb) => {
      capturedHandle = cb;
      return Promise.resolve(() => {});
    });

    const spec = {
      schema: 1 as const,
      name: "test",
      description: null,
      task: "do something",
      context: null,
      workdir: "/tmp",
      identity: { system_prompt: null, mode: "append" as const },
      skills: [],
      plugins: {},
      model: { id: null },
      leash: { max_turns: 5, timeout_secs: null, isolation: "none" as const },
      auth: { bare: true, token_env: null },
      interactive: { enabled: true, answer_timeout_secs: null },
    };
    await startRun(spec);

    capturedHandle!({
      type: "ask.requested",
      id: "q2",
      questions: [{ kind: "text", header: "h", question: "q?", optional: false }],
    });

    // The active ask (answers === null) exists before answering.
    const activeBeforeAnswer = runStore.asks.find((a) => a.answers === null);
    expect(activeBeforeAnswer).not.toBeUndefined();

    capturedHandle!({ type: "ask.answered", id: "q2", answers: [["some text"]] });

    // After answering, no ask has answers === null.
    const activeAfterAnswer = runStore.asks.find((a) => a.answers === null);
    expect(activeAfterAnswer).toBeUndefined();
  });

  it("submitAnswer is a no-op when state is not awaiting", async () => {
    runStore.state = "idle";
    const api = await import("./api");
    await submitAnswer("q1", [["yes"]]);
    expect(vi.mocked(api.submitAnswer)).not.toHaveBeenCalled();
  });

  it("submitAnswer calls api.submitAnswer when state is awaiting", async () => {
    runStore.state = "awaiting";
    const api = await import("./api");
    vi.mocked(api.submitAnswer).mockResolvedValueOnce(undefined);
    await submitAnswer("q1", [["Isolate only"]]);
    expect(vi.mocked(api.submitAnswer)).toHaveBeenCalledWith("q1", [["Isolate only"]]);
  });
});
