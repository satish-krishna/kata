import type { StreamEvent } from "./events";
import { pairToolEvents, metaFor, DIFF_TIMEOUT_MS } from "./toolcards";

// Two entirely different texts, large enough that the Myers search cannot finish
// inside DIFF_TIMEOUT_MS. This drives the real timeout rather than mocking `diff`:
// a vi.mock only takes effect when this file is the first to load the module, and
// every ui spec that renders a diff loads the real one into the shared worker.
const big = (tag: string): string => Array.from({ length: 12000 }, (_, i) => `${tag}${i}`).join("\n");
const edit = (): StreamEvent =>
  ({ type: "tool.use", name: "Edit", input_summary: "s", id: "i", input: { file_path: "a", old_string: big("o"), new_string: big("n") } }) as StreamEvent;

describe("a diff that times out", () => {
  it("yields no +n -m meta, and the diff is bounded by DIFF_TIMEOUT_MS", () => {
    const it = pairToolEvents([edit()])[0];
    if (it.kind !== "call") throw new Error("not a call");
    const t0 = performance.now();
    expect(metaFor(it.call)).toEqual({});
    expect(performance.now() - t0).toBeLessThan(DIFF_TIMEOUT_MS * 10);
  });
});
