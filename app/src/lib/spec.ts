import type { RunSpec } from "../bindings/RunSpec";

/** The model-selector modes. opus/sonnet/haiku are aliases claude resolves to
 *  its current model for that tier at run time (honoring ANTHROPIC_DEFAULT_*_MODEL
 *  when set), so they never go stale the way a pinned id does. */
export type ModelChoice = "default" | "opus" | "sonnet" | "haiku" | "custom";
export const MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;

/** The selector mode implied by a stored model id: blank (incl. whitespace-only,
 *  matching `normalize()` and the engine's `trim().is_empty()` guard) → default,
 *  a known alias → that alias, anything else → a pinned custom id. */
export function modelChoiceFor(id: string | null | undefined): ModelChoice {
  const trimmed = id?.trim();
  if (!trimmed) return "default";
  return (MODEL_ALIASES as readonly string[]).includes(trimmed) ? (trimmed as ModelChoice) : "custom";
}

/** The model id to store for a chosen selector mode. default and custom both
 *  start blank (null → engine omits --model); aliases pass through verbatim. */
export function modelIdForChoice(choice: ModelChoice): string | null {
  return choice === "default" || choice === "custom" ? null : choice;
}

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
    leash: { max_turns: 12, timeout_secs: null, max_budget_usd: null, isolation: "none" },
    auth: { bare: true, token_env: null },
    interactive: { enabled: false, answer_timeout_secs: null },
  };
}

/** Build an editable draft from a loaded spec. Optional text fields that the
 *  saved file omits (arriving as undefined/null) become "" so inputs never
 *  render "undefined"/"null", and nested objects always carry their defaults. */
export function draftFrom(loaded: RunSpec): RunSpec {
  const d = defaultSpec();
  return {
    ...d,
    ...loaded,
    description: loaded.description ?? "",
    context: loaded.context ?? "",
    identity: {
      mode: loaded.identity?.mode ?? "append",
      system_prompt: loaded.identity?.system_prompt ?? "",
    },
    model: { id: loaded.model?.id ?? "" },
    leash: { ...d.leash, ...loaded.leash },
    skills: loaded.skills ?? [],
    plugins: loaded.plugins ?? {},
    auth: { bare: loaded.auth?.bare ?? true, token_env: loaded.auth?.token_env ?? null },
    interactive: { ...d.interactive, ...loaded.interactive },
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
  c.auth.token_env = blankToNull(c.auth.token_env);
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
