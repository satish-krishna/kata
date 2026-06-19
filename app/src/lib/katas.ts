import type { RunSpec } from "../bindings/RunSpec";
import type { RunRecord, RunState } from "./events";
import { statusForExit } from "./events";

/** A Saved-katas rail row: the persisted spec's static fields + run aggregates. */
export type KataView = {
  name: string;
  description: string;
  isolation: string;
  kit: number;
  runs: number;
  lastState: RunState | null;
  lastExit: number | null;
};

/** Join the kata library with run history (runs newest-first per `list_runs`). */
export function kataViews(katas: RunSpec[], runs: RunRecord[]): KataView[] {
  return katas.map((k) => {
    const mine = runs.filter((r) => r.kata === k.name);
    const latest = mine[0] ?? null;
    return {
      name: k.name,
      description: k.description ?? "",
      isolation: k.leash.isolation,
      kit: k.skills.length + Object.keys(k.plugins).length,
      runs: mine.length,
      lastState: latest ? statusForExit(latest.exit ?? null) : null,
      lastExit: latest ? latest.exit ?? null : null,
    };
  });
}

/** A copy of `spec` with `task` overridden (the reusable-agent per-run param). */
export function withTask(spec: RunSpec, task: string): RunSpec {
  return { ...structuredClone(spec), task };
}

/** Append a preset body to existing context (blank-line separated; set if empty). */
export function appendContext(current: string | null | undefined, body: string): string {
  return current && current.trim() !== "" ? `${current}\n\n${body}` : body;
}
