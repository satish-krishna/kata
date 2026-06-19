import { describe, it, expect } from "vitest";
import { history, runDetailFixture } from "./library";

describe("library fixtures match the RunRecord shape", () => {
  it("records carry the live field names", () => {
    const r = history[0];
    expect(typeof r.started_at).toBe("number");
    expect("cost_usd" in r).toBe(true);
    expect("when" in r).toBe(false); // old fixture shape is gone
  });
  it("runDetailFixture wraps record + events", () => {
    const d = runDetailFixture(history[0].id);
    expect(d.record.id).toBe(history[0].id);
    expect(Array.isArray(d.events)).toBe(true);
  });
});
