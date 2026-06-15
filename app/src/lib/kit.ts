import type { RunSpec } from "../bindings/RunSpec";
import type { PluginConfig } from "../bindings/PluginConfig";
import type { CatalogEntry } from "../bindings/CatalogEntry";

export type GroupedCatalog = { skills: CatalogEntry[]; plugins: CatalogEntry[] };

const byName = (a: CatalogEntry, b: CatalogEntry) => a.name.localeCompare(b.name);

export function groupCatalog(entries: CatalogEntry[]): GroupedCatalog {
  return {
    skills: entries.filter((e) => e.kind === "skill").sort(byName),
    plugins: entries.filter((e) => e.kind === "plugin").sort(byName),
  };
}

export const isSkillSelected = (spec: RunSpec, name: string): boolean =>
  spec.skills.includes(name);

export function toggleSkill(spec: RunSpec, name: string): void {
  if (isSkillSelected(spec, name)) {
    spec.skills = spec.skills.filter((s) => s !== name);
  } else {
    spec.skills = [...spec.skills, name];
  }
}

export const isPluginSelected = (spec: RunSpec, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(spec.plugins, name);

export function togglePlugin(spec: RunSpec, name: string): void {
  if (isPluginSelected(spec, name)) {
    delete spec.plugins[name];
  } else {
    const cfg: PluginConfig = { mcp: null, env: [] };
    spec.plugins[name] = cfg;
  }
}

export function setPluginMcp(spec: RunSpec, name: string, mcp: boolean | null): void {
  const cfg = spec.plugins[name];
  if (cfg) cfg.mcp = mcp;
}

export function setPluginEnv(spec: RunSpec, name: string, env: string[]): void {
  const cfg = spec.plugins[name];
  if (cfg) cfg.env = env;
}
