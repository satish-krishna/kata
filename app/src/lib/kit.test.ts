import { describe, it, expect } from "vitest";
import {
  groupCatalog,
  isSkillSelected,
  toggleSkill,
  isPluginSelected,
  togglePlugin,
  setPluginMcp,
  setPluginEnv,
} from "./kit";
import { defaultSpec } from "./spec";
import type { CatalogEntry } from "../bindings/CatalogEntry";

const entries: CatalogEntry[] = [
  { kind: "plugin", name: "github-tools", description: "gh", source: "plugin", path: "p", provides: ["skill:pr-review"], mcp_servers: ["github"] },
  { kind: "skill", name: "triage", description: "t", source: "user", path: "s", provides: [], mcp_servers: [] },
];

describe("kit helpers", () => {
  it("groups and sorts by kind then name", () => {
    const g = groupCatalog(entries);
    expect(g.skills.map((e) => e.name)).toEqual(["triage"]);
    expect(g.plugins.map((e) => e.name)).toEqual(["github-tools"]);
  });

  it("toggles a skill on and off", () => {
    const s = defaultSpec();
    expect(isSkillSelected(s, "triage")).toBe(false);
    toggleSkill(s, "triage");
    expect(s.skills).toEqual(["triage"]);
    expect(isSkillSelected(s, "triage")).toBe(true);
    toggleSkill(s, "triage");
    expect(s.skills).toEqual([]);
  });

  it("toggles a plugin on and off", () => {
    const s = defaultSpec();
    togglePlugin(s, "github-tools");
    expect(isPluginSelected(s, "github-tools")).toBe(true);
    expect(s.plugins["github-tools"]).toEqual({ mcp: null, env: [] });
    togglePlugin(s, "github-tools");
    expect(isPluginSelected(s, "github-tools")).toBe(false);
  });

  it("edits plugin mcp and env when selected", () => {
    const s = defaultSpec();
    togglePlugin(s, "github-tools");
    setPluginMcp(s, "github-tools", true);
    setPluginEnv(s, "github-tools", ["GITHUB_TOKEN"]);
    expect(s.plugins["github-tools"]).toEqual({ mcp: true, env: ["GITHUB_TOKEN"] });
  });
});
