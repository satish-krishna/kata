import type { StreamEvent } from "./events";
import type { AskRecord, PermissionRecord } from "./events";
import {
  pairToolEvents, withPauses, rendererFor, statusOf, defaultOpen,
  targetFor, metaFor, editStats, todosOf, editsOf, type ToolCall, type StreamItem,
} from "./toolcards";

const use = (id: string, name: string, extra: Record<string, unknown> = {}): StreamEvent =>
  ({ type: "tool.use", name, input_summary: `${name} summary`, id, ...extra }) as StreamEvent;
const res = (id: string, name: string, ok = true, extra: Record<string, unknown> = {}): StreamEvent =>
  ({ type: "tool.result", name, ok, summary: `${name} done`, id, ...extra }) as StreamEvent;
const text = (t: string, parent_id?: string): StreamEvent =>
  ({ type: "assistant.text", text: t, ...(parent_id ? { parent_id } : {}) }) as StreamEvent;
const callAt = (items: StreamItem[], k: number): ToolCall => {
  const it = items[k];
  if (it.kind !== "call") throw new Error(`item ${k} is ${it.kind}`);
  return it.call;
};

describe("pairToolEvents", () => {
  it("pairs parallel calls of the same tool by id, not by order", () => {
    const items = pairToolEvents([use("a", "Read"), use("b", "Read"), res("b", "Read", false), res("a", "Read")]);
    expect(items).toHaveLength(2);
    expect(callAt(items, 0).result?.ok).toBe(true);
    expect(callAt(items, 1).result?.ok).toBe(false);
  });

  it("leaves a call without a result running", () => {
    const items = pairToolEvents([use("a", "Bash")]);
    expect(callAt(items, 0).result).toBeNull();
    expect(statusOf(callAt(items, 0))).toBe("running");
  });

  it("nests a subagent's calls and text one level deep", () => {
    const items = pairToolEvents([
      use("A", "Agent"),
      text("reading", "A"),
      use("B", "Read", { parent_id: "A" }),
      res("B", "Read", true, { parent_id: "A" }),
      res("A", "Agent"),
    ]);
    expect(items).toHaveLength(1);
    const agent = callAt(items, 0);
    expect(agent.children.map((c) => c.kind)).toEqual(["event", "call"]);
    const read = callAt(agent.children, 1);
    expect(read.depth).toBe(1);
    expect(read.result?.ok).toBe(true);
  });

  it("flattens a subagent's subagent into the first level", () => {
    const items = pairToolEvents([
      use("A", "Agent"),
      use("B", "Agent", { parent_id: "A" }),
      use("C", "Read", { parent_id: "B" }),
    ]);
    const agent = callAt(items, 0);
    expect(agent.children).toHaveLength(2);
    expect(callAt(agent.children, 1).use.name).toBe("Read");
    expect(callAt(agent.children, 1).depth).toBe(1);
  });

  it("shows an event whose parent never arrived at the top level", () => {
    const items = pairToolEvents([use("B", "Read", { parent_id: "missing" })]);
    expect(items).toHaveLength(1);
    expect(callAt(items, 0).use.name).toBe("Read");
  });

  it("treats a null parent_id like an absent one", () => {
    const items = pairToolEvents([use("A", "Agent"), use("B", "Read", { parent_id: null })]);
    expect(items).toHaveLength(2);
    expect(callAt(items, 0).children).toHaveLength(0);
    expect(callAt(items, 1).depth).toBe(0);
  });

  it("passes id-less events (old transcripts) through untouched", () => {
    const old = { type: "tool.use", name: "Bash", input_summary: "ls" } as StreamEvent;
    const items = pairToolEvents([old, text("hi")]);
    expect(items.map((i) => i.kind)).toEqual(["event", "event"]);
  });

  it("shows a result whose call never arrived as a plain event", () => {
    const items = pairToolEvents([res("zz", "Read")]);
    expect(items[0].kind).toBe("event");
  });

  it("records the raw index of the event that opened each item", () => {
    const items = pairToolEvents([text("a"), use("x", "Read"), res("x", "Read"), text("b")]);
    expect(items.map((i) => i.at)).toEqual([0, 1, 3]);
  });
});

describe("withPauses", () => {
  const perm = (id: string, at: number) => ({ id, at, tool: "Bash", input_summary: "", decided: null }) as PermissionRecord;
  const ask = (id: string, at: number) => ({ id, at, questions: [], answers: null }) as unknown as AskRecord;

  it("puts a pause that happened mid-call right after that call's row", () => {
    // tool.use at 1, the ask after 2 events (between use and result), result at 2.
    const items = pairToolEvents([text("a"), use("x", "Bash"), res("x", "Bash"), text("b")]);
    const out = withPauses(items, [], [ask("q", 2)]);
    expect(out.map((i) => i.key)).toEqual(["e:0", "c:x", "a:q", "e:3"]);
  });

  it("puts a pause at 0 first and one past the end last, permissions before asks", () => {
    const items = pairToolEvents([text("a")]);
    const out = withPauses(items, [perm("p0", 0), perm("p9", 9)], [ask("q0", 0)]);
    expect(out.map((i) => i.key)).toEqual(["p:p0", "a:q0", "e:0", "p:p9"]);
  });
});

