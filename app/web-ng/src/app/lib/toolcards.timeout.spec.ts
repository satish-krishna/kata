
const diffLines = vi.hoisted(() => vi.fn());
vi.mock("diff", () => ({ diffLines }));

import type { StreamEvent } from "./events";
import { pairToolEvents, metaFor, DIFF_TIMEOUT_MS } from "./toolcards";

const edit = (): StreamEvent =>
  ({ type: "tool.use", name: "Edit", input_summary: "s", id: "i", input: { file_path: "a", old_string: "x", new_string: "y" } }) as StreamEvent;

describe("a diff that times out", () => {
  it("yields no +n -m meta, and the diff is bounded by DIFF_TIMEOUT_MS", () => {
    diffLines.mockReturnValue(undefined);
    const it = pairToolEvents([edit()])[0];
    if (it.kind !== "call") throw new Error("not a call");
    expect(metaFor(it.call)).toEqual({});
    expect(diffLines).toHaveBeenCalledWith("x", "y", { timeout: DIFF_TIMEOUT_MS });
  });
});
