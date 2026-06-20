import { describe, it, expect } from "vitest";
import { defaultSpec, normalize, specEquals, draftFrom, modelChoiceFor, modelIdForChoice } from "./spec";

describe("spec helpers", () => {
  it("defaultSpec is a valid-shaped schema-1 draft", () => {
    const s = defaultSpec();
    expect(s.schema).toBe(1);
    expect(s.leash.max_turns).toBeNull();
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

  it("defaultSpec carries a bare auth with no token", () => {
    const s = defaultSpec();
    expect(s.auth.bare).toBe(true);
    expect(s.auth.token_env).toBeNull();
  });

  it("normalize converts a blank token_env to null", () => {
    const s = defaultSpec();
    s.auth.token_env = "   ";
    expect(normalize(s).auth.token_env).toBeNull();
  });
});

describe("draftFrom", () => {
  it("fills omitted optional text fields with empty strings", () => {
    const loaded = { schema: 1, name: "x", task: "t", workdir: "/w", identity: { mode: "append" }, skills: [], plugins: {}, model: {}, leash: { max_turns: 8, isolation: "none" } } as any;
    const draft = draftFrom(loaded);
    expect(draft.description).toBe("");
    expect(draft.context).toBe("");
    expect(draft.identity.system_prompt).toBe("");
    expect(draft.model.id).toBe("");
    expect(draft.leash.timeout_secs).toBeNull();
    expect(draft.leash.max_turns).toBe(8);
  });

  it("preserves populated values", () => {
    const loaded = { ...defaultSpec(), description: "d", model: { id: "m" }, identity: { mode: "replace", system_prompt: "sp" } } as any;
    const draft = draftFrom(loaded);
    expect(draft.description).toBe("d");
    expect(draft.model.id).toBe("m");
    expect(draft.identity.mode).toBe("replace");
    expect(draft.identity.system_prompt).toBe("sp");
  });

  it("defaults auth when the loaded spec omits it", () => {
    const loaded = { schema: 1, name: "x", task: "t", workdir: "/w", identity: { mode: "append" }, skills: [], plugins: {}, model: {}, leash: { max_turns: 8, isolation: "none" } } as any;
    const draft = draftFrom(loaded);
    expect(draft.auth.bare).toBe(true);
    expect(draft.auth.token_env).toBeNull();
  });

  it("preserves a loaded auth block", () => {
    const loaded = { ...defaultSpec(), auth: { bare: false, token_env: "MY_KEY" } } as any;
    const draft = draftFrom(loaded);
    expect(draft.auth.bare).toBe(false);
    expect(draft.auth.token_env).toBe("MY_KEY");
  });
});

describe("model selection", () => {
  it("modelChoiceFor treats a blank id as default", () => {
    expect(modelChoiceFor(null)).toBe("default");
    expect(modelChoiceFor(undefined)).toBe("default");
    expect(modelChoiceFor("")).toBe("default");
    // whitespace-only is blank too — consistent with normalize()/the engine guard
    expect(modelChoiceFor("   ")).toBe("default");
  });

  it("modelChoiceFor recognises each tier alias", () => {
    expect(modelChoiceFor("opus")).toBe("opus");
    expect(modelChoiceFor("sonnet")).toBe("sonnet");
    expect(modelChoiceFor("haiku")).toBe("haiku");
  });

  it("modelChoiceFor treats a pinned id as custom", () => {
    expect(modelChoiceFor("claude-opus-4-8")).toBe("custom");
    expect(modelChoiceFor("claude-sonnet-4-6")).toBe("custom");
  });

  it("modelIdForChoice stores null for default and custom (engine omits --model)", () => {
    expect(modelIdForChoice("default")).toBeNull();
    expect(modelIdForChoice("custom")).toBeNull();
  });

  it("modelIdForChoice passes aliases through verbatim", () => {
    expect(modelIdForChoice("opus")).toBe("opus");
    expect(modelIdForChoice("sonnet")).toBe("sonnet");
    expect(modelIdForChoice("haiku")).toBe("haiku");
  });

  it("an alias round-trips through id and back to the same choice", () => {
    for (const a of ["opus", "sonnet", "haiku"] as const) {
      expect(modelChoiceFor(modelIdForChoice(a))).toBe(a);
    }
  });
});
