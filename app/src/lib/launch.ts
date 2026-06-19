import type { RunSpec } from "../bindings/RunSpec";

/** One-shot handoff from the Library route to Compose. Plain module state (not
 *  reactive): the value is set just before navigation and consumed once on the
 *  compose route's mount. */
export type LaunchPayload = { spec: RunSpec; autorun: boolean };

let pending: LaunchPayload | null = null;

export function setLaunch(payload: LaunchPayload): void {
  pending = payload;
}

/** Return the pending launch (if any) and clear it. */
export function takeLaunch(): LaunchPayload | null {
  const v = pending;
  pending = null;
  return v;
}
