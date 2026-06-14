import type { RunSpec } from "../bindings/RunSpec";

export function defaultSpec(): RunSpec {
  return {
    schema: 1,
    name: "",
    description: "",
    task: "",
    context: "",
    workdir: "",
    identity: { system_prompt: "", mode: "append" },
    skills: [],
    plugins: {},
    model: { id: "" },
    leash: { max_turns: 12, timeout_secs: null, isolation: "none" },
  };
}

const blankToNull = (s: string | null | undefined): string | null =>
  s && s.trim() !== "" ? s : null;

/** Convert blank optional text fields to null so saved specs omit them. */
export function normalize(spec: RunSpec): RunSpec {
  const c: RunSpec = structuredClone(spec);
  c.description = blankToNull(c.description);
  c.context = blankToNull(c.context);
  c.identity.system_prompt = blankToNull(c.identity.system_prompt);
  c.model.id = blankToNull(c.model.id);
  return c;
}

/**
 * Structural equality for dirty-state tracking against an in-app snapshot.
 * Key-order sensitive (JSON.stringify): deselecting then re-selecting a plugin
 * reorders `plugins` keys and may flip the dirty flag spuriously until the next
 * save. Acceptable for M5's indicator-only use.
 */
export function specEquals(a: RunSpec, b: RunSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
