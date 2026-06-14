import { describe, it, expect } from "vitest";
import { defaultSpec, normalize, specEquals } from "./spec";

describe("spec helpers", () => {
  it("defaultSpec is a valid-shaped schema-1 draft", () => {
    const s = defaultSpec();
    expect(s.schema).toBe(1);
    expect(s.leash.max_turns).toBe(12);
    expect(s.leash.isolation).toBe("none");
    expect(s.identity.mode).toBe("append");
    expect(s.skills).toEqual([]);
    expect(s.plugins).toEqual({});
  });

  it("normalize converts blank optionals to null", () => {
    const s = defaultSpec();
    s.description = "  ";
    s.context = "";
    s.identity.system_prompt = "   ";
    s.model.id = "";
    const n = normalize(s);
    expect(n.description).toBeNull();
    expect(n.context).toBeNull();
    expect(n.identity.system_prompt).toBeNull();
    expect(n.model.id).toBeNull();
  });

  it("normalize keeps non-blank optionals", () => {
    const s = defaultSpec();
    s.model.id = "claude-sonnet-4-6";
    expect(normalize(s).model.id).toBe("claude-sonnet-4-6");
  });

  it("specEquals detects dirtiness", () => {
    const a = defaultSpec();
    const b = defaultSpec();
    expect(specEquals(a, b)).toBe(true);
    b.task = "changed";
    expect(specEquals(a, b)).toBe(false);
  });
});
