import type { RunSpec } from "../../bindings/RunSpec";
import { defaultSpec } from "$lib/spec";

/** A deep-reactive draft spec for component tests. The real app wraps its spec
 *  in `$state(...)` in `+page.svelte`, which deep-proxies nested writes so a
 *  click that flips a nested field re-renders the template. A plain object
 *  handed to `render()` has no such proxy, so tests must opt in the same way. */
export function reactiveSpec(mutate: (s: RunSpec) => void = () => {}): RunSpec {
  const spec = $state(defaultSpec());
  mutate(spec);
  return spec;
}
