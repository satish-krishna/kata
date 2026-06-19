import { describe, it, expect } from "vitest";
import { setLaunch, takeLaunch } from "./launch";
import type { RunSpec } from "../bindings/RunSpec";

const s = { schema: 1, name: "k", task: "t", workdir: "/w" } as RunSpec;

describe("launch handoff", () => {
  it("take returns the set payload once, then null", () => {
    expect(takeLaunch()).toBeNull();
    setLaunch({ spec: s, autorun: true });
    const got = takeLaunch();
    expect(got?.spec.name).toBe("k");
    expect(got?.autorun).toBe(true);
    expect(takeLaunch()).toBeNull(); // consumed
  });
});