describe("renderer selection", () => {
  const call = (name: string, input?: unknown, extra: Record<string, unknown> = {}): ToolCall =>
    callAt(pairToolEvents([use("i", name, { ...(input !== undefined ? { input } : {}), ...extra })]), 0);

  it("picks a renderer per tool and matches both Agent and Task", () => {
    expect(rendererFor(call("Edit", { old_string: "a", new_string: "b" }))).toBe("edit");
    expect(rendererFor(call("MultiEdit", { edits: [] }))).toBe("multiedit");
    expect(rendererFor(call("Write", { content: "x" }))).toBe("write");
    expect(rendererFor(call("Read", {}))).toBe("read");
    expect(rendererFor(call("Grep", {}))).toBe("search");
    expect(rendererFor(call("Glob", {}))).toBe("search");
    expect(rendererFor(call("TodoWrite", { todos: [] }))).toBe("todo");
    expect(rendererFor(call("Agent", {}))).toBe("agent");
    expect(rendererFor(call("Task", {}))).toBe("agent");
    expect(rendererFor(call("WebFetch", {}))).toBe("generic");
  });

  it("falls back to generic without a payload, except for subagents", () => {
    expect(rendererFor(call("Edit"))).toBe("generic");
    expect(rendererFor(call("Agent"))).toBe("agent");
  });

  it("never draws a diff from a truncated input", () => {
    expect(rendererFor(call("Edit", undefined, { truncated: true }))).toBe("generic");
  });

  it("opens edits, todos, and failures; collapses the rest", () => {
    expect(defaultOpen(call("Edit", { old_string: "a", new_string: "b" }))).toBe(true);
    expect(defaultOpen(call("TodoWrite", { todos: [] }))).toBe(true);
    expect(defaultOpen(call("Read", {}))).toBe(false);
    expect(defaultOpen(call("Agent", {}))).toBe(false);
    const failed = callAt(pairToolEvents([use("i", "Read", { input: {} }), res("i", "Read", false)]), 0);
    expect(defaultOpen(failed)).toBe(true);
  });
});

describe("row text", () => {
  it("counts added and removed lines", () => {
    expect(editStats("a\nb\n", "a\nc\nd\n")).toEqual({ add: 2, del: 1 });
    expect(editStats("", "x\ny")).toEqual({ add: 2, del: 0 });
  });

  it("builds target and meta from the payload", () => {
    const edit = callAt(pairToolEvents([use("i", "Edit", { input: { file_path: "src/a.rs", old_string: "x", new_string: "y" } })]), 0);
    expect(targetFor(edit)).toBe("src/a.rs");
    expect(metaFor(edit)).toEqual({ add: 1, del: 1 });

    const todo = callAt(pairToolEvents([use("i", "TodoWrite", { input: { todos: [
      { content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" },
    ] } })]), 0);
    expect(metaFor(todo)).toEqual({ text: "1 / 3" });
    expect(todosOf(todo).map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);

    const read = callAt(pairToolEvents([use("i", "Read", { input: { file_path: "a.rs" } }), res("i", "Read", true, { output: "1\ta\n2\tb\n" })]), 0);
    expect(metaFor(read)).toEqual({ text: "2 lines" });

    const agent = callAt(pairToolEvents([
      use("A", "Agent", { input: { subagent_type: "Explore", description: "find checks" } }),
      use("B", "Grep", { parent_id: "A" }),
    ]), 0);
    expect(targetFor(agent)).toBe("Explore: find checks");
    expect(metaFor(agent)).toEqual({ text: "1 call" });
  });

  it("uses the summary as the target when there is no payload", () => {
    const bare = callAt(pairToolEvents([use("i", "Edit")]), 0);
    expect(targetFor(bare)).toBe("Edit summary");
    expect(metaFor(bare)).toEqual({});
  });
});

describe("F1 memoized edit stats", () => {
  it("returns the identical meta object across two passes over the same events", () => {
    const events = [use("i", "Edit", { input: { file_path: "a", old_string: "x\n", new_string: "y\nz\n" } }), res("i", "Edit")];
    const a = callAt(pairToolEvents(events), 0);
    const b = callAt(pairToolEvents(events), 0);
    expect(a).not.toBe(b);
    expect(metaFor(a)).toBe(metaFor(b));
    const multi = [use("m", "MultiEdit", { input: { file_path: "a", edits: [{ old_string: "x", new_string: "y" }] } })];
    expect(metaFor(callAt(pairToolEvents(multi), 0))).toBe(metaFor(callAt(pairToolEvents(multi), 0)));
  });
});

describe("F2 malformed MultiEdit", () => {
  const input = { file_path: "a", edits: [null, 3, { old_string: "a", new_string: "b" }] };
  it("editsOf keeps only object elements", () => {
    const c = callAt(pairToolEvents([use("m", "MultiEdit", { input })]), 0);
    expect(editsOf(c)).toEqual([{ old_string: "a", new_string: "b" }]);
  });
  it("metaFor does not throw and counts the good edit", () => {
    const c = callAt(pairToolEvents([use("m", "MultiEdit", { input })]), 0);
    expect(metaFor(c)).toEqual({ add: 1, del: 1 });
  });
});

describe("F4 duplicate tool.use id", () => {
  it("keeps the repeat as a plain event with a unique key", () => {
    const items = pairToolEvents([use("d", "Read"), use("d", "Read")]);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
    expect(items[1].kind).toBe("event");
  });
});

describe("F5 nested agent meta", () => {
  it("shows no call count for a depth-1 Agent", () => {
    const items = pairToolEvents([use("A", "Agent"), use("B", "Agent", { parent_id: "A" }), use("C", "Read", { parent_id: "B" })]);
    const nested = callAt(callAt(items, 0).children, 0);
    expect(nested.depth).toBe(1);
    expect(metaFor(nested)).toEqual({});
  });
});

describe("F3 turn nesting", () => {
  it("nests a turn with parent_id under its Agent call", () => {
    const items = pairToolEvents([
      use("A", "Agent"),
      { type: "turn", n: 2, parent_id: "A" } as StreamEvent,
      { type: "turn", n: 3 } as StreamEvent,
    ]);
    expect(items).toHaveLength(2);
    expect(callAt(items, 0).children.map((c) => c.kind)).toEqual(["event"]);
  });
});
