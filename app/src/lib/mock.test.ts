import { describe, it, expect } from "vitest";
import { validateLocal } from "./mock";
import { defaultSpec } from "./spec";

/** A spec that passes every non-permission check, so only permission errors surface. */
function runnableSpec() {
  const s = defaultSpec();
  s.name = "demo";
  s.task = "do the thing";
  s.workdir = "D:/Repos/acme-api";
  return s;
}

describe("validateLocal — permission coherence", () => {
  it("accepts the default bypass posture with no rules", () => {
    expect(validateLocal(runnableSpec())).toEqual([]);
  });

  it("rejects rules carried under bypass mode", () => {
    const s = runnableSpec();
    s.permissions.allow = ["Read"];
    expect(validateLocal(s)).toContain(
      'permissions.allow/deny are only consulted under permissions.mode = "prompt"; under "bypass" claude never asks, so the rules would be ignored',
    );
  });

  it("rejects unmatched = ask when interactive is off", () => {
    const s = runnableSpec();
    s.permissions.mode = "prompt";
    expect(validateLocal(s)).toContain(
      'permissions.unmatched = "ask" needs an operator to ask: set [interactive] enabled = true, or choose unmatched = "deny" / "allow" for a headless run',
    );
  });

  it("accepts unmatched = ask once interactive is on", () => {
    const s = runnableSpec();
    s.permissions.mode = "prompt";
    s.interactive.enabled = true;
    expect(validateLocal(s)).toEqual([]);
  });

  it("accepts a headless prompt run with unmatched = deny", () => {
    const s = runnableSpec();
    s.permissions.mode = "prompt";
    s.permissions.unmatched = "deny";
    s.permissions.allow = ["Read", "Bash(git *)", "*"];
    expect(validateLocal(s)).toEqual([]);
  });

  it.each([
    ["Bash(unclosed", "permissions.allow"],
    ["", "permissions.allow"],
    ["   ", "permissions.allow"],
    ["Bash)", "permissions.allow"],
    ["(specifier)", "permissions.allow"],
  ])("rejects the malformed rule %j", (rule, field) => {
    const s = runnableSpec();
    s.permissions.mode = "prompt";
    s.permissions.unmatched = "deny";
    s.permissions.allow = [rule];
    expect(validateLocal(s)).toContain(
      `${field} has a malformed rule '${rule}'; expected 'Tool' or 'Tool(specifier)'`,
    );
  });

  it("reports a malformed deny rule against the deny field", () => {
    const s = runnableSpec();
    s.permissions.mode = "prompt";
    s.permissions.unmatched = "deny";
    s.permissions.deny = ["Bash(unclosed"];
    expect(validateLocal(s)).toContain(
      "permissions.deny has a malformed rule 'Bash(unclosed'; expected 'Tool' or 'Tool(specifier)'",
    );
  });
});
